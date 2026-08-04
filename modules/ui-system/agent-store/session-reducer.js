function reduceSessionCreated(state, event) {
    const activeRuntimes = new Map(state.activeRuntimes);
    const current = activeRuntimes.get(event.sessionId) || { sessionId: event.sessionId };
    activeRuntimes.set(event.sessionId, { ...current, state: 'created', ...(event.payload || {}) });
    return { ...state, activeRuntimes };
}

function reduceSessionState(state, event) {
    const activeRuntimes = new Map(state.activeRuntimes);
    const current = activeRuntimes.get(event.sessionId);
    if (current) activeRuntimes.set(event.sessionId, {
        ...current,
        ...(event.payload || {}),
        state: event.type === 'session.closed' ? 'closed' : event.payload?.state,
    });
    return { ...state, activeRuntimes };
}

function projectSelectedSessionConfig(state, sessionId, payload) {
    if (state.selectedSessionId !== sessionId || !state.selectedTopic) return state.selectedTopic;
    return {
        ...state.selectedTopic,
        configSnapshot: payload.desiredConfig || state.selectedTopic.configSnapshot,
        appliedRuntimeConfig: payload.appliedRuntimeConfig || state.selectedTopic.appliedRuntimeConfig,
        configRevision: payload.configRevision ?? state.selectedTopic.configRevision,
        appliedRuntimeConfigRevision: payload.appliedRuntimeConfigRevision
            ?? state.selectedTopic.appliedRuntimeConfigRevision,
        configApplyState: payload.applyState || state.selectedTopic.configApplyState,
        configApplyError: payload.applyError || payload.error || null,
    };
}

function reduceSessionConfig(state, event) {
    const payload = event.payload || {};
    const sessionId = event.sessionId || payload.sessionId;
    const activeRuntimes = new Map(state.activeRuntimes);
    const runtime = activeRuntimes.get(sessionId);
    if (runtime) activeRuntimes.set(sessionId, {
        ...runtime,
        configRevision: payload.configRevision,
        appliedRuntimeConfigRevision: payload.appliedRuntimeConfigRevision,
        configApplyState: payload.applyState,
        configApplyError: payload.applyError || payload.error || null,
    });
    return {
        ...state,
        activeRuntimes,
        selectedTopic: projectSelectedSessionConfig(state, sessionId, payload),
    };
}

const SESSION_HANDLERS = new Map([
    ['session.created', reduceSessionCreated],
    ['session.state_changed', reduceSessionState],
    ['session.closed', reduceSessionState],
    ['session.config.saved', reduceSessionConfig],
    ['session.config.pending', reduceSessionConfig],
    ['session.config.applied', reduceSessionConfig],
    ['session.config.failed', reduceSessionConfig],
]);

function reduceSessionEvent(state, event) {
    return SESSION_HANDLERS.get(event.type)?.(state, event) ?? state;
}

export { reduceSessionEvent };
