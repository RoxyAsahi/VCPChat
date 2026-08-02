import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexRuntimeManager, vcpInvokeTool } = require('../modules/codex-runtime/runtimeManager.js');
const { AgentProjectionRepository } = require('../modules/codex-runtime/projection');

class FakeTransport extends EventEmitter {
    constructor() {
        super();
        this.status = { running: false, ready: false, pid: 77 };
        this.calls = [];
        this.responses = [];
        this.startCount = 0;
    }
    async start() { this.startCount += 1; this.status = { ...this.status, running: true, ready: true }; }
    async stop() { this.status = { ...this.status, running: false, ready: false }; }
    async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/start') {
            this.threadCounter = (this.threadCounter || 0) + 1;
            return { thread: { id: this.threadCounter === 1 ? 'thr_test' : `thr_test_${this.threadCounter}` } };
        }
        if (method === 'thread/resume') return { thread: { id: params.threadId, status: { type: 'idle' } } };
        if (method === 'turn/start') return { turn: { id: 'turn_test' } };
        if (method === 'thread/read' && this.readError) throw this.readError;
        if (method === 'thread/read' && this.readResult) return this.readResult;
        if (method === 'thread/read') return {
            thread: {
                id: 'thr_test',
                turns: [{
                    id: 'turn_test',
                    items: [{ id: 'item_a', type: 'agentMessage', text: 'done', status: 'completed' }],
                }],
            },
        };
        if (method === 'thread/fork') return { thread: { id: 'thr_fork' } };
        return {};
    }
    respond(id, result) { this.responses.push({ id, result }); }
    respondError(id, code, message) { this.responses.push({ id, error: { code, message } }); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-manager-'));
assert.equal(vcpInvokeTool().inputSchema.properties.arguments.additionalProperties, true,
    'the generic VCP argument envelope must remain open after Codex normalizes DynamicTool schemas');

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
const fastTopics = await fastManager.listTopics({ agentId: '_Agent_Nova' });
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
    const listed = await fastManager.listTopics({ agentId: '_Agent_Nova' });
    listDurations.push(performance.now() - sampleStartedAt);
    assert.equal(listed.length, 50);
}
listDurations.sort((left, right) => left - right);
assert.ok(listDurations[Math.ceil(listDurations.length * 0.95) - 1] < 150,
    '50-Session SQLite list P95 must remain below the UX-R1 150ms gate');
await fastManager.readTopic({ sessionId: 'legacy-nova-session', reconcile: false });
assert.equal(fastTransport.startCount, 0, 'projection-only read must remain available with no App Server process');
const [warmA, warmB] = await Promise.all([
    fastManager.ensureSessionRuntime({ sessionId: 'legacy-nova-session', reason: 'selection' }),
    fastManager.ensureSessionRuntime({ sessionId: 'legacy-nova-session', reason: 'send' }),
]);
assert.equal(warmA.threadId, warmB.threadId);
assert.equal(fastTransport.calls.filter((call) => call.method === 'thread/start').length, 1,
    'selection warm and immediate send must share one Session warm promise');
const warmTopicB = await fastManager.createTopic({ agentId: '_Agent_Nova', title: 'Warm B', systemPrompt: '{{Nova}}' });
const warmTopicC = await fastManager.createTopic({ agentId: '_Agent_Nova', title: 'Warm C', systemPrompt: '{{Nova}}' });
await fastManager.ensureSessionRuntime({ sessionId: warmTopicB.sessionId, reason: 'selection' });
await fastManager.ensureSessionRuntime({ sessionId: warmTopicC.sessionId, reason: 'selection' });
assert.equal(fastManager.idleWarmSessions.size, 2, 'proactive idle Thread warm set must remain bounded at two Sessions');
assert.equal(fastManager.resumedThreadIds.has(warmA.threadId), false,
    'LRU eviction must remove the oldest Session from VChat\'s warm/resume set');
await fastManager.stop();
fs.rmSync(fastRoot, { recursive: true, force: true });
const fake = new FakeTransport();
const uiEvents = [];
const manager = new CodexRuntimeManager({
    projectRoot: root,
    settingsPath: path.join(root, 'settings.json'),
    getSettings: () => ({}),
    transportFactory: () => fake,
    repositoryFactory: () => new AgentProjectionRepository({ databasePath: path.join(root, 'projection.sqlite') }),
    sendEvent: (event) => uiEvents.push(event),
});
fs.mkdirSync(path.join(root, 'Agents', 'MainOnly'), { recursive: true });
fs.writeFileSync(path.join(root, 'Agents', 'MainOnly', 'config.json'), JSON.stringify({ name: 'MainOnly' }));
const buildProfiles = manager.listAgentProfiles();
assert.ok(buildProfiles.some((profile) => profile.id === 'Nova'),
    'the isolated Build catalog must initialize its own Nova profile');
assert.equal(buildProfiles.some((profile) => profile.id === 'MainOnly'), false,
    'normal-chat Agents must never appear in the Build Agent catalog');
const savedBuildProfile = manager.saveAgentProfile({
    name: 'Research Agent', systemPrompt: '{{Research}}', model: 'gpt-5.6-terra',
});
assert.equal(savedBuildProfile.profile.id, 'Research-Agent');
assert.equal(manager.listAgentProfiles().some((profile) => profile.id === 'Research-Agent'), true,
    'a saved Build Agent profile must immediately appear in the isolated catalog');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'CodexAgents', 'Research-Agent', 'config.json'), 'utf8')).systemPrompt,
    '{{Research}}', 'Build Agent creation must persist its prompt outside the normal-chat Agent directory');
assert.throws(() => manager.saveAgentProfile({ name: 'Research Agent', systemPrompt: '{{Other}}' }), /already exists/);
const savedBuildAvatar = manager.saveAgentAvatar({
    agentId: 'Nova',
    avatarData: { name: 'nova.png', type: 'image/png', buffer: new Uint8Array([1, 2, 3]) },
});
assert.match(savedBuildAvatar.avatarUrl, /CodexAgents\/Nova\/avatar\.png/i,
    'Build avatars must be stored under CodexAgents rather than normal-chat Agents');
const workspaceTopic = await manager.createTopic({
    agentId: 'Research-Agent', title: 'Workspace settings', workspaceRoot: root,
});
const nextWorkspace = path.join(root, 'next-workspace');
fs.mkdirSync(nextWorkspace);
const workspaceUpdate = await manager.updateWorkbenchSettings({
    sessionId: workspaceTopic.sessionId, workspaceRoot: nextWorkspace, expectedConfigRevision: 1,
});
assert.equal(workspaceUpdate.session.workspaceRoot, nextWorkspace,
    'selected Session workspace changes must be durable rather than renderer-only');
await assert.rejects(() => manager.updateWorkbenchSettings({
    sessionId: workspaceTopic.sessionId, workspaceRoot: path.join(root, 'missing-workspace'), expectedConfigRevision: 2,
}), /does not exist/);

// The Codex provider must target VChat's loopback compatibility adapter, not
// ToolBox's optional /v1/responses implementation.  The upstream ToolBox key
// stays in the adapter and bridge; the App Server receives only a disposable
// local capability value.
const providerTransport = new FakeTransport();
let providerTransportConfig = null;
let adapterStopped = false;
const localAdapter = {
    capability: 'test-loopback-capability',
    baseUrl: 'http://127.0.0.1:49152/v1/test-loopback-capability',
    async start() { return this.baseUrl; },
    async stop() { adapterStopped = true; },
};
const providerManager = new CodexRuntimeManager({
    projectRoot: root,
    settingsPath: path.join(root, 'provider-settings.json'),
    getSettings: () => ({ vcpServerUrl: 'http://toolbox.invalid:6005', vcpApiKey: 'upstream-key-not-for-codex' }),
    transportFactory: (config) => { providerTransportConfig = config; return providerTransport; },
    responsesAdapterFactory: (config) => {
        assert.equal(config.toolboxUrl, 'http://toolbox.invalid:6005');
        assert.equal(config.toolboxApiKey, 'upstream-key-not-for-codex');
        return localAdapter;
    },
    repositoryFactory: () => new AgentProjectionRepository({ databasePath: path.join(root, 'provider-projection.sqlite') }),
});
providerManager.bridge = { async start() {}, async stop() {} };
await providerManager.start();
const providerTopic = await providerManager.createTopic({ title: 'Adapter provider' });
await providerManager.createSession({ resume: providerTopic.topicId });
const providerStart = providerTransport.calls.find((call) => call.method === 'thread/start');
assert.equal(providerStart.params.config['model_providers.vcp_toolbox.base_url'], localAdapter.baseUrl);
assert.equal(providerStart.params.config['model_providers.vcp_toolbox.env_key'], 'VCP_CODEX_RESPONSES_ADAPTER_CAPABILITY');
assert.equal(providerTransportConfig.env.VCP_CODEX_RESPONSES_ADAPTER_CAPABILITY, localAdapter.capability);
assert.equal('VCP_TOOLBOX_API_KEY' in providerTransportConfig.env, false);
assert.deepEqual(providerTransportConfig.unsetEnv, ['VCP_TOOLBOX_API_KEY', 'VCP_TOOLBOX_URL']);
assert.deepEqual(providerStart.params.environments, [],
    'ToolBox-backed Sessions must not expose a Codex filesystem/shell execution environment');
assert.equal(providerStart.params.config.include_permissions_instructions, false);
assert.equal(providerStart.params.config.include_apps_instructions, false);
assert.equal(providerStart.params.config.include_collaboration_mode_instructions, false);
assert.equal(providerStart.params.config.include_environment_context, false);
assert.equal(providerStart.params.config.project_doc_max_bytes, 0);
assert.equal(providerStart.params.config['skills.include_instructions'], false,
    'ToolBox-backed Sessions must not inject the Codex skills catalog');
assert.equal(providerStart.params.config.model_reasoning_summary, 'detailed');
assert.equal(providerStart.params.config['tools.update_plan.enabled'], false);
assert.equal(providerStart.params.config['tools.experimental_request_user_input.enabled'], false);
assert.equal(providerStart.params.config['features.collab'], false);
assert.equal(providerStart.params.config['features.multi_agent_v2'], false);
assert.equal(providerStart.params.config.web_search, 'disabled');
assert.deepEqual(providerStart.params.config.mcp_servers, {});
assert.deepEqual(providerStart.params.dynamicTools.map((tool) => tool.name), ['vcp_invoke']);
await providerManager.stop();
assert.equal(adapterStopped, true, 'stopping the runtime must close the loopback adapter');

// Changing VChat's ToolBox settings is a security boundary: the old bridge
// must be stopped, its pending backend approvals fail closed, and the stable
// loopback adapter must receive only the new upstream configuration.  This is
// deliberately a Main-only test; no key is projected to UI/SQLite.
const reconfigureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-reconfigure-'));
const bridgeDir = path.join(reconfigureRoot, 'rust', 'target', 'release');
fs.mkdirSync(bridgeDir, { recursive: true });
fs.writeFileSync(path.join(bridgeDir, process.platform === 'win32' ? 'vcp-toolbox-bridge.exe' : 'vcp-toolbox-bridge'), 'fixture');
let changingSettings = { vcpServerUrl: 'http://toolbox-one.invalid:6005', vcpApiKey: 'first-key' };
const adapterChanges = [];
let blockNextAdapterChange = false;
let releaseBlockedAdapterChange = null;
const mutableAdapter = {
    capability: 'stable-loopback-capability',
    baseUrl: 'http://127.0.0.1:49153/v1/stable-loopback-capability',
    async start() { return this.baseUrl; },
    async stop() { this.stopped = true; },
    async reconfigure(config) {
        adapterChanges.push(config);
        if (blockNextAdapterChange) {
            blockNextAdapterChange = false;
            await new Promise((resolve) => { releaseBlockedAdapterChange = resolve; });
        }
    },
};
const bridges = [];
const reconfigureManager = new CodexRuntimeManager({
    projectRoot: reconfigureRoot,
    settingsPath: path.join(reconfigureRoot, 'settings.json'),
    getSettings: () => changingSettings,
    transportFactory: () => new FakeTransport(),
    responsesAdapterFactory: () => mutableAdapter,
    bridgeFactory: () => {
        const bridge = {
            started: 0,
            stopped: 0,
            approvalResponses: [],
            async start() { this.started += 1; },
            async stop() { this.stopped += 1; },
            async interrupt() { return { interrupted: true }; },
            async respondApproval(value) { this.approvalResponses.push(value); return { written: true }; },
            on() {},
        };
        bridges.push(bridge);
        return bridge;
    },
    repositoryFactory: () => new AgentProjectionRepository({ databasePath: path.join(reconfigureRoot, 'projection.sqlite') }),
});
await reconfigureManager.start();
const firstBridge = reconfigureManager.bridge;
reconfigureManager._handleBridgeEvent({
    channel: 'backend-approval',
    event: { requestId: 'settings-change-approval', expiresAtMs: Date.now() + 30_000, data: { toolName: 'FileOperator' } },
});
changingSettings = { vcpServerUrl: 'http://toolbox-two.invalid:6005', vcpApiKey: 'second-key' };
blockNextAdapterChange = true;
const firstReconfiguration = reconfigureManager.refreshToolboxConfiguration(changingSettings);
while (adapterChanges.length < 1) await new Promise((resolve) => setImmediate(resolve));
changingSettings = { vcpServerUrl: 'http://toolbox-three.invalid:6005', vcpApiKey: 'third-key' };
const latestReconfiguration = reconfigureManager.refreshToolboxConfiguration(changingSettings);
releaseBlockedAdapterChange();
await Promise.all([firstReconfiguration, latestReconfiguration]);
assert.equal(firstBridge.stopped, 1, 'old ToolBox bridge must stop before reconnecting');
assert.equal(firstBridge.approvalResponses[0].requestId, 'settings-change-approval');
assert.equal(firstBridge.approvalResponses[0].approved, false, 'old backend approval must fail closed');
assert.equal(bridges.length, 3, 'latest-wins reload must replace the bridge for every applied authority generation');
assert.equal(bridges[1].stopped, 1, 'an intermediate bridge must stop before the newest settings become authoritative');
assert.equal(reconfigureManager.bridge, bridges[2]);
assert.deepEqual(adapterChanges, [
    { toolboxUrl: 'http://toolbox-two.invalid:6005', toolboxApiKey: 'second-key' },
    { toolboxUrl: changingSettings.vcpServerUrl, toolboxApiKey: changingSettings.vcpApiKey },
], 'a settings update received during reload must drain to the latest fingerprint');
assert.equal(reconfigureManager.toolboxApprovals.size, 0);
await reconfigureManager.stop();
fs.rmSync(reconfigureRoot, { recursive: true, force: true });
await manager.start();
await manager.setWorkbenchPresence(true);
const topic = await manager.createTopic({ agentId: 'Nova', title: 'Test', model: 'Nova', systemPrompt: '{{Nova}}' });
const session = await manager.createSession({ topicId: topic.topicId });
assert.equal(session.threadId, 'thr_test');
const resumed = await manager.createSession({ resume: topic.topicId });
assert.equal(resumed.sessionId, session.sessionId, 'resume must reuse the VChat Session instead of creating another one');
assert.equal(fake.calls.filter((call) => call.method === 'thread/start').length, 1);
// The generic personality only shapes how Codex phrases the default template;
// VChat's persona identity must arrive as `baseInstructions` so Codex replaces
// its built-in "You are Codex" system prompt instead of appending a hint.
// The Agent catalog's `systemPrompt` (e.g. `{{Nova}}`, expanded by VCPToolBox)
// maps to `baseInstructions`, never to the appending `developerInstructions`.
const baseInstructionsTopic = await manager.createTopic({
    agentId: 'Nova',
    title: 'Persona',
    systemPrompt: '{{Nova}}',
    developerInstructions: 'extra hint',
});
await manager.createSession({ topicId: baseInstructionsTopic.topicId });
const personaStart = fake.calls.find((call) => call.method === 'thread/start'
    && call.params.developerInstructions === 'extra hint');
assert.equal(personaStart.params.baseInstructions, '{{Nova}}',
    'systemPrompt must map to baseInstructions so VCPToolBox expands the Nova identity and replaces Codex');
assert.equal(personaStart.params.developerInstructions, 'extra hint',
    'an explicit developerInstructions still appends as a separate hint');
assert.equal(personaStart.params.personality, 'pragmatic');
// An explicit `baseInstructions` wins over `systemPrompt` when both are given.
const explicitBaseTopic = await manager.createTopic({
    agentId: 'Nova',
    title: 'Explicit base',
    baseInstructions: 'You are Nova, VChat\'s coding agent.',
    systemPrompt: '{{Nova}}',
});
await manager.createSession({ topicId: explicitBaseTopic.topicId });
const explicitBaseStart = fake.calls.find((call) => call.method === 'thread/start'
    && call.params.baseInstructions === 'You are Nova, VChat\'s coding agent.');
assert.ok(explicitBaseStart, 'explicit baseInstructions must override the catalog systemPrompt');

// Repair only the known historical bug where an Agent placeholder was stored
// as an appending developer instruction. Arbitrary developer instructions are
// intentional data and must never be silently promoted to system identity.
const legacyNow = Date.now();
manager.repository.saveSession({
    sessionId: 'session_legacy_identity',
    threadId: 'thr_legacy_identity',
    agentId: 'Nova',
    title: 'Legacy identity',
    workspaceRoot: root,
    state: 'ready',
    configSnapshot: { provider: 'vcp_toolbox', baseInstructions: '', developerInstructions: '{{Nova}}' },
    createdAt: legacyNow,
    updatedAt: legacyNow,
});
await manager.createSession({ sessionId: 'session_legacy_identity' });
const repairedLegacy = manager.repository.getSession('session_legacy_identity').configSnapshot;
assert.equal(repairedLegacy.baseInstructions, '{{Nova}}');
assert.equal(repairedLegacy.developerInstructions, '');
assert.equal(repairedLegacy.identityMigrationVersion, 1);
assert.equal(repairedLegacy.executionProfile, 'codex-native-legacy',
    'an existing Thread must not be mislabeled as ToolBox-only because its original environment cannot be revoked on resume');

manager.repository.saveSession({
    sessionId: 'session_custom_developer',
    threadId: 'thr_custom_developer',
    agentId: 'Nova',
    title: 'Custom developer hint',
    workspaceRoot: root,
    state: 'ready',
    configSnapshot: { provider: 'vcp_toolbox', baseInstructions: '', developerInstructions: 'Keep answers concise.' },
    createdAt: legacyNow,
    updatedAt: legacyNow,
});
await manager.createSession({ sessionId: 'session_custom_developer' });
const customDeveloper = manager.repository.getSession('session_custom_developer').configSnapshot;
assert.equal(customDeveloper.baseInstructions || '', '');
assert.equal(customDeveloper.developerInstructions, 'Keep answers concise.');
const updatedPolicy = await manager.updateWorkbenchSettings({
    sessionId: session.sessionId,
    permissionMode: 'always-approve',
    expectedConfigRevision: manager.repository.getSession(session.sessionId).configRevision,
});
assert.equal(updatedPolicy.session.sessionId, session.sessionId,
    'saving an approval policy must update the currently selected VChat Session');
assert.equal(manager.repository.getSession(session.sessionId).configSnapshot.approvalPolicy, 'never',
    'the current Session policy must be durable in the projection store');
assert.equal(manager.repository.getSession(session.sessionId).configSnapshot.permissionMode, 'always-approve',
    'the user-facing permission mode must be durable separately from Codex protocol policy');
const updatedModel = await manager.updateWorkbenchSettings({
    sessionId: session.sessionId,
    model: 'gpt-5.6-luna',
    expectedConfigRevision: manager.repository.getSession(session.sessionId).configRevision,
});
assert.equal(updatedModel.settings.model, 'gpt-5.6-luna',
    'saving a model must return the effective Session model');
assert.equal(manager.repository.getSession(session.sessionId).configSnapshot.model, 'gpt-5.6-luna',
    'the current Session model must be durable in its frozen config snapshot');
assert.equal(manager.repository.getSession(session.sessionId).configSnapshot.permissionMode, 'always-approve',
    'a model-only save must preserve the current Session approval policy');
await assert.rejects(() => manager.updateWorkbenchSettings({
    sessionId: session.sessionId,
    model: 'stale-write-must-not-win',
    expectedConfigRevision: updatedPolicy.session.configRevision,
}), (error) => error.code === 'SESSION_CONFIG_CONFLICT',
'a stale settings view must fail its compare-and-swap instead of overwriting newer Session config');
const revisedNova = manager.saveAgentProfile({
    agentId: 'Nova', name: 'Nova', systemPrompt: '{{NovaV2}}', model: 'profile-model-v2', permissionMode: 'ask',
});
assert.ok(revisedNova.profile.revision > Number(session.configSnapshot.profileRevision || 1));
const profilePreview = await manager.applyAgentProfileToSession({
    sessionId: session.sessionId,
    expectedConfigRevision: manager.repository.getSession(session.sessionId).configRevision,
    previewOnly: true,
});
assert.equal(profilePreview.requiresNewSession, true,
    'a materialized Thread must not silently accept prompt identity changes from its Profile');
assert.ok(profilePreview.identityChanges.includes('systemPrompt'));
const profileFork = await manager.applyAgentProfileToSession({
    sessionId: session.sessionId,
    expectedConfigRevision: manager.repository.getSession(session.sessionId).configRevision,
    createNewSession: true,
});
assert.equal(profileFork.createdNewSession, true);
assert.equal(profileFork.session.threadId, null,
    'applying identity-changing Profile fields must create a fresh unmaterialized Session');
assert.equal(manager.repository.getSession(session.sessionId).configSnapshot.baseInstructions, '{{Nova}}',
    'the original materialized Session must retain its frozen Profile snapshot');
// A fresh App Server process has no in-memory subscription for the persisted
// VChat Session. Simulate that boundary: the next write must reopen exactly
// the saved Codex Thread, never create a replacement Thread.
manager.resumedThreadIds.clear();
const resumedAfterRestart = await manager.createSession({ resume: topic.topicId });
assert.equal(resumedAfterRestart.threadId, 'thr_test');
assert.equal(fake.calls.filter((call) => call.method === 'thread/start').length, 3,
    'only the original and two persona Sessions start Threads; every resume reopens the saved one');
const resumeCall = fake.calls.find((call) => call.method === 'thread/resume' && call.params.threadId === 'thr_test');
assert.deepEqual({ threadId: resumeCall.params.threadId, excludeTurns: resumeCall.params.excludeTurns }, {
    threadId: 'thr_test', excludeTurns: true,
});
const turn = await manager.startTurn({ sessionId: session.sessionId, prompt: 'hello' });
assert.equal(turn.turnId, 'turn_test');
assert.deepEqual(fake.calls.find((call) => call.method === 'turn/start').params.input, [
    { type: 'text', text: 'hello', text_elements: [] },
]);
assert.equal(fake.calls.find((call) => call.method === 'turn/start').params.approvalPolicy, 'never',
    'the next Turn must receive the current Session approval policy without restarting its Thread');
fake.emit('notification', {
    method: 'item/started',
    params: { threadId: 'thr_test', turnId: 'turn_test', item: { id: 'item_a', type: 'agentMessage', text: '' } },
});
fake.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr_test', turnId: 'turn_test', itemId: 'item_a', delta: 'partial' },
});
assert.equal(uiEvents.at(-1).projectionMessage.blocks[0].content.text, 'partial');
fake.emit('notification', {
    method: 'item/completed',
    params: { threadId: 'thr_test', turnId: 'turn_test', item: { id: 'item_a', type: 'agentMessage', text: 'done' } },
});
const projection = await manager.readTopic({ topicId: session.sessionId });
assert.equal(projection.messages[0].blocks[0].content.text, 'done');
fake.emit('notification', { method: 'turn/completed', params: { threadId: 'thr_test', turn: { id: 'turn_test', status: 'completed' } } });
let compactionSettled = false;
const compaction = manager.compactSession({ sessionId: session.sessionId, timeoutMs: 5_000 })
    .then((result) => { compactionSettled = true; return result; });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(fake.calls.at(-1).method, 'thread/compact/start');
assert.equal(compactionSettled, false, 'thread/compact/start ACK must not resolve GUI compaction');
fake.emit('notification', {
    method: 'item/started',
    params: { threadId: 'thr_test', item: { id: 'compact_1', type: 'contextCompaction', status: 'inProgress' } },
});
assert.equal(compactionSettled, false);
fake.emit('notification', {
    method: 'item/completed',
    params: { threadId: 'thr_test', item: { id: 'compact_1', type: 'contextCompaction', status: 'completed' } },
});
const compacted = await compaction;
assert.equal(compacted.itemId, 'compact_1');
assert.equal(compacted.snapshot.session.sessionId, session.sessionId,
    'terminal compaction must reconcile the durable SQLite projection before resolving');
fake.readError = new Error('temporary App Server transport failure');
const temporaryFailureProjection = await manager.readTopic({ topicId: session.sessionId });
assert.equal(temporaryFailureProjection.session.orphaned, false,
    'a temporary read failure must preserve a writable Session instead of inventing an orphan');
assert.match(temporaryFailureProjection.projection.lastError, /temporary App Server transport failure/);
fake.readError = new Error('No rollout found for thread thr_test');
const missingThreadProjection = await manager.readTopic({ topicId: session.sessionId });
assert.equal(missingThreadProjection.session.orphaned, true,
    'only an explicit missing Codex Thread may mark the local Session orphaned');
fake.readError = null;
manager.resumedThreadIds.clear();
await manager.createSession({ sessionId: session.sessionId });
assert.equal(manager.repository.getSession(session.sessionId).orphaned, false,
    'a successful explicit resume clears a previously stale orphan marker');
const fork = await manager.forkSession({ sessionId: session.sessionId, turnId: 'turn_test' });
assert.equal(fork.threadId, 'thr_fork');
assert.equal(manager.getStatus().runtimes.some((runtime) => runtime.topicId === session.sessionId), true);
// Archive/unarchive must move the actual Codex Thread, while pinning remains
// VChat-only presentation metadata. None of these navigation operations may
// infer or replace a Thread identity.
const lifecycleSession = await manager.createSession({ topicId: baseInstructionsTopic.topicId });
const pinned = await manager.setSessionPinned({ sessionId: lifecycleSession.sessionId, pinned: true });
assert.equal(pinned.session.pinnedAt > 0, true);
const archived = await manager.closeSession({ sessionId: lifecycleSession.sessionId });
assert.equal(archived.archived, true);
assert.ok(fake.calls.some((call) => call.method === 'thread/archive' && call.params.threadId === lifecycleSession.threadId));
assert.equal((await manager.listTopics()).some((entry) => entry.sessionId === lifecycleSession.sessionId), false);
assert.equal((await manager.listTopics({ archived: true })).some((entry) => entry.sessionId === lifecycleSession.sessionId), true);
const restored = await manager.restoreSession({ sessionId: lifecycleSession.sessionId });
assert.equal(restored.restored, true);
assert.ok(fake.calls.some((call) => call.method === 'thread/unarchive' && call.params.threadId === lifecycleSession.threadId));
assert.equal((await manager.listTopics()).find((entry) => entry.sessionId === lifecycleSession.sessionId).pinnedAt > 0, true);
// Main is the last idempotency boundary: two renderer sends with the exact
// same payload share one request, while a different payload never becomes an
// accidental second concurrent Turn.
const originalStartTurn = manager._startTurn.bind(manager);
let deferredStarts = 0;
let resolveDeferred;
manager._startTurn = async () => {
    deferredStarts += 1;
    return new Promise((resolve) => { resolveDeferred = resolve; });
};
const firstSubmit = manager.startTurn({ sessionId: lifecycleSession.sessionId, prompt: 'same submit' });
const sameSubmit = manager.startTurn({ sessionId: lifecycleSession.sessionId, prompt: 'same submit' });
await assert.rejects(
    () => manager.startTurn({ sessionId: lifecycleSession.sessionId, prompt: 'different submit' }),
    (error) => error.code === 'SESSION_BUSY',
);
fake.emit('server-request', {
    id: 'req_user_input', method: 'item/tool/requestUserInput',
    params: {
        threadId: 'thr_test', turnId: 'turn_test', itemId: 'input_a', autoResolutionMs: 60_000,
        questions: [{ id: 'choice', header: 'Choice', question: 'Pick one', isOther: true, isSecret: false,
            options: [{ label: 'Alpha', description: 'A' }, { label: 'Beta', description: 'B' }] }],
    },
});
assert.equal(uiEvents.at(-1).type, 'interaction.requested');
assert.equal(uiEvents.at(-1).payload.kind, 'user-input');
await manager.respondInteraction({
    source: 'codex-native', requestId: 'req_user_input', kind: 'user-input',
    generation: manager.runtimeGeneration,
    response: { answers: { choice: { answers: ['Alpha'] }, unknown: { answers: ['ignored'] } } },
});
assert.deepEqual(fake.responses.at(-1), { id: 'req_user_input', result: { answers: { choice: { answers: ['Alpha'] } } } });

fake.emit('server-request', {
    id: 'req_permissions', method: 'item/permissions/requestApproval',
    params: { threadId: 'thr_test', turnId: 'turn_test', itemId: 'permission_a', cwd: root,
        permissions: { network: { enabled: true }, fileSystem: { read: [root], write: [] } } },
});
await manager.respondInteraction({
    source: 'codex-native', requestId: 'req_permissions', kind: 'permission',
    generation: manager.runtimeGeneration,
    response: { decision: 'accept', scope: 'session', permissions: { network: { enabled: false } } },
});
assert.deepEqual(fake.responses.at(-1), { id: 'req_permissions', result: {
    permissions: { network: { enabled: true }, fileSystem: { read: [root], write: [] } }, scope: 'session', strictAutoReview: undefined,
} }, 'the renderer may only grant the exact permission profile requested by Codex');

fake.emit('server-request', {
    id: 'req_mcp', method: 'mcpServer/elicitation/request',
    params: { threadId: 'thr_test', turnId: 'turn_test', serverName: 'fixture', mode: 'form', message: 'Configure',
        requestedSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, count: { type: 'integer' } } } },
});
await manager.respondInteraction({
    source: 'codex-native', requestId: 'req_mcp', kind: 'mcp-elicitation',
    generation: manager.runtimeGeneration,
    response: { action: 'accept', content: { name: 'Nova', count: 2, extra: 'ignored' } },
});
assert.deepEqual(fake.responses.at(-1), { id: 'req_mcp', result: {
    action: 'accept', content: { name: 'Nova', count: 2 }, _meta: null,
} });
assert.equal(deferredStarts, 1);
resolveDeferred({ sessionId: lifecycleSession.sessionId, threadId: lifecycleSession.threadId, turnId: 'deduped-turn' });
assert.deepEqual(await firstSubmit, await sameSubmit);
manager._startTurn = originalStartTurn;
manager.threadStates.set(lifecycleSession.threadId, { activity: 'running', activeTurnId: 'active-turn' });
const queuedFollowUp = await manager.followUpTurn({ sessionId: lifecycleSession.sessionId, prompt: 'run after current turn' });
assert.equal(queuedFollowUp.queued, true);
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId).length, 1);
fake.emit('notification', { method: 'turn/completed', params: { threadId: lifecycleSession.threadId, turn: { id: 'active-turn' } } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId).length, 0, 'a completed Turn must drain one durable follow-up');
assert.ok(fake.calls.some((call) => call.method === 'turn/start' && call.params.input[0]?.text === 'run after current turn'));
manager.threadStates.set(lifecycleSession.threadId, { activity: 'idle', activeTurnId: null });
manager.repository.enqueuePendingInput(lifecycleSession.sessionId, {
    dedupeKey: 'ack-before-sqlite-crash', prompt: 'accepted before local commit',
});
const crashWindowInput = manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .find((entry) => entry.dedupeKey === 'ack-before-sqlite-crash');
manager.faultInjection.afterTurnAckBeforePendingCommit = async () => {
    const error = new Error('simulated crash after turn/start ACK');
    error.simulateProcessCrash = true;
    throw error;
};
await assert.rejects(() => manager._drainFollowUpQueue(lifecycleSession), /simulated crash/);
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .find((entry) => entry.inputId === crashWindowInput.inputId)?.state, 'dispatching',
'the ACK-before-SQLite crash window must retain a non-replayable dispatching record');
manager.faultInjection.afterTurnAckBeforePendingCommit = null;
fake.readResult = { thread: { id: lifecycleSession.threadId, turns: [{
    id: 'turn-confirmed-after-crash',
    items: [{
        id: crashWindowInput.clientMessageId,
        clientUserMessageId: crashWindowInput.clientMessageId,
        type: 'userMessage',
    }],
}] } };
await manager._recoverPendingInputsForSession(lifecycleSession);
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .some((entry) => entry.inputId === crashWindowInput.inputId), false,
'thread/read confirmation must clear an accepted crash-window input without replaying it');
manager.threadStates.set(lifecycleSession.threadId, { activity: 'idle', activeTurnId: null });
manager.repository.enqueuePendingInput(lifecycleSession.sessionId, {
    dedupeKey: 'unconfirmed-after-crash', prompt: 'do not guess whether to resend',
});
const uncertainInput = manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .find((entry) => entry.dedupeKey === 'unconfirmed-after-crash');
manager.repository.updatePendingInput(uncertainInput.inputId, { state: 'dispatching', attemptCount: 1 });
fake.readResult = { thread: { id: lifecycleSession.threadId, turns: [] } };
await manager._recoverPendingInputsForSession(lifecycleSession);
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .find((entry) => entry.inputId === uncertainInput.inputId)?.state, 'uncertain');
const startsBeforeUncertainDrain = fake.calls.filter((call) => call.method === 'turn/start').length;
await manager._drainFollowUpQueue(lifecycleSession);
assert.equal(fake.calls.filter((call) => call.method === 'turn/start').length, startsBeforeUncertainDrain,
    'an uncertain input must wait for an explicit user decision and never auto-replay');
manager.repository.enqueuePendingInput(lifecycleSession.sessionId, {
    dedupeKey: 'crash-before-turn-rpc', prompt: 'never reached the transport',
});
const beforeRpcInput = manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .find((entry) => entry.dedupeKey === 'crash-before-turn-rpc');
const startsBeforeRpcCrash = fake.calls.filter((call) => call.method === 'turn/start').length;
manager.faultInjection.beforePendingInputRpc = async () => {
    const error = new Error('simulated crash before turn/start RPC');
    error.simulateProcessCrash = true;
    throw error;
};
await assert.rejects(() => manager._drainFollowUpQueue(lifecycleSession), /before turn\/start RPC/);
assert.equal(fake.calls.filter((call) => call.method === 'turn/start').length, startsBeforeRpcCrash,
    'a crash before the RPC boundary must not dispatch a Turn');
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .find((entry) => entry.inputId === beforeRpcInput.inputId)?.state, 'dispatching');
manager.faultInjection.beforePendingInputRpc = null;
fake.readResult = { thread: { id: lifecycleSession.threadId, turns: [] } };
await manager._recoverPendingInputsForSession(lifecycleSession);
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .find((entry) => entry.inputId === beforeRpcInput.inputId)?.state, 'uncertain',
    'a crash-window input missing from thread/read must require an explicit resend decision');

manager.threadStates.set(lifecycleSession.threadId, { activity: 'idle', activeTurnId: null });
manager.repository.enqueuePendingInput(lifecycleSession.sessionId, {
    dedupeKey: 'transport-exit-during-turn-rpc', prompt: 'ambiguous transport failure',
});
const originalFakeRequest = fake.request.bind(fake);
fake.request = async (method, params) => {
    if (method === 'turn/start' && params.input?.[0]?.text === 'ambiguous transport failure') {
        const error = new Error('transport exited while awaiting turn/start ACK');
        error.code = 'PROCESS_EXITED';
        throw error;
    }
    return originalFakeRequest(method, params);
};
await manager._drainFollowUpQueue(lifecycleSession);
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .find((entry) => entry.dedupeKey === 'transport-exit-during-turn-rpc')?.state, 'uncertain',
    'an ambiguous transport failure must not be downgraded to a retryable failed input');
fake.request = originalFakeRequest;
fake.readResult = null;
const approvalSession = manager.repository.getSession(session.sessionId);
manager.repository.saveSession({
    ...approvalSession,
    configSnapshot: { ...approvalSession.configSnapshot, executionProfile: 'codex-native-legacy' },
    updatedAt: Date.now(),
});
fake.emit('server-request', {
    id: 'req_approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thr_test', turnId: 'turn_test', itemId: 'cmd_a', command: 'Get-Location' },
});
assert.equal(uiEvents.at(-1).type, 'approval.requested');
assert.equal(uiEvents.at(-1).payload.approval.scope, 'codex-native');
await manager.respondApproval({ approvalId: 'req_approval', decision: 'allow', generation: manager.runtimeGeneration });
assert.deepEqual(fake.responses.at(-1), { id: 'req_approval', result: { decision: 'accept' } });
await assert.rejects(
    () => manager.respondApproval({ approvalId: 'req_approval', decision: 'allow', generation: manager.runtimeGeneration }),
    (error) => error.code === 'NOT_FOUND' || error.code === 'INTERACTION_ALREADY_RESOLVED',
    'a resolved Codex approval must never be replayed',
);
fake.emit('server-request', { id: 'req_tool', method: 'item/tool/call', params: { callId: 'call_a' } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(fake.responses.at(-1).error.code, -32001);
assert.equal(uiEvents.filter((event) => event.type === 'approval.requested').length, 1,
    'dynamic tools must not be misrepresented as native Codex approvals');
const toolboxDecisions = [];
const toolboxInvocations = [];
const toolboxInterrupts = [];
manager.bridge = {
    invoke: async (payload) => {
        toolboxInvocations.push(payload);
        return { result: { ok: true, output: `completed ${payload.toolName}` } };
    },
    respondApproval: async (payload) => {
        toolboxDecisions.push(payload);
        return { written: true };
    },
    interrupt: async (requestId) => {
        toolboxInterrupts.push(requestId);
        return { interrupted: true };
    },
    stop: async () => {},
};
fake.emit('server-request', {
    id: 'req_vcp_invoke',
    method: 'item/tool/call',
    params: {
        threadId: 'thr_test', turnId: 'turn_test', callId: 'call_file_1',
        tool: 'vcp_invoke',
        arguments: { tool: 'FileOperator', arguments: { action: 'read', path: 'package.json' } },
    },
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(toolboxInvocations, [{
    requestId: 'codex:thr_test:turn_test:call_file_1',
    toolName: 'FileOperator',
    arguments: { action: 'read', path: 'package.json' },
}], 'bridge must receive the inner ToolBox target rather than the vcp_invoke wrapper');
assert.deepEqual(fake.responses.at(-1), {
    id: 'req_vcp_invoke',
    result: {
        contentItems: [{ type: 'inputText', text: 'completed FileOperator' }],
        success: true,
    },
});
for (const [id, params] of [
    ['req_wrong_wrapper', {
        threadId: 'thr_test', turnId: 'turn_test', callId: 'call_bad_wrapper', tool: 'other_tool',
        arguments: { tool: 'FileOperator', arguments: {} },
    }],
    ['req_missing_target', {
        threadId: 'thr_test', turnId: 'turn_test', callId: 'call_missing_target', tool: 'vcp_invoke',
        arguments: { arguments: {} },
    }],
    ['req_array_arguments', {
        threadId: 'thr_test', turnId: 'turn_test', callId: 'call_array_arguments', tool: 'vcp_invoke',
        arguments: { tool: 'FileOperator', arguments: [] },
    }],
]) {
    fake.emit('server-request', { id, method: 'item/tool/call', params });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.responses.at(-1).id, id);
    assert.equal(fake.responses.at(-1).result.success, false);
}
assert.equal(toolboxInvocations.length, 1, 'malformed dynamic-tool envelopes must fail before reaching ToolBox');
manager._handleBridgeEvent({
    channel: 'backend-approval',
    event: { requestId: 'toolbox-approval-1', expiresAtMs: Date.now() + 30_000, data: { toolName: 'PowerShellExecutor' } },
});
assert.equal(uiEvents.at(-1).payload.approval.scope, 'toolbox');
await manager.respondApproval({
    approvalId: 'toolbox-approval-1', scope: 'toolbox', decision: 'deny',
    generation: manager.toolboxApprovals.get('toolbox-approval-1').generation,
});
assert.equal(toolboxDecisions[0].approved, false);
manager._handleBridgeEvent({
    channel: 'backend-approval',
    event: { requestId: 'toolbox-approval-1', expiresAtMs: Date.now() + 30_000, replay: true, data: { toolName: 'PowerShellExecutor' } },
});
assert.notEqual(uiEvents.at(-1).payload?.approval?.approvalId, 'toolbox-approval-1',
    'a replayed ToolBox approval must not create a second actionable interaction');
manager._handleBridgeEvent({
    channel: 'info',
    event: { type: 'RAG_RETRIEVAL_DETAILS', apiKey: 'must-not-leak', detail: 'x'.repeat(20_000) },
});
assert.equal(uiEvents.at(-1).payload.kind, 'rag-retrieval');
assert.equal(uiEvents.at(-1).payload.value.apiKey, '[redacted]');
assert.equal(uiEvents.at(-1).payload.value.detail.length, 16_384);
const deletionTopic = await manager.createTopic({
    agentId: 'Nova', title: 'Permanent delete fixture', systemPrompt: '{{NovaV2}}',
});
const deletionSession = await manager.createSession({ sessionId: deletionTopic.sessionId });
await manager.archiveSession({ sessionId: deletionSession.sessionId });
await assert.rejects(() => manager.startTurn({ sessionId: deletionSession.sessionId, prompt: 'must not resume' }),
    (error) => error.code === 'SESSION_ARCHIVED',
    'an archived Session must remain projection-only until the user explicitly restores it');
const deletion = await manager.permanentlyDeleteSession({ sessionId: deletionSession.sessionId });
assert.equal(deletion.deleted, true);
assert.match(deletion.receipt.sessionHash, /^[0-9a-f]{64}$/);
assert.match(deletion.receipt.threadHash, /^[0-9a-f]{64}$/);
assert.equal(manager.repository.getSession(deletionSession.sessionId), null,
    'permanent deletion must remove the SQLite Session projection');
assert.ok(fake.calls.some((call) => call.method === 'thread/delete' && call.params.threadId === deletionSession.threadId));
assert.doesNotMatch(JSON.stringify(deletion.receipt), new RegExp(deletionSession.sessionId),
    'the retained deletion receipt must not contain raw Session identity');
const blockedDeleteTopic = await manager.createTopic({
    agentId: 'Nova', title: 'Blocked delete fixture', systemPrompt: '{{NovaV2}}',
});
const blockedDeleteSession = await manager.createSession({ sessionId: blockedDeleteTopic.sessionId });
await manager.archiveSession({ sessionId: blockedDeleteSession.sessionId });
const blockedPending = manager.repository.enqueuePendingInput(blockedDeleteSession.sessionId, {
    dedupeKey: 'delete-blocked-uncertain', prompt: 'must be resolved first',
});
manager.repository.updatePendingInput(blockedPending.input_id, { state: 'uncertain' });
await assert.rejects(() => manager.permanentlyDeleteSession({ sessionId: blockedDeleteSession.sessionId }),
    (error) => error.code === 'SESSION_HAS_PENDING_INPUT');
const approvalBlockedTopic = await manager.createTopic({
    agentId: 'Nova', title: 'Approval blocked delete fixture', systemPrompt: '{{NovaV2}}',
});
const approvalBlockedSession = await manager.createSession({ sessionId: approvalBlockedTopic.sessionId });
await manager.archiveSession({ sessionId: approvalBlockedSession.sessionId });
manager._handleBridgeEvent({
    channel: 'backend-approval',
    event: { requestId: 'toolbox-delete-blocker', expiresAtMs: Date.now() + 30_000, data: { toolName: 'PowerShellExecutor' } },
});
await assert.rejects(() => manager.permanentlyDeleteSession({ sessionId: approvalBlockedSession.sessionId }),
    (error) => error.code === 'SESSION_HAS_PENDING_APPROVAL');
await manager.respondApproval({
    approvalId: 'toolbox-delete-blocker', scope: 'toolbox', decision: 'deny',
    generation: manager.toolboxApprovals.get('toolbox-delete-blocker').generation,
});
assert.equal((await manager.permanentlyDeleteSession({ sessionId: approvalBlockedSession.sessionId })).deleted, true);
// A crashed App Server has no valid JSON-RPC response channel. All native
// approvals, dynamic calls and ToolBox backend approvals must be cleared and
// projected as fail-closed rather than lingering in a reopened Workbench.
fake.emit('server-request', {
    id: 'req_crash_native', method: 'item/fileChange/requestApproval',
    params: { threadId: 'thr_test', turnId: 'turn_test', itemId: 'file_crash' },
});
manager._handleBridgeEvent({
    channel: 'backend-approval',
    event: { requestId: 'toolbox-crash-approval', expiresAtMs: Date.now() + 30_000, data: { toolName: 'PowerShellExecutor' } },
});
let rejectCrashInvoke;
manager.bridge.invoke = () => new Promise((_resolve, reject) => { rejectCrashInvoke = reject; });
fake.emit('server-request', {
    id: 'req_crash_dynamic', method: 'item/tool/call',
    params: {
        threadId: 'thr_test', turnId: 'turn_test', callId: 'call_crash', tool: 'vcp_invoke',
        arguments: { tool: 'FileOperator', arguments: { action: 'read', path: 'package.json' } },
    },
});
await new Promise((resolve) => setImmediate(resolve));
fake.emit('exit', new Error('simulated App Server crash'));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(manager.getStatus().state, 'crashed');
assert.equal(manager.serverRequests.size, 0, 'crash must clear native and dynamic server requests');
assert.equal(manager.dynamicCalls.size, 0, 'crash must clear dynamic-call routing identity');
assert.equal(manager.toolboxApprovals.size, 0, 'crash must fail-close ToolBox backend approvals');
assert.deepEqual(toolboxInterrupts, ['codex:thr_test:turn_test:call_crash']);
assert.ok(toolboxDecisions.some((decision) => decision.requestId === 'toolbox-crash-approval' && decision.approved === false));
assert.ok(uiEvents.some((event) => event.type === 'approval.resolved'
    && event.approvalId === 'req_crash_native' && event.payload.reason === 'Codex App Server crashed'));
rejectCrashInvoke(new Error('bridge interrupted after crash'));
await manager.stop();
fs.rmSync(root, { recursive: true, force: true });

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
const uncertainTopic = await sagaManager.createTopic({ agentId: 'Nova', title: 'Uncertain start', systemPrompt: '{{Nova}}' });
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
const lifecycleSagaTopic = await archiveManager.createTopic({ agentId: 'Nova', title: 'Lifecycle Saga', systemPrompt: '{{Nova}}' });
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

// If writable startup fails but the existing database can be opened, Main
// degrades to read-only projection access and rejects every mutation.
const degradedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-degraded-'));
const degradedDatabase = path.join(degradedRoot, 'codex-agent-projection.sqlite');
const writableSeed = new AgentProjectionRepository({ databasePath: degradedDatabase });
writableSeed.saveSession({
    sessionId: 'degraded-session', agentId: 'Nova', title: 'Readable history', state: 'created',
    workspaceRoot: degradedRoot, configSnapshot: { baseInstructions: '{{Nova}}' },
});
writableSeed.close();
let repositoryAttempts = 0;
const degradedManager = new CodexRuntimeManager({
    projectRoot: degradedRoot,
    settingsPath: path.join(degradedRoot, 'settings.json'),
    getSettings: () => ({}),
    repositoryFactory: (config) => {
        repositoryAttempts += 1;
        if (!config.readOnly) throw new Error('simulated writable database failure');
        return new AgentProjectionRepository(config);
    },
});
assert.equal((await degradedManager.listTopics())[0]?.sessionId, 'degraded-session');
assert.equal(degradedManager.getStatus().storage.readOnly, true);
await assert.rejects(() => degradedManager.createTopic({ title: 'must fail' }),
    (error) => error.code === 'PROJECTION_READ_ONLY');
assert.equal(repositoryAttempts, 2, 'degraded startup must attempt writable then read-only exactly once');
await degradedManager.stop();
fs.rmSync(degradedRoot, { recursive: true, force: true });
console.log('Codex runtime manager tests passed.');
