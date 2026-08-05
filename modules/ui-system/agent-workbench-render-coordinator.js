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

function visibleText(value) {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value.text === 'string') return value.text.trim();
    return '';
}

function sessionHasVisibleTurnOutput(current, sessionId, turnId, selectedSessionId) {
    if (sessionId !== selectedSessionId) return false;
    const assistantVisible = current.messages.some((message) => message.role === 'assistant'
        && (!turnId || message.turnId === turnId)
        && (visibleText(message.content) || visibleText(message.reasoning)
            || (Array.isArray(message.attachments) && message.attachments.length > 0)));
    if (assistantVisible) return true;
    const tools = current.tools instanceof Map ? [...current.tools.values()] : [];
    return tools.some((tool) => !turnId || tool.turnId === turnId);
}

function terminalPhase(event) {
    if (event?.type === 'turn.failed') return 'failed';
    if (event?.type === 'turn.cancelled' || event?.type === 'turn.interrupted') return 'interrupted';
    if (event?.type === 'turn.completed') return 'empty';
    if (event?.method !== 'turn/completed') return null;
    const status = String(event.turnStatus || '').trim().toLowerCase();
    if (['failed', 'error'].includes(status)) return 'failed';
    if (['interrupted', 'cancelled', 'canceled'].includes(status)) return 'interrupted';
    return 'empty';
}

function terminalDetail(event, phase) {
    if (phase === 'failed') {
        return String(event?.payload?.error || event?.payload?.reason || event?.turnError
            || '任务执行失败，请检查 Runtime 与 ToolBox 连接。');
    }
    if (phase === 'interrupted') return '任务已停止。';
    return '任务已结束，但没有返回可显示内容。';
}

function routeStoreEvent(event, deps) {
    const { queueRender, noteTimelineActivity, maybeAutoOpenActivity, refreshControlPlane, patchSidebarTopicSelection } = deps;
    if (!event?.type) { patchSidebarTopicSelection(); queueRender({ header: true, feed: true, composer: true }); return; }
    if (event.type === 'projection.updated') {
        noteTimelineActivity();
        queueRender({ feed: true, header: true, composer: true });
        return;
    }
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
    if (event.type.startsWith('session.config.')) {
        queueRender({ header: true, activity: true, composer: true });
        return;
    }
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

    function settleEventStart(event, turnStart, current) {
        const turnMatches = !event.turnId || !turnStart.turnId || event.turnId === turnStart.turnId;
        const sessionMatches = event.sessionId === turnStart.sessionId;
        if (sessionMatches && event.type === 'turn.started') {
            state.turnStarts.set(turnStart.sessionId, {
                ...turnStart, turnId: event.turnId || turnStart.turnId, phase: 'thinking', seenRunning: true,
            });
        }
        if (!sessionMatches || !turnMatches) return false;
        if (sessionHasVisibleTurnOutput(
            current, turnStart.sessionId, event.turnId || turnStart.turnId, selectedSessionKey(current),
        )) {
            state.turnStarts.delete(turnStart.sessionId);
            return true;
        }
        const phase = terminalPhase(event);
        if (phase) {
            state.turnStarts.set(turnStart.sessionId, {
                ...turnStart,
                turnId: event.turnId || turnStart.turnId,
                phase,
                detail: terminalDetail(event, phase),
                seenRunning: true,
            });
            return true;
        }
        return false;
    }

    function settleIdleStarts(current) {
        for (const [sessionId, entry] of state.turnStarts) {
            const hasOutput = sessionHasVisibleTurnOutput(
                current, sessionId, entry.turnId, selectedSessionKey(current),
            );
            const runtime = current.activeRuntimes instanceof Map ? current.activeRuntimes.get(sessionId) : null;
            if (runtime && (runtime.activity === 'running' || runtime.activeTurnId) && !entry.seenRunning) {
                state.turnStarts.set(sessionId, { ...entry, seenRunning: true });
            }
            const terminalRuntime = Boolean(entry.turnId && entry.seenRunning && runtime
                && runtime.activity === 'idle' && !runtime.activeTurnId);
            if (!hasOutput && !terminalRuntime) continue;
            if (hasOutput) uxMark('first-assistant-item', entry.turnId,
                state.uxTimings.get(`turn-start:${entry.sessionId || 'new'}`) || null);
            if (hasOutput) {
                state.turnStarts.delete(sessionId);
            } else if (!['failed', 'interrupted', 'empty'].includes(entry.phase)) {
                state.turnStarts.set(sessionId, {
                    ...entry,
                    phase: 'empty',
                    detail: '任务已结束，但没有返回可显示内容。',
                });
            }
        }
    }

    function settleTurnStartIndicator(event) {
        const current = store.getState();
        if (event?.type === 'runtime.crashed') {
            for (const [sessionId, entry] of state.turnStarts) {
                state.turnStarts.set(sessionId, {
                    ...entry,
                    phase: 'failed',
                    detail: String(event?.payload?.error || event?.error || 'Codex App Server 已断开。'),
                });
            }
            return;
        }
        const eventSessionId = event?.sessionId || null;
        const turnStart = eventSessionId ? state.turnStarts.get(eventSessionId) : selectedTurnStart();
        if (event && turnStart) { settleEventStart(event, turnStart, current); return; }
        if (event) return;
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
