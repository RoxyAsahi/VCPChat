import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimeSessionService } = require('../modules/codex-runtime/runtime-session-service.js');
const { createRuntimeOperationContext } = require('../modules/codex-runtime/runtime-operation-context.js');

function makeRepository() {
    const sessions = new Map();
    const operations = new Map();
    const writes = [];
    return {
        writes,
        readOnly: false,
        saveSession(session) { sessions.set(session.sessionId, { ...session }); return sessions.get(session.sessionId); },
        getSession: (sessionId) => sessions.get(sessionId) || null,
        listSessions: ({ archived = false } = {}) => [...sessions.values()]
            .filter((session) => Boolean(session.archivedAt) === archived),
        readProjection: (sessionId) => ({ session: sessions.get(sessionId), messages: [] }),
        projectionGeneration: () => 0,
        markOrphaned: () => {},
        markProjectionError: () => {},
        createOperation(operation) {
            const value = { operationId: `operation-${operations.size + 1}`, state: 'prepared', ...operation };
            operations.set(value.operationId, value);
            return value;
        },
        updateOperation(operationId, patch) {
            const next = { ...operations.get(operationId), ...patch };
            operations.set(operationId, next);
            writes.push({ operationId, patch: { ...patch } });
            return next;
        },
        archiveSession(sessionId) {
            const next = { ...sessions.get(sessionId), archivedAt: Date.now() };
            sessions.set(sessionId, next);
            return next;
        },
        setPinned(sessionId, pinned) {
            const next = { ...sessions.get(sessionId), pinnedAt: pinned ? Date.now() : null };
            sessions.set(sessionId, next);
            return next;
        },
        listPendingInputs: () => [],
    };
}

function makeHarness(repository, request = async () => ({})) {
    let generation = 1;
    let sequence = 0;
    const cleared = [];
    const registered = [];
    let stat = { isFile: () => true, size: 128 };
    let lifecycleBusy = false;
    let reconcileCount = 0;
    const service = new RuntimeSessionService({
        ensureProjectionStore: () => {},
        assertProjectionWritable: () => {},
        repository: () => repository,
        transport: () => ({ request }),
        projector: () => ({ reconcileThread: () => { reconcileCount += 1; return { applied: true }; } }),
        start: async () => {},
        captureGeneration: () => {
            const captured = generation;
            return { assertCurrent(current) {
                if (current !== captured) {
                    const error = new Error('stale generation');
                    error.code = 'STALE_RUNTIME_GENERATION';
                    throw error;
                }
            } };
        },
        assertGeneration(scope) {
            scope.assertCurrent(generation);
        },
        createOperationContext(identity) {
            const captured = generation;
            return createRuntimeOperationContext({ assertCurrent(current) {
                if (current !== captured) {
                    const error = new Error('stale generation');
                    error.code = 'STALE_RUNTIME_GENERATION';
                    throw error;
                }
            } }, identity);
        },
        assertOperationContext(operation) { operation.generation.assertCurrent(generation); },
        repairSessionConfig: (session) => session,
        repairSessionIdentity: (session) => session,
        resolveCanonicalAgent: (agentId) => ({ catalogId: agentId, name: agentId, profile: {} }),
        configSnapshot: (options) => ({
            instructionMode: 'vchat-identity', baseInstructions: options.systemPrompt || '{{Nova}}',
            agentName: options.agentId, model: options.model || '',
        }),
        createId: () => `session-${++sequence}`,
        projectRoot: () => process.cwd(),
        diagnosticClock: () => 1,
        diagnostic: () => {},
        attachments: () => ({
            clearSession: (sessionId) => cleared.push(sessionId),
            register: (sessionId, filePath, fileStat) => {
                const attachment = { sessionId, path: filePath, size: fileStat.size };
                registered.push(attachment);
                return attachment;
            },
        }),
        statFile: () => stat,
        faultInjection: () => ({}),
        assertLifecycleIdle: () => {
            if (!lifecycleBusy) return;
            const error = new Error('Session is busy');
            error.code = 'SESSION_BUSY';
            throw error;
        },
        toolboxApprovalCount: () => 0,
    });
    return {
        service, cleared, registered,
        setStat: (value) => { stat = value; },
        setLifecycleBusy: (value) => { lifecycleBusy = Boolean(value); },
        reconcileCount: () => reconcileCount,
        advanceGeneration: () => { generation += 1; },
    };
}

const repository = makeRepository();
const harness = makeHarness(repository);
const created = harness.service.create({ agentId: 'Nova', title: 'Session A', systemPrompt: '{{Nova}}' });
assert.equal(created.sessionId, 'session-1');
assert.equal(harness.service.list({ agentId: 'Nova' })[0].title, 'Session A');
harness.service.rename({ sessionId: created.sessionId, title: 'Renamed' });
assert.equal(repository.getSession(created.sessionId).title, 'Renamed');
assert.equal(harness.service.pin({ sessionId: created.sessionId, pinned: true }).pinned, true);
assert.equal(harness.service.export({ sessionId: created.sessionId }).fileName, 'Renamed.md');
const attachment = harness.service.importAttachment({ sessionId: created.sessionId, path: 'C:\\Temp\\note.txt' });
assert.equal(attachment.attachment.sessionId, created.sessionId);
assert.equal(harness.registered.length, 1);
harness.setStat({ isFile: () => true, size: 32 * 1024 * 1024 + 1 });
assert.throws(
    () => harness.service.importAttachment({ sessionId: created.sessionId, path: 'C:\\Temp\\large.bin' }),
    (error) => error.code === 'ATTACHMENT_TOO_LARGE',
);

let releaseArchive;
let archiveRequested;
const archiveRequestStarted = new Promise((resolve) => { archiveRequested = resolve; });
const staleRepository = makeRepository();
staleRepository.saveSession({
    sessionId: 'session-stale', threadId: 'thread-stale', agentId: 'Nova', title: 'Stale', archivedAt: null,
});
const staleHarness = makeHarness(staleRepository, () => new Promise((resolve) => {
    releaseArchive = resolve;
    archiveRequested();
}));
const archive = staleHarness.service.archive({ sessionId: 'session-stale' });
await archiveRequestStarted;
staleHarness.advanceGeneration();
releaseArchive({});
await assert.rejects(archive, (error) => error.code === 'STALE_RUNTIME_GENERATION');
assert.deepEqual(staleRepository.writes.map((write) => write.patch.state), ['dispatching'],
    'a stale archive response must not mutate the replacement repository generation');
assert.equal(staleRepository.getSession('session-stale').archivedAt, null);

let releaseRead;
let readRequested;
const readStarted = new Promise((resolve) => { readRequested = resolve; });
const busyRepository = makeRepository();
busyRepository.saveSession({
    sessionId: 'session-busy-read', threadId: 'thread-busy-read', agentId: 'Nova', title: 'Busy read',
});
const busyHarness = makeHarness(busyRepository, () => new Promise((resolve) => {
    releaseRead = resolve;
    readRequested();
}));
const busyRead = busyHarness.service.read({ sessionId: 'session-busy-read' });
await readStarted;
busyHarness.setLifecycleBusy(true);
releaseRead({ thread: { id: 'thread-busy-read', turns: [] } });
const busyProjection = await busyRead;
assert.equal(busyProjection.session.sessionId, 'session-busy-read');
assert.equal(busyHarness.reconcileCount(), 0,
    'a thread/read started before a new Turn must not reconcile after that Session becomes busy');

console.log('Codex Runtime session service tests passed.');
