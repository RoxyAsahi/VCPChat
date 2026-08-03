import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimeConfigService } = require('../modules/codex-runtime/runtime-config-service.js');

let session = {
    sessionId: 'session-config', threadId: null, workspaceRoot: process.cwd(),
    configRevision: 1, appliedRuntimeConfigRevision: 0, configApplyState: 'unmaterialized',
    configSnapshot: { instructionMode: 'vchat-identity', baseInstructions: '{{Nova}}', permissionMode: 'ask' },
    appliedRuntimeConfig: {},
};
const events = [];
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
};
const service = new RuntimeConfigService({
    ensureProjectionStore: () => {},
    assertProjectionWritable: () => {},
    repository: () => repository,
    transport: () => ({ request: async () => ({}) }),
    start: async () => {},
    captureGeneration: () => 1,
    assertGeneration: () => {},
    resumeSession: async (value) => value,
    createSession: async () => { throw new Error('not expected'); },
    getSettings: () => ({ agentRuntime: { codex: { model: 'default-model', permissionMode: 'ask' } } }),
    setSettings: () => null,
    projectRoot: () => process.cwd(),
    validateReasoningEffort: (_model, effort) => ({ effort: effort || null, supported: effort ? [effort] : [] }),
    reasoningEffortsForModel: () => [],
    sendUiEvent: (event) => events.push(event),
    setLastError: () => {},
    configApplyPromises: () => new Map(),
    configApplyTargets: () => new Map(),
    resumedThreadIds: () => new Set(),
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

console.log('Codex Runtime config service tests passed.');
