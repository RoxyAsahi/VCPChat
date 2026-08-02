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
        runtime: 'codex',
        ...event,
    });
}

// Selection and runtime ownership are separate: the selected Session controls
// only the visible projection, while activeRuntimes owns process state.
store.selectSession({ sessionId: 's1', topicId: 'topic-1', state: 'idle' });
store.setState({ activeRuntimes: new Map([['s1', { sessionId: 's1', topicId: 'topic-1', state: 'idle' }]]) });
store.setState({ runtime: { state: 'ready', worker: null, lastError: null } });
assert.equal(deriveWorkbenchViewState(store.getState()), 'idle', 'an idle Session Runtime must enable the composer');
assert.equal('sessions' in store.getState(), false);
assert.equal('artifacts' in store.getState(), false);

const previewOnlyStore = createWorkbenchStore();
previewOnlyStore.setState({
    runtime: { state: 'ready', worker: null, lastError: null },
    selectedTopic: { topicId: 'preview-only-topic', mode: 'preview' },
});
assert.equal(deriveWorkbenchViewState(previewOnlyStore.getState()), 'idle',
    'a ready control process must keep an idle Session preview send-capable until send-time runtime startup');

const concurrentApprovalStore = createWorkbenchStore();
concurrentApprovalStore.setState({
    runtime: { state: 'ready', worker: null, lastError: null },
    selectedTopic: { topicId: 'topic-b', mode: 'preview' },
    approvals: [{ approvalId: 'approval-a', topicId: 'topic-a', sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'tool-a' }],
});
assert.equal(deriveWorkbenchViewState(concurrentApprovalStore.getState()), 'idle',
    'a local approval in Topic A must not disable Topic B composer');
concurrentApprovalStore.setState({
    selectedSessionId: 'topic-a',
    selectedTopic: { topicId: 'topic-a', mode: 'runtime-active' },
    activeRuntimes: new Map([['session-a', { sessionId: 'session-a', topicId: 'topic-a', state: 'idle' }]]),
});
assert.equal(deriveWorkbenchViewState(concurrentApprovalStore.getState()), 'awaiting-approval',
    'the approval-owning Session must remain paused until Codex resolves it');

const usageStore = createWorkbenchStore();
usageStore.selectSession({ sessionId: 'usage-session', topicId: 'usage-topic', state: 'idle' });
usageStore.dispatch({ eventId: 'usage-unknown', sequence: 1, timestamp: 1, sessionId: 'usage-session', topicId: 'usage-topic', type: 'context.usage', runtime: 'codex', payload: { totalTokens: 123 } });
assert.equal(usageStore.getState().context.source, 'unknown');
assert.equal(usageStore.getState().context.usageAvailable, false,
    'token-shaped data without explicit provenance must never be displayed as real usage');
usageStore.dispatch({ eventId: 'usage-estimate', sequence: 2, timestamp: 2, sessionId: 'usage-session', topicId: 'usage-topic', type: 'context.usage', runtime: 'codex', payload: { source: 'estimated', totalTokens: 123 } });
assert.equal(usageStore.getState().context.usageAvailable, true);
assert.equal(usageStore.getState().context.source, 'estimated');

const activityStore = createWorkbenchStore();
activityStore.selectSession({ sessionId: 'activity-session', topicId: 'activity-topic', state: 'idle' });
activityStore.dispatch({ eventId: 'activity-1', sequence: 1, timestamp: 1, sessionId: 'activity-session', topicId: 'activity-topic', type: 'toolbox.ws', runtime: 'codex', payload: { kind: 'notification', value: 'one' } });
activityStore.dispatch({ eventId: 'activity-2', sequence: 2, timestamp: 2, sessionId: 'activity-session', topicId: 'activity-topic', type: 'marker.observed', runtime: 'codex', payload: { kind: 'vcpinfo', summary: 'two' } });
assert.equal(activityStore.getState().activityUnread, 2, 'activity observations must increment a bounded Renderer-only unread cursor');

const compactStore = createWorkbenchStore();
compactStore.selectSession({ sessionId: 'compact-session', topicId: 'compact-topic', state: 'idle' });
compactStore.dispatch({ eventId: 'compact-start', sequence: 1, timestamp: 1, sessionId: 'compact-session', topicId: 'compact-topic', type: 'compaction.started', runtime: 'codex', payload: {} });
assert.equal(compactStore.getState().context.compacting, true,
    'Codex runtime compaction.started must drive the Workbench state rather than only legacy context.compaction.* names');
compactStore.dispatch({ eventId: 'compact-done', sequence: 2, timestamp: 2, sessionId: 'compact-session', topicId: 'compact-topic', type: 'compaction.completed', runtime: 'codex', payload: { summary: 'checkpoint reconciled' } });
assert.deepEqual(compactStore.getState().context.compactionState, 'completed');

// R3-C: the Renderer may show an accepted command immediately, but it must
// replace that temporary projection with the Runtime event identity rather
// than grow a second transcript or guess a durable message id.
const deliveryStore = createWorkbenchStore();
deliveryStore.selectSession({ sessionId: 'delivery-session', topicId: 'delivery-topic', state: 'idle' });
deliveryStore.addPendingUserMessage({ turnId: 'delivery-turn', prompt: '请先显示我，再等待 Codex 确认', createdAt: 123 });
assert.deepEqual(deliveryStore.getState().messages, [{
    id: 'pending-user:delivery-turn', turnId: 'delivery-turn', role: 'user',
    content: '请先显示我，再等待 Codex 确认', attachments: [], state: 'pending', deliveryState: 'sending',
    deliveryDetail: '正在等待 Codex App Server 确认…', createdAt: 123,
    firstSequence: null, lastSequence: null,
}]);
deliveryStore.dispatch({
    eventId: 'runtime-turn-started', sequence: 1, timestamp: 124, runtime: 'codex',
    sessionId: 'delivery-session', topicId: 'delivery-topic', turnId: 'delivery-turn',
    messageId: 'msg_delivery-turn_user',
    type: 'turn.started', payload: { prompt: '请先显示我，再等待 Codex 确认' },
});
assert.deepEqual(deliveryStore.getState().messages, [{
    id: 'msg_delivery-turn_user', messageId: 'msg_delivery-turn_user', turnId: 'delivery-turn', role: 'user',
    content: '请先显示我，再等待 Codex 确认', attachments: [], state: 'complete', deliveryState: 'confirmed',
    deliveryDetail: '', createdAt: 124,
    firstSequence: 1, lastSequence: 1,
}], 'turn.started must confirm and replace the temporary user item');
deliveryStore.addPendingUserMessage({ turnId: 'delivery-crash', prompt: '可能已经到达 App Server', createdAt: 125 });
deliveryStore.dispatch({
    eventId: 'runtime-crashed', sequence: 2, timestamp: 126, runtime: 'codex', sessionId: 'runtime',
    topicId: 'runtime', type: 'runtime.crashed', payload: { error: 'pipe closed' },
});
assert.equal(deliveryStore.getState().messages.at(-1).deliveryState, 'unconfirmed',
    'a broken pipe must not claim failure or auto-replay a command whose durable outcome is unknown');
const missingAssetStore = createWorkbenchStore();
missingAssetStore.selectSession({ sessionId: 'asset-session', topicId: 'asset-topic', state: 'idle' });
missingAssetStore.addPendingUserMessage({
    turnId: 'asset-turn', prompt: '', attachments: [{ id: 'attachment-missing', displayName: '缺失.png' }], createdAt: 126,
});
missingAssetStore.dispatch({
    eventId: 'asset-missing', sequence: 1, timestamp: 127, runtime: 'codex',
    sessionId: 'asset-session', topicId: 'asset-topic', turnId: 'asset-turn',
    type: 'turn.failed',
    payload: { code: 'attachment-unavailable', error: '附件文件不可用或已损坏；请重新选择附件后再发送。' },
});
assert.equal(missingAssetStore.getState().messages[0].deliveryState, 'failed',
    'a missing durable attachment must be distinct from an interrupted model turn');
assert.match(missingAssetStore.getState().messages[0].deliveryDetail, /重新选择附件/);
deliveryStore.dispatch({
    eventId: 'assistant-part-one', sequence: 3, timestamp: 127, runtime: 'codex',
    sessionId: 'delivery-session', topicId: 'delivery-topic', turnId: 'delivery-turn',
    messageId: 'assistant-part-one', type: 'assistant.started', payload: {},
});
deliveryStore.dispatch({
    eventId: 'assistant-part-two', sequence: 4, timestamp: 128, runtime: 'codex',
    sessionId: 'delivery-session', topicId: 'delivery-topic', turnId: 'delivery-turn',
    messageId: 'assistant-part-two', type: 'assistant.started', payload: {},
});
assert.equal(deliveryStore.getState().messages.filter((message) => message.role === 'assistant').length, 2,
    'distinct Runtime message ids in one turn must remain distinct timeline items');

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
assert.equal(store.getState().tools.get('tc1').firstSequence, 6, 'tool timeline position must come from the first Runtime event');
assert.equal(store.getState().tools.get('tc1').lastSequence, 7, 'tool updates must not rewrite the first timeline position');

dispatch({ type: 'approval.requested', sessionId: 's1', turnId: 't1', toolCallId: 'tool-1', approvalId: 'a1', sequence: 8, payload: { approval: { approvalId: 'a1', toolName: 'vcp_invoke', argumentsHash: 'hash-1', expiresAtMs: 1234 } } });
assert.equal(store.getState().approvals.length, 1);
assert.deepEqual(store.getState().approvals[0], {
    approvalId: 'a1', toolName: 'vcp_invoke', argumentsHash: 'hash-1', expiresAtMs: 1234,
    topicId: 'topic-1', sessionId: 's1', turnId: 't1', toolCallId: 'tool-1',
});
dispatch({ type: 'approval.resolved', sessionId: 's1', approvalId: 'a1', sequence: 9, payload: {} });
assert.equal(store.getState().approvals.length, 0);

dispatch({ type: 'context.usage', sessionId: 's1', sequence: 10, payload: { usedTokens: 500, contextWindow: 1000 } });
assert.equal(store.getState().context.percentage, 50);
dispatch({ type: 'context.compaction.started', sessionId: 's1', turnId: 't1', sequence: 11, payload: {} });
assert.equal(store.getState().context.compacting, true, 'store must use the Runtime dot-form compaction event name');
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
    toolbox: { state: 'checking', detail: 'Main readiness check' },
} });
dispatch({ type: 'runtime.readiness', sessionId: 'runtime', sequence: 14, payload: {
    toolbox: { state: 'ready', detail: 'authenticated probe' },
    capability: { state: 'unknown', detail: 'awaiting VCPLog' },
} });
assert.equal(store.getState().readiness.server.state, 'configured', 'readiness must be Main-projected instead of renderer-probed');
assert.equal(store.getState().readiness.toolbox.state, 'ready', 'incremental Runtime readiness must merge by subsystem');
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
store.dispatch({ eventId: 'event-5', type: 'assistant.delta', sessionId: 's1', topicId: 'topic-1', turnId: 't1', messageId: 'assistant-1', sequence: 5, timestamp: 1_700_000_000_005, runtime: 'codex', payload: { text: 'lo' } });
assert.equal(store.getState().messages.length, messageCount, 'eventId is the only replay key');
dispatch({ type: 'assistant.delta', sessionId: 'other', turnId: 't2', messageId: 'assistant-2', sequence: 13, payload: { text: 'ignore' } });
assert.equal(store.getState().messages.length, messageCount, 'events from inactive sessions must be filtered');
store.dispatch({ type: 'assistant.delta', sessionId: 's1', topicId: 'topic-1', turnId: 't1', sequence: 14, timestamp: 1_700_000_000_014, runtime: 'codex', payload: { text: 'invalid' } });
assert.equal(store.getState().messages.length, messageCount, 'missing Runtime event identity is fail-closed');

const calls = [];
let liveEvent;
let resolveInitialRead;
const pendingInteraction = {
    source: 'toolbox', requestId: 'same-id', sessionId: null, threadId: null,
    turnId: null, kind: 'backend-approval', state: 'pending', createdAt: 1,
};
const controller = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({
        state: 'ready',
        runtimes: [{ sessionId: 'restored', topicId: 'topic-restored', state: 'idle' }],
        pendingInteractions: [pendingInteraction],
    }),
    agentRuntimeReadTopic: async (payload) => {
        calls.push(['topic', payload]);
        return new Promise((resolve) => { resolveInitialRead = resolve; });
    },
    agentRuntimeSetWorkbenchPresence() {},
    onAgentRuntimeEvent(callback) { liveEvent = callback; return () => {}; },
});
controller.store.selectSession({ sessionId: 'restored', topicId: 'topic-restored', state: 'idle' });
const initializing = controller.initialize();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(controller.store.getState().interactions, [pendingInteraction],
    'Activity Center must receive Main-owned interaction identities independently of approval cards');
assert.equal(typeof liveEvent, 'function', 'Renderer must subscribe before it starts reading a Session projection');
assert.deepEqual(calls.find(([name]) => name === 'topic')[1], { topicId: 'topic-restored' });
liveEvent({
    eventId: 'initial-live-event', sequence: 5, timestamp: 5, runtime: 'codex',
    sessionId: 'restored', topicId: 'topic-restored', turnId: 'turn-restored',
    messageId: 'assistant-live', type: 'assistant.delta', payload: { text: 'snapshot 期间的 live delta' },
});
liveEvent({
    eventId: 'initial-readiness-event', sequence: 6, timestamp: 6, runtime: 'codex',
    sessionId: 'restored', topicId: 'topic-restored', type: 'runtime.readiness',
    payload: { toolbox: { state: 'unavailable', detail: 'Main readiness settled during snapshot' } },
});
resolveInitialRead({
    topicId: 'topic-restored', snapshotSequence: 4,
    state: { title: '恢复的 Codex Session 标题', model: 'gpt-5.6-terra', workspaceRef: 'C:\\workspace\\restored' },
    history: [
        { id: 'history-1', role: 'assistant', content: '来自 Codex Session', snapshotOrdinal: 0 },
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
assert.equal(controller.store.getState().messages[0].content, '来自 Codex Session');
assert.equal(controller.store.getState().selectedTopic.title, '恢复的 Codex Session 标题',
    'snapshot-first hydration must promote durable metadata into the selected Session projection');
assert.equal(controller.store.getState().selectedTopic.workspaceRoot, 'C:\\workspace\\restored');
const restoredTool = controller.store.getState().tools.get('call-restored');
assert.equal(restoredTool?.name, 'FileOperator', 'read-topic must rebuild tool artifacts from the Codex projection');
assert.equal(restoredTool?.payload.resources[0].name, 'package.json');
assert.equal(restoredTool?.snapshotOrdinal, 1);
assert.ok(controller.store.getState().messages.some((message) => message.id === 'assistant-live'),
    'a live event arriving during initial read-topic must be buffered and projected after the snapshot');
assert.equal(controller.store.getState().readiness.toolbox.state, 'unavailable',
    'process-global readiness must survive a Session-less snapshot barrier instead of remaining at checking');
// An App Server crash is global, not a transcript event. It must still reach the
// currently previewed Session when an active Runtime has a different
// identity, otherwise the user sees a silently disabled composer with no
// reconnect affordance.
controller.store.setState({ selectedTopic: { topicId: 'previewed-other-topic', mode: 'preview' } });
liveEvent({
    eventId: 'runtime-crash-on-other-topic', sequence: 7, timestamp: 7, runtime: 'vcpchat',
    sessionId: 'runtime', topicId: 'topic-restored', type: 'runtime.crashed', payload: { error: 'pipe closed' },
});
assert.equal(controller.store.getState().runtime.state, 'failed',
    'process-global crash diagnostics must not be discarded as a foreign Session event');
controller.store.setState({ approvals: [{ approvalId: 'approval-live', toolName: 'PowerShellExecutor' }] });
await controller.refreshStatus();
assert.equal(controller.store.getState().approvals.length, 1,
    'a Main status response without an approval list must not erase Renderer approval projection');
controller.dispose();

// A switch/reconnect runs as a snapshot transaction. Events that arrive while
// read-topic is in flight are buffered; only events newer than the projection
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
const sessionRuntime = { sessionId: 'switch-session', topicId: 'switch-topic', state: 'idle' };
const hydrating = switching.hydrateTopic(sessionRuntime.topicId, sessionRuntime);
switchEvent({ eventId: 'old-event', sequence: 4, timestamp: 4, runtime: 'codex', sessionId: sessionRuntime.sessionId, topicId: sessionRuntime.topicId, turnId: 'turn-1', messageId: 'old-message', type: 'assistant.delta', payload: { text: 'stale' } });
switchEvent({ eventId: 'new-event', sequence: 5, timestamp: 5, runtime: 'codex', sessionId: sessionRuntime.sessionId, topicId: sessionRuntime.topicId, turnId: 'turn-1', messageId: 'new-message', type: 'assistant.delta', payload: { text: 'live' } });
deferredRead({ topicId: sessionRuntime.topicId, snapshotSequence: 4, history: [{ id: 'checkpoint-message', role: 'assistant', content: 'checkpoint' }] });
await hydrating;
assert.ok(switching.store.getState().messages.some((message) => message.content === 'checkpoint'), 'snapshot must become the base projection');
assert.ok(switching.store.getState().messages.some((message) => message.id === 'new-message'), 'newer buffered events must follow the snapshot');
assert.equal(switching.store.getState().messages.some((message) => message.id === 'old-message'), false, 'stale events must not be replayed after snapshot restore');
switching.dispose();

// A fresh Topic is a valid no-checkpoint state.  The renderer must still own
// the live Session identity when the first
// read-topic call says that no snapshot has been committed yet.
const fresh = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({ state: 'ready', pendingApprovals: [] }),
    agentRuntimeCreateSession: async () => ({ sessionId: 'fresh-session', topicId: 'fresh-topic', state: 'idle' }),
    agentRuntimeReadTopic: async () => { throw new Error('Topic has no checkpoint yet'); },
});
await fresh.createSession();
assert.equal(fresh.store.getState().selectedSessionId, null,
    'a failed first snapshot must not invent a selected writable Session');
assert.deepEqual(fresh.store.getState().messages, [], 'a fresh Topic must not receive a fabricated JS transcript');
fresh.dispose();

// Cherry-style selection is snapshot-only.  The first send is the sole point
// where the controller asks Main to start or resume the selected Runtime.
const previewCalls = [];
const preview = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({ state: 'ready', pendingApprovals: [] }),
    agentRuntimeReadTopic: async ({ topicId }) => ({ topicId, snapshotSequence: 0, history: [{ id: 'preview-history', role: 'assistant', content: 'preview only' }] }),
    agentRuntimeCreateSession: async (payload) => {
        previewCalls.push(['runtime', payload]);
        return { sessionId: 'preview-session', topicId: payload.resume, state: 'idle' };
    },
    agentRuntimeStartTurn: async (payload) => {
        previewCalls.push(['turn', payload]);
        return { turnId: 'preview-turn' };
    },
});
await preview.previewTopic('preview-topic', 'Nova', { title: 'Preview', model: 'gpt-5.6-terra' });
assert.equal(previewCalls.length, 0, 'selecting a Session must not start its Runtime');
assert.equal(preview.store.getState().selectedTopic.mode, 'preview');
assert.equal(preview.store.getState().messages[0].content, 'preview only');
await preview.startTurn('继续这个任务');
assert.equal(previewCalls[0][0], 'runtime', 'first send must start the selected Session Runtime before issuing a turn');
assert.equal(previewCalls[0][1].resume, 'preview-topic');
assert.equal(previewCalls[1][0], 'turn');
assert.equal(previewCalls[1][1].sessionId, 'preview-session');
preview.dispose();

// Codex selection remains projection-only. The first send begins exactly one
// demand-driven Thread ensure and awaits it before turn/start.
const warmCalls = [];
let resolveWarm;
const warming = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({
        state: 'ready', pendingApprovals: [],
        runtimes: [{ sessionId: 'warm-session', topicId: 'warm-session', activity: 'idle' }],
    }),
    agentRuntimeReadProjection: async ({ topicId }) => ({
        session: { sessionId: topicId, agentId: 'Nova', title: 'Warm' }, messages: [],
    }),
    agentRuntimeReadTopic: async ({ topicId }) => ({
        session: { sessionId: topicId, agentId: 'Nova', title: 'Warm' }, messages: [],
    }),
    agentRuntimeEnsureSessionRuntime: (payload) => {
        warmCalls.push(payload);
        return new Promise((resolve) => { resolveWarm = resolve; });
    },
    agentRuntimeStartTurn: async (payload) => ({ ...payload, turnId: 'warm-turn' }),
});
await warming.previewTopic('warm-session', 'Nova', { title: 'Warm' });
await Promise.resolve();
assert.equal(warmCalls.length, 0, 'selection must not start or resume a Codex Thread');
const warmSend = warming.startTurn('发送时按需启动');
await Promise.resolve();
assert.equal(warmCalls.length, 1, 'send must begin one demand-driven Session Runtime ensure');
resolveWarm({ sessionId: 'warm-session', topicId: 'warm-session', threadId: 'warm-thread' });
const warmAccepted = await warmSend;
assert.equal(warmAccepted.turnId, 'warm-turn');
warming.dispose();

// Codex cold-open has two distinct reads: projection-only SQLite is the
// awaited navigation path, while App Server reconciliation is detached.  A
// late reconciliation for A must not overwrite a newer selection B.
const coldCalls = [];
let resolveSqliteA;
let resolveThreadA;
let resolveThreadB;
const cold = createWorkbenchController({
    agentRuntimeReadProjection: ({ topicId }) => {
        coldCalls.push(['sqlite', topicId]);
        if (topicId === 'topic-a') return new Promise((resolve) => { resolveSqliteA = resolve; });
        return Promise.resolve({
            session: { agentId: 'Nova', title: 'SQLite B' },
            messages: [{ messageId: 'sqlite-b', itemId: 'item-b', role: 'assistant', status: 'completed', blocks: [{ blockId: 'b:0', kind: 'message', content: { text: 'SQLite B' } }] }],
        });
    },
    agentRuntimeReadTopic: ({ topicId }) => {
        coldCalls.push(['thread', topicId]);
        if (topicId === 'topic-a') return new Promise((resolve) => { resolveThreadA = resolve; });
        return new Promise((resolve) => { resolveThreadB = resolve; });
    },
});
const openingA = cold.previewTopic('topic-a', 'Nova', { title: 'A' });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(coldCalls, [['sqlite', 'topic-a']], 'cold navigation must not wait for thread/read');
resolveSqliteA({
    session: { agentId: 'Nova', title: 'SQLite A' },
    messages: [{ messageId: 'sqlite-a', itemId: 'item-a', role: 'assistant', status: 'completed', blocks: [{ blockId: 'a:0', kind: 'message', content: { text: 'SQLite A' } }] }],
});
await openingA;
assert.equal(cold.store.getState().messages[0].content, 'SQLite A', 'SQLite projection is the visible cold-open result');
await new Promise((resolve) => setImmediate(resolve));
assert.ok(coldCalls.some(([kind, topicId]) => kind === 'thread' && topicId === 'topic-a'), 'thread/read starts only after SQLite has rendered');
await cold.previewTopic('topic-b', 'Nova', { title: 'B' });
assert.equal(cold.store.getState().messages[0].content, 'SQLite B');
resolveThreadA({
    session: { agentId: 'Nova', title: 'stale Thread A' },
    messages: [{ messageId: 'thread-a', itemId: 'item-a', role: 'assistant', status: 'completed', blocks: [{ blockId: 'a:0', kind: 'message', content: { text: 'must not replace B' } }] }],
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(cold.store.getState().selectedTopic.topicId, 'topic-b');
assert.equal(cold.store.getState().messages[0].content, 'SQLite B', 'late A reconciliation must not overwrite B');
resolveThreadB({ session: { agentId: 'Nova', title: 'Thread B' }, messages: [] });
cold.dispose();

const hydrateCalls = [];
let resolveHydrateSqlite;
let resolveHydrateThread;
const hydratedCodex = createWorkbenchController({
    agentRuntimeReadProjection: () => {
        hydrateCalls.push('sqlite');
        return new Promise((resolve) => { resolveHydrateSqlite = resolve; });
    },
    agentRuntimeReadTopic: () => {
        hydrateCalls.push('thread');
        return new Promise((resolve) => { resolveHydrateThread = resolve; });
    },
});
const openingAttached = hydratedCodex.hydrateTopic('attached-topic', {
    sessionId: 'attached-session', topicId: 'attached-topic', agentId: 'Nova', title: 'Runtime shell', state: 'idle',
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(hydrateCalls, ['sqlite'], 'an attached Codex Session must also open from SQLite before thread/read');
resolveHydrateSqlite({
    session: { agentId: 'Nova', title: 'SQLite attached' },
    messages: [{ messageId: 'attached-message', itemId: 'attached-item', role: 'assistant', status: 'completed', blocks: [{ blockId: 'attached:0', kind: 'message', content: { text: 'attached SQLite projection' } }] }],
});
await openingAttached;
assert.equal(hydratedCodex.store.getState().messages[0].content, 'attached SQLite projection');
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(hydrateCalls, ['sqlite', 'thread']);
resolveHydrateThread({ session: { agentId: 'Nova', title: 'Thread attached' }, messages: [] });
hydratedCodex.dispose();

let liveGuardEvent;
let resolveLiveGuardThread;
const liveGuard = createWorkbenchController({
    agentRuntimeReadProjection: async () => ({
        session: { agentId: 'Nova', title: 'SQLite live guard' },
        messages: [{ messageId: 'sqlite-guard', itemId: 'item-guard', role: 'assistant', status: 'completed', blocks: [{ blockId: 'guard:0', kind: 'message', content: { text: 'SQLite base' } }] }],
    }),
    agentRuntimeReadTopic: async () => new Promise((resolve) => { resolveLiveGuardThread = resolve; }),
    onAgentRuntimeEvent(callback) { liveGuardEvent = callback; return () => {}; },
});
liveGuard.subscribeRuntime();
await liveGuard.previewTopic('live-guard-topic', 'Nova');
liveGuardEvent({
    runtime: 'codex', type: 'projection.updated', topicId: 'live-guard-topic', sessionId: 'live-guard-session',
    threadId: 'thread-live-guard', turnId: 'turn-live-guard', activity: 'running',
    projectionMessage: {
        messageId: 'live-guard-message', itemId: 'live-guard-item', turnId: 'turn-live-guard', role: 'assistant', status: 'inProgress',
        blocks: [{ blockId: 'live-guard:0', kind: 'message', content: { text: 'live delta must survive' } }],
    },
});
resolveLiveGuardThread({
    session: { agentId: 'Nova', title: 'stale thread result' },
    messages: [{ messageId: 'stale-guard-message', itemId: 'stale-guard-item', role: 'assistant', status: 'completed', blocks: [{ blockId: 'stale-guard:0', kind: 'message', content: { text: 'must not replace live delta' } }] }],
});
await new Promise((resolve) => setImmediate(resolve));
assert.ok(liveGuard.store.getState().messages.some((message) => message.content === 'live delta must survive'),
    'a late thread/read snapshot must not overwrite a newer live projection patch');
assert.equal(liveGuard.store.getState().messages.some((message) => message.content === 'must not replace live delta'), false);
liveGuard.dispose();

// Codex emits the durable user item asynchronously. It must reconcile the
// renderer-only pending row by turn id instead of leaving two identical user
// messages in the timeline.
let duplicateGuardEvent;
const duplicateGuard = createWorkbenchController({
    agentRuntimeStartTurn: async () => ({ turnId: 'codex-turn-1' }),
    onAgentRuntimeEvent(callback) { duplicateGuardEvent = callback; return () => {}; },
});
duplicateGuard.store.setState({
    selectedSessionId: 'codex-topic',
    selectedTopic: { topicId: 'codex-topic', mode: 'runtime-active' },
    activeRuntimes: new Map([['codex-topic', { sessionId: 'codex-topic', topicId: 'codex-topic', state: 'idle' }]]),
});
duplicateGuard.subscribeRuntime();
await duplicateGuard.startTurn('只显示一次');
assert.equal(duplicateGuard.store.getState().messages.filter((message) => message.role === 'user').length, 1,
    'turn acceptance may show one temporary user row');
duplicateGuardEvent({
    runtime: 'codex', type: 'projection.updated', topicId: 'codex-topic', sessionId: 'codex-topic',
    turnId: 'codex-turn-1', activity: 'running',
    projectionMessage: {
        messageId: 'durable-user-message', itemId: 'durable-user-item', turnId: 'codex-turn-1',
        role: 'user', status: 'completed',
        blocks: [{ blockId: 'durable-user-block', kind: 'message', content: { parts: [{ text: '只显示一次' }] } }],
    },
});
const reconciledUserMessages = duplicateGuard.store.getState().messages.filter((message) => message.role === 'user');
assert.equal(reconciledUserMessages.length, 1,
    'the App Server user item must replace—not append to—the temporary row');
assert.equal(reconciledUserMessages[0].id, 'durable-user-block');
assert.equal(reconciledUserMessages[0].deliveryState, 'confirmed');
duplicateGuard.dispose();

console.log('Agent Workbench store/reducer/controller projection tests passed.');
