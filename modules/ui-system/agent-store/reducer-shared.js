const REJECT_EVENT = Symbol('reject-agent-store-event');

function approvalIdentity(approval) {
    const source = String(approval?.scope || approval?.source || 'codex-native');
    const id = String(approval?.approvalId || approval?.requestId || '');
    return id ? `${source}:${id}` : '';
}

function incrementActivityUnread(state, tab) {
    const current = state.activityUnreadByTab || {};
    const activityUnreadByTab = { ...current, [tab]: Math.min(100, (current[tab] || 0) + 1) };
    return {
        activityUnreadByTab,
        activityUnread: Math.min(100, Object.values(activityUnreadByTab)
            .reduce((sum, value) => sum + Number(value || 0), 0)),
    };
}

function pendingUserMessageId(turnId) {
    return `pending-user:${turnId}`;
}

export {
    REJECT_EVENT,
    approvalIdentity,
    incrementActivityUnread,
    pendingUserMessageId,
};
