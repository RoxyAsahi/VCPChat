'use strict';

// Agent runtime sidecar entry point.
// Started with child_process.fork() under ELECTRON_RUN_AS_NODE=1.
// Never runs inside the Electron renderer; holds no VCP key unless the main
// process passes one through start-session options.

const path = require('path');
const { pathToFileURL } = require('url');
const {
    PROTOCOL_VERSION,
    MESSAGE_TYPES,
    validateMessage,
    makeAck,
} = require('./protocol.cjs');

const driverKind = process.env.AGENT_RUNTIME_DRIVER || 'mock';

let adapter = null;
const pendingToolCalls = new Map();
const pendingModelRequests = new Map();

function send(message) {
    if (process.send) {
        process.send(message);
    }
}

function emitEvent(sessionId, event) {
    send({ type: MESSAGE_TYPES.EVENT, sessionId, event });
}

function requestModelFactory(sessionId, turnId) {
    return (body, signal) => new Promise((resolve) => {
        const requestId = `model_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const timeout = setTimeout(() => {
            pendingModelRequests.delete(requestId);
            resolve({ ok: false, error: 'model bridge timeout' });
        }, 10 * 60 * 1000);
        if (typeof timeout.unref === 'function') timeout.unref();
        pendingModelRequests.set(requestId, { resolve, timeout });
        send({ type: MESSAGE_TYPES.MODEL_REQUEST, requestId, sessionId, turnId, body });
        if (signal) {
            signal.addEventListener('abort', () => {
                const pending = pendingModelRequests.get(requestId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pendingModelRequests.delete(requestId);
                    pending.resolve({ ok: false, error: 'cancelled', cancelled: true });
                }
            }, { once: true });
        }
    });
}

function requestToolFactory(sessionId, turnId) {
    return (request) => new Promise((resolve, reject) => {
        const toolCallId = request.toolCallId || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        const timeout = setTimeout(() => {
            pendingToolCalls.delete(toolCallId);
            resolve({ ok: false, error: 'tool bridge timeout', toolCallId });
        }, 10 * 60 * 1000);
        if (typeof timeout.unref === 'function') {
            timeout.unref();
        }
        pendingToolCalls.set(toolCallId, { resolve, reject, timeout });
        send({
            type: MESSAGE_TYPES.TOOL_REQUEST,
            sessionId,
            turnId,
            toolCallId,
            toolName: request.toolName,
            arguments: request.arguments || {},
            reason: request.reason,
        });
        if (request.signal) {
            request.signal.addEventListener('abort', () => {
                const pending = pendingToolCalls.get(toolCallId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pendingToolCalls.delete(toolCallId);
                    pending.resolve({ ok: false, error: 'cancelled', cancelled: true, toolCallId });
                }
            }, { once: true });
        }
    });
}

async function loadAdapter(kind) {
    if (kind === 'pi') {
        const moduleUrl = pathToFileURL(path.join(__dirname, 'piAdapter.mjs')).href;
        const mod = await import(moduleUrl);
        return mod.createPiAdapter();
    }
    const moduleUrl = pathToFileURL(path.join(__dirname, 'mockAdapter.mjs')).href;
    const mod = await import(moduleUrl);
    return mod.createMockAdapter();
}

async function handleStartSession(message) {
    try {
        const options = { ...(message.options || {}) };
        // Main process strips credentials before this message reaches the worker.
        options.createRequestTool = (turnId) => requestToolFactory(message.sessionId, turnId);
        options.createRequestModel = (turnId) => requestModelFactory(message.sessionId, turnId);
        await adapter.createSession(message.sessionId, options);
        send({ type: MESSAGE_TYPES.SESSION_STARTED, requestId: message.requestId, sessionId: message.sessionId, ok: true });
    } catch (error) {
        send({
            type: MESSAGE_TYPES.SESSION_STARTED,
            requestId: message.requestId,
            sessionId: message.sessionId,
            ok: false,
            error: error.message,
        });
    }
}

async function handleStartTurn(message) {
    const emit = (partial) => {
        emitEvent(message.sessionId, {
            ...partial,
            turnId: message.turnId,
        });
    };
    try {
        const requestTool = requestToolFactory(message.sessionId, message.turnId);
        const result = await adapter.runTurn({
            sessionId: message.sessionId,
            turnId: message.turnId,
            prompt: message.prompt,
            emitEvent: emit,
            requestTool,
        });
        send(makeAck(message.requestId, result && result.ok !== false, { result }));
    } catch (error) {
        send(makeAck(message.requestId, false, { error: error.message }));
    }
}

async function handleCancelTurn(message) {
    try {
        const result = await adapter.cancelTurn(message.sessionId, message.turnId);
        send(makeAck(message.requestId, !result || result.ok !== false, { result }));
    } catch (error) {
        send(makeAck(message.requestId, false, { error: error.message }));
    }
}

function handleModelResult(message) {
    const pending = pendingModelRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingModelRequests.delete(message.requestId);
    pending.resolve({ ok: message.ok, data: message.data, error: message.error });
}

function handleToolResult(message) {
    const pending = pendingToolCalls.get(message.toolCallId);
    if (!pending) {
        return;
    }
    clearTimeout(pending.timeout);
    pendingToolCalls.delete(message.toolCallId);
    pending.resolve({
        ok: message.ok,
        output: message.output,
        error: message.error,
        audit: message.audit,
        toolCallId: message.toolCallId,
    });
}

async function handleShutdown(message) {
    try {
        if (adapter && typeof adapter.dispose === 'function') {
            await adapter.dispose();
        }
        send(makeAck(message.requestId, true));
    } catch (error) {
        send(makeAck(message.requestId, false, { error: error.message }));
    } finally {
        setTimeout(() => process.exit(0), 50);
    }
}

const HANDLERS = {
    [MESSAGE_TYPES.START_SESSION]: handleStartSession,
    [MESSAGE_TYPES.START_TURN]: handleStartTurn,
    [MESSAGE_TYPES.CANCEL_TURN]: handleCancelTurn,
    [MESSAGE_TYPES.MODEL_RESULT]: handleModelResult,
    [MESSAGE_TYPES.TOOL_RESULT]: handleToolResult,
    [MESSAGE_TYPES.SHUTDOWN]: handleShutdown,
};

process.on('message', (message) => {
    const validation = validateMessage(message);
    if (!validation.ok) {
        send({ type: MESSAGE_TYPES.FATAL, error: `protocol violation: ${validation.error}` });
        return;
    }
    const handler = HANDLERS[message.type];
    if (!handler) {
        return;
    }
    Promise.resolve(handler(message)).catch((error) => {
        send({ type: MESSAGE_TYPES.FATAL, error: `unhandled handler error: ${error.message}` });
    });
});

process.on('uncaughtException', (error) => {
    send({ type: MESSAGE_TYPES.FATAL, error: `uncaughtException: ${error.message}` });
});

process.on('unhandledRejection', (reason) => {
    send({ type: MESSAGE_TYPES.FATAL, error: `unhandledRejection: ${reason && reason.message ? reason.message : String(reason)}` });
});

(async () => {
    try {
        adapter = await loadAdapter(driverKind);
        const probe = await adapter.probe();
        send({
            type: MESSAGE_TYPES.READY,
            protocolVersion: PROTOCOL_VERSION,
            probe: {
                ...probe,
                driver: driverKind,
                execPath: process.execPath,
                platform: process.platform,
                arch: process.arch,
                versions: {
                    node: process.versions.node,
                    electron: process.versions.electron || null,
                    modules: process.versions.modules || null,
                },
            },
        });
    } catch (error) {
        send({
            type: MESSAGE_TYPES.READY,
            protocolVersion: PROTOCOL_VERSION,
            probe: {
                available: false,
                driver: driverKind,
                details: `sidecar init failed: ${error.message}`,
            },
        });
    }
})();
