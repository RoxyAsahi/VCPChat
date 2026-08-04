import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexRuntimeManager } = require('../modules/codex-runtime/runtimeManager.js');
const { AgentProjectionRepository } = require('../modules/codex-runtime/projection');

class ConfigTransport extends EventEmitter {
    constructor() {
        super();
        this.status = { running: false, ready: false, pid: 146 };
        this.calls = [];
        this.failSettings = false;
        this.autoConfirmSettings = false;
    }
    async start() { this.status = { ...this.status, running: true, ready: true }; }
    async stop() { this.status = { ...this.status, running: false, ready: false }; }
    async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/start') return { thread: { id: 'thread-config' } };
        if (method === 'thread/resume') return { thread: { id: params.threadId, status: { type: 'idle' } } };
        if (method === 'thread/settings/update' && this.failSettings) {
            const error = new Error('settings rejected');
            error.code = 'INVALID_PARAMS';
            throw error;
        }
        if (method === 'thread/settings/update' && this.autoConfirmSettings) {
            queueMicrotask(() => this.emit('notification', {
                method: 'thread/settings/updated',
                params: {
                    threadId: params.threadId,
                    threadSettings: {
                        cwd: params.cwd, model: params.model, approvalPolicy: params.approvalPolicy,
                        effort: params.effort ?? null, personality: params.personality ?? null,
                    },
                },
            }));
        }
        if (method === 'turn/start') return { turn: { id: 'turn-config' } };
        return {};
    }
    respond() {}
    respondError() {}
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-config-'));
const workspaceA = path.join(root, 'workspace-a');
const workspaceB = path.join(root, 'workspace-b');
fs.mkdirSync(workspaceA);
fs.mkdirSync(workspaceB);
const transport = new ConfigTransport();
const events = [];
let resolveToolboxInstructions = null;
const manager = new CodexRuntimeManager({
    projectRoot: root,
    settingsPath: path.join(root, 'settings.json'),
    getSettings: () => ({ vcpServerUrl: 'http://toolbox.invalid:6005', vcpApiKey: 'test-key' }),
    getModels: () => [{ id: 'model-a', reasoning_efforts: ['low', 'high'] }, { id: 'model-b', reasoning_efforts: ['low', 'high'] }],
    transportFactory: () => transport,
    repositoryFactory: () => new AgentProjectionRepository({ databasePath: path.join(root, 'projection.sqlite') }),
    responsesAdapterFactory: (options) => {
        resolveToolboxInstructions = options.resolveInstructions;
        return {
            capability: 'config-apply-fixture',
            baseUrl: 'http://127.0.0.1:1460/v1/config-apply-fixture',
            async start() { return this.baseUrl; },
            async stop() {},
        };
    },
    sendEvent: (event) => events.push(event),
});

const topic = await manager.createSessionRecord({
    agentId: 'Nova', title: 'Config apply', workspaceRoot: workspaceA,
    model: 'model-a', reasoningEffort: 'low', permissionMode: 'ask', baseInstructions: '{{Nova}}',
});
await manager.ensureSessionRuntime({ sessionId: topic.sessionId });
assert.equal(resolveToolboxInstructions({
    threadId: 'thread-config',
    sessionId: 'thread-config',
}).baseInstructions, '{{Nova}}',
    'Codex provider session_id is the Codex Thread id, not the VChat Session primary key');
assert.throws(() => resolveToolboxInstructions({
    threadId: 'thread-config',
    sessionId: 'different-thread',
}), (error) => error.code === 'SESSION_IDENTITY_MISMATCH',
    'a provider session identity from another Codex Thread must fail closed');
const before = manager.repository.getSession(topic.sessionId);
const saved = await manager.updateSessionConfig({
    sessionId: topic.sessionId,
    expectedConfigRevision: before.configRevision,
    patch: {
        workspaceRoot: workspaceB,
        model: 'model-b',
        reasoningEffort: 'high',
        permissionMode: 'always-approve',
    },
});
assert.equal(saved.desiredConfig.permissionMode, 'always-approve');
assert.equal(saved.desiredConfig.workspaceRoot, workspaceB);
assert.equal(saved.appliedRuntimeConfig.workspaceRoot, workspaceA);
assert.notEqual(saved.configRevision, saved.appliedRuntimeConfigRevision,
    'saving desired config must not pretend the Runtime has already applied it');
await manager._applySessionRuntimeConfig(topic.sessionId);
const update = transport.calls.filter((call) => call.method === 'thread/settings/update').at(-1);
assert.deepEqual(update.params, {
    threadId: 'thread-config', cwd: workspaceB, model: 'model-b', approvalPolicy: 'never', effort: 'high',
});
transport.emit('notification', {
    method: 'thread/settings/updated',
    params: { threadId: 'thread-config' },
});
assert.notEqual(manager.readSessionConfig({ sessionId: topic.sessionId }).applyState, 'applied',
    'an empty settings notification cannot confirm a target revision');
transport.emit('notification', {
    method: 'thread/settings/updated',
    params: {
        threadId: 'thread-config',
        threadSettings: {
            cwd: workspaceB, model: 'model-b', approvalPolicy: 'never', effort: 'high', personality: null,
        },
    },
});
const applied = manager.readSessionConfig({ sessionId: topic.sessionId });
assert.equal(applied.applyState, 'applied');
assert.equal(applied.appliedRuntimeConfigRevision, applied.configRevision);
assert.equal(applied.appliedRuntimeConfig.workspaceRoot, workspaceB,
    'the confirmed applied config must include the Runtime workspace identity');
assert.ok(events.some((event) => event.type === 'session.config.saved'));
assert.ok(events.some((event) => event.type === 'session.config.applied'));

const promptSaved = await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: applied.configRevision,
    baseInstructions: '{{NovaV2}}',
});
manager.threadStates.set('thread-config', { activity: 'running', activeTurnId: 'turn-running' });
await manager._applySessionRuntimeConfig(topic.sessionId);
assert.notEqual(promptSaved.configRevision, manager.readSessionConfig({ sessionId: topic.sessionId }).appliedRuntimeConfigRevision,
    'instruction updates during an active Turn must remain pending');
manager.threadStates.set('thread-config', { activity: 'idle', activeTurnId: null });
await manager._applySessionRuntimeConfig(topic.sessionId);
assert.ok(transport.calls.some((call) => call.method === 'thread/unsubscribe'));
assert.equal(manager.readSessionConfig({ sessionId: topic.sessionId }).applyState, 'applied',
    'an idle unsubscribe/resume reload must preserve threadId and mark instructions applied');

const afterPrompt = manager.repository.getSession(topic.sessionId);
await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: afterPrompt.configRevision,
    model: 'model-a',
});
transport.autoConfirmSettings = true;
await manager._applySessionRuntimeConfig(topic.sessionId, { barrier: true });
assert.equal(manager.readSessionConfig({ sessionId: topic.sessionId }).applyState, 'applied',
    'the send barrier must wait for the matching settings notification');
transport.autoConfirmSettings = false;
const afterConfirmed = manager.repository.getSession(topic.sessionId);
await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: afterConfirmed.configRevision,
    model: 'model-b',
});
transport.failSettings = true;
await assert.rejects(() => manager.startTurn({ sessionId: topic.sessionId, prompt: 'must not send' }), /settings rejected/);
assert.equal(transport.calls.filter((call) => call.method === 'turn/start'
    && call.params.input?.some((item) => item.text === 'must not send')).length, 0,
    'a failed config barrier must block the user Turn');

transport.failSettings = false;
await manager.stop();
fs.rmSync(root, { recursive: true, force: true });
console.log('Agent Runtime config apply tests passed.');
