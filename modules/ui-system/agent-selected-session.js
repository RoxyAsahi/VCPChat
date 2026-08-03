function selectedSessionIdentity(state = {}) {
    const sessionId = String(state.selectedSessionId || '').trim();
    if (!sessionId) return null;
    const topicSessionId = String(state.selectedTopic?.sessionId || '').trim();
    if (topicSessionId && topicSessionId !== sessionId) return null;
    return Object.freeze({
        sessionId,
        threadId: String(state.selectedTopic?.threadId || '').trim() || null,
        agentId: String(state.selectedTopic?.agentId || '').trim() || null,
    });
}

function selectedSessionId(state = {}) {
    return selectedSessionIdentity(state)?.sessionId || null;
}

export { selectedSessionIdentity, selectedSessionId };
