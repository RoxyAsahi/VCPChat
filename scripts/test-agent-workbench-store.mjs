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

const previewOnlyStore = createWorkbenchStore();
previewOnlyStore.setState({
    runtime: { state: 'ready', worker: null, lastError: null },
    selectedTopic: { topicId: 'preview-only-topic', mode: 'preview' },
});
assert.equal(deriveWorkbenchViewState(previewOnlyStore.getState()), 'idle',
    'a ready control daemon must keep an idle Topic preview send-capable until send-time attachment');

// R3-C: the Renderer may show an accepted command immediately, but it must
// replace that temporary projection with the daemon's event identity rather
// than grow a second transcript or guess a durable message id.
const deliveryStore = createWorkbenchStore();
deliveryStore.setAttachment({ sessionId: 'delivery-session', topicId: 'delivery-topic', state: 'idle' });
deliveryStore.addPendingUserMessage({ turnId: 'delivery-turn', prompt: '请先显示我，再等待 Rust 确认', createdAt: 123 });
assert.deepEqual(deliveryStore.getState().messages, [{
    id: 'pending-user:delivery-turn', turnId: 'delivery-turn', role: 'user',
    content: '请先显示我，再等待 Rust 确认', attachments: [], state: 'pending', deliveryState: 'sending',
    deliveryDetail: '正在等待 Rust Runtime 确认…', createdAt: 123,
    firstSequence: null, lastSequence: null,
}]);
deliveryStore.dispatch({
    eventId: 'daemon-turn-started', sequence: 1, timestamp: 124, runtime: 'rust',
    sessionId: 'delivery-session', topicId: 'delivery-topic', turnId: 'delivery-turn',
    messageId: 'msg_delivery-turn_user',
    type: 'turn.started', payload: { prompt: '请先显示我，再等待 Rust 确认' },
});
assert.deepEqual(deliveryStore.getState().messages, [{
    id: 'msg_delivery-turn_user', messageId: 'msg_delivery-turn_user', turnId: 'delivery-turn', role: 'user',
    content: '请先显示我，再等待 Rust 确认', attachments: [], state: 'complete', deliveryState: 'confirmed',
    deliveryDetail: '', createdAt: 124,
    firstSequence: 1, lastSequence: 1,
}], 'turn.started must confirm and replace the temporary user item');
deliveryStore.addPendingUserMessage({ turnId: 'delivery-crash', prompt: '可能已经到达 daemon', createdAt: 125 });
deliveryStore.dispatch({
    eventId: 'daemon-crashed', sequence: 2, timestamp: 126, runtime: 'rust', sessionId: 'runtime',
    topicId: 'runtime', type: 'runtime.crashed', payload: { error: 'pipe closed' },
});
assert.equal(deliveryStore.getState().messages.at(-1).deliveryState, 'unconfirmed',
    'a broken pipe must not claim failure or auto-replay a command whose durable outcome is unknown');
const missingAssetStore = createWorkbenchStore();
missingAssetStore.setAttachment({ sessionId: 'asset-session', topicId: 'asset-topic', state: 'idle' });
missingAssetStore.addPendingUserMessage({
    turnId: 'asset-turn', prompt: '', attachments: [{ id: 'attachment-missing', displayName: '缺失.png' }], createdAt: 126,
});
missingAssetStore.dispatch({
    eventId: 'asset-missing', sequence: 1, timestamp: 127, runtime: 'rust',
    sessionId: 'asset-session', topicId: 'asset-topic', turnId: 'asset-turn',
    type: 'turn.failed',
    payload: { code: 'attachment-unavailable', error: '附件文件不可用或已损坏；请重新选择附件后再发送。' },
});
assert.equal(missingAssetStore.getState().messages[0].deliveryState, 'failed',
    'a missing durable attachment must be distinct from an interrupted model turn');
assert.match(missingAssetStore.getState().messages[0].deliveryDetail, /重新选择附件/);
deliveryStore.dispatch({
    eventId: 'assistant-part-one', sequence: 3, timestamp: 127, runtime: 'rust',
    sessionId: 'delivery-session', topicId: 'delivery-topic', turnId: 'delivery-turn',
    messageId: 'assistant-part-one', type: 'assistant.started', payload: {},
});
deliveryStore.dispatch({
    eventId: 'assistant-part-two', sequence: 4, timestamp: 128, runtime: 'rust',
    sessionId: 'delivery-session', topicId: 'delivery-topic', turnId: 'delivery-turn',
    messageId: 'assistant-part-two', type: 'assistant.started', payload: {},
});
assert.equal(deliveryStore.getState().messages.filter((message) => message.role === 'assistant').length, 2,
    'distinct daemon message ids in one turn must remain distinct timeline items');

dispatch({ type: 'session.created', sessionId: 's1', sequence: 1, payload: { model: 'm1' } });
dispatch({ type: 'turn.started', sessionId: 's1', turnId: 't1', messageId: 'msg_t1_user', sequence: 2, payload: { prompt: 'hello' } });
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
assert.equal(store.getState().tools.get('tc1').firstSequence, 6, 'tool timeline position must come from the first daemon event');
assert.equal(store.getState().tools.get('tc1').lastSequence, 7, 'tool updates must not rewrite the first timeline position');

dispatch({ type: 'approval.requested', sessionId: 's1', turnId: 't1', toolCallId: 'tool-1', approvalId: 'a1', sequence: 8, payload: { approval: { approvalId: 'a1', toolName: 'vcp_invoke', argumentsHash: 'hash-1', expiresAtMs: 1234 } } });
assert.equal(store.getState().approvals.length, 1);
assert.deepEqual(store.getState().approvals[0], {
    approvalId: 'a1', toolName: 'vcp_invoke', argumentsHash: 'hash-1', expiresAtMs: 1234,
    sessionId: 's1', turnId: 't1', toolCallId: 'tool-1',
});
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
dispatch({ type: 'marker.observed', sessionId: 's1', turnId: 't1', messageId: 'assistant-1', sequence: 12, payload: { kind: 'dynamic-fold', summary: '安全摘要', detail: '只在展开时显示的正文' } });
assert.deepEqual(store.getState().markerObservations, [{
    id: 'marker:dynamic-fold:12', kind: 'dynamic-fold', summary: '安全摘要', detail: '只在展开时显示的正文',
    messageId: 'assistant-1', turnId: 't1', timestamp: 1_700_000_000_015,
}], 'marker observations must remain a separate ephemeral projection, never a message/tool/Topic record');
dispatch({ type: 'runtime.readiness', sessionId: 'runtime', sequence: 13, payload: {
    server: { state: 'configured', detail: 'shared settings' },
    toolbox: { state: 'checking', detail: 'daemon probe' },
} });
dispatch({ type: 'runtime.readiness', sessionId: 'runtime', sequence: 14, payload: {
    toolbox: { state: 'ready', detail: 'authenticated probe' },
    capability: { state: 'unknown', detail: 'awaiting VCPLog' },
} });
assert.equal(store.getState().readiness.server.state, 'configured', 'readiness must be daemon-projected instead of renderer-probed');
assert.equal(store.getState().readiness.toolbox.state, 'ready', 'incremental daemon readiness must merge by subsystem');
assert.equal(store.getState().readiness.capability.state, 'unknown', 'capability status must not be guessed from an absent node event');
const interruptProjection = {
    messageCount: store.getState().messages.length,
    toolCount: store.getState().tools.size,
    notice: store.getState().notice,
};
dispatch({
    type: 'runtime.interrupt_result', sessionId: 's1', turnId: 't1', sequence: 15,
    payload: { accepted: true, source: 'toolbox', outcome: 'accepted' },
});
assert.deepEqual({
    messageCount: store.getState().messages.length,
    toolCount: store.getState().tools.size,
    notice: store.getState().notice,
}, interruptProjection, 'interrupt receipts are transport diagnostics and must not create transcript/tool/UI state');

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
liveEvent({
    eventId: 'initial-readiness-event', sequence: 6, timestamp: 6, runtime: 'rust',
    sessionId: 'restored', topicId: 'topic-restored', type: 'runtime.readiness',
    payload: { toolbox: { state: 'unavailable', detail: 'daemon probe settled during snapshot' } },
});
resolveInitialRead({
    topicId: 'topic-restored', snapshotSequence: 4,
    history: [
        { id: 'history-1', role: 'assistant', content: '来自 Rust Topic', snapshotOrdinal: 0 },
        {
            id: 'tool-call-restored', role: 'tool', toolCallId: 'call-restored', toolName: 'FileOperator',
            state: 'completed', timestamp: 2, snapshotOrdinal: 1,
            payload: {
                toolName: 'FileOperator', result: 'package.json',
                resources: [{ name: 'package.json', url: 'file-ref:package.json' }],
                warnings: ['只读预览'], task: { id: 'task-restored', status: 'completed' },
            },
        },
    ],
});
await initializing;
assert.equal(controller.store.getState().messages[0].content, '来自 Rust Topic');
const restoredTool = controller.store.getState().tools.get('call-restored');
assert.equal(restoredTool?.name, 'FileOperator', 'read-topic must rebuild tool artifacts from the Rust snapshot');
assert.equal(restoredTool?.payload.resources[0].name, 'package.json');
assert.equal(restoredTool?.snapshotOrdinal, 1);
assert.ok(controller.store.getState().messages.some((message) => message.id === 'assistant-live'),
    'a live event arriving during initial read-topic must be buffered and projected after the snapshot');
assert.equal(controller.store.getState().readiness.toolbox.state, 'unavailable',
    'daemon-global readiness must survive an attachment-less snapshot barrier instead of remaining at checking');
// A daemon crash is global, not a transcript event. It must still reach the
// currently previewed Topic when the writable attachment has a different
// identity, otherwise the user sees a silently disabled composer with no
// reconnect affordance.
controller.store.setState({ selectedTopic: { topicId: 'previewed-other-topic', mode: 'preview' } });
liveEvent({
    eventId: 'runtime-crash-on-other-topic', sequence: 7, timestamp: 7, runtime: 'vcpchat',
    sessionId: 'runtime', topicId: 'topic-restored', type: 'runtime.crashed', payload: { error: 'pipe closed' },
});
assert.equal(controller.store.getState().runtime.state, 'failed',
    'daemon-global crash diagnostics must not be discarded as a foreign Topic event');
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

// Cherry-style selection is snapshot-only.  The first send is the sole point
// where the controller asks Main/Rust to obtain a writable attachment.
const previewCalls = [];
const preview = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({ state: 'ready', pendingApprovals: [] }),
    agentRuntimeReadTopic: async ({ topicId }) => ({ topicId, snapshotSequence: 0, history: [{ id: 'preview-history', role: 'assistant', content: 'preview only' }] }),
    agentRuntimeCreateSession: async (payload) => {
        previewCalls.push(['attach', payload]);
        return { sessionId: 'preview-session', topicId: payload.resume, state: 'idle' };
    },
    agentRuntimeStartTurn: async (payload) => {
        previewCalls.push(['turn', payload]);
        return { turnId: 'preview-turn' };
    },
});
await preview.previewTopic('preview-topic', 'Nova', { title: 'Preview', model: 'gpt-5.6-terra' });
assert.equal(previewCalls.length, 0, 'selecting a Topic must not acquire a writable Rust attachment');
assert.equal(preview.store.getState().selectedTopic.mode, 'preview');
assert.equal(preview.store.getState().messages[0].content, 'preview only');
await preview.startTurn('继续这个任务');
assert.equal(previewCalls[0][0], 'attach', 'first send must acquire the selected Topic before issuing a turn');
assert.equal(previewCalls[0][1].resume, 'preview-topic');
assert.equal(previewCalls[1][0], 'turn');
assert.equal(previewCalls[1][1].sessionId, 'preview-session');
preview.dispose();

console.log('Agent Workbench store/reducer/controller projection tests passed.');
