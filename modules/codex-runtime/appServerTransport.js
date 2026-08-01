'use strict';

const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MINIMUM_CODEX_VERSION = '0.124.0';

class CodexAppServerError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'CodexAppServerError';
        this.code = code;
        this.details = details;
    }
}

function candidateFromWhere(command = 'codex') {
    if (process.platform !== 'win32') return null;
    const result = spawnSync('where.exe', [command], {
        encoding: 'utf8',
        windowsHide: true,
    });
    if (result.status !== 0) return null;
    const candidates = String(result.stdout || '')
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
    return candidates.find((value) => path.extname(value).toLowerCase() === '.cmd')
        || candidates.find((value) => path.extname(value).toLowerCase() === '.exe')
        || candidates[0]
        || null;
}

function resolveCodexLaunch(options = {}) {
    const explicit = String(
        process.env.VCP_CODEX_APP_SERVER
        || process.env.CODEX_APP_SERVER_EXECUTABLE
        || options.executable
        || ''
    ).trim();
    const executable = explicit || candidateFromWhere('codex-app-server') || candidateFromWhere('codex') || 'codex';
    const basename = path.basename(executable).toLowerCase();
    const direct = basename.startsWith('codex-app-server');
    const args = direct ? ['--listen', 'stdio://'] : ['app-server', '--listen', 'stdio://'];

    if (process.platform === 'win32' && path.extname(executable).toLowerCase() === '.cmd') {
        return {
            command: executable,
            args,
            source: executable,
            direct,
            shell: true,
        };
    }
    return { command: executable, args, source: executable, direct };
}

function parseCodexVersion(initializeResult) {
    const userAgent = String(initializeResult?.userAgent || '');
    // First-party Codex prefixes: `Codex/0.124.0` or `Codex Desktop/0.124.0`.
    const firstParty = userAgent.match(/Codex(?: Desktop)?\/(\d+)\.(\d+)\.(\d+)/i);
    if (firstParty) return `${firstParty[1]}.${firstParty[2]}.${firstParty[3]}`;
    // The app-server echoes the negotiated originator token as
    // `<originator>/<buildVersion> (<os> <osVersion>; <arch>) ...`, so the
    // build version is always the first semver triplet after the leading
    // originator token (e.g. `vcp_chat/0.124.0 (Windows ...)`).
    const originatorForm = userAgent.match(/^[^/\s]+\/(\d+)\.(\d+)\.(\d+)/);
    return originatorForm ? `${originatorForm[1]}.${originatorForm[2]}.${originatorForm[3]}` : null;
}

function compareVersions(left, right) {
    const a = String(left).split('.').map(Number);
    const b = String(right).split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
    }
    return 0;
}

class CodexAppServerTransport extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = options;
        this.spawnImpl = options.spawnImpl || spawn;
        this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
        this.startTimeoutMs = options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;
        this.maxLineBytes = options.maxLineBytes || MAX_LINE_BYTES;
        this.child = null;
        this.buffer = '';
        this.nextRequestId = 1;
        this.pending = new Map();
        this.ready = false;
        this.stopping = false;
        this.launch = null;
        this.initializeResult = null;
        this.version = null;
    }

    get status() {
        return {
            running: Boolean(this.child && !this.child.killed),
            ready: this.ready,
            pid: this.child?.pid || null,
            executable: this.launch?.source || null,
            version: this.version,
            pendingRequests: this.pending.size,
        };
    }

    async start() {
        if (this.ready) return this.status;
        if (this.child) throw new CodexAppServerError('START_IN_PROGRESS', 'Codex App Server is already starting');

        this.launch = resolveCodexLaunch(this.options);
        this.stopping = false;
        const childEnv = { ...process.env, ...(this.options.env || {}) };
        for (const key of this.options.unsetEnv || []) delete childEnv[key];
        const child = this.spawnImpl(this.launch.command, this.launch.args, {
            cwd: this.options.cwd || process.cwd(),
            env: childEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: this.launch.shell === true,
        });
        this.child = child;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => this._acceptChunk(chunk));
        child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk)));
        child.once('error', (error) => this._handleExit(error));
        child.once('exit', (code, signal) => {
            this._handleExit(new CodexAppServerError(
                this.stopping ? 'STOPPED' : 'PROCESS_EXITED',
                `Codex App Server exited (code=${code}, signal=${signal || 'none'})`,
                { code, signal }
            ));
        });

        const initialize = this.request('initialize', {
            clientInfo: {
                name: 'vcp_chat',
                title: 'VCPChat',
                version: this.options.clientVersion || '1.0.0',
            },
            capabilities: {
                experimentalApi: true,
            },
        }, { timeoutMs: this.startTimeoutMs });
        try {
            this.initializeResult = await initialize;
            this.version = parseCodexVersion(this.initializeResult);
            const minimumVersion = this.options.minimumVersion || MINIMUM_CODEX_VERSION;
            if (!this.version || compareVersions(this.version, minimumVersion) < 0) {
                throw new CodexAppServerError(
                    'UNSUPPORTED_VERSION',
                    `Codex App Server ${this.version || 'unknown'} is unsupported; expected ${minimumVersion} or newer`,
                    { userAgent: this.initializeResult?.userAgent || null, minimumVersion },
                );
            }
            this.notify('initialized', {});
            this.ready = true;
            this.emit('ready', { ...this.status, initialize: this.initializeResult });
            return this.status;
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    request(method, params = {}, options = {}) {
        if (!this.child?.stdin?.writable) {
            return Promise.reject(new CodexAppServerError('NOT_RUNNING', 'Codex App Server is not running'));
        }
        const id = options.id ?? this.nextRequestId++;
        const timeoutMs = options.timeoutMs || this.requestTimeoutMs;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(String(id));
                reject(new CodexAppServerError('REQUEST_TIMEOUT', `Codex request timed out: ${method}`, { method, id }));
            }, timeoutMs);
            this.pending.set(String(id), { resolve, reject, timeout, method });
            try {
                this._write({ method, id, params });
            } catch (error) {
                clearTimeout(timeout);
                this.pending.delete(String(id));
                reject(error);
            }
        });
    }

    notify(method, params = {}) {
        this._write({ method, params });
    }

    respond(id, result) {
        this._write({ id, result });
    }

    respondError(id, code, message, data) {
        this._write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
    }

    async stop() {
        const child = this.child;
        if (!child) return;
        this.stopping = true;
        this.ready = false;
        this._rejectPending(new CodexAppServerError('STOPPED', 'Codex App Server stopped'));
        this.child = null;
        if (!child.killed) child.kill();
    }

    _write(message) {
        if (!this.child?.stdin?.writable) {
            throw new CodexAppServerError('NOT_RUNNING', 'Codex App Server stdin is not writable');
        }
        const line = `${JSON.stringify(message)}\n`;
        if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
            throw new CodexAppServerError('MESSAGE_TOO_LARGE', 'Codex protocol message exceeds the configured limit');
        }
        this.child.stdin.write(line);
    }

    _acceptChunk(chunk) {
        this.buffer += String(chunk);
        if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
            this._handleExit(new CodexAppServerError('LINE_TOO_LARGE', 'Codex protocol line exceeds the configured limit'));
            this.child?.kill();
            return;
        }
        let newline = this.buffer.indexOf('\n');
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line) this._acceptLine(line);
            newline = this.buffer.indexOf('\n');
        }
    }

    _acceptLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            this.emit('protocol-error', new CodexAppServerError('INVALID_JSON', 'Codex App Server emitted invalid JSON', { line }));
            return;
        }
        if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
            const pending = this.pending.get(String(message.id));
            if (!pending) {
                this.emit('orphan-response', message);
                return;
            }
            clearTimeout(pending.timeout);
            this.pending.delete(String(message.id));
            if (message.error) {
                pending.reject(new CodexAppServerError(
                    'RPC_ERROR',
                    message.error.message || `Codex request failed: ${pending.method}`,
                    { method: pending.method, id: message.id, rpc: message.error }
                ));
            } else {
                pending.resolve(message.result);
            }
            return;
        }
        if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
            this.emit('server-request', message);
            return;
        }
        if (message.method) {
            this.emit('notification', message);
            this.emit(`notification:${message.method}`, message.params);
            return;
        }
        this.emit('protocol-error', new CodexAppServerError('INVALID_ENVELOPE', 'Unknown Codex protocol envelope', { message }));
    }

    _rejectPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }

    _handleExit(error) {
        if (!this.child && !this.ready && this.pending.size === 0) return;
        this.ready = false;
        this.child = null;
        this.buffer = '';
        this._rejectPending(error);
        this.emit('exit', error);
    }
}

module.exports = {
    CodexAppServerTransport,
    CodexAppServerError,
    resolveCodexLaunch,
    parseCodexVersion,
    MAX_LINE_BYTES,
    MINIMUM_CODEX_VERSION,
};
