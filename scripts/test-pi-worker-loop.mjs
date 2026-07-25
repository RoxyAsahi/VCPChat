import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { resolveElectronNodeExecPath } = require('../modules/agent-runtime/workerTransport.js');
const sidecar = path.join(root, 'agent-runtime', 'sidecar.cjs');
const child = fork(sidecar, [], {
    cwd: root,
    execPath: resolveElectronNodeExecPath(root),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_RUNTIME_DRIVER: 'pi' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
});

const received = [];
let stderr = '';
child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
child.on('message', (message) => {
    received.push(message);
    if (message.type === 'model-request') {
        child.send({
            type: 'model-result',
            requestId: message.requestId,
            ok: true,
            data: {
                id: 'chatcmpl-test',
                choices: [{ index: 0, message: { role: 'assistant', content: 'Pi worker loop is alive.' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
            },
        });
    }
});

function waitFor(predicate, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
            const found = received.find(predicate);
            if (found) return resolve(found);
            if (Date.now() >= deadline) return reject(new Error(`timeout; stderr=${stderr}`));
            setTimeout(poll, 10);
        };
        poll();
    });
}

try {
    const ready = await waitFor((m) => m.type === 'ready');
    assert.equal(ready.probe.available, true, ready.probe.details);
    child.send({
        type: 'start-session', requestId: 'session-req', sessionId: 'sess_pi_loop',
        options: { vcp: { model: 'test-model' }, systemPrompt: 'Answer briefly.' },
    });
    const started = await waitFor((m) => m.type === 'session-started' && m.requestId === 'session-req');
    assert.equal(started.ok, true, started.error);
    child.send({
        type: 'start-turn', requestId: 'turn-req', sessionId: 'sess_pi_loop', turnId: 'turn_pi_loop', prompt: 'ping',
    });
    const ack = await waitFor((m) => m.type === 'ack' && m.requestId === 'turn-req');
    assert.equal(ack.ok, true, ack.error || ack.result?.error);
    const deltas = received
        .filter((m) => m.type === 'event' && m.event?.type === 'assistant.delta')
        .map((m) => m.event.payload.text)
        .join('');
    assert.equal(deltas, 'Pi worker loop is alive.');
    assert.equal(received.some((m) => m.type === 'model-request'), true);
    child.send({ type: 'shutdown', requestId: 'shutdown-req' });
    await waitFor((m) => m.type === 'ack' && m.requestId === 'shutdown-req');
} finally {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
}

console.log('Pi worker loop test passed (real Pi Agent + mocked main-process model bridge).');
