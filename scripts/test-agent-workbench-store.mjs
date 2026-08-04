import assert from 'node:assert/strict';
import { createWorkbenchController as createRawWorkbenchController } from '../modules/ui-system/agent-workbench-controller.js';
import { createInitialState, createWorkbenchStore, deriveWorkbenchViewState, reduceEvent } from '../modules/ui-system/agent-workbench-store.js';
import { ROUTES, reducersForEvent } from '../modules/ui-system/agent-store/event-router.js';
import { projectSession, projectTool } from '../modules/ui-system/agent-workbench-projections.js';

function createWorkbenchController(api) {
    const topicPayload = (payload = {}) => ({ ...payload, sessionId: payload.sessionId || payload.sessionId });
    const canonicalProjection = async (reader, payload) => {
        const snapshot = await reader(topicPayload(payload));
        if (snapshot?.session?.sessionId) return snapshot;
        const sessionId = String(snapshot?.sessionId || '').trim();
        if (!sessionId) return snapshot;
        return {
            ...snapshot,
            session: {
                sessionId,
                title: snapshot?.state?.title || '',
                workspaceRoot: snapshot?.state?.workspaceRoot || snapshot?.state?.workspaceRef || '',
                configSnapshot: snapshot?.state?.configSnapshot || (snapshot?.state?.model
                    ? { model: snapshot.state.model } : null),
            },
        };
    };
    return createRawWorkbenchController({
        ...api,
        agentSessionCreate: api.agentSessionCreate || api.agentRuntimeCreateTopic || api.agentRuntimeCreateSession,
        agentSessionList: api.agentSessionList || api.agentRuntimeListTopics,
        agentSessionReadProjection: api.agentSessionReadProjection
            ? (payload) => canonicalProjection(api.agentSessionReadProjection, payload)
            : api.agentRuntimeReadProjection ? (payload) => canonicalProjection(api.agentRuntimeReadProjection, payload)
                : api.agentRuntimeReadTopic ? (payload) => canonicalProjection(api.agentRuntimeReadTopic, payload) : undefined,
        agentSessionRead: api.agentSessionRead
            ? (payload) => canonicalProjection(api.agentSessionRead, payload)
            : api.agentRuntimeReadTopic ? (payload) => canonicalProjection(api.agentRuntimeReadTopic, payload) : undefined,
        agentSessionRename: api.agentSessionRename || api.agentRuntimeRenameTopic,
        agentSessionArchive: api.agentSessionArchive || api.agentRuntimeCloseSession,
        agentSessionRestore: api.agentSessionRestore || api.agentRuntimeRestoreSession,
        agentSessionDelete: api.agentSessionDelete || api.agentRuntimePermanentlyDeleteSession,
        agentSessionFork: api.agentSessionFork || api.agentRuntimeForkSession,
        agentRuntimeEnsureSessionRuntime: api.agentRuntimeEnsureSessionRuntime || api.agentRuntimeCreateSession,
    });
}

function projectionPatch({ sessionId, threadId, revision, messageId, itemId, turnId, kind, content, sourceOrder = revision, role = 'assistant' }) {
    return {
        schemaVersion: 1, sessionId, threadId, runtimeGeneration: 1,
        baseProjectionRevision: revision - 1, projectionRevision: revision,
        upsertBlocks: [{
            schemaVersion: 2, blockId: `block:${sessionId}:${itemId}:0`, sessionId, threadId,
            turnId, itemId, messageId, kind, itemType: kind === 'tool' ? 'dynamicToolCall' : null,
            authority: kind === 'tool' ? 'toolbox' : 'codex', status: 'inProgress', sourceOrder, ordinal: 0,
            content, createdAt: revision, updatedAt: revision,
        }], deleteBlockIds: [],
    };
}

assert.equal(projectSession({ sessionId: 's-running', activeTurnId: 'turn-running' }).activity, 'running',
    'Session projection must preserve per-Session running identity for the sidebar avatar');
assert.equal(projectSession({ sessionId: 's-idle' }).activity, 'idle');

const routedEventFamilies = [
    'runtime.state_changed', 'session.created', 'turn.started', 'assistant.delta',
    'tool.requested', 'approval.requested', 'interaction.requested', 'toolbox.ws',
    'context.usage', 'plan.updated',
];
for (const type of routedEventFamilies) {
    assert.ok(reducersForEvent(type).length > 0, `${type} must have an explicit Store route`);
}
assert.equal(ROUTES.has('runtime.interrupt_result'), false,
    'transport-only diagnostics must not accidentally become a Store slice route');
const unknownBase = createInitialState();
const unknownResult = reduceEvent(unknownBase, { type: 'runtime.interrupt_result', sequence: 7 });
assert.equal(unknownResult.lastSequence, 7, 'unknown valid events retain the projection waterline');
assert.deepEqual({ ...unknownResult, lastSequence: 0 }, unknownBase,
    'unknown events must not mutate any business slice');

const store = createWorkbenchStore();
let eventNumber = 0;
function dispatch(event) {
    eventNumber += 1;
    store.dispatch({
        eventId: `event-${eventNumber}`,
        sessionId: 's1',
        timestamp: 1_700_000_000_000 + eventNumber,
        runtime: 'codex',
        ...event,
    });
}

// Selection and runtime ownership are separate: the selected Session controls
// only the visible projection, while activeRuntimes owns process state.
store.selectSession({ sessionId: 's1', state: 'idle' });
store.setState({ activeRuntimes: new Map([['s1', { sessionId: 's1', state: 'idle' }]]) });
store.setState({ runtime: { state: 'ready', worker: null, lastError: null } });
assert.equal(deriveWorkbenchViewState(store.getState()), 'idle', 'an idle Session Runtime must enable the composer');
store.setState({ activeRuntimes: new Map([['s1', {
    sessionId: 's1', state: 'ready', activity: 'running', activeTurnId: 'turn-background',
}]]) });
assert.equal(deriveWorkbenchViewState(store.getState()), 'running',
    'returning to a Session must recover its running state from the Session-keyed runtime Map');
store.setState({ activeRuntimes: new Map([['s1', { sessionId: 's1', state: 'idle' }]]) });
assert.equal('sessions' in store.getState(), false);
assert.equal('artifacts' in store.getState(), false);

const previewOnlyStore = createWorkbenchStore();
previewOnlyStore.setState({
    runtime: { state: 'ready', worker: null, lastError: null },
    selectedSessionId: 'preview-only-topic',
    selectedTopic: { sessionId: 'preview-only-topic', mode: 'preview' },
});
assert.equal(deriveWorkbenchViewState(previewOnlyStore.getState()), 'idle',
    'a ready control process must keep an idle Session preview send-capable until send-time runtime startup');

const concurrentApprovalStore = createWorkbenchStore();
concurrentApprovalStore.setState({
    runtime: { state: 'ready', worker: null, lastError: null },
    selectedSessionId: 'topic-b',
    selectedTopic: { sessionId: 'topic-b', mode: 'preview' },
    approvals: [{ approvalId: 'approval-a', sessionId: 'session-a', turnId: 'turn-a', toolCallId: 'tool-a' }],
});
assert.equal(deriveWorkbenchViewState(concurrentApprovalStore.getState()), 'idle',
    'a local approval in Topic A must not disable Topic B composer');
concurrentApprovalStore.setState({
    selectedSessionId: 'session-a',
    selectedTopic: { sessionId: 'session-a', mode: 'runtime-active' },
    activeRuntimes: new Map([['session-a', { sessionId: 'session-a', state: 'idle' }]]),
});
assert.equal(deriveWorkbenchViewState(concurrentApprovalStore.getState()), 'awaiting-approval',
    'the approval-owning Session must remain paused until Codex resolves it');

const conflictingSelectionStore = createWorkbenchStore();
conflictingSelectionStore.setState({
    runtime: { state: 'ready', worker: null, lastError: null },
    selectedSessionId: 'session-a',
    selectedTopic: { sessionId: 'session-b', agentId: 'Nova', mode: 'preview' },
});
assert.equal(deriveWorkbenchViewState(conflictingSelectionStore.getState()), 'disconnected',
    'conflicting Session identities must fail closed instead of choosing either projection');

const usageStore = createWorkbenchStore();
usageStore.selectSession({ sessionId: 'usage-session', state: 'idle' });
usageStore.dispatch({ eventId: 'usage-unknown', sequence: 1, timestamp: 1, sessionId: 'usage-session', type: 'context.usage', runtime: 'codex', payload: { totalTokens: 123 } });
assert.equal(usageStore.getState().context.source, 'unknown');
assert.equal(usageStore.getState().context.usageAvailable, false,
    'token-shaped data without explicit provenance must never be displayed as real usage');
usageStore.dispatch({ eventId: 'usage-estimate', sequence: 2, timestamp: 2, sessionId: 'usage-session', type: 'context.usage', runtime: 'codex', payload: { source: 'estimated', totalTokens: 123 } });
assert.equal(usageStore.getState().context.usageAvailable, true);
assert.equal(usageStore.getState().context.source, 'estimated');

const activityStore = createWorkbenchStore();
activityStore.selectSession({ sessionId: 'activity-session', state: 'idle' });
activityStore.dispatch({ eventId: 'activity-1', sequence: 1, timestamp: 1, sessionId: 'activity-session', type: 'toolbox.ws', runtime: 'codex', payload: { kind: 'notification', value: 'one' } });
activityStore.dispatch({ eventId: 'activity-2', sequence: 2, timestamp: 2, sessionId: 'activity-session', type: 'marker.observed', runtime: 'codex', payload: { kind: 'vcpinfo', summary: 'two' } });
assert.equal(activityStore.getState().activityUnread, 2, 'activity observations must increment a bounded Renderer-only unread cursor');

const compactStore = createWorkbenchStore();
compactStore.selectSession({ sessionId: 'compact-session', state: 'idle' });
compactStore.dispatch({ eventId: 'compact-start', sequence: 1, timestamp: 1, sessionId: 'compact-session', type: 'compaction.started', runtime: 'codex', payload: {} });
assert.equal(compactStore.getState().context.compacting, true,
    'Codex runtime compaction.started must drive the Workbench state rather than only legacy context.compaction.* names');
compactStore.dispatch({ eventId: 'compact-done', sequence: 2, timestamp: 2, sessionId: 'compact-session', type: 'compaction.completed', runtime: 'codex', payload: { summary: 'checkpoint reconciled' } });
assert.deepEqual(compactStore.getState().context.compactionState, 'completed');

// R3-C: the Renderer may show an accepted command immediately, but it must
// replace that temporary projection with the Runtime event identity rather
// than grow a second transcript or guess a durable message id.
const deliveryStore = createWorkbenchStore();
deliveryStore.selectSession({ sessionId: 'delivery-session', state: 'idle' });
deliveryStore.addPendingUserMessage({ turnId: 'delivery-turn', prompt: '请先显示我，再等待 Codex 确认', createdAt: 123 });
assert.deepEqual(deliveryStore.getState().messages, [{
    id: 'pending-user:delivery-turn', turnId: 'delivery-turn', role: 'user',
    content: '请先显示我，再等待 Codex 确认', attachments: [], state: 'pending', deliveryState: 'sending',
    deliveryDetail: '正在等待 Codex App Server 确认…', createdAt: 123,
    firstSequence: null, lastSequence: null,
}]);
deliveryStore.dispatch({
    eventId: 'runtime-turn-started', sequence: 1, timestamp: 124, runtime: 'codex',
    sessionId: 'delivery-session', turnId: 'delivery-turn',
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
    eventId: 'runtime-crashed', sequence: 2, timestamp: 126, runtime: 'codex', sessionId: 'runtime', type: 'runtime.crashed', payload: { error: 'pipe closed' },
});
assert.equal(deliveryStore.getState().messages.at(-1).deliveryState, 'unconfirmed',
    'a broken pipe must not claim failure or auto-replay a command whose durable outcome is unknown');
const missingAssetStore = createWorkbenchStore();
missingAssetStore.selectSession({ sessionId: 'asset-session', state: 'idle' });
missingAssetStore.addPendingUserMessage({
    turnId: 'asset-turn', prompt: '', attachments: [{ id: 'attachment-missing', displayName: '缺失.png' }], createdAt: 126,
});
missingAssetStore.dispatch({
    eventId: 'asset-missing', sequence: 1, timestamp: 127, runtime: 'codex',
    sessionId: 'asset-session', turnId: 'asset-turn',
    type: 'turn.failed',
    payload: { code: 'attachment-unavailable', error: '附件文件不可用或已损坏；请重新选择附件后再发送。' },
});
assert.equal(missingAssetStore.getState().messages[0].deliveryState, 'failed',
    'a missing durable attachment must be distinct from an interrupted model turn');
assert.match(missingAssetStore.getState().messages[0].deliveryDetail, /重新选择附件/);
deliveryStore.dispatch({
    eventId: 'assistant-part-one', sequence: 3, timestamp: 127, runtime: 'codex',
    sessionId: 'delivery-session', turnId: 'delivery-turn',
    messageId: 'assistant-part-one', type: 'assistant.started', payload: {},
});
deliveryStore.dispatch({
    eventId: 'assistant-part-two', sequence: 4, timestamp: 128, runtime: 'codex',
    sessionId: 'delivery-session', turnId: 'delivery-turn',
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
    sessionId: 's1', turnId: 't1', toolCallId: 'tool-1',
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
dispatch({ type: 'turn.completed', sessionId: 's1', turnId: 't1', sequence: 13, payload: {} });
assert.equal(store.getState().activeTurnId, null);
dispatch({ type: 'toolbox.ws', sessionId: 's1', sequence: 14, payload: { channel: 'Info', kind: 'notification', value: { message: 'ToolBox 已连接' } } });
assert.deepEqual(store.getState().toolboxWs, [{ id: 'Info:notification:14', channel: 'Info', kind: 'notification', value: { message: 'ToolBox 已连接' }, timestamp: 1_700_000_000_014 }]);
dispatch({ type: 'marker.observed', sessionId: 's1', turnId: 't1', messageId: 'assistant-1', sequence: 15, payload: { kind: 'dynamic-fold', summary: '安全摘要', detail: '只在展开时显示的正文' } });
assert.deepEqual(store.getState().markerObservations, [{
    id: 'marker:dynamic-fold:15', kind: 'dynamic-fold', summary: '安全摘要', detail: '只在展开时显示的正文',
    messageId: 'assistant-1', turnId: 't1', timestamp: 1_700_000_000_015,
}], 'marker observations must remain a separate ephemeral projection, never a message/tool/Topic record');
dispatch({ type: 'runtime.readiness', sessionId: 'runtime', sequence: 15, payload: {
    server: { state: 'configured', detail: 'shared settings' },
    toolbox: { state: 'checking', detail: 'Main readiness check' },
} });
dispatch({ type: 'runtime.readiness', sessionId: 'runtime', sequence: 16, payload: {
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
store.dispatch({ eventId: 'event-5', type: 'assistant.delta', sessionId: 's1', turnId: 't1', messageId: 'assistant-1', sequence: 5, timestamp: 1_700_000_000_005, runtime: 'codex', payload: { text: 'lo' } });
assert.equal(store.getState().messages.length, messageCount, 'eventId is the only replay key');
dispatch({ type: 'assistant.delta', sessionId: 'other', turnId: 't2', messageId: 'assistant-2', sequence: 13, payload: { text: 'ignore' } });
assert.equal(store.getState().messages.length, messageCount, 'events from inactive sessions must be filtered');
store.dispatch({ type: 'assistant.delta', sessionId: 's1', turnId: 't1', sequence: 14, timestamp: 1_700_000_000_014, runtime: 'codex', payload: { text: 'invalid' } });
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
        runtimes: [{ sessionId: 'restored', state: 'idle' }],
        pendingInteractions: [pendingInteraction],
    }),
    agentSessionReadProjection: async (payload) => {
        calls.push(['topic', payload]);
        return new Promise((resolve) => { resolveInitialRead = resolve; });
    },
    agentSessionRead: () => new Promise(() => {}),
    agentRuntimeSetWorkbenchPresence() {},
    onAgentRuntimeEvent(callback) { liveEvent = callback; return () => {}; },
});
controller.store.selectSession({ sessionId: 'restored', state: 'idle' });
const initializing = controller.initialize();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(controller.store.getState().interactions, [pendingInteraction],
    'Activity Center must receive Main-owned interaction identities independently of approval cards');
assert.equal(typeof liveEvent, 'function', 'Renderer must subscribe before it starts reading a Session projection');
assert.deepEqual(calls.find(([name]) => name === 'topic')[1], { sessionId: 'restored' });
liveEvent({
    eventId: 'initial-live-event', sequence: 5, timestamp: 5, runtime: 'codex',
    sessionId: 'restored', turnId: 'turn-restored',
    messageId: 'assistant-live', type: 'assistant.delta', payload: { text: 'snapshot 期间的 live delta' },
});
liveEvent({
    eventId: 'initial-readiness-event', sequence: 6, timestamp: 6, runtime: 'codex',
    sessionId: 'restored', type: 'runtime.readiness',
    payload: { toolbox: { state: 'unavailable', detail: 'Main readiness settled during snapshot' } },
});
resolveInitialRead({
    sessionId: 'restored', snapshotSequence: 4,
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
controller.store.setState({ selectedTopic: { sessionId: 'previewed-other-topic', mode: 'preview' } });
liveEvent({
    eventId: 'runtime-crash-on-other-topic', sequence: 7, timestamp: 7, runtime: 'vcpchat',
    sessionId: 'runtime', type: 'runtime.crashed', payload: { error: 'pipe closed' },
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
const sessionRuntime = { sessionId: 'switch-session', state: 'idle' };
const hydrating = switching.hydrateTopic(sessionRuntime.sessionId, sessionRuntime);
switchEvent({ eventId: 'old-event', sequence: 4, timestamp: 4, runtime: 'codex', sessionId: sessionRuntime.sessionId, turnId: 'turn-1', messageId: 'old-message', type: 'assistant.delta', payload: { text: 'stale' } });
switchEvent({ eventId: 'new-event', sequence: 5, timestamp: 5, runtime: 'codex', sessionId: sessionRuntime.sessionId, turnId: 'turn-1', messageId: 'new-message', type: 'assistant.delta', payload: { text: 'live' } });
deferredRead({ sessionId: sessionRuntime.sessionId, snapshotSequence: 4, history: [{ id: 'checkpoint-message', role: 'assistant', content: 'checkpoint' }] });
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
    agentRuntimeCreateSession: async () => ({ sessionId: 'fresh-session', state: 'idle' }),
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
    agentRuntimeReadTopic: async ({ sessionId }) => ({ sessionId, snapshotSequence: 0, history: [{ id: 'preview-history', role: 'assistant', content: 'preview only' }] }),
    agentRuntimeCreateSession: async (payload) => {
        previewCalls.push(['runtime', payload]);
        return { sessionId: payload.sessionId, state: 'idle' };
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
assert.equal(previewCalls[0][1].sessionId, 'preview-topic');
assert.equal(previewCalls[1][0], 'turn');
assert.equal(previewCalls[1][1].sessionId, 'preview-topic');
preview.dispose();

// Codex selection remains projection-only. The first send begins exactly one
// demand-driven Thread ensure and awaits it before turn/start.
const warmCalls = [];
let resolveWarm;
const warming = createWorkbenchController({
    agentRuntimeGetStatus: async () => ({
        state: 'ready', pendingApprovals: [],
        runtimes: [{ sessionId: 'warm-session', activity: 'idle' }],
    }),
    agentRuntimeReadProjection: async ({ sessionId }) => ({
        session: { sessionId: sessionId, agentId: 'Nova', title: 'Warm' }, messages: [],
    }),
    agentRuntimeReadTopic: async ({ sessionId }) => ({
        session: { sessionId: sessionId, agentId: 'Nova', title: 'Warm' }, messages: [],
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
resolveWarm({ sessionId: 'warm-session', threadId: 'warm-thread' });
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
    agentRuntimeReadProjection: ({ sessionId }) => {
        coldCalls.push(['sqlite', sessionId]);
        if (sessionId === 'topic-a') return new Promise((resolve) => { resolveSqliteA = resolve; });
        return Promise.resolve({
            session: { sessionId: 'topic-b', agentId: 'Nova', title: 'SQLite B' },
            messages: [{ messageId: 'sqlite-b', itemId: 'item-b', role: 'assistant', status: 'completed', blocks: [{ blockId: 'b:0', kind: 'message', content: { text: 'SQLite B' } }] }],
        });
    },
    agentRuntimeReadTopic: ({ sessionId }) => {
        coldCalls.push(['thread', sessionId]);
        if (sessionId === 'topic-a') return new Promise((resolve) => { resolveThreadA = resolve; });
        return new Promise((resolve) => { resolveThreadB = resolve; });
    },
});
const openingA = cold.previewTopic('topic-a', 'Nova', { title: 'A' });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(coldCalls, [['sqlite', 'topic-a']], 'cold navigation must not wait for thread/read');
resolveSqliteA({
    session: { sessionId: 'topic-a', agentId: 'Nova', title: 'SQLite A' },
    messages: [{ messageId: 'sqlite-a', itemId: 'item-a', role: 'assistant', status: 'completed', blocks: [{ blockId: 'a:0', kind: 'message', content: { text: 'SQLite A' } }] }],
});
await openingA;
assert.equal(cold.store.getState().messages[0].content, 'SQLite A', 'SQLite projection is the visible cold-open result');
await new Promise((resolve) => setImmediate(resolve));
assert.ok(coldCalls.some(([kind, sessionId]) => kind === 'thread' && sessionId === 'topic-a'), 'thread/read starts only after SQLite has rendered');
await cold.previewTopic('topic-b', 'Nova', { title: 'B' });
assert.equal(cold.store.getState().messages[0].content, 'SQLite B');
resolveThreadA({
    session: { sessionId: 'topic-a', agentId: 'Nova', title: 'stale Thread A' },
    messages: [{ messageId: 'thread-a', itemId: 'item-a', role: 'assistant', status: 'completed', blocks: [{ blockId: 'a:0', kind: 'message', content: { text: 'must not replace B' } }] }],
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(cold.store.getState().selectedTopic.sessionId, 'topic-b');
assert.equal(cold.store.getState().messages[0].content, 'SQLite B', 'late A reconciliation must not overwrite B');
resolveThreadB({ session: { sessionId: 'topic-b', agentId: 'Nova', title: 'Thread B' }, messages: [] });
cold.dispose();

// Live reasoning and tools belong to the selected Session projection, not only
// to the currently mounted DOM. Switching A -> B -> A must restore them on the
// synchronous cached frame, before the second SQLite read resolves. An active
// Turn must also not be reconciled from a potentially sparse thread/read.
let liveSwitchEvent;
let resolveSecondLiveSqlite;
const liveSwitchThreadReads = [];
let liveSqliteAReads = 0;
const liveSwitch = createWorkbenchController({
    agentRuntimeReadProjection: ({ sessionId }) => {
        if (sessionId === 'live-session-a') {
            liveSqliteAReads += 1;
            if (liveSqliteAReads > 1) {
                return new Promise((resolve) => { resolveSecondLiveSqlite = resolve; });
            }
            return Promise.resolve({
                session: { sessionId, agentId: 'Nova', title: 'Live A' }, messages: [],
            });
        }
        return Promise.resolve({
            session: { sessionId, agentId: 'Nova', title: 'Idle B' },
            messages: [{
                messageId: 'idle-b-message', itemId: 'idle-b-item', role: 'assistant', status: 'completed',
                blocks: [{ blockId: 'idle-b:0', kind: 'message', content: { text: 'Idle B' } }],
            }],
        });
    },
    agentRuntimeReadTopic: async ({ sessionId }) => {
        liveSwitchThreadReads.push(sessionId);
        return {
            session: { sessionId, agentId: 'Nova', title: sessionId },
            messages: sessionId === 'idle-session-b' ? [{
                messageId: 'idle-b-message', itemId: 'idle-b-item', role: 'assistant', status: 'completed',
                blocks: [{ blockId: 'idle-b:0', kind: 'message', content: { text: 'Idle B' } }],
            }] : [],
        };
    },
    onAgentRuntimeEvent(callback) { liveSwitchEvent = callback; return () => {}; },
});
liveSwitch.subscribeRuntime();
liveSwitch.store.setState({
    activeRuntimes: new Map([['live-session-a', {
        sessionId: 'live-session-a', activity: 'running', activeTurnId: 'live-turn-a',
    }]]),
});
await liveSwitch.previewTopic('live-session-a', 'Nova', { title: 'Live A' });
liveSwitchEvent({
    eventId: 'live-reasoning-event', sequence: 1, timestamp: 1, runtime: 'codex',
    type: 'projection.updated', sessionId: 'live-session-a', turnId: 'live-turn-a', activity: 'running',
    projectionPatch: projectionPatch({ sessionId: 'live-session-a', threadId: 'thread-live-a', revision: 1,
        messageId: 'live-reasoning-message', itemId: 'live-reasoning-item', turnId: 'live-turn-a', kind: 'reasoning',
        content: { summary: ['still thinking'], content: [] } }),
});
liveSwitchEvent({
    eventId: 'live-tool-event', sequence: 2, timestamp: 2, runtime: 'codex',
    type: 'projection.updated', sessionId: 'live-session-a', turnId: 'live-turn-a', activity: 'running',
    projectionPatch: projectionPatch({ sessionId: 'live-session-a', threadId: 'thread-live-a', revision: 2,
        messageId: 'live-tool-message', itemId: 'live-tool-item', turnId: 'live-turn-a', kind: 'tool',
        content: { item: { type: 'dynamicToolCall', tool: 'Browser', arguments: { url: 'https://vcptoolbox.com' } } } }),
});
assert.equal(liveSwitch.store.getState().messages[0].reasoning, 'still thinking');
assert.equal(liveSwitch.store.getState().tools.has('live-tool-item'), true);
await liveSwitch.previewTopic('idle-session-b', 'Nova', { title: 'Idle B' });
const returningToLiveA = liveSwitch.previewTopic('live-session-a', 'Nova', { title: 'Live A' });
assert.equal(liveSwitch.store.getState().messages.some((message) => message.reasoning === 'still thinking'), true,
    'switching back must synchronously restore live reasoning from the Session projection cache');
assert.equal(liveSwitch.store.getState().tools.has('live-tool-item'), true,
    'switching back must synchronously restore live tool cards from the Session projection cache');
resolveSecondLiveSqlite({
    session: { sessionId: 'live-session-a', agentId: 'Nova', title: 'Live A' },
    messages: [{
        messageId: 'live-reasoning-message', itemId: 'live-reasoning-item', turnId: 'live-turn-a',
        role: 'assistant', status: 'inProgress', sourceOrder: 1,
        blocks: [{ blockId: 'live-reasoning:0', kind: 'reasoning', content: { text: 'still thinking' } }],
    }, {
        messageId: 'live-tool-message', itemId: 'live-tool-item', turnId: 'live-turn-a',
        role: 'assistant', status: 'inProgress', sourceOrder: 2,
        blocks: [{ blockId: 'live-tool:0', kind: 'tool', content: {
            item: { type: 'dynamicToolCall', tool: 'Browser', arguments: { url: 'https://vcptoolbox.com' } },
        } }],
    }],
});
await returningToLiveA;
await new Promise((resolve) => setImmediate(resolve));
assert.equal(liveSwitchThreadReads.includes('live-session-a'), false,
    'an active Turn must not run thread/read reconciliation that can erase streaming reasoning or tools');
assert.equal(liveSwitch.store.getState().messages.some((message) => message.reasoning === 'still thinking'), true);
assert.equal(liveSwitch.store.getState().tools.has('live-tool-item'), true);
liveSwitch.dispose();

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
    sessionId: 'attached-session', agentId: 'Nova', title: 'Runtime shell', state: 'idle',
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(hydrateCalls, ['sqlite'], 'an attached Codex Session must also open from SQLite before thread/read');
resolveHydrateSqlite({
    session: { sessionId: 'attached-topic', agentId: 'Nova', title: 'SQLite attached' },
    messages: [{ messageId: 'attached-message', itemId: 'attached-item', role: 'assistant', status: 'completed', blocks: [{ blockId: 'attached:0', kind: 'message', content: { text: 'attached SQLite projection' } }] }],
});
await openingAttached;
assert.equal(hydratedCodex.store.getState().messages[0].content, 'attached SQLite projection');
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(hydrateCalls, ['sqlite', 'thread']);
resolveHydrateThread({ session: { sessionId: 'attached-topic', agentId: 'Nova', title: 'Thread attached' }, messages: [] });
hydratedCodex.dispose();

let liveGuardEvent;
let resolveLiveGuardThread;
const liveGuard = createWorkbenchController({
    agentRuntimeReadProjection: async () => ({
        session: { sessionId: 'live-guard-topic', agentId: 'Nova', title: 'SQLite live guard' },
        messages: [{ messageId: 'sqlite-guard', itemId: 'item-guard', role: 'assistant', status: 'completed', blocks: [{ blockId: 'guard:0', kind: 'message', content: { text: 'SQLite base' } }] }],
    }),
    agentRuntimeReadTopic: async () => new Promise((resolve) => { resolveLiveGuardThread = resolve; }),
    onAgentRuntimeEvent(callback) { liveGuardEvent = callback; return () => {}; },
});
liveGuard.subscribeRuntime();
await liveGuard.previewTopic('live-guard-topic', 'Nova');
liveGuardEvent({
    runtime: 'codex', type: 'projection.updated', sessionId: 'live-guard-topic',
    threadId: 'thread-live-guard', turnId: 'turn-live-guard', activity: 'running',
    projectionPatch: projectionPatch({ sessionId: 'live-guard-topic', threadId: 'thread-live-guard', revision: 1,
        messageId: 'live-guard-message', itemId: 'live-guard-item', turnId: 'turn-live-guard', kind: 'message',
        content: { text: 'live delta must survive' } }),
});
resolveLiveGuardThread({
    session: { sessionId: 'live-guard-topic', agentId: 'Nova', title: 'stale thread result' },
    messages: [{ messageId: 'stale-guard-message', itemId: 'stale-guard-item', role: 'assistant', status: 'completed', blocks: [{ blockId: 'stale-guard:0', kind: 'message', content: { text: 'must not replace live delta' } }] }],
});
await new Promise((resolve) => setImmediate(resolve));
assert.ok(liveGuard.store.getState().messages.some((message) => message.content === 'live delta must survive'),
    'a late thread/read snapshot must not overwrite a newer live projection patch');
assert.equal(liveGuard.store.getState().messages.some((message) => message.content === 'must not replace live delta'), false);
liveGuard.dispose();

const conflictingPreview = createWorkbenchController({
    agentRuntimeReadProjection: async () => ({
        session: { sessionId: 'session-b', agentId: 'Nova', title: 'Wrong Session' },
        messages: [],
    }),
});
await assert.rejects(
    conflictingPreview.previewTopic('session-a', 'Nova'),
    (error) => error?.code === 'SESSION_IDENTITY_MISMATCH',
    'a projection for Session B must not populate the selected Session A',
);
conflictingPreview.dispose();

let revisionGapEvent;
let revisionGapReads = 0;
const revisionGap = createWorkbenchController({
    agentRuntimeReadProjection: async () => {
        revisionGapReads += 1;
        return {
            session: { sessionId: 'revision-gap-session', threadId: 'revision-gap-thread', agentId: 'Nova' },
            projectionRevision: revisionGapReads === 1 ? 2 : 4,
            messages: [{
                messageId: 'revision-gap-message', itemId: 'revision-gap-item', role: 'assistant', status: 'completed',
                blocks: [{ blockId: 'legacy-revision-gap', kind: 'message', content: {
                    text: revisionGapReads === 1 ? 'before gap' : 'reloaded after gap',
                } }],
            }],
        };
    },
    onAgentRuntimeEvent(callback) { revisionGapEvent = callback; return () => {}; },
});
revisionGap.subscribeRuntime();
await revisionGap.previewTopic('revision-gap-session', 'Nova');
assert.equal(revisionGap.store.getState().projectionRevisions.get('revision-gap-session'), 2);
revisionGapEvent({
    runtime: 'codex', type: 'projection.updated', sessionId: 'revision-gap-session',
    threadId: 'revision-gap-thread', activity: 'idle',
    projectionPatch: projectionPatch({ sessionId: 'revision-gap-session', threadId: 'revision-gap-thread', revision: 4,
        messageId: 'must-not-apply', itemId: 'must-not-apply', turnId: 'turn-gap', kind: 'message',
        content: { text: 'gap patch must be discarded' } }),
});
for (let attempt = 0; attempt < 20 && revisionGapReads < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
}
await new Promise((resolve) => setImmediate(resolve));
assert.equal(revisionGapReads, 2, 'a revision gap must trigger one full SQLite projection reload');
assert.equal(revisionGap.store.getState().messages.some((message) => message.content === 'reloaded after gap'), true);
assert.equal(revisionGap.store.getState().messages.some((message) => message.content === 'gap patch must be discarded'), false);
revisionGap.dispose();

// Codex Session identity is authoritative. A compatibility sessionId must never
// let another Session mutate an existing runtime slot or the visible status.
let strictIdentityEvent;
const strictIdentity = createWorkbenchController({
    onAgentRuntimeEvent(callback) { strictIdentityEvent = callback; return () => {}; },
    agentRuntimeGetStatus: async () => ({ state: 'ready', runtimes: [] }),
});
strictIdentity.store.setState({
    selectedSessionId: 'session-nova',
    selectedTopic: { sessionId: 'session-nova', agentId: 'Nova', mode: 'runtime-active' },
    activeRuntimes: new Map([['legacy-topic-key', {
        sessionId: 'session-nova', agentId: 'Nova', activity: 'idle',
    }]]),
});
strictIdentity.subscribeRuntime();
strictIdentityEvent({
    eventId: 'foreign-session-turn', sequence: 1, timestamp: 1, runtime: 'codex',
    type: 'turn.started', sessionId: 'session-uika',
    turnId: 'turn-uika', messageId: 'message-uika', payload: { prompt: 'UIka task' },
});
assert.equal(strictIdentity.store.getState().activeRuntimes.get('legacy-topic-key').activity, 'idle',
    'a foreign Session event must not update a runtime through the old sessionId compatibility key');
assert.equal(strictIdentity.store.getState().activeTurnId, null,
    'a foreign Agent Session must never mark the selected Session as running');
strictIdentity.dispose();

let conflictingStartCalls = 0;
const conflictingSelection = createWorkbenchController({
    agentRuntimeStartTurn: async () => { conflictingStartCalls += 1; return { turnId: 'must-not-start' }; },
    agentRuntimeEnsureSessionRuntime: async ({ sessionId }) => ({ sessionId }),
});
conflictingSelection.store.setState({
    selectedSessionId: 'session-a',
    selectedTopic: { sessionId: 'session-b', agentId: 'Nova', mode: 'preview' },
});
await assert.rejects(() => conflictingSelection.startTurn('must fail closed'), /身份不完整|已变化/);
assert.equal(conflictingStartCalls, 0, 'conflicting selection identity must never reach Main');
conflictingSelection.dispose();

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
    selectedTopic: { sessionId: 'codex-topic', mode: 'runtime-active' },
    activeRuntimes: new Map([['codex-topic', { sessionId: 'codex-topic', state: 'idle' }]]),
});
duplicateGuard.subscribeRuntime();
await duplicateGuard.startTurn('只显示一次');
assert.equal(duplicateGuard.store.getState().messages.filter((message) => message.role === 'user').length, 1,
    'turn acceptance may show one temporary user row');
duplicateGuardEvent({
    runtime: 'codex', type: 'projection.updated', sessionId: 'codex-topic',
    turnId: 'codex-turn-1', activity: 'running',
    projectionPatch: projectionPatch({ sessionId: 'codex-topic', threadId: 'thread-codex-topic', revision: 1,
        messageId: 'durable-user-message', itemId: 'durable-user-item', turnId: 'codex-turn-1', kind: 'message',
        content: { parts: [{ type: 'text', text: '只显示一次' }] } }),
});
const reconciledUserMessages = duplicateGuard.store.getState().messages.filter((message) => message.role === 'user');
assert.equal(reconciledUserMessages.length, 1,
    'the App Server user item must replace—not append to—the temporary row');
assert.equal(reconciledUserMessages[0].id, 'block:codex-topic:durable-user-item:0');
assert.equal(reconciledUserMessages[0].deliveryState, 'confirmed');
duplicateGuard.dispose();

console.log('Agent Workbench store/reducer/controller projection tests passed.');
