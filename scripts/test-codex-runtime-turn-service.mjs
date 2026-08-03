import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimeTurnService } = require('../modules/codex-runtime/runtime-turn-service.js');
const { createRuntimeOperationContext } = require('../modules/codex-runtime/runtime-operation-context.js');

const session = {
    sessionId: 'session-turn', threadId: 'thread-turn', workspaceRoot: '.', archivedAt: null,
    configRevision: 2, configSnapshot: { model: 'gpt-5.6', permissionMode: 'ask', sandbox: 'none' },
};
const secondSession = {
    ...session,
    sessionId: 'session-second',
    threadId: 'thread-second',
};
const sessions = new Map([
    [session.sessionId, session],
    [secondSession.sessionId, secondSession],
]);
const repository = {
    getSession: (sessionId) => sessions.get(sessionId) || null,
    markSessionConfigApplied: (sessionId, revision, config) => ({
        ...sessions.get(sessionId), sessionId, configRevision: revision, configSnapshot: config,
    }),
    listPendingInputs: () => [],
};
const threadStates = new Map([
    ['thread-turn', { activity: 'idle', activeTurnId: null }],
    ['thread-second', { activity: 'idle', activeTurnId: null }],
]);
const resumedThreadIds = new Set(['thread-turn', 'thread-second']);
const turnStartPromises = new Map();
const calls = [];
let generation = 4;
const captureGeneration = () => {
    const captured = generation;
    return { value: captured, assertCurrent(current) {
        if (current !== captured) { const error = new Error('stale'); error.code = 'STALE_RUNTIME_GENERATION'; throw error; }
    } };
};
const service = new RuntimeTurnService({
    ensureProjectionStore: () => {},
    assertProjectionWritable: () => {},
    repository: () => repository,
    transport: () => ({
        async request(method, params) {
            calls.push({ method, params });
            if (method === 'turn/start') return { turn: { id: `turn-${params.threadId}` } };
            if (method === 'turn/interrupt') return {};
            throw new Error(`unexpected ${method}`);
        },
    }),
    bridge: () => null,
    responsesAdapter: () => null,
    attachments: () => ({ resolveMany: () => [] }),
    dynamicCalls: () => new Map(),
    start: async () => {},
    captureGeneration,
    assertGeneration: (scope) => scope.assertCurrent(generation),
    createOperationContext: (identity) => createRuntimeOperationContext(captureGeneration(), identity),
    assertOperationContext: (operation) => operation.generation.assertCurrent(generation),
    repairSessionConfig: (value) => value,
    repairSessionIdentity: (value) => value,
    configSnapshot: () => ({}),
    runtimePolicyParams: () => ({}),
    threadInstructionParams: () => ({}),
    effectiveReasoningEffort: () => null,
    applySessionRuntimeConfig: async () => {},
    sendSessionConfigEvent: () => {},
    sendUiEvent: () => {},
    rememberIdleWarmSession: () => {},
    assertLifecycleIdle: () => {},
    createId: (prefix) => `${prefix}-generated`,
    diagnosticClock: () => 1,
    diagnostic: () => {},
    faultInjection: () => ({}),
    sessionWarmPromises: () => new Map(),
    turnStartPromises: () => turnStartPromises,
    followUpDrainPromises: () => new Map(),
    compactionWaiters: () => new Map(),
    resumedThreadIds: () => resumedThreadIds,
    resumingThreads: () => new Map(),
    threadStates: () => threadStates,
    configApplyTargets: () => new Map(),
    idleWarmSessions: () => new Map(),
});

const started = await service.startTurn({ sessionId: session.sessionId, prompt: 'hello' });
assert.equal(started.turnId, 'turn-thread-turn');
assert.equal(threadStates.get('thread-turn').activity, 'running');
assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1);
await service.cancel({ sessionId: session.sessionId, turnId: started.turnId });
assert.equal(calls.at(-1).method, 'turn/interrupt');

threadStates.set('thread-turn', { activity: 'idle', activeTurnId: null });
const [firstConcurrent, secondConcurrent] = await Promise.all([
    service.startTurn({ sessionId: session.sessionId, prompt: 'first concurrent' }),
    service.startTurn({ sessionId: secondSession.sessionId, prompt: 'second concurrent' }),
]);
assert.deepEqual(firstConcurrent, {
    sessionId: session.sessionId, threadId: session.threadId, turnId: 'turn-thread-turn',
});
assert.deepEqual(secondConcurrent, {
    sessionId: secondSession.sessionId, threadId: secondSession.threadId, turnId: 'turn-thread-second',
});
assert.equal(threadStates.get(session.threadId).activeTurnId, 'turn-thread-turn');
assert.equal(threadStates.get(secondSession.threadId).activeTurnId, 'turn-thread-second');
assert.equal(calls.filter((call) => call.method === 'turn/start' && call.params.threadId === session.threadId).length, 2);
assert.equal(calls.filter((call) => call.method === 'turn/start' && call.params.threadId === secondSession.threadId).length, 1);

let releaseStaleTurn;
const staleSession = {
    ...session,
    sessionId: 'session-stale',
    threadId: 'thread-stale',
};
sessions.set(staleSession.sessionId, staleSession);
resumedThreadIds.add(staleSession.threadId);
threadStates.set(staleSession.threadId, { activity: 'idle', activeTurnId: null });
const originalTransport = service.context.transport;
service.context.transport = () => ({
    request: () => new Promise((resolve) => { releaseStaleTurn = resolve; }),
});
const staleStart = service.startTurn({ sessionId: staleSession.sessionId, prompt: 'stale turn' });
await new Promise((resolve) => setImmediate(resolve));
generation += 1;
releaseStaleTurn({ turn: { id: 'turn-stale' } });
await assert.rejects(staleStart, (error) => error.code === 'STALE_RUNTIME_GENERATION');
assert.equal(threadStates.get(staleSession.threadId).activeTurnId, null,
    'an old generation Turn ACK must not update replacement Runtime state');
service.context.transport = originalTransport;
console.log('Codex Runtime turn service tests passed.');
