import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { resolveElectronNodeExecPath } = require('../archive/agent-runtime/workerTransport.js');
const sidecar = path.join(root, 'agent-runtime', 'sidecar.cjs');
const child = fork(sidecar, [], {
    cwd: root,
    execPath: resolveElectronNodeExecPath(root),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_RUNTIME_DRIVER: 'pi' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
});

const received = [];
let stderr = '';
let modelRequestBody = null;
let modelRequestCount = 0;
const toolRequests = [];
child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
child.on('message', (message) => {
    received.push(message);
    if (message.type === 'model-request') {
        modelRequestCount += 1;
        if (!modelRequestBody) modelRequestBody = message.body;
        if (modelRequestCount === 1) {
            // Some OpenAI-compatible servers repeat `function.name` in every
            // SSE chunk. The worker must retain one tool name, not concatenate it.
            child.send({
                type: 'model-delta', requestId: message.requestId,
                delta: { tool_calls: [{ index: 0, id: 'call_pi', function: { name: 'vcp_invoke', arguments: '{"toolName":"FileOperator",' } }] },
            });
            child.send({
                type: 'model-delta', requestId: message.requestId,
                delta: { tool_calls: [{ index: 0, function: { name: 'vcp_invoke', arguments: '"arguments":{"command":"ListAllowedDirectories"}}' } }] },
            });
            child.send({
                type: 'model-done', requestId: message.requestId, finishReason: 'tool_calls',
                usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
            });
        } else {
            child.send({
                type: 'model-delta', requestId: message.requestId,
                delta: { content: 'Pi worker loop is alive.' },
            });
            child.send({
                type: 'model-done', requestId: message.requestId, finishReason: 'stop',
                usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
            });
        }
    }
    if (message.type === 'tool-request') {
        toolRequests.push(message);
        child.send({
            type: 'tool-result', sessionId: message.sessionId, turnId: message.turnId,
            toolCallId: message.toolCallId, ok: true, output: 'Directory listing returned.',
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
        options: {
            vcp: { model: 'test-model', apiKey: 'must-not-reach-model' },
            systemPrompt: 'Answer briefly.',
            summary: 'The restored task is already scoped.',
            messages: [
                { role: 'user', content: 'Restored question', createdAt: 1 },
                { role: 'assistant', content: [{ type: 'text', text: 'Restored answer' }], createdAt: 2 },
                { role: 'assistant', content: [{ type: 'toolCall', id: 'unsafe', name: 'removed_local_executor', arguments: {} }] },
                { role: 'user', content: 'Compacted secret', compacted: true },
                { role: 'toolResult', content: 'Unsafe tool output', toolCallId: 'unsafe' },
            ],
        },
    });
    const started = await waitFor((m) => m.type === 'session-started' && m.requestId === 'session-req');
    assert.equal(started.ok, true, started.error);
    child.send({
        type: 'start-turn', requestId: 'turn-req', sessionId: 'sess_pi_loop', turnId: 'turn_pi_loop', prompt: 'ping',
    });
    const ack = await waitFor((m) => m.type === 'ack' && m.requestId === 'turn-req');
    assert.equal(ack.ok, true, ack.error || ack.result?.error);
    await waitFor((m) => m.type === 'event' && m.event?.type === 'assistant.delta' && m.event.payload.text === 'Pi worker loop is alive.');
    assert.equal(modelRequestCount, 2);
    assert.equal(toolRequests.length, 1);
    assert.equal(toolRequests[0].toolName, 'vcp_invoke');
    assert.deepEqual(toolRequests[0].arguments, {
        toolName: 'FileOperator', arguments: { command: 'ListAllowedDirectories' },
    });
    const deltas = received
        .filter((m) => m.type === 'event' && m.event?.type === 'assistant.delta')
        .map((m) => m.event.payload.text)
        .join('');
    assert.equal(deltas, 'Pi worker loop is alive.');
    assert.equal(received.some((m) => m.type === 'model-request'), true);
    assert.deepEqual(modelRequestBody.messages.slice(0, 4), [
        { role: 'system', content: 'Answer briefly.' },
        { role: 'user', content: '[Previous conversation summary]\nThe restored task is already scoped.' },
        { role: 'user', content: 'Restored question' },
        { role: 'assistant', content: 'Restored answer' },
    ]);
    assert.equal(JSON.stringify(modelRequestBody).includes('must-not-reach-model'), false);
    assert.equal(JSON.stringify(modelRequestBody).includes('Unsafe tool output'), false);
    assert.equal(JSON.stringify(modelRequestBody).includes('Compacted secret'), false);
    const toolNames = modelRequestBody.tools.map((tool) => tool.function?.name || tool.name);
    assert.equal(toolNames.includes('vcp_invoke'), true);
    assert.equal(toolNames.includes('workspace_propose_patch'), true);
    for (const removed of ['workspace_read', 'workspace_list', 'workspace_search', 'terminal_execute']) {
        assert.equal(toolNames.includes(removed), false);
    }
    const assistantEvents = received.filter((m) => m.type === 'event' && m.event?.type.startsWith('assistant.'));
    assert.ok(assistantEvents.length >= 3);
    assert.ok(assistantEvents[0].event.messageId);
    // A tool-use response and its post-tool final response are separate assistant
    // messages; each message still keeps a stable ID across its own stream events.
    assert.equal(new Set(assistantEvents.map((m) => m.event.messageId)).size, 2);
    child.send({ type: 'shutdown', requestId: 'shutdown-req' });
    await waitFor((m) => m.type === 'ack' && m.requestId === 'shutdown-req');
} finally {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
}

console.log('Pi worker loop test passed (real Pi Agent + mocked main-process model bridge).');
