'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { developmentBridgePath } = require('./toolboxBridgePaths');

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const START_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;

class ToolboxBridgeTransport extends EventEmitter {
    constructor(options = {}) {
        super();
        this.projectRoot = options.projectRoot || process.cwd();
        this.executable = options.executable || developmentBridgePath(this.projectRoot);
        this.env = options.env || {};
        this.child = null;
        this.buffer = '';
        this.pending = new Map();
        this.nextId = 1;
        this.ready = false;
        this.startPromise = null;
    }

    start() {
        if (this.ready) return Promise.resolve();
        if (this.startPromise) return this.startPromise;
        this.child = spawn(this.executable, [], {
            cwd: this.projectRoot,
            env: { ...process.env, ...this.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');
        this.child.stdout.on('data', (chunk) => this._accept(chunk));
        this.child.stderr.on('data', (chunk) => this.emit('stderr', String(chunk)));
        this.child.once('exit', (code, signal) => {
            const error = new Error(`ToolBox bridge exited (code=${code}, signal=${signal || 'none'})`);
            for (const pending of this.pending.values()) {
                clearTimeout(pending.timeout);
                pending.reject(error);
            }
            this.pending.clear();
            this.child = null;
            this.ready = false;
            this.startPromise = null;
            this.emit('exit', error);
        });
        this.startPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('ToolBox bridge startup timed out')), START_TIMEOUT_MS);
            this.once('ready', () => {
                clearTimeout(timeout);
                this.ready = true;
                resolve();
            });
            this.child.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
        }).finally(() => {
            if (!this.ready) this.startPromise = null;
        });
        return this.startPromise;
    }

    async stop() {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('ToolBox bridge stopped'));
        }
        this.pending.clear();
        const child = this.child;
        this.child = null;
        this.ready = false;
        this.startPromise = null;
        if (child?.stdin?.writable) child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
        if (child && !child.killed) {
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    if (!child.killed) child.kill();
                    resolve();
                }, 2_000);
                child.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        }
    }

    invoke({ requestId, toolName, arguments: args }) {
        return this._request({
            type: 'invoke',
            requestId: requestId || `toolbox_${this.nextId++}`,
            toolName,
            arguments: args || {},
        });
    }

    interrupt(requestId) {
        return this._request({ type: 'interrupt', requestId });
    }

    respondApproval({ requestId, approved, reason }) {
        return this._request({
            type: 'approvalResponse',
            requestId,
            approved: approved === true,
            ...(reason ? { reason: String(reason) } : {}),
        });
    }

    _request(message) {
        if (!this.child?.stdin?.writable) return Promise.reject(new Error('ToolBox bridge is not running'));
        const key = String(message.requestId || `bridge_${this.nextId++}`);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(key);
                reject(new Error(`ToolBox bridge request timed out: ${message.type}`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(key, { resolve, reject, timeout });
            this.child.stdin.write(`${JSON.stringify(message)}\n`);
        });
    }

    _accept(chunk) {
        this.buffer += String(chunk);
        if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES) {
            this.emit('protocol-error', new Error('ToolBox bridge emitted an oversized line'));
            this.child?.kill();
            return;
        }
        let index = this.buffer.indexOf('\n');
        while (index >= 0) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (line) this._line(line);
            index = this.buffer.indexOf('\n');
        }
    }

    _line(line) {
        let message;
        try { message = JSON.parse(line); } catch (_error) { return; }
        if (message.type === 'ready') {
            this.emit('ready', message);
            return;
        }
        if (message.type === 'event') {
            this.emit('event', message);
            return;
        }
        const requestId = String(message.requestId || '');
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.resolve(message);
    }
}

module.exports = { ToolboxBridgeTransport };
