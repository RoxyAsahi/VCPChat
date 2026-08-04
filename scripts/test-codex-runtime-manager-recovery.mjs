import { assert, os, path, fs, CodexRuntimeManager, AgentProjectionRepository, developmentBridgePath, vcpInvokeTool, FakeTransport } from './fixtures/codex-runtime-manager-harness.mjs';

// A remote mutation whose acknowledgement is lost must be journaled as
// uncertain. It is surfaced for repair and never retried as a second Thread.
const sagaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-saga-'));
const uncertainTransport = new FakeTransport();
const uncertainRequest = uncertainTransport.request.bind(uncertainTransport);
let uncertainStartAttempts = 0;
uncertainTransport.request = async (method, params) => {
    if (method === 'thread/start') {
        uncertainStartAttempts += 1;
        const error = new Error('connection lost after dispatch');
        error.code = 'PROCESS_EXITED';
        throw error;
    }
    if (method === 'thread/list') return {
        data: params.archived ? [] : [{
            id: 'thr_unbound_recovery', name: 'Recovered uncertain start', preview: 'repair me',
            cwd: sagaRoot, modelProvider: 'vcp_toolbox', createdAt: 1, updatedAt: 2,
        }],
        nextCursor: null,
    };
    if (method === 'thread/read' && params.threadId === 'thr_unbound_recovery') return {
        thread: { id: 'thr_unbound_recovery', name: 'Recovered uncertain start', cwd: sagaRoot, turns: [] },
    };
    return uncertainRequest(method, params);
};
const sagaManager = new CodexRuntimeManager({
    projectRoot: sagaRoot,
    settingsPath: path.join(sagaRoot, 'settings.json'),
    getSettings: () => ({}),
    transportFactory: () => uncertainTransport,
    repositoryFactory: () => new AgentProjectionRepository({ databasePath: path.join(sagaRoot, 'codex-agent-projection.sqlite') }),
});
const uncertainTopic = await sagaManager.createSessionRecord({ agentId: 'Nova', title: 'Uncertain start', systemPrompt: '{{Nova}}' });
await assert.rejects(() => sagaManager.createSession({ sessionId: uncertainTopic.sessionId }), /connection lost/);
const uncertainOperations = sagaManager.listRecoveryOperations();
assert.ok(uncertainOperations.some((operation) => operation.kind === 'thread-start' && operation.state === 'uncertain'));
assert.equal(uncertainStartAttempts, 1, 'an uncertain thread/start must never be automatically retried');
const recoveryCandidates = await sagaManager.listRecoveryCandidates();
assert.deepEqual(recoveryCandidates.threads.map((thread) => thread.threadId), ['thr_unbound_recovery'],
    'recovery discovery must expose only Codex Threads that are not already bound to SQLite Sessions');
const uncertainOperation = recoveryCandidates.operations.find((operation) => operation.kind === 'thread-start');
const recovered = await sagaManager.resolveRecoveryOperation({
    operationId: uncertainOperation.operationId,
    action: 'bind',
    threadId: 'thr_unbound_recovery',
});
assert.equal(recovered.session.threadId, 'thr_unbound_recovery');
assert.equal(sagaManager.repository.getSession(uncertainTopic.sessionId).threadId, 'thr_unbound_recovery');
assert.equal(sagaManager.listRecoveryOperations().some((operation) => operation.operationId === uncertainOperation.operationId), false,
    'an explicitly bound recovery operation must leave the recoverable Saga queue');
assert.equal(uncertainStartAttempts, 1, 'manual binding must not create a replacement Thread');
await sagaManager.stop();
fs.rmSync(sagaRoot, { recursive: true, force: true });

// Once Codex returns a Thread id, a crash before the SQLite binding must keep
// that exact identity available for explicit recovery. It must never create a
// replacement Thread automatically.
const acknowledgedStartRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-ack-start-'));
const acknowledgedStartTransport = new FakeTransport();
const acknowledgedStartRequest = acknowledgedStartTransport.request.bind(acknowledgedStartTransport);
acknowledgedStartTransport.request = async (method, params) => {
    if (method === 'thread/list') return {
        data: params.archived ? [] : [{ id: 'thr_test', name: 'Acknowledged start', cwd: acknowledgedStartRoot }],
        nextCursor: null,
    };
    return acknowledgedStartRequest(method, params);
};
const acknowledgedStartManager = new CodexRuntimeManager({
    projectRoot: acknowledgedStartRoot,
    settingsPath: path.join(acknowledgedStartRoot, 'settings.json'),
    getSettings: () => ({}),
    transportFactory: () => acknowledgedStartTransport,
    faultInjection: {
        afterThreadStartRemoteApplied: async () => { throw new Error('simulated crash after thread/start ACK'); },
    },
    repositoryFactory: () => new AgentProjectionRepository({
        databasePath: path.join(acknowledgedStartRoot, 'codex-agent-projection.sqlite'),
    }),
});
const acknowledgedStartTopic = await acknowledgedStartManager.createSessionRecord({
    agentId: 'Nova', title: 'Acknowledged start', systemPrompt: '{{Nova}}',
});
await assert.rejects(
    () => acknowledgedStartManager.createSession({ sessionId: acknowledgedStartTopic.sessionId }),
    /after thread\/start ACK/,
);
const acknowledgedStartOperation = acknowledgedStartManager.listRecoveryOperations()
    .find((operation) => operation.kind === 'thread-start' && operation.threadId === 'thr_test');
assert.equal(acknowledgedStartOperation.state, 'uncertain');
assert.equal(acknowledgedStartTransport.calls.filter((call) => call.method === 'thread/start').length, 1);
const acknowledgedStartCandidates = await acknowledgedStartManager.listRecoveryCandidates();
assert.ok(acknowledgedStartCandidates.operations.some((operation) => operation.operationId === acknowledgedStartOperation.operationId));
await acknowledgedStartManager.resolveRecoveryOperation({
    operationId: acknowledgedStartOperation.operationId, action: 'bind', threadId: 'thr_test',
});
assert.equal(acknowledgedStartManager.repository.getSession(acknowledgedStartTopic.sessionId).threadId, 'thr_test');
assert.equal(acknowledgedStartTransport.calls.filter((call) => call.method === 'thread/start').length, 1,
    'binding an acknowledged start must not issue a second thread/start');
await acknowledgedStartManager.stop();
fs.rmSync(acknowledgedStartRoot, { recursive: true, force: true });

const acknowledgedForkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-ack-fork-'));
const acknowledgedForkTransport = new FakeTransport();
const acknowledgedForkRequest = acknowledgedForkTransport.request.bind(acknowledgedForkTransport);
acknowledgedForkTransport.request = async (method, params) => {
    if (method === 'thread/list') return {
        data: params.archived ? [] : [
            { id: 'thr_test', name: 'Fork source', cwd: acknowledgedForkRoot },
            { id: 'thr_fork', name: 'Acknowledged fork', cwd: acknowledgedForkRoot },
        ],
        nextCursor: null,
    };
    if (method === 'thread/read' && params.threadId === 'thr_fork') {
        return { thread: { id: 'thr_fork', name: 'Acknowledged fork', cwd: acknowledgedForkRoot, turns: [] } };
    }
    return acknowledgedForkRequest(method, params);
};
const acknowledgedForkManager = new CodexRuntimeManager({
    projectRoot: acknowledgedForkRoot,
    settingsPath: path.join(acknowledgedForkRoot, 'settings.json'),
    getSettings: () => ({}),
    transportFactory: () => acknowledgedForkTransport,
    faultInjection: {
        afterThreadForkRemoteApplied: async () => { throw new Error('simulated crash after thread/fork ACK'); },
    },
    repositoryFactory: () => new AgentProjectionRepository({
        databasePath: path.join(acknowledgedForkRoot, 'codex-agent-projection.sqlite'),
    }),
});
const acknowledgedForkTopic = await acknowledgedForkManager.createSessionRecord({
    agentId: 'Nova', title: 'Fork source', systemPrompt: '{{Nova}}',
});
const acknowledgedForkSource = await acknowledgedForkManager.createSession({ sessionId: acknowledgedForkTopic.sessionId });
await assert.rejects(
    () => acknowledgedForkManager.forkSession({ sessionId: acknowledgedForkSource.sessionId }),
    /after thread\/fork ACK/,
);
const acknowledgedForkOperation = acknowledgedForkManager.listRecoveryOperations()
    .find((operation) => operation.kind === 'thread-fork' && operation.threadId === 'thr_fork');
assert.equal(acknowledgedForkOperation.state, 'uncertain');
await acknowledgedForkManager.resolveRecoveryOperation({
    operationId: acknowledgedForkOperation.operationId, action: 'bind', threadId: 'thr_fork',
});
assert.ok(acknowledgedForkManager.repository.getSession(acknowledgedForkOperation.payload.targetSessionId));
assert.equal(acknowledgedForkTransport.calls.filter((call) => call.method === 'thread/fork').length, 1,
    'binding an acknowledged fork must not issue a second thread/fork');
await acknowledgedForkManager.stop();
fs.rmSync(acknowledgedForkRoot, { recursive: true, force: true });

// A fresh App Server generation normalizes only local Saga state. It never
// replays a start/fork whose dispatch outcome was not durably recorded.
const legacySagaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-legacy-saga-'));
const legacySagaDatabase = path.join(legacySagaRoot, 'codex-agent-projection.sqlite');
const legacySagaSeed = new AgentProjectionRepository({ databasePath: legacySagaDatabase });
for (const sessionId of ['legacy-prepared', 'legacy-dispatching', 'legacy-remote']) {
    legacySagaSeed.saveSession({
        sessionId, agentId: 'Nova', title: sessionId, state: 'created', workspaceRoot: legacySagaRoot,
        configSnapshot: { baseInstructions: '{{Nova}}' },
    });
}
const legacyPrepared = legacySagaSeed.createOperation({
    operationId: 'legacy-operation-prepared', sessionId: 'legacy-prepared', kind: 'thread-start', state: 'prepared',
});
const legacyDispatching = legacySagaSeed.createOperation({
    operationId: 'legacy-operation-dispatching', sessionId: 'legacy-dispatching', kind: 'thread-fork', state: 'dispatching',
    payload: { targetSessionId: 'legacy-fork-target' },
});
const legacyRemote = legacySagaSeed.createOperation({
    operationId: 'legacy-operation-remote', sessionId: 'legacy-remote', kind: 'thread-start', state: 'remote-applied',
    threadId: 'thr_legacy_remote',
});
legacySagaSeed.close();
const legacySagaTransport = new FakeTransport();
const legacySagaRequest = legacySagaTransport.request.bind(legacySagaTransport);
legacySagaTransport.request = async (method, params) => {
    if (method === 'thread/list') return {
        data: params.archived ? [] : [{ id: 'thr_legacy_remote', name: 'Legacy acknowledged Thread', cwd: legacySagaRoot }],
        nextCursor: null,
    };
    return legacySagaRequest(method, params);
};
const legacySagaManager = new CodexRuntimeManager({
    projectRoot: legacySagaRoot,
    settingsPath: path.join(legacySagaRoot, 'settings.json'),
    getSettings: () => ({}),
    transportFactory: () => legacySagaTransport,
    repositoryFactory: () => new AgentProjectionRepository({ databasePath: legacySagaDatabase }),
});
await legacySagaManager.start();
assert.equal(legacySagaManager.repository.getOperation(legacyPrepared.operationId).state, 'failed');
assert.equal(legacySagaManager.repository.getOperation(legacyDispatching.operationId).state, 'uncertain');
assert.equal(legacySagaManager.repository.getOperation(legacyRemote.operationId).state, 'remote-applied');
const legacyRecoveryCandidates = await legacySagaManager.listRecoveryCandidates();
assert.ok(legacyRecoveryCandidates.operations.some((operation) => operation.operationId === legacyRemote.operationId),
    'a legacy remote-applied start must remain visible for explicit recovery');
assert.equal(legacySagaTransport.calls.some((call) => call.method === 'thread/start'), false);
assert.equal(legacySagaTransport.calls.some((call) => call.method === 'thread/fork'), false);
await legacySagaManager.stop();
fs.rmSync(legacySagaRoot, { recursive: true, force: true });

// Known-Thread lifecycle operations are idempotent Saga recoveries. A crash
// after the remote ACK leaves `remote-applied`; the next App Server generation
// retries/finalizes only that known Thread operation and never creates a Turn
// or replacement Thread.
const lifecycleSagaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-lifecycle-saga-'));
const lifecycleDatabase = path.join(lifecycleSagaRoot, 'codex-agent-projection.sqlite');
const makeLifecycleManager = (transport, faultInjection = {}) => new CodexRuntimeManager({
    projectRoot: lifecycleSagaRoot,
    settingsPath: path.join(lifecycleSagaRoot, 'settings.json'),
    getSettings: () => ({}),
    transportFactory: () => transport,
    faultInjection,
    repositoryFactory: () => new AgentProjectionRepository({ databasePath: lifecycleDatabase }),
});
const archiveTransport = new FakeTransport();
const archiveManager = makeLifecycleManager(archiveTransport, {
    afterArchiveRemoteApplied: async () => {
        const error = new Error('simulated crash after archive ACK');
        error.simulateProcessCrash = true;
        throw error;
    },
});
const lifecycleSagaTopic = await archiveManager.createSessionRecord({ agentId: 'Nova', title: 'Lifecycle Saga', systemPrompt: '{{Nova}}' });
const lifecycleSagaSession = await archiveManager.createSession({ sessionId: lifecycleSagaTopic.sessionId });
await assert.rejects(() => archiveManager.archiveSession({ sessionId: lifecycleSagaSession.sessionId }), /after archive ACK/);
assert.equal(archiveManager.repository.getSession(lifecycleSagaSession.sessionId).archivedAt, null);
assert.ok(archiveManager.listRecoveryOperations().some((operation) => operation.kind === 'thread-archive'
    && operation.state === 'remote-applied'));
await archiveManager.stop();

const unarchiveTransport = new FakeTransport();
const unarchiveManager = makeLifecycleManager(unarchiveTransport, {
    afterUnarchiveRemoteApplied: async () => {
        const error = new Error('simulated crash after unarchive ACK');
        error.simulateProcessCrash = true;
        throw error;
    },
});
await unarchiveManager.start();
assert.ok(unarchiveManager.repository.getSession(lifecycleSagaSession.sessionId).archivedAt,
    'startup must finalize a remote-applied archive in SQLite');
await assert.rejects(() => unarchiveManager.restoreSession({ sessionId: lifecycleSagaSession.sessionId }), /after unarchive ACK/);
assert.ok(unarchiveManager.repository.getSession(lifecycleSagaSession.sessionId).archivedAt,
    'the local unarchive commit must remain pending after the injected crash');
await unarchiveManager.stop();

const deleteTransport = new FakeTransport();
const deleteManager = makeLifecycleManager(deleteTransport, {
    afterDeleteRemoteApplied: async () => {
        const error = new Error('simulated crash after delete ACK');
        error.simulateProcessCrash = true;
        throw error;
    },
});
await deleteManager.start();
assert.equal(deleteManager.repository.getSession(lifecycleSagaSession.sessionId).archivedAt, null,
    'startup must finalize a remote-applied unarchive in SQLite');
await deleteManager.archiveSession({ sessionId: lifecycleSagaSession.sessionId });
await assert.rejects(() => deleteManager.permanentlyDeleteSession({ sessionId: lifecycleSagaSession.sessionId }), /after delete ACK/);
assert.ok(deleteManager.repository.getSession(lifecycleSagaSession.sessionId),
    'the SQLite Session must survive until delete recovery commits locally');
await deleteManager.stop();

const recoveredDeleteTransport = new FakeTransport();
const recoveredDeleteManager = makeLifecycleManager(recoveredDeleteTransport);
await recoveredDeleteManager.start();
assert.equal(recoveredDeleteManager.repository.getSession(lifecycleSagaSession.sessionId), null,
    'startup must finalize a remote-applied permanent delete without creating a replacement Thread');
assert.equal(recoveredDeleteTransport.calls.some((call) => call.method === 'thread/start'), false,
    'known-Thread Saga recovery must not create a new Thread');
assert.equal(recoveredDeleteTransport.calls.some((call) => call.method === 'turn/start'), false,
    'known-Thread Saga recovery must never replay a Turn');
await recoveredDeleteManager.stop();
fs.rmSync(lifecycleSagaRoot, { recursive: true, force: true });
