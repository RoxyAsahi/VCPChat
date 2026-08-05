const SESSION_STATES = Object.freeze([
    'idle', 'warming', 'starting', 'streaming', 'waiting-native-approval',
    'waiting-vcp-approval', 'waiting-user-input', 'interrupting', 'completed',
    'interrupted', 'reconnecting', 'orphaned', 'error',
]);
const TERMINAL_STATES = new Set(['completed', 'interrupted', 'orphaned', 'error']);

function normalizedSessionId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function requireMatchingProjectionSession(expectedSessionId, projectionSessionId) {
    const expected = normalizedSessionId(expectedSessionId);
    const actual = normalizedSessionId(projectionSessionId);
    if (!expected || actual !== expected) {
        const error = new Error('Projection identity does not match the selected Agent Session');
        error.code = 'SESSION_IDENTITY_MISMATCH';
        throw error;
    }
    return expected;
}

function requireSnapshotSession(snapshot, expectedSessionId) {
    return requireMatchingProjectionSession(expectedSessionId, snapshot?.session?.sessionId);
}

function createAgentSessionUiState(sessions = []) {
    const bySessionId = {};
    for (const session of sessions) {
        if (!session?.sessionId || !session?.threadId) continue;
        bySessionId[session.sessionId] = {
            sessionId: session.sessionId,
            threadId: session.threadId,
            turnId: null,
            state: session.orphaned ? 'orphaned' : (session.state === 'running' ? 'streaming' : 'idle'),
            pendingInteractionId: null,
        };
    }
    return { selectedSessionId: null, bySessionId };
}

function reconcileAgentSessionUiState(current, sessions = []) {
    const seed = createAgentSessionUiState(sessions);
    const previous = current?.bySessionId || {};
    for (const [sessionId, record] of Object.entries(seed.bySessionId)) {
        const existing = previous[sessionId];
        // A resumed Session keeps its live local state only while the durable
        // Thread identity is unchanged. This prevents a stale status refresh
        // from clearing a streaming/approval state for the current Thread.
        if (record.state === 'orphaned') {
            seed.bySessionId[sessionId] = record;
        } else if (existing?.threadId === record.threadId && !TERMINAL_STATES.has(existing.state)) {
            seed.bySessionId[sessionId] = existing;
        }
    }
    return {
        selectedSessionId: seed.bySessionId[current?.selectedSessionId]
            ? current.selectedSessionId : null,
        bySessionId: seed.bySessionId,
    };
}

function eventMatches(record, event) {
    if (!record || !event || event.sessionId !== record.sessionId) return false;
    if (event.threadId && event.threadId !== record.threadId) return false;
    if (event.turnId && record.turnId && event.turnId !== record.turnId) return false;
    return true;
}

function reduceAgentSessionUiState(state, event) {
    if (!event || typeof event.type !== 'string') return state;
    if (event.type === 'session.selected') {
        return state.bySessionId[event.sessionId]
            ? { ...state, selectedSessionId: event.sessionId }
            : state;
    }
    const record = state.bySessionId[event.sessionId];
    if (!eventMatches(record, event)) return state;
    const next = { ...record };
    switch (event.type) {
        case 'runtime.warming': next.state = 'warming'; break;
        case 'turn.started': next.state = 'streaming'; next.turnId = event.turnId || record.turnId; break;
        case 'turn.interrupting': next.state = 'interrupting'; break;
        case 'turn.completed': next.state = 'completed'; next.turnId = null; next.pendingInteractionId = null; break;
        case 'turn.interrupted':
        case 'turn.cancelled': next.state = 'interrupted'; next.turnId = null; next.pendingInteractionId = null; break;
        case 'turn.failed': next.state = 'error'; next.turnId = null; next.pendingInteractionId = null; break;
        case 'runtime.reconnecting': next.state = 'reconnecting'; break;
        case 'session.orphaned': next.state = 'orphaned'; next.turnId = null; next.pendingInteractionId = null; break;
        case 'interaction.native.requested': next.state = 'waiting-native-approval'; next.pendingInteractionId = event.requestId || null; break;
        case 'interaction.vcp.requested': next.state = 'waiting-vcp-approval'; next.pendingInteractionId = event.requestId || null; break;
        case 'interaction.user-input.requested': next.state = 'waiting-user-input'; next.pendingInteractionId = event.requestId || null; break;
        case 'interaction.resolved':
            if (event.requestId && event.requestId !== record.pendingInteractionId) return state;
            next.state = record.turnId ? 'streaming' : 'idle';
            next.pendingInteractionId = null;
            break;
        default: return state;
    }
    if (!SESSION_STATES.includes(next.state)) return state;
    return { ...state, bySessionId: { ...state.bySessionId, [record.sessionId]: next } };
}

export {
    SESSION_STATES, TERMINAL_STATES, createAgentSessionUiState,
    reconcileAgentSessionUiState, eventMatches, reduceAgentSessionUiState,
    requireMatchingProjectionSession, requireSnapshotSession,
};
