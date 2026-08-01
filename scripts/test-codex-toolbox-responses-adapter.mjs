import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ToolboxResponsesAdapter } = require('../modules/codex-runtime/toolboxResponsesAdapter.js');

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    return `http://127.0.0.1:${server.address().port}`;
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

const received = [];
const upstream = http.createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer upstream-test-key');
    const body = await readJson(request);
    received.push(body);
    if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stream","function":{"name":"vcp_invoke","arguments":"{\\\"tool\\\":\\\"File"}}]}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Operator\\\"}"}}]}}]}\n\n');
        response.end('data: [DONE]\n\n');
        return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
        id: 'chat_non_stream', model: body.model, created: 1,
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
            id: 'call_non_stream', type: 'function', function: { name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}' },
        }] } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }));
});

const upstreamBase = await listen(upstream);
const adapter = new ToolboxResponsesAdapter({ toolboxUrl: `${upstreamBase}/v1/responses`, toolboxApiKey: 'upstream-test-key' });
await adapter.start();

try {
    const baseRequest = {
        model: 'gpt-5.6-luna',
        instructions: 'Use supplied tools only.',
        input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read package.json' }] },
            { type: 'function_call', call_id: 'call_previous', name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}' },
            { type: 'function_call_output', call_id: 'call_previous', output: [{ type: 'input_text', text: 'completed' }] },
        ],
        tools: [
            { type: 'function', name: 'shell_command', description: 'must be removed', parameters: { type: 'object' } },
            { type: 'function', name: 'update_plan', description: 'must be removed', parameters: { type: 'object' } },
            { type: 'function', name: 'vcp_invoke', description: 'VCP wrapper', parameters: { type: 'object', additionalProperties: true } },
        ],
    };
    const response = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseRequest),
    });
    assert.equal(response.status, 200);
    const mapped = await response.json();
    assert.deepEqual(mapped.output, [{
        id: 'fc_call_non_stream', type: 'function_call', call_id: 'call_non_stream', name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}',
    }]);
    assert.deepEqual(received[0].messages, [
        { role: 'system', content: 'Use supplied tools only.' },
        { role: 'user', content: 'Read package.json' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_previous', type: 'function', function: { name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}' } }] },
        { role: 'tool', tool_call_id: 'call_previous', content: 'completed' },
    ]);
    assert.deepEqual(received[0].tools, [{ type: 'function', function: { name: 'vcp_invoke', description: 'VCP wrapper', parameters: { type: 'object', additionalProperties: true } } }]);

    const streamResponse = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...baseRequest, stream: true, input: 'Use vcp_invoke.' }),
    });
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    const events = streamText.split('\n\n').filter(Boolean).map((chunk) => {
        const data = chunk.split('\n').find((line) => line.startsWith('data: '));
        return JSON.parse(data.slice(6));
    });
    const call = events.find((event) => event.type === 'response.output_item.done' && event.item?.type === 'function_call');
    assert.deepEqual(call?.item, {
        id: 'fc_call_stream', type: 'function_call', call_id: 'call_stream', name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}',
    });
    assert.equal(events.at(-1).type, 'response.completed');

    const forbidden = await fetch(`http://127.0.0.1:${adapter.port}/v1/wrong/responses`, { method: 'POST' });
    assert.equal(forbidden.status, 404, 'adapter must require the process-local loopback capability path');
} finally {
    await adapter.stop();
    await new Promise((resolve) => upstream.close(resolve));
}

console.log('VChat-owned ToolBox Responses adapter tests passed.');
