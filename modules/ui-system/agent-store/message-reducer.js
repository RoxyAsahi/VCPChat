import {
    REJECT_EVENT,
    confirmUserMessage,
    eventSequence,
    markPendingTurn,
    messageIdentity,
    upsertMessage,
} from './reducer-shared.js';

function reduceTurnStarted(state, event) {
    if (!event.turnId || !event.messageId) return REJECT_EVENT;
    return {
        ...state,
        activeTurnId: event.turnId,
        messages: confirmUserMessage(state.messages, event),
    };
}

function reduceUserMessage(state, event) {
    if (!event.eventId) return REJECT_EVENT;
    return { ...state, messages: confirmUserMessage(state.messages, event) };
}

function assistantCandidate(event) {
    return {
        id: event.messageId,
        messageId: event.messageId,
        turnId: event.turnId,
        role: 'assistant',
        content: '',
        reasoning: '',
        state: 'streaming',
        createdAt: event.timestamp || 0,
        firstSequence: eventSequence(event),
        lastSequence: eventSequence(event),
    };
}

function reduceAssistantStarted(state, event) {
    if (!event.messageId || !event.turnId) return REJECT_EVENT;
    if (state.messages.some((message) => messageIdentity(message) === event.messageId)) return state;
    return { ...state, messages: upsertMessage(state.messages, assistantCandidate(event)) };
}

function reduceAssistantDelta(state, event) {
    if (!event.messageId || !event.turnId) return REJECT_EVENT;
    const messages = [...state.messages];
    let index = messages.findIndex((message) => messageIdentity(message) === event.messageId);
    if (index < 0) {
        messages.push(assistantCandidate(event));
        index = messages.length - 1;
    }
    const message = { ...messages[index] };
    if (event.type === 'assistant.delta' && message.state !== 'complete') {
        message.content = `${message.content || ''}${event.payload?.text || ''}`;
    } else if (event.type === 'reasoning.delta') {
        message.reasoning = `${message.reasoning || ''}${event.payload?.text || ''}`;
    }
    message.lastSequence = eventSequence(event) ?? message.lastSequence ?? null;
    messages[index] = message;
    return { ...state, messages };
}

function reduceAssistantCompleted(state, event) {
    if (!event.messageId || !event.turnId) return REJECT_EVENT;
    return {
        ...state,
        messages: state.messages.map((message) => messageIdentity(message) === event.messageId
            ? { ...message, state: 'complete', lastSequence: eventSequence(event) ?? message.lastSequence ?? null }
            : message),
    };
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

function reduceTerminalTurn(state, event) {
    const activeTurnId = event.turnId && event.turnId === state.activeTurnId ? null : state.activeTurnId;
    if (event.type === 'turn.completed') return { ...state, activeTurnId };
    const delivery = terminalDelivery(event);
    return {
        ...state,
        activeTurnId,
        messages: event.turnId
            ? markPendingTurn(state.messages, event.turnId, delivery.state, delivery.detail)
            : state.messages,
        notice: { level: 'error', text: event.payload?.error || event.payload?.reason || event.type },
    };
}

function reduceRuntimeCrashMessages(state) {
    return {
        ...state,
        messages: state.messages.map((message) => (
            message.role === 'user' && message.deliveryState === 'sending'
                ? {
                    ...message,
                    deliveryState: 'unconfirmed',
                    deliveryDetail: '连接中断，消息是否已写入将由重新连接后的 Codex Thread 对账确认。',
                }
                : message
        )),
    };
}

const MESSAGE_HANDLERS = new Map([
    ['turn.started', reduceTurnStarted],
    ['user.message', reduceUserMessage],
    ['assistant.started', reduceAssistantStarted],
    ['assistant.delta', reduceAssistantDelta],
    ['reasoning.delta', reduceAssistantDelta],
    ['assistant.completed', reduceAssistantCompleted],
    ['turn.completed', reduceTerminalTurn],
    ['turn.failed', reduceTerminalTurn],
    ['turn.cancelled', reduceTerminalTurn],
    ['runtime.crashed', reduceRuntimeCrashMessages],
]);

function reduceMessageEvent(state, event) {
    return MESSAGE_HANDLERS.get(event.type)?.(state, event) ?? state;
}

export { reduceMessageEvent };
