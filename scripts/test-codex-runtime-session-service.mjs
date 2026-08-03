import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimeSessionService } = require('../modules/codex-runtime/runtime-session-service.js');

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
    const service = new RuntimeSessionService({
        ensureProjectionStore: () => {},
        assertProjectionWritable: () => {},
        repository: () => repository,
        transport: () => ({ request }),
        projector: () => ({ reconcileThread: () => ({ applied: true }) }),
        start: async () => {},
        captureGeneration: () => generation,
        assertGeneration(scope) {
            if (scope !== generation) {
                const error = new Error('stale generation');
                error.code = 'STALE_RUNTIME_GENERATION';
                throw error;
            }
        },
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
        attachments: () => ({ clearSession: (sessionId) => cleared.push(sessionId) }),
        faultInjection: () => ({}),
        assertLifecycleIdle: () => {},
        toolboxApprovalCount: () => 0,
    });
    return { service, cleared, advanceGeneration: () => { generation += 1; } };
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

let releaseArchive;
const staleRepository = makeRepository();
staleRepository.saveSession({
    sessionId: 'session-stale', threadId: 'thread-stale', agentId: 'Nova', title: 'Stale', archivedAt: null,
});
const staleHarness = makeHarness(staleRepository, () => new Promise((resolve) => { releaseArchive = resolve; }));
const archive = staleHarness.service.archive({ sessionId: 'session-stale' });
await Promise.resolve();
staleHarness.advanceGeneration();
releaseArchive({});
await assert.rejects(archive, (error) => error.code === 'STALE_RUNTIME_GENERATION');
assert.deepEqual(staleRepository.writes.map((write) => write.patch.state), ['dispatching'],
    'a stale archive response must not mutate the replacement repository generation');
assert.equal(staleRepository.getSession('session-stale').archivedAt, null);

console.log('Codex Runtime session service tests passed.');
