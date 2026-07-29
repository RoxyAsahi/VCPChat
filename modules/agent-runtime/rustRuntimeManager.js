'use strict';

const crypto = require('crypto');
const path = require('path');
const { RustDaemonTransport } = require('./rustDaemonTransport');

// This class is deliberately a daemon client, not a second Agent Runtime.
// Rust owns transcript, Topic, Turn, approval, tool and usage state. Main only
// supervises stdio, correlates control requests and forwards daemon events.
class RustAgentRuntimeManager {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot;
        this.settingsPath = options.settingsPath || path.join(this.projectRoot, 'AppData', 'settings.json');
        this.agentsDir = options.agentsDir || path.join(this.projectRoot, 'AppData', 'Agents');
        this.getSettings = options.getSettings || (() => ({}));
        this.sendEvent = options.sendEvent || (() => {});
        this.transportFactory = options.transportFactory || ((config) => new RustDaemonTransport(config));
        this.state = 'stopped';
        this.transport = null;
        this.attachment = null;
        this.controlWaiters = new Map();
        this.eventWaiters = new Set();
        this.lastError = null;
        this.controlTransportPromise = null;
        this.diagnosticSequence = 0;
        this.workbenchMounted = false;
    }

    getStatus() {
        return {
            state: this.state,
            protocolVersion: 1,
            protocolRevision: '1.2',
            driver: 'rust',
            worker: this.transport ? {
                available: true,
                runtime: 'rust',
                hosted: true,
                // Process identity is lifecycle metadata only.  It lets the
                // Electron smoke test terminate the *attached* daemon rather
                // than an arbitrary catalog/control child process.
                pid: this.transport.child?.pid || null,
                buildRevision: this.transport.readyMessage?.buildRevision || null,
            } : null,
            lastError: this.lastError,
            attachment: this.attachment ? { ...this.attachment } : null,
            toolbox: { configured: Boolean(this.getSettings()?.vcpServerUrl && this.getSettings()?.vcpApiKey) },
        };
    }

    async start() {
        this.lastError = null;
        if (this.state === 'stopped') this.state = 'ready';
        return this.getStatus();
    }

    async stop() {
        this._rejectControlWaiters(new Error('Rust Agent runtime stopped'));
        this._rejectEventWaiters(new Error('Rust Agent runtime stopped'));
        await this.transport?.stop();
        this.transport = null;
        this.state = 'stopped';
        return this.getStatus();
    }

    async createSession(options = {}) {
        await this.transport?.stop();
        this._rejectControlWaiters(new Error('Rust Agent attachment replaced'));
        this._rejectEventWaiters(new Error('Rust Agent attachment replaced'));
        const settings = this.getSettings() || {};
        const workspaceRoot = path.resolve(options.workspaceRoot || this.projectRoot);
        this.state = 'starting';
        this.transport = this.transportFactory(this._transportConfig({ ...options, workspaceRoot }));
        await this.transport.start();
        const created = await this.transport.request('create-session');
        this.attachment = {
            sessionId: created.sessionId,
            topicId: created.topicId || options.resume || null,
            title: options.title || 'Nova Agent',
            workspaceRoot,
            model: options.model || settings.agentRuntime?.tui?.defaultModel || '',
            agentId: options.agent || options.agentId || 'Nova',
            runtime: 'rust',
        };
        if (this.workbenchMounted) {
            await this._requestControl('set-workbench-presence', { mounted: true }, 'workbench-presence');
        }
        this.state = 'ready';
        return { ...this.attachment };
    }

    async closeSession({ sessionId }) {
        this._assertAttachment(sessionId);
        const closed = { ...this.attachment };
        await this.stop();
        // `close-session` is different from a crash/reconnect stop: it is an
        // explicit abandonment of the process-local attachment. Keep no stale
        // session identity in Main after the daemon has been shut down.
        this.attachment = null;
        return closed;
    }

    async startTurn({ sessionId, prompt }) {
        this._assertAttachment(sessionId);
        const value = String(prompt || '').trim();
        if (!value) throw new Error('Prompt must not be empty');
        const turnId = `turn_${crypto.randomUUID()}`;
        await this.transport.request('start-turn', { sessionId, turnId, prompt: value });
        return { sessionId, turnId };
    }

    async steerTurn({ sessionId, turnId, prompt }) {
        this._assertAttachment(sessionId);
        const value = String(prompt || '').trim();
        if (!turnId || !value) throw new Error('Steering requires the active turn and a non-empty prompt');
        await this.transport.request('steer-turn', { sessionId, turnId, prompt: value });
        return { ok: true };
    }

    async followUpTurn({ sessionId, turnId, prompt }) {
        this._assertAttachment(sessionId);
        const value = String(prompt || '').trim();
        if (!turnId || !value) throw new Error('Follow-up requires the active turn and a non-empty prompt');
        await this.transport.request('follow-up-turn', { sessionId, turnId, prompt: value });
        return { ok: true };
    }

    async cancelTurn({ sessionId, turnId }) {
        this._assertAttachment(sessionId);
        await this.transport.request('cancel-turn', { sessionId, turnId });
        return { ok: true };
    }

    async respondApproval(payload = {}) {
        this._assertAttachment(payload.sessionId);
        if (!payload.approvalId || !payload.turnId || !payload.toolCallId || !payload.argumentsHash) {
            throw new Error('Approval binding is incomplete');
        }
        await this.transport.request('approval', {
            approvalId: payload.approvalId,
            allowed: payload.decision === 'allow',
            sessionId: payload.sessionId,
            turnId: payload.turnId,
            toolCallId: payload.toolCallId,
            argumentsHash: payload.argumentsHash,
        });
        return { ok: true };
    }

    async compactSession({ sessionId }) {
        this._assertAttachment(sessionId);
        if (!this.transport) throw new Error('Rust Agent daemon is not running');
        const outcome = this._waitForEvent((event) => (
            event.sessionId === sessionId
            && (event.type === 'context.compaction.completed' || event.type === 'context.compaction.failed')
        ), 180_000, 'Rust Agent context compaction timed out');
        try {
            await this.transport.request('compact', { sessionId });
            const event = await outcome.promise;
            if (event.type === 'context.compaction.failed') {
                throw new Error(event.payload?.error || event.payload?.message || 'Rust Agent context compaction failed');
            }
            return { ok: true, sessionId, topicId: this.attachment.topicId, compaction: event.payload || {} };
        } catch (error) {
            outcome.cancel(error);
            throw error;
        }
    }

    async listTopics({ agentId } = {}) {
        const normalizedAgentId = normalizeAgentId(agentId);
        // A control daemon is deliberately not a second Session.  It may be
        // attached to a different Agent, so Topic operations carry their
        // target Agent explicitly rather than relying on daemon spawn args.
        await this._ensureControlTransport(normalizedAgentId);
        return this._requestControl('list-topics', withAgentId({}, normalizedAgentId), 'topics');
    }
    async readTopic({ topicId, agentId }) {
        if (!topicId) throw new Error('Topic id is required');
        const normalizedAgentId = normalizeAgentId(agentId);
        await this._ensureControlTransport(normalizedAgentId);
        return this._requestControl('read-topic', withAgentId({ topicId }, normalizedAgentId), 'topic-read-only');
    }
    async takeoverTopic({ topicId, agentId }) {
        if (!topicId) throw new Error('Topic id is required');
        const normalizedAgentId = normalizeAgentId(agentId);
        await this._ensureControlTransport(normalizedAgentId);
        return this._requestControl('takeover-topic', withAgentId({ topicId }, normalizedAgentId), 'topic-takeover-pending');
    }
    async renameTopic({ topicId, title, agentId }) {
        const normalizedTopicId = String(topicId || '').trim();
        const normalizedTitle = String(title || '').trim();
        if (!normalizedTopicId) throw new Error('Topic id is required');
        if (!normalizedTitle || Array.from(normalizedTitle).length > 120) throw new Error('Topic 名称不能为空且不能超过 120 个字符');
        const normalizedAgentId = normalizeAgentId(agentId);
        await this._ensureControlTransport(normalizedAgentId);
        return this._requestControl('rename-topic', withAgentId({ topicId: normalizedTopicId, title: normalizedTitle }, normalizedAgentId), 'topic-renamed');
    }
    async deleteTopic({ topicId, agentId }) {
        const normalizedTopicId = String(topicId || '').trim();
        if (!normalizedTopicId) throw new Error('Topic id is required');
        if (this.attachment?.topicId === normalizedTopicId) throw new Error('不能删除当前打开的 Agent Topic；请先切换到其他会话。');
        const normalizedAgentId = normalizeAgentId(agentId);
        await this._ensureControlTransport(normalizedAgentId);
        return this._requestControl('delete-topic', withAgentId({ topicId: normalizedTopicId }, normalizedAgentId), 'topic-deleted');
    }
    async listInteractionQueue() { await this._ensureControlTransport(); return this._requestControl('list-interaction-queue', {}, 'interaction-queue'); }
    async replaceInteractionQueue({ sessionId, interactions }) {
        this._assertAttachment(sessionId);
        if (!Array.isArray(interactions)) throw new Error('Interaction queue must be an array');
        const normalized = interactions.map((item, index) => {
            const interactionId = String(item?.interactionId || '').trim();
            const kind = String(item?.kind || '').trim();
            const prompt = String(item?.prompt || item?.text || '').trim();
            if (!interactionId || !prompt || !['steer', 'follow-up'].includes(kind)) throw new Error(`Invalid interaction queue item at index ${index}`);
            return { interactionId, kind, prompt };
        });
        return this._requestControl('replace-interaction-queue', { sessionId, interactions: normalized }, 'interaction-queue');
    }
    async clearInteractionQueue() { await this._ensureControlTransport(); return this._requestControl('clear-interaction-queue', {}, 'interaction-queue'); }
    async getWorkbenchSettings() { await this._ensureControlTransport(); return this._requestControl('get-settings', {}, 'settings'); }
    async updateWorkbenchSettings(payload = {}) {
        await this._ensureControlTransport();
        const permissionMode = payload.permissionMode === 'always-approve'
            ? 'always-approve'
            : payload.permissionMode === 'ask' ? 'ask' : undefined;
        return this._requestControl('update-settings', {
            settings: {
                budget: normalizeBudget(payload.budget),
                ...(permissionMode ? { permissionMode } : {}),
            },
        }, 'settings-updated');
    }

    // Presence is a daemon command, not a Main-process flag. When no
    // Workbench is present Rust resolves every pending local approval as a
    // denial, so an invisible renderer can never leave a tool request alive.
    async setWorkbenchPresence(mounted) {
        this.workbenchMounted = mounted === true;
        // Merely mounting a page must not launch a host and allocate an
        // invisible Topic. A real attachment synchronizes this state directly
        // after `create-session`; an existing attachment is updated now.
        if (!this.transport || !this.attachment) return { mounted: this.workbenchMounted, deferred: true };
        return this._requestControl('set-workbench-presence', { mounted: this.workbenchMounted }, 'workbench-presence');
    }

    _handleMessage(message) {
        if (message.type === 'event') {
            this._forwardDaemonEvent(message.event || {});
            return;
        }
        if (message.type === 'control-event') {
            const waiter = message.requestId && this.controlWaiters.get(message.requestId);
            if (waiter) {
                this.controlWaiters.delete(message.requestId);
                clearTimeout(waiter.timer);
                if (message.kind === 'control-error') waiter.reject(new Error(message.payload?.error || `Rust Agent control request failed: ${waiter.operation}`));
                else if (message.kind !== waiter.expectedKind) waiter.reject(new Error(`Rust Agent control response mismatch: expected ${waiter.expectedKind}, got ${message.kind}`));
                else waiter.resolve(message.payload);
                return;
            }
            this._emitDiagnostic('runtime.control', { kind: message.kind, value: message.payload, requestId: message.requestId || null }, 'runtime');
            return;
        }
        if (message.type === 'fatal') this._handleExit(new Error(message.error || 'Rust daemon fatal error'));
    }

    _forwardDaemonEvent(event) {
        if (!event || typeof event !== 'object' || !event.type || !event.eventId
            || !event.sessionId || !event.topicId || event.runtime !== 'rust'
            || !Number.isFinite(Number(event.sequence)) || !Number.isFinite(Number(event.timestamp))) {
            this._emitDiagnostic('runtime.warning', { warning: 'Rust daemon emitted an invalid event envelope' }, 'runtime');
            return;
        }
        if ((event.type === 'assistant.started' || event.type === 'assistant.delta'
            || event.type === 'assistant.completed' || event.type === 'reasoning.delta')
            && (!event.turnId || !event.messageId)) {
            this._emitDiagnostic('runtime.warning', { warning: 'Rust daemon emitted a streaming event without turnId/messageId' }, 'runtime');
            return;
        }
        // Main deliberately does not derive turn/session state from daemon
        // events. It validates and forwards them; the Renderer projection is
        // the only live consumer that reduces those business transitions.
        this.sendEvent(event);
        this._resolveEventWaiters(event);
    }

    _emitDiagnostic(type, payload, sessionId = 'runtime') {
        this.sendEvent({
            schemaVersion: 1,
            eventId: `main:${crypto.randomUUID()}`,
            sequence: ++this.diagnosticSequence,
            timestamp: Date.now(),
            sessionId,
            topicId: this.attachment?.topicId || null,
            runtime: 'vcpchat',
            type,
            payload: payload || {},
        });
    }

    _handleExit(error) {
        if (!error || this.state === 'stopped') return;
        this._rejectControlWaiters(error);
        this._rejectEventWaiters(error);
        this.transport = null;
        this.state = 'failed';
        this.lastError = error.message || 'Rust Agent daemon exited unexpectedly';
        this._emitDiagnostic('runtime.crashed', { error: this.lastError, recoverable: true });
    }

    _transportConfig(options = {}) {
        const settings = this.getSettings() || {};
        return {
            projectRoot: this.projectRoot,
            settingsPath: this.settingsPath,
            agentsDir: this.agentsDir,
            workspaceRoot: options.workspaceRoot || path.resolve(this.projectRoot),
            model: options.model || settings.agentRuntime?.tui?.defaultModel,
            agent: options.agent || options.agentId || settings.agentRuntime?.tui?.defaultAgentId || 'Nova',
            resume: options.resume,
            alwaysApprove: options.permissionMode === 'always-approve',
            onMessage: (message) => this._handleMessage(message),
            onExit: (_code, _signal, error) => this._handleExit(error),
        };
    }

    async _ensureControlTransport(agentId) {
        if (this.transport) return;
        if (!this.controlTransportPromise) {
            this.controlTransportPromise = (async () => {
                const transport = this.transportFactory(this._transportConfig({ agent: agentId }));
                this.state = 'starting';
                await transport.start();
                this.transport = transport;
                this.state = 'ready';
            })();
        }
        try { await this.controlTransportPromise; } finally { this.controlTransportPromise = null; }
    }

    async _requestControl(type, payload, expectedKind) {
        if (!this.transport) throw new Error('Rust Agent daemon is not running');
        const requestId = `control_${crypto.randomUUID()}`;
        const result = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.controlWaiters.delete(requestId);
                reject(new Error(`Rust Agent control request timed out: ${type}`));
            }, 30_000);
            this.controlWaiters.set(requestId, { resolve, reject, timer, expectedKind, operation: type });
        });
        try {
            await this.transport.request(type, payload, requestId);
        } catch (error) {
            const waiter = this.controlWaiters.get(requestId);
            if (waiter) {
                this.controlWaiters.delete(requestId);
                clearTimeout(waiter.timer);
                waiter.reject(error);
            }
            throw error;
        }
        return result;
    }

    _waitForEvent(predicate, timeoutMs, timeoutMessage) {
        let waiter;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.eventWaiters.delete(waiter); reject(new Error(timeoutMessage)); }, timeoutMs);
            waiter = { predicate, resolve, reject, timer };
            this.eventWaiters.add(waiter);
        });
        promise.catch(() => {});
        return {
            promise,
            cancel: (error) => {
                if (!this.eventWaiters.delete(waiter)) return;
                clearTimeout(waiter.timer);
                waiter.reject(error);
            },
        };
    }

    _resolveEventWaiters(event) {
        for (const waiter of [...this.eventWaiters]) {
            if (!waiter.predicate(event)) continue;
            this.eventWaiters.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(event);
        }
    }

    _rejectEventWaiters(error) {
        for (const waiter of this.eventWaiters) { clearTimeout(waiter.timer); waiter.reject(error); }
        this.eventWaiters.clear();
    }

    _rejectControlWaiters(error) {
        for (const waiter of this.controlWaiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
        this.controlWaiters.clear();
    }

    _assertAttachment(sessionId) {
        if (!this.attachment || this.attachment.sessionId !== sessionId) throw new Error(`Unknown Rust Agent session: ${sessionId}`);
    }
}

function normalizeBudget(value) {
    const source = value && typeof value === 'object' ? value : {};
    const normalize = (input, field) => {
        if (input === null || input === undefined || input === '') return null;
        const number = Number(input);
        if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${field} 必须是正整数，留空表示不设限制`);
        if (number > 100_000_000) throw new Error(`${field} 超出允许范围`);
        return number;
    };
    return {
        maxRequestsPerTurn: normalize(source.maxRequestsPerTurn, '每轮请求上限'),
        maxTokensPerTurn: normalize(source.maxTokensPerTurn, '每轮 token 上限'),
    };
}

function normalizeAgentId(value) {
    if (value === undefined || value === null || String(value).trim() === '') return undefined;
    return String(value).trim();
}

function withAgentId(payload, agentId) {
    return agentId ? { ...payload, agentId } : payload;
}

module.exports = { RustAgentRuntimeManager };
