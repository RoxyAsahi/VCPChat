import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

if (process.env.VCP_CODEX_LIVE !== '1') {
    throw new Error('Refusing live ToolBox test. Set VCP_CODEX_LIVE=1 explicitly.');
}

const toolboxUrl = String(process.env.VCP_TOOLBOX_URL || '').trim();
const toolboxApiKey = String(process.env.VCP_TOOLBOX_API_KEY || '').trim();
const model = String(process.env.VCP_CODEX_LIVE_MODEL || 'gpt-5.6-luna').trim();
const baseInstructions = String(process.env.VCP_CODEX_LIVE_BASE_INSTRUCTIONS || '{{Nova}}').trim();
const liveTimeoutMs = Math.max(10_000, Number(process.env.VCP_CODEX_LIVE_TIMEOUT_MS || 120_000));
if (!toolboxUrl || !toolboxApiKey) {
    throw new Error('Live ToolBox test requires VCP_TOOLBOX_URL and VCP_TOOLBOX_API_KEY. Credentials are never logged.');
}

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const { CodexRuntimeManager } = require('../modules/codex-runtime/runtimeManager.js');
const projectRoot = path.resolve(import.meta.dirname, '..');
const packagePath = path.join(projectRoot, 'package.json');
const fileOperatorRoot = path.join(projectRoot, 'VCPDistributedServer', 'Plugin', 'FileOperator');
const fileOperatorEntry = path.join(fileOperatorRoot, 'FileOperator.js');
const fileOperatorManifestPath = path.join(fileOperatorRoot, 'plugin-manifest.json');
const packageName = JSON.parse(fs.readFileSync(packagePath, 'utf8')).name;
assert.equal(typeof packageName, 'string');

function sanitizedLiveError(value) {
    return String(value || '').replaceAll(projectRoot, '<workspace>').slice(0, 500);
}

function executeFileOperator(argumentsValue) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.env.VCP_CODEX_NODE_EXECUTABLE || 'node', [fileOperatorEntry], {
            cwd: fileOperatorRoot,
            env: {
                ...process.env,
                ALLOWED_DIRECTORIES: projectRoot,
                DEBUG_MODE: 'false',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('FileOperator live fixture timed out'));
        }, 30_000);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2 * 1024 * 1024); });
        child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024); });
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`FileOperator exited with code ${code}: ${sanitizedLiveError(stderr)}`));
        });
        child.stdin.end(JSON.stringify(argumentsValue));
    });
}

async function startFileOperatorTestNode() {
    const manifest = JSON.parse(fs.readFileSync(fileOperatorManifestPath, 'utf8'));
    const readFileCommands = (manifest.capabilities?.invocationCommands || [])
        .filter((entry) => entry.command === 'ReadFile');
    const registeredManifest = {
        ...manifest,
        capabilities: { ...manifest.capabilities, invocationCommands: readFileCommands },
    };
    const endpoint = new URL(toolboxUrl);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.pathname = `/vcp-distributed-server/VCP_Key=${toolboxApiKey}`;
    endpoint.search = '';
    endpoint.hash = '';
    const serverName = `Codex-R16-FileOperator-${process.pid}-${randomUUID()}`;
    const socket = new WebSocket(endpoint.toString());
    const activeExecutions = new Set();
    let fatalError = null;
    socket.on('message', (message) => {
        let payload;
        try { payload = JSON.parse(String(message)); } catch { return; }
        if (payload?.type !== 'execute_tool' || payload?.data?.toolName !== 'FileOperator') return;
        const requestId = payload.data.requestId;
        const args = payload.data.toolArgs;
        const execution = (async () => {
            try {
                if (args?.command !== 'ReadFile' || path.resolve(String(args?.filePath || '')) !== packagePath) {
                    throw new Error('R16 FileOperator fixture accepts only ReadFile for the repository package.json');
                }
                const result = await executeFileOperator(args);
                socket.send(JSON.stringify({
                    type: 'tool_result', data: { requestId, status: 'success', result },
                }));
            } catch (error) {
                socket.send(JSON.stringify({
                    type: 'tool_result', data: {
                        requestId, status: 'error', error: sanitizedLiveError(error?.message || error),
                    },
                }));
            }
        })();
        activeExecutions.add(execution);
        void execution.finally(() => activeExecutions.delete(execution));
    });
    socket.on('error', (error) => { fatalError = error; });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out connecting the R16 FileOperator test node')), 10_000);
        socket.once('open', () => {
            clearTimeout(timeout);
            socket.send(JSON.stringify({
                type: 'register_tools', data: { serverName, tools: [registeredManifest] },
            }));
            resolve();
        });
        socket.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (fatalError) throw fatalError;
    return {
        serverName,
        async stop() {
            await Promise.allSettled([...activeExecutions]);
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
        },
    };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-toolbox-live-'));
const manager = new CodexRuntimeManager({
    projectRoot,
    settingsPath: path.join(scratch, 'settings.json'),
    getSettings: () => ({
        vcpServerUrl: toolboxUrl,
        vcpApiKey: toolboxApiKey,
        agentRuntime: { codex: { model } },
    }),
});
let fileOperatorNode = null;

function waitForCompletedTurn(runtime, session, diagnostics, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            runtime.off('event', onEvent);
            reject(new Error(
                'Timed out waiting for live FileOperator Turn completion; '
                + `diagnostics=${JSON.stringify(diagnostics)}`
            ));
        }, timeoutMs);
        const onEvent = (event) => {
            if (event?.sessionId !== session.sessionId || event?.threadId !== session.threadId) return;
            if (event?.type === 'runtime.crashed') {
                clearTimeout(timeout);
                runtime.off('event', onEvent);
                reject(new Error(`Codex App Server crashed: ${event.error?.message || 'unknown error'}`));
            }
            if (event?.method === 'turn/completed') {
                clearTimeout(timeout);
                runtime.off('event', onEvent);
                assert.equal(event.turnStatus, 'completed',
                    `live ToolBox Turn failed; diagnostics=${JSON.stringify(diagnostics)}`);
                resolve(event);
            }
        };
        runtime.on('event', onEvent);
    });
}

try {
    fileOperatorNode = await startFileOperatorTestNode();
    await manager.start();
    assert.ok(manager.bridge, 'live ToolBox settings must start the standalone bridge');

    const calls = [];
    const diagnostics = {
        notificationCounts: {},
        codexErrors: [],
        serverRequestCount: 0,
        serverRequests: [],
        bridgeStarted: [],
        bridgeCompleted: [],
        bridgeErrors: [],
    };
    manager.on('event', (event) => {
        if (!event?.method) return;
        diagnostics.notificationCounts[event.method] = (diagnostics.notificationCounts[event.method] || 0) + 1;
        if (event.method === 'error' && diagnostics.codexErrors.length < 5) {
            diagnostics.codexErrors.push(String(event?.params?.error?.message || event?.params?.message || 'unknown error').slice(0, 500));
        }
    });
    manager.transport.on('server-request', (request) => {
        diagnostics.serverRequestCount += 1;
        if (diagnostics.serverRequests.length < 5) {
            const wrapperArguments = request?.params?.arguments;
            const targetArguments = wrapperArguments && typeof wrapperArguments === 'object'
                ? wrapperArguments.arguments
                : null;
            diagnostics.serverRequests.push({
                method: request?.method || null,
                tool: request?.params?.tool || null,
                hasThreadId: Boolean(request?.params?.threadId),
                hasTurnId: Boolean(request?.params?.turnId),
                hasCallId: Boolean(request?.params?.callId),
                wrapperArgumentKeys: wrapperArguments && typeof wrapperArguments === 'object'
                    ? Object.keys(wrapperArguments).sort()
                    : [],
                targetArgumentKeys: targetArguments && typeof targetArguments === 'object'
                    ? Object.keys(targetArguments).sort()
                    : [],
            });
        }
    });
    const invokeBridge = manager.bridge.invoke.bind(manager.bridge);
    manager.bridge.invoke = async (request) => {
        if (diagnostics.bridgeStarted.length < 5) {
            diagnostics.bridgeStarted.push({ toolName: request?.toolName || null, hasArguments: Boolean(request?.arguments) });
        }
        try {
            const response = await invokeBridge(request);
            if (diagnostics.bridgeCompleted.length < 5) {
                diagnostics.bridgeCompleted.push({
                    toolName: request?.toolName || null,
                    ok: response?.result?.ok ?? response?.ok ?? null,
                    error: sanitizedLiveError(response?.result?.error || response?.error) || null,
                });
            }
            calls.push({ request, response });
            return response;
        } catch (error) {
            if (diagnostics.bridgeErrors.length < 5) diagnostics.bridgeErrors.push(sanitizedLiveError(error?.message || error));
            throw error;
        }
    };

    const topic = await manager.createSessionRecord({
        agentId: 'Nova',
        title: 'Codex ToolBox FileOperator live check',
        model,
        baseInstructions,
        workspaceRoot: projectRoot,
    });
    const session = await manager.createSession({ sessionId: topic.sessionId });
    const completion = waitForCompletedTurn(manager, session, diagnostics, liveTimeoutMs);
    await manager.startTurn({
        sessionId: session.sessionId,
        prompt: [
            'Use the dynamic tool vcp_invoke exactly once.',
            'Do not use native filesystem, shell, web, or any other tool.',
            'Its arguments must be tool="FileOperator" and arguments={"command":"ReadFile","filePath":' + JSON.stringify(packagePath) + ',"encoding":"utf8"}.',
            `After it succeeds, reply with exactly this package name and nothing else: ${packageName}`,
        ].join(' '),
    });
    await completion;

    const fileOperatorCalls = calls.filter(({ request }) => request?.toolName === 'FileOperator');
    assert.equal(fileOperatorCalls.length, 1, 'Codex must invoke the requested FileOperator exactly once');
    const [fileOperatorCall] = fileOperatorCalls;
    assert.ok(fileOperatorCall, 'Codex must invoke the distributed VCP FileOperator through vcp_invoke, not a native substitute');
    assert.match(String(fileOperatorCall.request.requestId || ''), /^codex:[0-9a-f-]+:[0-9a-f-]+:[^:\s]+$/i,
        'bridge request identity must retain the Codex UUID thread/turn IDs and its opaque call ID');
    assert.deepEqual(fileOperatorCall.request.arguments, {
        command: 'ReadFile',
        filePath: packagePath,
        encoding: 'utf8',
    });
    assert.equal(fileOperatorCall.response?.result?.ok, true,
        `distributed VCP FileOperator must complete successfully; error=${sanitizedLiveError(fileOperatorCall.response?.result?.error) || 'none'}`);

    const projection = await manager.readSession({ sessionId: session.sessionId, reconcile: false });
    const projectionText = JSON.stringify(projection);
    assert.match(projectionText, new RegExp(packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'the completed ToolBox result or final assistant reply must reach the SQLite projection');
    const sessionDiagnostics = manager.readSessionDiagnostics({ sessionId: session.sessionId });
    const latestAdapterRequest = sessionDiagnostics.toolbox.adapter.recentRequests[0];
    assert.equal(sessionDiagnostics.toolbox.endpoint, 'http://localhost:6005/v1/chat/completions');
    assert.equal(sessionDiagnostics.toolbox.configured, true);
    assert.equal(latestAdapterRequest?.status, 'completed');
    assert.equal(latestAdapterRequest?.model, model);
    assert.deepEqual((latestAdapterRequest?.forwardedTools || []).map((tool) => tool.name), ['vcp_invoke'],
        'authoritative diagnostics must report the actual ToolBox-bound tool list');
    const serializedDiagnostics = JSON.stringify(sessionDiagnostics);
    assert.equal(serializedDiagnostics.includes(packagePath), false,
        'Session diagnostics must not expose absolute FileOperator arguments');
    assert.equal(serializedDiagnostics.includes(baseInstructions), false,
        'Session diagnostics must not expose the frozen identity prompt');
    console.log(JSON.stringify({
        runtime: 'codex-app-server',
        model,
        tool: 'FileOperator',
        operation: 'ReadFile',
        testNode: fileOperatorNode.serverName,
        dynamicCall: 'passed',
        bridgeCompleted: 'passed',
        projection: 'passed',
        diagnostics: 'passed',
    }));
} finally {
    await manager.stop().catch(() => null);
    await fileOperatorNode?.stop().catch(() => null);
    fs.rmSync(scratch, { recursive: true, force: true });
}
