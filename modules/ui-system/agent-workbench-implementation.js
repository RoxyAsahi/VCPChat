import { register } from './next-ui-apps.js';
import { createWorkbenchController } from './agent-workbench-controller.js';
import { deriveWorkbenchViewState } from './agent-workbench-store.js';
import { createAgentBlockPresentation } from './agent-presentation/index.js';
import { renderPendingInputQueue } from './agent-workbench-queue.js';
import { createWorkspaceRequestCoordinator } from './agent-workspace-requests.js';
import { createWorkbenchLifecycle } from './agent-workbench-lifecycle.js';
import { renderAgentSettingsPane } from './agent-settings-view.js';
import {
    createAgentSettingsState,
} from './agent-settings-state.js';
import {
    button,
    createSidebarSearchPanel,
    cssEscape,
    icon,
    iconButton,
    node,
    visualActionButton,
} from './agent-workbench-dom.js';
import { createAgentWorkbenchShellView } from './agent-workbench-shell-view.js';
import { createAgentWorkbenchRunStatusView } from './agent-workbench-run-status-view.js';
import { createAgentWorkbenchComposerView } from './agent-workbench-composer-view.js';
import { createAgentWorkspaceView } from './agent-workspace-view.js';
import { createAgentWorkbenchHeaderView } from './agent-workbench-header-view.js';
import { createAgentWorkbenchAccountView } from './agent-workbench-account-view.js';
import { createAgentActivityReadonlyView } from './agent-activity-readonly-view.js';
import { createAgentSessionDockView } from './agent-session-dock-view.js';
import { createAgentNotificationView } from './agent-notification-view.js';
import { createAgentApprovalView } from './agent-approval-view.js';
import { createAgentWorkbenchTopicFlow } from './agent-workbench-topic-flow.js';
import { createAgentWorkspaceCoordinator } from './agent-workspace-coordinator.js';
import { createAgentSettingsCoordinator } from './agent-settings-coordinator.js';
import { createAgentTopicContextMenuView } from './agent-topic-context-menu-view.js';
import { createAgentSessionOperationsCoordinator } from './agent-session-operations-coordinator.js';
import { createAgentActivityCoordinator } from './agent-activity-coordinator.js';
import { createAgentComposerCoordinator } from './agent-composer-coordinator.js';
import { createAgentWorkbenchRenderCoordinator } from './agent-workbench-render-coordinator.js';
import { createAgentWorkbenchSidebarCoordinator } from './agent-workbench-sidebar-coordinator.js';
import { createAgentTimelineCoordinator } from './agent-timeline-coordinator.js';
import { createAgentSessionViewContext } from './agent-session-view-context.js';
import { createAgentWorkbenchState } from './agent-workbench-state.js';
import {
    agentCacheKey,
    createAgentSessionCatalogCoordinator,
    sameAgent,
    seedBuildAgentCatalog,
} from './agent-session-catalog-coordinator.js';

// This is deliberately a view over AgentRuntime, not a second chat/session
// implementation. Session, message, tool, approval and runtime state all come
// from Electron Main's Codex runtime and projection services through narrow IPC.
const runtimeApi = () => window.chatAPI || window.electronAPI || {};
// This is deliberately only a pointer. The renderer remembers which durable
// VChat Agent Session to display after Ctrl+R; transcript data stays in SQLite
// and execution context stays in the Codex Thread Store.
const LAST_TOPIC_STORAGE_KEY = 'vcpchat.agentWorkbench.lastTopic.v1';

// R3 fixed lifecycle state machine — labels shown in the Workbench header.
const WORKBENCH_VIEW_STATE_LABELS = {
    disconnected: '未连接',
    starting: '启动中',
    idle: '空闲',
    running: '运行中',
    'awaiting-approval': '待审批',
    reconnecting: '重连中',
    error: '错误',
};

function loadRememberedTopic() {
    try {
        const value = window.localStorage?.getItem(LAST_TOPIC_STORAGE_KEY);
        const parsed = value ? JSON.parse(value) : null;
        if (!parsed || typeof parsed.topicId !== 'string') return null;
        const pointer = { topicId: parsed.topicId };
        // Normalize legacy values immediately; no async runtime/catalog read
        // may leave transcript, Agent or workspace metadata in localStorage.
        window.localStorage?.setItem(LAST_TOPIC_STORAGE_KEY, JSON.stringify(pointer));
        return pointer;
    } catch {
        return null;
    }
}

function rememberTopic(session) {
    if (!session?.topicId) return;
    try {
        window.localStorage?.setItem(LAST_TOPIC_STORAGE_KEY, JSON.stringify({ topicId: session.topicId }));
    } catch {
        // Local storage is only a convenience pointer; Topic recovery must
        // never fail because a locked-down renderer refuses preferences.
    }
}

function proxyMainButton(id) {
    // The Agent Workbench is a separate product page.  The only shared piece
    // here is the VCPChat Agent/Group configuration flow, which belongs to
    // main chat rather than Codex Sessions. Ask the owning module to open it
    // directly: a synthetic click can silently hit a replaced sidebar button
    // whose original event listener is no longer attached after a UI redraw.
    if (id === 'nextUiCreateItemBtn' && typeof window.topTabManager?.openCreateDialog === 'function') {
        return window.topTabManager.openCreateDialog();
    }
    return document.getElementById(id)?.click();
}

// Agent Workbench owns its DOM and behavior.  It deliberately uses the shared
// sidebar/composer *classes* and design tokens, but never clones a main-chat
// element: copying it also copied incidental IDs/listeners and made this page
// depend on whichever main-chat markup happened to be mounted.
function notify(message, variant = 'info') {
    if (window.VCPUI?.feedback?.toast) window.VCPUI.feedback.toast(message, { variant });
    else window.uiHelperFunctions?.showToastNotification?.(message, variant === 'error' ? 'error' : 'success');
}

function nextSessionTitle() {
    // Keep the same friction-free convention as VCPChat's normal “新话题”
    // action. A first user prompt may become the durable VChat Session title.
    const time = new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    return `新会话 ${time}`;
}

function formatTime(value) {
    if (!value) return '';
    try { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); } catch { return ''; }
}

function renderMarkdown(text) {
    const bridge = window.vcpRenderBridge;
    if (!text) return '';
    if (bridge) return bridge.renderContent(text);
    if (typeof window.parseAgentMarkdown === 'function') return window.parseAgentMarkdown(text);
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function postRender(contentDiv) {
    window.vcpRenderBridge?.runPostRender(contentDiv);
}

function scrollFeed(container, force) {
    const bridge = window.vcpRenderBridge;
    if (force) {
        const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
        raf(() => { if (container?.isConnected) container.scrollTop = container.scrollHeight; });
        return;
    }
    if (bridge) {
        bridge.autoScrollToBottom(container);
    } else if (container && isFollowingContainer(container)) {
        container.scrollTop = container.scrollHeight;
    }
}

function isFollowingContainer(container) {
    const bridge = window.vcpRenderBridge;
    return bridge ? bridge.isNearBottom(container, 48) : (container.scrollTop + container.clientHeight >= container.scrollHeight - 48);
}

function mountWorkbench(container) {
    const lifecycle = createWorkbenchLifecycle(window);
    const controller = createWorkbenchController(runtimeApi());
    const { store } = controller;
    const state = createAgentWorkbenchState({
        window, agentCatalog: seedBuildAgentCatalog(), rememberedTopic: loadRememberedTopic(),
    });
    const sessionViewContext = createAgentSessionViewContext({ state, store, document, sameAgent });
    const {
        activeSession, selectedSessionKey, selectedComposerState, selectedTurnStart,
        selectedActiveTurnId, sessionActivity, createSessionAvatar,
    } = sessionViewContext;
    const syncPermissionModeFromSelectedSession = sessionViewContext.syncPermissionMode;
    const syncModelFromSelectedSession = sessionViewContext.syncModel;
    let renderCoordinator = null;
    const queueRender = (parts) => renderCoordinator?.queueRender(parts);
    const settleTurnStartIndicator = (event) => renderCoordinator?.settleTurnStartIndicator(event);

    const shellView = createAgentWorkbenchShellView({
        document,
        container,
        state,
        actions: {
            openSessionSettings: () => {
                state.tab = 'settings';
                state.settingsScope = 'session';
                queueRender({ shell: true });
            },
            setInputMode: (mode) => {
                state.composerStateBySession.setMode(selectedSessionKey(), mode);
                renderComposer();
            },
            openEmoticons: (trigger, targetInput) => {
                if (window.emoticonManager?.togglePanel) window.emoticonManager.togglePanel(trigger, targetInput);
                else notify('表情包系统尚未准备好。', 'warning');
            },
            openPermissionSettings: () => {
                state.tab = 'settings';
                state.settingsScope = selectedSessionKey() ? 'session' : 'profile';
                queueRender({ shell: true });
            },
            setActivityOpen: (open) => setActivityOpen(open),
        },
    });
    const {
        root, topicFlowLayer, sidebar, main, feed, feedItems, jumpToLatest, header,
        runStatus, runStatusLabel, runStatusDetail, runStatusElapsed, runStatusStop,
        composerConfig, runningModes, steerModeButton, followUpModeButton, inputCard, input,
        newButton, attachButton, permissionsButton, sendButton, attachmentTray,
        activityPanel, activitySplitter,
    } = shellView.refs;
    const runStatusView = createAgentWorkbenchRunStatusView({ refs: shellView.refs, lifecycle });
    const composerView = createAgentWorkbenchComposerView({ refs: shellView.refs, document });
    const headerView = createAgentWorkbenchHeaderView({
        element: header,
        document,
        actions: {
            reconnect: () => run(recoverRuntime),
            toggleActivity: () => setActivityOpen(!state.activityOpen),
            toggleQueue: () => {
                state.queueOpen = !state.queueOpen;
                renderHeader();
            },
            toggleContext: () => {
                if (state.activityOpen && normalizeDockKind(state.activityTab) === 'context') setActivityOpen(false);
                else setActivityOpen(true, 'context');
            },
            compact: () => run(async () => {
                const session = activeSession();
                if (!session) return;
                const result = await controller.compactSession(session.sessionId);
                const before = Number(result?.compaction?.beforeTokens || 0);
                const after = Number(result?.compaction?.afterTokens || 0);
                notify(before && after
                    ? `上下文已完成压缩：${before} -> ${after} tokens。`
                    : '上下文已完成压缩并刷新会话历史。', 'success');
            }),
        },
    });
    const accountView = createAgentWorkbenchAccountView({
        window,
        document,
        actions: {
            openThemes: () => runtimeApi().openThemesWindow?.(),
            toggleTheme: () => proxyMainButton('themeToggleBtn'),
            openGlobalSettings: () => window.uiHelperFunctions?.openModal?.('globalSettingsModal'),
            setPresentationMode: (mode) => window.applyChatPresentationMode?.(mode, {
                persist: true,
                preserveScroll: true,
                notify: false,
                source: 'agent-account-menu',
            }),
        },
    });
    let sidebarCoordinator = null;

    const run = async (work) => {
        try { await work(); } catch (error) {
            // Browser DevTools otherwise renders an Error object as an opaque
            // `JSHandle@error`, which hides a Runtime/control-plane failure
            // from both users and Electron smoke diagnostics.
            console.error('[Agent Workbench]', error?.stack || error?.message || String(error));
            notify(error?.message || String(error), 'error');
        }
    };
    const workspaceView = createAgentWorkspaceView({
        document,
        actions: {
            run,
            refresh: () => renderActivity(),
            loadDirectory: (relativePath) => loadWorkspaceDirectory(relativePath),
            openPreview: (ref) => openWorkspacePreview(ref),
            openFileTab: (ref) => openWorkspaceFileTab(ref),
            performPathAction: (ref, action) => performWorkspaceAction(ref, action),
            search: (value) => scheduleWorkspaceSearch(value),
            onBinaryPreview: () => activitySplitter.classList.remove('is-active'),
        },
    });
    const activityReadonlyView = createAgentActivityReadonlyView({
        document,
        actions: {
            run,
            reconnect: () => recoverRuntime(),
            openFileTab: (ref) => openWorkspaceFileTab(ref),
            revealPath: (ref) => performWorkspaceAction(ref, 'reveal-in-explorer'),
        },
    });
    const sessionDockView = createAgentSessionDockView({
        refs: shellView.refs,
        document,
        actions: {
            activate(id, kind) {
                state.sessionDock.activate(id);
                state.activityTab = id;
                clearActivityUnread(kind);
                renderActivity();
            },
            close(id) {
                state.sessionDock.close(id);
                state.activityTab = state.sessionDock.snapshot().activeId;
                renderActivity();
            },
            toggleMenu() {
                state.dockMenuOpen = !state.dockMenuOpen;
                renderActivity();
            },
            closeMenu() {
                state.dockMenuOpen = false;
                renderActivity();
            },
        },
    });
    const workspaceRequests = createWorkspaceRequestCoordinator({
        cancel: ({ requestId, sessionId }) => {
            try { void controller.workspaceCancel({ requestId, sessionId }).catch(() => null); } catch {}
        },
    });
    function selectedWorkspaceIdentity(current = store.getState()) {
        const selected = current.selectedTopic || {};
        return {
            sessionId: current.selectedSessionId || selected.topicId || selected.sessionId || '',
            workspaceRoot: selected.workspaceRef || selected.workspaceRoot || '',
        };
    }
    const workspaceCoordinator = createAgentWorkspaceCoordinator({
        browser: state.workspaceBrowser,
        requests: workspaceRequests,
        lifecycle,
        getIdentity: selectedWorkspaceIdentity,
        clearAttachments: (sessionId) => state.composerStateBySession.setAttachments(sessionId, []),
        refresh: () => renderActivity(),
        notify: (message) => notify(message, 'success'),
        client: {
            listDirectory: (request) => controller.workspaceListDirectory(request),
            readPreview: (request) => controller.workspaceReadPreview(request),
            performPathAction: (request) => controller.workspacePerformPathAction(request),
            searchFiles: (request) => controller.workspaceSearchFiles(request),
        },
    });
    let budgetAutosaveTimer = null;
    const settingsState = createAgentSettingsState();
    runStatusStop.addEventListener('click', () => run(async () => {
        runStatusStop.disabled = true;
        await controller.cancelTurn();
    }));

    const sessionCatalog = createAgentSessionCatalogCoordinator({
        state,
        store,
        controller,
        listAgentProfiles: () => runtimeApi().agentRuntimeListAgentProfiles?.(),
        getCachedModels: () => runtimeApi().getCachedModels?.(),
        queueRender,
        syncPermissionModeFromSelectedSession,
        syncModelFromSelectedSession,
        uxMark,
        requestAnimationFrame: window.requestAnimationFrame || ((callback) => setTimeout(callback, 0)),
    });
    const {
        selectedAgentProfile,
        profileNeedsConfiguration,
        selectAgent,
        refreshTopicsForAgent,
        refreshControlPlane,
    } = sessionCatalog;
    const settingsCoordinator = createAgentSettingsCoordinator({
        state,
        store,
        settingsState,
        controller,
        selectedAgentProfile,
        selectAgent,
        saveAgentProfile: (request) => runtimeApi().agentRuntimeSaveAgentProfile?.(request),
        refreshTopicsForAgent,
        notify,
        refreshViews: () => {
            renderSidebar();
            renderHeader();
        },
    });
    const { persist: persistWorkbenchSettings, sessionConfigRevisions } = settingsCoordinator;

    const approvalRegistry = new Map();
    let timelineCoordinator = null;
    const blockPresentation = createAgentBlockPresentation({
        document,
        renderContent: renderMarkdown,
        postRender,
        actions: {
            cancelTool: (tool) => run(() => controller.cancelTool(tool.toolCallId, tool.turnId)),
            respondToolboxApproval: (approvalId, decision, approval) => run(() => controller.respondToolboxApproval(approvalId, decision, approval?.generation)),
            openWorkspacePath: (relativePath, action = 'preview') => run(() => openWorkspaceSourcePath(relativePath, 'tool', action)),
        },
    });
    const notificationView = createAgentNotificationView({
        document,
        blockPresentation,
        actions: { refresh: () => renderActivity() },
    });
    const approvalView = createAgentApprovalView({
        document,
        blockPresentation,
        registry: approvalRegistry,
        actions: {
            ensureTicker: () => timelineCoordinator?.ensureApprovalTicker(),
            respondApproval: (item, decision) => run(() => controller.respondApproval(item, decision)),
            respondInteraction: (interaction, response) => run(() => controller.respondInteraction(interaction, response)),
            openExternal: (url) => runtimeApi().sendOpenExternalLink?.(url),
            notifyInvalidJson: () => notify('MCP 表单 JSON 无效。', 'error'),
        },
    });
    const topicFlowView = createAgentWorkbenchTopicFlow({
        element: topicFlowLayer,
        document,
        actions: {
            close: closeTopicFlow,
            updateDraft(patch) {
                if (state.topicFlow?.kind === 'agent') Object.assign(state.topicFlow, patch);
            },
            submit(request) {
                run(async () => {
                    if (!state.topicFlow || state.topicFlow.kind !== 'agent' || state.topicFlow.saving) return;
                    state.topicFlow = { ...state.topicFlow, saving: true };
                    queueRender({ topicFlow: true });
                    try {
                        const result = await runtimeApi().agentRuntimeSaveAgentProfile?.(request);
                        if (!result?.success || !result.profile?.id) throw new Error(result?.error || 'Build Agent 创建失败。');
                        state.selectedAgent = result.profile.id;
                        state.topicFlow = null;
                        await refreshControlPlane();
                        state.tab = 'agents';
                        notify(`已创建 Build Agent「${result.profile.name || result.profile.id}」。`, 'success');
                    } finally {
                        if (state.topicFlow?.kind === 'agent') state.topicFlow = { ...state.topicFlow, saving: false };
                        queueRender({ shell: true, header: true, composer: true, topicFlow: true });
                    }
                });
            },
        },
    });

    function isMissingRememberedSessionError(error) {
        // The pointer is only a convenience preference. A Session may have
        // been permanently deleted since the previous Renderer lifetime.
        return /(?:Session was not found|NOT_FOUND)/i.test(String(error?.message || error || ''));
    }

    function uxMark(name, identity, startedAt = null) {
        const now = window.performance?.now?.() || Date.now();
        const shortId = String(identity || '').slice(0, 8);
        if (startedAt === null) state.uxTimings.set(name, now);
        const base = startedAt ?? state.uxTimings.get(name) ?? now;
        console.debug('[Agent UX]', { name, id: shortId, durationMs: Math.round((now - base) * 10) / 10 });
        return now;
    }

    timelineCoordinator = createAgentTimelineCoordinator({
        state, store, controller, lifecycle, window, document, root, refs: shellView.refs,
        runtimeApi: runtimeApi(), blockPresentation, approvalRegistry, cssEscape,
        selectedAgentProfile, activeSession, selectedSessionKey, selectedTurnStart,
        run, notify, scrollFeed, isFollowingContainer,
    });

    const sessionOperations = createAgentSessionOperationsCoordinator({
        state, store, controller, selectedAgentProfile, profileNeedsConfiguration,
        refreshControlPlane, queueRender, renderSidebar, notify, rememberTopic,
        clearRememberedTopic: () => {
            try { window.localStorage?.removeItem(LAST_TOPIC_STORAGE_KEY); } catch {}
        },
        nextSessionTitle, activeSession,
    });
    const {
        refreshRecoveryOperations, createTopic, createNewTopicDirectly, recoverRuntime,
        rememberTopicTitle, forgetTopic,
    } = sessionOperations;

    function openNewTopicFlow() {
        // New Session inherits the selected Profile and is created immediately;
        // only the separate New Build Agent flow remains modal.
        void run(createNewTopicDirectly);
    }

    function closeTopicFlow() {
        state.topicFlow = null;
        queueRender({ topicFlow: true });
    }

    function openNewAgentFlow() {
        state.topicFlow = {
            kind: 'agent',
            name: '',
            systemPrompt: '',
            model: state.model || '',
            workspaceRoot: '',
            permissionMode: 'ask',
            saving: false,
        };
        queueRender({ topicFlow: true });
    }

    const topicContextMenuView = createAgentTopicContextMenuView({
        document,
        window,
        node,
        visualActionButton,
        run,
        actions: {
            canOpen: () => !state.topicManaging,
            notify,
            openLive: (topic) => controller.hydrateTopic(topic.id, null, null, topic.agentId),
            async open(topic) {
                await controller.previewTopic(topic.id, topic.agentId, topic);
                rememberTopic({ topicId: topic.id });
            },
            async rename(topic) {
                const title = window.prompt?.('重命名 Agent Topic', topic.title || '');
                if (title === null || title === undefined || title.trim() === (topic.title || '').trim()) return;
                await controller.renameTopic(topic.id, title, topic.agentId);
                rememberTopicTitle(topic, title.trim());
                await refreshControlPlane();
                notify('Agent Topic 已重命名。', 'success');
            },
            async exportMarkdown(topic) {
                const result = await controller.exportSession(topic.id, 'markdown');
                if (result?.exported) notify('Agent 会话已导出。', 'success');
            },
            async archive(topic) {
                if (!window.confirm?.(`确定归档「${topic.title || topic.id}」吗？之后可从归档会话中恢复。`)) return;
                await controller.deleteTopic(topic.id, topic.agentId);
                state.composerStateBySession.delete(topic.id);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent 会话已归档。', 'success');
            },
            async restore(topic) {
                await controller.restoreSession(topic.id);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent 会话已恢复。', 'success');
            },
            async remove(topic) {
                if (!window.confirm?.(`永久删除「${topic.title || topic.id}」及其本地投影吗？此操作不可恢复。`)) return;
                await controller.permanentlyDeleteSession(topic.id);
                state.composerStateBySession.delete(topic.id);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent 会话已永久删除。', 'success');
            },
        },
    });
    const activityCoordinator = createAgentActivityCoordinator({
        state,
        store,
        document,
        node,
        refs: shellView.refs,
        sessionDockView,
        activityReadonlyView,
        approvalView,
        notificationView,
        workspaceView,
        workspaceCoordinator,
        queueRender,
        run,
        launchTerminal: async () => {
            const result = await runtimeApi().desktopLaunchVchatApp?.('open-powershell-executor-terminal');
            if (result && result.success === false) throw new Error(result.error || '无法打开 VChat 终端。');
        },
    });
    const {
        normalizeKind: normalizeDockKind,
        selectedSessionId: selectedDockSessionId,
        syncDock: syncSessionDock,
        clearUnread: clearActivityUnread,
        setOpen: setActivityOpen,
        maybeAutoOpen: maybeAutoOpenActivity,
        syncWorkspace: syncWorkspaceScope,
        loadDirectory: loadWorkspaceDirectory,
        openPreview: openWorkspacePreview,
        openFileTab: openWorkspaceFileTab,
        performPathAction: performWorkspaceAction,
        openSourcePath: openWorkspaceSourcePath,
        search: scheduleWorkspaceSearch,
        render: renderActivity,
    } = activityCoordinator;
    const closeTopicContextMenu = topicContextMenuView.close;
    const appendTopicActions = topicContextMenuView.appendActions;

    function renderSettingsSidebarContent() {
        return renderAgentSettingsPane({
            state,
            store,
            activeSession,
            sessionConfigRevisions,
            selectedAgentProfile,
            profileNeedsConfiguration,
            persistWorkbenchSettings,
            renderSidebar,
            runtimeApi,
            run,
            refreshControlPlane,
            notify,
            controller,
            refreshRecoveryOperations,
            refreshTopicsForAgent,
            node,
            button,
            sameAgent,
            settingValue(targetKey, field, fallback) {
                return settingsState.value(targetKey, field, fallback);
            },
            settingStatus(targetKey, fields) {
                return settingsState.status(targetKey, fields);
            },
            scheduleTextSave(targetKey, field, callback) {
                settingsState.schedule(targetKey, field, callback);
            },
            scheduleBudgetSave(callback) {
                budgetAutosaveTimer = lifecycle.timeout('budget-autosave', callback, 500);
            },
        });
    }

    function renderSidebar() {
        sidebarCoordinator?.render();
    }

    sidebarCoordinator = createAgentWorkbenchSidebarCoordinator({
        state, store, controller, element: sidebar, accountView, lifecycle, document, run, notify,
        sameAgent, agentCacheKey, selectedAgentProfile, profileNeedsConfiguration,
        sessionActivity, createSessionAvatar, appendTopicActions, closeTopicContextMenu,
        openNewTopicFlow, openNewAgentFlow, refreshControlPlane, refreshRecoveryOperations,
        refreshTopicsForAgent, selectAgent, rememberTopic, forgetTopic,
        syncModel: syncModelFromSelectedSession, renderSettings: renderSettingsSidebarContent,
        queueRender, uxMark,
    });

    function renderTopicFlow() {
        topicFlowView.update(state.topicFlow?.kind === 'agent'
            ? { ...state.topicFlow, modelCatalog: state.modelCatalog } : null);
    }

    function renderHeader() {
        syncPermissionModeFromSelectedSession();
        const session = activeSession();
        const current = store.getState();
        const viewState = deriveWorkbenchViewState(current);
        const selected = current.selectedTopic;
        const selectedHasRuntime = selected?.topicId && selected.topicId === session?.topicId;
        const headingTitle = selected?.title
            || (selectedHasRuntime ? session?.title : '')
            || `与 ${selected?.agentId || state.selectedAgent || 'Nova'} 聊天中`;
        const queuePanel = renderPendingInputQueue({
            state, controller, refresh: refreshControlPlane, notify, run, button, node,
        });
        headerView.update({
            title: headingTitle,
            state: viewState,
            stateLabel: WORKBENCH_VIEW_STATE_LABELS[viewState] || viewState,
            codexRuntime: current.runtime?.runtime === 'codex-app-server',
            pendingApprovals: (current.approvals || []).length,
            activityUnread: Number(current.activityUnread) || 0,
            alert: viewState === 'error' || viewState === 'reconnecting',
            activityOpen: state.activityOpen,
            queueLength: state.queue.length,
            queueOpen: state.queueOpen,
            usage: current.context,
            contextExpanded: state.activityOpen && normalizeDockKind(state.activityTab) === 'context',
            hasSession: Boolean(session),
            queuePanel,
        });
    }

    function renderFeed() {
        timelineCoordinator.render();
    }

    function renderJumpToLatest() {
        timelineCoordinator.renderJumpToLatest();
    }

    const composerCoordinator = createAgentComposerCoordinator({
        state, store, controller, composerView, runStatusView, refs: shellView.refs, run, notify,
        selectedSessionKey, selectedComposerState, selectedTurnStart, selectedActiveTurnId,
        renderFeed, renderJumpToLatest, queueRender, settleTurnStartIndicator,
        refreshControlPlane, uxMark, openNewTopicFlow, isFollowingContainer, scrollFeed,
    });
    const renderComposer = composerCoordinator.render;

    renderCoordinator = createAgentWorkbenchRenderCoordinator({
        state, store, lifecycle, sidebar, feed, sessionActivity, selectedSessionKey,
        selectedTurnStart, selectedDockSessionId, clearActivityUnread, maybeAutoOpenActivity,
        refreshControlPlane, uxMark, isFollowingContainer,
        renderers: {
            sidebar: renderSidebar,
            header: renderHeader,
            feed: renderFeed,
            activity: renderActivity,
            composer: renderComposer,
            topicFlow: renderTopicFlow,
            jumpToLatest: renderJumpToLatest,
        },
    });

    function render() {
        if (state.disposed) return;
        renderSidebar();
        renderHeader();
        renderFeed();
        renderActivity();
        renderComposer();
        renderTopicFlow();
    }

    const unsubscribe = store.subscribe((_nextState, event) => renderCoordinator.renderForStoreEvent(event));
    render();
    controller.initialize()
        .then(async () => {
            // A renderer reload restores SQLite only. The first actual send
            // starts or resumes the selected Codex Thread on demand.
            if (!store.getState().selectedSessionId && state.rememberedTopic?.topicId) {
                // Do not wait for model/catalog discovery before restoring
                // the visible history. Main validates the durable Session;
                // catalog data enriches the row in the background.
                const topicId = state.rememberedTopic.topicId;
                rememberTopic({ topicId });
                try {
                    await controller.previewTopic(topicId);
                } catch (error) {
                    if (!isMissingRememberedSessionError(error)) throw error;
                    // The pointer is not durable history. Forget only it;
                    // Main retains the empty Session and will write its first
                    // projection normally after a future Turn.
                    forgetTopic(topicId);
                }
            }
            await refreshControlPlane();
        })
        .catch((error) => notify(`Agent 页面初始化失败：${error?.message || error}`, 'error'));

    return () => {
        state.disposed = true;
        sessionCatalog.dispose();
        sessionOperations.dispose();
        settingsCoordinator.dispose();
        activityCoordinator.dispose();
        composerCoordinator.dispose();
        renderCoordinator.dispose();
        sidebarCoordinator.dispose();
        workspaceCoordinator.dispose();
        settingsState.dispose();
        topicContextMenuView.dispose();
        timelineCoordinator.dispose();
        activityReadonlyView.dispose();
        approvalView.dispose();
        notificationView.dispose();
        sessionDockView.dispose();
        topicFlowView.dispose();
        workspaceView.dispose();
        headerView.dispose();
        accountView.dispose();
        composerView.dispose();
        runStatusView.dispose();
        lifecycle.dispose();
        unsubscribe();
        controller.dispose();
        shellView.dispose();
    };
}

register({
    id: 'agent-workbench',
    title: 'VCPBuild',
    // Rounded-square "code" chip mirroring opencode's tab project-avatar:
    // a small filled tile with an inset ring and a code glyph inside.
    iconSvg: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="currentColor" fill-opacity="0.12"/><rect x="1.5" y="1.5" width="21" height="21" rx="5" stroke="currentColor" stroke-opacity="0.35" stroke-width="1"/><path d="m9.2 9.2-3 3 3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="m14.8 9.2 3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.2 7.5l-2.4 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    kind: 'internal',
    mount: mountWorkbench,
});
