import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimePolicyService } = require('../modules/codex-runtime/runtime-policy-service.js');
const { RuntimeEventService } = require('../modules/codex-runtime/runtime-event-service.js');

const policy = new RuntimePolicyService({ providerParams: () => ({ modelProvider: 'vcp_toolbox', config: { base: true } }) });
const restricted = policy.runtimePolicyParams({ executionProfile: 'toolbox-only' }, { starting: true });
assert.equal(restricted.modelProvider, 'vcp_toolbox');
assert.equal(restricted.config['features.shell_tool'], false);
assert.deepEqual(restricted.environments, []);
assert.deepEqual(policy.threadInstructionParams({
    executionProfile: 'toolbox-only', instructionMode: 'vchat-identity', baseInstructions: '{{Nova}}',
}), { baseInstructions: '{{Nova}}' });
assert.throws(() => policy.threadInstructionParams({ executionProfile: 'toolbox-only', instructionMode: 'vchat-identity' }),
    (error) => error.code === 'AGENT_IDENTITY_MISSING');

const sessions = new Map([['session-a', {
    sessionId: 'session-a', threadId: 'thread-a', state: 'running', configRevision: 1,
    appliedRuntimeConfigRevision: 1,
}]]);
const activity = [];
const repository = {
    getSession: (id) => sessions.get(id) || null,
    saveSession(session) { sessions.set(session.sessionId, session); return session; },
    updateActivity(sessionId, patch) { activity.push({ sessionId, patch }); },
};
const states = new Map([['thread-a', { activity: 'running', activeTurnId: 'turn-a' }]]);
const envelopes = [];
let drainCount = 0;
const eventService = new RuntimeEventService({
    repository: () => repository,
    threadStates: () => states,
    idleWarmSessions: () => new Map(),
    resumedThreadIds: () => new Set(),
    maxIdleWarmSessions: () => 0,
    scheduleSessionConfigApply: () => {},
    drainFollowUpQueue: async () => { drainCount += 1; },
    sendEvent: (event) => envelopes.push(event),
});
eventService.updateThreadState({
    method: 'turn/completed',
    params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } },
}, sessions.get('session-a'));
assert.equal(states.get('thread-a').activity, 'idle');

states.set('thread-a', { activity: 'running', activeTurnId: 'turn-b' });
eventService.updateThreadState({
    method: 'turn/completed',
    params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } },
}, sessions.get('session-a'));
assert.deepEqual(states.get('thread-a'), { activity: 'running', activeTurnId: 'turn-b' });
states.set('thread-a', { activity: 'running', activeTurnId: 'turn-c', observedThreadStatus: 'active' });
eventService.updateThreadState({
    method: 'thread/status/changed',
    params: { threadId: 'thread-a', status: { type: 'idle' } },
}, sessions.get('session-a'));
assert.equal(states.get('thread-a').activeTurnId, 'turn-c',
    'Codex 0.146 idle status must not finish the active Turn before turn/completed');
assert.equal(drainCount, 1, 'idle status must not drain another follow-up');
eventService.updateThreadState({
    method: 'turn/completed',
    params: { threadId: 'thread-a', turn: { id: 'turn-c', status: 'completed' } },
}, sessions.get('session-a'));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(states.get('thread-a').activeTurnId, null);
states.set('thread-a', {
    activity: 'unknown', activeTurnId: null, observedThreadStatus: 'active', recoveryState: 'unconfirmed',
});
eventService.updateThreadState({
    method: 'turn/started', params: { turn: { id: 'turn-recovered' } },
}, sessions.get('session-a'));
assert.equal(states.get('thread-a').recoveryState, 'confirmed',
    'an authoritative turn/started event must clear a prior unconfirmed recovery state');
assert.equal(states.get('thread-a').activeTurnId, 'turn-recovered');
assert.equal(drainCount, 2, 'the matching completion is the finalization authority');
eventService.sendUiEvent({ type: 'context.usage', sessionId: 'session-a', payload: { totalTokens: 10 } });
assert.equal(activity[0].patch.usage.totalTokens, 10);
assert.equal(activity[0].patch.usage.source, 'unknown');
assert.equal(envelopes[0].sequence, 1);
console.log('Codex Runtime policy and event service tests passed.');
