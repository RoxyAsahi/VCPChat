import { assert, os, path, fs, CodexRuntimeManager, AgentProjectionRepository, developmentBridgePath, vcpInvokeTool, FakeTransport } from './fixtures/codex-runtime-manager-harness.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-manager-'));
fs.mkdirSync(path.join(root, 'AppData'), { recursive: true });
const diagnosticManager = new CodexRuntimeManager({
    projectRoot: root,
    getSettings: () => ({
        vcpServerUrl: 'http://user:password@localhost:6005/v1/chat/completions?api_key=secret',
        vcpApiKey: 'must-not-leave-main',
    }),
});
const diagnosticStatus = diagnosticManager.getStatus();
assert.equal(diagnosticStatus.toolbox.endpoint, 'http://localhost:6005/v1/chat/completions');
assert.equal(JSON.stringify(diagnosticStatus).includes('must-not-leave-main'), false,
    'Runtime diagnostics must never expose the ToolBox API key');
const diagnosticTopic = await diagnosticManager.createSessionRecord({
    agentId: 'Nova', title: 'Diagnostics', model: 'deepseek-v4-flash',
});
diagnosticManager.repository.replaceUnmaterializedThread(diagnosticTopic.sessionId, 'thread-diagnostics');
let diagnosticAdapterFilter = null;
diagnosticManager.responsesAdapter = {
    stop: async () => {},
    getDiagnostics: (filter) => {
        diagnosticAdapterFilter = filter;
        return ({
        state: 'ready', activeRequestCount: 0, recentRequests: [{
            sessionId: 'thread-diagnostics', threadId: 'thread-diagnostics', turnId: 'turn-diagnostics',
            model: 'deepseek-v4-flash', status: 'completed', httpStatus: 200,
            startedAt: 1, completedAt: 21, durationMs: 20,
            incomingTools: [{ type: 'function', name: 'shell_command' }, { type: 'function', name: 'vcp_invoke' }],
            forwardedTools: [{ type: 'function', name: 'vcp_invoke' }], error: null,
        }],
        });
    },
};
diagnosticManager.configApplyTargets.set('thread-diagnostics', {
    revision: 2, runtimeGeneration: 3,
    settings: { cwd: 'C:\\private\\workspace', model: 'deepseek-v4-flash', approvalPolicy: 'never' },
});
const sessionDiagnostics = diagnosticManager.readSessionDiagnostics({ sessionId: diagnosticTopic.sessionId });
assert.deepEqual(diagnosticAdapterFilter, { threadId: 'thread-diagnostics' },
    'Main diagnostics must query Adapter records by authoritative Codex Thread identity only');
assert.equal(sessionDiagnostics.toolbox.endpoint, 'http://localhost:6005/v1/chat/completions');
assert.equal(sessionDiagnostics.toolbox.adapter.recentRequests[0].sessionId, diagnosticTopic.sessionId,
    'Main diagnostics must rewrite Codex metadata sessionId to the owning VChat Session');
assert.equal(sessionDiagnostics.toolbox.adapter.recentRequests[0].threadId, 'thread-diagnostics');
assert.equal(sessionDiagnostics.toolbox.adapter.recentRequests[0].forwardedTools[0].name, 'vcp_invoke');
assert.deepEqual(sessionDiagnostics.applyBarrier.fields, ['approvalPolicy', 'cwd', 'model']);
assert.equal(JSON.stringify(sessionDiagnostics).includes('must-not-leave-main'), false);
assert.equal(JSON.stringify(sessionDiagnostics).includes('C:\\private'), false,
    'diagnostics expose barrier field names without leaking the workspace path');
const unmaterializedDiagnosticTopic = await diagnosticManager.createSessionRecord({
    agentId: 'Nova', title: 'Unmaterialized diagnostics', model: 'deepseek-v4-flash',
});
const unmaterializedDiagnostics = diagnosticManager.readSessionDiagnostics({
    sessionId: unmaterializedDiagnosticTopic.sessionId,
});
assert.deepEqual(diagnosticAdapterFilter, {
    threadId: `unmaterialized:${unmaterializedDiagnosticTopic.sessionId}`,
});
assert.deepEqual(unmaterializedDiagnostics.toolbox.adapter.recentRequests, [],
    'an unmaterialized Session must not receive another Thread\'s Adapter diagnostics');
assert.equal(vcpInvokeTool().inputSchema.properties.arguments.additionalProperties, true,
    'the generic VCP argument envelope must remain open after Codex normalizes DynamicTool schemas');
await import('./test-codex-runtime-manager-catalog.mjs');
const fake = new FakeTransport();
const uiEvents = [];
const manager = new CodexRuntimeManager({
    projectRoot: root,
    settingsPath: path.join(root, 'settings.json'),
    getSettings: () => ({}),
    getModels: () => [{ id: 'gpt-5.6-terra', reasoning_efforts: ['low', 'medium', 'high'] }],
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
const researchWorkspace = path.join(root, 'research-workspace');
fs.mkdirSync(researchWorkspace);
const savedBuildProfile = manager.saveAgentProfile({
    name: 'Research Agent', systemPrompt: '{{Research}}', model: 'gpt-5.6-terra',
    reasoningEffort: 'high', workspaceRoot: researchWorkspace, permissionMode: 'always-approve',
});
assert.equal(savedBuildProfile.profile.id, 'Research-Agent');
assert.equal(manager.listAgentProfiles().some((profile) => profile.id === 'Research-Agent'), true,
    'a saved Build Agent profile must immediately appear in the isolated catalog');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'CodexAgents', 'Research-Agent', 'config.json'), 'utf8')).systemPrompt,
    '{{Research}}', 'Build Agent creation must persist its prompt outside the normal-chat Agent directory');
const inheritedProfileTopic = await manager.createSessionRecord({ agentId: 'Research-Agent', title: 'Profile inheritance' });
const inheritedProfileSession = manager.repository.getSession(inheritedProfileTopic.sessionId);
assert.equal(inheritedProfileSession.workspaceRoot, researchWorkspace,
    'a new Session must inherit its Build Agent Profile workspace when the caller provides no override');
assert.equal(inheritedProfileSession.configSnapshot.model, 'gpt-5.6-terra',
    'a new Session must freeze its Build Agent Profile model instead of falling back to a global model');
assert.equal(inheritedProfileSession.configSnapshot.permissionMode, 'always-approve',
    'a new Session must freeze its Build Agent Profile approval mode');
assert.equal(inheritedProfileSession.configSnapshot.reasoningEffort, 'high',
    'a new Session must freeze only a reasoning effort advertised by its model metadata');
assert.throws(() => manager.saveAgentProfile({
    name: 'Unsupported reasoning', systemPrompt: '{{Nova}}', model: 'unknown-model', reasoningEffort: 'high',
}), /does not advertise reasoning effort/);
assert.throws(() => manager.saveAgentProfile({ name: 'Research Agent', systemPrompt: '{{Other}}' }), /already exists/);
const savedBuildAvatar = manager.saveAgentAvatar({
    agentId: 'Nova',
    expectedProfileRevision: buildProfiles.find((profile) => profile.id === 'Nova').revision,
    avatarData: { name: 'nova.png', type: 'image/png', buffer: new Uint8Array([1, 2, 3]) },
});
assert.match(savedBuildAvatar.avatarUrl, /CodexAgents\/Nova\/avatar-r\d+\.png/i,
    'Build avatars must be versioned under CodexAgents rather than overwriting normal-chat or prior Session assets');
const avatarFrozenTopic = await manager.createSessionRecord({ agentId: 'Nova', title: 'Avatar snapshot' });
const firstAvatarSnapshot = manager.repository.getSession(avatarFrozenTopic.sessionId).configSnapshot.agentAvatar;
assert.equal(firstAvatarSnapshot, savedBuildAvatar.avatarUrl,
    'Session creation must freeze the current Profile avatar URL');
const secondBuildAvatar = manager.saveAgentAvatar({
    agentId: 'Nova',
    expectedProfileRevision: savedBuildAvatar.revision,
    avatarData: { name: 'nova.webp', type: 'image/webp', buffer: new Uint8Array([4, 5, 6]) },
});
assert.notEqual(secondBuildAvatar.avatarUrl, savedBuildAvatar.avatarUrl);
assert.ok(secondBuildAvatar.revision > savedBuildAvatar.revision,
    'avatar changes must advance the Agent Profile revision');
assert.equal(manager.repository.getSession(avatarFrozenTopic.sessionId).configSnapshot.agentAvatar, firstAvatarSnapshot,
    'updating a Profile avatar must not mutate an existing Session snapshot');
const latestAvatarTopic = await manager.createSessionRecord({ agentId: 'Nova', title: 'Latest avatar snapshot' });
assert.equal(manager.repository.getSession(latestAvatarTopic.sessionId).configSnapshot.agentAvatar, secondBuildAvatar.avatarUrl,
    'new Sessions must freeze the latest versioned Profile avatar');
const workspaceTopic = await manager.createSessionRecord({
    agentId: 'Research-Agent', title: 'Workspace settings', workspaceRoot: root,
});
const nextWorkspace = path.join(root, 'next-workspace');
fs.mkdirSync(nextWorkspace);
const workspaceUpdate = await manager.updateWorkbenchSettings({
    sessionId: workspaceTopic.sessionId, workspaceRoot: nextWorkspace, expectedConfigRevision: 1,
});
assert.equal(workspaceUpdate.session.workspaceRoot, nextWorkspace,
    'selected Session workspace changes must be durable rather than renderer-only');
const promptUpdate = await manager.updateWorkbenchSettings({
    sessionId: workspaceTopic.sessionId,
    systemPrompt: '{{ResearchSession}}',
    expectedConfigRevision: workspaceUpdate.session.configRevision,
});
assert.equal(promptUpdate.session.configSnapshot.baseInstructions, '{{ResearchSession}}',
    'an unmaterialized Session must allow its frozen Base Instructions to be edited with CAS');
await assert.rejects(() => manager.updateWorkbenchSettings({
    sessionId: workspaceTopic.sessionId, workspaceRoot: path.join(root, 'missing-workspace'),
    expectedConfigRevision: promptUpdate.session.configRevision,
}), /does not exist/);
manager.repository.saveSession({
    ...manager.repository.getSession(workspaceTopic.sessionId),
    threadId: 'thr_materialized_identity',
    updatedAt: Date.now(),
});
const materializedPromptUpdate = await manager.updateWorkbenchSettings({
    sessionId: workspaceTopic.sessionId,
    systemPrompt: '{{MustFork}}',
    expectedConfigRevision: promptUpdate.session.configRevision,
});
assert.equal(materializedPromptUpdate.desiredConfig.baseInstructions, '{{MustFork}}',
    'Codex 0.146 materialized Threads must save VChat Base Instructions for an idle reload');
assert.ok(['pending', 'applying', 'applied'].includes(materializedPromptUpdate.applyState),
    'a materialized Base Instructions change must expose its Runtime apply state');

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
const providerTopic = await providerManager.createSessionRecord({ title: 'Adapter provider' });
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
assert.equal(providerStart.params.config['tools.update_plan.enabled'], true,
    'new Agent Sessions should expose the simple full-tool preset by default');
assert.equal(providerStart.params.config['features.shell_tool'], true);
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
const reconfigureBridgePath = developmentBridgePath(reconfigureRoot);
fs.mkdirSync(path.dirname(reconfigureBridgePath), { recursive: true });
fs.writeFileSync(reconfigureBridgePath, 'fixture');
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
const topic = await manager.createSessionRecord({ agentId: 'Nova', title: 'Test', model: 'Nova', systemPrompt: '{{Nova}}' });
const session = await manager.createSession({ sessionId: topic.sessionId });
assert.equal(session.threadId, 'thr_test');
const resumed = await manager.createSession({ sessionId: topic.sessionId });
assert.equal(resumed.sessionId, session.sessionId, 'resume must reuse the VChat Session instead of creating another one');
assert.equal(fake.calls.filter((call) => call.method === 'thread/start').length, 1);
// The generic personality only shapes how Codex phrases the default template;
// VChat's persona identity must arrive as `baseInstructions` so Codex replaces
// its built-in "You are Codex" system prompt instead of appending a hint.
// The Agent catalog's `systemPrompt` (e.g. `{{Nova}}`, expanded by VCPToolBox)
// maps to `baseInstructions`, never to the appending `developerInstructions`.
const baseInstructionsTopic = await manager.createSessionRecord({
    agentId: 'Nova',
    title: 'Persona',
    systemPrompt: '{{Nova}}',
    developerInstructions: 'extra hint',
});
await manager.createSession({ sessionId: baseInstructionsTopic.sessionId });
const personaStart = fake.calls.find((call) => call.method === 'thread/start'
    && call.params.baseInstructions === '{{Nova}}');
assert.equal(personaStart.params.baseInstructions, '{{Nova}}',
    'systemPrompt must map to baseInstructions so VCPToolBox expands the Nova identity and replaces Codex');
assert.equal(personaStart.params.developerInstructions, undefined,
    'VChat identity mode must not expose an ineffective second instruction source');
assert.equal(personaStart.params.personality, undefined,
    'personality is effective only when Codex manages the identity');
const managedTopic = await manager.createSessionRecord({
    agentId: 'Nova',
    title: 'Codex managed',
    instructionMode: 'codex-managed',
    developerInstructions: 'Keep answers concise.',
    personality: 'friendly',
});
await manager.createSession({ sessionId: managedTopic.sessionId });
const managedStart = fake.calls.find((call) => call.method === 'thread/start'
    && call.params.developerInstructions === 'Keep answers concise.');
assert.equal(managedStart.params.baseInstructions, undefined,
    'Codex-managed identity must not inject a VChat baseInstructions replacement');
assert.equal(managedStart.params.personality, 'friendly');
// An explicit `baseInstructions` wins over `systemPrompt` when both are given.
const explicitBaseTopic = await manager.createSessionRecord({
    agentId: 'Nova',
    title: 'Explicit base',
    baseInstructions: 'You are Nova, VChat\'s coding agent.',
    systemPrompt: '{{Nova}}',
});
await manager.createSession({ sessionId: explicitBaseTopic.sessionId });
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
assert.equal(repairedLegacy.executionProfile, 'toolbox-only',
    'R12 must normalize every active Session snapshot to the only supported execution profile');

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
const materializedAvatarSnapshot = manager.repository.getSession(session.sessionId).configSnapshot.agentAvatar;
const latestProfileAvatar = manager.saveAgentAvatar({
    agentId: 'Nova',
    expectedProfileRevision: secondBuildAvatar.revision,
    avatarData: { name: 'nova-latest.png', type: 'image/png', buffer: new Uint8Array([7, 8, 9]) },
});
assert.equal(manager.repository.getSession(session.sessionId).configSnapshot.agentAvatar, materializedAvatarSnapshot,
    'a materialized Session must not adopt a later Profile avatar implicitly');
const revisedNova = manager.saveAgentProfile({
    agentId: 'Nova', expectedProfileRevision: latestProfileAvatar.revision,
    name: 'Nova', systemPrompt: '{{NovaV2}}', model: 'profile-model-v2', permissionMode: 'ask',
});
assert.ok(revisedNova.profile.revision > Number(session.configSnapshot.profileRevision || 1));
assert.equal(revisedNova.profile.avatarUrl, latestProfileAvatar.avatarUrl,
    'saving other Profile fields must preserve the latest versioned avatar');
const profilePreview = await manager.applyAgentProfileToSession({
    sessionId: session.sessionId,
    expectedConfigRevision: manager.repository.getSession(session.sessionId).configRevision,
    previewOnly: true,
});
assert.equal(profilePreview.requiresNewSession, true,
    'a materialized Thread must not silently accept prompt identity changes from its Profile');
assert.ok(profilePreview.identityChanges.includes('baseInstructions'));
assert.ok(profilePreview.differences.some((difference) => difference.field === 'avatar'),
    'Profile preview must disclose avatar drift instead of silently changing old Session presentation');
const profileFork = await manager.applyAgentProfileToSession({
    sessionId: session.sessionId,
    expectedConfigRevision: manager.repository.getSession(session.sessionId).configRevision,
    createNewSession: true,
});
assert.equal(profileFork.createdNewSession, true);
assert.equal(profileFork.session.threadId, null,
    'applying identity-changing Profile fields must create a fresh unmaterialized Session');
assert.equal(manager.repository.getSession(profileFork.session.sessionId).configSnapshot.agentAvatar, latestProfileAvatar.avatarUrl,
    'the new Session created from an updated Profile must freeze the latest avatar version');
assert.equal(manager.repository.getSession(session.sessionId).configSnapshot.baseInstructions, '{{Nova}}',
    'the original materialized Session must retain its frozen Profile snapshot');
// A fresh App Server process has no in-memory subscription for the persisted
// VChat Session. Simulate that boundary: the next write must reopen exactly
// the saved Codex Thread, never create a replacement Thread.
manager.resumedThreadIds.clear();
const resumedAfterRestart = await manager.createSession({ sessionId: topic.sessionId });
assert.equal(resumedAfterRestart.threadId, 'thr_test');
assert.equal(fake.calls.filter((call) => call.method === 'thread/start').length, 4,
    'the original, VChat identity, Codex-managed and explicit-base Sessions start Threads; every resume reopens the saved one');
await manager.startTurn({ sessionId: inheritedProfileTopic.sessionId, prompt: 'reason carefully' });
assert.equal(fake.calls.filter((call) => call.method === 'turn/start').at(-1).params.effort, 'high',
    'the validated Session reasoning effort must reach the next turn/start request');
const resumeCall = fake.calls.find((call) => call.method === 'thread/resume' && call.params.threadId === 'thr_test');
assert.deepEqual({ threadId: resumeCall.params.threadId, excludeTurns: resumeCall.params.excludeTurns }, {
    threadId: 'thr_test', excludeTurns: true,
});
const turn = await manager.startTurn({ sessionId: session.sessionId, prompt: 'hello' });
assert.equal(turn.turnId, 'turn_test');
const helloTurnStart = fake.calls.filter((call) => call.method === 'turn/start').at(-1);
assert.deepEqual(helloTurnStart.params.input, [
    { type: 'text', text: 'hello', text_elements: [] },
]);
assert.equal(helloTurnStart.params.approvalPolicy, 'never',
    'the next Turn must receive the current Session approval policy without restarting its Thread');
assert.equal(helloTurnStart.params.model, 'gpt-5.6-luna',
    'the next Turn must receive the model saved for the current Session');
fake.emit('notification', {
    method: 'item/started',
    params: { threadId: 'thr_test', turnId: 'turn_test', item: { id: 'item_a', type: 'agentMessage', text: '' } },
});
fake.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr_test', turnId: 'turn_test', itemId: 'item_a', delta: 'partial' },
});
assert.equal(uiEvents.at(-1).projectionMessage, undefined,
    'Renderer events must not expose the legacy per-message projection cache');
assert.equal(uiEvents.at(-1).projectionPatch.schemaVersion, 1);
assert.equal(uiEvents.at(-1).projectionPatch.sessionId, session.sessionId);
assert.equal(uiEvents.at(-1).projectionPatch.threadId, 'thr_test');
assert.equal(uiEvents.at(-1).projectionPatch.upsertBlocks[0].schemaVersion, 2);
assert.equal(uiEvents.at(-1).projectionPatch.upsertBlocks[0].blockId,
    `block:${session.sessionId}:item_a:0`);
assert.equal(uiEvents.at(-1).projectionPatch.upsertBlocks[0].content.text, 'partial');
fake.emit('notification', {
    method: 'item/completed',
    params: { threadId: 'thr_test', turnId: 'turn_test', item: { id: 'item_a', type: 'agentMessage', text: 'done' } },
});
const projection = await manager.readSession({ sessionId: session.sessionId });
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
const temporaryFailureProjection = await manager.readSession({ sessionId: session.sessionId });
assert.equal(temporaryFailureProjection.session.orphaned, false,
    'a temporary read failure must preserve a writable Session instead of inventing an orphan');
assert.match(temporaryFailureProjection.projection.lastError, /temporary App Server transport failure/);
fake.readError = new Error('No rollout found for thread thr_test');
const missingThreadProjection = await manager.readSession({ sessionId: session.sessionId });
assert.equal(missingThreadProjection.session.orphaned, true,
    'only an explicit missing Codex Thread may mark the local Session orphaned');
fake.readError = null;
manager.resumedThreadIds.clear();
await manager.createSession({ sessionId: session.sessionId });
assert.equal(manager.repository.getSession(session.sessionId).orphaned, false,
    'a successful explicit resume clears a previously stale orphan marker');
const resumesBeforeRetryFork = fake.calls.filter((call) => call.method === 'thread/resume').length;
const fork = await manager.forkSession({ sessionId: session.sessionId, beforeTurnId: 'turn_test' });
assert.equal(fork.threadId, 'thr_fork');
assert.equal(manager.getStatus().runtimes.some((runtime) => runtime.sessionId === session.sessionId), true);
const retryForkRequest = fake.calls.filter((call) => call.method === 'thread/fork').at(-1);
assert.equal(retryForkRequest.params.threadId, 'thr_test');
assert.equal(retryForkRequest.params.beforeTurnId, 'turn_test',
    'retry/edit forks must exclude the selected Turn instead of copying it and resubmitting the same input');
assert.equal(retryForkRequest.params.model, manager.repository.getSession(session.sessionId).configSnapshot.model,
    'forks must carry the Session model instead of falling back to an unrelated provider default');
assert.equal(retryForkRequest.params.baseInstructions, manager.repository.getSession(session.sessionId).configSnapshot.baseInstructions,
    'forks must carry the trusted VChat identity into the replacement Thread');
assert.equal(manager.resumedThreadIds.has('thr_fork'), false,
    'a freshly forked Thread must be resumed once to bind toolbox-only dynamic tools and provider policy');
await manager.startTurn({ sessionId: fork.sessionId, prompt: 'retry input' });
assert.equal(fake.calls.filter((call) => call.method === 'thread/resume').length, resumesBeforeRetryFork + 1,
    'sending the first replacement Turn must resume the fork once to bind toolbox-only runtime configuration');
// Archive/unarchive must move the actual Codex Thread, while pinning remains
// VChat-only presentation metadata. None of these navigation operations may
// infer or replace a Thread identity.
const lifecycleSession = await manager.createSession({ sessionId: baseInstructionsTopic.sessionId });
const pinned = await manager.setSessionPinned({ sessionId: lifecycleSession.sessionId, pinned: true });
assert.equal(pinned.session.pinnedAt > 0, true);
const archived = await manager.closeSession({ sessionId: lifecycleSession.sessionId });
assert.equal(archived.archived, true);
assert.ok(fake.calls.some((call) => call.method === 'thread/archive' && call.params.threadId === lifecycleSession.threadId));
assert.equal((await manager.listSessions()).some((entry) => entry.sessionId === lifecycleSession.sessionId), false);
assert.equal((await manager.listSessions({ archived: true })).some((entry) => entry.sessionId === lifecycleSession.sessionId), true);
const restored = await manager.restoreSession({ sessionId: lifecycleSession.sessionId });
assert.equal(restored.restored, true);
assert.ok(fake.calls.some((call) => call.method === 'thread/unarchive' && call.params.threadId === lifecycleSession.threadId));
assert.equal((await manager.listSessions()).find((entry) => entry.sessionId === lifecycleSession.sessionId).pinnedAt > 0, true);
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
const queuedFollowUp = await manager.followUpTurn({
    sessionId: lifecycleSession.sessionId, turnId: 'active-turn', submissionId: 'follow-up-test-1',
    prompt: 'run after current turn',
});
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
const uncertainQueue = await manager.listInteractionQueue({ sessionId: lifecycleSession.sessionId });
assert.equal(uncertainQueue.items.find((entry) => entry.inputId === uncertainInput.inputId)?.state, 'uncertain',
    'uncertain input must be exposed through the Session-scoped recovery queue');
await manager.resolvePendingInput({
    sessionId: lifecycleSession.sessionId,
    inputId: uncertainInput.inputId,
    action: 'discard',
});
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .some((entry) => entry.inputId === uncertainInput.inputId), false,
    'discard must remove only the explicitly selected uncertain input');

manager.repository.enqueuePendingInput(lifecycleSession.sessionId, {
    dedupeKey: 'explicit-resend', prompt: 'send only after user confirmation',
});
const resendInput = manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .find((entry) => entry.dedupeKey === 'explicit-resend');
manager.repository.updatePendingInput(resendInput.inputId, { state: 'uncertain', attemptCount: 1 });
const oldClientMessageId = resendInput.clientMessageId;
const startsBeforeExplicitResend = fake.calls.filter((call) => call.method === 'turn/start').length;
await manager.resolvePendingInput({
    sessionId: lifecycleSession.sessionId,
    inputId: resendInput.inputId,
    action: 'resend',
});
assert.equal(fake.calls.filter((call) => call.method === 'turn/start').length, startsBeforeExplicitResend + 1,
    'explicit resend must dispatch exactly one replacement Turn');
const explicitResendCall = fake.calls.filter((call) => call.method === 'turn/start').at(-1);
assert.notEqual(explicitResendCall.params.clientUserMessageId, oldClientMessageId,
    'explicit resend must use a new client message identity');
assert.equal(manager.repository.listPendingInputs(lifecycleSession.sessionId)
    .some((entry) => entry.inputId === resendInput.inputId), false);
manager.threadStates.set(lifecycleSession.threadId, { activity: 'idle', activeTurnId: null });
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
    configSnapshot: {
        ...approvalSession.configSnapshot,
        executionProfile: 'codex-native-legacy',
        toolPolicy: {
            schemaVersion: 1,
            preset: 'custom',
            enabledCodexCapabilities: [],
            enabledVcpTools: ['vcp:*'],
        },
    },
    appliedRuntimeConfig: {
        ...(approvalSession.appliedRuntimeConfig || approvalSession.configSnapshot),
        toolPolicy: {
            schemaVersion: 1,
            preset: 'custom',
            enabledCodexCapabilities: [],
            enabledVcpTools: ['vcp:*'],
        },
    },
    updatedAt: Date.now(),
});
fake.emit('server-request', {
    id: 'req_approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thr_test', turnId: 'turn_test', itemId: 'cmd_a', command: 'Get-Location' },
});
assert.equal(uiEvents.at(-1).type, 'interaction.rejected',
    'legacy executionProfile fields must not override the explicit per-Session tool policy');
assert.deepEqual(fake.responses.at(-1), { id: 'req_approval', result: { decision: 'decline' } });
fake.emit('server-request', { id: 'req_tool', method: 'item/tool/call', params: { callId: 'call_a' } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(fake.responses.at(-1).error.code, -32001);
assert.equal(uiEvents.filter((event) => event.type === 'approval.requested').length, 0,
    'dynamic tools must not be misrepresented as native Codex approvals');
const toolboxDecisions = [];
const toolboxInvocations = [];
const toolboxInterrupts = [];
let crashBridgeStops = 0;
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
    stop: async () => { crashBridgeStops += 1; },
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
const deletionTopic = await manager.createSessionRecord({
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
const blockedDeleteTopic = await manager.createSessionRecord({
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
const approvalBlockedTopic = await manager.createSessionRecord({
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
manager.threadStates.set(session.threadId, { activity: 'running', activeTurnId: 'turn_test' });
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
assert.equal(fake.status.running, false, 'crash must stop the old App Server transport authority');
assert.equal(crashBridgeStops, 1, 'crash must stop the old ToolBox bridge authority');
assert.equal(manager.transport, null);
assert.equal(manager.bridge, null);
assert.equal(manager.repository, null, 'crash must close and release the old projection Repository handle');
const crashRepository = manager.ensureProjectionStore();
    assert.equal(crashRepository.getSession(session.sessionId).state, 'interrupted',
        'a running Session must be durably marked interrupted after App Server crash');
    assert.equal(crashRepository.readProjection(session.sessionId).projection.activity.deliveryState, 'unconfirmed');
assert.equal(manager.serverRequests.size, 0, 'crash must clear native and dynamic server requests');
assert.equal(manager.dynamicCalls.size, 0, 'crash must clear dynamic-call routing identity');
assert.equal(manager.toolboxApprovals.size, 0, 'crash must fail-close ToolBox backend approvals');
assert.deepEqual(toolboxInterrupts, ['codex:thr_test:turn_test:call_crash']);
assert.ok(toolboxDecisions.some((decision) => decision.requestId === 'toolbox-crash-approval' && decision.approved === false));
assert.ok(uiEvents.some((event) => event.type === 'interaction.rejected'
    && event.payload.requestId === 'req_crash_native'),
'toolbox-only native requests must be rejected immediately instead of surviving until a crash');
rejectCrashInvoke(new Error('bridge interrupted after crash'));
await manager.stop();
await diagnosticManager.stop();
fs.rmSync(root, { recursive: true, force: true });

// A remote mutation whose acknowledgement is lost must be journaled as
