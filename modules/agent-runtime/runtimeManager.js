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
    TURN_STATES,
    TOOL_STATES,
    transition,
} = require('./runtimeState');
const { SessionRegistry } = require('./sessionRegistry');
const { WorkerTransport } = require('./workerTransport');
const { ApprovalBroker } = require('./approvalBroker');
const { canonicalizeWorkspaceRoot } = require('./workspacePolicy');
const { summarizeValue, redactValue } = require('./secretRedactor');
const { LegacyVcpToolboxClient, normalizeVcpBaseUrl } = require('./toolbox/legacyVcpToolboxClient');
const { classifyLegacyTool } = require('./toolbox/toolRiskClassifier');

class AgentRuntimeManager {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot;
        this.driver = options.driver || RUNTIME_KINDS.PI;
        this.getSettings = options.getSettings || (() => ({}));
        this.sendEvent = options.sendEvent || (() => {});
        this.hasUi = options.hasUi || (() => true);
        this.transportFactory = options.transportFactory || ((transportOptions) => new WorkerTransport(transportOptions));

        this.state = RUNTIME_STATES.STOPPED;
        this.transport = null;
        this.probe = null;
        this.lastError = null;
        this.registry = new SessionRegistry();
        this.activeDelegateRequests = new Map();
        this.activeTools = new Map();
        this.auditLog = [];
        this.maxAuditEntries = 500;

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
        };
    }

    _toolboxInfo() {
        const settings = this.getSettings() || {};
        return {
            configured: Boolean(settings.vcpServerUrl && settings.vcpApiKey),
            baseUrl: settings.vcpServerUrl || null,
        };
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
        this._setRuntimeState(RUNTIME_STATES.STARTING);
        this.transport = this.transportFactory({
            projectRoot: this.projectRoot,
            driver: this.driver,
            onEvent: (message) => this._handleWorkerEvent(message),
            onModelRequest: (message) => this._handleModelRequest(message),
            onToolRequest: (message) => this._handleToolRequest(message),
            onFatal: (error) => this._handleWorkerFatal(error),
            onExit: (code, signal) => this._handleWorkerExit(code, signal),
        });
        try {
            const started = await this.transport.start();
            this.probe = started.probe;
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
            metadata: { ...(options.metadata || {}), model: options.model || null },
        });
        const sessionOptions = {
            systemPrompt: options.systemPrompt,
            // Credentials remain in Electron Main. The worker only gets model metadata.
            vcp: { model: options.model || 'mock-model' },
        };
        try {
            const request = this.transport.sendRequest('start-session', {
                sessionId: record.sessionId,
                options: sessionOptions,
            }, LIMITS.WORKER_STARTUP_TIMEOUT_MS);
            const ack = await request.promise;
            if (ack.ok === false) {
                throw new AgentRuntimeError(ERROR_CODES.WORKER_PROTOCOL_ERROR, ack.error || 'worker rejected session');
            }
        } catch (error) {
            this.registry.remove(record.sessionId);
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
        this.approvals.cancelForSession(session.sessionId, 'turn-cancelled');
        session.transitionTurn(turn.turnId, TURN_STATES.CANCELLED);
        this._emit(session, EVENT_TYPES.TURN_CANCELLED, { reason: 'user-request' }, { turnId: turn.turnId });
        return { ok: true };
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
            this.transport.sendModelResult({ requestId: message.requestId, ok: false, error: 'unknown session' });
            return;
        }
        const settings = this.getSettings() || {};
        if (!settings.vcpServerUrl || !settings.vcpApiKey) {
            this.transport.sendModelResult({ requestId: message.requestId, ok: false, error: 'VCP gateway not configured' });
            return;
        }
        const controller = new AbortController();
        this.activeDelegateRequests.set(message.requestId, {
            sessionId: message.sessionId,
            turnId: message.turnId,
            cancelLocal: () => controller.abort(),
        });
        try {
            const response = await fetch(`${normalizeVcpBaseUrl(settings.vcpServerUrl)}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${settings.vcpApiKey}`,
                },
                body: JSON.stringify(message.body),
                signal: controller.signal,
            });
            const text = await response.text();
            if (!response.ok) {
                this.transport.sendModelResult({
                    requestId: message.requestId,
                    ok: false,
                    error: `VCP model gateway HTTP ${response.status}: ${text.slice(0, 500)}`,
                });
                return;
            }
            let data;
            try {
                data = JSON.parse(text);
            } catch (error) {
                this.transport.sendModelResult({ requestId: message.requestId, ok: false, error: 'VCP model gateway returned invalid JSON' });
                return;
            }
            this.transport.sendModelResult({ requestId: message.requestId, ok: true, data });
        } catch (error) {
            this.transport.sendModelResult({
                requestId: message.requestId,
                ok: false,
                error: controller.signal.aborted ? 'model request cancelled' : error.message,
            });
        } finally {
            this.activeDelegateRequests.delete(message.requestId);
        }
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
        this._emit(session, EVENT_TYPES.TOOL_REQUESTED, {
            toolName,
            argumentSummary: summarizeValue(toolArgs),
            argumentsHash: hashArguments(toolArgs || {}),
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
            if (type) {
                this._emit(session, type, { toolName, ...extra }, { turnId, toolCallId });
            }
        };

        (async () => {
            const classification = classifyLegacyTool(toolName, toolArgs || {});
            let approvalOutcome;
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

    async _executeLegacyTool(session, turnId, toolCallId, toolName, toolArgs) {
        const settings = this.getSettings() || {};
        const toolbox = LegacyVcpToolboxClient.fromSettings(settings);
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
            const innerArgs = toolArgs.arguments || {};
            return toolbox.invokeTool({
                toolName: innerName,
                args: innerArgs,
                signal: abortController.signal,
            });
        }
        fail(ERROR_CODES.TOOL_PROTOCOL_VIOLATION, `Unsupported runtime tool: ${toolName}`);
    }

    _handleWorkerEvent(message) {
        const session = this.registry.maybeGet(message.sessionId);
        if (!session) {
            return;
        }
        const workerEvent = message.event || {};
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
            'reasoning.delta': EVENT_TYPES.REASONING_DELTA,
            'tool.started': EVENT_TYPES.TOOL_PROGRESS,
            'tool.completed': EVENT_TYPES.TOOL_PROGRESS,
            'tool.failed': EVENT_TYPES.TOOL_PROGRESS,
        };
        const type = mapping[workerEvent.type];
        if (!type) {
            return;
        }
        this._emit(session, type, redactValue(workerEvent.payload || {}), {
            turnId: workerEvent.turnId,
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

module.exports = {
    AgentRuntimeManager,
};
