import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimeConfigService } = require('../modules/codex-runtime/runtime-config-service.js');
const { createRuntimeOperationContext } = require('../modules/codex-runtime/runtime-operation-context.js');

let session = {
    sessionId: 'session-config', threadId: null, workspaceRoot: process.cwd(),
    configRevision: 1, appliedRuntimeConfigRevision: 0, configApplyState: 'unmaterialized',
    configSnapshot: { instructionMode: 'vchat-identity', baseInstructions: '{{Nova}}', permissionMode: 'ask' },
    appliedRuntimeConfig: {},
};
const events = [];
let generation = 1;
const captureGeneration = () => {
    const captured = generation;
    return { value: captured, assertCurrent(current) {
        if (current !== captured) { const error = new Error('stale'); error.code = 'STALE_RUNTIME_GENERATION'; throw error; }
    } };
};
const applyPromises = new Map();
const applyTargets = new Map();
const resumedThreadIds = new Set();
let transportRequest = async () => ({});
const repository = {
    getSession: (sessionId) => sessionId === session.sessionId ? session : null,
    updateSessionConfig(sessionId, revision, update) {
        if (sessionId !== session.sessionId || revision !== session.configRevision) return { updated: false, session };
        session = {
            ...session,
            ...update,
            configSnapshot: update.configSnapshot,
            configRevision: session.configRevision + 1,
            configApplyState: 'pending',
        };
        return { updated: true, session };
    },
    markSessionConfigApplying(sessionId, revision) {
        session = { ...session, configApplyState: 'applying', configRevision: revision };
        return session;
    },
    markSessionConfigFailed(sessionId, revision, error) {
        session = { ...session, configApplyState: 'failed', configRevision: revision, configApplyError: error };
        return session;
    },
};
const service = new RuntimeConfigService({
    ensureProjectionStore: () => {},
    assertProjectionWritable: () => {},
    repository: () => repository,
    transport: () => ({ request: (...args) => transportRequest(...args) }),
    start: async () => {},
    captureGeneration,
    assertGeneration: (scope) => scope.assertCurrent(generation),
    createOperationContext: (identity) => createRuntimeOperationContext(captureGeneration(), identity),
    assertOperationContext: (operation) => operation.generation.assertCurrent(generation),
    resumeSession: async (value) => value,
    createSession: async () => { throw new Error('not expected'); },
    getSettings: () => ({ agentRuntime: { codex: { model: 'default-model', permissionMode: 'ask' } } }),
    setSettings: () => null,
    projectRoot: () => process.cwd(),
    validateReasoningEffort: (_model, effort) => ({ effort: effort || null, supported: effort ? [effort] : [] }),
    reasoningEffortsForModel: () => [],
    sendUiEvent: (event) => events.push(event),
    setLastError: () => {},
    configApplyPromises: () => applyPromises,
    configApplyTargets: () => applyTargets,
    resumedThreadIds: () => resumedThreadIds,
    threadStates: () => new Map(),
    runtimeGeneration: () => 1,
});

assert.deepEqual(service.getWorkbenchSettings(), {
    runtime: 'codex-app-server', driver: 'codex', permissionMode: 'ask', model: 'default-model',
});
const saved = await service.updateSessionConfig({
    sessionId: session.sessionId,
    expectedConfigRevision: 1,
    patch: { model: 'next-model', permissionMode: 'always-approve' },
});
assert.equal(saved.configRevision, 2);
assert.equal(saved.desiredConfig.model, 'next-model');
assert.equal(saved.desiredConfig.permissionMode, 'always-approve');
assert.equal(events.at(-1).type, 'session.config.saved');
assert.throws(() => service.updateSessionConfig({
    sessionId: session.sessionId, expectedConfigRevision: 2, patch: { unknown: true },
}), /Unsupported Session config fields/);
service.clearScheduledApplies();

session = { ...session, threadId: 'thread-config', appliedRuntimeConfigRevision: 1,
    appliedRuntimeConfig: { ...session.configSnapshot, model: 'old-model' }, configApplyState: 'pending' };
resumedThreadIds.add(session.threadId);
let appliedRequest;
transportRequest = async (method, params) => { appliedRequest = { method, params }; return {}; };
await service.applySessionRuntimeConfig(session.sessionId);
assert.equal(appliedRequest.method, 'thread/settings/update');
assert.equal(applyTargets.get(session.threadId).sessionId, session.sessionId);

let releaseApply;
session = { ...session, configRevision: 3, configApplyState: 'pending',
    configSnapshot: { ...session.configSnapshot, model: 'stale-model' } };
transportRequest = () => new Promise((resolve) => { releaseApply = resolve; });
const staleApply = service.applySessionRuntimeConfig(session.sessionId);
await new Promise((resolve) => setImmediate(resolve));
generation += 1;
releaseApply({});
await assert.rejects(staleApply, (error) => error.code === 'STALE_RUNTIME_GENERATION');
assert.notEqual(session.configApplyState, 'failed', 'a stale config ACK must not write failure state');

console.log('Codex Runtime config service tests passed.');
