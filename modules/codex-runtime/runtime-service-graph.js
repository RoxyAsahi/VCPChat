'use strict';

const crypto = require('crypto');
const { RuntimeInteractionService } = require('./runtime-interaction-service');
const { RuntimeToolboxService } = require('./runtime-toolbox-service');
const { RuntimeRecoveryService } = require('./runtime-recovery-service');
const { RuntimeSessionService } = require('./runtime-session-service');
const { RuntimeTurnService } = require('./runtime-turn-service');
const { RuntimeConfigService } = require('./runtime-config-service');
const { RuntimeProfileService } = require('./runtime-profile-service');
const { RuntimeHostService } = require('./runtime-host-service');
const { RuntimePolicyService } = require('./runtime-policy-service');
const { RuntimeEventService } = require('./runtime-event-service');
const { createRuntimeServiceContext } = require('./runtime-service-contexts');

function createId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function attachRuntimeServiceGraph(runtime) {
    runtime.policyService = new RuntimePolicyService(createRuntimeServiceContext('policy', {
        providerParams: () => runtime._providerParams(),
    }));
    runtime.eventService = new RuntimeEventService(createRuntimeServiceContext('event', {
        repository: () => runtime.repository,
        threadStates: () => runtime.threadStates,
        idleWarmSessions: () => runtime.idleWarmSessions,
        resumedThreadIds: () => runtime.resumedThreadIds,
        maxIdleWarmSessions: () => runtime.maxIdleWarmSessions,
        scheduleSessionConfigApply: (sessionId) => runtime._scheduleSessionConfigApply(sessionId),
        drainFollowUpQueue: (session) => runtime._drainFollowUpQueue(session),
        sendEvent: (event) => { runtime.sendEvent(event); runtime.emit('event', event); },
    }));
    runtime.interactionService = new RuntimeInteractionService(createRuntimeServiceContext('interaction', {
        repository: () => runtime.repository,
        transport: () => runtime.transport,
        bridge: () => runtime.bridge,
        runtimeGeneration: () => runtime.runtimeGeneration,
        createOperationContext: (identity) => runtime._createOperationContext(identity),
        assertOperationContext: (operation) => runtime._assertOperationContext(operation),
        workbenchMounted: () => runtime.workbenchMounted,
        setWorkbenchMounted: (value) => { runtime.workbenchMounted = value; },
        profileForRequest: (request) => runtime._profileForRequest(request),
        sendUiEvent: (event) => runtime._sendUiEvent(event),
        diagnostic: (message) => runtime.emit('diagnostic', message),
        ensureProjectionStore: () => runtime.ensureProjectionStore(),
        assertProjectionWritable: () => runtime._assertProjectionWritable(),
        ensureSessionRuntime: (options) => runtime.ensureSessionRuntime(options),
        threadStates: () => runtime.threadStates,
        drainFollowUpQueue: (session) => runtime._drainFollowUpQueue(session),
    }));
    runtime.serverRequests = runtime.interactionService.serverRequests;
    runtime.interactions = runtime.interactionService.interactions;
    runtime.interactionTimers = runtime.interactionService.interactionTimers;
    runtime.toolboxApprovals = runtime.interactionService.toolboxApprovals;

    runtime.toolboxService = new RuntimeToolboxService(createRuntimeServiceContext('toolbox', {
        transport: () => runtime.transport,
        bridge: () => runtime.bridge,
        runtimeGeneration: () => runtime.runtimeGeneration,
        createOperationContext: (identity) => runtime._createOperationContext(identity),
        assertOperationContext: (operation) => runtime._assertOperationContext(operation),
        toolboxAuthorityGeneration: () => runtime.toolboxAuthorityGeneration,
        interactions: runtime.interactionService,
        sendUiEvent: (event) => runtime._sendUiEvent(event),
        diagnostic: (message) => runtime.emit('diagnostic', message),
    }));
    runtime.dynamicCalls = runtime.toolboxService.dynamicCalls;

    runtime.recoveryService = new RuntimeRecoveryService(createRuntimeServiceContext('recovery', {
        ensureProjectionStore: () => runtime.ensureProjectionStore(),
        assertProjectionWritable: () => runtime._assertProjectionWritable(),
        repository: () => runtime.repository,
        transport: () => runtime.transport,
        projector: () => runtime.projector,
        threadStates: () => runtime.threadStates,
        start: () => runtime.start(),
        captureGeneration: () => runtime._captureGeneration(),
        assertGeneration: (generation) => runtime._assertGeneration(generation),
        createOperationContext: (identity) => runtime._createOperationContext(identity),
        assertOperationContext: (operation) => runtime._assertOperationContext(operation),
        recoveryPromise: () => runtime.knownOperationRecoveryPromise,
        setRecoveryPromise: (promise) => { runtime.knownOperationRecoveryPromise = promise; },
        setLastError: (error) => { runtime.lastError = error; },
        diagnostic: (name, fields) => runtime._diagnostic(name, fields),
    }));

    runtime.sessionService = new RuntimeSessionService(createRuntimeServiceContext('session', {
        ensureProjectionStore: () => runtime.ensureProjectionStore(),
        assertProjectionWritable: () => runtime._assertProjectionWritable(),
        repository: () => runtime.repository,
        transport: () => runtime.transport,
        projector: () => runtime.projector,
        start: () => runtime.start(),
        captureGeneration: () => runtime._captureGeneration(),
        assertGeneration: (generation) => runtime._assertGeneration(generation),
        createOperationContext: (identity) => runtime._createOperationContext(identity),
        assertOperationContext: (operation) => runtime._assertOperationContext(operation),
        repairSessionConfig: (session) => runtime._repairSessionConfig(session),
        repairSessionIdentity: (session) => runtime._repairSessionIdentity(session),
        resolveCanonicalAgent: (agentId, options) => runtime._resolveCanonicalAgent(agentId, options),
        configSnapshot: (options) => runtime._configSnapshot(options),
        createId,
        projectRoot: () => runtime.projectRoot,
        diagnosticClock: () => runtime.diagnosticClock(),
        diagnostic: (name, fields) => runtime._diagnostic(name, fields),
        attachments: () => runtime.attachments,
        statFile: (filePath) => require('fs').statSync(filePath),
        faultInjection: () => runtime.faultInjection,
        assertLifecycleIdle: (session) => runtime._assertLifecycleIdle(session),
        toolboxApprovalCount: () => runtime.toolboxApprovals.size,
    }));

    runtime.turnService = new RuntimeTurnService(createRuntimeServiceContext('turn', {
        ensureProjectionStore: () => runtime.ensureProjectionStore(),
        assertProjectionWritable: () => runtime._assertProjectionWritable(),
        repository: () => runtime.repository,
        transport: () => runtime.transport,
        bridge: () => runtime.bridge,
        responsesAdapter: () => runtime.responsesAdapter,
        attachments: () => runtime.attachments,
        dynamicCalls: () => runtime.dynamicCalls,
        start: () => runtime.start(),
        captureGeneration: () => runtime._captureGeneration(),
        assertGeneration: (generation) => runtime._assertGeneration(generation),
        createOperationContext: (identity) => runtime._createOperationContext(identity),
        assertOperationContext: (operation) => runtime._assertOperationContext(operation),
        repairSessionConfig: (session) => runtime._repairSessionConfig(session),
        repairSessionIdentity: (session) => runtime._repairSessionIdentity(session),
        configSnapshot: (options) => runtime._configSnapshot(options),
        runtimePolicyParams: (config, options) => runtime._runtimePolicyParams(config, options),
        threadInstructionParams: (config) => runtime._threadInstructionParams(config),
        effectiveReasoningEffort: (config) => runtime._effectiveReasoningEffort(config),
        applySessionRuntimeConfig: (sessionId, options) => runtime._applySessionRuntimeConfig(sessionId, options),
        sendSessionConfigEvent: (type, session, error) => runtime._sendSessionConfigEvent(type, session, error),
        sendUiEvent: (event) => runtime._sendUiEvent(event),
        readSession: (options) => runtime.readSession(options),
        scheduleSessionConfigApply: (sessionId) => runtime._scheduleSessionConfigApply(sessionId),
        rememberIdleWarmSession: (sessionId) => runtime._rememberIdleWarmSession(sessionId),
        assertLifecycleIdle: (session) => runtime._assertLifecycleIdle(session),
        createId,
        diagnosticClock: () => runtime.diagnosticClock(),
        diagnostic: (name, fields) => runtime._diagnostic(name, fields),
        faultInjection: () => runtime.faultInjection,
        sessionWarmPromises: () => runtime.sessionWarmPromises,
        turnStartPromises: () => runtime.turnStartPromises,
        followUpDrainPromises: () => runtime.followUpDrainPromises,
        compactionWaiters: () => runtime.compactionWaiters,
        resumedThreadIds: () => runtime.resumedThreadIds,
        resumingThreads: () => runtime.resumingThreads,
        threadStates: () => runtime.threadStates,
        configApplyTargets: () => runtime.configApplyTargets,
        idleWarmSessions: () => runtime.idleWarmSessions,
        startTurnOverride: () => runtime._startTurn,
        defaultStartTurnMethod: () => runtime._defaultStartTurnMethod,
    }));

    runtime.configService = new RuntimeConfigService(createRuntimeServiceContext('config', {
        ensureProjectionStore: () => runtime.ensureProjectionStore(),
        assertProjectionWritable: () => runtime._assertProjectionWritable(),
        repository: () => runtime.repository,
        transport: () => runtime.transport,
        start: () => runtime.start(),
        captureGeneration: () => runtime._captureGeneration(),
        assertGeneration: (generation) => runtime._assertGeneration(generation),
        createOperationContext: (identity) => runtime._createOperationContext(identity),
        assertOperationContext: (operation) => runtime._assertOperationContext(operation),
        resumeSession: (session) => runtime._resumeSession(session),
        createSession: (options) => runtime.createSessionRecord(options),
        getSettings: () => runtime.getSettings() || {},
        setSettings: () => runtime.setSettings,
        projectRoot: () => runtime.projectRoot,
        getModels: () => runtime.getModels?.() || [],
        validateReasoningEffort: (model, effort, options) => runtime._validateReasoningEffort(model, effort, options),
        reasoningEffortsForModel: (model) => runtime._reasoningEffortsForModel(model),
        sendUiEvent: (event) => runtime._sendUiEvent(event),
        setLastError: (error) => { runtime.lastError = error; },
        configApplyPromises: () => runtime.configApplyPromises,
        configApplyTargets: () => runtime.configApplyTargets,
        resumedThreadIds: () => runtime.resumedThreadIds,
        threadStates: () => runtime.threadStates,
        runtimeGeneration: () => runtime.runtimeGeneration,
    }));

    runtime.profileService = new RuntimeProfileService(createRuntimeServiceContext('profile', {
        ensureProjectionStore: () => runtime.ensureProjectionStore(),
        assertProjectionWritable: () => runtime._assertProjectionWritable(),
        repository: () => runtime.repository,
        agentsDir: () => runtime.agentsDir,
        getSettings: () => runtime.getSettings() || {},
        getModels: () => runtime.getModels?.() || [],
        createSession: (options) => runtime.createSessionRecord(options),
    }));

    runtime.hostService = new RuntimeHostService(createRuntimeServiceContext('host', {
        assertProjectionWritable: () => runtime._assertProjectionWritable(),
        ensureProjectionStore: () => runtime.ensureProjectionStore(),
        repository: () => runtime.repository,
        projector: () => runtime.projector,
        transport: () => runtime.transport,
        setTransport: (value) => { runtime.transport = value; },
        bridge: () => runtime.bridge,
        setBridge: (value) => { runtime.bridge = value; },
        responsesAdapter: () => runtime.responsesAdapter,
        setResponsesAdapter: (value) => { runtime.responsesAdapter = value; },
        transportFactory: () => runtime.transportFactory,
        bridgeFactory: () => runtime.bridgeFactory,
        responsesAdapterFactory: () => runtime.responsesAdapterFactory,
        getSettings: () => runtime.getSettings() || {},
        getStatus: () => runtime.getStatus(),
        projectRoot: () => runtime.projectRoot,
        state: () => runtime.state,
        setState: (value) => { runtime.state = value; },
        setLastError: (value) => { runtime.lastError = value; },
        intentionalStop: () => runtime.intentionalStop,
        setIntentionalStop: (value) => { runtime.intentionalStop = value; },
        startPromise: () => runtime.startPromise,
        setStartPromise: (value) => { runtime.startPromise = value; },
        runtimeRetryAfter: () => runtime.runtimeRetryAfter,
        setRuntimeRetryAfter: (value) => { runtime.runtimeRetryAfter = value; },
        runtimeStartFailures: () => runtime.runtimeStartFailures,
        setRuntimeStartFailures: (value) => { runtime.runtimeStartFailures = value; },
        diagnosticClock: () => runtime.diagnosticClock(),
        diagnostic: (name, fields) => runtime._diagnostic(name, fields),
        emitDiagnostic: (message) => runtime.emit('diagnostic', message),
        beginGeneration: () => {
            runtime.generationScope = runtime.lifecycle.begin('Runtime superseded by a new generation');
            runtime.runtimeGeneration = runtime.lifecycle.value;
            runtime.interactions.setGeneration('codex-native', runtime.runtimeGeneration);
        },
        closeGeneration: (reason) => runtime.lifecycle.close(reason),
        invalidateGeneration: (reason) => {
            runtime.lifecycle.invalidate(reason);
            runtime.runtimeGeneration = runtime.lifecycle.value;
            runtime.generationScope = runtime.lifecycle.capture();
        },
        captureGeneration: () => runtime._captureGeneration(),
        assertGeneration: (generation) => runtime._assertGeneration(generation),
        createOperationContext: (identity) => runtime._createOperationContext(identity),
        assertOperationContext: (operation) => runtime._assertOperationContext(operation),
        runtimeGeneration: () => runtime.runtimeGeneration,
        normalizeUnboundThreadOperations: () => runtime._normalizeUnboundThreadOperations(),
        recoverKnownThreadOperations: () => runtime._recoverKnownThreadOperations(),
        clearScheduledConfigApplies: () => runtime.configService?.clearScheduledApplies(),
        failClosedNativeApprovals: (reason, options) => runtime._failClosedNativeApprovals(reason, options),
        interruptDynamicCalls: (reason) => runtime._interruptDynamicCalls(reason),
        failClosedToolboxApprovals: (reason) => runtime._failClosedToolboxApprovals(reason),
        clearInteractions: (source) => runtime.interactions.clear({ source }),
        clearInteractionTimers: () => runtime.interactionService.clearTimers(),
        advanceToolboxAuthorityGeneration: () => {
            runtime.toolboxAuthorityGeneration += 1;
            runtime.interactions.setGeneration('toolbox', runtime.toolboxAuthorityGeneration);
        },
        acceptServerRequest: (message) => runtime.interactionService.acceptServerRequest(message),
        handleDynamicToolCall: (message) => runtime._handleDynamicToolCall(message),
        handleBridgeEvent: (message) => runtime._handleBridgeEvent(message),
        sendUiEvent: (event) => runtime._sendUiEvent(event),
        sendSessionConfigEvent: (type, session) => runtime._sendSessionConfigEvent(type, session),
        updateThreadState: (message, session) => runtime._updateThreadState(message, session),
        sendEvent: (event) => { runtime.sendEvent(event); runtime.emit('event', event); },
        readSession: (options) => runtime.readSession(options),
        threadStates: () => runtime.threadStates,
        compactionWaiters: () => runtime.compactionWaiters,
        configApplyTargets: () => runtime.configApplyTargets,
        setKnownOperationRecoveryPromise: (value) => { runtime.knownOperationRecoveryPromise = value; },
        clearCrashRegistries: () => {
            runtime.threadStates.clear();
            runtime.resumedThreadIds.clear();
            runtime.resumingThreads.clear();
            runtime.configApplyPromises.clear();
            runtime.configApplyTargets.clear();
        },
        clearHostResources: () => runtime._clearHostResources(),
    }));
}

module.exports = { attachRuntimeServiceGraph };
