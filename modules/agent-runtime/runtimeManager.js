'use strict';

const { fail, ERROR_CODES, AgentRuntimeError } = require('./errors');
const {
    EVENT_TYPES,
    LIMITS,
    RUNTIME_KINDS,
    LEGACY_TOOL_NAMES,
    assertPrompt,
    hashArguments,
} = require('./contracts');
const {
    RUNTIME_STATES,
    SESSION_STATES,
    TURN_STATES,
    TOOL_STATES,
    transition,
} = require('./runtimeState');
const { SessionRegistry } = require('./sessionRegistry');
const { WorkerTransport } = require('./workerTransport');
const { ApprovalBroker } = require('./approvalBroker');
const { canonicalizeWorkspaceRoot, resolveInsideRoot } = require('./workspacePolicy');
const { summarizeValue, redactValue } = require('./secretRedactor');
const { LegacyVcpToolboxClient, normalizeVcpBaseUrl } = require('./toolbox/legacyVcpToolboxClient');
const { classifyLegacyTool, classifyPatchTool } = require('./toolbox/toolRiskClassifier');
const { PatchManager, escapeVcpLiterals } = require('./workspace/patchManager');
const { LocalToolCatalog } = require('./catalog/localToolCatalog');
const { CapabilityPolicy } = require('./security/capabilityPolicy');
const { SubagentCoordinator } = require('./orchestration/subagentCoordinator');

const PATCH_TOOL_NAMES = new Set([
    'workspace_propose_patch',
    'workspace_apply_patch',
    'workspace_revert_patch',
]);
const FILE_PATH_ARGUMENT = /^(?:path|filePath|directoryPath|searchPath|source|sourcePath|destination|destinationPath)(?:\d+)?$/i;

class AgentRuntimeManager {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot;
        this.driver = options.driver || RUNTIME_KINDS.PI;
        this.getSettings = options.getSettings || (() => ({}));
        this.sendEvent = options.sendEvent || (() => {});
        this.hasUi = options.hasUi || (() => true);
        this.transportFactory = options.transportFactory || ((transportOptions) => new WorkerTransport(transportOptions));
        this.store = options.store || null;
        this.restored = false;

        this.state = RUNTIME_STATES.STOPPED;
        this.transport = null;
        this.probe = null;
        this.lastError = null;
        this.registry = new SessionRegistry();
        this.activeDelegateRequests = new Map();
        this.activeTools = new Map();
        this.patchManagers = new Map();
        this.auditLog = [];
        this.maxAuditEntries = 500;
        this.toolboxClientFactory = options.toolboxClientFactory || (() => (
            LegacyVcpToolboxClient.fromSettings(this.getSettings() || {})
        ));
        this.catalog = options.catalog || new LocalToolCatalog({
            roots: options.catalogRoots || (this.projectRoot ? [{ id: 'bundled-toolbox', path: `${this.projectRoot}/VCPDistributedServer` }] : []),
        });
        this.subagents = options.subagentCoordinator || new SubagentCoordinator({
            budget: options.subagentBudget,
            createChild: (request) => this._createSubagentChild(request),
            runChild: (request) => this._runSubagentChild(request),
            cancelChild: (request) => this._cancelSubagentChild(request),
            onEvent: (event) => this._handleSubagentEvent(event),
        });

        this.approvals = new ApprovalBroker({
            hasUi: this.hasUi,
            onEvent: (approvalEvent) => this._handleApprovalEvent(approvalEvent),
        });
    }

    getStatus() {
        return {
            state: this.state,
            protocolVersion: 1,
            driver: this.driver,
            worker: this.transport && this.transport.probe
                ? redactValue(this.transport.probe)
                : null,
            lastError: this.lastError,
            sessions: this.registry.list(),
            pendingApprovals: this.approvals.listPending(),
            toolbox: this._toolboxInfo(),
            catalog: this._catalogStatus(),
            orchestration: {
                subagents: { available: this.driver === RUNTIME_KINDS.PI, usage: this.subagents.usage() },
                team: { status: 'experimental', available: false, apiVersion: 1 },
            },
        };
    }

    _toolboxInfo() {
        const settings = this.getSettings() || {};
        return {
            configured: Boolean(settings.vcpServerUrl && settings.vcpApiKey),
            baseUrl: settings.vcpServerUrl || null,
        };
    }

    _catalogStatus() {
        const snapshot = this.catalog.getSnapshot();
        return snapshot ? {
            status: snapshot.status,
            available: snapshot.available,
            generatedAt: snapshot.generatedAt,
            catalogHash: snapshot.catalogHash,
            toolCount: snapshot.tools.length,
            diagnostics: snapshot.diagnostics,
            drift: snapshot.drift,
        } : { status: 'unavailable', available: false, toolCount: 0, diagnostics: [] };
    }

    async refreshToolCatalog() {
        return this.catalog.refresh();
    }

    getToolCatalog(options = {}) {
        if (options.id) return this.catalog.get(options.id);
        return this.catalog.getSnapshot() || { schemaVersion: 1, status: 'unavailable', available: false, tools: [], diagnostics: [] };
    }

    _setRuntimeState(next, details) {
        transition('runtime', this.state, next);
        this.state = next;
        if (details && details.error) {
            this.lastError = details.error;
        }
        this._broadcastRuntimeEvent(EVENT_TYPES.RUNTIME_STATE_CHANGED, {
            state: next,
            details: details ? redactValue(details) : undefined,
        });
    }

    async start() {
        if (this.state === RUNTIME_STATES.READY || this.state === RUNTIME_STATES.DEGRADED) {
            return this.getStatus();
        }
        if (this.state !== RUNTIME_STATES.STOPPED) {
            fail(ERROR_CODES.INVALID_STATE_TRANSITION, `Cannot start runtime from ${this.state}`);
        }
        if (this.store && !this.restored) {
            for (const snapshot of this.store.restore()) {
                if (this.registry.maybeGet(snapshot.sessionId)) continue;
                const session = this.registry.restore(snapshot);
                if (session.state !== SESSION_STATES.CLOSED && session.workspaceRoot) {
                    try {
                        this._createPatchManager(session);
                    } catch (error) {
                        this._failSessionRestore(session, `workspace restore failed: ${error.message}`);
                    }
                }
            }
            this.restored = true;
        }
        await this.catalog.loadCache().catch(() => null);
        await this.catalog.refresh().catch((error) => {
            this.lastError = `tool catalog unavailable: ${error.message}`;
        });
        this._setRuntimeState(RUNTIME_STATES.STARTING);
        this.transport = this.transportFactory({
            projectRoot: this.projectRoot,
            driver: this.driver,
            onEvent: (message) => this._handleWorkerEvent(message),
            onModelRequest: (message) => this._handleModelRequest(message),
            onModelAbort: (message) => this._handleModelAbort(message),
            onToolRequest: (message) => this._handleToolRequest(message),
            onFatal: (error) => this._handleWorkerFatal(error),
            onExit: (code, signal) => this._handleWorkerExit(code, signal),
        });
        try {
            const started = await this.transport.start();
            this.probe = started.probe;
            await this._startRestoredSessions();
            if (started.probe && started.probe.available === false) {
                this._setRuntimeState(RUNTIME_STATES.DEGRADED, {
                    error: started.probe.details || 'worker probe unavailable',
                });
            } else {
                this._setRuntimeState(RUNTIME_STATES.READY);
            }
        } catch (error) {
            this._setRuntimeState(RUNTIME_STATES.DEGRADED, { error: error.message });
            throw error;
        }
        return this.getStatus();
    }

    async stop() {
        if (this.state === RUNTIME_STATES.STOPPED) {
            return { state: this.state };
        }
        if (this.state === RUNTIME_STATES.STOPPING) {
            fail(ERROR_CODES.SHUTDOWN_IN_PROGRESS, 'Runtime stop already in progress');
        }
        this._setRuntimeState(RUNTIME_STATES.STOPPING);
        this.approvals.cancelAll('runtime-stopped');
        for (const [requestId, entry] of this.activeDelegateRequests) {
            if (entry.toolbox) {
                await entry.toolbox.interrupt(requestId).catch(() => {});
            }
            this.activeDelegateRequests.delete(requestId);
        }
        for (const entry of this.activeTools.values()) {
            if (entry.cancelLocal) entry.cancelLocal();
        }
        this.activeTools.clear();
        for (const session of this._allSessions()) {
            const active = session.activeTurn();
            if (active && session.state !== 'closed') {
                try {
                    session.transitionTurn(active.turnId, TURN_STATES.CANCELLING);
                    session.transitionTurn(active.turnId, TURN_STATES.CANCELLED);
                } catch (error) {
                    // Best effort during shutdown.
                }
            }
        }
        this.patchManagers.clear();
        if (this.transport) {
            await this.transport.stop().catch(() => {});
            this.transport = null;
        }
        this._setRuntimeState(RUNTIME_STATES.STOPPED);
        return { state: this.state };
    }

    async createSession(options = {}) {
        this._requireUsableRuntime();
        let workspaceRoot = null;
        if (options.workspaceRoot) {
            workspaceRoot = canonicalizeWorkspaceRoot(options.workspaceRoot);
        }
        const settings = this.getSettings() || {};
        if (this.driver === RUNTIME_KINDS.PI && (!settings.vcpServerUrl || !settings.vcpApiKey)) {
            fail(ERROR_CODES.RUNTIME_NOT_READY, 'Pi session requires configured VCP server URL and API key');
        }
        if (this.driver === RUNTIME_KINDS.PI && !options.model) {
            fail(ERROR_CODES.RUNTIME_NOT_READY, 'Pi session requires an explicit model ID');
        }
        const record = this.registry.create(this.driver, {
            workspaceRoot,
            title: options.title || null,
            parentSessionId: options.parentSessionId || null,
            metadata: {
                ...(options.metadata || {}),
                model: options.model || null,
                systemPrompt: options.systemPrompt || options.metadata?.systemPrompt || null,
            },
        });
        const capabilityPolicy = CapabilityPolicy.forSession(record.sessionId, {
            ...(options.metadata || {}),
            capabilities: options.capabilities || options.metadata?.capabilities,
            capabilityPolicy: options.capabilityPolicy || options.metadata?.capabilityPolicy,
        });
        record.metadata.capabilityPolicy = capabilityPolicy.snapshot();
        record.metadata.execution = { mode: 'vcp-toolbox', decision: 'single-execution-backend' };
        if (this.store) this.store.saveSession(record);
        if (workspaceRoot) this._createPatchManager(record);
        try {
            await this._startWorkerSession(record);
        } catch (error) {
            this.registry.remove(record.sessionId);
            this.patchManagers.delete(record.sessionId);
            if (this.store) this.store.deleteSession(record.sessionId);
            throw error;
        }
        this._emit(record, EVENT_TYPES.SESSION_CREATED, {
            workspaceRoot,
            driver: this.driver,
        });
        return record.summary();
    }

    listSessions() {
        return { sessions: this.registry.list() };
    }

    getSession(sessionId) {
        const session = this.registry.get(sessionId);
        return {
            ...session.summary(),
            metadata: redactValue(session.metadata),
            turns: Array.from(session.turns.values()).map((turn) => ({ ...turn, prompt: summarizeValue(turn.prompt, 500) })),
        };
    }

    renameSession(options) {
        const session = this.registry.get(options.sessionId);
        const title = String(options.title || '').trim().slice(0, 200);
        if (!title) fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, 'Session title is required');
        session.title = title;
        session.updatedAt = Date.now();
        if (this.store) this.store.saveSession(session);
        return session.summary();
    }

    async closeSession(options) {
        const session = this.registry.get(options.sessionId);
        if (session.state === SESSION_STATES.CLOSED) return session.summary();
        const active = session.activeTurn();
        if (active) await this.cancelTurn({ sessionId: session.sessionId, turnId: active.turnId });
        session.setState(SESSION_STATES.CLOSING);
        this.approvals.cancelForSession(session.sessionId, 'session-closed');
        if (this.transport && this.transport.isRunning()) {
            await this.transport.sendRequest('close-session', { sessionId: session.sessionId }, 15000).promise.catch(() => {});
        }
        session.setState(SESSION_STATES.CLOSED);
        this.patchManagers.delete(session.sessionId);
        if (this.store) this.store.saveSession(session);
        this._emit(session, EVENT_TYPES.SESSION_CLOSED, {});
        return session.summary();
    }

    async deleteSession(options) {
        const session = this.registry.get(options.sessionId);
        if (session.state !== SESSION_STATES.CLOSED) await this.closeSession(options);
        this.registry.remove(session.sessionId);
        if (this.store) this.store.deleteSession(session.sessionId);
        return { ok: true, sessionId: session.sessionId };
    }

    async forkSession(options) {
        const source = this.registry.get(options.sessionId);
        const fork = await this.createSession({
            workspaceRoot: source.workspaceRoot,
            model: source.metadata.model,
            metadata: { ...source.metadata, forkedFrom: source.sessionId },
            title: options.title || (source.title ? `${source.title} (fork)` : null),
            parentSessionId: source.sessionId,
        });
        if (this.store) {
            for (const message of this.store.getMessages(source.sessionId)) {
                this.store.saveMessage({ ...message, messageId: undefined, sessionId: fork.sessionId });
            }
        }
        return fork;
    }

    getMessages(sessionId) {
        return { messages: this.store ? this.store.getMessages(sessionId) : [] };
    }

    getArtifacts(sessionId) {
        this.registry.get(sessionId);
        return { artifacts: this.store && typeof this.store.getArtifacts === 'function' ? this.store.getArtifacts(sessionId) : [] };
    }

    listPatchProposals(sessionId) {
        this.registry.get(sessionId);
        return { proposals: this._requirePatchManager(sessionId).list() };
    }

    getPatchProposal(options = {}) {
        this.registry.get(options.sessionId);
        return this._requirePatchManager(options.sessionId).get(options.proposalId);
    }

    rejectPatchProposal(options = {}) {
        this.registry.get(options.sessionId);
        return this._requirePatchManager(options.sessionId).reject(options.proposalId);
    }

    _requirePatchManager(sessionId) {
        const patchManager = this.patchManagers.get(sessionId);
        if (!patchManager) fail(ERROR_CODES.WORKSPACE_INVALID, 'Session has no bound workspace');
        return patchManager;
    }

    compactSession(options) {
        const session = this.registry.get(options.sessionId);
        const messages = this.store ? this.store.getMessages(session.sessionId) : [];
        this._emit(session, EVENT_TYPES.CONTEXT_COMPACTION_STARTED, {
            messageCount: messages.length, facade: 'transcript',
        });
        const summary = buildTranscriptSummary(messages, options.instructions);
        const retained = messages.length > 0 ? messages[messages.length - 1].messageId : null;
        session.summaryText = summary;
        session.updatedAt = Date.now();
        if (this.store) {
            if (retained) this.store.markMessagesCompacted(session.sessionId, retained);
            this.store.saveCheckpoint({
                sessionId: session.sessionId,
                kind: 'transcript-compaction',
                summary,
                contextUsage: session.contextUsage,
                metadata: { facade: 'transcript', messageCount: messages.length },
            });
            this.store.saveSession(session);
        }
        this._emit(session, EVENT_TYPES.CONTEXT_COMPACTION_COMPLETED, {
            summary, messageCount: messages.length, facade: 'transcript',
        });
        return { ok: true, summary, messageCount: messages.length, facade: 'transcript' };
    }

    async startTurn(options) {
        this._requireUsableRuntime();
        const session = this.registry.get(options.sessionId);
        const prompt = assertPrompt(options.prompt);
        if (this.driver === RUNTIME_KINDS.PI) {
            const settings = this.getSettings() || {};
            if (!settings.vcpServerUrl || !settings.vcpApiKey) {
                fail(ERROR_CODES.RUNTIME_NOT_READY, 'VCP gateway configuration was removed after session creation');
            }
            if (options.model && options.model !== session.metadata.model) {
                fail(ERROR_CODES.INVALID_STATE_TRANSITION, 'Changing model within an active session is not supported');
            }
        }
        const turnId = session.startTurn(prompt);
        session.transitionTurn(turnId, TURN_STATES.RUNNING);
        const turn = session.getTurn(turnId);
        if (this.store) {
            this.store.saveSession(session);
            this.store.saveTurn(session.sessionId, turn, turn.turnIndex);
            this.store.saveMessage({ sessionId: session.sessionId, turnId, role: 'user', content: prompt });
        }
        this._emit(session, EVENT_TYPES.TURN_STARTED, { prompt: summarizeValue(prompt, 300) }, { turnId });

        const finish = (nextState, payload) => {
            const current = session.getTurn(turnId);
            if (!current) {
                return;
            }
            try {
                if (nextState === TURN_STATES.CANCELLED) {
                    if (current.state !== TURN_STATES.CANCELLING) {
                        session.transitionTurn(turnId, TURN_STATES.CANCELLING);
                    }
                    session.transitionTurn(turnId, TURN_STATES.CANCELLED);
                    this._emit(session, EVENT_TYPES.TURN_CANCELLED, payload, { turnId });
                } else if (nextState === TURN_STATES.FAILED) {
                    session.transitionTurn(turnId, TURN_STATES.FAILED);
                    this._emit(session, EVENT_TYPES.TURN_FAILED, payload, { turnId });
                } else {
                    session.transitionTurn(turnId, TURN_STATES.COMPLETED);
                    this._emit(session, EVENT_TYPES.TURN_COMPLETED, payload, { turnId });
                }
                const finished = session.getTurn(turnId);
                if (this.store) {
                    if (payload && payload.error) finished.error = summarizeValue(payload.error, 1000);
                    this.store.saveTurn(session.sessionId, finished, finished.turnIndex);
                    this.store.saveSession(session);
                }
            } catch (error) {
                this._emit(session, EVENT_TYPES.RUNTIME_WARNING, {
                    warning: `turn finish transition failed: ${error.message}`,
                }, { turnId });
            }
        };

        (async () => {
            try {
                const request = this.transport.sendRequest('start-turn', {
                    sessionId: session.sessionId,
                    turnId,
                    prompt,
                }, LIMITS.TURN_DEFAULT_TIMEOUT_MS);
                const ack = await request.promise;
                if (ack.ok === false || (ack.result && ack.result.ok === false)) {
                    const cancelled = ack.result && ack.result.cancelled;
                    finish(cancelled ? TURN_STATES.CANCELLED : TURN_STATES.FAILED, {
                        error: (ack.result && ack.result.error) || ack.error || 'turn failed',
                    });
                    return;
                }
                finish(TURN_STATES.COMPLETED, {});
            } catch (error) {
                finish(TURN_STATES.FAILED, { error: error.message });
            }
        })();

        return { turnId, state: TURN_STATES.RUNNING };
    }

    async cancelTurn(options) {
        const session = this.registry.get(options.sessionId);
        const turn = options.turnId
            ? session.getTurn(options.turnId)
            : session.activeTurn();
        if (!turn) {
            return { ok: true, note: 'no active turn' };
        }
        if (![TURN_STATES.RUNNING, TURN_STATES.AWAITING_APPROVAL, TURN_STATES.QUEUED].includes(turn.state)) {
            return { ok: true, note: `turn already ${turn.state}` };
        }
        session.transitionTurn(turn.turnId, TURN_STATES.CANCELLING);
        this.transport.sendRequest('cancel-turn', {
            sessionId: session.sessionId,
            turnId: turn.turnId,
        }, 15000).promise.catch(() => {});
        for (const [requestId, entry] of this.activeDelegateRequests) {
            if (entry.sessionId === session.sessionId && entry.turnId === turn.turnId) {
                if (entry.cancelLocal) {
                    entry.cancelLocal();
                }
                if (entry.toolbox) {
                    entry.toolbox.interrupt(requestId).catch(() => {});
                }
            }
        }
        for (const [toolCallId, entry] of this.activeTools) {
            if (entry.sessionId === session.sessionId && entry.turnId === turn.turnId && entry.cancelLocal) {
                entry.cancelLocal();
                this.activeTools.delete(toolCallId);
            }
        }
        this.approvals.cancelForSession(session.sessionId, 'turn-cancelled');
        await this.subagents.cancelByParent(session.sessionId, 'parent-turn-cancelled');
        session.transitionTurn(turn.turnId, TURN_STATES.CANCELLED);
        if (this.store) {
            this.store.saveTurn(session.sessionId, turn, turn.turnIndex);
            this.store.saveSession(session);
        }
        this._emit(session, EVENT_TYPES.TURN_CANCELLED, { reason: 'user-request' }, { turnId: turn.turnId });
        return { ok: true };
    }

    async steerTurn(options) {
        this._requireUsableRuntime();
        const session = this.registry.get(options.sessionId);
        const turn = session.activeTurn();
        const prompt = assertPrompt(options.prompt);
        if (!turn || turn.turnId !== options.turnId) {
            fail(ERROR_CODES.INVALID_STATE_TRANSITION, 'Steering requires the active turn for this session');
        }
        const ack = await this.transport.sendRequest('steer-turn', {
            sessionId: session.sessionId,
            turnId: turn.turnId,
            prompt,
        }, 15000).promise;
        if (ack.ok === false || ack.result?.ok === false) {
            fail(ERROR_CODES.RUNTIME_NOT_READY, ack.error || ack.result?.error || 'Unable to queue steering input');
        }
        if (this.store) this.store.saveMessage({ sessionId: session.sessionId, turnId: turn.turnId, role: 'user', content: prompt });
        this._emit(session, EVENT_TYPES.USER_MESSAGE, { prompt, queued: true }, { turnId: turn.turnId });
        return { ok: true, turnId: turn.turnId };
    }

    respondApproval(options) {
        const result = this.approvals.respond(
            options.approvalId,
            options.decision,
            options.arguments,
            {
                sessionId: options.sessionId,
                turnId: options.turnId,
                toolCallId: options.toolCallId,
                argumentsHash: options.argumentsHash,
            },
        );
        return result;
    }

    getEvents(sessionId, sinceSequence = 0) {
        const session = this.registry.get(sessionId);
        if (this.store) return this.store.getEvents(sessionId, sinceSequence);
        return {
            events: session.buffer.since(sinceSequence),
            lastSequence: session.sequencer.sequence,
            droppedCount: session.buffer.droppedCount,
        };
    }

    getAuditLog() {
        return this.auditLog.slice(-this.maxAuditEntries);
    }

    async _handleModelRequest(message) {
        const session = this.registry.maybeGet(message.sessionId);
        if (!session) {
            this.transport.sendModelError({ requestId: message.requestId, error: 'unknown session' });
            return;
        }
        const settings = this.getSettings() || {};
        if (!settings.vcpServerUrl || !settings.vcpApiKey) {
            this.transport.sendModelError({ requestId: message.requestId, error: 'VCP gateway not configured' });
            return;
        }
        const controller = new AbortController();
        this.activeDelegateRequests.set(message.requestId, {
            sessionId: message.sessionId,
            turnId: message.turnId,
            cancelLocal: () => controller.abort(),
        });
        try {
            const body = { ...message.body, stream: true, stream_options: { include_usage: true } };
            const response = await fetch(`${normalizeVcpBaseUrl(settings.vcpServerUrl)}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                    Authorization: `Bearer ${settings.vcpApiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!response.ok) {
                const text = await response.text();
                this.transport.sendModelError({ requestId: message.requestId, error: `VCP model gateway HTTP ${response.status}: ${text.slice(0, 500)}` });
                return;
            }
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('text/event-stream')) {
                this.transport.sendModelResult({ requestId: message.requestId, ok: true, data: await response.json() });
                return;
            }
            let usage;
            let finishReason;
            await parseOpenAiSse(response.body, (chunk) => {
                usage = chunk.usage || usage;
                const choice = chunk.choices && chunk.choices[0];
                if (choice && choice.finish_reason) finishReason = choice.finish_reason;
                if (choice && choice.delta) {
                    for (const delta of splitModelDelta(choice.delta, LIMITS.MODEL_DELTA_CHUNK_BYTES)) {
                        this.transport.sendModelDelta({ requestId: message.requestId, delta });
                    }
                }
            }, controller.signal);
            if (usage) {
                session.contextUsage = normalizeContextUsage(usage, session.metadata.contextWindow);
                if (this.store) this.store.saveSession(session);
                this._emit(session, EVENT_TYPES.CONTEXT_USAGE, session.contextUsage, { turnId: message.turnId });
            }
            this.transport.sendModelDone({ requestId: message.requestId, usage, finishReason });
        } catch (error) {
            this.transport.sendModelError({ requestId: message.requestId, error: controller.signal.aborted ? 'model request cancelled' : error.message });
        } finally {
            this.activeDelegateRequests.delete(message.requestId);
        }
    }

    _handleModelAbort(message) {
        const active = this.activeDelegateRequests.get(message.requestId);
        if (active && active.cancelLocal) active.cancelLocal();
    }

    async _handleToolRequest(message) {
        const session = this.registry.maybeGet(message.sessionId);
        if (!session) {
            this.transport.sendToolResult({
                ...message,
                ok: false,
                error: `unknown session: ${message.sessionId}`,
            });
            return;
        }
        const { toolCallId, toolName, arguments: toolArgs, turnId } = message;
        const toolRecord = {
            toolCallId, sessionId: session.sessionId, turnId, toolName,
            state: TOOL_STATES.REQUESTED,
            argumentsHash: hashArguments(toolArgs || {}),
            argumentSummary: summarizeValue(toolArgs),
        };
        if (this.store) this.store.saveToolCall(toolRecord);
        this._emit(session, EVENT_TYPES.TOOL_REQUESTED, {
            toolName,
            argumentSummary: toolRecord.argumentSummary,
            argumentsHash: toolRecord.argumentsHash,
        }, { turnId, toolCallId });

        const setToolState = (state, extra = {}) => {
            const typeByState = {
                [TOOL_STATES.AWAITING_LOCAL_APPROVAL]: EVENT_TYPES.TOOL_AWAITING_LOCAL_APPROVAL,
                [TOOL_STATES.AWAITING_TOOLBOX_APPROVAL]: EVENT_TYPES.TOOL_AWAITING_TOOLBOX_APPROVAL,
                [TOOL_STATES.RUNNING]: EVENT_TYPES.TOOL_STARTED,
                [TOOL_STATES.COMPLETED]: EVENT_TYPES.TOOL_COMPLETED,
                [TOOL_STATES.FAILED]: EVENT_TYPES.TOOL_FAILED,
                [TOOL_STATES.CANCELLED]: EVENT_TYPES.TOOL_CANCELLED,
            };
            const type = typeByState[state];
            toolRecord.state = state;
            toolRecord.outputSummary = extra.outputSummary || toolRecord.outputSummary;
            toolRecord.error = extra.error || toolRecord.error;
            if (this.store) this.store.saveToolCall(toolRecord);
            if (type) {
                this._emit(session, type, { toolName, ...extra }, { turnId, toolCallId });
            }
        };

        (async () => {
            const capability = this._evaluateToolCapability(session, toolName, toolArgs || {});
            if (!capability.allowed) {
                this._audit(session, turnId, toolCallId, toolName, 'denied', { source: 'capability-policy', capability });
                setToolState(TOOL_STATES.CANCELLED, { source: 'capability-policy', reason: capability.reason });
                this.transport.sendToolResult({ ...message, ok: false, error: `capability denied: ${capability.reason}` });
                return;
            }
            if (toolName === 'spawn_agent' || toolName === 'await_agent' || toolName === 'cancel_agent') {
                await this._executeSubagentTool({ session, turnId, toolCallId, toolName, toolArgs, message, setToolState });
                return;
            }
            if (PATCH_TOOL_NAMES.has(toolName)) {
                await this._executePatchTool({ session, turnId, toolCallId, toolName, toolArgs, message, setToolState });
                return;
            }
            const classification = classifyLegacyTool(toolName, toolArgs || {});
            let approvalOutcome = { approved: true, reason: 'policy-auto-approved-read' };
            if (classification.requiresApproval) {
                try {
                setToolState(TOOL_STATES.AWAITING_LOCAL_APPROVAL, {
                    riskLevel: classification.riskLevel,
                    reasons: classification.reasons,
                });
                const request = this.approvals.requestApproval({
                    sessionId: session.sessionId,
                    turnId,
                    toolCallId,
                    toolName,
                    kind: classification.kind,
                    riskLevel: classification.riskLevel,
                    reason: classification.reasons.join('; '),
                    arguments: toolArgs || {},
                });
                approvalOutcome = await request.promise;
                } catch (error) {
                    approvalOutcome = { approved: false, reason: error.message };
                }
            }
            if (!approvalOutcome.approved) {
                this._audit(session, turnId, toolCallId, toolName, 'denied', {
                    reason: approvalOutcome.reason,
                });
                setToolState(TOOL_STATES.CANCELLED, { reason: approvalOutcome.reason || 'approval denied' });
                this.transport.sendToolResult({
                    ...message,
                    ok: false,
                    error: `denied: ${approvalOutcome.reason || 'approval denied'}`,
                });
                return;
            }

            setToolState(TOOL_STATES.RUNNING, { riskLevel: classification.riskLevel });
            setToolState(TOOL_STATES.AWAITING_TOOLBOX_APPROVAL, {
                note: 'Legacy bridge cannot prove correlation with VCPToolBox approval; server-side approval may still block execution.',
            });
            const startedAt = Date.now();
            try {
                const result = await this._executeLegacyTool(session, turnId, toolCallId, toolName, toolArgs || {});
                this._audit(session, turnId, toolCallId, toolName, result.ok ? 'completed' : 'failed', {
                    durationMs: Date.now() - startedAt,
                    error: result.error,
                    endpoint: result.audit && result.audit.endpoint,
                });
                setToolState(result.ok ? TOOL_STATES.COMPLETED : TOOL_STATES.FAILED, {
                    outputSummary: summarizeValue(result.output || result.error || '', 500),
                });
                this.transport.sendToolResult({
                    ...message,
                    ok: result.ok,
                    output: result.output,
                    error: result.error,
                    audit: result.audit,
                });
            } catch (error) {
                this._audit(session, turnId, toolCallId, toolName, 'failed', {
                    durationMs: Date.now() - startedAt,
                    error: error.message,
                });
                setToolState(TOOL_STATES.FAILED, { error: summarizeValue(error.message, 500) });
                this.transport.sendToolResult({
                    ...message,
                    ok: false,
                    error: error.message,
                });
            } finally {
                this.activeTools.delete(toolCallId);
            }
        })();
    }

    _evaluateToolCapability(session, toolName, args) {
        const action = toolAction(toolName, args);
        const nestedArgs = toolName === LEGACY_TOOL_NAMES.VCP_INVOKE ? (args.arguments || {}) : args;
        const candidatePath = nestedArgs.path || nestedArgs.filePath || nestedArgs.directoryPath || nestedArgs.searchPath || null;
        try {
            return CapabilityPolicy.fromSnapshot(session.metadata.capabilityPolicy).evaluate({
                sessionId: session.sessionId,
                toolId: toolName,
                action,
                path: candidatePath,
            });
        } catch (error) {
            return { allowed: false, effect: 'deny', reason: 'invalid-session-capability-policy', matchedRuleIds: [] };
        }
    }

    async _executeSubagentTool({ session, turnId, toolCallId, toolName, toolArgs, message, setToolState }) {
        setToolState(TOOL_STATES.RUNNING, { source: 'main-subagent-coordinator' });
        try {
            let output;
            if (toolName === 'spawn_agent') {
                if (this.driver !== RUNTIME_KINDS.PI) throw new Error('Subagents require the Pi runtime');
                output = await this.subagents.spawn({
                    parentSessionId: session.sessionId,
                    task: { prompt: assertPrompt(toolArgs.prompt || toolArgs.task) },
                    metadata: { model: toolArgs.model || session.metadata.model, title: toolArgs.title || null },
                    budget: toolArgs.budget || {},
                });
            } else if (toolName === 'await_agent') {
                output = await this.subagents.await(String(toolArgs.taskId || ''));
            } else {
                output = { cancelled: await this.subagents.cancel(String(toolArgs.taskId || ''), toolArgs.reason || 'agent-requested') };
            }
            setToolState(TOOL_STATES.COMPLETED, { source: 'main-subagent-coordinator', outputSummary: summarizeValue(output, 500) });
            this.transport.sendToolResult({ ...message, ok: true, output });
        } catch (error) {
            setToolState(TOOL_STATES.FAILED, { source: 'main-subagent-coordinator', error: summarizeValue(error.message, 500) });
            this.transport.sendToolResult({ ...message, ok: false, error: error.message });
        }
    }

    async _executePatchTool({ session, turnId, toolCallId, toolName, toolArgs, message, setToolState }) {
        const patchManager = this.patchManagers.get(session.sessionId);
        if (!patchManager) {
            this.transport.sendToolResult({ ...message, ok: false, error: 'Session has no bound workspace' });
            return;
        }
        const startedAt = Date.now();
        const risk = classifyPatchTool(toolName, toolArgs || {});
        this.activeTools.set(toolCallId, {
            sessionId: session.sessionId,
            turnId,
        });
        if (risk.requiresApproval) {
            setToolState(TOOL_STATES.AWAITING_LOCAL_APPROVAL, {
                source: 'patch-workflow',
                riskLevel: risk.riskLevel,
                reasons: risk.reasons,
            });
            const turn = session.getTurn(turnId);
            if (turn && turn.state === TURN_STATES.RUNNING) {
                session.transitionTurn(turnId, TURN_STATES.AWAITING_APPROVAL);
                if (this.store) this.store.saveTurn(session.sessionId, turn, turn.turnIndex);
            }
        }
        try {
            if (risk.requiresApproval) {
                const requested = this.approvals.requestApproval({
                    sessionId: session.sessionId,
                    turnId,
                    toolCallId,
                    toolName,
                    kind: risk.kind,
                    riskLevel: risk.riskLevel,
                    reason: risk.reasons.join('; '),
                    arguments: toolArgs || {},
                });
                const approval = await requested.promise;
                const turn = session.getTurn(turnId);
                if (turn && turn.state === TURN_STATES.AWAITING_APPROVAL) {
                    session.transitionTurn(turnId, TURN_STATES.RUNNING);
                    if (this.store) this.store.saveTurn(session.sessionId, turn, turn.turnIndex);
                }
                if (!approval.approved) {
                    fail(ERROR_CODES.APPROVAL_DENIED, approval.reason || `Approval denied for ${toolName}`);
                }
            }
            setToolState(TOOL_STATES.RUNNING, { source: 'patch-workflow-via-vcp' });
            let output;
            if (toolName === 'workspace_propose_patch') {
                output = await patchManager.propose(toolArgs.path, toolArgs.content);
            } else if (toolName === 'workspace_apply_patch') {
                output = await patchManager.apply(toolArgs.proposalId, { approved: true });
            } else {
                output = await patchManager.revert(toolArgs.proposalId, { approved: true });
            }
            this._audit(session, turnId, toolCallId, toolName, 'completed', {
                durationMs: Date.now() - startedAt,
                source: 'patch-workflow-via-vcp',
            });
            setToolState(TOOL_STATES.COMPLETED, {
                source: 'patch-workflow-via-vcp',
                outputSummary: summarizeValue(output, 500),
            });
            this.transport.sendToolResult({
                ...message,
                ok: true,
                output,
                audit: { source: 'patch-workflow-via-vcp', durationMs: Date.now() - startedAt },
            });
        } catch (error) {
            this._audit(session, turnId, toolCallId, toolName, 'failed', {
                durationMs: Date.now() - startedAt,
                source: 'patch-workflow-via-vcp',
                error: error.message,
            });
            const state = error.code === ERROR_CODES.APPROVAL_DENIED ? TOOL_STATES.CANCELLED : TOOL_STATES.FAILED;
            setToolState(state, { source: 'patch-workflow-via-vcp', error: summarizeValue(error.message, 500) });
            this.transport.sendToolResult({ ...message, ok: false, error: error.message });
        } finally {
            this.activeTools.delete(toolCallId);
        }
    }

    _createPatchManager(session) {
        if (!session.workspaceRoot || this.patchManagers.has(session.sessionId)) {
            return this.patchManagers.get(session.sessionId) || null;
        }
        const patchManager = new PatchManager({
            workspaceRoot: session.workspaceRoot,
            invokeTool: (request) => this.toolboxClientFactory().invokeTool(request),
        });
        this.patchManagers.set(session.sessionId, patchManager);
        return patchManager;
    }

    _workerSessionOptions(session) {
        const messages = this.store && typeof this.store.getMessages === 'function'
            ? this.store.getMessages(session.sessionId)
            : [];
        return {
            systemPrompt: this._buildAgentSystemPrompt(session),
            vcp: { model: session.metadata?.model || 'mock-model' },
            messages,
            summary: session.summaryText || undefined,
        };
    }

    _buildAgentSystemPrompt(session) {
        const customPrompt = String(session.metadata?.systemPrompt || '').trim();
        const workspaceGuidance = session.workspaceRoot
            ? `The active workspace is ${session.workspaceRoot}. Pass workspace paths as relative paths; VCPChat scopes FileOperator calls to this root.`
            : 'No workspace is bound. Do not claim workspace file access is available.';
        const catalog = this.catalog.getSnapshot();
        const catalogLines = [];
        let catalogBytes = 0;
        for (const tool of (catalog?.tools || [])) {
            if (tool.enabled === false) continue;
            const description = String(tool.display?.description || '').replace(/\s+/g, ' ').trim().slice(0, 500);
            const line = `- ${tool.id}${description ? `: ${description}` : ''}`;
            const lineBytes = Buffer.byteLength(line);
            if (catalogLines.length >= 40 || catalogBytes + lineBytes > 12_000) break;
            catalogLines.push(line);
            catalogBytes += lineBytes;
        }
        const runtimePrompt = [
            'You are the VCPChat Pi agent. Pi owns planning and the agent loop; VCPToolBox plugins are the only execution backend.',
            workspaceGuidance,
            'Use vcp_invoke to call existing plugins directly. Use FileOperator for file reads/listing/search and PowerShellExecutor for terminal or interactive CLI work.',
            'For workspace modifications, use workspace_propose_patch first, then workspace_apply_patch after approval. Use workspace_revert_patch to undo an applied proposal.',
            'Use vcp_delegate only as a compatibility fallback when direct plugin selection is genuinely impossible; it starts a nested ToolBox agent loop.',
            'Never claim an action succeeded without a returned tool result.',
            catalogLines.length > 0 ? `Available VCP plugin catalog:\n${catalogLines.join('\n')}` : 'The local VCP plugin catalog is unavailable; use only known plugin names.',
        ].join('\n\n');
        return customPrompt ? `${customPrompt}\n\n${runtimePrompt}` : runtimePrompt;
    }

    async _startWorkerSession(session) {
        const request = this.transport.sendRequest('start-session', {
            sessionId: session.sessionId,
            options: this._workerSessionOptions(session),
        }, LIMITS.WORKER_STARTUP_TIMEOUT_MS);
        const ack = await request.promise;
        if (ack.ok === false) {
            throw new AgentRuntimeError(ERROR_CODES.WORKER_PROTOCOL_ERROR, ack.error || 'worker rejected session');
        }
    }

    async _startRestoredSessions() {
        for (const session of this._allSessions()) {
            if (session.state === SESSION_STATES.CLOSED) continue;
            try {
                await this._startWorkerSession(session);
            } catch (error) {
                this._failSessionRestore(session, `worker session restore failed: ${error.message}`);
            }
        }
    }

    _failSessionRestore(session, error) {
        session.state = SESSION_STATES.FAILED;
        session.updatedAt = Date.now();
        if (this.store) this.store.saveSession(session);
        this._emit(session, EVENT_TYPES.RUNTIME_WARNING, { warning: summarizeValue(error, 500), restoreFailed: true });
    }

    async _createSubagentChild(request) {
        const parent = this.registry.get(request.parentSessionId);
        const child = await this.createSession({
            workspaceRoot: parent.workspaceRoot,
            model: request.metadata.model || parent.metadata.model,
            title: request.metadata.title || `Subagent: ${request.taskId}`,
            parentSessionId: parent.sessionId,
            metadata: {
                subagentTaskId: request.taskId,
                subagentDepth: request.depth,
                capabilityPolicy: parent.metadata.capabilityPolicy,
            },
        });
        return { sessionId: child.sessionId };
    }

    async _runSubagentChild(request) {
        const started = await this.startTurn({ sessionId: request.childSessionId, prompt: request.task.prompt });
        const final = await this._waitForTurn(request.childSessionId, started.turnId);
        if (final.state !== TURN_STATES.COMPLETED) throw Object.assign(new Error(final.error || `child turn ${final.state}`), { code: 'SUBAGENT_CHILD_TURN_FAILED' });
        const messages = this.store ? this.store.getMessages(request.childSessionId) : [];
        const assistant = [...messages].reverse().find((entry) => entry.role === 'assistant');
        const usage = this.registry.get(request.childSessionId).contextUsage || {};
        return {
            result: assistant ? assistant.content : { sessionId: request.childSessionId, turnId: started.turnId },
            usage: { tokens: usage.totalTokens || 0, cost: 0 },
        };
    }

    async _cancelSubagentChild(request) {
        const child = this.registry.maybeGet(request.childSessionId);
        if (!child) return { ok: false };
        await this.cancelTurn({ sessionId: child.sessionId });
        await this.closeSession({ sessionId: child.sessionId }).catch(() => {});
        return { ok: true };
    }

    _waitForTurn(sessionId, turnId) {
        return new Promise((resolve) => {
            const poll = () => {
                const turn = this.registry.get(sessionId).getTurn(turnId);
                if (!turn || [TURN_STATES.COMPLETED, TURN_STATES.CANCELLED, TURN_STATES.FAILED].includes(turn.state)) resolve(turn);
                else setTimeout(poll, 25);
            };
            poll();
        });
    }

    _handleSubagentEvent(event) {
        const parentId = event.task && event.task.parentSessionId;
        const parent = parentId && this.registry.maybeGet(parentId);
        if (parent) this._emit(parent, EVENT_TYPES.RUNTIME_WARNING, { orchestrationEvent: redactValue(event) });
    }

    async _executeLegacyTool(session, turnId, toolCallId, toolName, toolArgs) {
        const toolbox = this.toolboxClientFactory();
        const abortController = new AbortController();
        this.activeTools.set(toolCallId, {
            sessionId: session.sessionId,
            turnId,
            cancel: () => abortController.abort(),
        });
        if (toolName === LEGACY_TOOL_NAMES.VCP_DELEGATE) {
            const requestId = `agentrt_${toolCallId}`;
            this.activeDelegateRequests.set(requestId, {
                sessionId: session.sessionId,
                turnId,
                toolbox,
                cancelLocal: () => abortController.abort(),
            });
            try {
                this._emit(session, EVENT_TYPES.TOOL_PROGRESS, {
                    toolName,
                    note: 'delegating to VCPToolBox agent loop',
                }, { turnId, toolCallId });
                return await toolbox.delegate({
                    task: String(toolArgs.task || ''),
                    context: toolArgs.context ? String(toolArgs.context) : undefined,
                    requestId,
                    signal: abortController.signal,
                    onDelta: (delta) => {
                        this._emit(session, EVENT_TYPES.TOOL_PROGRESS, {
                            toolName,
                            delta: delta.slice(0, 2000),
                        }, { turnId, toolCallId });
                    },
                });
            } finally {
                this.activeDelegateRequests.delete(requestId);
            }
        }
        if (toolName === LEGACY_TOOL_NAMES.VCP_INVOKE) {
            const innerName = toolArgs.toolName;
            const innerArgs = this._scopeVcpInvocation(session, innerName, toolArgs.arguments || {});
            return toolbox.invokeTool({
                toolName: innerName,
                args: innerArgs,
                signal: abortController.signal,
            });
        }
        fail(ERROR_CODES.TOOL_PROTOCOL_VIOLATION, `Unsupported runtime tool: ${toolName}`);
    }

    _scopeVcpInvocation(session, toolName, toolArgs) {
        const args = { ...(toolArgs || {}) };
        if (toolName !== 'FileOperator' || !session.workspaceRoot) return args;
        for (const [key, value] of Object.entries(args)) {
            if (!FILE_PATH_ARGUMENT.test(key) || typeof value !== 'string' || /^https?:\/\//i.test(value)) continue;
            args[key] = resolveInsideRoot(session.workspaceRoot, value);
        }
        const commandKey = Object.keys(args).find((key) => /^command$/i.test(key));
        const contentKey = Object.keys(args).find((key) => /^content$/i.test(key));
        if (commandKey && contentKey && typeof args[contentKey] === 'string' && /^(?:WriteFile|EditFile)$/i.test(args[commandKey])) {
            const escaped = escapeVcpLiterals(args[contentKey]);
            if (escaped.changed) {
                args[contentKey] = escaped.content;
                args[commandKey] = /^WriteFile$/i.test(args[commandKey]) ? 'WriteEscapedFile' : 'EditEscapedFile';
            }
        }
        return args;
    }

    _handleWorkerEvent(message) {
        const session = this.registry.maybeGet(message.sessionId);
        if (!session) {
            return;
        }
        const workerEvent = message.event || {};
        // Pi emits lifecycle events around every native tool execution.  The main
        // process is also the authoritative executor for bridge tools: it owns
        // policy, approval, VCPToolBox dispatch and its terminal state.  Forwarding
        // both streams creates duplicate tool cards (`started`/`completed`) for a
        // single call and can make a UI report a result before its audit record is
        // written.  Keep only the main-process lifecycle for tools.
        if (typeof workerEvent.type === 'string' && workerEvent.type.startsWith('tool.')) {
            return;
        }
        if (workerEvent.turnId) {
            const turn = session.getTurn(workerEvent.turnId);
            if (!turn || [TURN_STATES.COMPLETED, TURN_STATES.CANCELLED, TURN_STATES.FAILED].includes(turn.state)) {
                this._audit(session, workerEvent.turnId, workerEvent.payload?.toolCallId, 'worker-event', 'lateResult', {
                    eventType: workerEvent.type,
                });
                return;
            }
        }
        const mapping = {
            'assistant.started': EVENT_TYPES.ASSISTANT_STARTED,
            'assistant.delta': EVENT_TYPES.ASSISTANT_DELTA,
            'assistant.completed': EVENT_TYPES.ASSISTANT_COMPLETED,
            'reasoning.started': EVENT_TYPES.REASONING_STARTED,
            'reasoning.delta': EVENT_TYPES.REASONING_DELTA,
            'reasoning.completed': EVENT_TYPES.REASONING_COMPLETED,
            'tool.started': EVENT_TYPES.TOOL_STARTED,
            'tool.progress': EVENT_TYPES.TOOL_PROGRESS,
            'tool.completed': EVENT_TYPES.TOOL_COMPLETED,
            'tool.failed': EVENT_TYPES.TOOL_FAILED,
        };
        const type = mapping[workerEvent.type];
        if (!type) {
            return;
        }
        if (this.store && workerEvent.type === 'assistant.completed' && workerEvent.payload?.message) {
            this.store.saveMessage({
                messageId: workerEvent.messageId,
                sessionId: session.sessionId,
                turnId: workerEvent.turnId,
                role: 'assistant',
                content: workerEvent.payload.message.content || [],
                metadata: { usage: workerEvent.payload.usage || workerEvent.payload.message.usage },
            });
        }
        this._emit(session, type, redactValue(workerEvent.payload || {}), {
            turnId: workerEvent.turnId,
            messageId: workerEvent.messageId,
            toolCallId: workerEvent.payload && workerEvent.payload.toolCallId,
        });
    }

    _handleWorkerFatal(error) {
        this.lastError = typeof error === 'string' ? error : error.message;
        this._broadcastRuntimeEvent(EVENT_TYPES.RUNTIME_WARNING, {
            warning: summarizeValue(this.lastError, 500),
        });
    }

    _handleWorkerExit(code, signal) {
        this.lastError = `worker exited (code ${code}, signal ${signal})`;
        if (this.state === RUNTIME_STATES.READY || this.state === RUNTIME_STATES.DEGRADED) {
            this._setRuntimeState(RUNTIME_STATES.DEGRADED, { error: this.lastError });
        }
        this._broadcastRuntimeEvent(EVENT_TYPES.RUNTIME_CRASHED, {
            code,
            signal,
        });
        this.approvals.cancelAll('worker-crashed');
        for (const session of this._allSessions()) {
            const active = session.activeTurn();
            if (active) {
                try {
                    session.transitionTurn(active.turnId, TURN_STATES.FAILED);
                    this._emit(session, EVENT_TYPES.TURN_FAILED, {
                        error: 'worker crashed',
                    }, { turnId: active.turnId });
                } catch (error) {
                    // Best effort.
                }
            }
        }
    }

    _handleApprovalEvent(approvalEvent) {
        const record = approvalEvent.record;
        const session = this.registry.maybeGet(record.sessionId);
        if (!session) {
            return;
        }
        const type = approvalEvent.type === 'approval.requested'
            ? EVENT_TYPES.APPROVAL_REQUESTED
            : approvalEvent.type === 'approval.expired'
                ? EVENT_TYPES.APPROVAL_EXPIRED
                : EVENT_TYPES.APPROVAL_RESOLVED;
        if (this.store) this.store.saveApproval(record, approvalEvent.outcome);
        this._emit(session, type, {
            approval: record,
            outcome: approvalEvent.outcome,
        }, {
            turnId: record.turnId,
            toolCallId: record.toolCallId,
            approvalId: record.approvalId,
        });
    }

    _audit(session, turnId, toolCallId, toolName, outcome, details = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            sessionId: session.sessionId,
            turnId,
            toolCallId,
            toolName,
            outcome,
            ...redactValue(details),
        };
        this.auditLog.push(entry);
        if (this.auditLog.length > this.maxAuditEntries) {
            this.auditLog.shift();
        }
        return entry;
    }

    _emit(session, type, payload, correlation = {}) {
        const event = session.emit(type, redactValue(payload || {}), correlation);
        if (this.store) this.store.saveEvent(event);
        this.sendEvent(event);
        return event;
    }

    _broadcastRuntimeEvent(type, payload) {
        const sessions = this._allSessions();
        if (sessions.length === 0) {
            this.sendEvent({
                schemaVersion: 1,
                eventId: `evt_${Date.now()}`,
                sequence: 0,
                timestamp: new Date().toISOString(),
                sessionId: 'runtime',
                runtime: this.driver,
                type,
                payload: redactValue(payload || {}),
            });
            return;
        }
        for (const session of sessions) {
            if (session.state !== 'closed') {
                this._emit(session, type, payload);
            }
        }
    }

    _allSessions() {
        return this.registry.list().map((summary) => this.registry.maybeGet(summary.sessionId)).filter(Boolean);
    }

    _requireUsableRuntime() {
        if (this.state !== RUNTIME_STATES.READY && this.state !== RUNTIME_STATES.DEGRADED) {
            fail(ERROR_CODES.RUNTIME_NOT_READY, `Runtime not ready: ${this.state}`);
        }
        if (!this.transport || !this.transport.isRunning()) {
            fail(ERROR_CODES.RUNTIME_NOT_READY, 'Worker is not running');
        }
    }
}

function toolAction(toolName, args = {}) {
    if (toolName === 'spawn_agent' || toolName === 'await_agent' || toolName === 'cancel_agent') return 'subagent';
    if (/apply|revert|write|edit|delete|remove|rename|move|copy|create/i.test(toolName)) return 'write';
    if (toolName === LEGACY_TOOL_NAMES.VCP_INVOKE) {
        const inner = args.arguments || {};
        const text = `${args.toolName || ''} ${inner.command || inner.action || ''}`;
        if (/shell|terminal|powershell|bash|cmd|exec/i.test(text)) return 'shell';
        if (/apply|write|edit|delete|remove|rename|move|copy|create/i.test(text)) return 'write';
    }
    return 'read';
}

async function parseOpenAiSse(body, onChunk, signal) {
    if (!body || typeof body.getReader !== 'function') throw new Error('SSE response has no readable body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        if (signal?.aborted) throw new Error('model request cancelled');
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            try {
                onChunk(JSON.parse(data));
            } catch (error) {
                throw new Error(`Invalid OpenAI SSE JSON: ${error.message}`);
            }
        }
        if (done) break;
    }
}

function splitUtf8(value, maxBytes) {
    const chunks = [];
    let current = '';
    let bytes = 0;
    for (const character of String(value || '')) {
        const size = Buffer.byteLength(character, 'utf8');
        if (bytes + size > maxBytes && current) {
            chunks.push(current);
            current = '';
            bytes = 0;
        }
        current += character;
        bytes += size;
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [''];
}

function splitModelDelta(delta, maxBytes) {
    const fields = ['content', 'reasoning_content', 'reasoning', 'reasoning_text'];
    const field = fields.find((name) => typeof delta[name] === 'string' && Buffer.byteLength(delta[name], 'utf8') > maxBytes);
    if (!field) return [delta];
    return splitUtf8(delta[field], maxBytes).map((part, index) => ({
        ...(index === 0 ? delta : {}),
        [field]: part,
        tool_calls: index === 0 ? delta.tool_calls : undefined,
    }));
}

function normalizeContextUsage(usage, contextWindow) {
    const input = usage.prompt_tokens || usage.input || 0;
    const output = usage.completion_tokens || usage.output || 0;
    const totalTokens = usage.total_tokens || usage.totalTokens || input + output;
    return {
        input, output, totalTokens,
        contextWindow: contextWindow || null,
        ratio: contextWindow ? totalTokens / contextWindow : null,
        updatedAt: Date.now(),
    };
}

function buildTranscriptSummary(messages, instructions) {
    const lines = [];
    if (instructions) lines.push(`Instructions: ${String(instructions).slice(0, 500)}`);
    for (const message of messages) {
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        lines.push(`${message.role}: ${summarizeValue(content, 1200)}`);
    }
    return lines.join('\n').slice(-12000) || 'No transcript messages to compact.';
}

module.exports = {
    AgentRuntimeManager,
    parseOpenAiSse,
    splitModelDelta,
    normalizeContextUsage,
    buildTranscriptSummary,
};
