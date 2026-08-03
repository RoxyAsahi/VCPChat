'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { RuntimeLifecycleService } = require('./runtime-lifecycle-service');
const { CodexAppServerTransport, CodexAppServerError } = require('./appServerTransport');
const { AgentProjectionRepository, CodexProjectionProjector } = require('./projection');
const { ToolboxBridgeTransport } = require('./toolboxBridgeTransport');
const { ToolboxResponsesAdapter } = require('./toolboxResponsesAdapter');
const { AttachmentRegistry } = require('./attachmentRegistry');
const { attachRuntimeServiceGraph } = require('./runtime-service-graph');
const {
    capabilityMatrix,
} = require('./protocolCapabilities');
const {
    approvalProjection,
    compatibilityRuntime,
    resolveSessionIdInput,
    serializeError,
    vcpInvokeTool,
} = require('./runtime-normalizers');

class CodexRuntimeManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.projectRoot = options.projectRoot || process.cwd();
        this.settingsPath = options.settingsPath || path.join(this.projectRoot, 'AppData', 'settings.json');
        this.agentsDir = options.agentsDir || path.join(path.dirname(this.settingsPath), 'CodexAgents');
        this.getSettings = options.getSettings || (() => ({}));
        this.getModels = options.getModels || (() => []);
        this.sendEvent = options.sendEvent || (() => {});
        this.transportFactory = options.transportFactory || ((config) => new CodexAppServerTransport(config));
        this.repositoryFactory = options.repositoryFactory || ((config) => new AgentProjectionRepository(config));
        this.responsesAdapterFactory = options.responsesAdapterFactory
            || ((config) => new ToolboxResponsesAdapter(config));
        this.bridgeFactory = options.bridgeFactory || ((config) => new ToolboxBridgeTransport(config));
        // Optional Main-process settings writer.  Session-scoped changes stay
        // in the projection store; only a model change made with no selected
        // Session is written back as the default for future Sessions.
        this.setSettings = options.setSettings || null;
        this.transport = null;
        this.repository = null;
        this.projector = null;
        this.state = 'stopped';
        this.lastError = null;
        this.attachments = options.attachmentRegistry || new AttachmentRegistry();
        this.bridge = null;
        this.responsesAdapter = null;
        this.threadStates = new Map();
        // Loaded/resumed is process-local App Server state. SQLite's threadId
        // outlives this set, so every fresh App Server process must explicitly
        // `thread/resume` before VChat sends a new turn to an existing Thread.
        this.resumedThreadIds = new Set();
        this.resumingThreads = new Map();
        this.uiEventSequence = 0;
        this.workbenchMounted = false;
        this.intentionalStop = false;
        this.sessionWarmPromises = new Map();
        this.turnStartPromises = new Map();
        this.followUpDrainPromises = new Map();
        this.configApplyPromises = new Map();
        this.configApplyTargets = new Map();
        this.compactionWaiters = new Map();
        this.idleWarmSessions = new Map();
        this.maxIdleWarmSessions = Number.isInteger(options.maxIdleWarmSessions)
            ? Math.max(0, options.maxIdleWarmSessions) : 2;
        this.diagnosticClock = options.diagnosticClock || (() => performance.now());
        this.startPromise = null;
        this.lifecycle = new RuntimeLifecycleService();
        this.runtimeGeneration = this.lifecycle.value;
        this.generationScope = this.lifecycle.capture();
        this.toolboxAuthorityGeneration = 0;
        this.runtimeStartFailures = 0;
        this.runtimeRetryAfter = 0;
        this.faultInjection = options.faultInjection || {};
        this.knownOperationRecoveryPromise = null;
        this._defaultStartTurnMethod = this._startTurn;
        attachRuntimeServiceGraph(this);
    }

    getStatus() {
        return {
            state: this.state,
            runtime: 'codex-app-server',
            protocol: 'codex-app-server-jsonl',
            worker: this.transport?.status || null,
            lastError: this.lastError,
            sessions: this.repository?.listSessions() || [],
            runtimes: (this.repository?.listSessions() || [])
                .filter((session) => session.threadId)
                .map((session) => compatibilityRuntime(session, this.threadStates.get(session.threadId))),
            pendingApprovals: [...this.serverRequests.entries()]
                .filter(([, request]) => [
                    'item/commandExecution/requestApproval',
                    'item/fileChange/requestApproval',
                ].includes(request.method))
                .map(([requestId, request]) => approvalProjection(requestId, request, this.repository))
                .concat([...this.toolboxApprovals.values()]),
            pendingInteractions: this.interactions.active(),
            toolbox: {
                configured: Boolean(this.getSettings()?.vcpServerUrl && this.getSettings()?.vcpApiKey),
            },
            storage: this.repository ? {
                readOnly: this.repository.readOnly === true,
                degradedReason: this.repository.degradedReason || null,
            } : { readOnly: false, degradedReason: null },
            capabilities: capabilityMatrix('toolbox-only'),
        };
    }

    async start() {
        return this.hostService.start();
    }

    ensureProjectionStore() {
        if (!this.repository) {
            const databasePath = path.join(path.dirname(this.settingsPath), 'codex-agent-projection.sqlite');
            const forceReadOnly = process.env.VCPCHAT_E2E_TEST === '1'
                && process.env.VCPCHAT_E2E_FORCE_AGENT_PROJECTION_READ_ONLY === '1';
            if (forceReadOnly) {
                this.repository = this.repositoryFactory({
                    databasePath,
                    readOnly: true,
                    degradedReason: 'E2E forced read-only projection mode',
                });
            }
            try {
                this.repository = this.repository || this.repositoryFactory({ databasePath });
            } catch (error) {
                if (!fs.existsSync(databasePath)) throw error;
                this.repository = this.repositoryFactory({
                    databasePath,
                    readOnly: true,
                    degradedReason: error?.message || String(error),
                });
                this.lastError = serializeError(error);
            }
        }
        this.projector = this.projector || new CodexProjectionProjector(this.repository);
        return this.repository;
    }

    _assertProjectionWritable() {
        this.ensureProjectionStore().assertWritable();
    }

    async stop() {
        return this.hostService.stop();
    }

    _clearHostResources() {
        this.transport = null;
        this.repository = null;
        this.projector = null;
        this.bridge = null;
        this.responsesAdapter = null;
        this.serverRequests.clear();
        this.threadStates.clear();
        this.resumedThreadIds.clear();
        this.resumingThreads.clear();
        this.configApplyPromises.clear();
        this.configApplyTargets.clear();
        this.sessionWarmPromises.clear();
        this.turnStartPromises.clear();
        this.followUpDrainPromises.clear();
        this.idleWarmSessions.clear();
        this.dynamicCalls.clear();
        this.toolboxApprovals.clear();
        this.interactionService.clearTimers();
        this.attachments.clear();
        this.startPromise = null;
        this.knownOperationRecoveryPromise = null;
    }

    _captureGeneration() {
        return this.lifecycle.capture();
    }

    _assertGeneration(scope) {
        this.lifecycle.assert(scope, CodexAppServerError);
        if (!this.repository) throw new CodexAppServerError('RUNTIME_STOPPED', 'Agent projection store is closed');
    }

    async createTopic(options = {}) {
        return this.sessionService.create(options);
    }

    async createSessionRecord(options = {}) {
        return this.createTopic(options);
    }

    async listSessions(options = {}) {
        return this.listTopics(options);
    }

    async readSession({ sessionId, reconcile = true } = {}) {
        return this.readTopic({ sessionId, reconcile });
    }

    async renameSession({ sessionId, title } = {}) {
        return this.renameTopic({ sessionId, title });
    }

    async createSession(options = {}) {
        this._assertProjectionWritable();
        const requestedSessionId = options.sessionId || options.topicId || options.resume;
        this.ensureProjectionStore();
        let session = requestedSessionId ? this.repository.getSession(requestedSessionId) : null;
        if (!session) {
            const created = await this.createTopic(options);
            session = this.repository.getSession(created.sessionId);
        }
        return this.ensureSessionRuntime({ ...options, sessionId: session.sessionId });
    }

    listAgentProfiles() {
        return this.profileService.listAgentProfiles();
    }

    saveAgentProfile(input = {}) {
        return this.profileService.saveAgentProfile(input);
    }

    saveAgentAvatar(options = {}) {
        return this.profileService.saveAgentAvatar(options);
    }

    async ensureSessionRuntime({
        sessionId, topicId, reason = 'send', recoverPendingInputs = true, ...options
    } = {}) {
        return this.turnService.ensureSessionRuntime({
            sessionId, topicId, reason, recoverPendingInputs, ...options,
        });
    }

    async _startThreadForSession(session, options = {}) {
        return this.turnService.startThreadForSession(session, options);
    }

    async readTopic({ topicId, sessionId, reconcile = true } = {}) {
        return this.sessionService.read({ topicId, sessionId, reconcile });
    }

    async listTopics({ agentId, archived = false } = {}) {
        return this.sessionService.list({ agentId, archived });
    }

    async startTurn({ sessionId, topicId, prompt, attachments = [], clientUserMessageId } = {}) {
        return this._startTurnWithGuard({
            sessionId, topicId, prompt, attachments, clientUserMessageId, recoverPendingInputs: true,
        });
    }

    async _startTurnWithGuard({
        sessionId, topicId, prompt, attachments = [], clientUserMessageId, recoverPendingInputs,
    } = {}) {
        return this.turnService.startTurnWithGuard({
            sessionId, topicId, prompt, attachments, clientUserMessageId, recoverPendingInputs,
        });
    }

    async _startTurn({
        sessionId, prompt, attachments = [], clientUserMessageId, recoverPendingInputs = true,
    } = {}) {
        return this.turnService.startTurnInternal({
            sessionId, prompt, attachments, clientUserMessageId, recoverPendingInputs,
        });
    }

    async steerTurn({ sessionId, topicId, turnId, prompt } = {}) {
        return this.turnService.steer({ sessionId, topicId, turnId, prompt });
    }

    async followUpTurn({ sessionId, topicId, prompt, attachments = [] } = {}) {
        return this.turnService.followUp({ sessionId, topicId, prompt, attachments });
    }

    async cancelTurn({ sessionId, topicId, turnId } = {}) {
        return this.turnService.cancel({ sessionId, topicId, turnId });
    }

    async forkSession({ sessionId, topicId, turnId, title } = {}) {
        return this.turnService.fork({ sessionId, topicId, turnId, title });
    }

    _assertLifecycleIdle(session) {
        const state = session?.threadId ? this.threadStates.get(session.threadId) : null;
        const hasInteraction = session?.threadId && [...this.serverRequests.values()]
            .some((request) => request?.params?.threadId === session.threadId);
        if (state?.activity === 'running' || hasInteraction) {
            throw new CodexAppServerError('SESSION_BUSY', 'Finish or cancel the current turn or interaction first');
        }
    }

    async archiveSession({ sessionId, topicId } = {}) {
        return this.sessionService.archive({ sessionId, topicId });
    }

    async closeSession(options = {}) { return this.archiveSession(options); }

    async restoreSession({ sessionId, topicId } = {}) {
        return this.sessionService.restore({ sessionId, topicId });
    }

    async setSessionPinned({ sessionId, topicId, pinned } = {}) {
        return this.sessionService.pin({ sessionId, topicId, pinned });
    }

    async setWorkbenchPresence(mounted = true) {
        this.workbenchMounted = mounted === true;
        if (!this.workbenchMounted) {
            await this._failClosedNativeApprovals('VChat Workbench closed');
            this.interactions.clear({ source: 'codex-native' });
            await this._failClosedToolboxApprovals('VChat Workbench closed');
            this.interactions.clear({ source: 'toolbox' });
        }
        return { mounted: this.workbenchMounted };
    }
    async compactSession({ sessionId, topicId, timeoutMs = 120_000 } = {}) {
        return this.turnService.compact({ sessionId, topicId, timeoutMs });
    }
    async searchTopics(options = {}) { return { topics: await this.listTopics(options) }; }
    async searchTopicMessages({ topicId, sessionId } = {}) { return this.readTopic({ topicId, sessionId }); }
    async getTopicIndexStatus() { return { available: false, source: 'codex-thread-store' }; }
    async rebuildTopicIndex() { return { available: false }; }
    async renameTopic({ topicId, sessionId, title }) {
        return this.sessionService.rename({ topicId, sessionId, title });
    }
    async deleteTopic({ topicId, sessionId }) { return this.archiveSession({ topicId, sessionId }); }
    listRecoveryOperations() {
        return this.recoveryService.listOperations();
    }
    async _recoverKnownThreadOperations() {
        return this.recoveryService.recoverKnownThreadOperations();
    }
    async _recoverKnownThreadOperation(input) {
        return this.recoveryService.recoverKnownThreadOperation(input);
    }
    async _listStoredThreads(archived) {
        return this.recoveryService.listStoredThreads(archived);
    }
    _normalizeUnboundThreadOperations() {
        return this.recoveryService.normalizeUnboundThreadOperations();
    }
    async listRecoveryCandidates() {
        return this.recoveryService.listRecoveryCandidates();
    }
    async resolveRecoveryOperation({ operationId, action, threadId } = {}) {
        return this.recoveryService.resolveRecoveryOperation({ operationId, action, threadId });
    }
    async permanentlyDeleteSession({ sessionId, topicId } = {}) {
        return this.sessionService.permanentlyDelete({ sessionId, topicId });
    }
    exportSession({ sessionId, topicId, format = 'markdown' } = {}) {
        return this.sessionService.export({ sessionId, topicId, format });
    }
    async listInteractionQueue({ sessionId, topicId } = {}) {
        return this.interactionService.listQueue({ sessionId, topicId });
    }

    async replaceInteractionQueue({ sessionId, topicId, interactions = [] } = {}) {
        return this.interactionService.replaceQueue({ sessionId, topicId, interactions });
    }

    async clearInteractionQueue({ sessionId, topicId } = {}) {
        return this.interactionService.clearQueue({ sessionId, topicId });
    }

    async resolvePendingInput({ sessionId, topicId, inputId, action } = {}) {
        return this.interactionService.resolvePendingInput({ sessionId, topicId, inputId, action });
    }
    getWorkbenchSettings() {
        return this.configService.getWorkbenchSettings();
    }

    async updateWorkbenchSettings(settings = {}) {
        return this.configService.updateWorkbenchSettings(settings);
    }

    async updateSessionConfig({ sessionId, topicId, expectedConfigRevision, patch } = {}) {
        return this.configService.updateSessionConfig({ sessionId, topicId, expectedConfigRevision, patch });
    }

    readSessionConfig({ sessionId } = {}) {
        return this.configService.readSessionConfig({ sessionId });
    }

    _sendSessionConfigEvent(type, session, error = null) {
        return this.configService.sendSessionConfigEvent(type, session, error);
    }

    _scheduleSessionConfigApply(sessionId) {
        return this.configService.scheduleApply(sessionId);
    }

    async _applySessionRuntimeConfig(sessionId, { barrier = false } = {}) {
        return this.configService.applySessionRuntimeConfig(sessionId, { barrier });
    }

    async applyAgentProfileToSession({
        sessionId, expectedConfigRevision, previewOnly = false, createNewSession = false,
    } = {}) {
        return this.profileService.applyAgentProfileToSession({
            sessionId,
            expectedConfigRevision,
            previewOnly,
            createNewSession,
        });
    }
    async importAttachment({ sessionId, path: inputPath } = {}) {
        if (!this.repository.getSession(sessionId)) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const resolved = path.resolve(String(inputPath || ''));
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) throw new CodexAppServerError('INVALID_ATTACHMENT', 'Attachment must be a file');
        if (stat.size > 32 * 1024 * 1024) throw new CodexAppServerError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds 32 MiB');
        return { attachment: this.attachments.register(sessionId, resolved, stat) };
    }
    async respondApproval({ requestId, approvalId, decision, scope, reason, generation } = {}) {
        return this.interactionService.respondApproval({ requestId, approvalId, decision, scope, reason, generation });
    }

    async respondInteraction({ source = 'codex-native', requestId, kind, response = {}, generation } = {}) {
        return this.interactionService.respondInteraction({ source, requestId, kind, response, generation });
    }

    _profileForRequest(request) {
        const threadId = request?.params?.threadId;
        return threadId
            ? (this.repository?.getSessionByThread(threadId)?.configSnapshot?.executionProfile || 'toolbox-only')
            : 'toolbox-only';
    }

    _clearInteractionTimer(requestId) {
        this.interactionService.clearTimer(requestId);
    }

    _configSnapshot(options) {
        return this.profileService.configSnapshot(options);
    }

    _resolveAgentProfile(agentId) {
        return this.profileService.resolveAgentProfile(agentId);
    }

    _agentCatalog() {
        return this.profileService.agentCatalog();
    }

    _ensureDefaultAgentProfile() {
        return this.profileService.ensureDefaultAgentProfile();
    }

    _agentAvatarUrl(agentId, profileConfig = null) {
        return this.profileService.agentAvatarUrl(agentId, profileConfig);
    }

    _resolveCanonicalAgent(value, { failOnAmbiguous = false } = {}) {
        return this.profileService.resolveCanonicalAgent(value, { failOnAmbiguous });
    }

    _repairSessionIdentity(session) {
        return this.profileService.repairSessionIdentity(session);
    }

    _rememberIdleWarmSession(sessionId) {
        return this.eventService.rememberIdleWarmSession(sessionId);
    }

    _diagnostic(name, fields = {}) {
        const safe = Object.fromEntries(Object.entries(fields).map(([key, value]) => {
            if (key === 'sessionId' || key === 'turnId' || key === 'agentId') {
                const text = String(value || '');
                return [key, text ? `${text.slice(0, 8)}…` : null];
            }
            return [key, typeof value === 'number' ? Math.round(value * 10) / 10 : value];
        }));
        const line = `[agent-ux] ${JSON.stringify({ name, ...safe })}`;
        console.debug(line);
        this.emit('diagnostic', line);
    }

    _repairSessionConfig(session) {
        return this.profileService.repairSessionConfig(session);
    }

    _runtimePolicyParams(config = {}, { starting = false } = {}) {
        return this.policyService.runtimePolicyParams(config, { starting });
    }

    _reasoningEffortsForModel(modelId) {
        return this.profileService.reasoningEffortsForModel(modelId);
    }

    _validateReasoningEffort(modelId, value, { supported } = {}) {
        return this.profileService.validateReasoningEffort(modelId, value, { supported });
    }

    _effectiveReasoningEffort(config = {}) {
        return this.profileService.effectiveReasoningEffort(config);
    }

    _threadInstructionParams(config = {}) {
        return this.policyService.threadInstructionParams(config);
    }

    _providerParams() {
        return this.hostService.providerParams();
    }

    async _ensureResponsesAdapter(settings = this.getSettings() || {}) {
        return this.hostService.ensureResponsesAdapter(settings);
    }

    // The ToolBox endpoint/key are Main-only configuration.  A settings
    // change is not a harmless display refresh: every pending approval and
    // dynamic invocation belongs to the old authority and must fail closed
    // before a new bridge process is allowed to connect.
    async refreshToolboxConfiguration(settings = this.getSettings() || {}) {
        return this.hostService.refreshToolboxConfiguration(settings);
    }

    async _drainToolboxConfiguration() {
        return this.hostService.drainToolboxConfiguration();
    }

    async _applyToolboxConfiguration(settings, nextFingerprint) {
        return this.hostService.applyToolboxConfiguration(settings, nextFingerprint);
    }

    _wireTransport() {
        return this.hostService.wireTransport();
    }

    _observeCompactionNotification(message) {
        return this.hostService.observeCompactionNotification(message);
    }

    _rejectCompactionWaiters(error) {
        return this.hostService.rejectCompactionWaiters(error);
    }

    async _ensureBridge(settings = this.getSettings() || {}) {
        return this.hostService.ensureBridge(settings);
    }

    async _handleTransportCrash(error) {
        return this.hostService.handleTransportCrash(error);
    }

    async _failClosedNativeApprovals(reason, options = {}) {
        return this.interactionService.failClosedNativeApprovals(reason, options);
    }

    _failClosedServerRequest(message, reason) {
        return this.interactionService.failClosedServerRequest(message, reason);
    }

    async _interruptDynamicCalls(reason) {
        return this.toolboxService.interruptDynamicCalls(reason);
    }

    async _resumeSession(session) {
        return this.turnService.resumeSession(session);
    }

    async _handleDynamicToolCall(message) {
        return this.toolboxService.handleDynamicToolCall(message);
    }

    _updateThreadState(message, session) {
        return this.eventService.updateThreadState(message, session);
    }

    async _drainFollowUpQueue(session) {
        return this.turnService.drainFollowUpQueue(session);
    }

    async _recoverPendingInputsForSession(session) {
        return this.turnService.recoverPendingInputsForSession(session);
    }

    _handleBridgeEvent(message) {
        return this.toolboxService.handleBridgeEvent(message);
    }

    async _failClosedToolboxApprovals(reason) {
        return this.interactionService.failClosedToolboxApprovals(reason);
    }

    _sendUiEvent(event) {
        return this.eventService.sendUiEvent(event);
    }
}

module.exports = { CodexRuntimeManager, vcpInvokeTool };
