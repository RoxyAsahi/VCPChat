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
const eventService = new RuntimeEventService({
    repository: () => repository,
    threadStates: () => states,
    idleWarmSessions: () => new Map(),
    resumedThreadIds: () => new Set(),
    maxIdleWarmSessions: () => 0,
    scheduleSessionConfigApply: () => {},
    drainFollowUpQueue: async () => {},
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
eventService.sendUiEvent({ type: 'context.usage', sessionId: 'session-a', payload: { totalTokens: 10 } });
assert.equal(activity[0].patch.usage.totalTokens, '[redacted]');
assert.equal(envelopes[0].sequence, 1);
console.log('Codex Runtime policy and event service tests passed.');
