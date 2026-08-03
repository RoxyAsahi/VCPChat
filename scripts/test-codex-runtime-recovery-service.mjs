import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexAppServerError } = require('../modules/codex-runtime/appServerTransport.js');
const { RuntimeRecoveryService } = require('../modules/codex-runtime/runtime-recovery-service.js');

function makeRepository({ operations = [], sessions = [] } = {}) {
    const operationMap = new Map(operations.map((operation) => [operation.operationId, { ...operation }]));
    const sessionMap = new Map(sessions.map((session) => [session.sessionId, { ...session }]));
    const writes = [];
    return {
        writes,
        listRecoverableOperations: () => [...operationMap.values()].filter((operation) => operation.state !== 'completed'),
        getOperation: (operationId) => operationMap.get(operationId) || null,
        updateOperation(operationId, patch) {
            const next = { ...operationMap.get(operationId), ...patch };
            operationMap.set(operationId, next);
            writes.push({ type: 'operation', operationId, patch: { ...patch } });
            return next;
        },
        getSession: (sessionId) => sessionMap.get(sessionId) || null,
        listSessions: ({ archived = false } = {}) => [...sessionMap.values()]
            .filter((session) => Boolean(session.archivedAt) === archived),
        replaceUnmaterializedThread(sessionId, threadId) {
            const next = { ...sessionMap.get(sessionId), threadId, state: 'ready' };
            sessionMap.set(sessionId, next);
            writes.push({ type: 'replace-thread', sessionId, threadId });
            return next;
        },
        saveSession(session) {
            sessionMap.set(session.sessionId, { ...session });
            writes.push({ type: 'save-session', sessionId: session.sessionId });
            return sessionMap.get(session.sessionId);
        },
        archiveSession(sessionId) { sessionMap.get(sessionId).archivedAt = Date.now(); },
        unarchiveSession(sessionId) { sessionMap.get(sessionId).archivedAt = null; },
        permanentlyDeleteSession(sessionId) {
            sessionMap.delete(sessionId);
            return { receiptId: `receipt:${sessionId}` };
        },
        projectionGeneration: () => 4,
    };
}

function makeHarness({ repository, request } = {}) {
    let generation = 1;
    let recoveryPromise = null;
    const reconciles = [];
    const threadStates = new Map();
    const service = new RuntimeRecoveryService({
        ensureProjectionStore: () => {},
        assertProjectionWritable: () => {},
        repository: () => repository,
        transport: () => ({ request: request || (async () => ({})) }),
        projector: () => ({
            reconcileThread(sessionId, thread, projectionGeneration) {
                reconciles.push({ sessionId, thread, projectionGeneration });
            },
        }),
        threadStates: () => threadStates,
        start: async () => {},
        captureGeneration: () => generation,
        assertGeneration(scope) {
            if (scope !== generation) {
                const error = new Error('expired generation');
                error.code = 'STALE_RUNTIME_GENERATION';
                throw error;
            }
        },
        recoveryPromise: () => recoveryPromise,
        setRecoveryPromise: (value) => { recoveryPromise = value; },
        setLastError: () => {},
        diagnostic: () => {},
    });
    return { service, reconciles, threadStates, advanceGeneration: () => { generation += 1; } };
}

const normalizedRepository = makeRepository({ operations: [
    { operationId: 'prepared', kind: 'thread-start', state: 'prepared' },
    { operationId: 'dispatching', kind: 'thread-fork', state: 'dispatching' },
] });
makeHarness({ repository: normalizedRepository }).service.normalizeUnboundThreadOperations();
assert.equal(normalizedRepository.getOperation('prepared').state, 'failed');
assert.equal(normalizedRepository.getOperation('dispatching').state, 'uncertain');

let releaseArchive;
const staleRepository = makeRepository({
    operations: [{
        operationId: 'archive', kind: 'thread-archive', state: 'prepared',
        sessionId: 'session-a', threadId: 'thread-a', payload: {},
    }],
    sessions: [{ sessionId: 'session-a', threadId: 'thread-a', archivedAt: null }],
});
const staleHarness = makeHarness({
    repository: staleRepository,
    request: () => new Promise((resolve) => { releaseArchive = resolve; }),
});
const staleRecovery = staleHarness.service.recoverKnownThreadOperation({ operationId: 'archive' });
await Promise.resolve();
staleHarness.advanceGeneration();
releaseArchive({});
await assert.rejects(staleRecovery, (error) => error.code === 'STALE_RUNTIME_GENERATION');
assert.deepEqual(staleRepository.writes.map((write) => write.patch?.state).filter(Boolean), ['dispatching'],
    'a stale remote result must not write remote-applied, failed, or completed state');

const bindRepository = makeRepository({
    operations: [{
        operationId: 'bind', kind: 'thread-start', state: 'uncertain',
        sessionId: 'session-bind', threadId: null, payload: {},
    }],
    sessions: [{ sessionId: 'session-bind', threadId: null, title: 'Unbound', archivedAt: null }],
});
const bindHarness = makeHarness({
    repository: bindRepository,
    request: async (method) => {
        assert.equal(method, 'thread/read');
        return { thread: { id: 'thread-bind', name: 'Recovered', cwd: '.', turns: [] } };
    },
});
const bound = await bindHarness.service.resolveRecoveryOperation({
    operationId: 'bind', action: 'bind', threadId: 'thread-bind',
});
assert.equal(bound.session.threadId, 'thread-bind');
assert.equal(bindHarness.reconciles.length, 1);
assert.equal(bindHarness.reconciles[0].projectionGeneration, 4);
assert.equal(bindHarness.threadStates.get('thread-bind').activity, 'idle');

const alreadyBoundRepository = makeRepository({
    operations: [{ operationId: 'mismatch', kind: 'thread-start', state: 'uncertain', sessionId: 'source' }],
    sessions: [
        { sessionId: 'source', threadId: null, archivedAt: null },
        { sessionId: 'owner', threadId: 'thread-owned', archivedAt: null },
    ],
});
await assert.rejects(
    makeHarness({ repository: alreadyBoundRepository }).service.resolveRecoveryOperation({
        operationId: 'mismatch', action: 'bind', threadId: 'thread-owned',
    }),
    (error) => error.code === 'THREAD_ALREADY_BOUND',
);

const deleteRepository = makeRepository({
    operations: [{ operationId: 'delete', kind: 'thread-start', state: 'uncertain', sessionId: 'source' }],
    sessions: [{ sessionId: 'source', threadId: null, archivedAt: null }],
});
const deleteHarness = makeHarness({
    repository: deleteRepository,
    request: async () => {
        throw new CodexAppServerError('THREAD_NOT_FOUND', 'Thread not found', { codexCode: 'thread_not_found' });
    },
});
await deleteHarness.service.resolveRecoveryOperation({
    operationId: 'delete', action: 'delete', threadId: 'thread-missing',
});
assert.equal(deleteRepository.getOperation('delete').state, 'completed');

let pages = 0;
const paginationRepository = makeRepository();
const paginationHarness = makeHarness({
    repository: paginationRepository,
    request: async () => {
        pages += 1;
        return { data: [{ id: `thread-${pages}` }], nextCursor: `cursor-${pages}` };
    },
});
const pagedThreads = await paginationHarness.service.listStoredThreads(false, 1);
assert.equal(pages, 20, 'Thread discovery must stop at the fixed page bound');
assert.equal(pagedThreads.length, 20);

console.log('Codex Runtime recovery service tests passed.');
