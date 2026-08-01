import assert from 'node:assert/strict';
import {
    createAgentSessionUiState,
    reconcileAgentSessionUiState,
    reduceAgentSessionUiState,
} from '../modules/ui-system/agent-session-state.js';

let state = createAgentSessionUiState([
    { sessionId: 'a', threadId: 'thread-a', state: 'idle' },
    { sessionId: 'b', threadId: 'thread-b', state: 'idle' },
]);
state = reduceAgentSessionUiState(state, { type: 'session.selected', sessionId: 'b' });
assert.equal(state.selectedSessionId, 'b');
state = reduceAgentSessionUiState(state, { type: 'turn.started', sessionId: 'a', threadId: 'thread-a', turnId: 'turn-a' });
assert.equal(state.bySessionId.a.state, 'streaming');
assert.equal(state.bySessionId.b.state, 'idle', 'selected session must not receive another Thread state');
const beforeWrongThread = state;
state = reduceAgentSessionUiState(state, { type: 'turn.completed', sessionId: 'a', threadId: 'thread-b', turnId: 'turn-a' });
assert.strictEqual(state, beforeWrongThread, 'cross-thread events must not mutate the projection');
state = reduceAgentSessionUiState(state, { type: 'interaction.native.requested', sessionId: 'a', threadId: 'thread-a', turnId: 'turn-a', requestId: 'req-a' });
assert.equal(state.bySessionId.a.state, 'waiting-native-approval');
state = reduceAgentSessionUiState(state, { type: 'interaction.resolved', sessionId: 'a', threadId: 'thread-a', turnId: 'turn-a', requestId: 'other' });
assert.equal(state.bySessionId.a.state, 'waiting-native-approval', 'an old interaction cannot resolve a newer request');
state = reduceAgentSessionUiState(state, { type: 'interaction.resolved', sessionId: 'a', threadId: 'thread-a', turnId: 'turn-a', requestId: 'req-a' });
assert.equal(state.bySessionId.a.state, 'streaming');
state = reduceAgentSessionUiState(state, { type: 'turn.interrupted', sessionId: 'a', threadId: 'thread-a', turnId: 'turn-a' });
assert.equal(state.bySessionId.a.state, 'interrupted');
let live = createAgentSessionUiState([{ sessionId: 'c', threadId: 'thread-c', state: 'running' }]);
live = reduceAgentSessionUiState(live, { type: 'turn.started', sessionId: 'c', threadId: 'thread-c', turnId: 'turn-c' });
const refreshed = reconcileAgentSessionUiState(live, [{ sessionId: 'c', threadId: 'thread-c', state: 'running' }]);
assert.equal(refreshed.bySessionId.c.state, 'streaming', 'a status refresh cannot erase an in-flight turn');
console.log('Agent Session UI state reducer tests passed.');
