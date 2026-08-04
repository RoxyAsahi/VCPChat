import { assert, os, path, fs, CodexRuntimeManager, AgentProjectionRepository, developmentBridgePath, vcpInvokeTool, FakeTransport } from './fixtures/codex-runtime-manager-harness.mjs';

// UX-R1/R2: the durable Session catalog is a SQLite concern, not an App
// Server lifecycle concern. Legacy display names are migrated once to the
// shared Agent folder identity, and selection/send share one Thread warm.
const fastRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-fast-catalog-'));
const fastAgents = path.join(fastRoot, 'Agents');
fs.mkdirSync(path.join(fastAgents, '_Agent_Nova'), { recursive: true });
fs.writeFileSync(path.join(fastAgents, '_Agent_Nova', 'config.json'), JSON.stringify({
    name: 'Nova', systemPrompt: '{{Nova}}',
}));
const fastTransport = new FakeTransport();
const fastManager = new CodexRuntimeManager({
    projectRoot: fastRoot,
    settingsPath: path.join(fastRoot, 'settings.json'),
    agentsDir: fastAgents,
    getSettings: () => ({}),
    transportFactory: () => fastTransport,
    repositoryFactory: () => new AgentProjectionRepository({ databasePath: path.join(fastRoot, 'projection.sqlite') }),
});
fastManager.ensureProjectionStore().saveSession({
    sessionId: 'legacy-nova-session', agentId: 'Nova', title: 'Legacy Nova', state: 'created',
    workspaceRoot: fastRoot, configSnapshot: { agentName: 'Nova', baseInstructions: '{{Nova}}' },
});
const fastListStartedAt = performance.now();
const fastTopics = await fastManager.listSessions({ agentId: '_Agent_Nova' });
assert.ok(performance.now() - fastListStartedAt < 150,
    'a cold local SQLite Session list must remain inside the UX-R1 150ms gate');
assert.equal(fastTransport.startCount, 0, 'listing SQLite Sessions must not start Codex App Server');
assert.equal(fastTopics.length, 1);
assert.equal(fastTopics[0].agentCatalogId, '_Agent_Nova');
assert.equal(fastTopics[0].agentId, '_Agent_Nova', 'legacy Agent display name must migrate to canonical catalog id');
for (let index = 1; index < 50; index += 1) {
    fastManager.repository.saveSession({
        sessionId: `nova-session-${index}`, agentId: '_Agent_Nova', agentCatalogId: '_Agent_Nova',
        agentNameSnapshot: 'Nova', title: `Nova ${index}`, state: 'created', workspaceRoot: fastRoot,
        configSnapshot: { agentName: 'Nova', baseInstructions: '{{Nova}}' },
    });
}
const listDurations = [];
for (let sample = 0; sample < 30; sample += 1) {
    const sampleStartedAt = performance.now();
    const listed = await fastManager.listSessions({ agentId: '_Agent_Nova' });
    listDurations.push(performance.now() - sampleStartedAt);
    assert.equal(listed.length, 50);
}
listDurations.sort((left, right) => left - right);
assert.ok(listDurations[Math.ceil(listDurations.length * 0.95) - 1] < 150,
    '50-Session SQLite list P95 must remain below the UX-R1 150ms gate');
await fastManager.readSession({ sessionId: 'legacy-nova-session', reconcile: false });
assert.equal(fastTransport.startCount, 0, 'projection-only read must remain available with no App Server process');
const [warmA, warmB] = await Promise.all([
    fastManager.ensureSessionRuntime({ sessionId: 'legacy-nova-session', reason: 'selection' }),
    fastManager.ensureSessionRuntime({ sessionId: 'legacy-nova-session', reason: 'send' }),
]);
assert.equal(warmA.threadId, warmB.threadId);
assert.equal(fastTransport.calls.filter((call) => call.method === 'thread/start').length, 1,
    'selection warm and immediate send must share one Session warm promise');
const warmTopicB = await fastManager.createSessionRecord({ agentId: '_Agent_Nova', title: 'Warm B', systemPrompt: '{{Nova}}' });
const warmTopicC = await fastManager.createSessionRecord({ agentId: '_Agent_Nova', title: 'Warm C', systemPrompt: '{{Nova}}' });
await fastManager.ensureSessionRuntime({ sessionId: warmTopicB.sessionId, reason: 'selection' });
await fastManager.ensureSessionRuntime({ sessionId: warmTopicC.sessionId, reason: 'selection' });
assert.equal(fastManager.idleWarmSessions.size, 2, 'proactive idle Thread warm set must remain bounded at two Sessions');
assert.equal(fastManager.resumedThreadIds.has(warmA.threadId), false,
    'LRU eviction must remove the oldest Session from VChat\'s warm/resume set');
let scheduledDeltaReconcile = null;
const originalFastRead = fastManager.sessionService.read.bind(fastManager.sessionService);
fastManager.sessionService.read = async (options) => {
    scheduledDeltaReconcile = options;
    return fastManager.repository.readProjection(options.sessionId);
};
await fastManager.projector.scheduleReconcile({
    sessionId: warmTopicC.sessionId,
    itemId: 'delta-without-item',
    reason: 'pending delta expired before item/started',
});
assert.deepEqual(scheduledDeltaReconcile, { sessionId: warmTopicC.sessionId, reconcile: true },
    'expired Main-only delta buffers must schedule an authoritative Session reconcile');
fastManager.sessionService.read = originalFastRead;
await fastManager.stop();
fs.rmSync(fastRoot, { recursive: true, force: true });
