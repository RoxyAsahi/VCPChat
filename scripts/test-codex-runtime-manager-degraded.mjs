import { assert, os, path, fs, CodexRuntimeManager, AgentProjectionRepository, developmentBridgePath, vcpInvokeTool, FakeTransport } from './fixtures/codex-runtime-manager-harness.mjs';

// If writable startup fails but the existing database can be opened, Main
// degrades to read-only projection access and rejects every mutation.
const degradedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-degraded-'));
const degradedDatabase = path.join(degradedRoot, 'codex-agent-projection.sqlite');
const writableSeed = new AgentProjectionRepository({ databasePath: degradedDatabase });
writableSeed.saveSession({
    sessionId: 'degraded-session', threadId: 'degraded-thread', agentId: 'Nova', title: 'Readable history', state: 'ready',
    workspaceRoot: degradedRoot, configSnapshot: { baseInstructions: '{{Nova}}' },
});
writableSeed.close();
let repositoryAttempts = 0;
let degradedTransportCreations = 0;
const degradedManager = new CodexRuntimeManager({
    projectRoot: degradedRoot,
    settingsPath: path.join(degradedRoot, 'settings.json'),
    getSettings: () => ({}),
    repositoryFactory: (config) => {
        repositoryAttempts += 1;
        if (!config.readOnly) throw new Error('simulated writable database failure');
        return new AgentProjectionRepository(config);
    },
    transportFactory: () => {
        degradedTransportCreations += 1;
        return new FakeTransport();
    },
});
assert.equal((await degradedManager.listSessions())[0]?.sessionId, 'degraded-session');
assert.equal(degradedManager.getStatus().storage.readOnly, true);
assert.equal((await degradedManager.readSession({ sessionId: 'degraded-session' })).session.sessionId, 'degraded-session',
    'read-only degraded mode must retain projection reads without starting App Server');
assert.match(degradedManager.exportSession({ sessionId: 'degraded-session' }).content, /Readable history/,
    'read-only degraded mode must retain explicit projection export');
await assert.rejects(() => degradedManager.createSessionRecord({ title: 'must fail' }),
    (error) => error.code === 'PROJECTION_READ_ONLY');
for (const mutation of [
    () => degradedManager.start(),
    () => degradedManager.createSession({ sessionId: 'degraded-session' }),
    () => degradedManager.ensureSessionRuntime({ sessionId: 'degraded-session' }),
    () => degradedManager.startTurn({ sessionId: 'degraded-session', prompt: 'must fail' }),
    () => degradedManager.steerTurn({ sessionId: 'degraded-session', turnId: 'turn-1', prompt: 'must fail' }),
    () => degradedManager.cancelTurn({ sessionId: 'degraded-session', turnId: 'turn-1' }),
    () => degradedManager.compactSession({ sessionId: 'degraded-session' }),
]) {
    await assert.rejects(mutation, (error) => error.code === 'PROJECTION_READ_ONLY');
}
assert.equal(degradedTransportCreations, 0,
    'read-only degraded mutations must fail before constructing or starting App Server transport');
assert.equal(repositoryAttempts, 2, 'degraded startup must attempt writable then read-only exactly once');
await degradedManager.stop();
fs.rmSync(degradedRoot, { recursive: true, force: true });

const backoffRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-backoff-'));
let failedStarts = 0;
const failingTransport = new FakeTransport();
failingTransport.start = async () => {
    failedStarts += 1;
    const error = new Error('simulated App Server startup failure');
    error.code = 'PROCESS_EXITED';
    throw error;
};
const backoffManager = new CodexRuntimeManager({
    projectRoot: backoffRoot,
    settingsPath: path.join(backoffRoot, 'settings.json'),
    getSettings: () => ({}),
    transportFactory: () => failingTransport,
    repositoryFactory: () => new AgentProjectionRepository({ databasePath: path.join(backoffRoot, 'projection.sqlite') }),
    responsesAdapterFactory: () => ({ capability: 'backoff-fixture', async start() {}, async stop() {} }),
});
await assert.rejects(() => backoffManager.start(), /startup failure/);
await assert.rejects(() => backoffManager.start(), (error) => error.code === 'RUNTIME_RETRY_BACKOFF');
assert.equal(failedStarts, 1, 'bounded restart backoff must not respawn immediately after a failed start');
await backoffManager.stop();
fs.rmSync(backoffRoot, { recursive: true, force: true });
