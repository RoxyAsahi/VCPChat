'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { EventEmitter } = require('events');
const { RuntimeLifecycleService } = require('./runtime-lifecycle-service');
const { CodexAppServerTransport, CodexAppServerError } = require('./appServerTransport');
const { AgentProjectionRepository, CodexProjectionProjector } = require('./projection');
const { ToolboxBridgeTransport } = require('./toolboxBridgeTransport');
const { ToolboxResponsesAdapter } = require('./toolboxResponsesAdapter');
const { AttachmentRegistry } = require('./attachmentRegistry');
const { RuntimeInteractionService } = require('./runtime-interaction-service');
const { normalizeProfile, normalizeSessionConfig, PROFILE_SCHEMA_VERSION } = require('./dataContracts');
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
    bridgeResultContentItems,
    buildTurnInput,
    classifyToolboxEvent,
    compatibilityRuntime,
    compatibilitySession,
    decodeVcpInvokeCall,
    explicitAgent,
    hasDurableProjection,
    hasToolboxConfiguration,
    isConfirmedThreadNotFound,
    isUncertainRemoteMutation,
    normalizeApprovalPolicy,
    normalizeInstructionMode,
    normalizePersonality,
    normalizePermissionMode,
    normalizeReasoningEffort,
    normalizeSandboxMode,
    notificationItemId,
    pendingInputProjection,
    reasoningEffortsFromModel,
    resolveSessionIdInput,
    safeAvatarFile,
    sanitizeInteractionPayload,
    sanitizeToolboxValue,
    serializeError,
    sessionConfigResult,
    sameIdentity,
    submissionDedupeKey,
    toolboxConfigFingerprint,
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
        this._transportWired = false;
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
        this.dynamicCalls = new Map();
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
        this.uiEventSequence = 0;
        this.workbenchMounted = false;
        this.intentionalStop = false;
        this.toolboxConfigFingerprint = null;
        this.toolboxReconfiguration = null;
        this.toolboxRequestedSettings = null;
        this.toolboxRequestedFingerprint = null;
        this.toolboxRequestedGeneration = 0;
        this.toolboxAppliedGeneration = 0;
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
        this._assertProjectionWritable();
        if (this.state === 'ready') return this.getStatus();
        if (this.startPromise) return this.startPromise;
        if (Date.now() < this.runtimeRetryAfter) {
            throw new CodexAppServerError('RUNTIME_RETRY_BACKOFF', 'Codex App Server restart is temporarily rate limited', {
                retryAfterMs: this.runtimeRetryAfter - Date.now(),
            });
        }
        this.startPromise = (async () => {
            const startedAt = this.diagnosticClock();
            this.intentionalStop = false;
            this.lastError = null;
            this.ensureProjectionStore();
            const settings = this.getSettings() || {};
            await this._ensureResponsesAdapter(settings);
            this.generationScope = this.lifecycle.begin('Runtime superseded by a new generation');
            this.runtimeGeneration = this.lifecycle.value;
            this.interactions.setGeneration('codex-native', this.runtimeGeneration);
            this.transport = this.transport || this.transportFactory({
                cwd: this.projectRoot,
                clientVersion: 'vcp-chat-codex-agent-0.1.0',
                executable: settings.agentRuntime?.codex?.executable || settings.codexAppServerPath,
                supportedVersionLine: '0.146',
                // The Codex child sees only a per-process loopback capability;
                // VCPToolBox credentials remain in the local adapter and bridge.
                env: this.responsesAdapter
                    ? { VCP_CODEX_RESPONSES_ADAPTER_CAPABILITY: this.responsesAdapter.capability }
                    : {},
                unsetEnv: this.responsesAdapter ? ['VCP_TOOLBOX_API_KEY', 'VCP_TOOLBOX_URL'] : [],
            });
            this._wireTransport();
            try {
                await this.transport.start();
                await this._ensureBridge();
                this._normalizeUnboundThreadOperations();
                await this._recoverKnownThreadOperations();
                this.toolboxConfigFingerprint = toolboxConfigFingerprint(settings);
                this.state = 'ready';
                this.runtimeStartFailures = 0;
                this.runtimeRetryAfter = 0;
                this._diagnostic('runtime-process-ready', {
                    durationMs: this.diagnosticClock() - startedAt,
                });
            } catch (error) {
                this.lifecycle.close('Codex App Server failed to start');
                this.state = 'error';
                this.lastError = serializeError(error);
                this.intentionalStop = true;
                await this.transport.stop().catch(() => null);
                await this.responsesAdapter?.stop().catch(() => null);
                this.responsesAdapter = null;
                this.runtimeStartFailures += 1;
                this.runtimeRetryAfter = Date.now() + Math.min(30_000, 500 * (2 ** Math.min(6, this.runtimeStartFailures - 1)));
                throw error;
            }
            return this.getStatus();
        })().finally(() => { this.startPromise = null; });
        return this.startPromise;
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
        this.state = 'stopping';
        this.intentionalStop = true;
        this.lifecycle.invalidate('VChat Agent Runtime stopped');
        this.runtimeGeneration = this.lifecycle.value;
        this.generationScope = this.lifecycle.capture();
        this._rejectCompactionWaiters(new CodexAppServerError('RUNTIME_STOPPED', 'VChat Agent Runtime stopped during compaction'));
        await this._failClosedNativeApprovals('VChat Agent Runtime stopped');
        await this._interruptDynamicCalls('VChat Agent Runtime stopped');
        await this._failClosedToolboxApprovals('VChat Agent Runtime stopped');
        this.interactions.clear({ source: 'codex-native' });
        this.interactions.clear({ source: 'toolbox' });
        await this.transport?.stop();
        await this.bridge?.stop();
        await this.responsesAdapter?.stop();
        this.repository?.close();
        this.transport = null;
        this.repository = null;
        this.projector = null;
        this._transportWired = false;
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
        this.toolboxConfigFingerprint = null;
        this.toolboxReconfiguration = null;
        this.toolboxRequestedSettings = null;
        this.toolboxRequestedFingerprint = null;
        this.toolboxRequestedGeneration = 0;
        this.toolboxAppliedGeneration = 0;
        this.startPromise = null;
        this.knownOperationRecoveryPromise = null;
        this.state = 'stopped';
        return this.getStatus();
    }

    _captureGeneration() {
        return this.lifecycle.capture();
    }

    _assertGeneration(scope) {
        this.lifecycle.assert(scope, CodexAppServerError);
        if (!this.repository) throw new CodexAppServerError('RUNTIME_STOPPED', 'Agent projection store is closed');
    }

    async createTopic(options = {}) {
        this.ensureProjectionStore();
        this._assertProjectionWritable();
        const sessionId = id('session');
        const now = Date.now();
        const agentId = explicitAgent(options.agentId || options.agent) || 'codex';
        const configSnapshot = this._configSnapshot({ ...options, agentId });
        if (configSnapshot.instructionMode === 'vchat-identity'
            && !String(configSnapshot.baseInstructions || '').trim()) {
            throw new CodexAppServerError(
                'AGENT_IDENTITY_MISSING',
                `Agent ${agentId} has no system prompt; refusing to start it with the Codex identity`,
            );
        }
        const identity = this._resolveCanonicalAgent(agentId, { failOnAmbiguous: true });
        const workspaceRoot = path.resolve(options.workspaceRoot
            || identity?.profile?.workspaceRoot
            || this.projectRoot);
        const session = this.repository.saveSession({
            sessionId,
            agentId: identity?.catalogId || agentId,
            agentCatalogId: identity?.catalogId || agentId,
            agentNameSnapshot: identity?.name || configSnapshot.agentName || agentId,
            title: String(options.title || 'Codex Agent').trim(),
            workspaceRoot,
            state: 'created',
            configSnapshot,
            configRevision: 1,
            createdAt: now,
            updatedAt: now,
        });
        return { topicId: session.sessionId, sessionId: session.sessionId, ...session };
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
        this.ensureProjectionStore();
        this._ensureDefaultAgentProfile();
        const profiles = this._agentCatalog().map((entry) => ({
            id: entry.catalogId, name: entry.name,
            revision: Number(entry.profile?.revision || 1),
            profileRevision: Number(entry.profile?.profileRevision || entry.profile?.revision || 1),
            schemaVersion: PROFILE_SCHEMA_VERSION,
            model: entry.profile?.model || '',
            instructionMode: normalizeInstructionMode(
                entry.profile?.instructionMode,
                entry.profile?.baseInstructions || entry.profile?.systemPrompt,
            ),
            baseInstructions: entry.profile?.baseInstructions || entry.profile?.systemPrompt || '',
            systemPrompt: entry.profile?.baseInstructions || entry.profile?.systemPrompt || '',
            developerInstructions: entry.profile?.developerInstructions || '',
            personality: normalizePersonality(entry.profile?.personality),
            workspaceRoot: entry.profile?.workspaceRoot || '',
            permissionMode: normalizePermissionMode(entry.profile?.permissionMode),
            reasoningEffort: normalizeReasoningEffort(entry.profile?.reasoningEffort),
            reasoningEfforts: Array.isArray(entry.profile?.reasoningEfforts) ? entry.profile.reasoningEfforts : [],
            executionProfile: 'toolbox-only',
            avatarUrl: this._agentAvatarUrl(entry.catalogId, entry.profile),
        }));
        for (const session of this.repository.listSessions({ archived: false })) {
            const idValue = session.agentCatalogId || session.agentId;
            if (!idValue || profiles.some((profile) => sameIdentity(profile.id, idValue))) continue;
            profiles.push({
                id: idValue,
                name: session.agentNameSnapshot || session.configSnapshot?.agentName || idValue,
                revision: Number(session.configSnapshot?.profileRevision || 1),
                model: session.configSnapshot?.model || '',
                instructionMode: normalizeInstructionMode(
                    session.configSnapshot?.instructionMode,
                    session.configSnapshot?.baseInstructions,
                ),
                baseInstructions: session.configSnapshot?.baseInstructions || '',
                systemPrompt: session.configSnapshot?.baseInstructions || '',
                developerInstructions: session.configSnapshot?.developerInstructions || '',
                personality: normalizePersonality(session.configSnapshot?.personality),
                workspaceRoot: session.workspaceRoot || '',
                permissionMode: normalizePermissionMode(session.configSnapshot?.permissionMode),
                reasoningEffort: normalizeReasoningEffort(session.configSnapshot?.reasoningEffort),
                reasoningEfforts: Array.isArray(session.configSnapshot?.reasoningEfforts)
                    ? session.configSnapshot.reasoningEfforts : [],
                executionProfile: 'toolbox-only',
                avatarUrl: session.configSnapshot?.agentAvatar || '',
            });
        }
        return profiles;
    }

    saveAgentProfile(input = {}) {
        this.ensureProjectionStore();
        this._assertProjectionWritable();
        const incomingPatch = input.patch && typeof input.patch === 'object' ? input.patch : input;
        const agentId = input.profileId || input.agentId;
        const requestedId = String(agentId || '').trim();
        const requestedDisplayName = String(incomingPatch.name || '').trim();
        const directIdentity = requestedId
            ? this._resolveCanonicalAgent(requestedId, { failOnAmbiguous: true }) : null;
        const namedIdentity = requestedDisplayName
            ? this._resolveCanonicalAgent(requestedDisplayName, { failOnAmbiguous: true }) : null;
        const existing = directIdentity?.profile ? directIdentity : namedIdentity?.profile ? namedIdentity : null;
        const patch = existing ? { ...existing.profile, ...incomingPatch } : incomingPatch;
        const {
            name, systemPrompt, instructionMode, baseInstructions, developerInstructions,
            personality, model, reasoningEffort, workspaceRoot, permissionMode,
        } = patch;
        const displayName = String(name || '').trim();
        const prompt = String(
            Object.prototype.hasOwnProperty.call(incomingPatch, 'baseInstructions')
                ? incomingPatch.baseInstructions
                : Object.prototype.hasOwnProperty.call(incomingPatch, 'systemPrompt')
                    ? incomingPatch.systemPrompt
                    : baseInstructions ?? systemPrompt ?? '',
        ).trim();
        const normalizedInstructionMode = normalizeInstructionMode(instructionMode, prompt);
        const normalizedDeveloperInstructions = String(developerInstructions || '').trim();
        const normalizedPersonality = normalizePersonality(personality);
        const idValue = requestedId || displayName
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!displayName || !idValue || idValue === '.' || idValue === '..' || /[\\/:*?"<>|]/.test(idValue)) {
            throw new CodexAppServerError('INVALID_INPUT', 'Build Agent name is invalid');
        }
        if (normalizedInstructionMode === 'vchat-identity' && !prompt) {
            throw new CodexAppServerError('INVALID_INPUT', 'VChat identity mode requires baseInstructions');
        }
        if (existing && (!requestedId || !sameIdentity(existing.catalogId, requestedId))) {
            throw new CodexAppServerError('ALREADY_EXISTS', `Build Agent ${displayName} already exists`);
        }
        if (existing) {
            const expected = Number(input.expectedProfileRevision);
            const actual = Number(existing.profile?.profileRevision || existing.profile?.revision || 1);
            if (!Number.isInteger(expected) || expected !== actual) {
                throw new CodexAppServerError('PROFILE_CONFIG_CONFLICT', 'Agent Profile changed in another view', {
                    current: { id: existing.catalogId, ...normalizeProfile(existing.profile, existing.catalogId) },
                });
            }
        }
        const directory = path.join(this.agentsDir, idValue);
        fs.mkdirSync(directory, { recursive: true });
        let normalizedWorkspace = '';
        if (String(workspaceRoot || '').trim()) {
            normalizedWorkspace = path.resolve(String(workspaceRoot).trim());
            let stat = null;
            try { stat = fs.statSync(normalizedWorkspace); } catch { /* validated below */ }
            if (!stat?.isDirectory()) throw new CodexAppServerError('INVALID_WORKSPACE', 'Workspace directory does not exist');
        }
        const previousRevision = Number(existing?.profile?.profileRevision || existing?.profile?.revision || 0);
        const avatarFile = safeAvatarFile(existing?.profile?.avatarFile);
        const normalizedModel = String(model || '').trim();
        const reasoning = this._validateReasoningEffort(normalizedModel, reasoningEffort);
        const profile = normalizeProfile({
            name: displayName,
            instructionMode: normalizedInstructionMode,
            baseInstructions: prompt,
            systemPrompt: prompt,
            developerInstructions: normalizedDeveloperInstructions,
            personality: normalizedPersonality,
            revision: previousRevision + 1,
            profileRevision: previousRevision + 1,
            schemaVersion: PROFILE_SCHEMA_VERSION,
            profileId: idValue,
            executionProfile: 'toolbox-only',
            permissionMode: normalizePermissionMode(permissionMode),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(reasoning.effort ? { reasoningEffort: reasoning.effort } : {}),
            ...(reasoning.supported.length ? { reasoningEfforts: reasoning.supported } : {}),
            ...(normalizedWorkspace ? { workspaceRoot: normalizedWorkspace } : {}),
            ...(avatarFile ? { avatarFile } : {}),
            updatedAt: Date.now(),
        }, idValue);
        const configPath = path.join(directory, 'config.json');
        const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporaryPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
        fs.renameSync(temporaryPath, configPath);
        return {
            success: true,
            profile: {
                id: idValue,
                ...profile,
                avatarUrl: this._agentAvatarUrl(idValue),
            },
        };
    }

    saveAgentAvatar({ agentId, profileId, expectedProfileRevision, avatarData } = {}) {
        this.ensureProjectionStore();
        this._assertProjectionWritable();
        const idValue = String(profileId || agentId || '').trim();
        if (!idValue || /[\\/:*?"<>|]/.test(idValue)) throw new CodexAppServerError('INVALID_INPUT', 'Invalid Build Agent identity');
        const type = String(avatarData?.type || '').toLowerCase();
        const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
        const ext = extensions[type];
        const bytes = Buffer.from(avatarData?.buffer || []);
        if (!ext || bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
            throw new CodexAppServerError('INVALID_INPUT', 'Invalid Build Agent avatar');
        }
        this._ensureDefaultAgentProfile();
        const resolved = this._resolveAgentProfile(idValue);
        if (!resolved || !sameIdentity(resolved.id, idValue)) {
            throw new CodexAppServerError('NOT_FOUND', 'Build Agent Profile was not found');
        }
        const actualRevision = Number(resolved.profileRevision || resolved.revision || 1);
        if (!Number.isInteger(Number(expectedProfileRevision)) || Number(expectedProfileRevision) !== actualRevision) {
            throw new CodexAppServerError('PROFILE_CONFIG_CONFLICT', 'Agent Profile changed in another view', {
                current: normalizeProfile(resolved, resolved.id),
            });
        }
        const revision = actualRevision + 1;
        const avatarFile = `avatar-r${revision}${ext}`;
        const directory = path.join(this.agentsDir, resolved.id);
        const avatarPath = path.join(directory, avatarFile);
        const avatarTemporaryPath = `${avatarPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(avatarTemporaryPath, bytes);
        fs.renameSync(avatarTemporaryPath, avatarPath);
        const configPath = path.join(directory, 'config.json');
        const configTemporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
        const { id: _id, avatarUrl: _avatarUrl, ...stored } = resolved;
        const profile = normalizeProfile({ ...stored, revision, profileRevision: revision,
            schemaVersion: PROFILE_SCHEMA_VERSION, profileId: resolved.id, avatarFile, updatedAt: Date.now() }, resolved.id);
        fs.writeFileSync(configTemporaryPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
        fs.renameSync(configTemporaryPath, configPath);
        const avatarUrl = pathToFileURL(avatarPath).toString();
        return { success: true, revision, avatarUrl, profile: { id: resolved.id, ...profile, avatarUrl } };
    }

    async ensureSessionRuntime({
        sessionId, topicId, reason = 'send', recoverPendingInputs = true, ...options
    } = {}) {
        this.ensureProjectionStore();
        this._assertProjectionWritable();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        if (this.sessionWarmPromises.has(idValue)) return this.sessionWarmPromises.get(idValue);
        const warm = (async () => {
            const startedAt = this.diagnosticClock();
            this._diagnostic('thread-warm-started', { sessionId: idValue, reason });
            await this.start();
            const generation = this._captureGeneration();
            let session = this.repository.getSession(idValue);
            if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
            if (session.archivedAt) {
                throw new CodexAppServerError('SESSION_ARCHIVED', 'Restore the archived Session before starting a Turn');
            }
            session = this._repairSessionIdentity(this._repairSessionConfig(session));
            session = session.threadId
                ? await this._resumeSession(session)
                : await this._startThreadForSession(session, options);
            this._assertGeneration(generation);
            if (recoverPendingInputs) await this._recoverPendingInputsForSession(session);
            this._assertGeneration(generation);
            this._rememberIdleWarmSession(session.sessionId);
            this._diagnostic('thread-warm-completed', {
                sessionId: session.sessionId,
                reason,
                durationMs: this.diagnosticClock() - startedAt,
            });
            return compatibilitySession(session);
        })().finally(() => this.sessionWarmPromises.delete(idValue));
        this.sessionWarmPromises.set(idValue, warm);
        return warm;
    }

    async _startThreadForSession(session, options = {}) {
        const generation = this._captureGeneration();
        const config = session.configSnapshot || this._configSnapshot(options);
        const runtimeParams = this._runtimePolicyParams(config, { starting: true });
        const operation = this.repository.createOperation({
            sessionId: session.sessionId,
            kind: 'thread-start',
            payload: { workspaceRoot: session.workspaceRoot, profileRevision: config.profileRevision || null },
        });
        let threadId;
        try {
            this.repository.updateOperation(operation.operationId, { state: 'dispatching' });
            const result = await this.transport.request('thread/start', {
                model: config.model || options.model,
                ...runtimeParams,
                cwd: session.workspaceRoot,
                approvalPolicy: normalizeApprovalPolicy(config.permissionMode || config.approvalPolicy),
                sandbox: normalizeSandboxMode(config.sandbox),
                ...this._threadInstructionParams(config),
                dynamicTools: [vcpInvokeTool()],
            });
            this._assertGeneration(generation);
            threadId = result?.thread?.id;
            if (!threadId) throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/start returned no thread id');
            this.repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId });
            await this.faultInjection.afterThreadStartRemoteApplied?.({ operation, session, threadId });
            this._assertGeneration(generation);
            session = session.threadId
                ? this.repository.replaceUnmaterializedThread(session.sessionId, threadId)
                : this.repository.saveSession({
                    ...session,
                    threadId,
                    state: 'ready',
                    updatedAt: Date.now(),
                });
            session = this.repository.markSessionConfigApplied(
                session.sessionId, session.configRevision, session.configSnapshot,
            );
            this._sendSessionConfigEvent('session.config.applied', session);
            this.repository.updateOperation(operation.operationId, { state: 'completed', threadId });
        } catch (error) {
            this.repository.updateOperation(operation.operationId, {
                state: (threadId || isUncertainRemoteMutation(error)) ? 'uncertain' : 'failed',
                threadId: threadId || null,
                lastError: error?.message || String(error),
            });
            throw error;
        }
        this.threadStates.set(threadId, { activity: 'idle', activeTurnId: null });
        this.resumedThreadIds.add(threadId);
        return session;
    }

    async readTopic({ topicId, sessionId, reconcile = true } = {}) {
        const startedAt = this.diagnosticClock();
        this.ensureProjectionStore();
        let session = this.repository.getSession(resolveSessionIdInput({ sessionId, topicId }));
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        session = this._repairSessionConfig(session);
        const localProjection = this.repository.readProjection(session.sessionId);
        if (reconcile === false || this.repository.readOnly) {
            this._diagnostic('projection-read-returned', {
                sessionId: session.sessionId,
                durationMs: this.diagnosticClock() - startedAt,
            });
            return localProjection;
        }
        await this.start();
        const runtimeGeneration = this._captureGeneration();
        if (session.threadId && reconcile !== false) {
            try {
                let applied = false;
                for (let attempt = 0; attempt < 3 && !applied; attempt += 1) {
                    const generation = this.repository.projectionGeneration(session.sessionId);
                    const result = await this.transport.request('thread/read', {
                        threadId: session.threadId,
                        includeTurns: true,
                    });
                    this._assertGeneration(runtimeGeneration);
                    applied = this.projector.reconcileThread(session.sessionId, result.thread || result, generation).applied;
                }
                if (!applied) throw new CodexAppServerError('RECONCILE_GENERATION_CHANGED', 'Projection changed during reconciliation; retry later');
                if (session.orphaned) this.repository.markOrphaned(session.sessionId, false);
            } catch (error) {
                if (error?.code === 'STALE_RUNTIME_GENERATION' || !this.repository) throw error;
                if (isConfirmedThreadNotFound(error) && hasDurableProjection(localProjection)) {
                    this.repository.markOrphaned(session.sessionId, true);
                }
                this.repository.markProjectionError(session.sessionId, error.message);
            }
        }
        const projection = this.repository.readProjection(session.sessionId);
        this._diagnostic('projection-reconcile-returned', {
            sessionId: session.sessionId,
            durationMs: this.diagnosticClock() - startedAt,
        });
        return projection;
    }

    async listTopics({ agentId, archived = false } = {}) {
        const startedAt = this.diagnosticClock();
        this.ensureProjectionStore();
        const requested = explicitAgent(agentId);
        const identity = requested ? this._resolveCanonicalAgent(requested, { failOnAmbiguous: true }) : null;
        const sessions = this.repository.listSessions({ archived: archived === true })
            .map((session) => this._repairSessionIdentity(session))
            .filter((session) => !identity || sameIdentity(session.agentCatalogId || session.agentId, identity.catalogId));
        const topics = sessions.map((session) => ({
            id: session.sessionId,
            topicId: session.sessionId,
            sessionId: session.sessionId,
            agentId: session.agentId,
            agentCatalogId: session.agentCatalogId || session.agentId,
            agentNameSnapshot: session.agentNameSnapshot || session.configSnapshot?.agentName || session.agentId,
            title: session.title,
            model: session.configSnapshot?.model || null,
            workspaceRoot: session.workspaceRoot,
            state: session.state,
            orphaned: session.orphaned,
            pinnedAt: session.pinnedAt || null,
            archivedAt: session.archivedAt || null,
            updatedAt: session.updatedAt,
        }));
        this._diagnostic('projection-list-returned', {
            agentId: identity?.catalogId || requested || 'all',
            count: topics.length,
            durationMs: this.diagnosticClock() - startedAt,
        });
        return topics;
    }

    async startTurn({ sessionId, topicId, prompt, attachments = [], clientUserMessageId } = {}) {
        return this._startTurnWithGuard({
            sessionId, topicId, prompt, attachments, clientUserMessageId, recoverPendingInputs: true,
        });
    }

    async _startTurnWithGuard({
        sessionId, topicId, prompt, attachments = [], clientUserMessageId, recoverPendingInputs,
    } = {}) {
        this._assertProjectionWritable();
        const requestedSessionId = resolveSessionIdInput({ sessionId, topicId });
        const text = String(prompt || '').trim();
        const requestKey = submissionDedupeKey(text, attachments);
        const existing = this.turnStartPromises.get(requestedSessionId);
        if (existing) {
            if (existing.requestKey === requestKey) return existing.promise;
            throw new CodexAppServerError('SESSION_BUSY', 'A different message is already being submitted for this Session');
        }
        const promise = this._startTurn({
            sessionId: requestedSessionId, prompt: text, attachments, clientUserMessageId, recoverPendingInputs,
        });
        this.turnStartPromises.set(requestedSessionId, { requestKey, promise });
        try {
            return await promise;
        } finally {
            if (this.turnStartPromises.get(requestedSessionId)?.promise === promise) this.turnStartPromises.delete(requestedSessionId);
        }
    }

    async _startTurn({
        sessionId, prompt, attachments = [], clientUserMessageId, recoverPendingInputs = true,
    } = {}) {
        this._assertProjectionWritable();
        const startedAt = this.diagnosticClock();
        let session = await this.ensureSessionRuntime({ sessionId, reason: 'send', recoverPendingInputs });
        const generation = this._captureGeneration();
        await this._applySessionRuntimeConfig(session.sessionId, { barrier: true });
        this._assertGeneration(generation);
        session = compatibilitySession(this.repository.getSession(session.sessionId));
        const text = String(prompt || '').trim();
        if (!text && (!Array.isArray(attachments) || attachments.length === 0)) {
            throw new CodexAppServerError('INVALID_INPUT', 'Prompt or attachment must not be empty');
        }
        const turnId = id('turn');
        const resolvedAttachments = this.attachments.resolveMany(session.sessionId, attachments);
        const input = buildTurnInput(text, resolvedAttachments);
        const effort = this._effectiveReasoningEffort(session.configSnapshot || {});
        const result = await this.transport.request('turn/start', {
            threadId: session.threadId,
            clientUserMessageId: clientUserMessageId || id('client_msg'),
            input,
            cwd: session.workspaceRoot,
            model: session.configSnapshot?.model || undefined,
            ...(effort ? { effort } : {}),
            // App Server applies execution policy to the turn it is about to
            // start.  Reading it from the Session snapshot means a saved
            // current-session change takes effect without restarting this
            // Thread (and without touching any other running Thread).
            approvalPolicy: normalizeApprovalPolicy(session.configSnapshot?.permissionMode || session.configSnapshot?.approvalPolicy),
            sandbox: normalizeSandboxMode(session.configSnapshot?.sandbox),
        });
        this._assertGeneration(generation);
        const acceptedTurnId = result?.turn?.id || turnId;
        const appliedSession = this.repository.markSessionConfigApplied(
            session.sessionId, session.configRevision, session.configSnapshot,
        );
        this.configApplyTargets.delete(session.threadId);
        this._sendSessionConfigEvent('session.config.applied', appliedSession);
        this.idleWarmSessions.delete(session.sessionId);
        this.threadStates.set(session.threadId, { activity: 'running', activeTurnId: acceptedTurnId });
        this._diagnostic('turn-start-ack', {
            sessionId: session.sessionId,
            turnId: acceptedTurnId,
            durationMs: this.diagnosticClock() - startedAt,
        });
        return {
            sessionId: session.sessionId,
            topicId: session.sessionId,
            threadId: session.threadId,
            turnId: acceptedTurnId,
        };
    }

    async steerTurn({ sessionId, topicId, turnId, prompt } = {}) {
        this._assertProjectionWritable();
        const session = this.repository.getSession(resolveSessionIdInput({ sessionId, topicId }));
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        const result = await this.transport.request('turn/steer', {
            threadId: session.threadId,
            expectedTurnId: turnId,
            clientUserMessageId: id('client_msg'),
            input: [{ type: 'text', text: String(prompt || ''), text_elements: [] }],
        });
        return { sessionId: session.sessionId, threadId: session.threadId, turnId: result?.turnId || turnId };
    }

    async followUpTurn({ sessionId, topicId, prompt, attachments = [] } = {}) {
        this._assertProjectionWritable();
        if (Array.isArray(attachments) && attachments.length) {
            throw new CodexAppServerError('QUEUE_ATTACHMENT_UNSUPPORTED', 'Queued follow-up attachments are not persisted; send them as a new turn instead');
        }
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        const session = this.repository.getSession(idValue);
        const text = String(prompt || '').trim();
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        if (!text) throw new CodexAppServerError('INVALID_INPUT', 'Follow-up message must not be empty');
        const queued = this.repository.enqueuePendingInput(idValue, {
            dedupeKey: submissionDedupeKey(text, []),
            prompt: text,
        });
        const state = this.threadStates.get(session.threadId);
        if (state?.activity !== 'running') void this._drainFollowUpQueue(session);
        return { sessionId: idValue, threadId: session.threadId, inputId: queued.input_id, queued: true };
    }

    async cancelTurn({ sessionId, topicId, turnId } = {}) {
        this._assertProjectionWritable();
        const session = this.repository.getSession(resolveSessionIdInput({ sessionId, topicId }));
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        await this.transport.request('turn/interrupt', {
            threadId: session.threadId,
            turnId,
        });
        // The adapter receives Codex's signed-by-process turn metadata header
        // and can therefore interrupt only this exact ToolBox model request.
        // Do this before unrelated dynamic VCP calls are considered.
        await this.responsesAdapter?.cancelTurn?.({ threadId: session.threadId, turnId });
        const interrupts = [...this.dynamicCalls.values()]
            .filter((call) => call.threadId === session.threadId && (!turnId || call.turnId === turnId))
            .map((call) => this.bridge?.interrupt(call.bridgeRequestId).catch(() => false));
        await Promise.all(interrupts);
        return { sessionId: session.sessionId, threadId: session.threadId, turnId, interrupted: true };
    }

    async forkSession({ sessionId, topicId, turnId, title } = {}) {
        this._assertProjectionWritable();
        const source = this.repository.getSession(resolveSessionIdInput({ sessionId, topicId }));
        if (!source?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        const targetSessionId = id('session');
        const operation = this.repository.createOperation({
            sessionId: source.sessionId, kind: 'thread-fork',
            payload: { targetSessionId, sourceThreadId: source.threadId, lastTurnId: turnId || null },
        });
        let threadId;
        try {
            this.repository.updateOperation(operation.operationId, { state: 'dispatching' });
            const result = await this.transport.request('thread/fork', {
                threadId: source.threadId,
                ...(turnId ? { lastTurnId: turnId } : {}),
            });
            threadId = result?.thread?.id;
            if (!threadId) throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/fork returned no thread id');
            this.repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId });
            await this.faultInjection.afterThreadForkRemoteApplied?.({ operation, source, threadId, targetSessionId });
            const fork = this.repository.saveSession({
                sessionId: targetSessionId,
                threadId,
                agentId: source.agentId,
                agentCatalogId: source.agentCatalogId,
                agentNameSnapshot: source.agentNameSnapshot,
                title: title || `${source.title || 'Codex Agent'} (branch)`,
                workspaceRoot: source.workspaceRoot,
                state: 'ready',
                configSnapshot: source.configSnapshot,
                configRevision: source.configRevision,
            });
            this.repository.updateOperation(operation.operationId, { state: 'completed', threadId });
            return fork;
        } catch (error) {
            this.repository.updateOperation(operation.operationId, {
                state: (threadId || isUncertainRemoteMutation(error)) ? 'uncertain' : 'failed',
                threadId: threadId || null,
                lastError: error?.message || String(error),
            });
            throw error;
        }
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
        this._assertProjectionWritable();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        this._assertLifecycleIdle(session);
        if (session.threadId) await this.start();
        const operation = this.repository.createOperation({ sessionId: idValue, kind: 'thread-archive', threadId: session.threadId });
        try {
            this.repository.updateOperation(operation.operationId, { state: 'dispatching' });
            if (session.threadId) {
                await this.transport.request('thread/archive', { threadId: session.threadId });
            }
            this.repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId: session.threadId });
        } catch (error) {
            this.repository.updateOperation(operation.operationId, {
                state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                lastError: error?.message || String(error),
            });
            throw error;
        }
        await this.faultInjection.afterArchiveRemoteApplied?.({ operation, session });
        const archived = this.repository.archiveSession(idValue);
        this.attachments.clearSession(idValue);
        this.repository.updateOperation(operation.operationId, { state: 'completed', threadId: session.threadId });
        return { sessionId: idValue, threadId: session.threadId, archived: true, session: compatibilitySession(archived) };
    }

    async closeSession(options = {}) { return this.archiveSession(options); }

    async restoreSession({ sessionId, topicId } = {}) {
        this._assertProjectionWritable();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        if (!session.archivedAt) return { sessionId: idValue, threadId: session.threadId, restored: false, session: compatibilitySession(session) };
        if (session.threadId) await this.start();
        const operation = this.repository.createOperation({ sessionId: idValue, kind: 'thread-unarchive', threadId: session.threadId });
        try {
            this.repository.updateOperation(operation.operationId, { state: 'dispatching' });
            if (session.threadId) {
                const result = await this.transport.request('thread/unarchive', { threadId: session.threadId });
                const returnedThreadId = String(result?.thread?.id || session.threadId);
                if (returnedThreadId !== session.threadId) {
                    throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/unarchive returned a mismatched thread id');
                }
            }
            this.repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId: session.threadId });
        } catch (error) {
            this.repository.updateOperation(operation.operationId, {
                state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                lastError: error?.message || String(error),
            });
            throw error;
        }
        await this.faultInjection.afterUnarchiveRemoteApplied?.({ operation, session });
        const restored = this.repository.unarchiveSession(idValue);
        this.repository.updateOperation(operation.operationId, { state: 'completed', threadId: session.threadId });
        return { sessionId: idValue, threadId: restored.threadId, restored: true, session: compatibilitySession(restored) };
    }

    async setSessionPinned({ sessionId, topicId, pinned } = {}) {
        this._assertProjectionWritable();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        if (typeof pinned !== 'boolean') throw new CodexAppServerError('INVALID_INPUT', 'Session pin state must be boolean');
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const updated = this.repository.setPinned(idValue, pinned);
        return { sessionId: idValue, pinned, session: compatibilitySession(updated) };
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
        this._assertProjectionWritable();
        const session = this.repository.getSession(resolveSessionIdInput({ sessionId, topicId }));
        if (!session?.threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached');
        this._assertLifecycleIdle(session);
        if (this.compactionWaiters.has(session.threadId)) {
            throw new CodexAppServerError('SESSION_BUSY', 'Context compaction is already running for this Session');
        }
        await this.start();
        let resolveWaiter;
        let rejectWaiter;
        const completion = new Promise((resolve, reject) => { resolveWaiter = resolve; rejectWaiter = reject; });
        const timeout = setTimeout(() => {
            const waiter = this.compactionWaiters.get(session.threadId);
            if (!waiter) return;
            this.compactionWaiters.delete(session.threadId);
            waiter.reject(new CodexAppServerError('COMPACTION_TIMEOUT', 'Codex context compaction did not complete in time'));
            this._sendUiEvent({ type: 'compaction.failed', topicId: session.sessionId, sessionId: session.sessionId,
                payload: { reason: 'timeout' } });
        }, Math.max(1_000, Number(timeoutMs) || 120_000));
        this.compactionWaiters.set(session.threadId, {
            sessionId: session.sessionId, threadId: session.threadId, resolve: resolveWaiter, reject: rejectWaiter, timeout,
        });
        this._sendUiEvent({ type: 'compaction.started', topicId: session.sessionId, sessionId: session.sessionId });
        try {
            // ACK proves only admission. Completion requires a terminal item.
            await this.transport.request('thread/compact/start', { threadId: session.threadId });
        } catch (error) {
            const waiter = this.compactionWaiters.get(session.threadId);
            if (waiter) {
                this.compactionWaiters.delete(session.threadId);
                clearTimeout(waiter.timeout);
                waiter.reject(error);
            }
            throw error;
        }
        return completion;
    }
    async searchTopics(options = {}) { return { topics: await this.listTopics(options) }; }
    async searchTopicMessages({ topicId, sessionId } = {}) { return this.readTopic({ topicId, sessionId }); }
    async getTopicIndexStatus() { return { available: false, source: 'codex-thread-store' }; }
    async rebuildTopicIndex() { return { available: false }; }
    async renameTopic({ topicId, sessionId, title }) {
        this._assertProjectionWritable();
        const session = this.repository.getSession(resolveSessionIdInput({ sessionId, topicId }));
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        this.repository.saveSession({ ...session, title: String(title || '').trim(), updatedAt: Date.now() });
        return this.repository.getSession(session.sessionId);
    }
    async deleteTopic({ topicId, sessionId }) { return this.archiveSession({ topicId, sessionId }); }
    listRecoveryOperations() {
        this.ensureProjectionStore();
        return this.repository.listRecoverableOperations();
    }
    async _recoverKnownThreadOperations() {
        if (this.repository?.readOnly) return { recovered: 0, remaining: 0 };
        if (this.knownOperationRecoveryPromise) return this.knownOperationRecoveryPromise;
        const promise = (async () => {
            const generation = this._captureGeneration();
            const recoverable = this.repository.listRecoverableOperations()
                .filter((operation) => ['thread-archive', 'thread-unarchive', 'thread-delete'].includes(operation.kind))
                .filter((operation) => ['prepared', 'dispatching', 'remote-applied', 'uncertain'].includes(operation.state));
            let recovered = 0;
            for (const operation of recoverable) {
                try {
                    if (await this._recoverKnownThreadOperation(operation)) recovered += 1;
                    this._assertGeneration(generation);
                } catch (error) {
                    if (error?.code === 'STALE_RUNTIME_GENERATION' || !this.repository) throw error;
                    this.lastError = serializeError(error);
                    this._diagnostic('known-operation-recovery-failed', {
                        operationId: operation.operationId,
                        kind: operation.kind,
                        error: error?.message || String(error),
                    });
                }
            }
            return {
                recovered,
                remaining: this.repository.listRecoverableOperations()
                    .filter((operation) => ['thread-archive', 'thread-unarchive', 'thread-delete'].includes(operation.kind))
                    .length,
            };
        })().finally(() => { this.knownOperationRecoveryPromise = null; });
        this.knownOperationRecoveryPromise = promise;
        return promise;
    }
    async _recoverKnownThreadOperation(input) {
        let operation = this.repository.getOperation(input.operationId);
        if (!operation || !['thread-archive', 'thread-unarchive', 'thread-delete'].includes(operation.kind)) return false;
        if (operation.state !== 'remote-applied') {
            this.repository.updateOperation(operation.operationId, { state: 'dispatching', lastError: null });
            try {
                if (operation.threadId) {
                    const method = operation.kind === 'thread-archive' ? 'thread/archive'
                        : operation.kind === 'thread-unarchive' ? 'thread/unarchive'
                            : 'thread/delete';
                    try {
                        await this.transport.request(method, { threadId: operation.threadId });
                    } catch (error) {
                        if (operation.kind !== 'thread-delete' || !isConfirmedThreadNotFound(error)) throw error;
                    }
                }
                operation = this.repository.updateOperation(operation.operationId, {
                    state: 'remote-applied', threadId: operation.threadId, lastError: null,
                });
            } catch (error) {
                this.repository.updateOperation(operation.operationId, {
                    state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                    lastError: error?.message || String(error),
                });
                return false;
            }
        }
        const session = operation.sessionId ? this.repository.getSession(operation.sessionId) : null;
        let payload = operation.payload || {};
        if (operation.kind === 'thread-archive') {
            if (!session) throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'Archive recovery Session no longer exists');
            this.repository.archiveSession(session.sessionId);
        } else if (operation.kind === 'thread-unarchive') {
            if (!session) throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'Unarchive recovery Session no longer exists');
            this.repository.unarchiveSession(session.sessionId);
        } else if (session) {
            const receipt = this.repository.permanentlyDeleteSession(session.sessionId, operation.threadId);
            payload = { ...payload, deletionReceiptId: receipt.receiptId };
        }
        this.repository.updateOperation(operation.operationId, {
            state: 'completed', threadId: operation.threadId, payload, lastError: null,
        });
        return true;
    }
    async _listStoredThreads(archived) {
        const threads = [];
        let cursor = null;
        for (let page = 0; page < 20; page += 1) {
            const result = await this.transport.request('thread/list', {
                archived: archived === true,
                cursor,
                limit: 100,
                useStateDbOnly: true,
            });
            const data = Array.isArray(result?.data) ? result.data : [];
            threads.push(...data);
            cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
            if (!cursor) break;
        }
        return threads;
    }
    _normalizeUnboundThreadOperations() {
        for (const operation of this.repository.listRecoverableOperations()) {
            if (operation.kind !== 'thread-start' && operation.kind !== 'thread-fork') continue;
            if (operation.state === 'prepared') {
                this.repository.updateOperation(operation.operationId, {
                    state: 'failed',
                    lastError: 'VChat restarted before the Codex Thread request was dispatched',
                });
            } else if (operation.state === 'dispatching') {
                this.repository.updateOperation(operation.operationId, {
                    state: 'uncertain',
                    lastError: 'VChat restarted before the Codex Thread request outcome was recorded',
                });
            }
        }
    }
    async listRecoveryCandidates() {
        this.ensureProjectionStore();
        const operations = this.repository.listRecoverableOperations()
            .filter((operation) => ['uncertain', 'remote-applied'].includes(operation.state)
                && (operation.kind === 'thread-start' || operation.kind === 'thread-fork'));
        if (!operations.length) return { operations: [], threads: [] };
        await this.start();
        const [active, archived] = await Promise.all([
            this._listStoredThreads(false),
            this._listStoredThreads(true),
        ]);
        const boundThreadIds = new Set([
            ...this.repository.listSessions({ archived: false }),
            ...this.repository.listSessions({ archived: true }),
        ].map((session) => session.threadId).filter(Boolean));
        const seen = new Set();
        const threads = [...active, ...archived]
            .filter((thread) => thread?.id && !boundThreadIds.has(thread.id) && !seen.has(thread.id) && seen.add(thread.id))
            .map((thread) => ({
                threadId: thread.id,
                title: thread.name || thread.preview || thread.id,
                preview: thread.preview || '',
                cwd: thread.cwd || '',
                modelProvider: thread.modelProvider || '',
                archived: archived.some((entry) => entry?.id === thread.id),
                createdAt: Number(thread.createdAt || 0),
                updatedAt: Number(thread.updatedAt || 0),
            }));
        return { operations, threads };
    }
    async resolveRecoveryOperation({ operationId, action, threadId } = {}) {
        this._assertProjectionWritable();
        const operation = this.repository.getOperation(String(operationId || ''));
        if (!operation || !['uncertain', 'remote-applied'].includes(operation.state)
            || (operation.kind !== 'thread-start' && operation.kind !== 'thread-fork')) {
            throw new CodexAppServerError('INVALID_RECOVERY_OPERATION', 'Only unresolved Thread start/fork operations can be resolved');
        }
        const selectedThreadId = String(threadId || '').trim();
        if (!selectedThreadId) throw new CodexAppServerError('INVALID_INPUT', 'Recovery requires a Codex threadId');
        if (operation.threadId && operation.threadId !== selectedThreadId) {
            throw new CodexAppServerError('RECOVERY_THREAD_MISMATCH', 'Recovery must use the Thread recorded by the acknowledged operation');
        }
        await this.start();
        const bound = [
            ...this.repository.listSessions({ archived: false }),
            ...this.repository.listSessions({ archived: true }),
        ].find((session) => session.threadId === selectedThreadId);
        if (bound) throw new CodexAppServerError('THREAD_ALREADY_BOUND', 'The selected Codex Thread already belongs to a VChat Session');

        if (action === 'delete') {
            try {
                await this.transport.request('thread/delete', { threadId: selectedThreadId });
            } catch (error) {
                if (!isConfirmedThreadNotFound(error)) throw error;
            }
            this.repository.updateOperation(operation.operationId, {
                state: 'completed',
                threadId: selectedThreadId,
                payload: { ...operation.payload, resolution: 'deleted-unbound-thread' },
                lastError: null,
            });
            return { operationId: operation.operationId, resolved: true, action: 'delete', threadId: selectedThreadId };
        }
        if (action !== 'bind') throw new CodexAppServerError('INVALID_INPUT', 'Recovery action must be bind or delete');

        const result = await this.transport.request('thread/read', { threadId: selectedThreadId, includeTurns: true });
        const thread = result?.thread || result;
        if (String(thread?.id || '') !== selectedThreadId) {
            throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/read returned a mismatched Thread');
        }
        let session;
        if (operation.kind === 'thread-start') {
            session = this.repository.getSession(operation.sessionId);
            if (!session || session.threadId) {
                throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'The VChat Session is missing or already materialized');
            }
            session = this.repository.replaceUnmaterializedThread(session.sessionId, selectedThreadId);
        } else {
            const source = this.repository.getSession(operation.sessionId);
            const targetSessionId = String(operation.payload?.targetSessionId || '').trim();
            if (!source || !targetSessionId || this.repository.getSession(targetSessionId)) {
                throw new CodexAppServerError('RECOVERY_TARGET_CHANGED', 'The fork recovery target is no longer available');
            }
            session = this.repository.saveSession({
                sessionId: targetSessionId,
                threadId: selectedThreadId,
                agentId: source.agentId,
                agentCatalogId: source.agentCatalogId,
                agentNameSnapshot: source.agentNameSnapshot,
                title: thread.name || `${source.title || 'Codex Agent'} (recovered branch)`,
                workspaceRoot: thread.cwd || source.workspaceRoot,
                state: 'ready',
                configSnapshot: source.configSnapshot,
                configRevision: source.configRevision,
            });
        }
        const generation = this.repository.projectionGeneration(session.sessionId);
        this.projector.reconcileThread(session.sessionId, thread, generation);
        this.repository.updateOperation(operation.operationId, {
            state: 'completed',
            threadId: selectedThreadId,
            payload: { ...operation.payload, resolution: 'bound-thread', boundSessionId: session.sessionId },
            lastError: null,
        });
        this.threadStates.set(selectedThreadId, { activity: 'idle', activeTurnId: null });
        return {
            operationId: operation.operationId,
            resolved: true,
            action: 'bind',
            threadId: selectedThreadId,
            session: compatibilitySession(session),
        };
    }
    async permanentlyDeleteSession({ sessionId, topicId } = {}) {
        this._assertProjectionWritable();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        if (!session.archivedAt) throw new CodexAppServerError('SESSION_NOT_ARCHIVED', 'Archive the Session before permanently deleting it');
        this._assertLifecycleIdle(session);
        if (this.toolboxApprovals.size) {
            throw new CodexAppServerError('SESSION_HAS_PENDING_APPROVAL', 'Resolve pending ToolBox approval before permanent deletion');
        }
        const blockingInput = this.repository.listPendingInputs(idValue)
            .find((entry) => ['queued', 'dispatching', 'accepted', 'uncertain'].includes(entry.state));
        if (blockingInput) throw new CodexAppServerError('SESSION_HAS_PENDING_INPUT', 'Resolve queued or uncertain input before permanent deletion');
        if (session.threadId) await this.start();
        const operation = this.repository.createOperation({
            sessionId: idValue, kind: 'thread-delete', threadId: session.threadId,
        });
        try {
            this.repository.updateOperation(operation.operationId, { state: 'dispatching' });
            if (session.threadId) {
                try {
                    await this.transport.request('thread/delete', { threadId: session.threadId });
                } catch (error) {
                    if (!isConfirmedThreadNotFound(error)) throw error;
                }
            }
            this.repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId: session.threadId });
        } catch (error) {
            this.repository.updateOperation(operation.operationId, {
                state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                lastError: error?.message || String(error),
            });
            throw error;
        }
        await this.faultInjection.afterDeleteRemoteApplied?.({ operation, session });
        const receipt = this.repository.permanentlyDeleteSession(idValue, session.threadId);
        this.attachments.clearSession(idValue);
        this.repository.updateOperation(operation.operationId, {
            state: 'completed', threadId: session.threadId,
            payload: { deletionReceiptId: receipt.receiptId },
        });
        return { deleted: true, receipt };
    }
    exportSession({ sessionId, topicId, format = 'markdown' } = {}) {
        this.ensureProjectionStore();
        const idValue = resolveSessionIdInput({ sessionId, topicId });
        const projection = this.repository.readProjection(idValue);
        if (!projection) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const safeTitle = String(projection.session.title || 'agent-session').replace(/[\\/:*?"<>|]+/g, '-');
        if (format === 'json') {
            return { format, fileName: `${safeTitle}.json`, content: `${JSON.stringify(projection, null, 2)}\n` };
        }
        const lines = [`# ${projection.session.title || 'Agent Session'}`, ''];
        for (const message of projection.messages) {
            lines.push(`## ${message.role || 'unknown'}`, '');
            for (const block of message.blocks || []) {
                const content = block.content || {};
                if (typeof content.text === 'string') lines.push(content.text);
                else if (Array.isArray(content.parts)) {
                    for (const part of content.parts) {
                        if (typeof part?.text === 'string') lines.push(part.text);
                    }
                } else lines.push('```json', JSON.stringify(content, null, 2), '```');
                lines.push('');
            }
        }
        return { format: 'markdown', fileName: `${safeTitle}.md`, content: `${lines.join('\n').trim()}\n` };
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
        const settings = this.getSettings() || {};
        return {
            runtime: 'codex-app-server',
            driver: 'codex',
            // This is a default for a *new* Session.  A selected Session has
            // its own frozen configuration in the projection database.
            permissionMode: normalizePermissionMode(
                settings.agentRuntime?.codex?.permissionMode
                    || settings.agentRuntime?.codex?.approvalPolicy,
            ),
            model: settings.agentRuntime?.codex?.model
                || settings.agentRuntime?.tui?.defaultModel
                || null,
        };
    }

    async updateWorkbenchSettings(settings = {}) {
        this.ensureProjectionStore();
        this._assertProjectionWritable();
        const hasPermissionUpdate = Object.prototype.hasOwnProperty.call(settings, 'permissionMode');
        const permissionMode = hasPermissionUpdate
            ? (settings.permissionMode === 'always-approve' ? 'always-approve' : 'ask')
            : null;
        const requestedModel = typeof settings.model === 'string' && settings.model.trim()
            ? settings.model.trim() : null;
        const hasReasoningUpdate = Object.prototype.hasOwnProperty.call(settings, 'reasoningEffort');
        const hasSystemPromptUpdate = Object.prototype.hasOwnProperty.call(settings, 'systemPrompt');
        const hasBaseInstructionsUpdate = Object.prototype.hasOwnProperty.call(settings, 'baseInstructions');
        const requestedSystemPrompt = (hasSystemPromptUpdate || hasBaseInstructionsUpdate)
            ? String(settings.baseInstructions ?? settings.systemPrompt ?? '').trim() : null;
        const hasInstructionModeUpdate = Object.prototype.hasOwnProperty.call(settings, 'instructionMode');
        const hasDeveloperInstructionsUpdate = Object.prototype.hasOwnProperty.call(settings, 'developerInstructions');
        const hasPersonalityUpdate = Object.prototype.hasOwnProperty.call(settings, 'personality');
        const hasWorkspaceUpdate = Object.prototype.hasOwnProperty.call(settings, 'workspaceRoot');
        let requestedWorkspaceRoot = null;
        if (hasWorkspaceUpdate) {
            requestedWorkspaceRoot = path.resolve(String(settings.workspaceRoot || '').trim() || this.projectRoot);
            let workspaceStat = null;
            try { workspaceStat = fs.statSync(requestedWorkspaceRoot); } catch { /* validated below */ }
            if (!workspaceStat?.isDirectory()) {
                throw new CodexAppServerError('INVALID_WORKSPACE', 'Workspace directory does not exist');
            }
        }
        const sessionId = String(settings.sessionId || settings.topicId || '').trim();
        let session = null;
        if (sessionId) {
            const current = this.repository.getSession(sessionId);
            if (!current) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
            const expectedRevision = Number(settings.expectedConfigRevision);
            if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
                throw new CodexAppServerError('SESSION_CONFIG_REVISION_REQUIRED', 'Session settings require expectedConfigRevision');
            }
            const nextInstructionMode = hasInstructionModeUpdate
                ? normalizeInstructionMode(settings.instructionMode, requestedSystemPrompt)
                : normalizeInstructionMode(current.configSnapshot?.instructionMode, current.configSnapshot?.baseInstructions);
            const nextBaseInstructions = (hasSystemPromptUpdate || hasBaseInstructionsUpdate)
                ? requestedSystemPrompt : String(current.configSnapshot?.baseInstructions || '');
            const nextDeveloperInstructions = hasDeveloperInstructionsUpdate
                ? String(settings.developerInstructions || '').trim()
                : String(current.configSnapshot?.developerInstructions || '');
            const nextPersonality = hasPersonalityUpdate
                ? normalizePersonality(settings.personality)
                : normalizePersonality(current.configSnapshot?.personality);
            const currentInstructionMode = normalizeInstructionMode(
                current.configSnapshot?.instructionMode,
                current.configSnapshot?.baseInstructions,
            );
            const requestedConfig = {
                ...(current.configSnapshot || {}),
                instructionMode: nextInstructionMode,
                baseInstructions: nextBaseInstructions,
                developerInstructions: nextDeveloperInstructions,
                personality: nextPersonality,
            };
            if (current.threadId && requiresFreshCodexManagedSession(
                requestedConfig,
                current.appliedRuntimeConfig || current.configSnapshot || {},
            )) {
                if (settings.createDerivedSession === true) {
                    const derivedPermissionMode = permissionMode || normalizePermissionMode(
                        current.configSnapshot?.permissionMode || current.configSnapshot?.approvalPolicy,
                    );
                    const derived = await this.createTopic({
                        ...current.configSnapshot,
                        ...requestedConfig,
                        agentId: current.agentId,
                        title: `${current.title || 'Agent Session'} (Codex managed)`,
                        workspaceRoot: hasWorkspaceUpdate ? requestedWorkspaceRoot : current.workspaceRoot,
                        permissionMode: derivedPermissionMode,
                        approvalPolicy: normalizeApprovalPolicy(derivedPermissionMode),
                        ...(requestedModel ? { model: requestedModel } : {}),
                    });
                    return {
                        ...this.getWorkbenchSettings(),
                        settings: {
                            permissionMode: derivedPermissionMode,
                            model: derived.configSnapshot?.model || null,
                            reasoningEffort: normalizeReasoningEffort(derived.configSnapshot?.reasoningEffort),
                        },
                        session: compatibilitySession(derived),
                        ...sessionConfigResult(derived),
                        appliesTo: 'derived-session',
                        createdDerivedSession: true,
                        sourceSessionId: current.sessionId,
                    };
                }
                throw new CodexAppServerError(
                    'IDENTITY_CHANGE_REQUIRES_NEW_SESSION',
                    'Codex 0.146 cannot clear persisted baseInstructions on this Thread; create a derived Session',
                    { requiresDerivedSession: true, requestedConfig },
                );
            }
            if (nextInstructionMode === 'vchat-identity' && !nextBaseInstructions) {
                throw new CodexAppServerError('AGENT_IDENTITY_MISSING', 'VChat identity mode requires baseInstructions');
            }
            const currentPermissionMode = normalizePermissionMode(
                current.configSnapshot?.permissionMode || current.configSnapshot?.approvalPolicy,
            );
            const nextModel = requestedModel || current.configSnapshot?.model || '';
            const reasoning = hasReasoningUpdate
                ? this._validateReasoningEffort(nextModel, settings.reasoningEffort)
                : {
                    effort: normalizeReasoningEffort(current.configSnapshot?.reasoningEffort),
                    supported: Array.isArray(current.configSnapshot?.reasoningEfforts)
                        ? current.configSnapshot.reasoningEfforts : this._reasoningEffortsForModel(nextModel),
                };
            const updated = this.repository.updateSessionConfig(sessionId, expectedRevision, {
                workspaceRoot: hasWorkspaceUpdate ? requestedWorkspaceRoot : current.workspaceRoot,
                configSnapshot: {
                    ...(current.configSnapshot || {}),
                    permissionMode: permissionMode || currentPermissionMode,
                    approvalPolicy: normalizeApprovalPolicy(permissionMode || currentPermissionMode),
                    ...(requestedModel ? { model: requestedModel } : {}),
                    instructionMode: nextInstructionMode,
                    baseInstructions: nextBaseInstructions,
                    developerInstructions: nextDeveloperInstructions,
                    personality: nextPersonality,
                    reasoningEffort: reasoning.effort,
                    reasoningEfforts: reasoning.supported,
                },
            });
            if (!updated.updated) {
                throw new CodexAppServerError('SESSION_CONFIG_CONFLICT', 'Session settings changed in another view', {
                    current: updated.session,
                });
            }
            session = updated.session;
            this._sendSessionConfigEvent('session.config.saved', session);
            this._scheduleSessionConfigApply(session.sessionId);
        } else if ((requestedModel || hasPermissionUpdate) && this.setSettings) {
            // Keep the global setting path narrow: this is only the default
            // for future Sessions.  Existing Sessions always use their frozen
            // configSnapshot and are never silently rewritten.
            await this.setSettings((current) => ({
                ...current,
                agentRuntime: {
                    ...(current?.agentRuntime || {}),
                    codex: {
                        ...(current?.agentRuntime?.codex || {}),
                        ...(requestedModel ? { model: requestedModel } : {}),
                        ...(hasPermissionUpdate ? { permissionMode } : {}),
                    },
                },
            }));
        }
        const effectivePermissionMode = session
            ? normalizePermissionMode(session.configSnapshot?.permissionMode || session.configSnapshot?.approvalPolicy)
            : (permissionMode || this.getWorkbenchSettings().permissionMode);
        const effectiveModel = session?.configSnapshot?.model || requestedModel || this.getWorkbenchSettings().model || null;
        return {
            ...this.getWorkbenchSettings(),
            settings: {
                permissionMode: effectivePermissionMode,
                ...(effectiveModel ? { model: effectiveModel } : {}),
                reasoningEffort: normalizeReasoningEffort(session?.configSnapshot?.reasoningEffort),
            },
            session: session ? compatibilitySession(session) : null,
            desiredConfig: session?.configSnapshot || null,
            appliedRuntimeConfig: session?.appliedRuntimeConfig || null,
            configRevision: session?.configRevision || null,
            appliedRuntimeConfigRevision: session?.appliedRuntimeConfigRevision || 0,
            applyState: session?.configApplyState || null,
            applyError: session?.configApplyError || null,
            appliesTo: session ? 'next-turn' : 'new-sessions',
        };
    }

    async updateSessionConfig({ sessionId, topicId, expectedConfigRevision, patch } = {}) {
        const resolvedSessionId = resolveSessionIdInput({ sessionId, topicId });
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new CodexAppServerError('INVALID_INPUT', 'Session config patch must be an object');
        }
        const allowedFields = new Set([
            'instructionMode', 'baseInstructions', 'systemPrompt',
            'developerInstructions', 'personality', 'model',
            'reasoningEffort', 'workspaceRoot', 'permissionMode',
            'createDerivedSession',
        ]);
        const unknownFields = Object.keys(patch).filter((field) => !allowedFields.has(field));
        if (unknownFields.length) {
            throw new CodexAppServerError('INVALID_INPUT', `Unsupported Session config fields: ${unknownFields.join(', ')}`);
        }
        return this.updateWorkbenchSettings({
            ...patch,
            sessionId: resolvedSessionId,
            expectedConfigRevision,
        });
    }

    readSessionConfig({ sessionId } = {}) {
        this.ensureProjectionStore();
        const session = this.repository.getSession(String(sessionId || '').trim());
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        return sessionConfigResult(session);
    }

    _sendSessionConfigEvent(type, session, error = null) {
        if (!session) return;
        this._sendUiEvent({
            type,
            topicId: session.sessionId,
            sessionId: session.sessionId,
            threadId: session.threadId || null,
            payload: { ...sessionConfigResult(session), ...(error ? { error: String(error) } : {}) },
        });
    }

    _scheduleSessionConfigApply(sessionId) {
        queueMicrotask(() => {
            void this._applySessionRuntimeConfig(sessionId).catch((error) => {
                this.lastError = serializeError(error);
            });
        });
    }

    async _applySessionRuntimeConfig(sessionId, { barrier = false } = {}) {
        const idValue = String(sessionId || '').trim();
        if (this.configApplyPromises.has(idValue)) return this.configApplyPromises.get(idValue);
        const apply = (async () => {
            let session = this.repository.getSession(idValue);
            if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
            if (!session.threadId) return session;
            if (session.appliedRuntimeConfigRevision === session.configRevision
                && session.configApplyState === 'applied') return session;
            const desired = normalizeSessionConfig(session.configSnapshot || {});
            const applied = normalizeSessionConfig(session.appliedRuntimeConfig || {});
            if (requiresFreshCodexManagedSession(desired, applied)) {
                const error = new CodexAppServerError('IDENTITY_CHANGE_REQUIRES_NEW_SESSION',
                    'Codex-managed instructions require a derived Session for this Thread');
                session = this.repository.markSessionConfigFailed(idValue, session.configRevision, error.message);
                this._sendSessionConfigEvent('session.config.failed', session, error.message);
                throw error;
            }
            session = this.repository.markSessionConfigApplying(idValue, session.configRevision);
            this._sendSessionConfigEvent('session.config.pending', session);
            try {
                await this.start();
                const generation = this._captureGeneration();
                if (!this.resumedThreadIds.has(session.threadId)) {
                    await this._resumeSession(session);
                    this._assertGeneration(generation);
                    return this.repository.getSession(idValue);
                }
                if (instructionConfigChanged(desired, applied)) {
                    const activity = this.threadStates.get(session.threadId)?.activity;
                    if (activity === 'running') {
                        if (barrier) throw new CodexAppServerError('SESSION_CONFIG_PENDING',
                            'Instruction changes will be applied after the active Turn finishes');
                        return this.repository.getSession(idValue);
                    }
                    await this.transport.request('thread/unsubscribe', { threadId: session.threadId });
                    this._assertGeneration(generation);
                    this.resumedThreadIds.delete(session.threadId);
                    await this._resumeSession(this.repository.getSession(idValue));
                    this._assertGeneration(generation);
                    return this.repository.getSession(idValue);
                }
                const target = {
                    sessionId: idValue,
                    revision: session.configRevision,
                    snapshot: desired,
                    runtimeGeneration: this.runtimeGeneration,
                };
                this.configApplyTargets.set(session.threadId, target);
                await this.transport.request('thread/settings/update', threadSettingsPatch(session, desired));
                this._assertGeneration(generation);
                if (!barrier) return this.repository.getSession(idValue);
                return this.repository.getSession(idValue);
            } catch (error) {
                if (error?.code === 'STALE_RUNTIME_GENERATION' || !this.repository) throw error;
                const current = this.repository.getSession(idValue);
                if (current?.configRevision === session.configRevision
                    && error?.code !== 'SESSION_CONFIG_PENDING') {
                    const failed = this.repository.markSessionConfigFailed(idValue, session.configRevision, error.message);
                    this._sendSessionConfigEvent('session.config.failed', failed, error.message);
                }
                throw error;
            }
        })().finally(() => this.configApplyPromises.delete(idValue));
        this.configApplyPromises.set(idValue, apply);
        return apply;
    }

    async applyAgentProfileToSession({
        sessionId, expectedConfigRevision, previewOnly = false, createNewSession = false,
    } = {}) {
        this.ensureProjectionStore();
        this._assertProjectionWritable();
        const session = this.repository.getSession(String(sessionId || ''));
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const profile = this._resolveAgentProfile(session.agentCatalogId || session.agentId);
        if (!profile) throw new CodexAppServerError('NOT_FOUND', 'Build Agent Profile was not found');
        const differences = [];
        const addDifference = (field, current, next, identity = false) => {
            if (String(current ?? '') !== String(next ?? '')) differences.push({ field, current: current ?? null, next: next ?? null, identity });
        };
        const profileMode = normalizeInstructionMode(
            profile.instructionMode,
            profile.baseInstructions || profile.systemPrompt,
        );
        addDifference(
            'instructionMode',
            normalizeInstructionMode(session.configSnapshot?.instructionMode, session.configSnapshot?.baseInstructions),
            profileMode,
            true,
        );
        addDifference('baseInstructions', session.configSnapshot?.baseInstructions || '', profile.baseInstructions || profile.systemPrompt || '', profileMode === 'vchat-identity');
        addDifference('developerInstructions', session.configSnapshot?.developerInstructions || '', profile.developerInstructions || '', profileMode === 'codex-managed');
        addDifference('personality', normalizePersonality(session.configSnapshot?.personality), normalizePersonality(profile.personality), profileMode === 'codex-managed');
        const profileWorkspace = profile.workspaceRoot ? path.resolve(profile.workspaceRoot) : session.workspaceRoot;
        addDifference('workspaceRoot', session.workspaceRoot || '', profileWorkspace || '', true);
        addDifference('name', session.agentNameSnapshot || session.configSnapshot?.agentName || '', profile.name || '');
        addDifference('avatar', session.configSnapshot?.agentAvatar || '', profile.avatarUrl || '');
        addDifference('model', session.configSnapshot?.model || '', profile.model || session.configSnapshot?.model || '');
        addDifference('reasoningEffort', session.configSnapshot?.reasoningEffort || '', profile.reasoningEffort || '');
        addDifference('permissionMode', normalizePermissionMode(session.configSnapshot?.permissionMode), normalizePermissionMode(profile.permissionMode));
        addDifference('profileRevision', Number(session.configSnapshot?.profileRevision || 1), Number(profile.revision || 1));
        const identityChanges = differences.filter((entry) => entry.identity).map((entry) => entry.field);
        if (previewOnly) {
            return {
                applied: false,
                requiresNewSession: Boolean(session.threadId && identityChanges.length),
                identityChanges,
                differences,
                profile: { id: profile.id, revision: Number(profile.revision || 1) },
            };
        }
        if (session.threadId && identityChanges.length) {
            if (!createNewSession) return {
                applied: false,
                requiresNewSession: true,
                identityChanges,
                differences,
                profile: { id: profile.id, revision: Number(profile.revision || 1) },
            };
            const created = await this.createTopic({
                agentId: profile.id,
                title: `${session.title || profile.name || 'Agent'}（Profile 更新）`,
                workspaceRoot: profileWorkspace,
                model: profile.model || session.configSnapshot?.model,
                permissionMode: profile.permissionMode,
                instructionMode: profileMode,
                baseInstructions: profile.baseInstructions || profile.systemPrompt || '',
                developerInstructions: profile.developerInstructions || '',
                personality: profile.personality,
                reasoningEffort: profile.reasoningEffort,
            });
            return { applied: false, createdNewSession: true, requiresNewSession: true, differences, session: created };
        }
        const permissionMode = normalizePermissionMode(profile.permissionMode);
        const updated = this.repository.updateSessionConfig(session.sessionId, Number(expectedConfigRevision), {
            workspaceRoot: profileWorkspace,
            agentNameSnapshot: profile.name || session.agentNameSnapshot,
            configSnapshot: {
                ...(session.configSnapshot || {}),
                profileId: profile.id,
                profileRevision: Number(profile.revision || 1),
                instructionMode: profileMode,
                baseInstructions: profile.baseInstructions || profile.systemPrompt || '',
                developerInstructions: String(profile.developerInstructions || ''),
                personality: normalizePersonality(profile.personality),
                agentName: profile.name || session.agentNameSnapshot || '',
                agentAvatar: profile.avatarUrl || session.configSnapshot?.agentAvatar || '',
                model: profile.model || session.configSnapshot?.model,
                reasoningEffort: normalizeReasoningEffort(profile.reasoningEffort),
                reasoningEfforts: Array.isArray(profile.reasoningEfforts) ? profile.reasoningEfforts : [],
                permissionMode,
                approvalPolicy: normalizeApprovalPolicy(permissionMode),
                provider: 'vcp_toolbox',
                executionProfile: 'toolbox-only',
            },
        });
        if (!updated.updated) throw new CodexAppServerError('SESSION_CONFIG_CONFLICT', 'Session settings changed in another view', {
            current: updated.session,
        });
        return { applied: true, requiresNewSession: false, differences, session: compatibilitySession(updated.session) };
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
        const settings = this.getSettings() || {};
        const toolboxConfigured = Boolean(settings.vcpServerUrl && settings.vcpApiKey);
        const agentId = explicitAgent(options.agentId || options.agent) || 'codex';
        const profile = this._resolveAgentProfile(agentId);
        const provider = options.provider || (profile ? 'vcp_toolbox' : (toolboxConfigured ? 'vcp_toolbox' : 'codex'));
        const permissionMode = normalizePermissionMode(
            options.permissionMode || options.approvalPolicy || profile?.permissionMode,
        );
        const model = options.model || profile?.model || settings.agentRuntime?.codex?.model
                || settings.agentRuntime?.tui?.defaultModel
                || (toolboxConfigured ? 'Nova' : 'gpt-5.1-codex');
        const baseInstructions = options.baseInstructions ?? options.systemPrompt
            ?? profile?.baseInstructions ?? profile?.systemPrompt ?? '';
        const requestedInstructionMode = options.instructionMode ?? profile?.instructionMode;
        const instructionMode = requestedInstructionMode
            ? normalizeInstructionMode(requestedInstructionMode, baseInstructions)
            : (!String(baseInstructions || '').trim() && sameIdentity(agentId, 'codex')
                ? 'codex-managed' : 'vchat-identity');
        const reasoning = this._validateReasoningEffort(
            model,
            options.reasoningEffort ?? profile?.reasoningEffort,
            { supported: options.reasoningEfforts || profile?.reasoningEfforts },
        );
        return {
            model,
            instructionMode,
            personality: normalizePersonality(options.personality ?? profile?.personality),
            permissionMode,
            approvalPolicy: normalizeApprovalPolicy(permissionMode),
            sandbox: normalizeSandboxMode(options.sandbox),
            // The Agent catalog's `systemPrompt` is the VChat identity (e.g.
            // `{{Nova}}`, expanded by VCPToolBox). It must replace Codex's
            // built-in system prompt via `baseInstructions`; `developerInstructions`
            // only appends and cannot suppress the "You are Codex" default.
            baseInstructions: String(baseInstructions || '').trim(),
            developerInstructions: String(options.developerInstructions ?? profile?.developerInstructions ?? '').trim(),
            reasoningEffort: reasoning.effort,
            reasoningEfforts: reasoning.supported,
            agentName: options.agentName || options.name || profile?.name || '',
            agentAvatar: options.agentAvatar || options.avatar || profile?.avatarUrl
                || this._agentAvatarUrl(profile?.id || agentId),
            profileId: profile?.id || agentId,
            profileRevision: Number(profile?.revision || 1),
            provider,
            executionProfile: options.executionProfile
                || (profile || provider === 'vcp_toolbox' ? 'toolbox-only' : 'codex-native'),
        };
    }

    _resolveAgentProfile(agentId) {
        this._ensureDefaultAgentProfile();
        const wanted = String(agentId || '').trim();
        if (!wanted || !this.agentsDir || !fs.existsSync(this.agentsDir)) return null;
        const readConfig = (directory) => {
            try {
                const value = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
                return value && typeof value === 'object'
                    ? normalizeProfile(value, path.basename(directory)) : null;
            } catch {
                return null;
            }
        };
        if (!/[\\/:*?"<>|]/.test(wanted)) {
            const direct = readConfig(path.join(this.agentsDir, wanted));
            if (direct) return { ...direct, id: wanted, avatarUrl: this._agentAvatarUrl(wanted, direct) };
        }
        try {
            for (const entry of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const profile = readConfig(path.join(this.agentsDir, entry.name));
                if (profile && (sameIdentity(entry.name, wanted) || sameIdentity(profile.name, wanted))) {
                    return { ...profile, id: entry.name, avatarUrl: this._agentAvatarUrl(entry.name, profile) };
                }
            }
        } catch {
            return null;
        }
        return null;
    }

    _agentCatalog() {
        this._ensureDefaultAgentProfile();
        if (!this.agentsDir || !fs.existsSync(this.agentsDir)) return [];
        const result = [];
        try {
            for (const entry of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                try {
                    const config = normalizeProfile(
                        JSON.parse(fs.readFileSync(path.join(this.agentsDir, entry.name, 'config.json'), 'utf8')),
                        entry.name,
                    );
                    result.push({ catalogId: entry.name, name: String(config?.name || entry.name), profile: config || {} });
                } catch {
                    // Invalid Agent folders are not identities and must not be
                    // guessed from their directory name alone.
                }
            }
        } catch {
            return [];
        }
        return result;
    }

    _ensureDefaultAgentProfile() {
        const directory = path.join(this.agentsDir, 'Nova');
        const configPath = path.join(directory, 'config.json');
        if (fs.existsSync(configPath)) return;
        if (fs.existsSync(this.agentsDir)) {
            try {
                for (const entry of fs.readdirSync(this.agentsDir, { withFileTypes: true })) {
                    if (!entry.isDirectory()) continue;
                    try {
                        const config = JSON.parse(fs.readFileSync(path.join(this.agentsDir, entry.name, 'config.json'), 'utf8'));
                        if (sameIdentity(entry.name, 'Nova') || sameIdentity(config?.name, 'Nova')) return;
                    } catch {
                        // Invalid folders do not suppress the safe default.
                    }
                }
            } catch {
                // Directory creation below remains the fail-safe path.
            }
        }
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(configPath, `${JSON.stringify({
            schemaVersion: PROFILE_SCHEMA_VERSION, profileId: 'Nova', profileRevision: 1,
            name: 'Nova', systemPrompt: '{{Nova}}', baseInstructions: '{{Nova}}', revision: 1,
            executionProfile: 'toolbox-only', permissionMode: 'ask',
        }, null, 2)}\n`, 'utf8');
    }

    _agentAvatarUrl(agentId, profileConfig = null) {
        const directory = path.join(this.agentsDir, String(agentId || ''));
        let configured = profileConfig;
        if (!configured) {
            try { configured = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')); } catch { configured = null; }
        }
        const avatarFile = safeAvatarFile(configured?.avatarFile);
        if (avatarFile) {
            const configuredPath = path.join(directory, avatarFile);
            if (fs.existsSync(configuredPath)) return pathToFileURL(configuredPath).toString();
        }
        for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp']) {
            const avatarPath = path.join(directory, `avatar${ext}`);
            if (fs.existsSync(avatarPath)) return pathToFileURL(avatarPath).toString();
        }
        return '';
    }

    _resolveCanonicalAgent(value, { failOnAmbiguous = false } = {}) {
        const wanted = String(value || '').trim();
        if (!wanted) return null;
        const catalog = this._agentCatalog();
        const direct = catalog.find((entry) => sameIdentity(entry.catalogId, wanted));
        if (direct) return direct;
        const byName = catalog.filter((entry) => sameIdentity(entry.name, wanted));
        if (byName.length === 1) return byName[0];
        if (byName.length > 1 && failOnAmbiguous) {
            throw new CodexAppServerError('AGENT_IDENTITY_AMBIGUOUS', `Agent name ${wanted} matches multiple catalog entries`);
        }
        return byName.length === 1 ? byName[0] : { catalogId: wanted, name: wanted, profile: null };
    }

    _repairSessionIdentity(session) {
        if (!session) return session;
        if (this.repository?.readOnly) return session;
        const current = String(session.agentCatalogId || '').trim();
        const identity = this._resolveCanonicalAgent(current || session.agentId, { failOnAmbiguous: false });
        if (!identity || (!identity.profile && current)) return session;
        const nextCatalogId = identity.catalogId || current || session.agentId;
        const nextName = session.agentNameSnapshot || identity.name || session.configSnapshot?.agentName || session.agentId;
        if (sameIdentity(current, nextCatalogId) && session.agentNameSnapshot === nextName
            && sameIdentity(session.agentId, nextCatalogId)) return session;
        return this.repository.saveSession({
            ...session,
            agentId: nextCatalogId,
            agentCatalogId: nextCatalogId,
            agentNameSnapshot: nextName,
            updatedAt: Date.now(),
        });
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
        if (!session) return session;
        if (this.repository?.readOnly) return session;
        const original = session.configSnapshot || {};
        const config = { ...original };
        const profile = this._resolveAgentProfile(session.agentId);
        const baseInstructions = String(config.baseInstructions || '').trim();
        const developerInstructions = String(config.developerInstructions || '').trim();
        const placeholder = /^\{\{([^{}]+)\}\}$/.exec(developerInstructions);
        let identityRepaired = false;

        if (!baseInstructions && placeholder && (
            sameIdentity(placeholder[1], session.agentId)
            || sameIdentity(placeholder[1], profile?.name)
        )) {
            config.baseInstructions = developerInstructions;
            config.developerInstructions = '';
            identityRepaired = true;
        } else if (!baseInstructions && !developerInstructions && String(profile?.systemPrompt || '').trim()) {
            config.baseInstructions = String(profile.systemPrompt).trim();
            config.agentName = config.agentName || profile.name || '';
            identityRepaired = true;
        }

        if (!config.instructionMode) {
            config.instructionMode = String(config.baseInstructions || '').trim()
                ? 'vchat-identity' : 'codex-managed';
            config.personality = 'none';
            identityRepaired = true;
        }

        if (!config.executionProfile) {
            config.executionProfile = 'toolbox-only';
        }
        if (identityRepaired) config.identityMigrationVersion = 1;
        if (JSON.stringify(config) === JSON.stringify(original)) return session;
        return this.repository.saveSession({ ...session, configSnapshot: config, updatedAt: Date.now() });
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
        const wanted = String(modelId || '').trim();
        if (!wanted) return [];
        const models = this.getModels?.() || [];
        const model = (Array.isArray(models) ? models : []).find((entry) => {
            const idValue = typeof entry === 'string' ? entry : entry?.id || entry?.name;
            return String(idValue || '').trim() === wanted;
        });
        return reasoningEffortsFromModel(model);
    }

    _validateReasoningEffort(modelId, value, { supported } = {}) {
        const effort = normalizeReasoningEffort(value);
        const advertised = Array.isArray(supported) && supported.length
            ? [...new Set(supported.map((item) => String(item || '').trim()).filter(Boolean))]
            : this._reasoningEffortsForModel(modelId);
        if (effort && !advertised.includes(effort)) {
            throw new CodexAppServerError(
                'REASONING_EFFORT_UNSUPPORTED',
                `Model ${modelId || '(default)'} does not advertise reasoning effort ${effort}`,
                { model: modelId || null, supported: advertised },
            );
        }
        return { effort, supported: advertised };
    }

    _effectiveReasoningEffort(config = {}) {
        return this._validateReasoningEffort(config.model, config.reasoningEffort, {
            supported: config.reasoningEfforts,
        }).effort;
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
        const settings = this.getSettings() || {};
        if (!settings.vcpServerUrl || !settings.vcpApiKey || !this.responsesAdapter?.baseUrl) return {};
        return {
            modelProvider: 'vcp_toolbox',
            config: {
                'model_providers.vcp_toolbox.name': 'VCPToolBox compatibility adapter',
                'model_providers.vcp_toolbox.base_url': this.responsesAdapter.baseUrl,
                'model_providers.vcp_toolbox.env_key': 'VCP_CODEX_RESPONSES_ADAPTER_CAPABILITY',
                'model_providers.vcp_toolbox.wire_api': 'responses',
                'model_providers.vcp_toolbox.requires_openai_auth': false,
            },
        };
    }

    async _ensureResponsesAdapter(settings = this.getSettings() || {}) {
        if (this.responsesAdapter) return this.responsesAdapter.start();
        if (!settings.vcpServerUrl || !settings.vcpApiKey) return null;
        this.responsesAdapter = this.responsesAdapterFactory({
            toolboxUrl: settings.vcpServerUrl,
            toolboxApiKey: settings.vcpApiKey,
            onRequest: (identity) => this._diagnostic('toolbox-response-request', identity),
            resolveInstructions: ({ threadId, sessionId: providerSessionId }) => {
                const session = threadId ? this.repository?.getSessionByThread(threadId) : null;
                if (!session) {
                    throw new CodexAppServerError('SESSION_NOT_FOUND', 'ToolBox request is not bound to a known VChat Agent Session');
                }
                if (session.configSnapshot?.executionProfile !== 'toolbox-only') {
                    throw new CodexAppServerError('PROFILE_MISMATCH', 'Only toolbox-only Threads may use the VCPToolBox Responses adapter');
                }
                // Codex's `x-codex-turn-metadata.session_id` is the App Server
                // provider/session identity. In 0.146 it is the public Codex
                // Thread id, not VChat's durable `session_...` primary key.
                // Compare it to the Thread resolved above; comparing it to
                // the VChat Session id rejects every real provider request.
                if (providerSessionId && providerSessionId !== session.threadId) {
                    throw new CodexAppServerError('SESSION_IDENTITY_MISMATCH', 'ToolBox provider session identity does not match its Codex Thread');
                }
                const appliedConfig = session.appliedRuntimeConfigRevision > 0
                    ? session.appliedRuntimeConfig : session.configSnapshot;
                const mode = normalizeInstructionMode(
                    appliedConfig?.instructionMode,
                    appliedConfig?.baseInstructions,
                );
                return mode === 'codex-managed'
                    ? {
                        mode,
                        developerInstructions: String(appliedConfig?.developerInstructions || ''),
                        personality: normalizePersonality(appliedConfig?.personality),
                    }
                    : { mode, baseInstructions: String(appliedConfig?.baseInstructions || '') };
            },
        });
        try {
            await this.responsesAdapter.start();
            return this.responsesAdapter;
        } catch (error) {
            await this.responsesAdapter.stop?.().catch(() => null);
            this.responsesAdapter = null;
            throw new CodexAppServerError('TOOLBOX_ADAPTER_START_FAILED', 'VCPToolBox Responses adapter failed to start', {
                cause: error?.message || String(error),
            });
        }
    }

    // The ToolBox endpoint/key are Main-only configuration.  A settings
    // change is not a harmless display refresh: every pending approval and
    // dynamic invocation belongs to the old authority and must fail closed
    // before a new bridge process is allowed to connect.
    async refreshToolboxConfiguration(settings = this.getSettings() || {}) {
        const nextFingerprint = toolboxConfigFingerprint(settings);
        if (nextFingerprint === this.toolboxConfigFingerprint && !this.toolboxReconfiguration) return this.getStatus();
        if (nextFingerprint !== this.toolboxRequestedFingerprint) {
            this.toolboxRequestedSettings = { ...settings };
            this.toolboxRequestedFingerprint = nextFingerprint;
            this.toolboxRequestedGeneration += 1;
        }
        const targetGeneration = this.toolboxRequestedGeneration;
        if (!this.toolboxReconfiguration) {
            this.toolboxReconfiguration = this._drainToolboxConfiguration().finally(() => {
                this.toolboxReconfiguration = null;
            });
        }
        const result = await this.toolboxReconfiguration;
        if (this.toolboxAppliedGeneration < targetGeneration) {
            return this.refreshToolboxConfiguration(this.toolboxRequestedSettings || settings);
        }
        return result;
    }

    async _drainToolboxConfiguration() {
        let lastError = null;
        while (this.toolboxAppliedGeneration < this.toolboxRequestedGeneration) {
            const generation = this.toolboxRequestedGeneration;
            const settings = this.toolboxRequestedSettings || {};
            const fingerprint = this.toolboxRequestedFingerprint;
            try {
                await this._applyToolboxConfiguration(settings, fingerprint);
                lastError = null;
            } catch (error) {
                lastError = error;
            }
            this.toolboxAppliedGeneration = generation;
            if (generation === this.toolboxRequestedGeneration && lastError) throw lastError;
        }
        return this.getStatus();
    }

    async _applyToolboxConfiguration(settings, nextFingerprint) {
        if (this.state !== 'ready') {
            this.toolboxConfigFingerprint = nextFingerprint;
            return this.getStatus();
        }
        const reason = 'VCPToolBox connection settings changed';
        await this._failClosedToolboxApprovals(reason);
        await this._interruptDynamicCalls(reason);
        this.interactions.clear({ source: 'toolbox' });
        this.toolboxAuthorityGeneration += 1;
        this.interactions.setGeneration('toolbox', this.toolboxAuthorityGeneration);

        // Detach the old bridge before changing any credentials.  Its
            // stop path closes observer sockets and rejects process waiters;
            // no invoke/interrupt can cross from the old host to the new one.
        const oldBridge = this.bridge;
        this.bridge = null;
        await oldBridge?.stop().catch((error) => {
            this.emit('diagnostic', `Could not stop old ToolBox bridge: ${error.message}`);
        });

        const configured = hasToolboxConfiguration(settings);
        try {
                if (!configured) {
                    await this.responsesAdapter?.stop().catch(() => null);
                    this.responsesAdapter = null;
                } else if (this.responsesAdapter?.reconfigure) {
                    // `reconfigure` validates before assigning, so a malformed
                    // URL/key cannot partially replace the current adapter.
                    await this.responsesAdapter.reconfigure({
                        toolboxUrl: settings.vcpServerUrl,
                        toolboxApiKey: settings.vcpApiKey,
                    });
                } else {
                    // Test/custom adapters that do not support in-place update
                    // are replaced rather than silently using stale settings.
                    await this.responsesAdapter?.stop().catch(() => null);
                    this.responsesAdapter = null;
                    await this._ensureResponsesAdapter(settings);
                }
                if (configured) await this._ensureBridge(settings);
                this.toolboxConfigFingerprint = nextFingerprint;
                this._sendUiEvent({
                    type: 'toolbox.connection.reconfigured',
                    payload: { configured },
                });
        } catch (error) {
                // Never fall back to the old bridge after a failed update.
                // For an invalid incoming config stop the adapter as well, so
                // subsequent model turns cannot keep using old credentials.
                await this.responsesAdapter?.stop().catch(() => null);
                this.responsesAdapter = null;
                this.lastError = serializeError(error);
                this._sendUiEvent({
                    type: 'runtime.warning',
                    payload: { warning: 'VCPToolBox connection update failed; VCP tools are unavailable.' },
                });
            throw error;
        }
        return this.getStatus();
    }

    _wireTransport() {
        if (this._transportWired) return;
        this._transportWired = true;
        this.transport.on('notification', (message) => {
            const projected = this.projector?.projectNotification(message);
            this._observeCompactionNotification(message);
            const threadId = message?.params?.threadId || message?.params?.thread?.id || null;
            const session = threadId ? this.repository?.getSessionByThread(threadId) : null;
            if (message.method === 'thread/settings/updated' && session) {
                const target = this.configApplyTargets.get(threadId);
                if (target && target.runtimeGeneration === this.runtimeGeneration) {
                    const applied = this.repository.markSessionConfigApplied(
                        target.sessionId, target.revision, target.snapshot,
                    );
                    this.configApplyTargets.delete(threadId);
                    if (applied?.appliedRuntimeConfigRevision === target.revision) {
                        this._sendSessionConfigEvent('session.config.applied', applied);
                    }
                }
            }
            this._updateThreadState(message, session);
            const itemId = notificationItemId(message);
            const projectionMessage = projected && session && itemId
                ? this.repository.getProjectedMessageByItem(session.sessionId, itemId)
                : null;
            const event = session ? {
                runtime: 'codex',
                type: 'projection.updated',
                method: message.method,
                topicId: session.sessionId,
                sessionId: session.sessionId,
                threadId,
                turnId: message?.params?.turnId || message?.params?.turn?.id || null,
                turnStatus: message?.params?.turn?.status || null,
                itemId,
                projectionMessage,
                activity: this.threadStates.get(threadId)?.activity || 'idle',
            } : { runtime: 'codex', ...message };
            this.sendEvent(event);
            this.emit('event', event);
        });
        this.transport.on('server-request', (message) => {
            if (message.method === 'item/tool/call') {
                void this._handleDynamicToolCall(message);
                return;
            }
            this.interactionService.acceptServerRequest(message);
        });
        this.transport.on('exit', (error) => {
            if (this.intentionalStop) return;
            void this._handleTransportCrash(error);
        });
        this.transport.on('stderr', (line) => this.emit('diagnostic', line));
    }

    _observeCompactionNotification(message) {
        const params = message?.params || {};
        const item = params.item;
        if (!item || item.type !== 'contextCompaction' || !params.threadId) return;
        const waiter = this.compactionWaiters.get(params.threadId);
        if (!waiter) return;
        if (message.method === 'item/started') {
            this._sendUiEvent({ type: 'compaction.started', topicId: waiter.sessionId, sessionId: waiter.sessionId,
                payload: { itemId: item.id || null } });
            return;
        }
        if (message.method !== 'item/completed') return;
        this.compactionWaiters.delete(params.threadId);
        clearTimeout(waiter.timeout);
        const failed = ['failed', 'error', 'cancelled', 'interrupted'].includes(String(item.status || '').toLowerCase());
        if (failed) {
            const error = new CodexAppServerError('COMPACTION_FAILED', item.message || 'Codex context compaction failed');
            waiter.reject(error);
            this._sendUiEvent({ type: 'compaction.failed', topicId: waiter.sessionId, sessionId: waiter.sessionId,
                payload: { itemId: item.id || null, reason: error.message } });
            return;
        }
        void this.readTopic({ sessionId: waiter.sessionId }).then((snapshot) => {
            waiter.resolve({ sessionId: waiter.sessionId, threadId: waiter.threadId, itemId: item.id || null, snapshot });
            this._sendUiEvent({ type: 'compaction.completed', topicId: waiter.sessionId, sessionId: waiter.sessionId,
                payload: { itemId: item.id || null } });
        }).catch((error) => {
            waiter.reject(error);
            this._sendUiEvent({ type: 'compaction.failed', topicId: waiter.sessionId, sessionId: waiter.sessionId,
                payload: { itemId: item.id || null, reason: error.message } });
        });
    }

    _rejectCompactionWaiters(error) {
        for (const [threadId, waiter] of this.compactionWaiters) {
            this.compactionWaiters.delete(threadId);
            clearTimeout(waiter.timeout);
            waiter.reject(error);
            this._sendUiEvent({ type: 'compaction.failed', topicId: waiter.sessionId, sessionId: waiter.sessionId,
                payload: { reason: error.message } });
        }
    }

    async _ensureBridge(settings = this.getSettings() || {}) {
        if (this.bridge) return this.bridge.start();
        const bridgeName = process.platform === 'win32' ? 'vcp-toolbox-bridge.exe' : 'vcp-toolbox-bridge';
        const candidates = [
            process.env.VCP_TOOLBOX_BRIDGE,
            process.resourcesPath && path.join(process.resourcesPath, bridgeName),
            path.join(this.projectRoot, 'rust', 'target', 'release', bridgeName),
        ].filter(Boolean);
        const bridgePath = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
        if (!settings.vcpServerUrl || !settings.vcpApiKey || !fs.existsSync(bridgePath)) return null;
        this.bridge = this.bridgeFactory({
            projectRoot: this.projectRoot,
            executable: bridgePath,
            env: {
                VCP_TOOLBOX_URL: settings.vcpServerUrl,
                VCP_TOOLBOX_API_KEY: settings.vcpApiKey,
            },
        });
        this.bridge.on('stderr', (line) => this.emit('diagnostic', `[toolbox-bridge] ${line}`));
        this.bridge.on('event', (message) => this._handleBridgeEvent(message));
        await this.bridge.start();
        return this.bridge;
    }

    async _handleTransportCrash(error) {
        this.state = 'crashed';
        this.lastError = serializeError(error);
        this.lifecycle.invalidate('Codex App Server crashed');
        this.runtimeGeneration = this.lifecycle.value;
        this.generationScope = this.lifecycle.capture();
        this.runtimeGeneration += 1;
        if (this.repository && !this.repository.readOnly) {
            for (const [threadId, threadState] of this.threadStates) {
                if (threadState?.activity !== 'running') continue;
                const session = this.repository.getSessionByThread(threadId);
                if (!session) continue;
                this.repository.saveSession({ ...session, state: 'interrupted', updatedAt: Date.now() });
                this.repository.updateActivity(session.sessionId, {
                    runtimeState: 'crashed',
                    deliveryState: 'unconfirmed',
                    interruptedTurnId: threadState.activeTurnId || null,
                });
            }
        }
        this.threadStates.clear();
        this.resumedThreadIds.clear();
        this.resumingThreads.clear();
        this.configApplyPromises.clear();
        this.configApplyTargets.clear();
        this._rejectCompactionWaiters(new CodexAppServerError('RUNTIME_CRASHED', 'Codex App Server crashed during compaction'));
        await this._failClosedNativeApprovals('Codex App Server crashed', { respond: false });
        await this._interruptDynamicCalls('Codex App Server crashed');
        await this._failClosedToolboxApprovals('Codex App Server crashed');
        this.interactions.clear({ source: 'codex-native' });
        this.interactions.clear({ source: 'toolbox' });
        this.interactionService.clearTimers();
        this.knownOperationRecoveryPromise = null;
        this.transport = null;
        this._transportWired = false;
        this.sendEvent({ runtime: 'codex', type: 'runtime.crashed', error: this.lastError });
        this.emit('event', { runtime: 'codex', type: 'runtime.crashed', error: this.lastError });
    }

    async _failClosedNativeApprovals(reason, options = {}) {
        return this.interactionService.failClosedNativeApprovals(reason, options);
    }

    _failClosedServerRequest(message, reason) {
        return this.interactionService.failClosedServerRequest(message, reason);
    }

    async _interruptDynamicCalls(reason) {
        const calls = [...this.dynamicCalls.values()];
        this.dynamicCalls.clear();
        for (const [requestId, request] of [...this.serverRequests.entries()]) {
            if (request.method === 'item/tool/call') this.serverRequests.delete(requestId);
        }
        await Promise.all(calls.map(async (call) => {
            try {
                await this.bridge?.interrupt(call.bridgeRequestId);
            } catch (error) {
                this.emit('diagnostic', `Could not interrupt ToolBox dynamic call ${call.bridgeRequestId}: ${error.message}`);
            }
        }));
        if (calls.length) {
            this._sendUiEvent({
                type: 'runtime.warning',
                payload: { warning: `${calls.length} VCP dynamic call(s) were interrupted: ${reason}` },
            });
        }
    }

    async _resumeSession(session) {
        const generation = this._captureGeneration();
        const threadId = String(session?.threadId || '').trim();
        if (!threadId) throw new CodexAppServerError('NOT_FOUND', 'Agent Session is not attached to a Codex Thread');
        if (this.resumedThreadIds.has(threadId)) return this.repository.getSession(session.sessionId) || session;
        if (this.resumingThreads.has(threadId)) return this.resumingThreads.get(threadId);
        const resume = (async () => {
            const config = session.configSnapshot || {};
            try {
                // `excludeTurns` is intentional: SQLite already owns the UI
                // projection and `thread/read` reconciles it in the background.
                // Resume only establishes the App Server live subscription and
                // reopens the durable Codex execution context.
                const result = await this.transport.request('thread/resume', {
                    threadId,
                    model: config.model || undefined,
                    ...this._runtimePolicyParams(config),
                    cwd: session.workspaceRoot || undefined,
                    approvalPolicy: normalizeApprovalPolicy(config.permissionMode || config.approvalPolicy),
                    sandbox: normalizeSandboxMode(config.sandbox),
                    ...this._threadInstructionParams(config),
                    ...(config.executionProfile === 'toolbox-only' ? { dynamicTools: [vcpInvokeTool()] } : {}),
                    excludeTurns: true,
                });
                this._assertGeneration(generation);
                const resumedThreadId = String(result?.thread?.id || '').trim();
                if (resumedThreadId !== threadId) {
                    throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/resume returned a mismatched thread id');
                }
                const activity = result?.thread?.status?.type === 'active' ? 'running' : 'idle';
                this.threadStates.set(threadId, { activity, activeTurnId: null });
                this.resumedThreadIds.add(threadId);
                const applied = this.repository.markSessionConfigApplied(
                    session.sessionId, session.configRevision, session.configSnapshot,
                );
                this.configApplyTargets.delete(threadId);
                this._sendSessionConfigEvent('session.config.applied', applied);
                if (session.orphaned) this.repository.markOrphaned(session.sessionId, false);
                return this.repository.getSession(session.sessionId) || applied || session;
            } catch (error) {
                if (error?.code === 'STALE_RUNTIME_GENERATION' || !this.repository) throw error;
                const projection = this.repository.readProjection(session.sessionId);
                if (isConfirmedThreadNotFound(error) && !hasDurableProjection(projection)) {
                    // Codex creates an in-memory empty Thread before its first
                    // Turn writes a rollout. There is no user/agent context to
                    // lose, so it is safe to bind this VChat Session to a new
                    // Thread using the same frozen config. Any non-empty
                    // projection remains fail-closed and orphaned instead.
                    return this._startThreadForSession(session);
                }
                if (isConfirmedThreadNotFound(error)) this.repository.markOrphaned(session.sessionId, true);
                this.repository.markProjectionError(session.sessionId, error.message);
                throw error;
            } finally {
                this.resumingThreads.delete(threadId);
            }
        })();
        this.resumingThreads.set(threadId, resume);
        return resume;
    }

    async _handleDynamicToolCall(message) {
        const params = message.params || {};
        const transport = this.transport;
        const runtimeGeneration = this.runtimeGeneration;
        const respond = (result) => {
            if (this.transport !== transport || this.runtimeGeneration !== runtimeGeneration) return false;
            transport?.respond(message.id, result);
            return true;
        };
        const respondError = (code, detail) => {
            if (this.transport !== transport || this.runtimeGeneration !== runtimeGeneration) return false;
            transport?.respondError(message.id, code, detail);
            return true;
        };
        if (!this.bridge) {
            respondError(-32001, 'vcp-toolbox-bridge is not connected');
            this.serverRequests.delete(String(message.id));
            return;
        }
        let invocation;
        try {
            invocation = decodeVcpInvokeCall(params);
        } catch (error) {
            // `tool` identifies the registered Codex dynamic tool.  It is not
            // the ToolBox target.  A malformed envelope must never reach the
            // bridge as an accidental `vcp_invoke` ToolBox invocation.
            respond({
                contentItems: [{ type: 'inputText', text: `Invalid vcp_invoke request: ${error.message}` }],
                success: false,
            });
            return;
        }
        const bridgeRequestId = `codex:${params.threadId}:${params.turnId}:${params.callId}`;
        this.serverRequests.set(String(message.id), message);
        this.dynamicCalls.set(String(message.id), {
            threadId: params.threadId,
            turnId: params.turnId,
            callId: params.callId,
            bridgeRequestId,
            wrapperToolName: invocation.wrapperToolName,
            targetToolName: invocation.targetToolName,
        });
        try {
            const result = await this.bridge.invoke({
                requestId: bridgeRequestId,
                toolName: invocation.targetToolName,
                arguments: invocation.targetArguments,
            });
            const toolboxResult = result.result || result;
            respond({
                contentItems: bridgeResultContentItems(toolboxResult),
                success: toolboxResult.ok !== false && !toolboxResult.error,
            });
        } catch (error) {
            respond({
                contentItems: [{ type: 'inputText', text: `VCPToolBox bridge failed: ${error.message}` }],
                success: false,
            });
        } finally {
            this.serverRequests.delete(String(message.id));
            this.dynamicCalls.delete(String(message.id));
        }
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
        if (!session?.sessionId || this.followUpDrainPromises.has(session.sessionId)) {
            return this.followUpDrainPromises.get(session?.sessionId) || null;
        }
        const drain = (async () => {
            const state = this.threadStates.get(session.threadId);
            if (state?.activity === 'running') return null;
            const next = this.repository.listPendingInputs(session.sessionId)
                .find((entry) => entry.state === 'queued');
            if (!next) return null;
            this.repository.updatePendingInput(next.inputId, {
                state: 'dispatching',
                attemptCount: next.attemptCount + 1,
                lastError: null,
            });
            try {
                await this.faultInjection.beforePendingInputRpc?.({ session, pendingInput: next });
                const accepted = await this._startTurnWithGuard({
                    sessionId: session.sessionId,
                    prompt: next.prompt,
                    clientUserMessageId: next.clientMessageId,
                    // This row became `dispatching` in the current call. A
                    // second recovery pass would mistake it for a prior crash
                    // window before turn/start has even been dispatched.
                    recoverPendingInputs: false,
                });
                await this.faultInjection.afterTurnAckBeforePendingCommit?.({ session, pendingInput: next, accepted });
                this.repository.updatePendingInput(next.inputId, {
                    state: 'accepted', turnId: accepted.turnId, lastError: null,
                });
                this.repository.removePendingInput(next.inputId);
                this._sendUiEvent({
                    type: 'input.dequeued',
                    topicId: session.sessionId,
                    sessionId: session.sessionId,
                    turnId: accepted.turnId,
                    payload: { inputId: next.inputId },
                });
                return accepted;
            } catch (error) {
                if (error?.simulateProcessCrash === true) throw error;
                this.repository.updatePendingInput(next.inputId, {
                    state: isUncertainRemoteMutation(error) ? 'uncertain' : 'failed',
                    lastError: error?.message || String(error),
                });
                this._sendUiEvent({
                    type: 'input.queue.failed',
                    topicId: session.sessionId,
                    sessionId: session.sessionId,
                    payload: { inputId: next.inputId, error: error.message },
                });
                return null;
            }
        })().finally(() => this.followUpDrainPromises.delete(session.sessionId));
        this.followUpDrainPromises.set(session.sessionId, drain);
        return drain;
    }

    async _recoverPendingInputsForSession(session) {
        const pending = this.repository.listPendingInputs(session.sessionId)
            .filter((entry) => ['dispatching', 'accepted'].includes(entry.state));
        if (!pending.length || !session.threadId) return;
        let thread;
        try {
            const result = await this.transport.request('thread/read', { threadId: session.threadId, includeTurns: true });
            thread = result?.thread || result;
        } catch (error) {
            for (const entry of pending) this.repository.updatePendingInput(entry.inputId, {
                state: 'uncertain', lastError: `Could not verify accepted input: ${error.message}`,
            });
            return;
        }
        const userItems = (thread?.turns || []).flatMap((turn) => (turn.items || []).map((item) => ({ turn, item })))
            .filter(({ item }) => item?.type === 'userMessage');
        for (const entry of pending) {
            const match = userItems.find(({ item }) => [
                item.id, item.clientUserMessageId, item.client_user_message_id,
            ].some((value) => String(value || '') === String(entry.clientMessageId || '')));
            if (match) {
                this.repository.updatePendingInput(entry.inputId, {
                    state: 'accepted', turnId: match.turn?.id || entry.turnId || null, lastError: null,
                });
                this.repository.removePendingInput(entry.inputId);
            } else {
                this.repository.updatePendingInput(entry.inputId, {
                    state: 'uncertain', lastError: 'Codex Thread does not confirm whether this input was accepted',
                });
            }
        }
    }

    _handleBridgeEvent(message) {
        const channel = message?.channel;
        const value = message?.event;
        if (channel === 'backend-approval') {
            const requestId = String(value?.requestId || '').trim();
            const expiresAtMs = Number(value?.expiresAtMs) || 0;
            if (!requestId || expiresAtMs <= Date.now()) return;
            const approval = {
                approvalId: requestId,
                requestId,
                scope: 'toolbox',
                expiresAtMs,
                replay: value?.replay === true,
                toolName: value?.data?.toolName || null,
                reason: value?.data?.reason || null,
                generation: this.toolboxAuthorityGeneration,
            };
            const queued = this.interactions.enqueue({
                source: 'toolbox', requestId, kind: 'backend-approval', expiresAtMs,
                generation: this.toolboxAuthorityGeneration,
            });
            if (!queued.accepted) return;
            this.toolboxApprovals.set(requestId, approval);
            this._sendUiEvent({
                type: 'approval.requested',
                payload: { approval },
            });
            return;
        }
        this._sendUiEvent({
            type: 'toolbox.ws',
            payload: {
                channel: channel || 'toolbox',
                kind: classifyToolboxEvent(channel, value),
                value: sanitizeToolboxValue(value),
            },
        });
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
