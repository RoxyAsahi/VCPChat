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
const pendingInputs = new Map();
let pendingSequence = 0;
const repository = {
    getSession: (sessionId) => sessions.get(sessionId) || null,
    markSessionConfigApplied: (sessionId, revision, config) => ({
        ...sessions.get(sessionId), sessionId, configRevision: revision, configSnapshot: config,
    }),
    enqueuePendingInput: (sessionId, input) => {
        const existing = [...pendingInputs.values()].find((entry) => (
            entry.sessionId === sessionId && entry.submissionId === input.submissionId
        ));
        if (existing) return { ...existing };
        const entry = {
            inputId: `pending-${++pendingSequence}`,
            sessionId,
            submissionId: input.submissionId,
            dedupeKey: input.submissionId,
            kind: input.kind || 'follow-up',
            targetTurnId: input.targetTurnId || null,
            prompt: input.prompt,
            state: 'queued',
            clientMessageId: `client-${pendingSequence}`,
            turnId: null,
            attemptCount: 0,
            lastError: null,
        };
        pendingInputs.set(entry.inputId, entry);
        return { ...entry };
    },
    listPendingInputs: (sessionId) => [...pendingInputs.values()]
        .filter((entry) => entry.sessionId === sessionId).map((entry) => ({ ...entry })),
    updatePendingInput: (inputId, patch) => {
        const current = pendingInputs.get(inputId);
        if (!current) return null;
        const next = { ...current, ...patch };
        pendingInputs.set(inputId, next);
        return { ...next };
    },
    removePendingInput: (inputId) => pendingInputs.delete(inputId),
};
const threadStates = new Map([
    ['thread-turn', { activity: 'idle', activeTurnId: null }],
    ['thread-second', { activity: 'idle', activeTurnId: null }],
]);
const resumedThreadIds = new Set(['thread-turn', 'thread-second']);
const turnStartPromises = new Map();
const steerPromises = new Map();
const followUpDrainPromises = new Map();
const turnCancellationStates = new Map();
const dynamicCalls = new Map();
const calls = [];
const responseCancels = [];
const bridgeInterrupts = [];
const failedClosedTurns = [];
let generation = 4;
let activeTransport = {
    async request(method, params) {
        calls.push({ method, params });
        if (method === 'turn/start') return { turn: { id: `turn-${params.threadId}` } };
        if (method === 'turn/steer') return { turnId: params.expectedTurnId };
        if (method === 'turn/interrupt') return {};
        throw new Error(`unexpected ${method}`);
    },
};
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
    transport: () => activeTransport,
    bridge: () => ({ interrupt: async (requestId) => { bridgeInterrupts.push(requestId); return { interrupted: true }; } }),
    responsesAdapter: () => ({ cancelTurn: async (identity) => { responseCancels.push(identity); return 1; } }),
    attachments: () => ({ resolveMany: () => [] }),
    dynamicCalls: () => dynamicCalls,
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
    steerPromises: () => steerPromises,
    followUpDrainPromises: () => followUpDrainPromises,
    turnCancellationStates: () => turnCancellationStates,
    failClosedTurnInteractions: async (identity) => { failedClosedTurns.push(identity); return { resolved: ['approval-1'] }; },
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
const originalTransport = activeTransport;
activeTransport = {
    request: () => new Promise((resolve) => { releaseStaleTurn = resolve; }),
};
const staleStart = service.startTurn({ sessionId: staleSession.sessionId, prompt: 'stale turn' });
await new Promise((resolve) => setImmediate(resolve));
generation += 1;
releaseStaleTurn({ turn: { id: 'turn-stale' } });
await assert.rejects(staleStart, (error) => error.code === 'STALE_RUNTIME_GENERATION');
assert.equal(threadStates.get(staleSession.threadId).activeTurnId, null,
    'an old generation Turn ACK must not update replacement Runtime state');
activeTransport = originalTransport;

threadStates.set(session.threadId, { activity: 'running', activeTurnId: 'turn-steer' });
let releaseSteer;
activeTransport = {
    request(method, params) {
        calls.push({ method, params });
        if (method !== 'turn/steer') throw new Error(`unexpected ${method}`);
        return new Promise((resolve) => { releaseSteer = () => resolve({ turnId: params.expectedTurnId }); });
    },
};
const firstSteer = service.steer({
    sessionId: session.sessionId, turnId: 'turn-steer', prompt: 'adjust now', submissionId: 'steer-submit-1',
});
const duplicateSteer = service.steer({
    sessionId: session.sessionId, turnId: 'turn-steer', prompt: 'adjust now', submissionId: 'steer-submit-1',
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.filter((call) => call.method === 'turn/steer'
    && call.params.expectedTurnId === 'turn-steer').length, 1,
    'the same in-flight steering submission must issue one App Server request');
releaseSteer();
assert.deepEqual(await firstSteer, await duplicateSteer);
assert.equal(repository.listPendingInputs(session.sessionId).length, 0,
    'an acknowledged steering command must leave no pending queue row');
await assert.rejects(service.steer({
    sessionId: session.sessionId, turnId: 'turn-stale', prompt: 'wrong turn', submissionId: 'steer-stale',
}), (error) => error.code === 'STALE_TURN');

activeTransport = originalTransport;
await service.followUp({
    sessionId: session.sessionId, afterTurnId: 'turn-steer', prompt: 'same follow-up', submissionId: 'follow-submit-1',
});
await service.followUp({
    sessionId: session.sessionId, afterTurnId: 'turn-steer', prompt: 'same follow-up', submissionId: 'follow-submit-2',
});
assert.equal(repository.listPendingInputs(session.sessionId).filter((entry) => entry.kind === 'follow-up').length, 2,
    'the same follow-up text with distinct submission IDs must remain two explicit queue entries');
threadStates.set(session.threadId, { activity: 'unknown', activeTurnId: null });
const startsBeforeUnknownDrain = calls.filter((call) => call.method === 'turn/start').length;
assert.equal(await service.drainFollowUpQueue(session, { completedTurnId: 'turn-steer' }), null);
assert.equal(calls.filter((call) => call.method === 'turn/start').length, startsBeforeUnknownDrain,
    'an unconfirmed Thread state must never drain the follow-up queue');

threadStates.set(session.threadId, { activity: 'idle', activeTurnId: null });
activeTransport = {
    async request(method, params) {
        calls.push({ method, params });
        if (method === 'turn/start') {
            const error = new Error('active turn is not steerable');
            error.code = 'ACTIVE_TURN_NOT_STEERABLE';
            throw error;
        }
        throw new Error(`unexpected ${method}`);
    },
};
await service.drainFollowUpQueue(session, { completedTurnId: 'turn-steer' });
assert.equal(repository.listPendingInputs(session.sessionId)[0]?.state, 'queued',
    'a recoverable active-turn race must return the follow-up to queued instead of losing it');

threadStates.set(session.threadId, { activity: 'running', activeTurnId: 'turn-cancel' });
dynamicCalls.set('dynamic-cancel', {
    threadId: session.threadId, turnId: 'turn-cancel', bridgeRequestId: 'bridge-request-1',
});
activeTransport = {
    async request(method, params) {
        calls.push({ method, params });
        if (method === 'turn/interrupt') throw new Error('App Server interrupt failed');
        throw new Error(`unexpected ${method}`);
    },
};
const cancelled = await service.cancel({
    sessionId: session.sessionId, turnId: 'turn-cancel',
});
const interruptCount = calls.filter((call) => call.method === 'turn/interrupt').length;
assert.deepEqual(await service.cancel({
    sessionId: session.sessionId, turnId: 'turn-cancel',
}), cancelled, 'repeated stop for the same Turn must return the original cancellation result');
assert.equal(calls.filter((call) => call.method === 'turn/interrupt').length, interruptCount,
    'repeated stop must not issue a second App Server interrupt');
assert.equal(cancelled.state, 'uncertain');
assert.equal(cancelled.channels.appServer, 'rejected');
assert.equal(cancelled.channels.responses, 'fulfilled');
assert.equal(cancelled.channels.bridge, 'fulfilled');
assert.equal(cancelled.channels.interactions, 'fulfilled');
assert.deepEqual(responseCancels.at(-1), { threadId: session.threadId, turnId: 'turn-cancel' });
assert.deepEqual(bridgeInterrupts, ['bridge-request-1']);
assert.equal(failedClosedTurns.at(-1).turnId, 'turn-cancel');

console.log('Codex Runtime turn service tests passed.');
