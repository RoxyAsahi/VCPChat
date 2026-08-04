import { selectedSessionId as selectedSessionIdFromState } from './agent-selected-session.js';

function eventTimestamp(value) {
    const raw = typeof value === 'string' ? Date.parse(value) : Number(value);
    if (Number.isFinite(raw) && raw >= 1_000_000_000_000) return raw;
    if (Number.isFinite(raw) && raw >= 1_000_000_000) return raw * 1000;
    return Date.now();
}

function syncEventDock(event, state, selectedDockSessionId) {
    if (event?.type === 'toolbox.ws' || event?.type === 'marker.observed') {
        state.sessionDock.setSession(selectedDockSessionId()); state.sessionDock.ensureKind('notifications');
    }
    if (event?.type?.startsWith('approval.') || event?.type?.startsWith('interaction.')) {
        state.sessionDock.setSession(selectedDockSessionId()); state.sessionDock.ensureKind('approvals');
    }
}

function clearEventUnread(event, state, clearActivityUnread) {
    if (!event?.type || !state.activityOpen) return;
    const eventTab = event.type === 'toolbox.ws' || event.type === 'marker.observed' ? 'notifications'
        : event.type.startsWith('approval.') || event.type.startsWith('interaction.') ? 'approvals'
            : event.type === 'plan.updated' || event.type === 'context.usage' || event.type.includes('compaction') ? 'context' : null;
    const activeKind = state.sessionDock.snapshot().tabs.find((tab) => tab.id === state.activityTab)?.kind;
    if (eventTab === activeKind) clearActivityUnread(eventTab);
}

function updateTurnTiming(event, state, selectedSessionKey) {
    if (event?.type === 'turn.started' && event.turnId) {
        if (!state.turnStartedAt.has(event.turnId)) state.turnStartedAt.set(event.turnId, eventTimestamp(event.timestamp));
        state.turnElapsedBySession?.delete(event.sessionId || selectedSessionKey());
        return;
    }
    if (!event?.turnId || !['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) return;
    const startedAt = state.turnStartedAt.get(event.turnId);
    if (startedAt && event.sessionId) state.turnElapsedBySession?.set(event.sessionId, Math.max(0, Date.now() - startedAt));
    state.turnStartedAt.delete(event.turnId);
}

function routeStoreEvent(event, deps) {
    const { queueRender, noteTimelineActivity, maybeAutoOpenActivity, refreshControlPlane, patchSidebarTopicSelection } = deps;
    if (!event?.type) { patchSidebarTopicSelection(); queueRender({ header: true, feed: true, composer: true }); return; }
    if (event.type === 'assistant.delta' || event.type === 'reasoning.delta') {
        const tokenKey = `first-visible-delta:${event.turnId || event.messageId || 'current'}`;
        if (!deps.state.uxTimings.has(tokenKey)) deps.state.uxTimings.set(tokenKey, deps.uxMark('first-visible-delta', event.turnId || event.messageId));
        noteTimelineActivity(); if (event.messageId) queueRender({ feed: true }); return;
    }
    if (event.type === 'interaction.consumed') { void refreshControlPlane(); queueRender({ header: true, composer: true }); return; }
    if (event.type.startsWith('tool.') || event.type.startsWith('approval.') || event.type === 'assistant.started' || event.type === 'assistant.completed' || event.type === 'user.message' || event.type.startsWith('turn.') || event.type === 'ui.user_message.pending') {
        if (!['approval.requested', 'approval.resolved', 'approval.expired'].includes(event.type)) noteTimelineActivity();
        maybeAutoOpenActivity(); queueRender({ feed: true, header: true, activity: true, composer: true }); return;
    }
    if (event.type === 'toolbox.ws') { queueRender({ activity: true }); return; }
    if (event.type.startsWith('session.')) { queueRender({ shell: true, header: true, feed: true, composer: true }); return; }
    if (event.type.startsWith('runtime.') || event.type.startsWith('context.')) { maybeAutoOpenActivity(); queueRender({ header: true, activity: true, composer: true }); return; }
    queueRender({ feed: true, activity: true, composer: true });
}

export function createAgentWorkbenchRenderCoordinator({
    state, store, lifecycle, sidebar, feed, sessionActivity, selectedSessionKey,
    selectedTurnStart, selectedDockSessionId, clearActivityUnread, maybeAutoOpenActivity,
    refreshControlPlane, uxMark, isFollowingContainer, renderers,
}) {
    const pending = { shell: false, header: false, feed: false, composer: false, activity: false, topicFlow: false };
    let frame = null;
    let disposed = false;

    function queueRender(parts = {}) {
        if (disposed || state.disposed) return;
        Object.assign(pending, parts);
        if (frame !== null) return;
        frame = lifecycle.frame('render', () => {
            frame = null;
            const next = { ...pending };
            Object.keys(pending).forEach((key) => { pending[key] = false; });
            if (next.shell) renderers.sidebar();
            if (next.header) renderers.header();
            if (next.feed) renderers.feed();
            if (next.activity) renderers.activity();
            if (next.composer) renderers.composer();
            if (next.topicFlow) renderers.topicFlow();
        });
    }

    function patchSidebarTopicSelection() {
        const current = store.getState();
        const selectedSessionId = selectedSessionIdFromState(current);
        for (const row of sidebar.querySelectorAll('.agent-chat-session-row[data-session-id]')) {
            const active = Boolean(selectedSessionId && row.dataset.sessionId === selectedSessionId);
            const activity = sessionActivity(row.dataset.sessionId, row.dataset.runtimeActivity || 'idle');
            row.classList.toggle('active', active);
            row.classList.toggle('active-topic-glowing', active);
            row.classList.toggle('is-running', ['starting', 'running'].includes(activity));
            row.classList.toggle('is-awaiting-approval', activity === 'awaiting-approval');
            row.dataset.runtimeActivity = activity;
            const avatar = row.querySelector('.agent-chat-session-avatar');
            if (avatar) {
                avatar.dataset.activity = activity;
                avatar.classList.toggle('is-running', ['starting', 'running'].includes(activity));
                avatar.classList.toggle('is-awaiting-approval', activity === 'awaiting-approval');
            }
            row.setAttribute('aria-current', active ? 'true' : 'false');
        }
    }

    function noteTimelineActivity() {
        if (isFollowingContainer(feed)) {
            state.followingFeed = true;
            state.unreadTimelineCount = 0;
        } else {
            state.followingFeed = false;
            state.unreadTimelineCount = Math.min(99, (state.unreadTimelineCount || 0) + 1);
        }
        renderers.jumpToLatest();
    }

    function settleEventStart(event, turnStart) {
        const turnMatches = !event.turnId || !turnStart.turnId || event.turnId === turnStart.turnId;
        const sessionMatches = event.sessionId === turnStart.sessionId;
        if (sessionMatches && event.type === 'turn.started') {
            state.turnStarts.set(turnStart.sessionId, {
                ...turnStart, turnId: event.turnId || turnStart.turnId, phase: 'thinking', seenRunning: true,
            });
        }
        if (sessionMatches && turnMatches && [
            'assistant.started', 'assistant.delta', 'reasoning.delta', 'turn.completed',
            'turn.failed', 'turn.cancelled', 'runtime.crashed',
        ].includes(event.type)) {
            state.turnStarts.delete(turnStart.sessionId);
            return true;
        }
        return false;
    }

    function settleIdleStarts(current) {
        for (const [sessionId, entry] of state.turnStarts) {
            const hasAssistant = sessionId === selectedSessionKey(current) && entry.turnId
                && current.messages.some((message) => message.role === 'assistant' && message.turnId === entry.turnId);
            const runtime = current.activeRuntimes instanceof Map ? current.activeRuntimes.get(sessionId) : null;
            if (runtime && (runtime.activity === 'running' || runtime.activeTurnId) && !entry.seenRunning) {
                state.turnStarts.set(sessionId, { ...entry, seenRunning: true });
            }
            const terminalRuntime = Boolean(entry.turnId && entry.seenRunning && runtime
                && runtime.activity === 'idle' && !runtime.activeTurnId);
            if (!hasAssistant && !terminalRuntime) continue;
            if (hasAssistant) uxMark('first-assistant-item', entry.turnId,
                state.uxTimings.get(`turn-start:${entry.sessionId || 'new'}`) || null);
            state.turnStarts.delete(sessionId);
        }
    }

    function settleTurnStartIndicator(event) {
        const eventSessionId = event?.sessionId || null;
        const turnStart = eventSessionId ? state.turnStarts.get(eventSessionId) : selectedTurnStart();
        if (event && turnStart) { settleEventStart(event, turnStart); return; }
        if (event) return;
        const current = store.getState();
        settleIdleStarts(current);
    }

    function renderForStoreEvent(event) {
        if (disposed) return;
        syncEventDock(event, state, selectedDockSessionId);
        clearEventUnread(event, state, clearActivityUnread);
        updateTurnTiming(event, state, selectedSessionKey);
        settleTurnStartIndicator(event);
        routeStoreEvent(event, { state, uxMark, queueRender, noteTimelineActivity, maybeAutoOpenActivity, refreshControlPlane, patchSidebarTopicSelection });
    }

    return {
        queueRender,
        settleTurnStartIndicator,
        renderForStoreEvent,
        dispose() {
            disposed = true;
            lifecycle.clear('render');
            frame = null;
            Object.keys(pending).forEach((key) => { pending[key] = false; });
        },
    };
}
