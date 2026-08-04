function reduceRuntimeState(state, event) {
    return {
        ...state,
        runtime: { ...state.runtime, ...(event.payload || {}), state: event.payload?.state || 'unknown' },
    };
}

function reduceRuntimeCrash(state, event) {
    return {
        ...state,
        runtime: { ...state.runtime, state: 'failed', lastError: event.payload || null },
    };
}

function reduceRuntimeWarning(state, event) {
    return { ...state, notice: { level: 'warning', text: event.payload?.warning || 'Runtime warning' } };
}

function reduceRuntimeReadiness(state, event) {
    return { ...state, readiness: { ...(state.readiness || {}), ...(event.payload || {}) } };
}

const RUNTIME_HANDLERS = new Map([
    ['runtime.state_changed', reduceRuntimeState],
    ['runtime.crashed', reduceRuntimeCrash],
    ['runtime.warning', reduceRuntimeWarning],
    ['runtime.readiness', reduceRuntimeReadiness],
]);

function reduceRuntimeEvent(state, event) {
    return RUNTIME_HANDLERS.get(event.type)?.(state, event) ?? state;
}

export { reduceRuntimeEvent };
