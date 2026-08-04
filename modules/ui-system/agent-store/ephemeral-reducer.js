const ACCEPTED_DETAIL = 'Codex 已接受消息，正在等待持久投影确认...';
const UNCONFIRMED_DETAIL = '连接中断，消息是否已写入将由重新连接后的 Codex Thread 对账确认。';

function updateSessionPending(state, sessionId, update) {
    const id = String(sessionId || '').trim();
    if (!id || !(state.ephemeralStateBySession instanceof Map)) return state;
    const current = state.ephemeralStateBySession.get(id);
    const pendingMessages = Array.isArray(current?.pendingMessages) ? current.pendingMessages : [];
    if (!pendingMessages.length) return state;
    const nextMessages = update(pendingMessages);
    if (nextMessages === pendingMessages) return state;
    const ephemeralStateBySession = new Map(state.ephemeralStateBySession);
    ephemeralStateBySession.set(id, { ...current, pendingMessages: nextMessages });
    return { ...state, ephemeralStateBySession };
}

function updateMatchingTurn(state, event, update) {
    const turnId = String(event.turnId || '').trim();
    if (!turnId) return state;
    return updateSessionPending(state, event.sessionId, (messages) => {
        let changed = false;
        const next = messages.map((message) => {
            if (message.turnId !== turnId) return message;
            const candidate = update(message);
            if (candidate !== message) changed = true;
            return candidate;
        });
        return changed ? next : messages;
    });
}

function reduceTurnStarted(state, event) {
    return updateMatchingTurn(state, event, (message) => (
        message.deliveryState === 'sending'
            ? { ...message, deliveryState: 'confirmed', deliveryDetail: ACCEPTED_DETAIL }
            : message
    ));
}

function terminalDelivery(event) {
    const attachmentUnavailable = event.type === 'turn.failed'
        && event.payload?.code === 'attachment-unavailable';
    return {
        state: attachmentUnavailable ? 'failed' : 'interrupted',
        detail: attachmentUnavailable
            ? '附件文件不可用或已损坏；请重新选择附件后重试。'
            : '任务已中断；为避免重复执行，Codex Runtime 不会自动重放此消息。',
    };
}

function reduceTurnTerminal(state, event) {
    if (event.type === 'turn.completed') return reduceTurnStarted(state, event);
    const delivery = terminalDelivery(event);
    const next = updateMatchingTurn(state, event, (message) => (
        message.deliveryState === 'sending'
            ? { ...message, deliveryState: delivery.state, deliveryDetail: delivery.detail }
            : message
    ));
    return {
        ...next,
        notice: { level: 'error', text: event.payload?.error || event.payload?.reason || event.type },
    };
}

function reduceRuntimeCrash(state) {
    if (!(state.ephemeralStateBySession instanceof Map)) return state;
    let changed = false;
    const ephemeralStateBySession = new Map();
    for (const [sessionId, current] of state.ephemeralStateBySession) {
        const pendingMessages = Array.isArray(current?.pendingMessages) ? current.pendingMessages : [];
        const nextMessages = pendingMessages.map((message) => {
            if (message.deliveryState !== 'sending') return message;
            changed = true;
            return { ...message, deliveryState: 'unconfirmed', deliveryDetail: UNCONFIRMED_DETAIL };
        });
        ephemeralStateBySession.set(sessionId, { ...current, pendingMessages: nextMessages });
    }
    return changed ? { ...state, ephemeralStateBySession } : state;
}

function reduceSessionClosed(state, event) {
    const sessionId = String(event.sessionId || '').trim();
    if (!sessionId || !(state.ephemeralStateBySession instanceof Map)
        || !state.ephemeralStateBySession.has(sessionId)) return state;
    const ephemeralStateBySession = new Map(state.ephemeralStateBySession);
    ephemeralStateBySession.delete(sessionId);
    return { ...state, ephemeralStateBySession };
}

const EPHEMERAL_HANDLERS = new Map([
    ['turn.started', reduceTurnStarted],
    ['turn.completed', reduceTurnTerminal],
    ['turn.failed', reduceTurnTerminal],
    ['turn.cancelled', reduceTurnTerminal],
    ['runtime.crashed', reduceRuntimeCrash],
    ['session.closed', reduceSessionClosed],
]);

function reduceEphemeralEvent(state, event) {
    return EPHEMERAL_HANDLERS.get(event.type)?.(state, event) ?? state;
}

export { reduceEphemeralEvent };
