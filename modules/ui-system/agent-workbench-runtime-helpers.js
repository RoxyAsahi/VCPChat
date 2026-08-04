const LAST_TOPIC_STORAGE_KEY = 'vcpchat.agentWorkbench.lastTopic.v1';

const WORKBENCH_VIEW_STATE_LABELS = Object.freeze({
    disconnected: '未连接',
    starting: '启动中',
    idle: '空闲',
    running: '运行中',
    'awaiting-approval': '待审批',
    reconnecting: '重连中',
    error: '错误',
});

const runtimeApi = () => window.chatAPI || window.electronAPI || {};

function loadRememberedTopic() {
    try {
        const value = window.localStorage?.getItem(LAST_TOPIC_STORAGE_KEY);
        const parsed = value ? JSON.parse(value) : null;
        const sessionId = String(parsed?.sessionId || '').trim();
        return sessionId ? { sessionId } : null;
    } catch {
        return null;
    }
}

function rememberTopic(session) {
    if (!session?.sessionId) return;
    try {
        window.localStorage?.setItem(LAST_TOPIC_STORAGE_KEY, JSON.stringify({ sessionId: session.sessionId }));
    } catch {}
}

function clearRememberedTopic() {
    try { window.localStorage?.removeItem(LAST_TOPIC_STORAGE_KEY); } catch {}
}

function proxyMainButton(id) {
    if (id === 'nextUiCreateItemBtn' && typeof window.topTabManager?.openCreateDialog === 'function') {
        return window.topTabManager.openCreateDialog();
    }
    return document.getElementById(id)?.click();
}

function notify(message, variant = 'info') {
    if (window.VCPUI?.feedback?.toast) window.VCPUI.feedback.toast(message, { variant });
    else window.uiHelperFunctions?.showToastNotification?.(message, variant === 'error' ? 'error' : 'success');
}

function nextSessionTitle() {
    const time = new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    return `新会话 ${time}`;
}

function formatTime(value) {
    if (!value) return '';
    try { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); } catch { return ''; }
}

function renderMarkdown(text, markdown = {}) {
    if (!text) return '';
    return markdown.render?.(text) || String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function postRender(contentDiv, markdown = {}) {
    markdown.postProcess?.(contentDiv);
}

function isFollowingContainer(container, bridge = {}) {
    return bridge.isNearBottom
        ? bridge.isNearBottom(container, 48)
        : (container.scrollTop + container.clientHeight >= container.scrollHeight - 48);
}

function scrollFeed(container, force, scheduleFrame, bridge = {}) {
    if (force) {
        scheduleFrame(() => { if (container?.isConnected) container.scrollTop = container.scrollHeight; });
        return;
    }
    if (bridge) bridge.autoScrollToBottom?.(container);
    else if (container && isFollowingContainer(container)) container.scrollTop = container.scrollHeight;
}

function headerIdentity(state, current, session) {
    const selected = current.selectedTopic;
    const selectedHasRuntime = Boolean(selected?.sessionId && selected.sessionId === session?.sessionId);
    return {
        title: selected?.title || (selectedHasRuntime ? session?.title : '')
            || `与 ${selected?.agentId || state.selectedAgent || 'Nova'} 聊天中`,
        sessionId: selected?.sessionId || null,
        agentId: selected?.agentId || session?.agentId || null,
        canRename: Boolean(selected?.sessionId),
        hasSession: Boolean(session),
    };
}

function headerStatus(state, current, viewState, activeTurnId) {
    const selected = current.selectedTopic;
    const stateLabel = WORKBENCH_VIEW_STATE_LABELS[viewState] || viewState;
    const completed = viewState === 'idle' && state.turnElapsedBySession?.has(selected?.sessionId);
    return {
        state: viewState,
        stateLabel,
        statusLabel: completed ? '已完成' : stateLabel,
        statusStartedAt: viewState === 'running'
            ? state.turnStartedAt.get(activeTurnId) || state.turnStarts.get(selected?.sessionId)?.startedAt : null,
        statusElapsedMs: viewState === 'idle' ? state.turnElapsedBySession?.get(selected?.sessionId) : null,
        codexRuntime: current.runtime?.runtime === 'codex-app-server',
        alert: viewState === 'error' || viewState === 'reconnecting',
    };
}

function headerActivity(state, current, contextExpanded) {
    return {
        pendingApprovals: (current.approvals || []).length,
        activityUnread: Number(current.activityUnread) || 0,
        activityOpen: state.activityOpen,
        queueLength: state.queue.length,
        queueOpen: state.queueOpen,
        usage: current.context,
        contextExpanded,
    };
}

function buildWorkbenchHeaderModel({
    state, current, session, viewState, activeTurnId, contextExpanded,
}) {
    return {
        ...headerIdentity(state, current, session),
        ...headerStatus(state, current, viewState, activeTurnId),
        ...headerActivity(state, current, contextExpanded),
    };
}

export {
    WORKBENCH_VIEW_STATE_LABELS,
    buildWorkbenchHeaderModel,
    clearRememberedTopic,
    formatTime,
    isFollowingContainer,
    loadRememberedTopic,
    nextSessionTitle,
    notify,
    postRender,
    proxyMainButton,
    rememberTopic,
    renderMarkdown,
    runtimeApi,
    scrollFeed,
};
