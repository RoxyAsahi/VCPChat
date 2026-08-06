import { register } from './next-ui-apps.js';
import { createWorkbenchController } from './agent-workbench-controller.js';
import { deriveWorkbenchViewState } from './agent-workbench-store.js';
import { createAgentBlockPresentation } from './agent-presentation/index.js';
import { renderPendingInputQueue } from './agent-workbench-queue.js';
import { createWorkspaceRequestCoordinator } from './agent-workspace-requests.js';
import { createWorkbenchLifecycle } from './agent-workbench-lifecycle.js';
import { selectedSessionId } from './agent-selected-session.js';
import { createAgentSettingsState } from './agent-settings-state.js';
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
import { createAgentWorkspaceFeatureView } from './agent-workspace-feature.js';
import { createAgentWorkbenchHeaderView } from './agent-workbench-header-view.js';
import { createAgentWorkbenchAccountView } from './agent-workbench-account-view.js';
import { createAgentActivityReadonlyView } from './agent-activity-readonly-view.js';
import { createAgentSessionDockView } from './agent-session-dock-view.js';
import { createAgentNotificationView } from './agent-notification-view.js';
import { createAgentApprovalView } from './agent-approval-view.js';
import { createAgentWorkspaceCoordinator } from './agent-workspace-coordinator.js';
import { createAgentSettingsCoordinator } from './agent-settings-coordinator.js';
import { createAgentSettingsAdvancedFeature } from './agent-settings-advanced-feature.js';
import { createAgentProfileFlowFeature } from './agent-profile-flow-feature.js';
import { createAgentSessionManagementFeature } from './agent-session-management-feature.js';
import { createAgentSettingsPaneFeature } from './agent-settings-pane-feature.js';
import { createAgentToolSettingsModal } from './agent-tool-settings-modal.js';
import { createAgentSessionOperationsCoordinator } from './agent-session-operations-coordinator.js';
import { createAgentActivityCoordinator } from './agent-activity-coordinator.js';
import { createAgentComposerCoordinator } from './agent-composer-coordinator.js';
import { createAgentWorkbenchRenderCoordinator } from './agent-workbench-render-coordinator.js';
import { createAgentWorkbenchSidebarCoordinator } from './agent-workbench-sidebar-coordinator.js';
import { createAgentTimelineCoordinator } from './agent-timeline-coordinator.js';
import { createAgentSessionViewContext } from './agent-session-view-context.js';
import { createAgentWorkbenchState } from './agent-workbench-state.js';
import { createAgentWorkbenchHostAdapter } from './agent-workbench-host-adapter.js';
import {
    agentCacheKey,
    createAgentSessionCatalogCoordinator,
    sameAgent,
    seedBuildAgentCatalog,
} from './agent-session-catalog-coordinator.js';
import {
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
} from './agent-workbench-runtime-helpers.js';
import {
    clearLegacyRememberedSession,
    createNavigationIdentityObserver,
    forgetAgentSession,
    migrateLegacyRememberedSession,
    rememberedSessionForAgent,
    restoreRememberedSessionSafely,
} from './agent-navigation-memory.js';
function mountWorkbench(container) {
    const host = createAgentWorkbenchHostAdapter({ windowRef: window, documentRef: document });
    const lifecycle = createWorkbenchLifecycle(window);
    const scopedScrollFeed = (target, force) => scrollFeed(
        target, force, (callback) => lifecycle.frame('scroll-feed', callback), host.vcpBridge,
    );
    const controller = createWorkbenchController(runtimeApi());
    const { store } = controller;
    const state = createAgentWorkbenchState({
        window, agentCatalog: seedBuildAgentCatalog(), rememberedTopic: loadRememberedTopic(),
    });
    const unsubscribeNavigationIdentity = createNavigationIdentityObserver({ store, state, rememberTopic });
    const sessionViewContext = createAgentSessionViewContext({ state, store, document, sameAgent });
    const {
        activeSession, selectedSessionKey, selectedComposerState, selectedTurnStart,
        selectedActiveTurnId, sessionActivity, createSessionAvatar,
    } = sessionViewContext;
    const syncPermissionModeFromSelectedSession = sessionViewContext.syncPermissionMode;
    const syncModelFromSelectedSession = sessionViewContext.syncModel;
    let renderCoordinator = null, toolSettingsModal = null;
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
            openToolSettings: () => void toolSettingsModal?.open(),
            setActivityOpen: (open) => setActivityOpen(open),
        },
    });
    const {
        root, topicFlowLayer, sidebar, main, feed, feedItems, jumpToLatest, header,
        runStatus, runStatusLabel, runStatusDetail, runStatusElapsed, runStatusStop,
        runningModes, steerModeButton, followUpModeButton, queuePanelHost, inputCard, input,
        newButton, attachButton, permissionsButton, sendButton, attachmentTray,
        activityPanel, activitySplitter,
    } = shellView.refs;
    const runStatusView = createAgentWorkbenchRunStatusView({ refs: shellView.refs, lifecycle });
    const composerView = createAgentWorkbenchComposerView({ refs: shellView.refs, document });
    const headerView = createAgentWorkbenchHeaderView({
        element: header,
        document,
        lifecycle,
        actions: {
            reconnect: () => run(recoverRuntime),
            renameTitle: async ({ sessionId, agentId, title }) => {
                const selected = store.getState().selectedTopic;
                if (!selected?.sessionId || selected.sessionId !== sessionId) {
                    throw new Error('当前会话已切换，未保存重命名。');
                }
                await controller.renameSession(sessionId, title, agentId);
                const current = store.getState();
                if (current.selectedTopic?.sessionId === sessionId) {
                    store.setState({ selectedTopic: { ...current.selectedTopic, title } });
                }
                rememberTopicTitle(selected, title);
                // A catalog refresh schedules a full shell render, which can replace a focused
                // Composer during a concurrent stream. The rename is already durable; patch
                // only the locally cached session rows needed by the sidebar.
                const patchTitle = (topic) => {
                    if (!topic || String(topic.sessionId || topic.id || '') !== String(sessionId)) return topic;
                    return { ...topic, title };
                };
                state.topics = state.topics.map(patchTitle);
                const cacheKey = agentCacheKey(agentId || state.selectedAgent);
                const cachedTopics = state.topicsByAgent.get(cacheKey);
                if (Array.isArray(cachedTopics)) {
                    state.topicsByAgent.set(cacheKey, cachedTopics.map(patchTitle));
                }
                renderSidebar();
                notify('会话已重命名。', 'success');
            },
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
        host,
        actions: {
            openThemes: () => controller.openThemes(),
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
    const workspaceView = createAgentWorkspaceFeatureView({
        document, run, state, render: () => renderActivity(),
        loadDirectory: (path) => loadWorkspaceDirectory(path), openPreview: (ref) => openWorkspacePreview(ref),
        openFileTab: (ref) => openWorkspaceFileTab(ref),
        performPathAction: (ref, action) => performWorkspaceAction(ref, action),
        saveText: (ref) => saveWorkspaceText(ref), search: (value) => scheduleWorkspaceSearch(value),
        onBinaryPreview: () => activitySplitter.classList.remove('is-active'),
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
            sessionId: selectedSessionId(current) || '',
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
            saveText: (request) => controller.workspaceSaveText(request),
            watch: (request) => controller.workspaceWatch(request),
            unwatch: (request) => controller.workspaceUnwatch(request),
            subscribeChanges: (listener) => controller.workspaceSubscribeChanges(listener),
            performPathAction: (request) => controller.workspacePerformPathAction(request),
            searchFiles: (request) => controller.workspaceSearchFiles(request),
        },
    });
    const settingsState = createAgentSettingsState({ lifecycle });
    runStatusStop.addEventListener('click', () => run(async () => {
        runStatusStop.disabled = true;
        await controller.cancelTurn();
    }));

    const sessionCatalog = createAgentSessionCatalogCoordinator({
        state,
        store,
        controller,
        listAgentProfiles: () => controller.listAgentProfiles(),
        getCachedModels: () => controller.getCachedModels(),
        refreshModels: () => controller.refreshModels(),
        onModelsUpdated: (callback) => controller.onModelsUpdated(callback),
        queueRender,
        syncPermissionModeFromSelectedSession,
        syncModelFromSelectedSession,
        uxMark,
        requestAnimationFrame: (callback) => lifecycle.frame('session-catalog-paint', callback),
    });
    const {
        selectedAgentProfile,
        profileNeedsConfiguration,
        selectAgent,
        refreshTopicsForAgent,
        refreshControlPlane,
        refreshModelCatalog,
    } = sessionCatalog;
    const settingsCoordinator = createAgentSettingsCoordinator({
        state,
        store,
        settingsState,
        controller,
        selectedAgentProfile,
        selectAgent,
        saveAgentProfile: (request) => controller.saveAgentProfile(request),
        refreshTopicsForAgent,
        notify,
        refreshViews: ({ phase, payload } = {}) => {
            const structuralChange = phase === 'settled' && payload && (
                Object.prototype.hasOwnProperty.call(payload, 'instructionMode')
                || Object.prototype.hasOwnProperty.call(payload, 'name')
                || payload.createDerivedSession === true
            );
            if (structuralChange) renderSidebar();
            else refreshSettingsStatus();
            renderHeader();
        },
    });
    const { persist: persistWorkbenchSettings, sessionConfigRevisions } = settingsCoordinator;
    toolSettingsModal = createAgentToolSettingsModal({ store, controller, settingsState, activeSession, selectedSessionKey, selectedAgentProfile, persistWorkbenchSettings, host, root, document, node, notify });

    const approvalRegistry = new Map();
    let timelineCoordinator = null;
    const blockPresentation = createAgentBlockPresentation({
        document,
        renderContent: (text) => renderMarkdown(text, host.markdown),
        postRender: (node) => postRender(node, host.markdown),
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
            openExternal: (url) => controller.openExternal(url),
            notifyInvalidJson: () => notify('MCP 表单 JSON 无效。', 'error'),
        },
    });
    const profileFlowFeature = createAgentProfileFlowFeature({
        state,
        controller,
        element: topicFlowLayer,
        document,
        run,
        queueRender,
        refreshControlPlane,
        notify,
    });

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
        rendererHost: {
            sendOpenExternalLink: (url) => controller.openExternal(url),
            openImageViewer: (payload) => controller.openImageViewer(payload),
            showImageContextMenu: (src) => controller.showImageContextMenu(src),
        }, blockPresentation, approvalRegistry, cssEscape,
        selectedAgentProfile, activeSession, selectedSessionKey, selectedTurnStart,
        run, notify, queueRender, scrollFeed: scopedScrollFeed,
        isFollowingContainer: (target) => isFollowingContainer(target, host.vcpBridge), host,
    });
    const sessionOperations = createAgentSessionOperationsCoordinator({
        state, store, controller, selectedAgentProfile, profileNeedsConfiguration,
        refreshControlPlane, queueRender, renderSidebar, notify, rememberTopic,
        clearRememberedTopic,
        forgetRememberedSession: forgetAgentSession,
        nextSessionTitle, activeSession,
    });
    const {
        refreshRecoveryOperations, createSession, createNewTopicDirectly, recoverRuntime,
        rememberTopicTitle, forgetTopic,
    } = sessionOperations;

    const advancedSettingsFeature = createAgentSettingsAdvancedFeature({
        state, store, settingsState, controller, document, lifecycle, host, run, notify,
        refreshControlPlane, renderSidebar, persistWorkbenchSettings,
        refreshRecoveryOperations, refreshTopicsForAgent,
    });
    function openNewSession() {
        // New Session inherits the selected Profile and is created immediately;
        // only the separate New Build Agent flow remains modal.
        void run(createNewTopicDirectly);
    }
    const sessionManagementFeature = createAgentSessionManagementFeature({
        state, controller, document, window, node, visualActionButton, run, host, notify,
        rememberTopic, rememberTopicTitle, forgetTopic, refreshControlPlane,
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
            const result = await controller.launchVchatApp('open-powershell-executor-terminal');
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
        saveText: saveWorkspaceText,
        openSourcePath: openWorkspaceSourcePath,
        search: scheduleWorkspaceSearch,
        render: renderActivity,
    } = activityCoordinator;
    const closeSessionContextMenu = sessionManagementFeature.close;
    const appendSessionActions = sessionManagementFeature.appendActions;
    const settingsPaneFeature = createAgentSettingsPaneFeature({
        state, store, sidebar, settingsState, advancedSettingsFeature, activeSession,
        sessionConfigRevisions, selectedAgentProfile, profileNeedsConfiguration,
        persistWorkbenchSettings, renderSidebar, run, refreshControlPlane, refreshModelCatalog, notify, controller,
        refreshRecoveryOperations, refreshTopicsForAgent, node, button, sameAgent, host,
    });
    const renderSettingsSidebarContent = settingsPaneFeature.render;

    function renderSidebar() {
        sidebarCoordinator?.render();
    }

    const refreshSettingsStatus = settingsPaneFeature.refreshStatus;

    sidebarCoordinator = createAgentWorkbenchSidebarCoordinator({
        state, store, controller, element: sidebar, accountView, lifecycle, document, run, notify,
        sameAgent, agentCacheKey, selectedAgentProfile, profileNeedsConfiguration,
        sessionActivity, createSessionAvatar, appendSessionActions, closeSessionContextMenu,
        openNewSession, openNewAgentFlow: profileFlowFeature.open, refreshControlPlane, refreshRecoveryOperations,
        refreshTopicsForAgent, selectAgent, rememberTopic, forgetTopic, host,
        rememberedSessionForAgent, forgetRememberedSession: forgetAgentSession,
        syncModel: syncModelFromSelectedSession, renderSettings: renderSettingsSidebarContent,
        queueRender, uxMark,
    });

    function renderTopicFlow() {
        profileFlowFeature.render();
    }

    function renderHeader() {
        syncPermissionModeFromSelectedSession();
        const session = activeSession();
        const current = store.getState();
        const viewState = deriveWorkbenchViewState(current);
        const activeTurnId = selectedActiveTurnId(current);
        const queuePanel = renderPendingInputQueue({
            state, controller, refresh: refreshControlPlane, notify, run, button, node, host,
            guidePrompt: (prompt) => {
                const sessionId = selectedSessionKey(current);
                if (!sessionId) return;
                state.composerStateBySession.setDraft(sessionId, prompt);
                renderComposer();
                input.focus();
            },
        });
        queuePanelHost.replaceChildren();
        if (queuePanel) queuePanelHost.append(queuePanel);
        headerView.update(buildWorkbenchHeaderModel({
            state, current, session, viewState, activeTurnId,
            contextExpanded: state.activityOpen && normalizeDockKind(state.activityTab) === 'context',
        }));
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
        refreshControlPlane, uxMark, openNewSession, isFollowingContainer, scrollFeed: scopedScrollFeed,
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

    const unsubscribe = advancedSettingsFeature.subscribe((event) => renderCoordinator.renderForStoreEvent(event), () => state.tab === 'settings' && state.settingsScope === 'advanced');
    render();
    controller.initialize()
        .then(async () => {
            // A renderer reload restores SQLite only. The first actual send
            // starts or resumes the selected Codex Thread on demand.
            if (!store.getState().selectedSessionId && state.rememberedTopic?.sessionId) {
                // Do not wait for model/catalog discovery before restoring
                // the visible history. Main validates the durable Session;
                // catalog data enriches the row in the background.
                await restoreRememberedSessionSafely({
                    state, store, controller, remembered: state.rememberedTopic,
                    rememberTopic, migrateLegacy: migrateLegacyRememberedSession,
                    clearLegacy: clearLegacyRememberedSession,
                    onMissing: (sessionId) => forgetTopic(sessionId),
                });
            }
            await refreshControlPlane();
        })
        .catch((error) => notify(`Agent 页面初始化失败：${error?.message || error}`, 'error'));

    return () => {
        state.disposed = true;
        unsubscribeNavigationIdentity();
        sessionCatalog.dispose();
        sessionOperations.dispose();
        settingsCoordinator.dispose();
        toolSettingsModal.dispose();
        advancedSettingsFeature.dispose();
        activityCoordinator.dispose();
        composerCoordinator.dispose();
        renderCoordinator.dispose();
        sidebarCoordinator.dispose();
        workspaceCoordinator.dispose();
        settingsState.dispose();
        sessionManagementFeature.dispose();
        timelineCoordinator.dispose();
        activityReadonlyView.dispose();
        approvalView.dispose();
        notificationView.dispose();
        sessionDockView.dispose();
        profileFlowFeature.dispose();
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
    title: 'VCPBUILD',
    // Rounded-square "code" chip mirroring opencode's tab project-avatar:
    // a small filled tile with an inset ring and a code glyph inside.
    iconSvg: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="currentColor" fill-opacity="0.12"/><rect x="1.5" y="1.5" width="21" height="21" rx="5" stroke="currentColor" stroke-opacity="0.35" stroke-width="1"/><path d="m9.2 9.2-3 3 3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="m14.8 9.2 3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.2 7.5l-2.4 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    kind: 'internal',
    mount: mountWorkbench,
});
