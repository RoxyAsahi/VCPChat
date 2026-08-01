import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexRuntimeManager } = require('../modules/codex-runtime/runtimeManager.js');

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(`http://127.0.0.1:${server.address().port}`);
        });
    });
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.once('error', reject);
        request.once('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
        });
    });
}

function stream(response, chunks) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const value of chunks) response.write(`data: ${JSON.stringify(value)}\n\n`);
    response.end('data: [DONE]\n\n');
}

const requests = [];
const upstream = http.createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer adapter-upstream-test-key');
    const body = await readJson(request);
    requests.push(body);
    const hasToolOutput = body.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_adapter_file');
    if (!hasToolOutput) {
        const toolNames = (body.tools || []).map((tool) => tool.function?.name || tool.name).filter(Boolean).sort();
        assert.deepEqual(toolNames, ['vcp_invoke'],
            'ToolBox-only Threads must expose exactly vcp_invoke and no native Codex/MCP/utility tools');
        stream(response, [{
            id: 'chat_tool_request', model: body.model,
            choices: [{ delta: { tool_calls: [{
                index: 0, id: 'call_adapter_file', type: 'function',
                function: { name: 'vcp_invoke', arguments: '{"tool":"FileOperator","arguments":{"command":"ReadFile","filePath":"package.json"}}' },
            }] } }],
        }]);
        return;
    }
    stream(response, [{
        id: 'chat_final', model: body.model,
        choices: [{ delta: { content: 'adapter-real-sentinel' } }],
    }]);
});

const upstreamBase = await listen(upstream);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-adapter-real-'));
const bridgeCalls = [];
const manager = new CodexRuntimeManager({
    projectRoot: path.resolve(import.meta.dirname, '..'),
    settingsPath: path.join(root, 'settings.json'),
    getSettings: () => ({
        vcpServerUrl: `${upstreamBase}/v1/chat/completions`,
        vcpApiKey: 'adapter-upstream-test-key',
        agentRuntime: { codex: { model: 'gpt-5.6-luna' } },
    }),
});
manager.bridge = {
    async start() {},
    async stop() {},
    async invoke(call) {
        bridgeCalls.push(call);
        return { result: { ok: true, output: 'package name: vcp-chat-desktop' } };
    },
    async interrupt() { return { interrupted: true }; },
    async respondApproval() { return { written: true }; },
};

function waitForTurn(session, timeoutMs = 45_000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            manager.off('event', onEvent);
            reject(new Error('timed out waiting for Codex App Server adapter turn'));
        }, timeoutMs);
        const onEvent = (event) => {
            if (event?.sessionId !== session.sessionId || event?.threadId !== session.threadId) return;
            if (event?.type === 'runtime.crashed') {
                clearTimeout(timeout); manager.off('event', onEvent); reject(new Error(event.error?.message || 'Codex crashed'));
            }
            if (event?.method === 'turn/completed') {
                clearTimeout(timeout); manager.off('event', onEvent); resolve(event);
            }
        };
        manager.on('event', onEvent);
    });
}

try {
    await manager.start();
    const topic = await manager.createTopic({ title: 'Codex App Server adapter real', model: 'gpt-5.6-luna' });
    const session = await manager.createSession({ resume: topic.topicId });
    const completed = waitForTurn(session);
    await manager.startTurn({ sessionId: session.sessionId, prompt: 'Use FileOperator to read package.json.' });
    const completion = await completed;
    assert.equal(completion.turnStatus, 'completed');
    assert.deepEqual(bridgeCalls, [{
        requestId: `codex:${session.threadId}:${completion.turnId}:call_adapter_file`,
        toolName: 'FileOperator',
        arguments: { command: 'ReadFile', filePath: 'package.json' },
    }]);
    assert.ok(requests.length >= 2, 'function_call_output must make Codex issue a continuation request through the adapter');
    assert.ok(requests.at(-1).messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_adapter_file'));
    const projection = await manager.readTopic({ sessionId: session.sessionId, reconcile: false });
    assert.match(JSON.stringify(projection), /adapter-real-sentinel/);
    console.log('Real Codex App Server -> VChat Responses adapter -> Chat tool call continuation passed.');
} finally {
    await manager.stop().catch(() => null);
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
}
