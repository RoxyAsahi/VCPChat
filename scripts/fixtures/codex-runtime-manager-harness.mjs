import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexRuntimeManager, vcpInvokeTool } = require('../../modules/codex-runtime/runtimeManager.js');
const { AgentProjectionRepository } = require('../../modules/codex-runtime/projection');
const { developmentBridgePath } = require('../../modules/codex-runtime/toolboxBridgePaths');

export class FakeTransport extends EventEmitter {
    constructor() {
        super();
        this.status = { running: false, ready: false, pid: 77 };
        this.calls = [];
        this.responses = [];
        this.startCount = 0;
        this.threadSettings = new Map();
    }
    async start() { this.startCount += 1; this.status = { ...this.status, running: true, ready: true }; }
    async stop() { this.status = { ...this.status, running: false, ready: false }; }
    async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/start') {
            this.threadCounter = (this.threadCounter || 0) + 1;
            const threadId = this.threadCounter === 1 ? 'thr_test' : `thr_test_${this.threadCounter}`;
            this.threadSettings.set(threadId, {
                cwd: params.cwd || null,
                model: params.model || null,
                approvalPolicy: params.approvalPolicy || null,
                effort: null,
                personality: params.personality ?? null,
            });
            return { thread: { id: threadId } };
        }
        if (method === 'thread/resume') {
            const current = this.threadSettings.get(params.threadId) || {};
            const settings = {
                ...current,
                cwd: params.cwd ?? current.cwd ?? null,
                model: params.model ?? current.model ?? null,
                approvalPolicy: params.approvalPolicy ?? current.approvalPolicy ?? null,
            };
            this.threadSettings.set(params.threadId, settings);
            return {
                thread: { id: params.threadId, status: { type: 'idle' } },
                cwd: settings.cwd,
                model: settings.model,
                approvalPolicy: settings.approvalPolicy,
                reasoningEffort: settings.effort ?? null,
            };
        }
        if (method === 'thread/settings/update') {
            const settings = {
                cwd: params.cwd ?? null,
                model: params.model ?? null,
                approvalPolicy: params.approvalPolicy ?? null,
                effort: params.effort ?? null,
                personality: params.personality ?? null,
            };
            this.threadSettings.set(params.threadId, settings);
            queueMicrotask(() => this.emit('notification', {
                method: 'thread/settings/updated',
                params: { threadId: params.threadId, threadSettings: settings },
            }));
            return {};
        }
        if (method === 'turn/start') return { turn: { id: 'turn_test' } };
        if (method === 'thread/read' && this.readError) throw this.readError;
        if (method === 'thread/read' && this.readResult) return this.readResult;
        if (method === 'thread/read') return {
            thread: {
                id: 'thr_test',
                turns: [{
                    id: 'turn_test',
                    items: [{ id: 'item_a', type: 'agentMessage', text: 'done', status: 'completed' }],
                }],
            },
        };
        if (method === 'thread/fork') return { thread: { id: 'thr_fork', sessionId: 'thr_fork' } };
        return {};
    }
    respond(id, result) { this.responses.push({ id, result }); }
    respondError(id, code, message) { this.responses.push({ id, error: { code, message } }); }
}

export { assert, os, path, fs, CodexRuntimeManager, AgentProjectionRepository, developmentBridgePath, vcpInvokeTool };
