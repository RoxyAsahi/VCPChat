import { eventSequence } from './reducer-shared.js';

function reduceToolEvent(state, event) {
    const toolCallId = event.toolCallId || event.payload?.toolCallId;
    if (!toolCallId) return state;
    const tools = new Map(state.tools);
    const previous = tools.get(toolCallId) || { toolCallId, events: [] };
    tools.set(toolCallId, {
        ...previous,
        turnId: event.turnId || null,
        name: event.payload?.toolName || previous.name || 'tool',
        state: event.type.slice('tool.'.length),
        payload: { ...(previous.payload || {}), ...(event.payload || {}) },
        events: [...previous.events, event],
        firstSequence: previous.firstSequence ?? eventSequence(event),
        lastSequence: eventSequence(event) ?? previous.lastSequence ?? null,
        firstTimestamp: previous.firstTimestamp ?? event.timestamp ?? null,
        lastTimestamp: event.timestamp ?? previous.lastTimestamp ?? null,
    });
    return { ...state, tools };
}

export { reduceToolEvent };
