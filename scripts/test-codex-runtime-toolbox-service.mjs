import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InteractionRegistry } = require('../modules/codex-runtime/interactionRegistry.js');
const { RuntimeToolboxService } = require('../modules/codex-runtime/runtime-toolbox-service.js');

let generation = 5;
let authorityGeneration = 2;
const responses = [];
const errors = [];
const events = [];
const invokes = [];
const interrupts = [];
let invokeHandler = async (payload) => ({ result: { ok: true, output: JSON.stringify(payload.arguments) } });
const transport = {
    respond: (requestId, result) => responses.push({ requestId, result }),
    respondError: (requestId, code, message) => errors.push({ requestId, code, message }),
};
const bridge = {
    invoke(payload) { invokes.push(payload); return invokeHandler(payload); },
    async interrupt(requestId) { interrupts.push(requestId); },
};
const interactions = {
    serverRequests: new Map(),
    toolboxApprovals: new Map(),
    interactions: new InteractionRegistry(),
};
interactions.interactions.setGeneration('toolbox', authorityGeneration);
const service = new RuntimeToolboxService({
    transport: () => transport,
    bridge: () => bridge,
    runtimeGeneration: () => generation,
    toolboxAuthorityGeneration: () => authorityGeneration,
    interactions,
    sendUiEvent: (event) => events.push(event),
    diagnostic: () => {},
});

const dynamicCall = (id) => ({
    id,
    method: 'item/tool/call',
    params: {
        threadId: 'thread-a', turnId: 'turn-a', callId: `call-${id}`, tool: 'vcp_invoke',
        arguments: { tool: 'FileOperator', arguments: { command: 'list', path: '.' } },
    },
});
await service.handleDynamicToolCall(dynamicCall('rpc-1'));
assert.equal(invokes[0].toolName, 'FileOperator');
assert.deepEqual(invokes[0].arguments, { command: 'list', path: '.' });
assert.equal(responses[0].requestId, 'rpc-1');
assert.equal(responses[0].result.success, true);
assert.equal(service.dynamicCalls.size, 0);

let releaseInvoke;
invokeHandler = () => new Promise((resolve) => { releaseInvoke = resolve; });
const staleCall = service.handleDynamicToolCall(dynamicCall('rpc-stale'));
await Promise.resolve();
generation += 1;
releaseInvoke({ result: { ok: true, output: 'late' } });
await staleCall;
assert.equal(responses.some((entry) => entry.requestId === 'rpc-stale'), false,
    'old generation dynamic result must not respond on the replacement transport authority');

service.dynamicCalls.set('rpc-interrupt', { bridgeRequestId: 'codex:thread-a:turn-a:call-x' });
interactions.serverRequests.set('rpc-interrupt', { method: 'item/tool/call' });
await service.interruptDynamicCalls('test stop');
assert.deepEqual(interrupts, ['codex:thread-a:turn-a:call-x']);
assert.equal(interactions.serverRequests.size, 0);

service.handleBridgeEvent({
    channel: 'backend-approval',
    event: { requestId: 'approval-a', expiresAtMs: Date.now() + 60_000, data: { toolName: 'Browser' } },
});
assert.equal(interactions.toolboxApprovals.get('approval-a').generation, authorityGeneration);
assert.equal(events.at(-1).type, 'approval.requested');

service.handleBridgeEvent({ channel: 'info', event: { type: 'RAG_RETRIEVAL_DETAILS', apiKey: 'secret' } });
assert.equal(events.at(-1).payload.kind, 'rag-retrieval');
assert.equal(events.at(-1).payload.value.apiKey, '[redacted]');

console.log('Codex Runtime ToolBox service tests passed.');
