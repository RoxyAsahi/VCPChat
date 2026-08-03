'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { RuntimeLifecycleService } = require('./runtime-lifecycle-service');
const { CodexAppServerTransport, CodexAppServerError } = require('./appServerTransport');
const { AgentProjectionRepository, CodexProjectionProjector } = require('./projection');
const { ToolboxBridgeTransport } = require('./toolboxBridgeTransport');
const { ToolboxResponsesAdapter } = require('./toolboxResponsesAdapter');
const { AttachmentRegistry } = require('./attachmentRegistry');
const { RuntimeInteractionService } = require('./runtime-interaction-service');
const { RuntimeToolboxService } = require('./runtime-toolbox-service');
const { RuntimeRecoveryService } = require('./runtime-recovery-service');
const { RuntimeSessionService } = require('./runtime-session-service');
const { RuntimeTurnService } = require('./runtime-turn-service');
const { RuntimeConfigService } = require('./runtime-config-service');
const { RuntimeProfileService } = require('./runtime-profile-service');
const { RuntimeHostService } = require('./runtime-host-service');
const {
    instructionConfigChanged,
    requiresFreshCodexManagedSession,
    threadSettingsPatch,
} = require('./runtimeConfig');
const {
    capabilityMatrix,
} = require('./protocolCapabilities');
const {
    approvalProjection,
    buildTurnInput,
    compatibilityRuntime,
    compatibilitySession,
    hasDurableProjection,
    isConfirmedThreadNotFound,
    isUncertainRemoteMutation,
    normalizeInstructionMode,
    normalizePersonality,
    pendingInputProjection,
    resolveSessionIdInput,
    sanitizeInteractionPayload,
    serializeError,
    sessionConfigResult,
    submissionDedupeKey,
    vcpInvokeTool,
} = require('./runtime-normalizers');

function id(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

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
        this.interactionService = new RuntimeInteractionService({
            repository: () => this.repository,
            transport: () => this.transport,
            bridge: () => this.bridge,
            runtimeGeneration: () => this.runtimeGeneration,
            workbenchMounted: () => this.workbenchMounted,
            profileForRequest: (request) => this._profileForRequest(request),
            sendUiEvent: (event) => this._sendUiEvent(event),
            diagnostic: (message) => this.emit('diagnostic', message),
        });
        // Compatibility aliases for existing diagnostics/tests. State
        // ownership belongs to RuntimeInteractionService.
        this.serverRequests = this.interactionService.serverRequests;
        this.interactions = this.interactionService.interactions;
        this.interactionTimers = this.interactionService.interactionTimers;
        this.toolboxApprovals = this.interactionService.toolboxApprovals;
        this.toolboxService = new RuntimeToolboxService({
            transport: () => this.transport,
            bridge: () => this.bridge,
            runtimeGeneration: () => this.runtimeGeneration,
            toolboxAuthorityGeneration: () => this.toolboxAuthorityGeneration,
            interactions: this.interactionService,
            sendUiEvent: (event) => this._sendUiEvent(event),
            diagnostic: (message) => this.emit('diagnostic', message),
        });
        this.dynamicCalls = this.toolboxService.dynamicCalls;
        this.recoveryService = new RuntimeRecoveryService({
            ensureProjectionStore: () => this.ensureProjectionStore(),
            assertProjectionWritable: () => this._assertProjectionWritable(),
            repository: () => this.repository,
            transport: () => this.transport,
            projector: () => this.projector,
            threadStates: () => this.threadStates,
            start: () => this.start(),
            captureGeneration: () => this._captureGeneration(),
            assertGeneration: (generation) => this._assertGeneration(generation),
            recoveryPromise: () => this.knownOperationRecoveryPromise,
            setRecoveryPromise: (promise) => { this.knownOperationRecoveryPromise = promise; },
            setLastError: (error) => { this.lastError = error; },
            diagnostic: (name, fields) => this._diagnostic(name, fields),
        });
        this.sessionService = new RuntimeSessionService({
            ensureProjectionStore: () => this.ensureProjectionStore(),
            assertProjectionWritable: () => this._assertProjectionWritable(),
            repository: () => this.repository,
            transport: () => this.transport,
            projector: () => this.projector,
            start: () => this.start(),
            captureGeneration: () => this._captureGeneration(),
            assertGeneration: (generation) => this._assertGeneration(generation),
            repairSessionConfig: (session) => this._repairSessionConfig(session),
            repairSessionIdentity: (session) => this._repairSessionIdentity(session),
            resolveCanonicalAgent: (agentId, options) => this._resolveCanonicalAgent(agentId, options),
            configSnapshot: (options) => this._configSnapshot(options),
            createId: (prefix) => id(prefix),
            projectRoot: () => this.projectRoot,
            diagnosticClock: () => this.diagnosticClock(),
            diagnostic: (name, fields) => this._diagnostic(name, fields),
            attachments: () => this.attachments,
            faultInjection: () => this.faultInjection,
            assertLifecycleIdle: (session) => this._assertLifecycleIdle(session),
            toolboxApprovalCount: () => this.toolboxApprovals.size,
        });
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
        this.turnService = new RuntimeTurnService({
            ensureProjectionStore: () => this.ensureProjectionStore(),
            assertProjectionWritable: () => this._assertProjectionWritable(),
            repository: () => this.repository,
            transport: () => this.transport,
            bridge: () => this.bridge,
            responsesAdapter: () => this.responsesAdapter,
            attachments: () => this.attachments,
            dynamicCalls: () => this.dynamicCalls,
            start: () => this.start(),
            captureGeneration: () => this._captureGeneration(),
            assertGeneration: (generation) => this._assertGeneration(generation),
            repairSessionConfig: (session) => this._repairSessionConfig(session),
            repairSessionIdentity: (session) => this._repairSessionIdentity(session),
            configSnapshot: (options) => this._configSnapshot(options),
            runtimePolicyParams: (config, options) => this._runtimePolicyParams(config, options),
            threadInstructionParams: (config) => this._threadInstructionParams(config),
            effectiveReasoningEffort: (config) => this._effectiveReasoningEffort(config),
            applySessionRuntimeConfig: (sessionId, options) => this._applySessionRuntimeConfig(sessionId, options),
            sendSessionConfigEvent: (type, session, error) => this._sendSessionConfigEvent(type, session, error),
            sendUiEvent: (event) => this._sendUiEvent(event),
            readSession: (options) => this.readTopic(options),
            scheduleSessionConfigApply: (sessionId) => this._scheduleSessionConfigApply(sessionId),
            rememberIdleWarmSession: (sessionId) => this._rememberIdleWarmSession(sessionId),
            assertLifecycleIdle: (session) => this._assertLifecycleIdle(session),
            createId: (prefix) => id(prefix),
            diagnosticClock: () => this.diagnosticClock(),
            diagnostic: (name, fields) => this._diagnostic(name, fields),
            faultInjection: () => this.faultInjection,
            sessionWarmPromises: () => this.sessionWarmPromises,
            turnStartPromises: () => this.turnStartPromises,
            followUpDrainPromises: () => this.followUpDrainPromises,
            compactionWaiters: () => this.compactionWaiters,
            resumedThreadIds: () => this.resumedThreadIds,
            resumingThreads: () => this.resumingThreads,
            threadStates: () => this.threadStates,
            configApplyTargets: () => this.configApplyTargets,
            idleWarmSessions: () => this.idleWarmSessions,
            startTurnOverride: () => this._startTurn,
            defaultStartTurnMethod: () => this._defaultStartTurnMethod,
        });
        this.configService = new RuntimeConfigService({
            ensureProjectionStore: () => this.ensureProjectionStore(),
            assertProjectionWritable: () => this._assertProjectionWritable(),
            repository: () => this.repository,
            transport: () => this.transport,
            start: () => this.start(),
            captureGeneration: () => this._captureGeneration(),
            assertGeneration: (generation) => this._assertGeneration(generation),
            resumeSession: (session) => this._resumeSession(session),
            createSession: (options) => this.createTopic(options),
            getSettings: () => this.getSettings() || {},
            setSettings: () => this.setSettings,
            projectRoot: () => this.projectRoot,
            getModels: () => this.getModels?.() || [],
            validateReasoningEffort: (model, effort, options) => this._validateReasoningEffort(model, effort, options),
            reasoningEffortsForModel: (model) => this._reasoningEffortsForModel(model),
            sendUiEvent: (event) => this._sendUiEvent(event),
            setLastError: (error) => { this.lastError = error; },
            configApplyPromises: () => this.configApplyPromises,
            configApplyTargets: () => this.configApplyTargets,
            resumedThreadIds: () => this.resumedThreadIds,
            threadStates: () => this.threadStates,
            runtimeGeneration: () => this.runtimeGeneration,
        });
        this.profileService = new RuntimeProfileService({
            ensureProjectionStore: () => this.ensureProjectionStore(),
            assertProjectionWritable: () => this._assertProjectionWritable(),
            repository: () => this.repository,
            agentsDir: () => this.agentsDir,
            getSettings: () => this.getSettings() || {},
            getModels: () => this.getModels?.() || [],
            createSession: (options) => this.createTopic(options),
        });
        this.hostService = new RuntimeHostService({
            assertProjectionWritable: () => this._assertProjectionWritable(),
            ensureProjectionStore: () => this.ensureProjectionStore(),
            repository: () => this.repository,
            projector: () => this.projector,
            transport: () => this.transport,
            setTransport: (value) => { this.transport = value; },
            bridge: () => this.bridge,
            setBridge: (value) => { this.bridge = value; },
            responsesAdapter: () => this.responsesAdapter,
            setResponsesAdapter: (value) => { this.responsesAdapter = value; },
            transportFactory: () => this.transportFactory,
            bridgeFactory: () => this.bridgeFactory,
            responsesAdapterFactory: () => this.responsesAdapterFactory,
            getSettings: () => this.getSettings() || {},
            getStatus: () => this.getStatus(),
            projectRoot: () => this.projectRoot,
            state: () => this.state,
            setState: (value) => { this.state = value; },
            lastError: () => this.lastError,
            setLastError: (value) => { this.lastError = value; },
            intentionalStop: () => this.intentionalStop,
            setIntentionalStop: (value) => { this.intentionalStop = value; },
            startPromise: () => this.startPromise,
            setStartPromise: (value) => { this.startPromise = value; },
            runtimeRetryAfter: () => this.runtimeRetryAfter,
            setRuntimeRetryAfter: (value) => { this.runtimeRetryAfter = value; },
            runtimeStartFailures: () => this.runtimeStartFailures,
            setRuntimeStartFailures: (value) => { this.runtimeStartFailures = value; },
            diagnosticClock: () => this.diagnosticClock(),
            diagnostic: (name, fields) => this._diagnostic(name, fields),
            emitDiagnostic: (message) => this.emit('diagnostic', message),
            beginGeneration: () => {
                this.generationScope = this.lifecycle.begin('Runtime superseded by a new generation');
                this.runtimeGeneration = this.lifecycle.value;
                this.interactions.setGeneration('codex-native', this.runtimeGeneration);
            },
            closeGeneration: (reason) => this.lifecycle.close(reason),
            invalidateGeneration: (reason) => {
                this.lifecycle.invalidate(reason);
                this.runtimeGeneration = this.lifecycle.value;
                this.generationScope = this.lifecycle.capture();
            },
            captureGeneration: () => this._captureGeneration(),
            assertGeneration: (generation) => this._assertGeneration(generation),
            runtimeGeneration: () => this.runtimeGeneration,
            normalizeUnboundThreadOperations: () => this._normalizeUnboundThreadOperations(),
            recoverKnownThreadOperations: () => this._recoverKnownThreadOperations(),
            clearScheduledConfigApplies: () => this.configService?.clearScheduledApplies(),
            failClosedNativeApprovals: (reason, options) => this._failClosedNativeApprovals(reason, options),
            interruptDynamicCalls: (reason) => this._interruptDynamicCalls(reason),
            failClosedToolboxApprovals: (reason) => this._failClosedToolboxApprovals(reason),
            clearInteractions: (source) => this.interactions.clear({ source }),
            clearInteractionTimers: () => this.interactionService.clearTimers(),
            advanceToolboxAuthorityGeneration: () => {
                this.toolboxAuthorityGeneration += 1;
                this.interactions.setGeneration('toolbox', this.toolboxAuthorityGeneration);
            },
            acceptServerRequest: (message) => this.interactionService.acceptServerRequest(message),
            handleDynamicToolCall: (message) => this._handleDynamicToolCall(message),
            handleBridgeEvent: (message) => this._handleBridgeEvent(message),
            sendUiEvent: (event) => this._sendUiEvent(event),
            sendSessionConfigEvent: (type, session) => this._sendSessionConfigEvent(type, session),
            updateThreadState: (message, session) => this._updateThreadState(message, session),
            sendEvent: (event) => { this.sendEvent(event); this.emit('event', event); },
            readSession: (options) => this.readTopic(options),
            threadStates: () => this.threadStates,
            compactionWaiters: () => this.compactionWaiters,
            configApplyTargets: () => this.configApplyTargets,
            setKnownOperationRecoveryPromise: (value) => { this.knownOperationRecoveryPromise = value; },
            clearCrashRegistries: () => {
                this.threadStates.clear();
                this.resumedThreadIds.clear();
                this.resumingThreads.clear();
                this.configApplyPromises.clear();
                this.configApplyTargets.clear();
            },
            clearHostResources: () => this._clearHostResources(),
        });
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
        this.ensureProjectionStore();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        return { items: this.repository.listPendingInputs(idValue).map(pendingInputProjection) };
    }

    async replaceInteractionQueue({ sessionId, topicId, interactions = [] } = {}) {
        this._assertProjectionWritable();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const requested = new Map((Array.isArray(interactions) ? interactions : []).map((item) => [
            String(item?.inputId || item?.interactionId || ''), item,
        ]).filter(([inputId]) => inputId));
        for (const current of this.repository.listPendingInputs(idValue)) {
            const next = requested.get(current.inputId);
            if (current.state !== 'queued') continue;
            if (!next) {
                this.repository.removePendingInput(current.inputId);
                continue;
            }
            const prompt = String(next.prompt || next.text || '').trim();
            if (!prompt) throw new CodexAppServerError('INVALID_INPUT', 'Queued follow-up message must not be empty');
            if (prompt !== current.prompt) {
                this.repository.updatePendingInput(current.inputId, {
                    prompt,
                    dedupeKey: submissionDedupeKey(prompt, []),
                });
            }
        }
        return this.listInteractionQueue({ sessionId: idValue });
    }

    async clearInteractionQueue({ sessionId, topicId } = {}) {
        this._assertProjectionWritable();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        for (const current of this.repository.listPendingInputs(idValue)) {
            if (['queued', 'failed'].includes(current.state)) this.repository.removePendingInput(current.inputId);
        }
        return this.listInteractionQueue({ sessionId: idValue });
    }

    async resolvePendingInput({ sessionId, topicId, inputId, action } = {}) {
        this._assertProjectionWritable();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        const targetId = String(inputId || '').trim();
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const pending = this.repository.listPendingInputs(idValue).find((entry) => entry.inputId === targetId);
        if (!pending) throw new CodexAppServerError('NOT_FOUND', 'Pending input was not found');
        if (action === 'discard') {
            if (!['queued', 'failed', 'uncertain'].includes(pending.state)) {
                throw new CodexAppServerError('PENDING_INPUT_BUSY', 'Dispatching or accepted input cannot be discarded');
            }
            this.repository.removePendingInput(targetId);
            return { resolved: true, action, items: this.repository.listPendingInputs(idValue).map(pendingInputProjection) };
        }
        if (action !== 'resend' || !['failed', 'uncertain'].includes(pending.state)) {
            throw new CodexAppServerError('INVALID_PENDING_INPUT_ACTION', 'Only failed or uncertain input can be explicitly resent');
        }
        const retried = this.repository.retryPendingInput(targetId);
        const runtimeSession = await this.ensureSessionRuntime({ sessionId: idValue, reason: 'explicit-input-resend' });
        const state = this.threadStates.get(runtimeSession.threadId);
        if (state?.activity !== 'running') await this._drainFollowUpQueue(runtimeSession);
        return {
            resolved: true,
            action,
            input: retried ? pendingInputProjection(retried) : null,
            items: this.repository.listPendingInputs(idValue).map(pendingInputProjection),
        };
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
        if (this.maxIdleWarmSessions <= 0) return;
        this.idleWarmSessions.delete(sessionId);
        this.idleWarmSessions.set(sessionId, Date.now());
        while (this.idleWarmSessions.size > this.maxIdleWarmSessions) {
            const oldest = this.idleWarmSessions.keys().next().value;
            this.idleWarmSessions.delete(oldest);
            const evicted = this.repository?.getSession(oldest);
            if (evicted?.threadId) this.resumedThreadIds.delete(evicted.threadId);
        }
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
        const provider = this._providerParams();
        if (config.executionProfile !== 'toolbox-only') return provider;
        const policyConfig = {
            ...(provider.config || {}),
            // ToolBox-backed Threads use the VChat Agent prompt as their only
            // instruction source. Native Codex permission, capability, skill,
            // project-doc and environment context is unnecessary because the
            // model can only call the allowlisted vcp_invoke dynamic tool.
            include_permissions_instructions: false,
            include_apps_instructions: false,
            include_collaboration_mode_instructions: false,
            include_environment_context: false,
            project_doc_max_bytes: 0,
            'skills.include_instructions': false,
            model_reasoning_summary: 'detailed',
            web_search: 'disabled',
            mcp_servers: {},
            'tools.update_plan.enabled': false,
            'tools.experimental_request_user_input.enabled': false,
            'features.shell_tool': false,
            'features.deferred_executor': false,
            'features.request_permissions_tool': false,
            'features.standalone_web_search': false,
            'features.memory_tool': false,
            'features.collab': false,
            'features.multi_agent_v2': false,
            'features.apps': false,
            'features.enable_mcp_apps': false,
            'features.tool_suggest': false,
            'features.plugins': false,
            'features.token_budget': false,
            'features.current_time_reminder': false,
        };
        return {
            ...provider,
            config: policyConfig,
            ...(starting ? { environments: [] } : {}),
        };
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
        if (config.executionProfile && config.executionProfile !== 'toolbox-only') {
            return {
                ...(String(config.baseInstructions || '').trim()
                    ? { baseInstructions: String(config.baseInstructions).trim() } : {}),
                ...(String(config.developerInstructions || '').trim()
                    ? { developerInstructions: String(config.developerInstructions).trim() } : {}),
                ...(normalizePersonality(config.personality) !== 'none'
                    ? { personality: normalizePersonality(config.personality) } : {}),
            };
        }
        const mode = normalizeInstructionMode(config.instructionMode, config.baseInstructions);
        if (mode === 'codex-managed') {
            const personality = normalizePersonality(config.personality);
            return {
                ...(personality !== 'none' ? { personality } : {}),
                ...(String(config.developerInstructions || '').trim()
                    ? { developerInstructions: String(config.developerInstructions).trim() } : {}),
            };
        }
        const baseInstructions = String(config.baseInstructions || '').trim();
        if (!baseInstructions) {
            throw new CodexAppServerError('AGENT_IDENTITY_MISSING', 'VChat identity mode requires baseInstructions');
        }
        return { baseInstructions };
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
        if (!session?.threadId) return;
        // A preceding notification handler (notably thread/settings/updated)
        // may already have advanced desired/applied config revisions. Never
        // persist the stale Session object captured before that mutation.
        const durableSession = this.repository.getSession(session.sessionId) || session;
        const previous = this.threadStates.get(session.threadId) || { activity: 'idle', activeTurnId: null };
        let next = previous;
        if (message.method === 'turn/started') {
            next = { activity: 'running', activeTurnId: message.params?.turn?.id || null };
        } else if (message.method === 'turn/completed') {
            next = { activity: 'idle', activeTurnId: null };
        } else if (message.method === 'thread/status/changed') {
            const active = message.params?.status?.type === 'active';
            next = { ...previous, activity: active ? 'running' : 'idle', activeTurnId: active ? previous.activeTurnId : null };
        }
        this.threadStates.set(session.threadId, next);
        this.repository.saveSession({ ...durableSession, state: next.activity, updatedAt: Date.now() });
        if (next.activity === 'idle') this._rememberIdleWarmSession(durableSession.sessionId);
        else this.idleWarmSessions.delete(durableSession.sessionId);
        if (message.method === 'turn/completed' && next.activity === 'idle') {
            const latest = this.repository.getSession(durableSession.sessionId);
            if (latest && latest.appliedRuntimeConfigRevision !== latest.configRevision) {
                this._scheduleSessionConfigApply(latest.sessionId);
            }
            void this._drainFollowUpQueue(latest || durableSession);
        }
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
        if (event.sessionId && this.repository) {
            if (event.type === 'context.usage') {
                this.repository.updateActivity(event.sessionId, { usage: sanitizeInteractionPayload(event.payload || {}) });
            } else if (event.type === 'compaction.started') {
                this.repository.updateActivity(event.sessionId, { compaction: { state: 'started', summary: '', error: '' } });
            } else if (event.type === 'compaction.completed') {
                this.repository.updateActivity(event.sessionId, { compaction: {
                    state: 'completed', summary: String(event.payload?.summary || '').slice(0, 2_000), error: '',
                } });
            } else if (event.type === 'compaction.failed') {
                this.repository.updateActivity(event.sessionId, { compaction: {
                    state: 'failed', summary: '', error: String(event.payload?.error || 'Context compaction failed').slice(0, 2_000),
                } });
            }
        }
        this.uiEventSequence += 1;
        const envelope = {
            runtime: 'codex',
            eventId: event.eventId || `codex-ui:${this.uiEventSequence}:${crypto.randomUUID()}`,
            sequence: this.uiEventSequence,
            timestamp: Date.now(),
            ...event,
        };
        this.sendEvent(envelope);
        this.emit('event', envelope);
    }
}

module.exports = { CodexRuntimeManager, vcpInvokeTool };
