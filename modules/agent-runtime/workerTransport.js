'use strict';

const path = require('path');
const { fork } = require('child_process');
const { fail, ERROR_CODES } = require('./errors');
const { LIMITS, newId } = require('./contracts');

const WORKER_PROTOCOL_VERSION = 1;

class WorkerTransport {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || path.join(__dirname, '..', '..');
        this.driver = options.driver || 'mock';
        this.startupTimeoutMs = options.startupTimeoutMs || LIMITS.WORKER_STARTUP_TIMEOUT_MS;
        this.shutdownTimeoutMs = options.shutdownTimeoutMs || LIMITS.WORKER_SHUTDOWN_TIMEOUT_MS;
        this.onEvent = options.onEvent || (() => {});
        this.onModelRequest = options.onModelRequest || (() => {});
        this.onToolRequest = options.onToolRequest || (() => {});
        this.onFatal = options.onFatal || (() => {});
        this.onExit = options.onExit || (() => {});
        this.spawnImpl = options.spawnImpl || null;
        this.execPath = options.execPath || resolveElectronNodeExecPath(this.projectRoot);

        this.child = null;
        this.ready = false;
        this.probe = null;
        this.pendingRequests = new Map();
        this._boundOnMessage = (message) => this._handleMessage(message);
        this._boundOnExit = (code, signal) => this._handleExit(code, signal);
    }

    isRunning() {
        return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
    }

    async start() {
        if (this.isRunning()) {
            return { alreadyRunning: true, probe: this.probe };
        }
        const sidecarPath = path.join(this.projectRoot, 'agent-runtime', 'sidecar.cjs');
        const env = {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            AGENT_RUNTIME_DRIVER: this.driver,
        };
        const forkImpl = this.spawnImpl || fork;
        this.child = forkImpl(sidecarPath, [], {
            execPath: this.execPath,
            env,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            windowsHide: true,
        });
        this.ready = false;
        this.probe = null;
        this.child.on('message', this._boundOnMessage);
        this.child.on('exit', this._boundOnExit);
        if (this.child.stderr) {
            this.child.stderr.on('data', (chunk) => {
                this.onEvent({ type: 'worker-stderr', text: chunk.toString().slice(0, 2000) });
            });
        }
        const ready = await this._waitForReady();
        this.ready = true;
        this.probe = ready.probe;
        return { alreadyRunning: false, probe: this.probe };
    }

    async stop() {
        if (!this.isRunning()) {
            this._cleanupChild();
            return { stopped: true, forced: false };
        }
        const requestId = newId('req');
        const ackPromise = this._registerPending(requestId, this.shutdownTimeoutMs);
        this._send({ type: 'shutdown', requestId });
        try {
            await ackPromise;
        } catch (error) {
            // Fall through to force kill below.
        }
        if (this.isRunning()) {
            try {
                this.child.kill('SIGKILL');
            } catch (error) {
                // Process may have exited between checks.
            }
            await this._waitForExit(3000);
            this._cleanupChild();
            return { stopped: true, forced: true };
        }
        this._cleanupChild();
        return { stopped: true, forced: false };
    }

    sendRequest(type, payload, timeoutMs = LIMITS.TOOL_DEFAULT_TIMEOUT_MS) {
        if (!this.isRunning()) {
            fail(ERROR_CODES.RUNTIME_NOT_READY, 'Worker is not running');
        }
        const requestId = payload.requestId || newId('req');
        const promise = this._registerPending(requestId, timeoutMs);
        this._send({ type, ...payload, requestId });
        return { requestId, promise };
    }

    sendModelResult(message) {
        this._send({
            type: 'model-result',
            requestId: message.requestId,
            ok: message.ok,
            data: message.data,
            error: message.error,
        });
    }

    sendToolResult(message) {
        this._send({
            type: 'tool-result',
            sessionId: message.sessionId,
            turnId: message.turnId,
            toolCallId: message.toolCallId,
            ok: message.ok,
            output: message.output,
            error: message.error,
            audit: message.audit,
        });
    }

    _send(message) {
        if (!this.isRunning()) {
            fail(ERROR_CODES.RUNTIME_NOT_READY, 'Worker is not running');
        }
        this.child.send(message, (error) => {
            if (error) {
                this.onFatal(`worker send failed: ${error.message}`);
            }
        });
    }

    _registerPending(requestId, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(Object.assign(new Error('worker request timeout'), { code: ERROR_CODES.WORKER_TIMEOUT }));
            }, timeoutMs);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
            this.pendingRequests.set(requestId, { resolve, reject, timer });
        });
    }

    _waitForReady() {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(Object.assign(new Error('worker ready timeout'), { code: ERROR_CODES.WORKER_TIMEOUT }));
            }, this.startupTimeoutMs);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
            const onMessage = (message) => {
                if (message && message.type === 'ready') {
                    cleanup();
                    if (message.protocolVersion !== WORKER_PROTOCOL_VERSION) {
                        reject(Object.assign(
                            new Error(`worker protocol mismatch: ${message.protocolVersion}`),
                            { code: ERROR_CODES.PROTOCOL_VERSION_MISMATCH },
                        ));
                        return;
                    }
                    resolve(message);
                }
            };
            const onExit = (code) => {
                cleanup();
                reject(Object.assign(new Error(`worker exited before ready (code ${code})`), { code: ERROR_CODES.WORKER_CRASHED }));
            };
            const cleanup = () => {
                clearTimeout(timer);
                this.child.off('message', onMessage);
                this.child.off('exit', onExit);
            };
            this.child.on('message', onMessage);
            this.child.on('exit', onExit);
        });
    }

    _waitForExit(timeoutMs) {
        return new Promise((resolve) => {
            if (!this.isRunning()) {
                resolve();
                return;
            }
            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, timeoutMs);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
            const onExit = () => {
                cleanup();
                resolve();
            };
            const cleanup = () => {
                clearTimeout(timer);
                if (this.child) {
                    this.child.off('exit', onExit);
                }
            };
            this.child.once('exit', onExit);
        });
    }

    _handleMessage(message) {
        if (!message || typeof message !== 'object') {
            return;
        }
        switch (message.type) {
            case 'ready':
                // Handled by _waitForReady listener.
                return;
            case 'ack':
            case 'session-started': {
                const pending = this.pendingRequests.get(message.requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingRequests.delete(message.requestId);
                    if (message.ok === false) {
                        pending.reject(Object.assign(new Error(message.error || 'worker request failed'), { code: ERROR_CODES.WORKER_PROTOCOL_ERROR, result: message }));
                    } else {
                        pending.resolve(message);
                    }
                }
                return;
            }
            case 'event':
                this.onEvent(message);
                return;
            case 'model-request':
                this.onModelRequest(message);
                return;
            case 'tool-request':
                this.onToolRequest(message);
                return;
            case 'fatal':
                this.onFatal(message.error || 'worker fatal');
                return;
            default:
                this.onFatal(`unknown worker message type: ${message.type}`);
        }
    }

    _handleExit(code, signal) {
        const error = Object.assign(
            new Error(`worker exited (code ${code}, signal ${signal})`),
            { code: ERROR_CODES.WORKER_CRASHED },
        );
        for (const [requestId, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(requestId);
            pending.reject(error);
        }
        this.ready = false;
        this.onExit(code, signal);
    }

    _cleanupChild() {
        if (this.child) {
            this.child.off('message', this._boundOnMessage);
            this.child.off('exit', this._boundOnExit);
            try {
                this.child.disconnect();
            } catch (error) {
                // Already disconnected.
            }
            this.child = null;
        }
        this.ready = false;
    }
}

function resolveElectronNodeExecPath(projectRoot) {
    const executable = process.platform === 'win32' ? 'electron.exe' : 'electron';
    const candidate = path.join(projectRoot, 'node_modules', 'electron', 'dist', executable);
    return require('fs').existsSync(candidate) ? candidate : process.execPath;
}

module.exports = {
    WorkerTransport,
    WORKER_PROTOCOL_VERSION,
    resolveElectronNodeExecPath,
};
