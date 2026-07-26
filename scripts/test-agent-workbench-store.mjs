import assert from 'node:assert/strict';
import { createWorkbenchController } from '../modules/ui-system/agent-workbench-controller.js';
import { createWorkbenchStore } from '../modules/ui-system/agent-workbench-store.js';
import { projectTool } from '../modules/ui-system/agent-workbench-projections.js';

const store = createWorkbenchStore();
store.dispatch({ type: 'session.created', sessionId: 's1', sequence: 1, payload: { model: 'm1' } });
store.dispatch({ type: 'turn.started', sessionId: 's1', turnId: 't1', sequence: 2, payload: { prompt: 'hello' } });
store.dispatch({ type: 'assistant.started', sessionId: 's1', turnId: 't1', sequence: 3, payload: {} });
store.dispatch({ type: 'assistant.delta', sessionId: 's1', turnId: 't1', sequence: 4, payload: { text: 'hel' } });
store.dispatch({ type: 'assistant.delta', sessionId: 's1', turnId: 't1', sequence: 5, payload: { text: 'lo' } });
assert.equal(store.getState().messages.find((message) => message.role === 'assistant').content, 'hello');

store.dispatch({
    type: 'tool.requested', sessionId: 's1', turnId: 't1', toolCallId: 'tc1', sequence: 6,
    payload: { toolName: 'vcp_invoke', argumentSummary: 'FileOperator.ReadFile README.md' },
});
store.dispatch({
    type: 'tool.completed', sessionId: 's1', turnId: 't1', toolCallId: 'tc1', sequence: 7,
    payload: { toolName: 'vcp_invoke', outputSummary: 'done' },
});
const tool = projectTool(store.getState().tools.get('tc1'));
assert.equal(tool.name, 'vcp_invoke');
assert.equal(tool.state, 'completed');
assert.equal(tool.eventCount, 2);

store.dispatch({
    type: 'approval.requested', sessionId: 's1', turnId: 't1', approvalId: 'a1', sequence: 8,
    payload: { approval: { approvalId: 'a1', toolName: 'vcp_invoke' } },
});
assert.equal(store.getState().approvals.length, 1);
store.dispatch({ type: 'approval.resolved', sessionId: 's1', approvalId: 'a1', sequence: 9, payload: {} });
assert.equal(store.getState().approvals.length, 0);

store.dispatch({ type: 'context.usage', sessionId: 's1', sequence: 10, payload: { usedTokens: 500, contextWindow: 1000 } });
assert.equal(store.getState().context.percentage, 50);
store.dispatch({ type: 'turn.completed', sessionId: 's1', turnId: 't1', sequence: 11, payload: {} });
assert.equal(store.getState().activeTurnId, null);

const messageCount = store.getState().messages.length;
store.dispatch({ type: 'assistant.delta', sessionId: 's1', turnId: 't1', sequence: 5, payload: { text: 'lo' } });
assert.equal(store.getState().messages.length, messageCount, 'replayed events must be deduplicated');
assert.equal(store.getState().messages.find((message) => message.role === 'assistant').content, 'hello');
store.dispatch({ type: 'assistant.delta', sessionId: 'other', turnId: 't2', sequence: 12, payload: { text: 'ignore' } });
assert.equal(store.getState().messages.length, messageCount, 'events from inactive sessions must be filtered');

const calls = [];
let liveEvent;
const controller = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({ state: 'ready', pendingApprovals: [] }),
    agentRuntimeListSessions: async () => ({ sessions: [{ sessionId: 'restored' }] }),
    agentRuntimeGetSession: async (payload) => { calls.push(['session', payload]); return { sessionId: payload.sessionId }; },
    agentRuntimeGetMessages: async (payload) => { calls.push(['messages', payload]); return { messages: [] }; },
    agentRuntimeGetEvents: async (payload) => { calls.push(['events', payload]); return { events: [] }; },
    agentRuntimeSetWorkbenchPresence() {},
    onAgentRuntimeEvent(callback) { liveEvent = callback; return () => {}; },
});
await controller.initialize();
assert.equal(typeof liveEvent, 'function');
assert.deepEqual(calls.find(([name]) => name === 'messages')[1], { sessionId: 'restored' });
assert.deepEqual(calls.find(([name]) => name === 'events')[1], { sessionId: 'restored', sinceSequence: 0 });
controller.dispose();

console.log('Agent Workbench store/reducer/controller projection tests passed.');
