import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentRuntimeManager } = require('../archive/agent-runtime/runtimeManager.js');
const { resolveElectronNodeExecPath } = require('../archive/agent-runtime/workerTransport.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const events = [];
const manager = new AgentRuntimeManager({
    projectRoot: root,
    driver: 'mock',
    getSettings: () => ({ vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'test-secret' }),
    hasUi: () => true,
    sendEvent: (event) => events.push(event),
});

try {
    const status = await manager.start();
    assert.equal(status.state, 'ready');
    assert.equal(status.worker.driver, 'mock');
    const session = await manager.createSession({ workspaceRoot: root, model: 'mock-model' });
    assert.match(session.sessionId, /^sess_/);
    const sessionRecord = manager.registry.get(session.sessionId);
    assert.equal(manager._evaluateToolCapability(sessionRecord, 'vcp_invoke', {
        toolName: 'FileOperator', arguments: { command: 'ReadFile', filePath: 'README.md' },
    }).allowed, true);
    const scopedRead = manager._scopeVcpInvocation(sessionRecord, 'FileOperator', {
        command: 'ReadFile', filePath: 'README.md',
    });
    assert.equal(scopedRead.filePath, path.join(root, 'README.md'));
    assert.throws(() => manager._scopeVcpInvocation(sessionRecord, 'FileOperator', {
        command: 'ReadFile', filePath: '../outside.txt',
    }), /escapes workspace/);
    const escapedWrite = manager._scopeVcpInvocation(sessionRecord, 'FileOperator', {
        command: 'EditFile', filePath: 'README.md', content: '<<<[TOOL_REQUEST]>>>',
    });
    assert.equal(escapedWrite.command, 'EditEscapedFile');
    assert.match(escapedWrite.content, /TOOL_REQUEST_ESCAPE/);
    const turn = await manager.startTurn({ sessionId: session.sessionId, prompt: 'hello runtime' });
    assert.match(turn.turnId, /^turn_/);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const listed = manager.listSessions().sessions.find((item) => item.sessionId === session.sessionId);
        if (listed?.state === 'idle') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const listed = manager.listSessions().sessions.find((item) => item.sessionId === session.sessionId);
    assert.equal(listed.state, 'idle');
    assert.equal(events.some((event) => event.type === 'assistant.delta'), true);
    assert.equal(events.some((event) => event.type === 'turn.completed'), true);

    const longTurn = await manager.startTurn({ sessionId: session.sessionId, prompt: 'cancel this turn after it starts' });
    await manager.cancelTurn({ sessionId: session.sessionId, turnId: longTurn.turnId });
    assert.equal(manager.registry.get(session.sessionId).getTurn(longTurn.turnId).state, 'cancelled');
} finally {
    const stopped = await manager.stop();
    assert.equal(stopped.state, 'stopped');
}

// Persistence restore recreates VCP-backed patch workflows and rehydrates every non-closed worker session.
const workerRequests = [];
const savedSessions = [];
const restoredMessages = [
    { messageId: 'msg_user', sessionId: 'sess_restore_ok', role: 'user', content: 'persisted question' },
    { messageId: 'msg_assistant', sessionId: 'sess_restore_ok', role: 'assistant', content: 'persisted answer' },
];
const restoreStore = {
    restore: () => [
        {
            sessionId: 'sess_restore_ok', runtime: 'mock', state: 'idle', workspaceRoot: root,
            metadata: { model: 'restored-model', systemPrompt: 'Restored system prompt.' },
            summaryText: 'restored summary', turns: [], events: [],
        },
        {
            sessionId: 'sess_restore_failed', runtime: 'mock', state: 'idle', workspaceRoot: null,
            metadata: { model: 'failed-model' }, turns: [], events: [],
        },
        {
            sessionId: 'sess_restore_closed', runtime: 'mock', state: 'closed', workspaceRoot: root,
            metadata: { model: 'closed-model' }, turns: [], events: [],
        },
    ],
    getMessages: (sessionId) => sessionId === 'sess_restore_ok' ? restoredMessages : [],
    saveSession: (session) => savedSessions.push({ sessionId: session.sessionId, state: session.state }),
    saveEvent: () => {},
};
const fakeTransport = {
    probe: { available: true, driver: 'mock' },
    start: async () => ({ probe: { available: true, driver: 'mock' } }),
    stop: async () => ({ stopped: true }),
    isRunning: () => true,
    sendRequest: (type, payload) => {
        workerRequests.push({ type, payload });
        const promise = type === 'start-session' && payload.sessionId === 'sess_restore_failed'
            ? Promise.reject(new Error('single-session rejection'))
            : Promise.resolve({ ok: true });
        return { promise };
    },
};
const restoredManager = new AgentRuntimeManager({
    projectRoot: root,
    driver: 'mock',
    store: restoreStore,
    catalog: { loadCache: async () => {}, refresh: async () => {}, getSnapshot: () => null },
    transportFactory: () => fakeTransport,
});
try {
    const restoredStatus = await restoredManager.start();
    assert.equal(restoredStatus.state, 'ready');
    assert.equal(restoredManager.patchManagers.has('sess_restore_ok'), true);
    assert.equal(restoredManager.patchManagers.has('sess_restore_closed'), false);
    assert.deepEqual(workerRequests.filter((entry) => entry.type === 'start-session').map((entry) => entry.payload.sessionId), [
        'sess_restore_ok', 'sess_restore_failed',
    ]);
    const restoredStart = workerRequests.find((entry) => entry.payload.sessionId === 'sess_restore_ok');
    assert.equal(restoredStart.payload.options.vcp.model, 'restored-model');
    assert.equal(restoredStart.payload.options.systemPrompt.startsWith('Restored system prompt.'), true);
    assert.match(restoredStart.payload.options.systemPrompt, /VCPToolBox plugins are the only execution backend/);
    assert.equal(restoredStart.payload.options.summary, 'restored summary');
    assert.deepEqual(restoredStart.payload.options.messages, restoredMessages);
    assert.equal(JSON.stringify(restoredStart).includes('test-secret'), false);
    assert.equal(restoredManager.registry.get('sess_restore_failed').state, 'failed');
    assert.equal(savedSessions.some((entry) => entry.sessionId === 'sess_restore_failed' && entry.state === 'failed'), true);
} finally {
    await restoredManager.stop();
}

// A standalone Pi probe confirms package loading without making a model request.
const sidecar = path.join(root, 'agent-runtime', 'sidecar.cjs');
const piProbe = await new Promise((resolve, reject) => {
    const child = fork(sidecar, [], {
        cwd: root,
        execPath: resolveElectronNodeExecPath(root),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_RUNTIME_DRIVER: 'pi' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Pi probe timeout'));
    }, 30000);
    child.on('message', (message) => {
        if (message?.type !== 'ready') return;
        clearTimeout(timer);
        child.send({ type: 'shutdown', requestId: 'probe-shutdown' });
        resolve(message.probe);
    });
    child.on('error', reject);
});
assert.equal(piProbe.available, true, piProbe.details);
assert.equal(piProbe.piAgentCore, '0.82.1-vcp.1');

console.log('Agent Runtime manager, worker lifecycle, mock turn, cancel, and Pi probe tests passed.');
