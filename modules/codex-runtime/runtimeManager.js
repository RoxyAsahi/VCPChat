'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { EventEmitter } = require('events');
const { CodexAppServerTransport, CodexAppServerError } = require('./appServerTransport');
const { AgentProjectionRepository, CodexProjectionProjector } = require('./projection');
const { ToolboxBridgeTransport } = require('./toolboxBridgeTransport');
const { ToolboxResponsesAdapter } = require('./toolboxResponsesAdapter');
const { InteractionRegistry } = require('./interactionRegistry');
const {
    capabilityMatrix,
    failClosedServerRequestResponse,
    serverRequestPolicy,
} = require('./protocolCapabilities');

function id(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function submissionDedupeKey(prompt, attachments = []) {
    const descriptors = (Array.isArray(attachments) ? attachments : []).map((attachment) => ({
        attachmentId: attachment?.attachmentId || null,
        displayName: attachment?.displayName || null,
        byteLen: Number(attachment?.byteLen) || 0,
        kind: attachment?.kind || null,
    }));
    return crypto.createHash('sha256')
        .update(JSON.stringify({ prompt: String(prompt || '').trim(), attachments: descriptors }))
        .digest('hex');
}

function explicitAgent(value) {
    const result = String(value || '').trim();
    return result || null;
}

function sameIdentity(left, right) {
    const a = String(left || '').trim().toLocaleLowerCase();
    const b = String(right || '').trim().toLocaleLowerCase();
    return Boolean(a && b && a === b);
}

class CodexRuntimeManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.projectRoot = options.projectRoot || process.cwd();
        this.settingsPath = options.settingsPath || path.join(this.projectRoot, 'AppData', 'settings.json');
        this.agentsDir = options.agentsDir || path.join(path.dirname(this.settingsPath), 'CodexAgents');
        this.getSettings = options.getSettings || (() => ({}));
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
        this.serverRequests = new Map();
        this.interactions = new InteractionRegistry();
        this.interactionTimers = new Map();
        this.bridge = null;
        this.responsesAdapter = null;
        this.threadStates = new Map();
        // Loaded/resumed is process-local App Server state. SQLite's threadId
        // outlives this set, so every fresh App Server process must explicitly
        // `thread/resume` before VChat sends a new turn to an existing Thread.
        this.resumedThreadIds = new Set();
        this.resumingThreads = new Map();
        this.dynamicCalls = new Map();
        this.toolboxApprovals = new Map();
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
        this.compactionWaiters = new Map();
        this.idleWarmSessions = new Map();
        this.maxIdleWarmSessions = Number.isInteger(options.maxIdleWarmSessions)
            ? Math.max(0, options.maxIdleWarmSessions) : 2;
        this.diagnosticClock = options.diagnosticClock || (() => performance.now());
        this.startPromise = null;
        this.runtimeGeneration = 0;
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
            this.runtimeGeneration += 1;
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
        this.sessionWarmPromises.clear();
        this.turnStartPromises.clear();
        this.followUpDrainPromises.clear();
        this.idleWarmSessions.clear();
        this.dynamicCalls.clear();
        this.toolboxApprovals.clear();
        this.toolboxConfigFingerprint = null;
        this.toolboxReconfiguration = null;
        this.toolboxRequestedSettings = null;
        this.toolboxRequestedFingerprint = null;
        this.toolboxRequestedGeneration = 0;
        this.toolboxAppliedGeneration = 0;
        this.startPromise = null;
        this.state = 'stopped';
        return this.getStatus();
    }

    async createTopic(options = {}) {
        this.ensureProjectionStore();
        this._assertProjectionWritable();
        const sessionId = id('session');
        const now = Date.now();
        const agentId = explicitAgent(options.agentId || options.agent) || 'codex';
        const configSnapshot = this._configSnapshot({ ...options, agentId });
        if (!sameIdentity(agentId, 'codex') && !String(configSnapshot.baseInstructions || '').trim()) {
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

    async createSession(options = {}) {
        this._assertProjectionWritable();
        const requestedSessionId = options.sessionId || options.topicId || options.resume;
        this.ensureProjectionStore();
        let session = requestedSessionId ? this.repository.getSession(requestedSessionId) : null;
        if (!session) {
            const created = await this.createTopic(options);
            session = this.repository.getSession(created.sessionId);
        }
        return this.ensureSessionRuntime({ sessionId: session.sessionId, ...options });
    }

    listAgentProfiles() {
        this.ensureProjectionStore();
        this._ensureDefaultAgentProfile();
        const profiles = this._agentCatalog().map((entry) => ({
            id: entry.catalogId, name: entry.name,
            revision: Number(entry.profile?.revision || 1),
            model: entry.profile?.model || '',
            systemPrompt: entry.profile?.systemPrompt || '',
            workspaceRoot: entry.profile?.workspaceRoot || '',
            permissionMode: normalizePermissionMode(entry.profile?.permissionMode),
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
                systemPrompt: session.configSnapshot?.baseInstructions || '',
                workspaceRoot: session.workspaceRoot || '',
                permissionMode: normalizePermissionMode(session.configSnapshot?.permissionMode),
                executionProfile: 'toolbox-only',
                avatarUrl: session.configSnapshot?.agentAvatar || '',
            });
        }
        return profiles;
    }

    saveAgentProfile({ agentId, name, systemPrompt, model, workspaceRoot, permissionMode } = {}) {
        this.ensureProjectionStore();
        this._assertProjectionWritable();
        const displayName = String(name || '').trim();
        const prompt = String(systemPrompt || '').trim();
        const requestedId = String(agentId || '').trim();
        const idValue = requestedId || displayName
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!displayName || !idValue || idValue === '.' || idValue === '..' || /[\\/:*?"<>|]/.test(idValue)) {
            throw new CodexAppServerError('INVALID_INPUT', 'Build Agent name is invalid');
        }
        if (!prompt) throw new CodexAppServerError('INVALID_INPUT', 'Build Agent system prompt is required');
        const directIdentity = this._resolveCanonicalAgent(idValue, { failOnAmbiguous: true });
        const namedIdentity = this._resolveCanonicalAgent(displayName, { failOnAmbiguous: true });
        const existing = directIdentity?.profile ? directIdentity : namedIdentity?.profile ? namedIdentity : null;
        if (existing && (!requestedId || !sameIdentity(existing.catalogId, requestedId))) {
            throw new CodexAppServerError('ALREADY_EXISTS', `Build Agent ${displayName} already exists`);
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
        const previousRevision = Number(existing?.profile?.revision || 0);
        const avatarFile = safeAvatarFile(existing?.profile?.avatarFile);
        const profile = {
            name: displayName,
            systemPrompt: prompt,
            revision: previousRevision + 1,
            executionProfile: 'toolbox-only',
            permissionMode: normalizePermissionMode(permissionMode),
            ...(String(model || '').trim() ? { model: String(model).trim() } : {}),
            ...(normalizedWorkspace ? { workspaceRoot: normalizedWorkspace } : {}),
            ...(avatarFile ? { avatarFile } : {}),
            updatedAt: Date.now(),
        };
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

    saveAgentAvatar({ agentId, avatarData } = {}) {
        this.ensureProjectionStore();
        this._assertProjectionWritable();
        const idValue = String(agentId || '').trim();
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
        const revision = Number(resolved.revision || 1) + 1;
        const avatarFile = `avatar-r${revision}${ext}`;
        const directory = path.join(this.agentsDir, resolved.id);
        const avatarPath = path.join(directory, avatarFile);
        const avatarTemporaryPath = `${avatarPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(avatarTemporaryPath, bytes);
        fs.renameSync(avatarTemporaryPath, avatarPath);
        const configPath = path.join(directory, 'config.json');
        const configTemporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
        const { id: _id, avatarUrl: _avatarUrl, ...stored } = resolved;
        const profile = { ...stored, revision, avatarFile, updatedAt: Date.now() };
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
        const idValue = String(sessionId || topicId || '').trim();
        if (!idValue) throw new CodexAppServerError('INVALID_INPUT', 'Session runtime warm requires sessionId');
        if (this.sessionWarmPromises.has(idValue)) return this.sessionWarmPromises.get(idValue);
        const warm = (async () => {
            const startedAt = this.diagnosticClock();
            this._diagnostic('thread-warm-started', { sessionId: idValue, reason });
            await this.start();
            let session = this.repository.getSession(idValue);
            if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
            if (session.archivedAt) {
                throw new CodexAppServerError('SESSION_ARCHIVED', 'Restore the archived Session before starting a Turn');
            }
            session = this._repairSessionIdentity(this._repairSessionConfig(session));
            session = session.threadId
                ? await this._resumeSession(session)
                : await this._startThreadForSession(session, options);
            if (recoverPendingInputs) await this._recoverPendingInputsForSession(session);
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
                personality: config.personality || 'pragmatic',
                ...(config.baseInstructions ? { baseInstructions: config.baseInstructions } : {}),
                ...(config.developerInstructions ? { developerInstructions: config.developerInstructions } : {}),
                dynamicTools: [vcpInvokeTool()],
            });
            threadId = result?.thread?.id;
            if (!threadId) throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/start returned no thread id');
            this.repository.updateOperation(operation.operationId, { state: 'remote-applied', threadId });
            await this.faultInjection.afterThreadStartRemoteApplied?.({ operation, session, threadId });
            session = session.threadId
                ? this.repository.replaceUnmaterializedThread(session.sessionId, threadId)
                : this.repository.saveSession({
                    ...session,
                    threadId,
                    state: 'ready',
                    updatedAt: Date.now(),
                });
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
        let session = this.repository.getSession(sessionId || topicId);
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
        if (session.threadId && reconcile !== false) {
            try {
                let applied = false;
                for (let attempt = 0; attempt < 3 && !applied; attempt += 1) {
                    const generation = this.repository.projectionGeneration(session.sessionId);
                    const result = await this.transport.request('thread/read', {
                        threadId: session.threadId,
                        includeTurns: true,
                    });
                    applied = this.projector.reconcileThread(session.sessionId, result.thread || result, generation).applied;
                }
                if (!applied) throw new CodexAppServerError('RECONCILE_GENERATION_CHANGED', 'Projection changed during reconciliation; retry later');
                if (session.orphaned) this.repository.markOrphaned(session.sessionId, false);
            } catch (error) {
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
        const requestedSessionId = String(sessionId || topicId || '').trim();
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
        const session = await this.ensureSessionRuntime({ sessionId, reason: 'send', recoverPendingInputs });
        const text = String(prompt || '').trim();
        if (!text && (!Array.isArray(attachments) || attachments.length === 0)) {
            throw new CodexAppServerError('INVALID_INPUT', 'Prompt or attachment must not be empty');
        }
        const turnId = id('turn');
        const input = buildTurnInput(text, attachments);
        const result = await this.transport.request('turn/start', {
            threadId: session.threadId,
            clientUserMessageId: clientUserMessageId || id('client_msg'),
            input,
            cwd: session.workspaceRoot,
            model: session.configSnapshot?.model || undefined,
            // App Server applies execution policy to the turn it is about to
            // start.  Reading it from the Session snapshot means a saved
            // current-session change takes effect without restarting this
            // Thread (and without touching any other running Thread).
            approvalPolicy: normalizeApprovalPolicy(session.configSnapshot?.permissionMode || session.configSnapshot?.approvalPolicy),
            sandbox: normalizeSandboxMode(session.configSnapshot?.sandbox),
        });
        const acceptedTurnId = result?.turn?.id || turnId;
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
        const session = this.repository.getSession(sessionId || topicId);
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
        const idValue = String(sessionId || topicId || '').trim();
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
        const session = this.repository.getSession(sessionId || topicId);
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
        const source = this.repository.getSession(sessionId || topicId);
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
        const idValue = sessionId || topicId;
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
        this.repository.updateOperation(operation.operationId, { state: 'completed', threadId: session.threadId });
        return { sessionId: idValue, threadId: session.threadId, archived: true, session: compatibilitySession(archived) };
    }

    async closeSession(options = {}) { return this.archiveSession(options); }

    async restoreSession({ sessionId, topicId } = {}) {
        this._assertProjectionWritable();
        const idValue = sessionId || topicId;
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
        const idValue = sessionId || topicId;
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
        const session = this.repository.getSession(sessionId || topicId);
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
        const session = this.repository.getSession(sessionId || topicId);
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
            const recoverable = this.repository.listRecoverableOperations()
                .filter((operation) => ['thread-archive', 'thread-unarchive', 'thread-delete'].includes(operation.kind))
                .filter((operation) => ['prepared', 'dispatching', 'remote-applied', 'uncertain'].includes(operation.state));
            let recovered = 0;
            for (const operation of recoverable) {
                try {
                    if (await this._recoverKnownThreadOperation(operation)) recovered += 1;
                } catch (error) {
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
        const idValue = String(sessionId || topicId || '').trim();
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
        this.repository.updateOperation(operation.operationId, {
            state: 'completed', threadId: session.threadId,
            payload: { deletionReceiptId: receipt.receiptId },
        });
        return { deleted: true, receipt };
    }
    exportSession({ sessionId, topicId, format = 'markdown' } = {}) {
        this.ensureProjectionStore();
        const idValue = String(sessionId || topicId || '').trim();
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
        const idValue = String(sessionId || topicId || '').trim();
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        return { items: this.repository.listPendingInputs(idValue).map(pendingInputProjection) };
    }

    async replaceInteractionQueue({ sessionId, topicId, interactions = [] } = {}) {
        this._assertProjectionWritable();
        const idValue = String(sessionId || topicId || '').trim();
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
        const idValue = String(sessionId || topicId || '').trim();
        const session = this.repository.getSession(idValue);
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        for (const current of this.repository.listPendingInputs(idValue)) {
            if (['queued', 'failed'].includes(current.state)) this.repository.removePendingInput(current.inputId);
        }
        return this.listInteractionQueue({ sessionId: idValue });
    }

    async resolvePendingInput({ sessionId, topicId, inputId, action } = {}) {
        this._assertProjectionWritable();
        const idValue = String(sessionId || topicId || '').trim();
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
        const hasSystemPromptUpdate = Object.prototype.hasOwnProperty.call(settings, 'systemPrompt');
        const requestedSystemPrompt = hasSystemPromptUpdate ? String(settings.systemPrompt || '').trim() : null;
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
            if (hasWorkspaceUpdate && current.threadId && requestedWorkspaceRoot !== current.workspaceRoot) {
                throw new CodexAppServerError(
                    'IDENTITY_CHANGE_REQUIRES_NEW_SESSION',
                    'Workspace is part of the materialized Codex Thread identity; create a new Session to change it',
                );
            }
            if (hasSystemPromptUpdate && current.threadId
                && requestedSystemPrompt !== String(current.configSnapshot?.baseInstructions || '')) {
                throw new CodexAppServerError(
                    'IDENTITY_CHANGE_REQUIRES_NEW_SESSION',
                    'System prompt is part of the materialized Codex Thread identity; create a new Session to change it',
                );
            }
            if (hasSystemPromptUpdate && !requestedSystemPrompt && !sameIdentity(current.agentId, 'codex')) {
                throw new CodexAppServerError('AGENT_IDENTITY_MISSING', 'Build Agent Session requires a system prompt');
            }
            const currentPermissionMode = normalizePermissionMode(
                current.configSnapshot?.permissionMode || current.configSnapshot?.approvalPolicy,
            );
            const updated = this.repository.updateSessionConfig(sessionId, expectedRevision, {
                workspaceRoot: hasWorkspaceUpdate ? requestedWorkspaceRoot : current.workspaceRoot,
                configSnapshot: {
                    ...(current.configSnapshot || {}),
                    permissionMode: permissionMode || currentPermissionMode,
                    approvalPolicy: normalizeApprovalPolicy(permissionMode || currentPermissionMode),
                    ...(requestedModel ? { model: requestedModel } : {}),
                    ...(hasSystemPromptUpdate ? { baseInstructions: requestedSystemPrompt } : {}),
                },
            });
            if (!updated.updated) {
                throw new CodexAppServerError('SESSION_CONFIG_CONFLICT', 'Session settings changed in another view', {
                    current: updated.session,
                });
            }
            session = updated.session;
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
            settings: { permissionMode: effectivePermissionMode, ...(effectiveModel ? { model: effectiveModel } : {}) },
            session: session ? compatibilitySession(session) : null,
            appliesTo: session ? 'next-turn' : 'new-sessions',
        };
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
        addDifference('systemPrompt', session.configSnapshot?.baseInstructions || '', profile.systemPrompt || '', true);
        const profileWorkspace = profile.workspaceRoot ? path.resolve(profile.workspaceRoot) : session.workspaceRoot;
        addDifference('workspaceRoot', session.workspaceRoot || '', profileWorkspace || '', true);
        addDifference('name', session.agentNameSnapshot || session.configSnapshot?.agentName || '', profile.name || '');
        addDifference('avatar', session.configSnapshot?.agentAvatar || '', profile.avatarUrl || '');
        addDifference('model', session.configSnapshot?.model || '', profile.model || session.configSnapshot?.model || '');
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
                systemPrompt: profile.systemPrompt,
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
                baseInstructions: profile.systemPrompt || '',
                agentName: profile.name || session.agentNameSnapshot || '',
                agentAvatar: profile.avatarUrl || session.configSnapshot?.agentAvatar || '',
                model: profile.model || session.configSnapshot?.model,
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
        return { attachment: attachmentDescriptor(resolved, stat.size) };
    }
    async respondApproval({ requestId, approvalId, decision, scope, reason, generation } = {}) {
        const pendingId = String(requestId || approvalId || '');
        if (scope === 'toolbox' || this.toolboxApprovals.has(pendingId)) {
            const approval = this.toolboxApprovals.get(pendingId);
            if (!approval || approval.expiresAtMs <= Date.now()) {
                this.toolboxApprovals.delete(pendingId);
                throw new CodexAppServerError('NOT_FOUND', 'ToolBox approval is no longer pending');
            }
            if (Number(generation) !== Number(approval.generation)) {
                throw new CodexAppServerError('STALE_INTERACTION_GENERATION', 'ToolBox approval belongs to a different authority generation');
            }
            if (!this.interactions.begin('toolbox', pendingId, approval.generation)) {
                throw new CodexAppServerError('INTERACTION_ALREADY_RESOLVED', 'ToolBox approval is already being answered');
            }
            let result;
            try {
                result = await this.bridge?.respondApproval({
                    requestId: pendingId,
                    approved: normalizeApprovalDecision(decision) === 'accept',
                    reason,
                });
            } catch (error) {
                this.interactions.rollback('toolbox', pendingId, approval.generation);
                throw error;
            }
            if (!result?.written) {
                this.interactions.rollback('toolbox', pendingId, approval.generation);
                throw new CodexAppServerError('TOOLBOX_APPROVAL_FAILED', result?.error || 'ToolBox approval response was not written');
            }
            this.toolboxApprovals.delete(pendingId);
            this.interactions.complete('toolbox', pendingId, 'completed', approval.generation);
            this._sendUiEvent({
                type: 'approval.resolved',
                approvalId: pendingId,
                payload: { approvalId: pendingId, decision, scope: 'toolbox' },
            });
            return { requestId: pendingId, resolved: true, scope: 'toolbox' };
        }
        if (!pendingId || !this.serverRequests.has(pendingId)) {
            throw new CodexAppServerError('NOT_FOUND', 'Approval request is no longer pending');
        }
        const request = this.serverRequests.get(pendingId);
        if (Number(generation) !== Number(request.runtimeGeneration)) {
            throw new CodexAppServerError('STALE_INTERACTION_GENERATION', 'Codex approval belongs to a different runtime generation');
        }
        if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
            throw new CodexAppServerError('INTERACTION_KIND_MISMATCH', 'This request must be answered through respondInteraction');
        }
        if (!this.interactions.begin('codex-native', pendingId, request.runtimeGeneration)) {
            throw new CodexAppServerError('INTERACTION_ALREADY_RESOLVED', 'Codex approval is already being answered');
        }
        const response = approvalResponse(request.method, decision);
        try {
            if (response) this.transport.respond(pendingId, response);
            else this.transport.respondError(pendingId, -32002, `Unsupported Codex server request: ${request.method}`);
        } catch (error) {
            this.interactions.rollback('codex-native', pendingId, request.runtimeGeneration);
            throw error;
        }
        this.serverRequests.delete(pendingId);
        this.interactions.complete('codex-native', pendingId, 'completed', request.runtimeGeneration);
        this._sendUiEvent({
            type: 'approval.resolved',
            topicId: approvalProjection(pendingId, request, this.repository).topicId,
            sessionId: approvalProjection(pendingId, request, this.repository).sessionId,
            approvalId: pendingId,
            payload: { approvalId: pendingId, decision },
        });
        return { requestId: pendingId, resolved: true };
    }

    async respondInteraction({ source = 'codex-native', requestId, kind, response = {}, generation } = {}) {
        const pendingId = String(requestId || '').trim();
        if (source !== 'codex-native') {
            throw new CodexAppServerError('INTERACTION_SOURCE_MISMATCH', 'Only Codex server requests use the interaction response channel');
        }
        const request = this.serverRequests.get(pendingId);
        if (!request) throw new CodexAppServerError('NOT_FOUND', 'Interaction request is no longer pending');
        if (Number(generation) !== Number(request.runtimeGeneration)) {
            throw new CodexAppServerError('STALE_INTERACTION_GENERATION', 'Codex interaction belongs to a different runtime generation');
        }
        const policy = serverRequestPolicy(request.method, this._profileForRequest(request));
        if (policy.state !== 'supported' || policy.kind !== kind) {
            throw new CodexAppServerError('INTERACTION_KIND_MISMATCH', 'Interaction kind does not match the pending request');
        }
        if (!this.interactions.begin(source, pendingId, request.runtimeGeneration)) {
            throw new CodexAppServerError('INTERACTION_ALREADY_RESOLVED', 'Interaction is already being answered');
        }
        let normalized;
        try {
            normalized = normalizeInteractionResponse(request, response);
            this.transport.respond(pendingId, normalized);
        } catch (error) {
            this.interactions.rollback(source, pendingId, request.runtimeGeneration);
            throw error;
        }
        this._clearInteractionTimer(pendingId);
        this.serverRequests.delete(pendingId);
        this.interactions.complete(source, pendingId, 'completed', request.runtimeGeneration);
        const projection = approvalProjection(pendingId, request, this.repository);
        this._sendUiEvent({
            type: 'interaction.resolved',
            topicId: projection.topicId,
            sessionId: projection.sessionId,
            turnId: projection.turnId,
            payload: { source, requestId: pendingId, kind, state: 'completed' },
        });
        return { requestId: pendingId, resolved: true, kind };
    }

    _profileForRequest(request) {
        const threadId = request?.params?.threadId;
        return threadId
            ? (this.repository?.getSessionByThread(threadId)?.configSnapshot?.executionProfile || 'toolbox-only')
            : 'toolbox-only';
    }

    _clearInteractionTimer(requestId) {
        const timer = this.interactionTimers.get(String(requestId));
        if (timer) clearTimeout(timer);
        this.interactionTimers.delete(String(requestId));
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
        return {
            model: options.model || profile?.model || settings.agentRuntime?.codex?.model
                || settings.agentRuntime?.tui?.defaultModel
                || (toolboxConfigured ? 'Nova' : 'gpt-5.1-codex'),
            personality: options.personality || 'pragmatic',
            permissionMode,
            approvalPolicy: normalizeApprovalPolicy(permissionMode),
            sandbox: normalizeSandboxMode(options.sandbox),
            // The Agent catalog's `systemPrompt` is the VChat identity (e.g.
            // `{{Nova}}`, expanded by VCPToolBox). It must replace Codex's
            // built-in system prompt via `baseInstructions`; `developerInstructions`
            // only appends and cannot suppress the "You are Codex" default.
            baseInstructions: options.baseInstructions || options.systemPrompt || profile?.systemPrompt || '',
            developerInstructions: options.developerInstructions || '',
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
                return value && typeof value === 'object' ? value : null;
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
                    const config = JSON.parse(fs.readFileSync(path.join(this.agentsDir, entry.name, 'config.json'), 'utf8'));
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
            name: 'Nova', systemPrompt: '{{Nova}}', revision: 1,
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

        if (!config.executionProfile) {
            config.executionProfile = session.threadId
                ? 'codex-native-legacy'
                : (config.provider === 'vcp_toolbox' ? 'toolbox-only' : 'codex-native');
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
            resolveBaseInstructions: ({ threadId }) => {
                const session = threadId ? this.repository?.getSessionByThread(threadId) : null;
                if (!session) {
                    throw new CodexAppServerError('SESSION_NOT_FOUND', 'ToolBox request is not bound to a known VChat Agent Session');
                }
                if (session.configSnapshot?.executionProfile !== 'toolbox-only') {
                    throw new CodexAppServerError('PROFILE_MISMATCH', 'Only toolbox-only Threads may use the VCPToolBox Responses adapter');
                }
                return String(session.configSnapshot?.baseInstructions || '');
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
            const request = { ...message, runtimeGeneration: this.runtimeGeneration };
            const threadId = request?.params?.threadId || null;
            const session = threadId ? this.repository?.getSessionByThread(threadId) : null;
            const profile = session?.configSnapshot?.executionProfile || 'toolbox-only';
            const policy = serverRequestPolicy(request.method, profile);
            if (policy.state !== 'supported') {
                this._failClosedServerRequest(request, policy.reason);
                return;
            }
            if (!this.workbenchMounted) {
                this._failClosedServerRequest(request, 'VChat Workbench is closed');
                return;
            }
            const queued = this.interactions.enqueue({
                source: 'codex-native',
                requestId: String(request.id),
                generation: request.runtimeGeneration,
                sessionId: session?.sessionId || null,
                threadId,
                turnId: request?.params?.turnId || null,
                kind: policy.kind || 'approval',
                method: request.method,
                payload: sanitizeInteractionPayload(request.params),
                expiresAtMs: interactionExpiry(request),
            });
            if (!queued.accepted) {
                if (queued.reason === 'capacity') {
                    this._failClosedServerRequest(request, 'VChat interaction capacity is exhausted');
                }
                return;
            }
            this.serverRequests.set(String(request.id), request);
            if (policy.kind === 'native-approval' || policy.kind === 'legacy-native-approval') {
                this._sendUiEvent(approvalEvent(String(request.id), request, this.repository));
            } else {
                const projection = approvalProjection(String(request.id), request, this.repository);
                this._sendUiEvent({
                    type: 'interaction.requested',
                    topicId: projection.topicId,
                    sessionId: projection.sessionId,
                    turnId: projection.turnId,
                    payload: queued.record,
                });
            }
            const expiresAtMs = queued.record.expiresAtMs;
            if (expiresAtMs) {
                const delay = Math.max(0, expiresAtMs - Date.now());
                const timer = setTimeout(() => {
                    if (!this.serverRequests.has(String(request.id))) return;
                    this._failClosedServerRequest(request, 'Interaction timed out');
                }, delay);
                timer.unref?.();
                this.interactionTimers.set(String(request.id), timer);
            }
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
        this._rejectCompactionWaiters(new CodexAppServerError('RUNTIME_CRASHED', 'Codex App Server crashed during compaction'));
        await this._failClosedNativeApprovals('Codex App Server crashed', { respond: false });
        await this._interruptDynamicCalls('Codex App Server crashed');
        await this._failClosedToolboxApprovals('Codex App Server crashed');
        this.interactions.clear({ source: 'codex-native' });
        this.interactions.clear({ source: 'toolbox' });
        this.transport = null;
        this._transportWired = false;
        this.sendEvent({ runtime: 'codex', type: 'runtime.crashed', error: this.lastError });
        this.emit('event', { runtime: 'codex', type: 'runtime.crashed', error: this.lastError });
    }

    async _failClosedNativeApprovals(reason, options = {}) {
        const respond = options.respond !== false;
        for (const [requestId, request] of [...this.serverRequests.entries()]) {
            if (request.method === 'item/tool/call') continue;
            this.serverRequests.delete(requestId);
            this._clearInteractionTimer(requestId);
            this.interactions.complete('codex-native', requestId, 'expired', request.runtimeGeneration);
            if (respond) {
                try {
                    this._failClosedServerRequest({ ...request, id: requestId }, reason);
                } catch (error) {
                    this.emit('diagnostic', `Could not fail-close Codex request ${requestId}: ${error.message}`);
                }
            }
            this._sendUiEvent({
                type: 'approval.resolved',
                topicId: approvalProjection(requestId, request, this.repository).topicId,
                sessionId: approvalProjection(requestId, request, this.repository).sessionId,
                approvalId: requestId,
                payload: { approvalId: requestId, decision: 'decline', scope: 'codex-native', reason },
            });
        }
    }

    _failClosedServerRequest(message, reason) {
        const requestId = String(message?.id || '');
        const response = failClosedServerRequestResponse(message?.method);
        if (response) this.transport?.respond(requestId, response);
        else this.transport?.respondError(requestId, -32002, reason || `Unsupported Codex server request: ${message?.method || '(empty)'}`);
        this.serverRequests.delete(requestId);
        this._clearInteractionTimer(requestId);
        this.interactions.complete('codex-native', requestId, 'rejected', message.runtimeGeneration);
        this._sendUiEvent({
            type: 'interaction.rejected',
            topicId: approvalProjection(requestId, message, this.repository).topicId,
            sessionId: approvalProjection(requestId, message, this.repository).sessionId,
            turnId: message?.params?.turnId || null,
            payload: { requestId, method: message?.method || null, reason: reason || 'Unsupported server request' },
        });
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
                    personality: config.personality || 'pragmatic',
                    ...(config.baseInstructions ? { baseInstructions: config.baseInstructions } : {}),
                    ...(config.developerInstructions ? { developerInstructions: config.developerInstructions } : {}),
                    ...(config.executionProfile === 'toolbox-only' ? { dynamicTools: [vcpInvokeTool()] } : {}),
                    excludeTurns: true,
                });
                const resumedThreadId = String(result?.thread?.id || '').trim();
                if (resumedThreadId !== threadId) {
                    throw new CodexAppServerError('INVALID_RESPONSE', 'Codex thread/resume returned a mismatched thread id');
                }
                const activity = result?.thread?.status?.type === 'active' ? 'running' : 'idle';
                this.threadStates.set(threadId, { activity, activeTurnId: null });
                this.resumedThreadIds.add(threadId);
                if (session.orphaned) this.repository.markOrphaned(session.sessionId, false);
                return this.repository.getSession(session.sessionId) || session;
            } catch (error) {
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
        this.repository.saveSession({ ...session, state: next.activity, updatedAt: Date.now() });
        if (next.activity === 'idle') this._rememberIdleWarmSession(session.sessionId);
        else this.idleWarmSessions.delete(session.sessionId);
        if (message.method === 'turn/completed' && next.activity === 'idle') {
            void this._drainFollowUpQueue(session);
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
        const approvals = [...this.toolboxApprovals.values()];
        this.toolboxApprovals.clear();
        for (const approval of approvals) {
            const requestId = approval.requestId;
            await this.bridge?.respondApproval({ requestId, approved: false, reason }).catch(() => null);
            this.interactions.complete('toolbox', requestId, 'expired', approval.generation);
            this._sendUiEvent({
                type: 'approval.resolved',
                approvalId: requestId,
                payload: { approvalId: requestId, decision: 'decline', scope: 'toolbox', reason },
            });
        }
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

function vcpInvokeTool() {
    return {
        type: 'function',
        name: 'vcp_invoke',
        description: 'Invoke one named VCPToolBox capability through the VCP bridge. '
            + '`tool` is the exact catalog capability name. `arguments` is forwarded losslessly to that capability: '
            + 'include every target-specific field exactly as documented, and use an empty object only when the target truly takes no arguments. '
            + 'Do not replace this call with a native filesystem, shell, web, or MCP tool.',
        inputSchema: {
            type: 'object',
            properties: {
                tool: { type: 'string', description: 'Exact ToolBox catalog capability name.' },
                arguments: {
                    type: 'object',
                    description: 'Complete target-specific argument object. Preserve all documented field names and values.',
                    // App Server normalizes an unspecified object schema to an
                    // empty `properties` map.  Declare this generic envelope
                    // explicitly open so target-specific ToolBox fields survive
                    // the DynamicTool → Responses conversion.
                    additionalProperties: true,
                },
            },
            required: ['tool', 'arguments'],
            additionalProperties: false,
        },
    };
}

const MAX_DYNAMIC_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const TOOLBOX_TARGET_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

// Codex App Server's `item/tool/call` has two tool levels.  The outer level is
// the name of a registered dynamic tool; VCP registers only `vcp_invoke`.
// The inner envelope is its inputSchema and contains the ToolBox target.
// Keeping this decoder at the Main/bridge boundary prevents a renderer or the
// bridge from guessing either identity.
function decodeVcpInvokeCall(params) {
    if (!isPlainObject(params)) throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'params must be an object');
    for (const field of ['threadId', 'turnId', 'callId']) {
        if (!String(params[field] || '').trim()) {
            throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', `${field} is required`);
        }
    }
    const wrapperToolName = String(params.tool || '').trim();
    if (wrapperToolName !== 'vcp_invoke') {
        throw new CodexAppServerError('UNSUPPORTED_DYNAMIC_TOOL', `unsupported dynamic tool: ${wrapperToolName || '(empty)'}`);
    }
    if (!isPlainObject(params.arguments)) {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments must be an object');
    }
    const targetToolName = String(params.arguments.tool || '').trim();
    if (!TOOLBOX_TARGET_NAME.test(targetToolName)) {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments.tool is not a valid ToolBox target name');
    }
    const targetArguments = params.arguments.arguments;
    if (!isPlainObject(targetArguments)) {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments.arguments must be an object');
    }
    let serialized;
    try {
        serialized = JSON.stringify(targetArguments);
    } catch (_error) {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments.arguments must be JSON serializable');
    }
    if (typeof serialized !== 'string') {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments.arguments must serialize to JSON');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DYNAMIC_TOOL_ARGUMENT_BYTES) {
        throw new CodexAppServerError('DYNAMIC_TOOL_ARGUMENTS_TOO_LARGE', 'vcp_invoke arguments exceed 1 MiB');
    }
    return { wrapperToolName, targetToolName, targetArguments };
}

function serializeError(error) {
    return {
        code: error?.code || 'RUNTIME_ERROR',
        message: error?.message || String(error),
        details: error?.details || null,
    };
}

function isConfirmedThreadNotFound(error) {
    const message = String(error?.message || '');
    // Do not infer orphaning from transport/timeout/provider failures. The
    // App Server's explicit missing-rollout errors are the only state change
    // that may make a VChat Session read-only orphaned.
    return /(?:no rollout found|thread\s+(?:was\s+)?not found|unknown thread|thread id .* not found)/i.test(message);
}

function hasDurableProjection(projection) {
    return Array.isArray(projection?.messages) && projection.messages.length > 0;
}

function hasToolboxConfiguration(settings) {
    return Boolean(String(settings?.vcpServerUrl || '').trim() && String(settings?.vcpApiKey || '').trim());
}

// Hash the secret so Main can identify a credential change without retaining
// it in status, diagnostics, SQLite or UI event payloads.
function toolboxConfigFingerprint(settings) {
    const url = String(settings?.vcpServerUrl || '').trim();
    const key = String(settings?.vcpApiKey || '');
    return crypto.createHash('sha256').update(`${url}\u0000${key}`).digest('hex');
}

function safeAvatarFile(value) {
    const file = String(value || '').trim();
    if (!file || path.basename(file) !== file || !/^avatar-r\d+\.(?:png|jpe?g|gif|webp)$/i.test(file)) return '';
    return file;
}

function compatibilitySession(session) {
    return {
        ...session,
        topicId: session.sessionId,
        model: session.configSnapshot?.model || null,
        runtime: 'codex',
    };
}

function pendingInputProjection(input) {
    return {
        interactionId: input.inputId,
        inputId: input.inputId,
        sessionId: input.sessionId,
        kind: 'follow-up',
        prompt: input.prompt,
        state: input.state,
        clientUserMessageId: input.clientMessageId,
        turnId: input.turnId || null,
        attempt: Number(input.attemptCount || 0),
        error: input.lastError || null,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
    };
}

function compatibilityRuntime(session, state = {}) {
    return {
        sessionId: session.sessionId,
        topicId: session.sessionId,
        threadId: session.threadId,
        agentId: session.agentId,
        title: session.title,
        model: session.configSnapshot?.model || null,
        configSnapshot: session.configSnapshot || {},
        workspaceRoot: session.workspaceRoot,
        activity: state?.activity || (session.state === 'running' ? 'running' : 'idle'),
        activeTurnId: state?.activeTurnId || null,
        runtime: 'codex',
    };
}

function buildTurnInput(text, attachments) {
    const input = [];
    if (text) input.push({ type: 'text', text, text_elements: [] });
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
        const filePath = String(attachment?.path || '').trim();
        const url = String(attachment?.url || '').trim();
        const kind = attachment?.kind;
        if (kind === 'image' && filePath) input.push({ type: 'localImage', path: filePath });
        else if (kind === 'image' && url) input.push({ type: 'image', url });
        else if (kind === 'audio' && filePath) input.push({ type: 'localAudio', path: filePath });
        else if (kind === 'audio' && url) input.push({ type: 'audio', url });
        else if (filePath) {
            input.push({ type: 'mention', name: path.basename(filePath), path: filePath });
        }
    }
    return input;
}

function attachmentDescriptor(filePath, size) {
    const extension = path.extname(filePath).toLowerCase();
    const image = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico']);
    const audio = new Set(['.wav', '.mp3', '.aiff', '.aif', '.aac', '.ogg', '.flac']);
    return {
        attachmentId: id('attachment'),
        displayName: path.basename(filePath),
        path: filePath,
        byteLen: size,
        kind: image.has(extension) ? 'image' : audio.has(extension) ? 'audio' : 'file',
    };
}

function notificationItemId(message) {
    return message?.params?.itemId || message?.params?.item?.id || null;
}

function approvalProjection(requestId, request, repository) {
    const params = request?.params || {};
    const session = params.threadId ? repository?.getSessionByThread(params.threadId) : null;
    return {
        approvalId: String(requestId),
        requestId: String(requestId),
        scope: 'codex-native',
        method: request?.method || '',
        topicId: session?.sessionId || null,
        sessionId: session?.sessionId || null,
        threadId: params.threadId || null,
        turnId: params.turnId || null,
        toolCallId: params.itemId || params.callId || null,
        reason: params.reason || null,
        command: params.command || null,
        cwd: params.cwd || null,
        params,
        generation: Number(request?.runtimeGeneration || 0),
    };
}

function approvalEvent(requestId, request, repository) {
    const approval = approvalProjection(requestId, request, repository);
    return {
        type: 'approval.requested',
        topicId: approval.topicId,
        sessionId: approval.sessionId,
        turnId: approval.turnId,
        toolCallId: approval.toolCallId,
        payload: { approval },
    };
}

function normalizeApprovalDecision(decision) {
    if (decision && typeof decision === 'object' && 'decision' in decision) return decision.decision;
    const value = String(decision || '').trim();
    if (['accept', 'acceptForSession', 'decline', 'cancel'].includes(value)) return value;
    if (['allow', 'approve', 'approved', 'yes'].includes(value)) return 'accept';
    if (['always-allow', 'allow-session'].includes(value)) return 'acceptForSession';
    if (['cancelled', 'interrupt'].includes(value)) return 'cancel';
    return 'decline';
}

function isUncertainRemoteMutation(error) {
    return ['REQUEST_TIMEOUT', 'PROCESS_EXITED', 'STOPPED', 'NOT_RUNNING', 'RUNTIME_CRASHED', 'STALE_GENERATION']
        .includes(String(error?.code || ''));
}

function normalizeApprovalPolicy(value) {
    const policy = String(value || '').trim();
    if (['untrusted', 'on-failure', 'on-request', 'never'].includes(policy)) return policy;
    if (['always-approve', 'alwaysApprove'].includes(policy)) return 'never';
    return 'on-request';
}

function normalizePermissionMode(value) {
    const mode = String(value || '').trim();
    if (mode === 'always-approve' || mode === 'alwaysApprove' || mode === 'never') return 'always-approve';
    return 'ask';
}

function normalizeSandboxMode(value) {
    const mode = String(value || '').trim();
    if (['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) return mode;
    if (mode === 'readOnly') return 'read-only';
    if (mode === 'dangerFullAccess') return 'danger-full-access';
    return 'workspace-write';
}

function approvalResponse(method, decision) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        return { decision: normalizeApprovalDecision(decision) };
    }
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
        const normalized = normalizeApprovalDecision(decision);
        return { decision: normalized === 'accept' || normalized === 'acceptForSession' ? 'approved' : 'abort' };
    }
    return failClosedApprovalResponse(method);
}

function failClosedApprovalResponse(method) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        return { decision: 'decline' };
    }
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { decision: 'abort' };
    return null;
}

function interactionExpiry(message) {
    const autoResolutionMs = Number(message?.params?.autoResolutionMs);
    if (!Number.isFinite(autoResolutionMs) || autoResolutionMs <= 0) return null;
    return Date.now() + Math.min(15 * 60 * 1000, Math.max(1_000, autoResolutionMs));
}

function sanitizeInteractionPayload(value, depth = 0) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 16_384);
    if (depth >= 6) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitizeInteractionPayload(item, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 16_384);
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 128)) {
        if (/token|secret|password|api.?key|authorization/i.test(key)) {
            result[key] = '[redacted]';
        } else {
            result[key] = sanitizeInteractionPayload(child, depth + 1);
        }
    }
    return result;
}

function normalizeInteractionResponse(request, response) {
    const method = request?.method;
    const params = request?.params || {};
    if (method === 'item/tool/requestUserInput') {
        const questions = Array.isArray(params.questions) ? params.questions : [];
        const submitted = response?.answers && typeof response.answers === 'object' ? response.answers : {};
        const answers = {};
        for (const question of questions.slice(0, 16)) {
            const id = String(question?.id || '').trim();
            if (!id) continue;
            const raw = submitted[id]?.answers ?? submitted[id] ?? [];
            const values = (Array.isArray(raw) ? raw : [raw])
                .map((value) => String(value ?? '').slice(0, 16_384))
                .filter((value) => value.length > 0)
                .slice(0, 8);
            if (values.length) answers[id] = { answers: values };
        }
        return { answers };
    }
    if (method === 'item/permissions/requestApproval') {
        if (response?.decision !== 'accept') return { permissions: {}, scope: 'turn' };
        const requested = params.permissions && typeof params.permissions === 'object' ? params.permissions : {};
        const permissions = {};
        if (requested.network) permissions.network = sanitizeInteractionPayload(requested.network);
        if (requested.fileSystem) permissions.fileSystem = sanitizeInteractionPayload(requested.fileSystem);
        return {
            permissions,
            scope: response?.scope === 'session' ? 'session' : 'turn',
            strictAutoReview: response?.strictAutoReview === true ? true : undefined,
        };
    }
    if (method === 'mcpServer/elicitation/request') {
        const action = ['accept', 'decline', 'cancel'].includes(response?.action) ? response.action : 'cancel';
        const content = action === 'accept' && params.mode !== 'url' && response?.content && typeof response.content === 'object'
            ? validateMcpElicitationContent(params.requestedSchema, response.content)
            : null;
        return { action, content, _meta: null };
    }
    throw new CodexAppServerError('UNSUPPORTED_INTERACTION', `Unsupported Codex interaction: ${method || '(empty)'}`);
}

function validateMcpElicitationContent(schema, input) {
    if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
        return sanitizeInteractionPayload(input);
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const content = {};
    for (const [key, definition] of Object.entries(schema.properties).slice(0, 64)) {
        if (!(key in input)) {
            if (required.has(key)) throw new CodexAppServerError('INVALID_INTERACTION_RESPONSE', `Missing required MCP field: ${key}`);
            continue;
        }
        const value = input[key];
        const type = Array.isArray(definition?.type) ? definition.type[0] : definition?.type;
        if (type === 'boolean' && typeof value !== 'boolean') throw new CodexAppServerError('INVALID_INTERACTION_RESPONSE', `MCP field ${key} must be boolean`);
        if ((type === 'number' || type === 'integer') && !Number.isFinite(Number(value))) {
            throw new CodexAppServerError('INVALID_INTERACTION_RESPONSE', `MCP field ${key} must be numeric`);
        }
        if (Array.isArray(definition?.enum) && !definition.enum.includes(value)) {
            throw new CodexAppServerError('INVALID_INTERACTION_RESPONSE', `MCP field ${key} is outside the allowed values`);
        }
        content[key] = sanitizeInteractionPayload(value);
    }
    return content;
}

function bridgeResultContentItems(result) {
    const items = [];
    const text = result.output || result.error || result.message;
    if (text) items.push({ type: 'inputText', text: String(text) });
    for (const resource of Array.isArray(result.resources) ? result.resources : []) {
        const url = String(resource?.url || resource?.imageUrl || resource?.audioUrl || '').trim();
        if (!url) continue;
        if (resource.type === 'audio' || resource.mimeType?.startsWith('audio/')) {
            items.push({ type: 'inputAudio', audioUrl: url });
        } else if (resource.type === 'image' || resource.mimeType?.startsWith('image/')) {
            items.push({ type: 'inputImage', imageUrl: url });
        }
    }
    if (!items.length) items.push({ type: 'inputText', text: JSON.stringify(result) });
    return items;
}

function classifyToolboxEvent(channel, value) {
    if (channel === 'info') {
        const type = String(value?.type || value?.data?.type || value?.kind || '').trim();
        if (/RAG_RETRIEVAL_DETAILS/i.test(type)) return 'rag-retrieval';
        if (/META_THINKING_CHAIN/i.test(type)) return 'meta-thinking';
        if (/AI_MEMO_RETRIEVAL/i.test(type)) return 'memory';
        if (/AGENT_PRIVATE_CHAT_PREVIEW/i.test(type)) return 'private-chat-preview';
        if (/DailyNote/i.test(type)) return 'daily-note';
        if (/AGENT_DREAM_/i.test(type)) return 'dream';
        return 'notification';
    }
    if (channel === 'log') return 'log';
    if (channel?.endsWith('-status')) return 'connection-status';
    return 'notification';
}

function sanitizeToolboxValue(value, depth = 0) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 16_384);
    if (depth >= 5) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeToolboxValue(item, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 16_384);
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
        if (/api[-_]?key|authorization|cookie|secret|token/i.test(key)) {
            result[key] = '[redacted]';
        } else {
            result[key] = sanitizeToolboxValue(child, depth + 1);
        }
    }
    return result;
}

module.exports = { CodexRuntimeManager, vcpInvokeTool };
