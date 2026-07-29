import assert from 'node:assert/strict';
import { createWorkbenchController } from '../modules/ui-system/agent-workbench-controller.js';
import { createWorkbenchStore, deriveWorkbenchViewState } from '../modules/ui-system/agent-workbench-store.js';
import { projectTool } from '../modules/ui-system/agent-workbench-projections.js';

const store = createWorkbenchStore();
let eventNumber = 0;
function dispatch(event) {
    eventNumber += 1;
    store.dispatch({
        eventId: `event-${eventNumber}`,
        topicId: 'topic-1',
        timestamp: 1_700_000_000_000 + eventNumber,
        runtime: 'rust',
        ...event,
    });
}

// R2: an attachment is transient UI state; Topic history is separately read
// from Rust. The store no longer has a session list or artifact cache.
store.setAttachment({ sessionId: 's1', topicId: 'topic-1', state: 'idle' });
store.setState({ runtime: { state: 'ready', worker: null, lastError: null } });
assert.equal(deriveWorkbenchViewState(store.getState()), 'idle', 'a daemon-created idle attachment must enable the composer');
assert.equal('sessions' in store.getState(), false);
assert.equal('artifacts' in store.getState(), false);

dispatch({ type: 'session.created', sessionId: 's1', sequence: 1, payload: { model: 'm1' } });
dispatch({ type: 'turn.started', sessionId: 's1', turnId: 't1', sequence: 2, payload: { prompt: 'hello' } });
dispatch({ type: 'assistant.started', sessionId: 's1', turnId: 't1', messageId: 'assistant-1', sequence: 3, payload: {} });
dispatch({ type: 'assistant.delta', sessionId: 's1', turnId: 't1', messageId: 'assistant-1', sequence: 4, payload: { text: 'hel' } });
dispatch({ type: 'assistant.delta', sessionId: 's1', turnId: 't1', messageId: 'assistant-1', sequence: 5, payload: { text: 'lo' } });
assert.equal(store.getState().messages.find((message) => message.role === 'assistant').content, 'hello');

dispatch({ type: 'tool.requested', sessionId: 's1', turnId: 't1', toolCallId: 'tc1', sequence: 6, payload: { toolName: 'vcp_invoke', argumentSummary: 'FileOperator.ReadFile README.md' } });
dispatch({ type: 'tool.completed', sessionId: 's1', turnId: 't1', toolCallId: 'tc1', sequence: 7, payload: { toolName: 'vcp_invoke', outputSummary: 'done' } });
const tool = projectTool(store.getState().tools.get('tc1'));
assert.equal(tool.name, 'vcp_invoke');
assert.equal(tool.state, 'completed');
assert.equal(tool.eventCount, 2);

dispatch({ type: 'approval.requested', sessionId: 's1', turnId: 't1', approvalId: 'a1', sequence: 8, payload: { approval: { approvalId: 'a1', toolName: 'vcp_invoke' } } });
assert.equal(store.getState().approvals.length, 1);
dispatch({ type: 'approval.resolved', sessionId: 's1', approvalId: 'a1', sequence: 9, payload: {} });
assert.equal(store.getState().approvals.length, 0);

dispatch({ type: 'context.usage', sessionId: 's1', sequence: 10, payload: { usedTokens: 500, contextWindow: 1000 } });
assert.equal(store.getState().context.percentage, 50);
dispatch({ type: 'context.compaction.started', sessionId: 's1', turnId: 't1', sequence: 11, payload: {} });
assert.equal(store.getState().context.compacting, true, 'store must use the daemon dot-form compaction event name');
dispatch({ type: 'context.compaction.completed', sessionId: 's1', turnId: 't1', sequence: 12, payload: { summary: 'checkpoint' } });
assert.equal(store.getState().context.compacting, false);
assert.equal(store.getState().context.summary, 'checkpoint');
dispatch({ type: 'turn.completed', sessionId: 's1', turnId: 't1', sequence: 11, payload: {} });
assert.equal(store.getState().activeTurnId, null);
dispatch({ type: 'toolbox.ws', sessionId: 's1', sequence: 12, payload: { channel: 'Info', kind: 'notification', value: { message: 'ToolBox 已连接' } } });
assert.deepEqual(store.getState().toolboxWs, [{ id: 'Info:notification:12', channel: 'Info', kind: 'notification', value: { message: 'ToolBox 已连接' }, timestamp: 1_700_000_000_014 }]);

const messageCount = store.getState().messages.length;
store.dispatch({ eventId: 'event-5', type: 'assistant.delta', sessionId: 's1', topicId: 'topic-1', turnId: 't1', messageId: 'assistant-1', sequence: 5, timestamp: 1_700_000_000_005, runtime: 'rust', payload: { text: 'lo' } });
assert.equal(store.getState().messages.length, messageCount, 'eventId is the only replay key');
dispatch({ type: 'assistant.delta', sessionId: 'other', turnId: 't2', messageId: 'assistant-2', sequence: 13, payload: { text: 'ignore' } });
assert.equal(store.getState().messages.length, messageCount, 'events from inactive sessions must be filtered');
store.dispatch({ type: 'assistant.delta', sessionId: 's1', topicId: 'topic-1', turnId: 't1', sequence: 14, timestamp: 1_700_000_000_014, runtime: 'rust', payload: { text: 'invalid' } });
assert.equal(store.getState().messages.length, messageCount, 'missing daemon event identity is fail-closed');

const calls = [];
let liveEvent;
let resolveInitialRead;
const controller = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({
        state: 'ready',
        attachment: { sessionId: 'restored', topicId: 'topic-restored', state: 'idle' },
    }),
    agentRuntimeReadTopic: async (payload) => {
        calls.push(['topic', payload]);
        return new Promise((resolve) => { resolveInitialRead = resolve; });
    },
    agentRuntimeSetWorkbenchPresence() {},
    onAgentRuntimeEvent(callback) { liveEvent = callback; return () => {}; },
});
const initializing = controller.initialize();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(typeof liveEvent, 'function', 'Renderer must subscribe before it starts reading a Rust Topic snapshot');
assert.deepEqual(calls.find(([name]) => name === 'topic')[1], { topicId: 'topic-restored' });
liveEvent({
    eventId: 'initial-live-event', sequence: 5, timestamp: 5, runtime: 'rust',
    sessionId: 'restored', topicId: 'topic-restored', turnId: 'turn-restored',
    messageId: 'assistant-live', type: 'assistant.delta', payload: { text: 'snapshot 期间的 live delta' },
});
resolveInitialRead({
    topicId: 'topic-restored', snapshotSequence: 4,
    history: [{ id: 'history-1', role: 'assistant', content: '来自 Rust Topic' }],
});
await initializing;
assert.equal(controller.store.getState().messages[0].content, '来自 Rust Topic');
assert.ok(controller.store.getState().messages.some((message) => message.id === 'assistant-live'),
    'a live event arriving during initial read-topic must be buffered and projected after the snapshot');
controller.store.setState({ approvals: [{ approvalId: 'approval-live', toolName: 'PowerShellExecutor' }] });
await controller.refreshStatus();
assert.equal(controller.store.getState().approvals.length, 1,
    'a Main status response without an approval list must not erase Renderer approval projection');
controller.dispose();

// A switch/reconnect runs as a snapshot transaction. Events that arrive while
// read-topic is in flight are buffered; only events newer than the daemon's
// snapshot waterline are applied after the durable history is installed.
let deferredRead;
let switchEvent;
const switching = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({ state: 'ready', pendingApprovals: [] }),
    agentRuntimeReadTopic: async () => new Promise((resolve) => { deferredRead = resolve; }),
    agentRuntimeSetWorkbenchPresence() {},
    onAgentRuntimeEvent(callback) { switchEvent = callback; return () => {}; },
});
switching.subscribeRuntime();
const attachment = { sessionId: 'switch-session', topicId: 'switch-topic', state: 'idle' };
const hydrating = switching.hydrateTopic(attachment.topicId, attachment);
switchEvent({ eventId: 'old-event', sequence: 4, timestamp: 4, runtime: 'rust', sessionId: attachment.sessionId, topicId: attachment.topicId, turnId: 'turn-1', messageId: 'old-message', type: 'assistant.delta', payload: { text: 'stale' } });
switchEvent({ eventId: 'new-event', sequence: 5, timestamp: 5, runtime: 'rust', sessionId: attachment.sessionId, topicId: attachment.topicId, turnId: 'turn-1', messageId: 'new-message', type: 'assistant.delta', payload: { text: 'live' } });
deferredRead({ topicId: attachment.topicId, snapshotSequence: 4, history: [{ id: 'checkpoint-message', role: 'assistant', content: 'checkpoint' }] });
await hydrating;
assert.ok(switching.store.getState().messages.some((message) => message.content === 'checkpoint'), 'snapshot must become the base projection');
assert.ok(switching.store.getState().messages.some((message) => message.id === 'new-message'), 'newer buffered events must follow the snapshot');
assert.equal(switching.store.getState().messages.some((message) => message.id === 'old-message'), false, 'stale events must not be replayed after snapshot restore');
switching.dispose();

// A fresh Topic is a valid no-checkpoint state.  The renderer must still own
// the live Rust attachment (and therefore enable its composer) when the first
// read-topic call says that no snapshot has been committed yet.
const fresh = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({ state: 'ready', pendingApprovals: [] }),
    agentRuntimeCreateSession: async () => ({ sessionId: 'fresh-session', topicId: 'fresh-topic', state: 'idle' }),
    agentRuntimeReadTopic: async () => { throw new Error('Topic has no checkpoint yet'); },
});
await fresh.createSession();
assert.deepEqual(fresh.store.getState().attachment, {
    sessionId: 'fresh-session', topicId: 'fresh-topic', state: 'idle',
}, 'a fresh Topic must retain the daemon attachment when no snapshot exists');
assert.deepEqual(fresh.store.getState().messages, [], 'a fresh Topic must not receive a fabricated JS transcript');
fresh.dispose();

console.log('Agent Workbench store/reducer/controller projection tests passed.');
