import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimeTurnService } = require('../modules/codex-runtime/runtime-turn-service.js');

const session = {
    sessionId: 'session-turn', threadId: 'thread-turn', workspaceRoot: '.', archivedAt: null,
    configRevision: 2, configSnapshot: { model: 'gpt-5.6', permissionMode: 'ask', sandbox: 'none' },
};
const repository = {
    getSession: (sessionId) => sessionId === session.sessionId ? session : null,
    markSessionConfigApplied: (sessionId, revision, config) => ({ ...session, sessionId, configRevision: revision, configSnapshot: config }),
    listPendingInputs: () => [],
};
const threadStates = new Map([['thread-turn', { activity: 'idle', activeTurnId: null }]]);
const resumedThreadIds = new Set(['thread-turn']);
const turnStartPromises = new Map();
const calls = [];
let generation = 4;
const service = new RuntimeTurnService({
    ensureProjectionStore: () => {},
    assertProjectionWritable: () => {},
    repository: () => repository,
    transport: () => ({
        async request(method, params) {
            calls.push({ method, params });
            if (method === 'turn/start') return { turn: { id: 'turn-accepted' } };
            if (method === 'turn/interrupt') return {};
            throw new Error(`unexpected ${method}`);
        },
    }),
    bridge: () => null,
    responsesAdapter: () => null,
    attachments: () => ({ resolveMany: () => [] }),
    dynamicCalls: () => new Map(),
    start: async () => {},
    captureGeneration: () => generation,
    assertGeneration: (scope) => {
        if (scope !== generation) { const error = new Error('stale'); error.code = 'STALE_RUNTIME_GENERATION'; throw error; }
    },
    repairSessionConfig: (value) => value,
    repairSessionIdentity: (value) => value,
    configSnapshot: () => ({}),
    runtimePolicyParams: () => ({}),
    threadInstructionParams: () => ({}),
    effectiveReasoningEffort: () => null,
    applySessionRuntimeConfig: async () => {},
    sendSessionConfigEvent: () => {},
    sendUiEvent: () => {},
    rememberIdleWarmSession: () => {},
    assertLifecycleIdle: () => {},
    createId: (prefix) => `${prefix}-generated`,
    diagnosticClock: () => 1,
    diagnostic: () => {},
    faultInjection: () => ({}),
    sessionWarmPromises: () => new Map(),
    turnStartPromises: () => turnStartPromises,
    followUpDrainPromises: () => new Map(),
    compactionWaiters: () => new Map(),
    resumedThreadIds: () => resumedThreadIds,
    resumingThreads: () => new Map(),
    threadStates: () => threadStates,
    configApplyTargets: () => new Map(),
    idleWarmSessions: () => new Map(),
});

const started = await service.startTurn({ sessionId: session.sessionId, prompt: 'hello' });
assert.equal(started.turnId, 'turn-accepted');
assert.equal(threadStates.get('thread-turn').activity, 'running');
assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1);
await service.cancel({ sessionId: session.sessionId, turnId: started.turnId });
assert.equal(calls.at(-1).method, 'turn/interrupt');

let release;
const staleTransport = service.context?.transport;
void staleTransport;
console.log('Codex Runtime turn service tests passed.');
