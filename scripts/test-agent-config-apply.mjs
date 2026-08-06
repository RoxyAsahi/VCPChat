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
        this.threadCounter = 0;
        this.threadSettings = new Map();
    }
    async start() { this.status = { ...this.status, running: true, ready: true }; }
    async stop() { this.status = { ...this.status, running: false, ready: false }; }
    async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/start') {
            this.threadCounter += 1;
            const threadId = this.threadCounter === 1 ? 'thread-config' : `thread-config-${this.threadCounter}`;
            this.threadSettings.set(threadId, {
                cwd: params.cwd, model: params.model, approvalPolicy: params.approvalPolicy,
                effort: null, personality: params.personality ?? null,
            });
            return { thread: { id: threadId } };
        }
        if (method === 'thread/resume') {
            const current = this.threadSettings.get(params.threadId) || {};
            const settings = {
                ...current, cwd: params.cwd, model: params.model,
                approvalPolicy: params.approvalPolicy, personality: params.personality ?? null,
            };
            this.threadSettings.set(params.threadId, settings);
            return {
                thread: { id: params.threadId, status: { type: 'idle' } },
                cwd: settings.cwd, model: settings.model,
                approvalPolicy: settings.approvalPolicy,
                reasoningEffort: settings.effort,
            };
        }
        if (method === 'thread/settings/update' && this.failSettings) {
            const error = new Error('settings rejected');
            error.code = 'INVALID_PARAMS';
            throw error;
        }
        if (method === 'thread/settings/update') {
            const settings = {
                cwd: params.cwd, model: params.model, approvalPolicy: params.approvalPolicy,
                effort: params.effort ?? null, personality: params.personality ?? null,
            };
            this.threadSettings.set(params.threadId, settings);
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
    configApplyConfirmationTimeoutMs: 100,
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
    personality: null,
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

const beforeToolPolicy = manager.repository.getSession(topic.sessionId);
const settingsUpdateCount = transport.calls.filter((call) => call.method === 'thread/settings/update').length;
await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: beforeToolPolicy.configRevision,
    toolPolicy: {
        schemaVersion: 1,
        preset: 'readonly',
        enabledCodexCapabilities: [],
        enabledVcpTools: [],
    },
});
transport.autoConfirmSettings = false;
await manager._applySessionRuntimeConfig(topic.sessionId, { barrier: true });
const toolPolicyApplied = manager.readSessionConfig({ sessionId: topic.sessionId });
assert.equal(toolPolicyApplied.applyState, 'applied');
assert.equal(toolPolicyApplied.appliedRuntimeConfig.toolPolicy.preset, 'readonly');
assert.equal(transport.calls.filter((call) => call.method === 'thread/settings/update').length, settingsUpdateCount,
    'host-only tool policy changes must not wait for a Codex Thread settings notification');

manager.threadStates.set('thread-config', { activity: 'running', activeTurnId: 'turn-policy-running' });
await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: toolPolicyApplied.configRevision,
    toolPolicy: {
        schemaVersion: 1,
        preset: 'custom',
        enabledCodexCapabilities: [],
        enabledVcpTools: [],
    },
});
await manager._applySessionRuntimeConfig(topic.sessionId);
assert.notEqual(manager.readSessionConfig({ sessionId: topic.sessionId }).applyState, 'applied',
    'host-only policy changes must not alter the active Turn authority');
manager.threadStates.set('thread-config', { activity: 'idle', activeTurnId: null });
await manager._applySessionRuntimeConfig(topic.sessionId, { barrier: true });
const deferredToolPolicyApplied = manager.readSessionConfig({ sessionId: topic.sessionId });
assert.equal(deferredToolPolicyApplied.appliedRuntimeConfig.toolPolicy.preset, 'custom');

const promptSaved = await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: deferredToolPolicyApplied.configRevision,
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

const afterInstructionResume = manager.repository.getSession(topic.sessionId);
transport.autoConfirmSettings = true;
await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: afterInstructionResume.configRevision,
    baseInstructions: '{{NovaV3}}',
    reasoningEffort: 'low',
});
await manager._applySessionRuntimeConfig(topic.sessionId, { barrier: true });
const instructionAndEffort = manager.readSessionConfig({ sessionId: topic.sessionId });
assert.equal(instructionAndEffort.applyState, 'applied');
assert.equal(instructionAndEffort.appliedRuntimeConfig.reasoningEffort, 'low',
    'resume cannot falsely confirm a simultaneous reasoning change that only settings/update can apply');
assert.ok(transport.calls.some((call) => call.method === 'thread/settings/update' && call.params.effort === 'low'),
    'instruction reload must continue through settings/update when resume does not confirm the target effort');

const beforeReasoningClear = manager.repository.getSession(topic.sessionId);
await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: beforeReasoningClear.configRevision,
    reasoningEffort: null,
});
transport.autoConfirmSettings = true;
await manager._applySessionRuntimeConfig(topic.sessionId, { barrier: true });
const reasoningCleared = manager.readSessionConfig({ sessionId: topic.sessionId });
assert.equal(reasoningCleared.applyState, 'applied');
assert.equal(reasoningCleared.appliedRuntimeConfig.reasoningEffort, null,
    'model-default reasoning must be persisted as an explicit cleared Runtime setting');
assert.equal(transport.calls.filter((call) => call.method === 'thread/settings/update').at(-1).params.effort, null,
    'clearing reasoning must send effort:null instead of omitting the previous override');

transport.autoConfirmSettings = false;
const beforeRevisionRace = manager.repository.getSession(topic.sessionId);
await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: beforeRevisionRace.configRevision,
    model: 'model-a',
});
await new Promise((resolve) => setImmediate(resolve));
const oldBarrier = manager._applySessionRuntimeConfig(topic.sessionId, { barrier: true });
await new Promise((resolve) => setImmediate(resolve));
const oldTargetCall = transport.calls.filter((call) => call.method === 'thread/settings/update').at(-1);
const revisionA = manager.repository.getSession(topic.sessionId);
await manager.updateWorkbenchSettings({
    sessionId: topic.sessionId,
    expectedConfigRevision: revisionA.configRevision,
    model: 'model-b',
});
transport.emit('notification', {
    method: 'thread/settings/updated',
    params: {
        threadId: oldTargetCall.params.threadId,
        threadSettings: {
            cwd: oldTargetCall.params.cwd,
            model: oldTargetCall.params.model,
            approvalPolicy: oldTargetCall.params.approvalPolicy,
            effort: oldTargetCall.params.effort ?? null,
            personality: oldTargetCall.params.personality ?? null,
        },
    },
});
await assert.rejects(oldBarrier, (error) => error.code === 'SESSION_CONFIG_CONFLICT',
    'a notification for an obsolete revision must reject its waiter instead of confirming the latest config');
transport.autoConfirmSettings = true;
await manager._applySessionRuntimeConfig(topic.sessionId, { barrier: true });
const revisionRaceApplied = manager.readSessionConfig({ sessionId: topic.sessionId });
assert.equal(revisionRaceApplied.applyState, 'applied');
assert.equal(revisionRaceApplied.appliedRuntimeConfigRevision, revisionRaceApplied.configRevision);
assert.equal(revisionRaceApplied.appliedRuntimeConfig.model, 'model-b',
    'latest-wins apply must continue with the newest Session revision after an obsolete waiter is rejected');

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
manager.threadStates.set('thread-config', { activity: 'idle', activeTurnId: null });
const unsubscribeCount = transport.calls.filter((call) => call.method === 'thread/unsubscribe').length;
const confirmationKeepAlive = setTimeout(() => {}, 1_000);
try {
    await manager._applySessionRuntimeConfig(topic.sessionId, { barrier: true });
} finally {
    clearTimeout(confirmationKeepAlive);
}
const reboundConfig = manager.readSessionConfig({ sessionId: topic.sessionId });
assert.equal(reboundConfig.applyState, 'applied');
assert.equal(reboundConfig.appliedRuntimeConfigRevision, reboundConfig.configRevision,
    'an idle confirmation timeout must perform one full resume and confirm the desired revision');
assert.equal(transport.calls.filter((call) => call.method === 'thread/unsubscribe').length,
    unsubscribeCount + 1, 'confirmation recovery must unsubscribe exactly once');

const managedTopic = await manager.createSessionRecord({
    agentId: 'CodexManaged', title: 'Managed personality', workspaceRoot: workspaceA,
    model: 'model-a', reasoningEffort: null, permissionMode: 'ask',
    instructionMode: 'codex-managed', baseInstructions: '', personality: 'friendly',
});
await manager.ensureSessionRuntime({ sessionId: managedTopic.sessionId });
const managedMaterialized = manager.repository.getSession(managedTopic.sessionId);
assert.equal(managedMaterialized.appliedRuntimeConfig.personality, 'friendly');
transport.autoConfirmSettings = true;
await manager.updateWorkbenchSettings({
    sessionId: managedTopic.sessionId,
    expectedConfigRevision: managedMaterialized.configRevision,
    personality: 'none',
});
await manager._applySessionRuntimeConfig(managedTopic.sessionId, { barrier: true });
const personalityCleared = manager.readSessionConfig({ sessionId: managedTopic.sessionId });
assert.equal(personalityCleared.applyState, 'applied');
assert.equal(personalityCleared.appliedRuntimeConfig.personality, 'none');
const personalityUpdate = transport.calls.filter((call) => call.method === 'thread/settings/update'
    && call.params.threadId === managedMaterialized.threadId).at(-1);
assert.equal(personalityUpdate.params.personality, null,
    'clearing a managed personality must send personality:null to Codex 0.146');

transport.autoConfirmSettings = false;
const beforeStopBarrier = manager.repository.getSession(managedTopic.sessionId);
await manager.updateWorkbenchSettings({
    sessionId: managedTopic.sessionId,
    expectedConfigRevision: beforeStopBarrier.configRevision,
    model: 'model-b',
});
const stoppedBarrier = manager._applySessionRuntimeConfig(managedTopic.sessionId, { barrier: true });
await new Promise((resolve) => setImmediate(resolve));
await manager.stop();
await assert.rejects(stoppedBarrier, (error) => ['RUNTIME_STOPPED', 'STALE_RUNTIME_GENERATION'].includes(error.code),
    'Runtime stop must reject an in-flight config barrier instead of leaving it pending');
fs.rmSync(root, { recursive: true, force: true });
console.log('Agent Runtime config apply tests passed.');
