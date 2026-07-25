import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentRuntimeManager } = require('../modules/agent-runtime/runtimeManager.js');
const { resolveElectronNodeExecPath } = require('../modules/agent-runtime/workerTransport.js');

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
assert.equal(piProbe.piAgentCore, '0.82.0');

console.log('Agent Runtime manager, worker lifecycle, mock turn, cancel, and Pi probe tests passed.');
