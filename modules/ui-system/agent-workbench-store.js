import { createAgentSessionUiState } from './agent-session-state.js';
import { createAgentEventDeduper } from './agent-event-deduper.js';
import { selectedProjectionView } from './agent-normalized-store.js';
import { selectedSessionId as selectedSessionIdFromState } from './agent-selected-session.js';
import { reduceEphemeralEvent } from './agent-store/ephemeral-reducer.js';
import { reduceEvent } from './agent-store/event-router.js';
import { pendingUserMessageId } from './agent-store/reducer-shared.js';

const SESSION_EVENT_TYPES = new Set([
    'session.created',
    'session.state_changed',
    'session.closed',
    'session.config.saved',
    'session.config.pending',
    'session.config.applied',
    'session.config.failed',
]);
const EPHEMERAL_EVENT_TYPES = new Set([
    'turn.started', 'turn.completed', 'turn.failed', 'turn.cancelled',
]);

function createInitialState() {
    return {
        runtime: { state: 'unknown', worker: null, lastError: null },
        selectedSessionId: null,
        sessionsById: new Map(),
        blocksById: new Map(),
        projectionRevisions: new Map(),
        activeRuntimes: new Map(),
        ephemeralStateBySession: new Map(),
        selectedTopic: null,
        sessionUi: createAgentSessionUiState(),
        approvals: [],
        interactions: [],
        toolboxWs: [],
        markerObservations: [],
        activityUnread: 0,
        activityUnreadByTab: { activity: 0, approvals: 0, plan: 0, changes: 0, usage: 0, connection: 0 },
        readiness: {},
        context: { usedTokens: 0, contextWindow: 0, percentage: 0, compacting: false, summary: '' },
        plan: null,
        activeTurnId: null,
        lastSequence: 0,
        notice: null,
    };
}

function acceptsVisibleEvent(state, event) {
    const isRuntimeEvent = !event.sessionId || event.sessionId === 'runtime'
        || event.type?.startsWith('runtime.') || event.type === 'toolbox.ws';
    const isSessionEvent = SESSION_EVENT_TYPES.has(event.type);
    const isApproval = event.type?.startsWith('approval.');
    const isInteraction = event.type?.startsWith('interaction.');
    const selectedSessionId = state.selectedSessionId || null;
    return isRuntimeEvent || isSessionEvent || isApproval || isInteraction
        || EPHEMERAL_EVENT_TYPES.has(event.type)
        || Boolean(selectedSessionId && event.sessionId === selectedSessionId);
}

function ownedInitialState(initial) {
    const { messages: _messages, tools: _tools, ...owned } = initial || {};
    const defaults = createInitialState();
    return {
        ...defaults,
        ...owned,
        sessionsById: owned.sessionsById instanceof Map ? owned.sessionsById : defaults.sessionsById,
        blocksById: owned.blocksById instanceof Map ? owned.blocksById : defaults.blocksById,
        projectionRevisions: owned.projectionRevisions instanceof Map
            ? owned.projectionRevisions : defaults.projectionRevisions,
        activeRuntimes: owned.activeRuntimes instanceof Map ? owned.activeRuntimes : defaults.activeRuntimes,
        ephemeralStateBySession: owned.ephemeralStateBySession instanceof Map
            ? owned.ephemeralStateBySession : defaults.ephemeralStateBySession,
    };
}

function createWorkbenchStore(initial = createInitialState()) {
    let state = ownedInitialState(initial);
    const listeners = new Set();
    const eventDeduper = createAgentEventDeduper();

    function viewState() {
        return { ...state, ...selectedProjectionView(state) };
    }

    function notify(event) {
        const current = viewState();
        listeners.forEach((listener) => listener(current, event));
    }

    return {
        getState: viewState,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setState(patch, event) {
            const { messages: _messages, tools: _tools, ...ownedPatch } = patch || {};
            state = { ...state, ...ownedPatch };
            notify(event);
        },
        addPendingUserMessage({ turnId, prompt, attachments = [], createdAt = Date.now() } = {}) {
            if (!turnId || (!String(prompt || '').trim() && !attachments.length)) return state;
            const sessionId = String(state.selectedSessionId || '').trim();
            if (!sessionId) return state;
            const ephemeralStateBySession = state.ephemeralStateBySession instanceof Map
                ? new Map(state.ephemeralStateBySession) : new Map();
            const ephemeral = ephemeralStateBySession.get(sessionId) || { pendingMessages: [] };
            const pendingMessages = Array.isArray(ephemeral.pendingMessages) ? ephemeral.pendingMessages : [];
            const existing = pendingMessages.find((message) => message.turnId === turnId && message.role === 'user');
            if (existing) return state;
            ephemeralStateBySession.set(sessionId, {
                ...ephemeral,
                pendingMessages: [...pendingMessages, {
                    id: pendingUserMessageId(turnId),
                    turnId,
                    role: 'user',
                    content: String(prompt).trim(),
                    attachments: Array.isArray(attachments) ? attachments.map((item) => ({ ...item })) : [],
                    state: 'pending',
                    deliveryState: 'sending',
                    deliveryDetail: '正在等待 Codex App Server 确认…',
                    createdAt,
                    firstSequence: null,
                    lastSequence: null,
                }],
            });
            state = { ...state, ephemeralStateBySession };
            notify({ type: 'ui.user_message.pending', turnId });
            return state;
        },
        applyEphemeralEvent(event) {
            const next = reduceEphemeralEvent(state, event || {});
            if (next !== state) {
                state = next;
                notify(event);
            }
            return state;
        },
        dispatch(event) {
            if (!event || typeof event !== 'object') return state;
            if (!event.eventId || !Number.isFinite(Number(event.sequence))
                || !Number.isFinite(Number(event.timestamp))) return state;
            if (!acceptsVisibleEvent(state, event) || !eventDeduper.accept(event)) return state;
            state = reduceEvent(state, event);
            notify(event);
            return state;
        },
        selectSession(session) {
            const sessionId = session?.sessionId || null;
            const defaults = createInitialState();
            state = {
                ...state,
                selectedSessionId: sessionId,
                selectedTopic: session ? { ...session, sessionId } : null,
                approvals: [],
                toolboxWs: [],
                markerObservations: [],
                activityUnread: 0,
                activityUnreadByTab: defaults.activityUnreadByTab,
                context: defaults.context,
                plan: null,
                activeTurnId: null,
                lastSequence: 0,
                notice: null,
            };
            notify();
        },
        reset() {
            eventDeduper.clear();
            state = createInitialState();
            notify();
        },
    };
}

function deriveWorkbenchViewState(state = {}) {
    const runtime = state.runtime || {};
    const selectedSessionId = selectedSessionIdFromState(state);
    const selectedRuntime = selectedSessionId && state.activeRuntimes instanceof Map
        ? state.activeRuntimes.get(selectedSessionId) : null;
    const hasSession = Boolean(selectedSessionId);
    const hasIdlePreview = Boolean(
        selectedSessionId
        && state.selectedTopic?.mode === 'preview'
        && state.selectedTopic?.sessionId === selectedSessionId
    );
    const hasTurn = Boolean(state.activeTurnId || selectedRuntime?.activeTurnId);
    const hasApproval = Boolean(selectedSessionId && Array.isArray(state.approvals)
        && state.approvals.some((approval) => approval?.sessionId === selectedSessionId));

    if (runtime.state === 'failed') return 'error';
    if (state.recovering || runtime.state === 'degraded') return 'reconnecting';
    if (runtimeRecoveryUnconfirmed(selectedRuntime)) return 'reconnecting';
    if ((runtime.state === 'unknown' || runtime.state === 'stopped') && !hasIdlePreview) return 'disconnected';
    if (!hasSession && !hasIdlePreview) return 'disconnected';
    if (hasApproval) return 'awaiting-approval';
    if (hasTurn) return 'running';
    if (selectedRuntime?.state && !['created', 'ready', 'idle'].includes(selectedRuntime.state)) return 'starting';
    return 'idle';
}

function runtimeRecoveryUnconfirmed(runtime) {
    return runtime?.recoveryState === 'unconfirmed' || runtime?.activity === 'unknown';
}

export {
    createInitialState,
    createWorkbenchStore,
    reduceEvent,
    deriveWorkbenchViewState,
};
