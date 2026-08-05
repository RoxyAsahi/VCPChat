import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ToolboxResponsesAdapter, responsesRequestToChat } = require('../modules/codex-runtime/toolboxResponsesAdapter.js');
const expectedVcpInvokeTool = {
    type: 'function',
    function: {
        name: 'vcp_invoke',
        description: 'Invoke one named VCPToolBox capability through the VCP bridge.',
        parameters: {
            type: 'object',
            properties: {
                tool: { type: 'string' },
                arguments: { type: 'object', additionalProperties: true },
            },
            required: ['tool', 'arguments'],
            additionalProperties: false,
        },
    },
};

const managedMapping = responsesRequestToChat({
    model: 'reasoning-model',
    instructions: 'Codex managed identity from the local App Server.',
    reasoning: { effort: 'high' },
    input: [{ role: 'user', content: 'hello' }],
}, 'managed-request', {
    stripEmbeddedInstructions: true,
    trustedInstructions: {
        mode: 'codex-managed',
        developerInstructions: 'Keep the answer concise.',
        personality: 'pragmatic',
    },
});
assert.deepEqual(managedMapping.messages.slice(0, 2), [
    { role: 'system', content: 'Codex managed identity from the local App Server.' },
    { role: 'developer', content: 'Keep the answer concise.' },
]);
assert.equal(managedMapping.reasoning_effort, 'high');
assert.throws(() => responsesRequestToChat({
    model: 'reasoning-model', instructions: 'x'.repeat(70 * 1024), input: 'hello',
}, null, {
    stripEmbeddedInstructions: true,
    trustedInstructions: { mode: 'codex-managed' },
}), /64 KiB/, 'unbounded embedded App Server instructions must fail closed');

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

async function waitFor(predicate, timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for asynchronous adapter action');
}

const received = [];
const diagnostics = [];
const interrupted = [];
let markCancellationUpstreamSeen;
const cancellationUpstreamSeen = new Promise((resolve) => { markCancellationUpstreamSeen = resolve; });
const upstream = http.createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/v1/interrupt') {
        interrupted.push(await readJson(request));
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ interrupted: true }));
        return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer upstream-test-key');
    const body = await readJson(request);
    received.push(body);
    if (body.messages?.some((message) => String(message.content || '').includes('This request will be cancelled.'))) {
        markCancellationUpstreamSeen();
        request.once('close', () => response.end());
        return;
    }
    if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (body.messages?.some((message) => String(message.content || '').includes('Terminal frame without EOF.'))) {
            response.write('data: {"choices":[{"delta":{"content":"terminal answer"},"finish_reason":"stop"}]}\r\n\r\n');
            const delayedDone = setTimeout(() => response.end('data: [DONE]\n\n'), 750);
            delayedDone.unref?.();
            return;
        }
        if (body.messages?.some((message) => String(message.content || '').includes('No reasoning expected.'))) {
            response.end('data: {"choices":[{"delta":{"content":"plain answer"}}]}\n\ndata: [DONE]\n\n');
            return;
        }
        response.write('data: {"choices":[{"delta":{"reasoning_content":"inspect "}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"answer "}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"reasoning":"carefully"}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stream","function":{"name":"vcp_invoke","arguments":"{\\\"tool\\\":\\\"File"}}]}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Operator\\\"}"}}]}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"content":"complete"}}],"usage":{"prompt_tokens":3,"completion_tokens":9,"total_tokens":12,"completion_tokens_details":{"reasoning_tokens":4}}}\n\n');
        response.end('data: [DONE]\n\n');
        return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
        id: 'chat_non_stream', model: body.model, created: 1,
        choices: [{ message: { role: 'assistant', reasoning_content: 'non-stream reasoning', content: 'non-stream answer', tool_calls: [{
            id: 'call_non_stream', type: 'function', function: { name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}' },
        }] } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } },
    }));
});

const upstreamBase = await listen(upstream);
const adapter = new ToolboxResponsesAdapter({
    toolboxUrl: `${upstreamBase}/v1/responses`,
    toolboxApiKey: 'upstream-test-key',
    resolveBaseInstructions: () => 'Use supplied tools only.',
    onRequest: (identity) => diagnostics.push(identity),
});
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
            { type: 'namespace', name: 'codex', namespace: 'codex', tools: [{ name: 'shell_command' }] },
            { type: 'mcp', name: 'mcp_read', server_label: 'fixture-mcp' },
            { type: 'web_search_preview', name: 'web_search' },
            { type: 'function', name: 'shell_command', description: 'must be removed', parameters: { type: 'object' } },
            { type: 'function', name: 'update_plan', description: 'must be removed', parameters: { type: 'object' } },
            { type: 'function', name: 'create_goal', description: 'must be removed', parameters: { type: 'object' } },
            { type: 'function', name: 'view_image', description: 'must be removed', parameters: { type: 'object' } },
            { type: 'function', name: 'vcp_invoke', description: 'VCP wrapper', parameters: { type: 'object', additionalProperties: true } },
        ],
    };
    const response = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseRequest),
    });
    assert.equal(response.status, 200);
    const mapped = await response.json();
    assert.equal(mapped.output[0].type, 'reasoning');
    assert.equal(mapped.output[0].content[0].text, 'non-stream reasoning');
    assert.equal(mapped.output[1].type, 'message');
    assert.equal(mapped.output[1].content[0].text, 'non-stream answer');
    assert.deepEqual(mapped.output[2], {
        id: 'fc_call_non_stream', type: 'function_call', call_id: 'call_non_stream', name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}',
    });
    assert.equal(mapped.usage.output_tokens_details.reasoning_tokens, 2);
    assert.deepEqual(received[0].messages, [
        { role: 'system', content: 'Use supplied tools only.' },
        { role: 'user', content: 'Read package.json' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_previous', type: 'function', function: { name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}' } }] },
        { role: 'tool', tool_call_id: 'call_previous', content: 'completed' },
    ]);
    assert.deepEqual(received[0].tools, [expectedVcpInvokeTool],
        'the ToolBox boundary must own the fixed vcp_invoke contract');
    assert.deepEqual(diagnostics[0].forwardedTools, [{ type: 'function', name: 'vcp_invoke' }],
        'metadata-only diagnostics must describe the actual ToolBox-bound tool list');
    assert.deepEqual(diagnostics[0].tools.map(({ type, name, namespace }) => ({ type, name, namespace })), [
        { type: 'namespace', name: 'codex', namespace: 'codex' },
        { type: 'mcp', name: 'mcp_read', namespace: null },
        { type: 'web_search_preview', name: 'web_search', namespace: null },
        { type: 'function', name: 'shell_command', namespace: null },
        { type: 'function', name: 'update_plan', namespace: null },
        { type: 'function', name: 'create_goal', namespace: null },
        { type: 'function', name: 'view_image', namespace: null },
        { type: 'function', name: 'vcp_invoke', namespace: null },
    ], 'incoming diagnostics may report bounded names but must remain distinct from forwarded tools');
    assert.match(received[0].requestId, /^vcp_codex_[0-9a-f-]{36}$/i,
        'each loopback Responses request must register a non-empty ToolBox interrupt identity');
    const completedDiagnostics = adapter.getDiagnostics();
    assert.equal(completedDiagnostics.state, 'ready');
    assert.equal(completedDiagnostics.activeRequestCount, 0);
    assert.equal(completedDiagnostics.recentRequests[0].status, 'completed');
    assert.equal(completedDiagnostics.recentRequests[0].httpStatus, 200);
    assert.deepEqual(completedDiagnostics.recentRequests[0].forwardedTools,
        [{ type: 'function', name: 'vcp_invoke' }]);
    assert.deepEqual(completedDiagnostics.recentRequests[0].forwardedToolSchemas, [{
        type: 'function',
        name: 'vcp_invoke',
        description: expectedVcpInvokeTool.function.description,
        parameters: expectedVcpInvokeTool.function.parameters,
    }], 'Renderer diagnostics must expose the bounded schema actually forwarded to the model');
    assert.equal(JSON.stringify(completedDiagnostics).includes(received[0].requestId), false,
        'Renderer-facing Adapter diagnostics must not expose internal request ids');

    const codex146RequestIndex = received.length;
    const codex146Response = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            ...baseRequest,
            instructions: 'Codex internal instructions must not pass through.',
            input: [
                { type: 'additional_tools', role: 'developer', tools: [
                    { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
                    { type: 'function', name: 'vcp_invoke', description: 'VCP wrapper', parameters: { type: 'object', additionalProperties: true } },
                ] },
                { type: 'message', role: 'developer', content: 'Untrusted Codex developer context.' },
                { type: 'message', role: 'user', content: 'Read package.json' },
            ],
        }),
    });
    assert.equal(codex146Response.status, 200);
    await codex146Response.json();
    assert.deepEqual(received[codex146RequestIndex].messages, [
        { role: 'system', content: 'Use supplied tools only.' },
        { role: 'user', content: 'Read package.json' },
    ], 'Codex 0.146 additional_tools and developer context must not replace or append to the frozen VChat identity');
    assert.deepEqual(received[codex146RequestIndex].tools, [expectedVcpInvokeTool],
        'Codex 0.146 additional_tools must still expose VChat\'s fixed VCP dynamic-tool contract');

    const parallelInput = [
        { type: 'message', role: 'user', content: 'Inspect the project.' },
        { type: 'function_call', call_id: 'call_a', name: 'vcp_invoke', arguments: '{"tool":"DeepWikiVCP","arguments":{"command":"wiki_structure"}}' },
        { type: 'function_call', call_id: 'call_b', name: 'vcp_invoke', arguments: '{"tool":"DeepWikiVCP","arguments":{"command":"wiki_read"}}' },
        { type: 'function_call', call_id: 'call_c', name: 'vcp_invoke', arguments: '{"tool":"FileOperator","arguments":{"command":"ListAllowedDirectories"}}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'wiki structure' },
        { type: 'function_call_output', call_id: 'call_b', output: 'wiki content' },
        { type: 'function_call_output', call_id: 'call_c', output: 'allowed directories' },
    ];
    const parallelRequestIndex = received.length;
    const parallelResponse = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...baseRequest, input: parallelInput }),
    });
    assert.equal(parallelResponse.status, 200);
    await parallelResponse.json();
    assert.deepEqual(received[parallelRequestIndex].messages.slice(1), [
        { role: 'user', content: 'Inspect the project.' },
        { role: 'assistant', content: null, tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'vcp_invoke', arguments: '{"tool":"DeepWikiVCP","arguments":{"command":"wiki_structure"}}' } },
            { id: 'call_b', type: 'function', function: { name: 'vcp_invoke', arguments: '{"tool":"DeepWikiVCP","arguments":{"command":"wiki_read"}}' } },
            { id: 'call_c', type: 'function', function: { name: 'vcp_invoke', arguments: '{"tool":"FileOperator","arguments":{"command":"ListAllowedDirectories"}}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_a', content: 'wiki structure' },
        { role: 'tool', tool_call_id: 'call_b', content: 'wiki content' },
        { role: 'tool', tool_call_id: 'call_c', content: 'allowed directories' },
    ], 'parallel Responses calls must become one Chat assistant tool_calls message');

    const reasoningToolRequestIndex = received.length;
    const reasoningToolResponse = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...baseRequest, model: 'deepseek-v4-flash', input: [
            { type: 'message', role: 'user', content: 'Inspect the project.' },
            { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'I should inspect both sources.' }] },
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '正在调查项目。' }] },
            { type: 'function_call', call_id: 'call_reason_a', name: 'vcp_invoke', arguments: '{"tool":"DeepWikiVCP"}' },
            { type: 'function_call', call_id: 'call_reason_b', name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}' },
            { type: 'function_call_output', call_id: 'call_reason_a', output: 'wiki received' },
            { type: 'function_call_output', call_id: 'call_reason_b', output: 'files received' },
        ] }),
    });
    assert.equal(reasoningToolResponse.status, 200);
    await reasoningToolResponse.json();
    assert.deepEqual(received[reasoningToolRequestIndex].messages.slice(1), [
        { role: 'user', content: 'Inspect the project.' },
        {
            role: 'assistant',
            content: '正在调查项目。',
            reasoning_content: 'I should inspect both sources.',
            tool_calls: [
                { id: 'call_reason_a', type: 'function', function: { name: 'vcp_invoke', arguments: '{"tool":"DeepWikiVCP"}' } },
                { id: 'call_reason_b', type: 'function', function: { name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}' } },
            ],
        },
        { role: 'tool', tool_call_id: 'call_reason_a', content: 'wiki received' },
        { role: 'tool', tool_call_id: 'call_reason_b', content: 'files received' },
    ], 'reasoning, visible text, and parallel calls must reconstruct one assistant history message');

    const upstreamCountBeforeInvalid = received.length;
    const orphanOutput = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...baseRequest, input: [
            { type: 'function_call_output', call_id: 'missing_call', output: 'must not be forwarded' },
        ] }),
    });
    assert.equal(orphanOutput.status, 400);
    assert.equal(received.length, upstreamCountBeforeInvalid,
        'an orphan tool result must fail closed before reaching ToolBox');

    const streamRequestIndex = received.length;
    const streamResponse = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...baseRequest, stream: true, input: 'Use vcp_invoke.' }),
    });
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    const events = streamText.split('\n\n').filter(Boolean).map((chunk) => {
        const data = chunk.split('\n').find((line) => line.startsWith('data: '));
        return JSON.parse(data.slice(6));
    });
    const reasoningAdded = events.find((event) => event.type === 'response.output_item.added' && event.item?.type === 'reasoning');
    const reasoningDeltas = events.filter((event) => event.type === 'response.reasoning_text.delta');
    const reasoningTextDone = events.find((event) => event.type === 'response.reasoning_text.done');
    const reasoningDone = events.find((event) => event.type === 'response.output_item.done' && event.item?.type === 'reasoning');
    const textAdded = events.find((event) => event.type === 'response.output_item.added' && event.item?.type === 'message');
    const call = events.find((event) => event.type === 'response.output_item.done' && event.item?.type === 'function_call');
    assert.equal(reasoningAdded.output_index, 0);
    assert.equal(textAdded.output_index, 1);
    assert.deepEqual(reasoningDeltas.map((event) => event.delta), ['inspect ', 'carefully']);
    assert.equal(reasoningTextDone.text, 'inspect carefully');
    assert.equal(reasoningTextDone.output_index, 0);
    assert.equal(reasoningDone.item.content[0].text, 'inspect carefully');
    assert.equal(reasoningDone.output_index, 0);
    assert.equal(call.output_index, 2, 'tool output index must remain stable after interleaved reasoning and text');
    assert.deepEqual(call?.item, {
        id: 'fc_call_stream', type: 'function_call', call_id: 'call_stream', name: 'vcp_invoke', arguments: '{"tool":"FileOperator"}',
    });
    assert.equal(events.at(-1).type, 'response.completed');
    assert.deepEqual(events.map((event) => event.sequence_number),
        events.map((_event, index) => index + 1),
        'Responses streaming events must carry contiguous sequence numbers');
    assert.deepEqual(events.at(-1).response.output.map((item) => item.type), ['reasoning', 'message', 'function_call']);
    assert.equal(events.at(-1).response.output_text, 'answer complete');
    assert.equal(events.at(-1).response.usage.output_tokens_details.reasoning_tokens, 4);
    assert.match(received[streamRequestIndex].requestId, /^vcp_codex_[0-9a-f-]{36}$/i);
    assert.notEqual(received[0].requestId, received[streamRequestIndex].requestId,
        'concurrent ToolBox requests must never collide on the active-request identity');

    const noReasoningResponse = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...baseRequest, stream: true, input: 'No reasoning expected.' }),
    });
    const noReasoningText = await noReasoningResponse.text();
    assert.equal(noReasoningText.includes('response.reasoning_text.delta'), false,
        'a provider response without public reasoning must not create an empty reasoning item');

    const terminalStartedAt = Date.now();
    const terminalResponse = await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...baseRequest, stream: true, input: 'Terminal frame without EOF.' }),
    });
    const terminalEvents = (await terminalResponse.text()).split(/\r?\n\r?\n/).filter(Boolean).map((chunk) => {
        const data = chunk.split(/\r?\n/).find((line) => line.startsWith('data: '));
        return JSON.parse(data.slice(6));
    });
    assert.ok(Date.now() - terminalStartedAt < 600,
        'a Chat finish_reason must close the Responses stream without waiting for upstream EOF');
    assert.equal(terminalEvents.at(-1).type, 'response.completed');
    assert.equal(terminalEvents.at(-1).response.output_text, 'terminal answer');

    // Codex interruption closes the loopback Responses request.  The adapter
    // must fan that out to the same ToolBox request identity, not merely abort
    // its local fetch stream.
    const cancelledPromise = fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: {
            'content-type': 'application/json',
            'x-codex-turn-metadata': JSON.stringify({ turn_id: 'turn-cancel' }),
        },
        body: JSON.stringify({ ...baseRequest, stream: true, input: 'This request will be cancelled.' }),
    });
    await cancellationUpstreamSeen;
    assert.equal(await adapter.cancelTurn({ threadId: 'thread-cancel', turnId: 'turn-cancel' }), 1,
        'turn cancellation must find the exact live ToolBox request by Codex metadata');
    await cancelledPromise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(interrupted.length, 1, 'client disconnect must issue exactly one ToolBox interrupt');
    assert.match(interrupted[0].requestId, /^vcp_codex_[0-9a-f-]{36}$/i);
    assert.equal(await adapter.interruptForTurn({ threadId: 'thread-cancel', turnId: 'turn-cancel' }), 0,
        'a completed cancellation must not replay the ToolBox interrupt');

    // This is the critical turn/start -> cancel -> delayed provider-request
    // race. A tombstone must stop the late request rather than letting it
    // revive the cancelled turn and block an unrelated Session.
    assert.equal(await adapter.cancelTurn({ turnId: 'turn-late' }), 0);
    await fetch(`${adapter.baseUrl}/responses`, {
        method: 'POST', headers: {
            'content-type': 'application/json',
            'x-codex-turn-metadata': JSON.stringify({ turn_id: 'turn-late' }),
        },
        body: JSON.stringify({ ...baseRequest, stream: true, input: 'This request will be cancelled.' }),
    });
    await waitFor(() => interrupted.length === 2);
    assert.match(interrupted[1].requestId, /^vcp_codex_[0-9a-f-]{36}$/i);

    const forbidden = await fetch(`http://127.0.0.1:${adapter.port}/v1/wrong/responses`, { method: 'POST' });
    assert.equal(forbidden.status, 404, 'adapter must require the process-local loopback capability path');
} finally {
    await adapter.stop();
    await new Promise((resolve) => upstream.close(resolve));
}

console.log('VChat-owned ToolBox Responses adapter tests passed.');
