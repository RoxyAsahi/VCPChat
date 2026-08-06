import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { RuntimeHostService } = require('../modules/codex-runtime/runtime-host-service.js');
const { createRuntimeOperationContext } = require('../modules/codex-runtime/runtime-operation-context.js');

let adapterConfig;
let adapter = null;
const sessions = new Map([['thread-a', {
    sessionId: 'session-a',
    threadId: 'thread-a',
    configSnapshot: { executionProfile: 'toolbox-only', instructionMode: 'vchat-identity', baseInstructions: '{{Nova}}' },
    appliedRuntimeConfigRevision: 0,
}]]);
const events = [];
const waiters = new Map();
let generation = 1;
const captureGeneration = () => {
    const captured = generation;
    return { value: captured, assertCurrent(current) {
        if (current !== captured) { const error = new Error('stale'); error.code = 'STALE_RUNTIME_GENERATION'; throw error; }
    } };
};
const service = new RuntimeHostService({
    getSettings: () => ({ vcpServerUrl: 'http://localhost:6005', vcpApiKey: '123456' }),
    responsesAdapter: () => adapter,
    setResponsesAdapter: (value) => { adapter = value; },
    responsesAdapterFactory: () => (config) => {
        adapterConfig = config;
        return { baseUrl: 'http://127.0.0.1:3456/v1', capability: 'cap', start: async () => adapter, stop: async () => {} };
    },
    repository: () => ({ getSessionByThread: (threadId) => sessions.get(threadId) || null }),
    diagnostic: () => {},
    compactionWaiters: () => waiters,
    sendUiEvent: (event) => events.push(event),
    readSession: async ({ sessionId }) => ({ session: { sessionId } }),
    createOperationContext: (identity) => createRuntimeOperationContext(captureGeneration(), identity),
    assertOperationContext: (operation) => operation.generation.assertCurrent(generation),
});

await service.ensureResponsesAdapter();
assert.equal(service.providerParams().modelProvider, 'vcp_toolbox');
assert.deepEqual(adapterConfig.resolveInstructions({ threadId: 'thread-a', sessionId: 'thread-a' }), {
    mode: 'vchat-identity', baseInstructions: '{{Nova}}',
});
assert.throws(() => adapterConfig.resolveInstructions({ threadId: 'thread-a', sessionId: 'wrong' }),
    (error) => error.code === 'SESSION_IDENTITY_MISMATCH');

let completed;
waiters.set('thread-a', {
    sessionId: 'session-a', threadId: 'thread-a', timeout: setTimeout(() => {}, 10_000),
    operation: createRuntimeOperationContext(captureGeneration(), { sessionId: 'session-a', threadId: 'thread-a' }),
    resolve: (value) => { completed = value; }, reject: (error) => { throw error; },
});
service.observeCompactionNotification({
    method: 'item/completed',
    params: { threadId: 'thread-a', item: { id: 'compact-a', type: 'contextCompaction', status: 'completed' } },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(completed.sessionId, 'session-a');
assert.equal(events.at(-1).type, 'compaction.completed');

let staleRejected;
waiters.set('thread-a', {
    sessionId: 'session-a', threadId: 'thread-a', timeout: setTimeout(() => {}, 10_000),
    operation: createRuntimeOperationContext(captureGeneration(), { sessionId: 'session-a', threadId: 'thread-a' }),
    resolve: () => { throw new Error('stale waiter resolved'); }, reject: (error) => { staleRejected = error; },
});
generation += 1;
service.observeCompactionNotification({
    method: 'item/completed',
    params: { threadId: 'thread-a', item: { id: 'compact-stale', type: 'contextCompaction', status: 'completed' } },
});
assert.equal(staleRejected?.code, 'STALE_RUNTIME_GENERATION');
assert.equal(waiters.has('thread-a'), false);

const oldTransport = new EventEmitter();
const replacementTransport = new EventEmitter();
let activeTransport = oldTransport;
let projectedNotifications = 0;
let acceptedRequests = 0;
let dynamicRequests = 0;
let crashes = 0;
let diagnostics = 0;
generation += 1;
const authorityService = new RuntimeHostService({
    transport: () => activeTransport,
    createOperationContext: (identity) => createRuntimeOperationContext(captureGeneration(), identity),
    assertOperationContext: (operation) => operation.generation.assertCurrent(generation),
    intentionalStop: () => false,
    acceptServerRequest: () => { acceptedRequests += 1; },
    handleDynamicToolCall: () => { dynamicRequests += 1; },
    emitDiagnostic: () => { diagnostics += 1; },
});
authorityService.handleNotification = () => { projectedNotifications += 1; };
authorityService.handleTransportCrash = async () => { crashes += 1; };
authorityService.wireTransport();
oldTransport.emit('notification', { method: 'turn/started' });
oldTransport.emit('server-request', { id: 'approval-a', method: 'item/fileChange/requestApproval' });
oldTransport.emit('server-request', { id: 'tool-a', method: 'item/tool/call' });
oldTransport.emit('stderr', 'owned');
assert.deepEqual([projectedNotifications, acceptedRequests, dynamicRequests, diagnostics], [1, 1, 1, 1]);

activeTransport = replacementTransport;
oldTransport.emit('notification', { method: 'turn/completed' });
oldTransport.emit('server-request', { id: 'approval-stale', method: 'item/fileChange/requestApproval' });
oldTransport.emit('server-request', { id: 'tool-stale', method: 'item/tool/call' });
oldTransport.emit('stderr', 'stale');
oldTransport.emit('exit', new Error('stale transport exited'));
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual([projectedNotifications, acceptedRequests, dynamicRequests, diagnostics, crashes], [1, 1, 1, 1, 0],
    'a replaced transport must not mutate the current Runtime generation');

const beforeMessage = {
    messageId: 'message-a', itemId: 'item-a', threadId: 'thread-a', turnId: 'turn-a',
    status: 'inProgress', sourceOrder: 1, createdAt: 1, updatedAt: 1,
    blocks: [
        { kind: 'message', ordinal: 0, authority: 'codex', content: { text: 'final' } },
        { kind: 'observation', ordinal: 1, authority: 'codex', content: { text: 'stale warning' } },
    ],
};
const afterMessage = {
    ...beforeMessage, status: 'completed', updatedAt: 2,
    blocks: [{ kind: 'message', ordinal: 0, authority: 'codex', content: { text: 'final' } }],
};
let projectionRevision = 7;
let messageReadCount = 0;
let emittedPatch = null;
let emittedEvent = null;
const patchRepository = {
    getSessionByThread: () => sessions.get('thread-a'),
    projectionGeneration: () => projectionRevision,
    getProjectedMessageByItem: () => (messageReadCount++ === 0 ? beforeMessage : afterMessage),
};
const usageEvents = [];
const patchService = new RuntimeHostService({
    repository: () => patchRepository,
    projector: () => ({ projectNotification: (message) => {
        if (!message?.params?.item) return false;
        projectionRevision += 1;
        return true;
    } }),
    compactionWaiters: () => new Map(),
    updateThreadState: () => {},
    threadStates: () => new Map(),
    runtimeGeneration: () => 4,
    sendUiEvent: (event) => usageEvents.push(event),
    sendEvent: (event) => { emittedEvent = event; emittedPatch = event.projectionPatch; },
});
patchService.handleNotification({
    method: 'thread/tokenUsage/updated',
    params: {
        threadId: 'thread-a', turnId: 'turn-a',
        tokenUsage: {
            last: { inputTokens: 80, cachedInputTokens: 20, cacheWriteInputTokens: 4,
                outputTokens: 12, reasoningOutputTokens: 5, totalTokens: 92 },
            total: { inputTokens: 180, cachedInputTokens: 40, cacheWriteInputTokens: 8,
                outputTokens: 32, reasoningOutputTokens: 9, totalTokens: 212 },
            modelContextWindow: 1_000,
        },
    },
});
assert.deepEqual(usageEvents.at(-1), {
    type: 'context.usage', sessionId: 'session-a', turnId: 'turn-a',
    payload: {
        schemaVersion: 1, source: 'real', provenance: 'codex-thread', turnId: 'turn-a',
        inputTokens: 80, outputTokens: 12, reasoningTokens: 5, cacheReadTokens: 20,
        cacheWriteTokens: 4, totalTokens: 92, usedTokens: 92, contextTokens: 92,
        contextWindow: 1_000, sessionInputTokens: 180, sessionOutputTokens: 32,
        sessionReasoningTokens: 9, sessionCacheReadTokens: 40, sessionCacheWriteTokens: 8,
        sessionTotalTokens: 212, percentage: 9,
    },
});
patchService.handleNotification({
    method: 'item/completed',
    params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'item-a', type: 'agentMessage' } },
});
assert.equal(emittedPatch.baseProjectionRevision, 7);
assert.equal(emittedPatch.projectionRevision, 8);
assert.deepEqual(emittedPatch.deleteBlockIds, ['block:session-a:item-a:1'],
    'live item completion must delete stale Blocks through the same revision Patch contract as reconcile');
assert.equal(emittedPatch.upsertBlocks.length, 1);
patchService.handleNotification({
    method: 'turn/completed',
    params: {
        threadId: 'thread-a',
        turn: { id: 'turn-a', status: 'failed', error: { message: 'ToolBox\nconnection\trefused' } },
    },
});
assert.equal(emittedEvent.turnStatus, 'failed');
assert.equal(emittedEvent.turnError, 'ToolBox connection refused',
    'Main must send a bounded readable Turn error instead of a raw protocol object');
console.log('Codex Runtime host service tests passed.');
