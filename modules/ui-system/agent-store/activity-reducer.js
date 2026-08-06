import { incrementActivityUnread } from './reducer-shared.js';

function withUnread(state, tab) {
    return { ...state, ...incrementActivityUnread(state, tab) };
}

function reduceToolboxObservation(state, event) {
    const payload = event.payload || {};
    const observation = {
        id: `${payload.channel || 'toolbox'}:${payload.kind || 'event'}:${event.sequence || event.timestamp || Date.now()}`,
        channel: String(payload.channel || 'ToolBox'),
        kind: String(payload.kind || 'notification'),
        value: payload.value ?? null,
        timestamp: event.timestamp || null,
    };
    return withUnread({ ...state, toolboxWs: [...state.toolboxWs, observation].slice(-100) },
        payload.kind === 'backend-approval-request' ? 'approvals' : 'activity');
}

function reduceMarkerObservation(state, event) {
    const payload = event.payload || {};
    const observation = {
        id: `marker:${payload.kind || 'unknown'}:${event.sequence}`,
        kind: String(payload.kind || 'unknown'),
        summary: typeof payload.summary === 'string' ? payload.summary : '',
        detail: typeof payload.detail === 'string' ? payload.detail : '',
        messageId: event.messageId || null,
        turnId: event.turnId || null,
        timestamp: event.timestamp || null,
    };
    return withUnread({ ...state, markerObservations: [...state.markerObservations, observation].slice(-100) }, 'activity');
}

function reduceUsage(state, event) {
    const payload = event.payload || {};
    const source = ['real', 'estimated', 'unknown'].includes(payload.source) ? payload.source : 'unknown';
    const hasReportedUsage = ['real', 'estimated'].includes(source)
        && ['totalTokens', 'usedTokens', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']
            .some((key) => Number.isFinite(Number(payload[key])));
    const usedTokens = Number(payload.contextTokens ?? payload.usedTokens ?? payload.totalTokens) || 0;
    const contextWindow = Number(payload.contextWindow) || 0;
    return withUnread({
        ...state,
        context: {
            ...state.context,
            ...payload,
            source,
            usageAvailable: hasReportedUsage,
            usedTokens,
            contextWindow,
            percentage: contextWindow ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : null,
        },
    }, 'usage');
}

function reduceCompactionStarted(state) {
    return withUnread({
        ...state,
        context: { ...state.context, compacting: true, compactionState: 'started', compactionError: '' },
    }, 'usage');
}

function reduceCompactionCompleted(state, event) {
    return withUnread({
        ...state,
        context: {
            ...state.context,
            compacting: false,
            compactionState: 'completed',
            summary: event.payload?.summary || '',
            compactionError: '',
        },
    }, 'usage');
}

function reduceCompactionFailed(state, event) {
    return withUnread({
        ...state,
        context: {
            ...state.context,
            compacting: false,
            compactionState: 'failed',
            summary: '',
            compactionError: event.payload?.error || '上下文压缩失败',
        },
    }, 'usage');
}

function reducePlan(state, event) {
    return withUnread({ ...state, plan: event.payload?.plan || event.payload || null }, 'plan');
}

function reduceApprovalUnread(state) {
    return withUnread(state, 'approvals');
}

const ACTIVITY_HANDLERS = new Map([
    ['toolbox.ws', reduceToolboxObservation],
    ['marker.observed', reduceMarkerObservation],
    ['context.usage', reduceUsage],
    ['context.compaction.started', reduceCompactionStarted],
    ['compaction.started', reduceCompactionStarted],
    ['context.compaction.completed', reduceCompactionCompleted],
    ['compaction.completed', reduceCompactionCompleted],
    ['context.compaction.failed', reduceCompactionFailed],
    ['compaction.failed', reduceCompactionFailed],
    ['plan.updated', reducePlan],
    ['approval.requested', reduceApprovalUnread],
    ['interaction.requested', reduceApprovalUnread],
]);

function reduceActivityEvent(state, event) {
    return ACTIVITY_HANDLERS.get(event.type)?.(state, event) ?? state;
}

export { reduceActivityEvent };
