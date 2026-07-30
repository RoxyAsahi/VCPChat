'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FRAME_BYTES = 256 * 1024;
const PROTOCOL_VERSION = 1;
const PROTOCOL_REVISION = '1.5';

function requiredString(value, field) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`daemon protocol requires ${field}`);
}

function requiredIdentity(message, field) {
    requiredString(message[field], field);
}

// Keep this validator deliberately adjacent to the stdio boundary.  Renderer
// callers cannot send an unversioned or incomplete daemon command, and no
// malformed child frame reaches Main's request waiters or the UI projection.
function validateDirectCommand(message) {
    if (!message || message.protocolVersion !== PROTOCOL_VERSION) throw new Error(`daemon protocol requires protocolVersion ${PROTOCOL_VERSION}`);
    requiredString(message.requestId, 'requestId');
    switch (message.type) {
    case 'hello': case 'shutdown': case 'create-session':
    case 'list-topics':
        if (Object.prototype.hasOwnProperty.call(message, 'agentId')) requiredString(message.agentId, 'agentId');
    case 'list-interaction-queue': case 'clear-interaction-queue': case 'get-settings':
    case 'get-index-status': case 'rebuild-topic-index':
        return;
    case 'switch-attachment':
        if (Object.prototype.hasOwnProperty.call(message, 'sessionId')) requiredString(message.sessionId, 'sessionId');
        for (const field of ['topicId', 'agentId', 'model', 'workspaceRoot']) {
            if (Object.prototype.hasOwnProperty.call(message, field)) requiredString(message[field], field);
        }
        if (Object.prototype.hasOwnProperty.call(message, 'permissionMode')
            && message.permissionMode !== 'ask' && message.permissionMode !== 'always-approve') {
            throw new Error('daemon protocol requires permissionMode ask or always-approve');
        }
        return;
    case 'close-session': case 'cancel-turn': case 'compact':
        return requiredIdentity(message, 'sessionId');
    case 'import-attachment':
        requiredIdentity(message, 'sessionId'); return requiredString(message.path, 'path');
    case 'start-turn': {
        requiredIdentity(message, 'sessionId'); requiredIdentity(message, 'turnId');
        if (typeof message.prompt !== 'string') throw new Error('daemon protocol requires string prompt');
        const attachments = message.attachments || [];
        if (!Array.isArray(attachments) || attachments.length > 8 || attachments.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
            throw new Error('daemon protocol requires at most 8 attachment descriptors');
        }
        if (!message.prompt.trim() && attachments.length === 0) throw new Error('daemon protocol requires prompt or attachments');
        return;
    }
    case 'steer-turn': case 'follow-up-turn':
        requiredIdentity(message, 'sessionId'); requiredIdentity(message, 'turnId'); return requiredString(message.prompt, 'prompt');
    case 'approval':
        requiredIdentity(message, 'sessionId'); requiredIdentity(message, 'turnId'); requiredIdentity(message, 'toolCallId');
        requiredString(message.approvalId, 'approvalId'); requiredString(message.argumentsHash, 'argumentsHash');
        if (typeof message.allowed !== 'boolean' && typeof message.decision !== 'string') throw new Error('daemon protocol requires allowed or decision');
        return;
    case 'toolbox-approval':
        requiredString(message.approvalRequestId, 'approvalRequestId');
        if (typeof message.approved !== 'boolean') throw new Error('daemon protocol requires boolean approved');
        if (Object.prototype.hasOwnProperty.call(message, 'reason') && message.reason != null && typeof message.reason !== 'string') throw new Error('daemon protocol requires string reason');
        return;
    case 'read-topic': case 'takeover-topic': case 'delete-topic':
        requiredString(message.topicId, 'topicId');
        if (Object.prototype.hasOwnProperty.call(message, 'agentId')) requiredString(message.agentId, 'agentId');
        return;
    case 'search-topics': case 'search-topic-messages':
        requiredString(message.query, 'query');
        if (message.type === 'search-topic-messages') requiredString(message.topicId, 'topicId');
        if (Object.prototype.hasOwnProperty.call(message, 'agentId')) requiredString(message.agentId, 'agentId');
        if (Object.prototype.hasOwnProperty.call(message, 'limit') && (!Number.isInteger(message.limit) || message.limit < 1 || message.limit > 500)) throw new Error('daemon protocol requires limit between 1 and 500');
        return;
    case 'rename-topic':
        requiredString(message.topicId, 'topicId');
        requiredString(message.title, 'title');
        if (Object.prototype.hasOwnProperty.call(message, 'agentId')) requiredString(message.agentId, 'agentId');
        return;
    case 'replace-interaction-queue': requiredIdentity(message, 'sessionId'); if (!Array.isArray(message.interactions)) throw new Error('daemon protocol requires interactions array'); return;
    case 'update-settings': if (!message.settings || typeof message.settings !== 'object' || Array.isArray(message.settings)) throw new Error('daemon protocol requires settings object'); return;
    case 'set-workbench-presence': if (typeof message.mounted !== 'boolean') throw new Error('daemon protocol requires boolean mounted'); return;
    default: throw new Error(`unsupported direct daemon command: ${String(message.type)}`);
    }
}

function validateDaemonFrame(message) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('daemon emitted an invalid frame');
    if (message.type === 'ready') {
        if (message.protocolVersion !== PROTOCOL_VERSION || message.protocolRevision !== PROTOCOL_REVISION || !/^[0-9a-f]{7,64}$/i.test(String(message.buildRevision || ''))) throw new Error('daemon emitted an invalid ready frame');
        return;
    }
    if (message.type === 'ack') { requiredString(message.requestId, 'requestId'); if (typeof message.ok !== 'boolean') throw new Error('daemon ack requires boolean ok'); return; }
    if (message.type === 'fatal') return requiredString(message.error, 'error');
    if (message.type === 'control-event') { requiredString(message.requestId, 'requestId'); requiredString(message.kind, 'kind'); if (!Object.prototype.hasOwnProperty.call(message, 'payload')) throw new Error('daemon control-event requires payload'); return; }
    if (message.type !== 'event' || !message.event || typeof message.event !== 'object') throw new Error(`unsupported daemon frame: ${message.type}`);
    const event = message.event;
    for (const field of ['eventId', 'sessionId', 'topicId', 'type']) requiredString(event[field], field);
    if (event.runtime !== 'rust' || !Number.isFinite(Number(event.sequence)) || !Number.isFinite(Number(event.timestamp))) throw new Error('daemon event has invalid envelope');
    if ((event.type.startsWith('assistant.') || event.type.startsWith('reasoning.') || event.type === 'turn.started') && (!event.turnId || !event.messageId)) throw new Error('daemon message event lacks turnId/messageId');
    if (event.type.startsWith('tool.') && !event.toolCallId) throw new Error('daemon tool event lacks toolCallId');
}

class RustDaemonTransport {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot;
        this.settingsPath = options.settingsPath;
        this.agentsDir = options.agentsDir;
        this.workspaceRoot = options.workspaceRoot;
        this.model = options.model;
        this.agent = options.agent || 'Nova';
        this.resume = options.resume;
        this.alwaysApprove = options.alwaysApprove === true;
        this.controlOnly = options.controlOnly === true;
        this.onMessage = options.onMessage || (() => {});
        this.onExit = options.onExit || (() => {});
        this.child = null;
        this.buffer = Buffer.alloc(0);
        this.pending = new Map();
        this.stderr = '';
        this.readyMessage = null;
        this.readyTimer = null;
        this.readyReject = null;
        this.stopping = false;
    }

    resolveExecutable() {
        const override = process.env.VCP_AGENT_RUST_DAEMON_PATH;
        const ext = process.platform === 'win32' ? '.exe' : '';
        const candidates = [
            override,
            process.resourcesPath && path.join(process.resourcesPath, 'vcp-agent', `vcp-agentd${ext}`),
            // in-repo rust/ directory (direct source, no submodule)
            this.projectRoot && path.join(this.projectRoot, 'rust', 'target', 'release', `vcp-agentd${ext}`),
        ].filter(Boolean);
        const executable = candidates.find((candidate) => fs.existsSync(candidate));
        if (!executable) throw new Error(`没有找到 vcp-agentd.exe；已检查：${candidates.join(', ')}`);
        return executable;
    }

    async start() {
        if (this.child) return;
        this.stopping = false;
        const args = ['--direct'];
        const append = (flag, value) => { if (value) args.push(flag, String(value)); };
        append('--settings-path', this.settingsPath);
        append('--agents-dir', this.agentsDir);
        append('--workspace', this.workspaceRoot);
        append('--model', this.model);
        append('--agent', this.agent);
        append('--resume', this.resume);
        if (this.alwaysApprove) args.push('--always-approve');
        if (this.controlOnly) args.push('--control');
        this.child = spawn(this.resolveExecutable(), args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });
        this.child.stdout.on('data', (chunk) => this._consume(chunk));
        this.child.once('error', (error) => {
            for (const pending of this.pending.values()) pending.reject(error);
            this.pending.clear();
        });
        this.child.stderr.on('data', (chunk) => {
            this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16 * 1024);
        });
        this.child.once('exit', (code, signal) => {
            const error = new Error(`vcp-agentd exited (${code ?? 'null'}/${signal || 'none'})${this.stderr ? `: ${this.stderr}` : ''}`);
            // A config/Topic-lock failure can occur before the daemon writes
            // `ready`. Reject that startup wait immediately; otherwise GUI
            // recovery looks active for 30 seconds with no daemon process.
            if (this.readyReject) this.readyReject(error);
            // `shutdown` can race the final stdout drain on Windows.  A clean
            // intentional stop is not a daemon crash and must not reject its
            // own pending shutdown request (or make the Workbench look stuck).
            for (const pending of this.pending.values()) {
                if (this.stopping && code === 0 && !signal) pending.resolve({ ok: true, stopped: true });
                else pending.reject(error);
            }
            this.pending.clear();
            this.child = null;
            this.onExit(code, signal, this.stopping && code === 0 && !signal ? null : error);
        });
        await this._waitForReady();
        await this.request('hello', { protocolVersion: PROTOCOL_VERSION });
    }

    _waitForReady() {
        if (this.readyMessage) return Promise.resolve(this.readyMessage);
        return new Promise((resolve, reject) => {
            this.readyTimer = setTimeout(() => {
                this.readyTimer = null;
                this.readyReject = null;
                reject(new Error('vcp-agentd startup timed out'));
            }, 30_000);
            this.readyReject = (error) => {
                if (this.readyTimer) clearTimeout(this.readyTimer);
                this.readyTimer = null;
                this.readyReject = null;
                reject(error);
            };
            const listener = (message) => {
                if (message.type === 'ready') {
                    const protocolVersion = Number(message.protocolVersion);
                    const protocolRevision = String(message.protocolRevision || '');
                    const buildRevision = String(message.buildRevision || '');
                    if (protocolVersion !== PROTOCOL_VERSION
                        || protocolRevision !== PROTOCOL_REVISION
                        || !/^[0-9a-f]{7,64}$/i.test(buildRevision)) {
                        const error = new Error(`unsupported Rust daemon ready frame (protocolVersion=${message.protocolVersion}, protocolRevision=${protocolRevision || 'missing'}, buildRevision=${buildRevision || 'missing'})`);
                        this.child?.kill();
                        this.readyReject?.(error);
                        return;
                    }
                    if (this.readyTimer) clearTimeout(this.readyTimer);
                    this.readyTimer = null;
                    this.readyReject = null;
                    this._readyListener = null;
                    resolve(message);
                }
            };
            this._readyListener = listener;
        });
    }

    _consume(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32BE(0);
            if (length > MAX_FRAME_BYTES) {
                this.child?.kill();
                return;
            }
            if (this.buffer.length < length + 4) return;
            const frame = this.buffer.subarray(4, length + 4);
            this.buffer = this.buffer.subarray(length + 4);
            let message;
            try {
                message = JSON.parse(frame.toString('utf8'));
                validateDaemonFrame(message);
            } catch (error) {
                const protocolError = error instanceof Error ? error : new Error(String(error));
                for (const pending of this.pending.values()) pending.reject(protocolError);
                this.pending.clear();
                this.child?.kill();
                return;
            }
            if (this._readyListener) this._readyListener(message);
            if (message.type === 'ready') this.readyMessage = message;
            const pending = message.requestId && this.pending.get(message.requestId);
            if (pending && (message.type === 'ack' || message.type === 'fatal')) {
                this.pending.delete(message.requestId);
                if (message.type === 'fatal' || message.ok === false) pending.reject(new Error(message.error || message.result?.error || 'daemon request failed'));
                else pending.resolve(message.result || message);
                continue;
            }
            this.onMessage(message);
        }
    }

    send(message) {
        if (!this.child?.stdin?.writable) throw new Error('vcp-agentd is not running');
        const bytes = Buffer.from(JSON.stringify(message), 'utf8');
        if (bytes.length > MAX_FRAME_BYTES) throw new Error('daemon frame exceeds 256 KiB');
        const prefix = Buffer.allocUnsafe(4);
        prefix.writeUInt32BE(bytes.length, 0);
        this.child.stdin.write(Buffer.concat([prefix, bytes]));
    }

    request(type, payload = {}, requestId = `gui_${crypto.randomUUID()}`) {
        if (!requestId || typeof requestId !== 'string') throw new Error('daemon requestId must be a non-empty string');
        const message = { type, protocolVersion: PROTOCOL_VERSION, requestId, ...payload };
        validateDirectCommand(message);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`daemon request timed out: ${type}`));
            }, 30_000);
            this.pending.set(requestId, {
                resolve: (value) => { clearTimeout(timeout); resolve(value); },
                reject: (error) => { clearTimeout(timeout); reject(error); },
            });
            this.send(message);
        });
    }

    async stop() {
        const child = this.child;
        if (!child) return;
        this.stopping = true;
        try { await this.request('shutdown'); } catch {}
        if (this.child) {
            await new Promise((resolve) => {
                const timer = setTimeout(() => { this.child?.kill(); resolve(); }, 5_000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
    }
}

module.exports = { RustDaemonTransport, MAX_FRAME_BYTES, PROTOCOL_VERSION, PROTOCOL_REVISION, validateDirectCommand, validateDaemonFrame };
