const REJECT_EVENT = Symbol('reject-agent-store-event');

function messageIdentity(message) {
    return message?.id || message?.messageId || null;
}

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

function upsertMessage(messages, candidate) {
    const id = messageIdentity(candidate);
    if (!id) return messages;
    const index = messages.findIndex((message) => messageIdentity(message) === id);
    if (index < 0) return [...messages, { ...candidate, id }];
    const next = [...messages];
    next[index] = { ...next[index], ...candidate, id };
    return next;
}

function pendingUserMessageId(turnId) {
    return `pending-user:${turnId}`;
}

function eventSequence(event) {
    const value = Number(event?.sequence);
    return Number.isFinite(value) ? value : null;
}

function confirmUserMessage(messages, event) {
    const index = messages.findIndex((message) => message.turnId === event.turnId && message.role === 'user');
    const candidate = {
        ...(index >= 0 ? messages[index] : {}),
        id: event.messageId,
        messageId: event.messageId,
        turnId: event.turnId,
        role: 'user',
        content: event.payload?.prompt || (index >= 0 ? messages[index].content : ''),
        attachments: Array.isArray(event.payload?.attachments)
            ? event.payload.attachments
            : (index >= 0 ? messages[index].attachments || [] : []),
        state: 'complete',
        deliveryState: 'confirmed',
        deliveryDetail: '',
        createdAt: event.timestamp || (index >= 0 ? messages[index].createdAt : 0),
        firstSequence: eventSequence(event) ?? (index >= 0 ? messages[index].firstSequence : null),
        lastSequence: eventSequence(event) ?? (index >= 0 ? messages[index].lastSequence : null),
    };
    if (index < 0) return [...messages, candidate];
    const next = [...messages];
    next[index] = candidate;
    return next;
}

function markPendingTurn(messages, turnId, deliveryState, deliveryDetail) {
    return messages.map((message) => (
        message.role === 'user'
        && message.turnId === turnId
        && message.deliveryState === 'sending'
            ? { ...message, deliveryState, deliveryDetail }
            : message
    ));
}

export {
    REJECT_EVENT,
    approvalIdentity,
    confirmUserMessage,
    eventSequence,
    incrementActivityUnread,
    markPendingTurn,
    messageIdentity,
    pendingUserMessageId,
    upsertMessage,
};
