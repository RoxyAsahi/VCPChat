import { approvalIdentity } from './reducer-shared.js';

function reduceApprovalRequested(state, event) {
    const payload = event.payload?.approval || event.payload;
    const approval = payload ? {
        ...payload,
        sessionId: event.sessionId,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
    } : null;
    if (!approval?.approvalId) return state;
    const key = approvalIdentity(approval);
    return {
        ...state,
        approvals: [...state.approvals.filter((item) => approvalIdentity(item) !== key), approval],
    };
}

function reduceApprovalResolved(state, event) {
    const approvalId = event.approvalId || event.payload?.approvalId || event.payload?.approval?.approvalId;
    const scope = event.payload?.scope || event.scope || null;
    return {
        ...state,
        approvals: state.approvals.filter((item) => (
            scope ? approvalIdentity(item) !== `${scope}:${approvalId}` : item.approvalId !== approvalId
        )),
    };
}

function reduceInteractionRequested(state, event) {
    const interaction = event.payload || {};
    const key = `${interaction.source || 'codex-native'}:${interaction.requestId || ''}`;
    return {
        ...state,
        interactions: [...state.interactions.filter((item) => `${item.source}:${item.requestId}` !== key), interaction],
    };
}

function reduceInteractionResolved(state, event) {
    const payload = event.payload || {};
    return {
        ...state,
        interactions: state.interactions.filter((item) => !(
            item.source === (payload.source || 'codex-native') && item.requestId === payload.requestId
        )),
    };
}

const APPROVAL_HANDLERS = new Map([
    ['approval.requested', reduceApprovalRequested],
    ['approval.resolved', reduceApprovalResolved],
    ['approval.expired', reduceApprovalResolved],
    ['interaction.requested', reduceInteractionRequested],
    ['interaction.resolved', reduceInteractionResolved],
    ['interaction.rejected', reduceInteractionResolved],
]);

function reduceApprovalEvent(state, event) {
    return APPROVAL_HANDLERS.get(event.type)?.(state, event) ?? state;
}

export { reduceApprovalEvent };
