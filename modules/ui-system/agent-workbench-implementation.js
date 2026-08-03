import { register } from './next-ui-apps.js';
import { createWorkbenchController } from './agent-workbench-controller.js';
import { projectSession } from './agent-workbench-projections.js';
import { deriveWorkbenchViewState } from './agent-workbench-store.js';
import {
    createAgentTimelineParts,
    projectVcpToolPresentation,
    reconcileAgentTimeline,
} from './agent-workbench-timeline.js';
import { createAgentBlockPresentation, createAgentMessagePresentation } from './agent-presentation/index.js';
import { createWorkspacePathRef, createWorkspaceTreeModel } from './agent-workspace-model.js';
import { createSessionDockModel } from './agent-session-dock.js';
import { renderPendingInputQueue } from './agent-workbench-queue.js';
import { createAgentComposerState } from './agent-composer-state.js';
import { createWorkspaceRequestCoordinator } from './agent-workspace-requests.js';
import { createWorkbenchLifecycle } from './agent-workbench-lifecycle.js';
import { renderAgentSettingsPane } from './agent-settings-view.js';
import {
    createAgentSettingsState,
    profileSettingsTarget,
    sessionSettingsTarget,
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
import { createAgentWorkbenchSidebarView } from './agent-workbench-sidebar-view.js';
import { createAgentSessionDockView } from './agent-session-dock-view.js';
import { createAgentNotificationView } from './agent-notification-view.js';
import { createAgentApprovalView } from './agent-approval-view.js';
import { createAgentWorkbenchTopicFlow } from './agent-workbench-topic-flow.js';
import { createAgentWorkspaceCoordinator } from './agent-workspace-coordinator.js';

// Build Agent identities are independent from normal-chat Agents. Keep Nova
// visible synchronously while the authoritative Build catalog loads.
const NOVA_CATALOG_FALLBACK = Object.freeze({
    id: 'Nova', name: 'Nova', model: '', systemPrompt: '{{Nova}}', avatarUrl: null,
});

function seedBuildAgentCatalog() { return [{ ...NOVA_CATALOG_FALLBACK }]; }

function reasoningEffortsForModel(model) {
    if (!model || typeof model !== 'object') return [];
    const values = [
        model.reasoningEfforts,
        model.reasoning_efforts,
        model.supportedReasoningEfforts,
        model.supported_reasoning_efforts,
        model.capabilities?.reasoningEfforts,
        model.capabilities?.reasoning_efforts,
        model.metadata?.reasoningEfforts,
        model.metadata?.reasoning_efforts,
    ].find(Array.isArray);
    return values ? [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))] : [];
}

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
    const state = {
        tab: 'agents',
        selectedAgent: 'Nova',
        agentCatalog: seedBuildAgentCatalog(),
        agentSearch: '',
        modelCatalog: [],
        topics: [],
        topicsByAgent: new Map(),
        archivedTopicsByAgent: new Map(),
        showArchivedTopics: false,
        topicListLoading: false,
        topicSearch: '',
        topicSearchResults: [],
        topicSearchLoading: false,
        topicSearchError: '',
        topicSearchOpen: false,
        topicManaging: false,
        topicSelectedIds: new Set(),
        queue: [],
        queueOpen: false,
        budget: { maxRequestsPerTurn: null, maxTokensPerTurn: null },
        budgetSaving: false,
        settingsSaveState: 'idle',
        settingsSaveMessage: '',
        settingsScope: 'profile',
        settingsSaveByScope: new Map([
            ['profile', { state: 'idle', message: '' }],
            ['session', { state: 'idle', message: '' }],
            ['advanced', { state: 'idle', message: '' }],
        ]),
        recoveryOperations: [],
        recoveryThreads: [],
        recoveryLoading: false,
        recoveryError: '',
        // This is deliberately local-client policy only.  It never changes
        // VCPToolBox's independent backend approval policy.
        permissionMode: 'ask',
        permissionSaving: false,
        modelSaving: false,
        avatarSaving: false,
        // Draft model value for the selected Session.  It is intentionally
        // kept separate from the durable configSnapshot until Save succeeds.
        modelDraft: null,
        modelDraftSessionId: null,
        recovering: false,
        activityOpen: false,
        activityPanelWidth: 420,
        activityTab: 'notifications',
        sessionDock: createSessionDockModel(window.sessionStorage),
        dockMenuOpen: false,
        lastViewState: null,
        hadApprovals: false,
        workspace: '',
        workspaceBrowser: {
            scope: '',
            sessionId: '',
            workspaceRevision: '',
            model: createWorkspaceTreeModel(),
            inflight: new Map(),
            inflightRequestIds: new Map(),
            previewRequestId: '',
            searchRequestId: '',
            error: '',
            preview: null,
            previewLoading: false,
            search: '',
            searchResults: [],
            searchLoading: false,
            selectedPath: '',
            splitPercent: 46,
        },
        model: 'gpt-5.6-terra',
        composerStateBySession: createAgentComposerState(),
        rememberedTopic: loadRememberedTopic(),
        // A purely visual reading aid.  It records neither transcript content
        // nor Runtime state; it only lets a reader return to the live edge
        // after intentionally browsing older timeline Parts.
        followingFeed: true,
        unreadTimelineCount: 0,
        // Keyed by Codex-owned messageId/toolCallId. This is a DOM cache only;
        // it never contains a transcript beyond the current renderer view.
        timelineRows: new Map(),
        // Renderer-only send barriers, isolated by durable Session identity.
        // They are never written to SQLite and must never disable or decorate
        // another Session while thread/start is still in flight.
        turnStarts: new Map(),
        topicCreating: false,
        profileConfigurationNotice: '',
        // This is deliberately a transient UI flow, not a second Session
        // store. SQLite remains the durable source of the Session projection;
        // the renderer only keeps the currently-open form and a small
        // read-only snapshot summary while the dialog is visible.
        topicFlow: null,
        // A document-level popover is intentionally transient. It is never
        // used as Session state: SQLite owns display metadata while Codex owns
        // Thread execution and mutations.
        topicContextMenu: null,
        uxTimings: new Map(),
        turnStartedAt: new Map(),
        disposed: false,
    };
    const pendingRender = { shell: false, header: false, feed: false, composer: false, activity: false };
    let renderFrame = null;
    // Control-plane replies can arrive after a user picked another Agent.
    // Keep the latest selection authoritative; an older Topic list must not
    // replace the newly selected Agent's history.
    let controlPlaneRequest = 0;
    let topicCatalogRequest = 0;
    let topicMenuInstance = 0;

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
    let sidebarView = null;

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
    const sessionConfigRevisions = new Map();
    runStatusStop.addEventListener('click', () => run(async () => {
        runStatusStop.disabled = true;
        await controller.cancelTurn();
    }));

    const approvalRegistry = new Map();
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
            ensureTicker: ensureApprovalTicker,
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

    function presentationSessionContext() {
        const current = store.getState();
        const profile = selectedAgentProfile() || {};
        const selected = current.selectedTopic || {};
        const runtime = activeSession();
        const snapshot = runtime?.configSnapshot || selected.configSnapshot || {};
        return {
            sessionId: current.selectedSessionId || selected.topicId || null,
            threadId: runtime?.threadId || selected.threadId || null,
            participant: {
                id: selected.agentId || profile.id || state.selectedAgent,
                name: snapshot.agentName || selected.agentName || profile.name || selected.agentId || state.selectedAgent || 'Nova',
                avatarUrl: snapshot.agentAvatar || selected.avatarUrl || profile.avatarUrl || '',
                colors: profile.colors || profile.config?.colors || {},
                config: profile.config || profile,
            },
            messages: current.messages || [],
            settings: window.globalSettings || {},
        };
    }

    function promptForPart(part) {
        const messages = store.getState().messages || [];
        const index = messages.findIndex((message) => (message.id || message.messageId) === part.id);
        const candidates = index >= 0 ? messages.slice(0, index + 1).reverse() : messages.slice().reverse();
        const user = candidates.find((message) => message.role === 'user' && typeof message.content === 'string');
        return user?.content || (typeof part.value?.content === 'string' ? part.value.content : '');
    }

    async function forkAndSend(part, prompt, title) {
        const context = presentationSessionContext();
        await controller.forkSession({ sessionId: context.sessionId, turnId: part.turnId, title });
        if (prompt?.trim()) await controller.startTurn(prompt.trim(), []);
    }

    const fullPresentation = createAgentMessagePresentation({
        window,
        document,
        container: feedItems,
        getSessionContext: presentationSessionContext,
        nonMessageCallbacks: blockPresentation.timelineCallbacks,
        electronAPI: runtimeApi(),
        scrollToBottom: () => scrollFeed(feed, true),
        notify,
        actions: {
            copy: async ({ text: value }) => {
                await navigator.clipboard.writeText(value);
                notify('已复制渲染后的文本。', 'success');
            },
            interrupt: ({ part }) => run(async () => {
                await controller.cancelTurn();
                notify(`已请求中止 ${part.turnId || '当前 Turn'}。`, 'success');
            }),
            fork: ({ part }) => run(async () => {
                await controller.forkSession({
                    sessionId: presentationSessionContext().sessionId,
                    turnId: part.turnId,
                    title: 'Agent 分支',
                });
                notify('已创建 Codex 会话分支。', 'success');
            }),
            retry: ({ part }) => run(async () => {
                await forkAndSend(part, promptForPart(part), '从消息重试');
                notify('已在新 Codex 分支重试。', 'success');
            }),
            edit: ({ part }) => {
                const original = promptForPart(part);
                const edited = window.prompt?.('编辑并在新 Codex 分支发送', original);
                if (edited === null || edited === undefined || !edited.trim()) return;
                run(async () => {
                    await forkAndSend(part, edited, '编辑消息分支');
                    notify('已在新 Codex 分支发送编辑内容。', 'success');
                });
            },
            forward: ({ part }) => run(async () => {
                const value = typeof part.value?.content === 'string' ? part.value.content : promptForPart(part);
                await navigator.clipboard.writeText(value || '');
                notify('Agent 消息已复制；可粘贴到目标 VChat 会话。', 'success');
            }),
        },
    });
    fullPresentation.bindInteractions();

    // One renderer-only ticker keeps Host-owned deadlines visible. It never
    // resolves an approval; Main's approval.resolved event is the sole
    // authoritative terminal transition.
    let approvalTicker = null;
    function ensureApprovalTicker() {
        if (approvalTicker) return;
        approvalTicker = lifecycle.interval('approval-ticker', () => {
            const now = Date.now();
            for (const [id, entry] of approvalRegistry) {
                const cards = root.querySelectorAll(`[data-approval-id="${cssEscape(id)}"]`);
                if (!cards.length) continue;
                const remaining = entry.deadline - now;
                const expired = remaining <= 0;
                cards.forEach((card) => {
                    const label = card.querySelector('.agent-chat-approval-countdown');
                    if (expired) {
                        if (!entry.expired) {
                            entry.expired = true;
                            card.classList.add('agent-chat-approval-expired');
                            if (label) label.textContent = '等待 Codex App Server 确认超时拒绝';
                            const approvalLive = card.querySelector('.agent-chat-approval-live');
                            if (approvalLive) approvalLive.textContent = '审批截止时间已到，等待 Codex App Server 最终事件。';
                        }
                    } else if (label) {
                        label.textContent = `默认拒绝 · Codex App Server ${Math.ceil(remaining / 1000)}s 后处理`;
                    }
                });
                if (expired) {
                    approvalRegistry.delete(id);
                    continue;
                }
            }
            if (approvalRegistry.size === 0 && approvalTicker) {
                lifecycle.clear('approval-ticker');
                approvalTicker = null;
            }
        }, 500);
    }

    function activeSession() {
        const current = store.getState();
        const sessionId = current.selectedSessionId || current.selectedTopic?.topicId;
        return sessionId && current.activeRuntimes instanceof Map
            ? current.activeRuntimes.get(sessionId) || null
            : null;
    }

    function selectedSessionKey(current = store.getState()) {
        return current.selectedSessionId || current.selectedTopic?.topicId || null;
    }

    function selectedComposerState(current = store.getState()) {
        return state.composerStateBySession.get(selectedSessionKey(current));
    }

    function selectedTurnStart(current = store.getState()) {
        const sessionId = selectedSessionKey(current);
        return sessionId ? state.turnStarts.get(sessionId) || null : null;
    }

    function selectedActiveTurnId(current = store.getState()) {
        const sessionId = selectedSessionKey(current);
        const runtime = sessionId && current.activeRuntimes instanceof Map
            ? current.activeRuntimes.get(sessionId) : null;
        return current.activeTurnId || runtime?.activeTurnId || null;
    }

    function profileNeedsConfiguration(profile = selectedAgentProfile()) {
        const agentId = String(profile?.id || profile?.name || '').trim();
        const instructionMode = profile?.instructionMode === 'codex-managed' ? 'codex-managed' : 'vchat-identity';
        return Boolean(agentId && instructionMode === 'vchat-identity'
            && !String(profile?.baseInstructions || profile?.systemPrompt || '').trim());
    }

    function syncPermissionModeFromSelectedSession() {
        const current = store.getState();
        const snapshot = current.selectedTopic?.configSnapshot || null;
        if (!snapshot || (!Object.prototype.hasOwnProperty.call(snapshot, 'permissionMode')
            && !Object.prototype.hasOwnProperty.call(snapshot, 'approvalPolicy'))) return;
        // The selected Session snapshot is the same source that Main passes
        // to Codex on the next turn. The page-level value is only a default
        // for creating a new Session and must not overwrite this projection.
        state.permissionMode = snapshot.permissionMode
            || (snapshot.approvalPolicy === 'never' ? 'always-approve' : 'ask');
    }

    function syncModelFromSelectedSession() {
        const current = store.getState();
        const selectedSessionId = current.selectedSessionId || current.selectedTopic?.topicId || '';
        if (state.modelDraftSessionId !== selectedSessionId) {
            state.modelDraftSessionId = selectedSessionId;
            state.modelDraft = null;
        }
        const snapshot = current.selectedTopic?.configSnapshot || null;
        const selectedModel = typeof snapshot?.model === 'string' ? snapshot.model.trim() : '';
        if (selectedModel && state.modelDraft === null) state.model = selectedModel;
    }

    function sameAgent(left, right) {
        return String(left || '').trim().toLocaleLowerCase()
            === String(right || '').trim().toLocaleLowerCase();
    }

    function isMissingRememberedSessionError(error) {
        // The pointer is only a convenience preference. A Session may have
        // been permanently deleted since the previous Renderer lifetime.
        return /(?:Session was not found|NOT_FOUND)/i.test(String(error?.message || error || ''));
    }

    function selectedAgentProfile() {
        return state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, state.selectedAgent)) || null;
    }

    function agentAvatarUrl(agentId) {
        return state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, agentId))?.avatarUrl
            || 'assets/default_avatar.png';
    }

    function sessionActivity(sessionId, fallback = 'idle') {
        const current = store.getState();
        const runtime = sessionId && current.activeRuntimes instanceof Map
            ? current.activeRuntimes.get(sessionId) : null;
        if (runtime?.activity) return runtime.activity;
        if (runtime?.activeTurnId) return 'running';
        if (sessionId && state.turnStarts.has(sessionId)) return 'starting';
        return fallback || 'idle';
    }

    function createSessionAvatar(sessionId, agentId, label, activity = 'idle') {
        const wrap = node('span', 'agent-chat-session-avatar');
        const resolvedActivity = sessionActivity(sessionId, activity);
        wrap.dataset.activity = resolvedActivity;
        wrap.classList.toggle('is-running', ['starting', 'running'].includes(resolvedActivity));
        wrap.classList.toggle('is-awaiting-approval', resolvedActivity === 'awaiting-approval');
        const avatar = document.createElement('img');
        avatar.className = 'avatar';
        avatar.loading = 'lazy';
        avatar.decoding = 'async';
        avatar.src = agentAvatarUrl(agentId);
        avatar.alt = label;
        avatar.onerror = () => { avatar.src = 'assets/default_avatar.png'; };
        wrap.append(avatar);
        return wrap;
    }

    function selectAgent(agentId) {
        const profile = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, agentId));
        if (!profile) return;
        state.selectedAgent = profile.id || profile.name;
        // Profile defaults are the only source for a future Session. Never
        // retain model/workspace/approval drafts from the previously selected
        // Agent; existing Sessions continue to use their frozen snapshots.
        state.model = profile.model || '';
        state.workspace = profile.workspaceRoot || '';
        state.permissionMode = profile.permissionMode === 'always-approve' ? 'always-approve' : 'ask';
        state.modelDraft = null;
        state.modelDraftSessionId = null;
    }

    function agentCacheKey(agentId) {
        return String(agentId || '').trim().toLocaleLowerCase();
    }

    function uxMark(name, identity, startedAt = null) {
        const now = window.performance?.now?.() || Date.now();
        const shortId = String(identity || '').slice(0, 8);
        if (startedAt === null) state.uxTimings.set(name, now);
        const base = startedAt ?? state.uxTimings.get(name) ?? now;
        console.debug('[Agent UX]', { name, id: shortId, durationMs: Math.round((now - base) * 10) / 10 });
        return now;
    }

    async function refreshTopicsForAgent(agentId, archived = state.showArchivedTopics) {
        const selectedAgentId = String(agentId || state.selectedAgent || 'Nova').trim();
        const key = agentCacheKey(selectedAgentId);
        const cache = archived ? state.archivedTopicsByAgent : state.topicsByAgent;
        const cached = cache.get(key);
        state.topics = Array.isArray(cached) ? cached : [];
        state.topicListLoading = !cached;
        queueRender({ shell: true, header: true, composer: true });
        if (cached) {
            const clickedAt = state.uxTimings.get(`agent-click:${key}`) || null;
            (window.requestAnimationFrame || ((callback) => setTimeout(callback, 0)))(() => {
                uxMark('session-cache-painted', selectedAgentId, clickedAt);
            });
        }
        const request = ++topicCatalogRequest;
        try {
            const topics = await controller.listTopics(selectedAgentId, { archived });
            if (state.disposed || request !== topicCatalogRequest || !sameAgent(selectedAgentId, state.selectedAgent)) return;
            const received = Array.isArray(topics) ? topics : topics?.topics || [];
            // Main has already resolved canonical Agent identity. Renderer
            // must not repeat legacy name/folder-id guessing here.
            cache.set(key, received);
            state.topics = received;
            uxMark('projection-list-returned', selectedAgentId, state.uxTimings.get(`agent-click:${key}`) || null);
            const clickedAt = state.uxTimings.get(`agent-click:${key}`) || null;
            (window.requestAnimationFrame || ((callback) => setTimeout(callback, 0)))(() => {
                uxMark('session-cache-painted', selectedAgentId, clickedAt);
            });
        } finally {
            if (!state.disposed && request === topicCatalogRequest && sameAgent(selectedAgentId, state.selectedAgent)) {
                state.topicListLoading = false;
                queueRender({ shell: true, header: true, composer: true });
            }
        }
    }

    async function refreshControlPlane() {
        const request = ++controlPlaneRequest;
        const optional = (fn) => Promise.resolve().then(fn).catch(() => []);
        // Build profiles are isolated from the normal-chat Agent directory.
        const sharedAgents = await optional(() => runtimeApi().agentRuntimeListAgentProfiles?.());
        const normalizedAgents = Array.isArray(sharedAgents)
            ? sharedAgents.map((agent) => ({
                id: agent.id || agent.name,
                name: agent.name || agent.id,
                model: agent.config?.model || agent.model || '',
                instructionMode: (agent.config?.instructionMode || agent.instructionMode) === 'codex-managed'
                    ? 'codex-managed' : 'vchat-identity',
                baseInstructions: agent.config?.baseInstructions || agent.baseInstructions
                    || agent.config?.systemPrompt || agent.systemPrompt || '',
                systemPrompt: agent.config?.systemPrompt || agent.systemPrompt || '',
                developerInstructions: agent.config?.developerInstructions || agent.developerInstructions || '',
                personality: ['friendly', 'pragmatic'].includes(agent.config?.personality || agent.personality)
                    ? (agent.config?.personality || agent.personality) : 'none',
                reasoningEffort: agent.config?.reasoningEffort || agent.reasoningEffort || null,
                reasoningEfforts: Array.isArray(agent.config?.reasoningEfforts || agent.reasoningEfforts)
                    ? (agent.config?.reasoningEfforts || agent.reasoningEfforts) : [],
                workspaceRoot: agent.config?.workspaceRoot || agent.workspaceRoot || '',
                permissionMode: (agent.config?.permissionMode || agent.permissionMode) === 'always-approve'
                    ? 'always-approve' : 'ask',
                revision: Number(agent.config?.revision || agent.revision || 1),
                profileRevision: Number(agent.config?.profileRevision || agent.profileRevision
                    || agent.config?.revision || agent.revision || 1),
                avatarUrl: agent.avatarUrl || null,
                configurationRequired: Boolean(
                    (agent.config?.instructionMode || agent.instructionMode) !== 'codex-managed'
                    && !String(agent.config?.baseInstructions || agent.baseInstructions
                        || agent.config?.systemPrompt || agent.systemPrompt || '').trim(),
                ),
            }))
            : [];
        if (!normalizedAgents.some((agent) => agent.id === 'Nova' || agent.name === 'Nova')) {
            normalizedAgents.unshift({ ...NOVA_CATALOG_FALLBACK });
        }
        state.agentCatalog = normalizedAgents;
        // Preserve a deliberate Agent selection. Nova is a fallback only
        // when the previously selected shared Agent disappeared.
        if (!selectedAgentProfile()) {
            const fallback = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, 'Nova'))
                || state.agentCatalog[0];
            if (fallback) selectAgent(fallback.id || fallback.name);
        } else if (!store.getState().selectedSessionId) {
            selectAgent(state.selectedAgent);
        }
        const selectedAgentId = state.selectedAgent || 'Nova';
        queueRender({ shell: true, header: true, composer: true });

        // VCPChat Main already owns its background `/v1/models` cache.  Read
        // that cache opportunistically for the optional settings selector;
        // never wait for it before rendering or restoring a Topic.
        void optional(() => runtimeApi().getCachedModels?.()).then((models) => {
            if (state.disposed) return;
            const rawModels = Array.isArray(models) ? models : models?.models || [];
            state.modelCatalog = rawModels.map((model) => typeof model === 'string'
                ? { id: model, name: model }
                : {
                    ...model,
                    id: model?.id || model?.name || '',
                    name: model?.name || model?.id || '',
                    reasoningEfforts: reasoningEffortsForModel(model),
                })
                .filter((model) => model.id);
            if (!state.modelDraft && !state.model) state.model = state.modelCatalog[0]?.id || '';
            // Model discovery only changes selectors in the sidebar.  It must
            // not reset a potentially streaming transcript.
            queueRender({ shell: true, header: true, composer: true });
        });

        // Sessions and the follow-up queue are Codex Agent state. Load them
        // after the base VCPChat Agent surface is visible so a
        // transient App Server or ToolBox issue cannot blank the entire page.
        const [topics, queue, workbenchSettings] = await Promise.all([
            optional(() => controller.listTopics(selectedAgentId, { archived: state.showArchivedTopics })),
            optional(() => controller.listInteractionQueue()),
            optional(() => controller.getWorkbenchSettings()),
        ]);
        if (state.disposed || request !== controlPlaneRequest || !sameAgent(selectedAgentId, state.selectedAgent)) return;
        const receivedTopics = Array.isArray(topics) ? topics : topics?.topics || [];
        // Main returns Agent-scoped Session metadata. Retain this defensive
        // filter so an old/stale Main result cannot leak another Agent's
        // history into the current sidebar.
        state.topics = receivedTopics;
        (state.showArchivedTopics ? state.archivedTopicsByAgent : state.topicsByAgent)
            .set(agentCacheKey(selectedAgentId), receivedTopics);
        state.topicListLoading = false;
        state.queue = Array.isArray(queue) ? queue : queue?.items || queue?.queue || [];
        if (workbenchSettings && typeof workbenchSettings === 'object') {
            const budget = workbenchSettings.budget && typeof workbenchSettings.budget === 'object'
                ? workbenchSettings.budget : {};
            state.budget = {
                maxRequestsPerTurn: budget.maxRequestsPerTurn ?? null,
                maxTokensPerTurn: budget.maxTokensPerTurn ?? null,
            };
            if (!selectedAgentProfile() && !store.getState().selectedTopic?.configSnapshot) {
                state.permissionMode = workbenchSettings.permissionMode === 'always-approve'
                    ? 'always-approve' : 'ask';
            }
            if (!selectedAgentProfile() && !store.getState().selectedTopic?.configSnapshot?.model && workbenchSettings.model) {
                state.model = String(workbenchSettings.model);
            }
        }
        syncPermissionModeFromSelectedSession();
        syncModelFromSelectedSession();
        // Topics and queue state live in the control plane; leave the active
        // transcript intact while those catalog reads finish.
        queueRender({ shell: true, header: true, composer: true });
    }

    async function refreshRecoveryOperations({ scanThreads = false } = {}) {
        state.recoveryLoading = true;
        state.recoveryError = '';
        renderSidebar();
        try {
            if (scanThreads) {
                const result = await controller.listRecoveryCandidates();
                state.recoveryOperations = Array.isArray(result?.operations) ? result.operations : [];
                state.recoveryThreads = Array.isArray(result?.threads) ? result.threads : [];
            } else {
                const operations = await controller.listRecoveryOperations();
                state.recoveryOperations = Array.isArray(operations) ? operations : [];
                state.recoveryThreads = [];
            }
        } catch (error) {
            state.recoveryError = error?.message || String(error);
        } finally {
            state.recoveryLoading = false;
            if (!state.disposed) renderSidebar();
        }
    }

    async function createSession(overrides = {}) {
        const runtimeState = store.getState().runtime.state;
        if (runtimeState === 'stopped' || runtimeState === 'unknown') {
            await controller.startRuntime();
        }
        const title = overrides.title || (overrides.resume ? undefined : nextSessionTitle());
        const session = await controller.createSession({
            ...(Object.prototype.hasOwnProperty.call(overrides, 'workspaceRoot') ? { workspaceRoot: overrides.workspaceRoot } : {}),
            ...(Object.prototype.hasOwnProperty.call(overrides, 'model') ? { model: overrides.model } : {}),
            ...(Object.prototype.hasOwnProperty.call(overrides, 'systemPrompt') ? { systemPrompt: overrides.systemPrompt } : {}),
            ...(Object.prototype.hasOwnProperty.call(overrides, 'permissionMode') ? { permissionMode: overrides.permissionMode } : {}),
            agent: overrides.agent ?? (state.selectedAgent || 'Nova'),
            resume: overrides.resume,
            title,
        });
        rememberTopic(session);
        state.tab = 'sessions';
        await refreshControlPlane();
        return session;
    }

    async function createTopic(overrides = {}) {
        const created = await controller.createTopic({
            ...(Object.prototype.hasOwnProperty.call(overrides, 'workspaceRoot') ? { workspaceRoot: overrides.workspaceRoot } : {}),
            ...(Object.prototype.hasOwnProperty.call(overrides, 'model') ? { model: overrides.model } : {}),
            ...(Object.prototype.hasOwnProperty.call(overrides, 'systemPrompt') ? { systemPrompt: overrides.systemPrompt } : {}),
            ...(Object.prototype.hasOwnProperty.call(overrides, 'permissionMode') ? { permissionMode: overrides.permissionMode } : {}),
            agent: overrides.agent ?? (state.selectedAgent || 'Nova'),
            title: overrides.title || nextSessionTitle(),
        });
        rememberTopic(created);
        state.tab = 'sessions';
        await refreshControlPlane();
        return created;
    }

    async function createNewTopicDirectly() {
        if (state.topicCreating) return null;
        const profile = selectedAgentProfile();
        if (!profile) {
            state.profileConfigurationNotice = '请先选择一个 Build Agent。';
            state.tab = 'agents';
            renderSidebar();
            return null;
        }
        if (profileNeedsConfiguration(profile)) {
            state.profileConfigurationNotice = `Agent「${profile.name || profile.id}」尚未配置提示词。请先在“设置”中填写提示词，避免用错误身份启动 Codex。`;
            state.tab = 'settings';
            renderSidebar();
            return null;
        }
        state.topicCreating = true;
        state.profileConfigurationNotice = '';
        queueRender({ shell: true, header: true, composer: true });
        try {
            const created = await createTopic({
                agent: state.selectedAgent,
                title: nextSessionTitle(),
            });
            state.tab = 'sessions';
            notify(`已新建会话「${created.title || created.topicId}」。`, 'success');
            return created;
        } finally {
            state.topicCreating = false;
            queueRender({ shell: true, header: true, composer: true });
        }
    }

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

    async function recoverRuntime() {
        // Recovery is intentionally user-driven. An App Server crash must
        // never replay an interrupted model/tool Turn; restore only SQLite's
        // durable preview after the process restarts.
        if (state.recovering) return;
        state.recovering = true;
        queueRender({ header: true, composer: true });
        try {
            const previous = activeSession();
            await controller.stopRuntime();
            await controller.startRuntime();
            if (previous?.topicId) {
                await controller.previewTopic(previous.topicId, previous.agentId, previous);
                notify('Codex App Server 已重新连接，并显示最近的 SQLite 投影。中断的 Turn 不会重放。', 'success');
            } else {
                await refreshControlPlane();
                notify('Codex App Server 已重新连接。请新建一个 Agent 会话。', 'success');
            }
        } finally {
            state.recovering = false;
            queueRender({ header: true, composer: true });
        }
    }

    function rememberTopicTitle(topic, title) {
        if (state.rememberedTopic?.topicId === topic.id) {
            state.rememberedTopic = { ...state.rememberedTopic, title };
        }
        rememberTopic({
            topicId: topic.id,
            title,
            agentId: topic.agentId || state.selectedAgent || 'Nova',
            model: topic.model || state.model,
            workspaceRoot: topic.workspaceRef || state.workspace,
        });
    }

    function forgetTopic(topicId) {
        if (state.rememberedTopic?.topicId !== topicId) return;
        state.rememberedTopic = null;
        try { window.localStorage?.removeItem(LAST_TOPIC_STORAGE_KEY); } catch { /* convenience pointer only */ }
    }

    function closeTopicContextMenu({ returnFocus = false } = {}) {
        const current = state.topicContextMenu;
        if (!current) return;
        state.topicContextMenu = null;
        current.menu.remove();
        current.positionRule?.remove();
        document.removeEventListener('pointerdown', current.onPointerDown, true);
        document.removeEventListener('keydown', current.onKeyDown, true);
        if (returnFocus && current.trigger?.isConnected) current.trigger.focus();
    }

    async function copyTopicId(topicId) {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard API unavailable');
            await navigator.clipboard.writeText(topicId);
            notify('Topic ID 已复制。', 'success');
        } catch {
            // This copies only a durable identifier supplied by Main; it is
            // not a transcript or a second renderer-side Topic store.
            const temporary = document.createElement('textarea');
            temporary.value = topicId;
            temporary.className = 'agent-chat-clipboard-proxy';
            temporary.setAttribute('readonly', '');
            document.body.append(temporary);
            temporary.select();
            const copied = document.execCommand?.('copy');
            temporary.remove();
            if (copied) notify('Topic ID 已复制。', 'success');
            else notify(`无法访问系统剪贴板；Topic ID：${topicId}`, 'warning');
        }
    }

    function addTopicContextMenuItem(menu, iconName, label, action, { danger = false } = {}) {
        // Deliberately reuse the main-chat DOM primitives. The callbacks stay
        // Agent-specific and go through narrow IPC, but the visual contract (size,
        // font, icon spacing, theme and hover state) is the exact same shared
        // `.context-menu` / `.context-menu-item` implementation.
        const item = node('div', `context-menu-item agent-chat-topic-context-menu-item${danger ? ' danger-item' : ''}`);
        item.setAttribute('role', 'menuitem');
        item.tabIndex = 0;
        const iconElement = node('i', `fas fa-${iconName}`);
        iconElement.setAttribute('aria-hidden', 'true');
        item.append(iconElement, document.createTextNode(label));
        const invoke = (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeTopicContextMenu();
            run(action);
        };
        item.addEventListener('click', invoke);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') invoke(event);
        });
        menu.append(item);
        return item;
    }

    function positionTopicContextMenu(menu, point) {
        // Mount under document.body so a sidebar scroller cannot clip the
        // menu; then clamp it to the active Electron viewport.
        const gap = 8;
        const width = menu.offsetWidth || 188;
        const height = menu.offsetHeight || 240;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const left = Math.max(gap, Math.min(point.x, viewportWidth - width - gap));
        const top = Math.max(gap, Math.min(point.y, viewportHeight - height - gap));
        const instance = String(++topicMenuInstance);
        menu.dataset.agentMenuInstance = instance;
        // Keep transient pointer coordinates out of element inline styles.
        // The rule contains only clamped numeric viewport coordinates and is
        // removed with the document-level menu; it never holds Topic data.
        const positionRule = document.createElement('style');
        positionRule.textContent = `.agent-chat-topic-context-menu[data-agent-menu-instance="${instance}"] { left: ${left}px; top: ${top}px; visibility: visible; }`;
        document.head.append(positionRule);
        return positionRule;
    }

    function showTopicContextMenu(topic, trigger, point, { live = false } = {}) {
        if (!topic?.id || state.topicManaging) return;
        closeTopicContextMenu();
        const menu = node('div', 'context-menu agent-chat-topic-context-menu');
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', `管理 Topic：${topic.title || topic.id}`);
        menu.hidden = true;

        const archived = Boolean(topic.archivedAt);
        if (live) {
            addTopicContextMenuItem(menu, 'folder-open', '打开当前会话', async () => controller.hydrateTopic(topic.id, null, null, topic.agentId));
        } else {
            addTopicContextMenuItem(menu, 'folder-open', archived ? '查看归档会话' : '打开会话', async () => {
                await controller.previewTopic(topic.id, topic.agentId, topic);
                rememberTopic({ topicId: topic.id });
            });
            if (!archived) addTopicContextMenuItem(menu, 'edit', '重命名', async () => {
                const title = window.prompt?.('重命名 Agent Topic', topic.title || '');
                if (title === null || title === undefined || title.trim() === (topic.title || '').trim()) return;
                await controller.renameTopic(topic.id, title, topic.agentId);
                rememberTopicTitle(topic, title.trim());
                await refreshControlPlane();
                notify('Agent Topic 已重命名。', 'success');
            });
        }
        addTopicContextMenuItem(menu, 'copy', '复制 Topic ID', async () => copyTopicId(topic.id));
        if (!live) addTopicContextMenuItem(menu, 'file-export', '导出 Markdown', async () => {
            const result = await controller.exportSession(topic.id, 'markdown');
            if (result?.exported) notify('Agent 会话已导出。', 'success');
        });
        if (!live && !archived) {
            addTopicContextMenuItem(menu, 'archive', '归档会话', async () => {
                const confirmed = window.confirm?.(`确定归档「${topic.title || topic.id}」吗？之后可从归档会话中恢复。`);
                if (!confirmed) return;
                await controller.deleteTopic(topic.id, topic.agentId);
                state.composerStateBySession.delete(topic.id);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent 会话已归档。', 'success');
            });
        } else if (!live && archived) {
            addTopicContextMenuItem(menu, 'undo', '恢复会话', async () => {
                await controller.restoreSession(topic.id);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent 会话已恢复。', 'success');
            });
            addTopicContextMenuItem(menu, 'trash', '永久删除', async () => {
                const confirmed = window.confirm?.(`永久删除「${topic.title || topic.id}」及其本地投影吗？此操作不可恢复。`);
                if (!confirmed) return;
                await controller.permanentlyDeleteSession(topic.id);
                state.composerStateBySession.delete(topic.id);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent 会话已永久删除。', 'success');
            }, { danger: true });
        }

        const onPointerDown = (event) => {
            if (!menu.contains(event.target) && event.target !== trigger) closeTopicContextMenu();
        };
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closeTopicContextMenu({ returnFocus: true });
        };
        document.body.append(menu);
        const positionRule = positionTopicContextMenu(menu, point);
        menu.hidden = false;
        state.topicContextMenu = { menu, trigger, onPointerDown, onKeyDown, positionRule };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        queueMicrotask(() => menu.querySelector('[role="menuitem"]')?.focus());
    }

    function appendTopicActions(row, topic, { live = false } = {}) {
        // Use an inline SVG here rather than a Material Symbols glyph. The
        // Agent Workbench can mount before that optional font is ready; its
        // text fallback was the small grey dash seen beside every Topic row.
        const menu = visualActionButton('more', `管理 Topic：${topic.title || topic.id}`, 'agent-chat-session-menu');
        menu.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = menu.getBoundingClientRect();
            showTopicContextMenu(topic, menu, { x: rect.right, y: rect.bottom }, { live });
        });
        row.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            showTopicContextMenu(topic, menu, { x: event.clientX, y: event.clientY }, { live });
        });
        row.append(menu);
    }

    function sessionSidebarEntries() {
        const current = store.getState();
        // Scope every active Thread by its durable Agent identity. Never reuse
        // the selected Session metadata as a fallback across runtimes.
        const liveSessions = (state.showArchivedTopics ? []
            : (current.activeRuntimes instanceof Map ? [...current.activeRuntimes.values()] : []))
            .filter((runtime) => sameAgent(runtime.agentId, state.selectedAgent))
            .map((runtime) => projectSession({
                ...(state.topics.find((topic) => topic.id === runtime.topicId) || {}),
                ...runtime,
            }));
        const liveTopicIds = new Set(liveSessions.map((session) => session.topicId).filter(Boolean));
        return {
            liveSessions,
            persistedTopics: state.topics.filter((topic) => !liveTopicIds.has(topic.id)),
            selectedTopicId: current.selectedSessionId || current.selectedTopic?.topicId || null,
        };
    }

    async function persistAgentProfileDefaults(payload) {
        const profile = selectedAgentProfile();
        if (!profile) throw new Error('请先选择 Build Agent');
        const result = await runtimeApi().agentRuntimeSaveAgentProfile?.({
            agentId: profile.id || profile.name,
            expectedProfileRevision: Number(profile.profileRevision || profile.revision || 1),
            name: Object.prototype.hasOwnProperty.call(payload, 'name')
                ? payload.name : profile.name || profile.id,
            instructionMode: Object.prototype.hasOwnProperty.call(payload, 'instructionMode')
                ? payload.instructionMode : profile.instructionMode || 'vchat-identity',
            baseInstructions: Object.prototype.hasOwnProperty.call(payload, 'baseInstructions')
                ? payload.baseInstructions
                : Object.prototype.hasOwnProperty.call(payload, 'systemPrompt')
                ? payload.systemPrompt : profile.baseInstructions || profile.systemPrompt || '',
            developerInstructions: Object.prototype.hasOwnProperty.call(payload, 'developerInstructions')
                ? payload.developerInstructions : profile.developerInstructions || '',
            personality: Object.prototype.hasOwnProperty.call(payload, 'personality')
                ? payload.personality : profile.personality || 'none',
            model: Object.prototype.hasOwnProperty.call(payload, 'model') ? payload.model : profile.model,
            reasoningEffort: Object.prototype.hasOwnProperty.call(payload, 'reasoningEffort')
                ? payload.reasoningEffort : profile.reasoningEffort,
            workspaceRoot: Object.prototype.hasOwnProperty.call(payload, 'workspaceRoot')
                ? payload.workspaceRoot : profile.workspaceRoot,
            permissionMode: Object.prototype.hasOwnProperty.call(payload, 'permissionMode')
                ? payload.permissionMode : profile.permissionMode,
        });
        if (!result?.success || !result.profile?.id) throw new Error(result?.error || 'Build Agent Profile 保存失败');
        const savedProfile = {
            ...result.profile,
            instructionMode: result.profile.instructionMode === 'codex-managed'
                ? 'codex-managed' : 'vchat-identity',
            baseInstructions: result.profile.baseInstructions || result.profile.systemPrompt || '',
            systemPrompt: result.profile.systemPrompt || '',
            developerInstructions: result.profile.developerInstructions || '',
            personality: result.profile.personality || 'none',
            reasoningEffort: result.profile.reasoningEffort || null,
            reasoningEfforts: Array.isArray(result.profile.reasoningEfforts) ? result.profile.reasoningEfforts : [],
            model: result.profile.model || '',
            workspaceRoot: result.profile.workspaceRoot || '',
            permissionMode: result.profile.permissionMode === 'always-approve' ? 'always-approve' : 'ask',
            configurationRequired: result.profile.instructionMode !== 'codex-managed'
                && !String(result.profile.baseInstructions || result.profile.systemPrompt || '').trim(),
        };
        Object.assign(profile, savedProfile);
        selectAgent(savedProfile.id);
        return {
            profile: savedProfile,
            settings: {
                model: savedProfile.model,
                permissionMode: savedProfile.permissionMode,
            },
        };
    }

    function persistWorkbenchSettings(payload, selectedSession, successMessage) {
        const saveScope = selectedSession ? 'session'
            : (Object.prototype.hasOwnProperty.call(payload, 'budget') ? 'advanced' : 'profile');
        const profile = selectedAgentProfile();
        const targetKey = selectedSession
            ? sessionSettingsTarget(selectedSession)
            : saveScope === 'advanced' ? 'advanced:global' : profileSettingsTarget(profile?.id || profile?.name);
        state.settingsSaveState = 'saving';
        state.settingsSaveMessage = '正在自动保存…';
        state.settingsSaveByScope.set(saveScope, { state: 'saving', message: '正在自动保存…' });
        const projectionAtEnqueue = store.getState().selectedTopic;
        if (selectedSession
            && (projectionAtEnqueue?.sessionId || projectionAtEnqueue?.topicId) === selectedSession) {
            sessionConfigRevisions.set(selectedSession, Number(projectionAtEnqueue.configRevision || 1));
        }
        const operation = settingsState.enqueue(targetKey, payload, async () => {
            const request = {
                ...payload,
                ...(selectedSession ? {
                    sessionId: selectedSession,
                    expectedConfigRevision: sessionConfigRevisions.get(selectedSession)
                        || Number(projectionAtEnqueue?.configRevision || 1),
                } : {}),
            };
            const profileUpdate = !selectedSession && [
                'name', 'systemPrompt', 'baseInstructions', 'instructionMode', 'developerInstructions',
                'personality', 'model', 'reasoningEffort', 'workspaceRoot', 'permissionMode',
            ]
                .some((key) => Object.prototype.hasOwnProperty.call(payload, key));
            const saved = profileUpdate
                ? await persistAgentProfileDefaults(payload)
                : await controller.updateWorkbenchSettings(request);
            if (saved?.profile && !saved.profile.configurationRequired) {
                state.profileConfigurationNotice = '';
            }
            if (saved?.createdDerivedSession && saved?.session?.sessionId) {
                await refreshTopicsForAgent(saved.session.agentId || state.selectedAgent, false);
                await controller.hydrateTopic(
                    saved.session.sessionId,
                    saved.session,
                    null,
                    saved.session.agentId || state.selectedAgent,
                );
                notify('已保留原会话，并创建 Codex 管理指令派生会话。', 'success');
            }
            if (saved?.session?.configRevision) {
                sessionConfigRevisions.set(saved.session.sessionId, Number(saved.session.configRevision));
            }
            const stillSelected = !selectedSession || store.getState().selectedSessionId === selectedSession;
            if (stillSelected && Object.prototype.hasOwnProperty.call(payload, 'permissionMode')) {
                state.permissionMode = saved?.settings?.permissionMode === 'always-approve' ? 'always-approve' : 'ask';
            }
            if (stillSelected && Object.prototype.hasOwnProperty.call(payload, 'model')) {
                state.model = saved?.settings?.model || saved?.session?.configSnapshot?.model || payload.model;
                state.modelDraft = null;
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'budget')) {
                state.budget = { ...state.budget, ...payload.budget };
            }
            if (stillSelected && selectedSession && saved?.session?.configSnapshot) {
                const currentProjection = store.getState();
                store.setState({
                    selectedTopic: currentProjection.selectedSessionId === selectedSession
                        ? {
                            ...currentProjection.selectedTopic,
                            configSnapshot: saved.session.configSnapshot,
                            configRevision: saved.session.configRevision,
                            workspaceRef: saved.session.workspaceRoot || currentProjection.selectedTopic.workspaceRef,
                            workspaceRoot: saved.session.workspaceRoot || currentProjection.selectedTopic.workspaceRoot,
                        }
                        : currentProjection.selectedTopic,
                });
            }
            state.settingsSaveState = 'saved';
            state.settingsSaveMessage = successMessage || '已自动保存';
            state.settingsSaveByScope.set(saveScope, { state: 'saved', message: successMessage || '已自动保存' });
            return saved;
        }, successMessage || '已自动保存').catch((error) => {
            state.settingsSaveState = 'error';
            state.settingsSaveMessage = error?.message || String(error);
            state.settingsSaveByScope.set(saveScope, { state: 'error', message: state.settingsSaveMessage });
            notify(state.settingsSaveMessage, 'error');
            return null;
        }).finally(() => {
            if (!state.disposed) {
                renderSidebar();
                renderHeader();
            }
        });
        return operation;
    }

    function sidebarViewModel() {
        syncModelFromSelectedSession();
        const { liveSessions, persistedTopics, selectedTopicId } = sessionSidebarEntries();
        return {
            tab: state.tab,
            selectedAgent: state.selectedAgent,
            selectedAgentName: selectedAgentProfile()?.name || state.selectedAgent,
            agentCatalog: state.agentCatalog,
            agentSearch: state.agentSearch,
            topics: state.topics,
            topicCreating: state.topicCreating,
            topicManaging: state.topicManaging,
            topicSelectedIds: new Set(state.topicSelectedIds),
            showArchivedTopics: state.showArchivedTopics,
            topicSearch: state.topicSearch,
            topicSearchResults: state.topicSearchResults,
            topicSearchLoading: state.topicSearchLoading,
            topicSearchError: state.topicSearchError,
            topicSearchOpen: state.topicSearchOpen,
            topicListLoading: state.topicListLoading,
            profileConfigurationRequired: profileNeedsConfiguration(),
            profileConfigurationNotice: state.profileConfigurationNotice,
            liveSessions: liveSessions.map((session) => ({
                ...session,
                activity: sessionActivity(session.topicId, session.activity),
            })),
            persistedTopics,
            selectedTopicId,
            selectedMessageCount: store.getState().messages.length,
        };
    }

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

    function ensureSidebarView() {
        if (sidebarView) return sidebarView;
        sidebarView = createAgentWorkbenchSidebarView({
            element: sidebar,
            accountView,
            lifecycle,
            actions: {
                selectTab(id) {
                    closeTopicContextMenu();
                    state.tab = id;
                    if (id !== 'sessions') {
                        state.topicManaging = false;
                        state.topicSelectedIds.clear();
                        state.topicSearchOpen = false;
                        state.topicSearch = '';
                        state.topicSearchResults = [];
                        state.topicSearchLoading = false;
                        state.topicSearchError = '';
                    }
                    renderSidebar();
                    if (id === 'sessions') run(() => refreshControlPlane());
                    else if (id === 'settings') void refreshRecoveryOperations();
                },
                openNewSession: openNewTopicFlow,
                toggleTopicManagement() {
                    closeTopicContextMenu();
                    state.topicManaging = !state.topicManaging;
                    if (!state.topicManaging) state.topicSelectedIds.clear();
                    renderSidebar();
                },
                toggleArchivedSessions() {
                    closeTopicContextMenu();
                    state.showArchivedTopics = !state.showArchivedTopics;
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    state.topicSearchOpen = false;
                    state.topicSearch = '';
                    state.topicSearchResults = [];
                    renderSidebar();
                    run(() => refreshTopicsForAgent(state.selectedAgent, state.showArchivedTopics));
                },
                setTopicSearchOpen(open, clear) {
                    state.topicSearchOpen = open;
                    if (clear) {
                        state.topicSearch = '';
                        state.topicSearchResults = [];
                        state.topicSearchLoading = false;
                        state.topicSearchError = '';
                    }
                    renderSidebar();
                },
                setTopicSearch(query, { loading, error, render = false } = {}) {
                    state.topicSearch = query;
                    state.topicSearchLoading = Boolean(loading);
                    state.topicSearchError = error || '';
                    if (!query) state.topicSearchResults = [];
                    if (render) renderSidebar();
                },
                searchSessions: (query, agentId, limit) => controller.searchTopics(query, agentId, limit),
                finishTopicSearch(query, { hits = [], error = '' } = {}) {
                    if (query !== state.topicSearch.trim()) return;
                    state.topicSearchResults = Array.isArray(hits) ? hits : [];
                    state.topicSearchLoading = false;
                    state.topicSearchError = error;
                    renderSidebar();
                    queueMicrotask(() => {
                        const active = document.getElementById('agentWorkbenchTopicSearchInput');
                        active?.focus();
                        active?.setSelectionRange(active.value.length, active.value.length);
                    });
                },
                createSessionAvatar,
                appendTopicActions,
                hydrateSession: (session) => run(() => controller.hydrateTopic(
                    session.topicId, session, null, session.agentId,
                )),
                previewSession: (topic) => run(async () => {
                    await controller.previewTopic(topic.id, topic.agentId, topic);
                    rememberTopic({ topicId: topic.id });
                }),
                toggleTopicSelection(sessionId) {
                    if (state.topicSelectedIds.has(sessionId)) state.topicSelectedIds.delete(sessionId);
                    else state.topicSelectedIds.add(sessionId);
                    renderSidebar();
                },
                selectVisibleSessions(sessionIds, selected) {
                    sessionIds.forEach((sessionId) => {
                        if (selected) state.topicSelectedIds.add(sessionId);
                        else state.topicSelectedIds.delete(sessionId);
                    });
                    renderSidebar();
                },
                archiveSelectedSessions(topics) {
                    run(async () => {
                        if (!topics.length || !window.confirm?.(`确定归档选中的 ${topics.length} 个 Agent 会话吗？`)) return;
                        for (const topic of topics) {
                            await controller.deleteTopic(topic.id, topic.agentId);
                            forgetTopic(topic.id);
                        }
                        state.topicSelectedIds.clear();
                        state.topicManaging = false;
                        await refreshTopicsForAgent(state.selectedAgent);
                        notify(`已归档 ${topics.length} 个 Agent 会话。`, 'success');
                    });
                },
                exitTopicManagement() {
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    renderSidebar();
                },
                openNewAgent: openNewAgentFlow,
                setAgentSearch(value) { state.agentSearch = value; },
                selectAgent(agentId) {
                    run(async () => {
                        state.uxTimings.set(`agent-click:${agentCacheKey(agentId)}`, uxMark('agent-click', agentId));
                        const current = store.getState();
                        const sessionAgent = current.selectedTopic?.agentId;
                        if (current.selectedSessionId && (!sessionAgent || !sameAgent(sessionAgent, agentId))) {
                            controller.clearSelection();
                        }
                        selectAgent(agentId);
                        state.tab = 'sessions';
                        state.topicManaging = false;
                        state.topicSelectedIds.clear();
                        state.topicSearchOpen = false;
                        state.topicSearch = '';
                        queueRender({ shell: true, header: true, composer: true });
                        await refreshControlPlane();
                    });
                },
                renderSettings: renderSettingsSidebarContent,
            },
        });
        return sidebarView;
    }

    function renderSidebar() {
        ensureSidebarView().update(sidebarViewModel());
    }

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
        // Preserve a reader's position during control updates. Main is
        // the ordering authority; this renderer only reconciles keyed rows.
        const follow = isFollowingContainer(feed);
        const current = store.getState();
        const clearEmpty = () => {
            state.timelineEmpty?.remove();
            state.timelineEmpty = null;
        };
        const showEmpty = (text) => {
            reconcileAgentTimeline(feedItems, [], {}, state.timelineRows);
            if (!state.timelineEmpty) {
                state.timelineEmpty = node('div', 'agent-chat-empty-conversation');
                feedItems.append(state.timelineEmpty);
            }
            state.timelineEmpty.textContent = text;
        };
        if (!current.selectedSessionId && !current.selectedTopic?.topicId) {
            showEmpty('创建一个 Agent 会话，即可开始与 VCPToolBox 协作。');
            return;
        }
        const timeline = createAgentTimelineParts(current);
        const pendingTurnStart = selectedTurnStart(current);
        if (pendingTurnStart) {
            const selectedTopicId = selectedSessionKey(current);
            const alreadyHasAssistant = pendingTurnStart.turnId && current.messages.some((message) => (
                message.role === 'assistant' && message.turnId === pendingTurnStart.turnId
            ));
            if (selectedTopicId && pendingTurnStart.topicId === selectedTopicId && !alreadyHasAssistant) {
                const presentationId = `turn-start:${selectedTopicId}`;
                timeline.push({
                    kind: 'message',
                    id: presentationId,
                    presentationKey: presentationId,
                    turnId: pendingTurnStart.turnId || null,
                    value: {
                        id: presentationId,
                        role: 'assistant',
                        state: 'streaming',
                        content: pendingTurnStart.phase === 'starting' ? '正在启动 Agent…' : '思考中',
                        presentationRole: 'turn-start',
                        presentationKey: presentationId,
                        presentationPhase: pendingTurnStart.phase,
                        createdAt: pendingTurnStart.createdAt || Date.now(),
                    },
                });
            }
        }
        if (!timeline.length && !pendingTurnStart) {
            showEmpty('会话已就绪，发送第一条消息开始。');
            return;
        }
        clearEmpty();
        reconcileAgentTimeline(feedItems, timeline, fullPresentation.timelineCallbacks, state.timelineRows);

        scrollFeed(feed, follow);
    }

    function renderJumpToLatest() {
        const count = Math.min(99, state.unreadTimelineCount || 0);
        const visible = !state.followingFeed && count > 0;
        jumpToLatest.hidden = !visible;
        if (!visible) return;
        const suffix = count > 1 ? `（${count} 条新动态）` : '（有新动态）';
        jumpToLatest.textContent = `回到最新${suffix}`;
        jumpToLatest.setAttribute('aria-label', `回到最新消息${suffix}`);
    }

    function noteTimelineActivity() {
        if (isFollowingContainer(feed)) {
            state.followingFeed = true;
            state.unreadTimelineCount = 0;
        } else {
            state.followingFeed = false;
            state.unreadTimelineCount = Math.min(99, (state.unreadTimelineCount || 0) + 1);
        }
        renderJumpToLatest();
    }

    function normalizeDockKind(tab) {
        return ({ usage: 'context', workspace: 'files', activity: 'notifications' })[tab] || tab || 'context';
    }

    function selectedDockSessionId(current = store.getState()) {
        return current.selectedSessionId || current.selectedTopic?.topicId || '';
    }

    function syncSessionDock(current = store.getState()) {
        state.sessionDock.setSession(selectedDockSessionId(current));
        const snapshot = state.sessionDock.snapshot();
        state.activityTab = snapshot.activeId;
        return snapshot;
    }

    function openDockKind(kind) {
        const normalized = normalizeDockKind(kind);
        state.sessionDock.setSession(selectedDockSessionId());
        state.sessionDock.openKind(normalized);
        state.activityTab = state.sessionDock.snapshot().activeId;
        state.dockMenuOpen = false;
        setActivityOpen(true);
    }

    function dockMenuCommands() {
        const current = store.getState();
        const changesAvailable = [...(current.tools instanceof Map ? current.tools.values() : [])]
            .some((tool) => Array.isArray(tool?.payload?.changes?.files) && tool.payload.changes.files.length);
        return [
            { icon: 'folder_open', label: '打开文件', run: () => openDockKind('files') },
            ...(changesAvailable ? [{ icon: 'difference', label: '查看变更', run: () => openDockKind('changes') }] : []),
            { icon: 'data_usage', label: '上下文', run: () => openDockKind('context') },
            { icon: 'notifications', label: '通知', run: () => openDockKind('notifications') },
            { icon: 'approval', label: '审批', run: () => openDockKind('approvals') },
            { icon: 'terminal', label: '在 VChat 终端中打开', run: () => run(async () => {
                const result = await runtimeApi().desktopLaunchVchatApp?.('open-powershell-executor-terminal');
                if (result && result.success === false) throw new Error(result.error || '无法打开 VChat 终端。');
                state.dockMenuOpen = false;
                renderActivity();
            }) },
        ];
    }

    function setActivityOpen(open, tab) {
        if (open && tab) {
            const normalized = normalizeDockKind(tab);
            state.sessionDock.setSession(selectedDockSessionId());
            state.sessionDock.openKind(normalized);
            state.activityTab = state.sessionDock.snapshot().activeId;
        }
        state.activityOpen = open;
        if (open) clearActivityUnread(normalizeDockKind(state.activityTab));
        if (open) {
            activitySplitter.classList.add('is-active');
            activityPanel.classList.add('agent-chat-activity-open');
            activityPanel.classList.remove('agent-chat-activity-collapsed');
            activityPanel.removeAttribute('inert');
            activityPanel.setAttribute('aria-hidden', 'false');
        } else {
            activityPanel.classList.remove('agent-chat-activity-open');
            activityPanel.classList.add('agent-chat-activity-collapsed');
            activityPanel.setAttribute('inert', '');
            activityPanel.setAttribute('aria-hidden', 'true');
        }
        queueRender({ activity: true, header: true });
    }

    function clearActivityUnread(tab) {
        tab = normalizeDockKind(tab);
        const current = store.getState();
        const byTab = { ...(current.activityUnreadByTab || {}) };
        const legacyTab = ({ context: 'usage', files: 'workspace', notifications: 'activity' })[tab];
        if (!byTab[tab] && !(legacyTab && byTab[legacyTab])) return;
        byTab[tab] = 0;
        if (legacyTab) byTab[legacyTab] = 0;
        store.setState({
            activityUnreadByTab: byTab,
            activityUnread: Object.values(byTab).reduce((sum, value) => sum + Number(value || 0), 0),
        });
    }

    // Surface the activity panel automatically on state transitions the user
    // must notice: a Runtime error, or the first pending approval arriving.
    // Main remains responsible for fail-closed expiry even while this
    // panel is collapsed; the renderer ticker only refreshes visible labels.
    function maybeAutoOpenActivity() {
        const current = store.getState();
        const viewState = deriveWorkbenchViewState(current);
        const approvalsCount = (current.approvals || []).length;
        if (approvalsCount > 0 && !state.hadApprovals && !state.activityOpen) {
            setActivityOpen(true, 'approvals');
        }
        state.lastViewState = viewState;
        state.hadApprovals = approvalsCount > 0;
    }

    function selectedWorkspaceIdentity(current = store.getState()) {
        const selected = current.selectedTopic || {};
        return {
            sessionId: current.selectedSessionId || selected.topicId || selected.sessionId || '',
            workspaceRoot: selected.workspaceRef || selected.workspaceRoot || '',
        };
    }

    function syncWorkspaceScope(current = store.getState()) {
        return workspaceCoordinator.syncScope(current);
    }

    function loadWorkspaceDirectory(relativePath = '') {
        return workspaceCoordinator.loadDirectory(relativePath, store.getState());
    }

    function openWorkspacePreview(ref) {
        return workspaceCoordinator.openPreview(ref);
    }

    async function openWorkspaceFileTab(ref) {
        state.sessionDock.setSession(selectedDockSessionId());
        const snapshot = state.sessionDock.openFile(ref);
        if (!snapshot) throw new Error('文件引用不属于当前会话或工作区版本已失效。');
        state.activityTab = snapshot.activeId;
        await workspaceCoordinator.openPreview(ref);
        setActivityOpen(true);
    }

    function performWorkspaceAction(ref, action) {
        return workspaceCoordinator.performAction(ref, action);
    }

    async function openWorkspaceSourcePath(relativePath, source = 'tree', action = 'preview') {
        syncWorkspaceScope();
        if (!state.workspaceBrowser.workspaceRevision) await loadWorkspaceDirectory('');
        const browser = state.workspaceBrowser;
        const ref = createWorkspacePathRef({
            sessionId: browser.sessionId, workspaceRevision: browser.workspaceRevision,
            relativePath, source,
        });
        if (action === 'preview') {
            setActivityOpen(true, 'files');
            return openWorkspacePreview(ref);
        }
        if (action === 'open-in-vchat') return openWorkspaceFileTab(ref);
        return performWorkspaceAction(ref, action);
    }

    function scheduleWorkspaceSearch(value) {
        workspaceCoordinator.search(value);
    }

    function renderActivity() {
        if (state.disposed) return;
        const current = store.getState();
        const previousContent = sessionDockView.activePanel();
        const previousActiveTab = state.sessionDock.snapshot().tabs.find((tab) => tab.id === state.activityTab);
        const previousScrollTarget = previousActiveTab?.kind === 'notifications'
            ? previousContent?.querySelector('.agent-chat-activity-list')
            : previousContent;
        const scrollTop = previousScrollTarget?.scrollTop || 0;
        const searchFocused = document.activeElement?.matches?.('.agent-chat-activity-filters input[type="search"]');
        const searchSelection = searchFocused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
        const existingInteractions = new Map([...activityPanel.querySelectorAll('.agent-chat-interaction-card[data-interaction-id]')]
            .map((item) => [item.dataset.interactionId, item]));
        const existingActivityCards = new Map([...activityPanel.querySelectorAll('[data-activity-key]')]
            .map((item) => [item.dataset.activityKey, item]));
        const openKeys = new Set([...activityPanel.querySelectorAll('details[open][data-activity-key]')]
            .map((item) => item.dataset.activityKey));

        const localApprovals = current.approvals || [];
        const backendApprovals = (current.toolboxWs || [])
            .filter((item) => item?.kind === 'backend-approval-request');
        const interactionKey = (source, requestId) => `${String(source || 'codex-native')}:${String(requestId || '')}`;
        const actionableKeys = new Set([
            ...localApprovals.map((item) => interactionKey(item.scope || 'codex-native', item.requestId || item.approvalId)),
            ...backendApprovals.map((item) => interactionKey('toolbox', item?.value?.requestId || item?.value?.data?.requestId)),
        ]);
        const passiveInteractions = (current.interactions || []).filter((item) => (
            !actionableKeys.has(interactionKey(item.source, item.requestId))
        ));
        const pendingApprovals = localApprovals.length + backendApprovals.length + passiveInteractions.length;
        const unread = current.activityUnreadByTab || {};
        syncSessionDock(current);
        state.sessionDock.setBadge('notifications', Number(unread.notifications || unread.activity || 0));
        state.sessionDock.setBadge('approvals', pendingApprovals);
        const tabDefs = state.sessionDock.snapshot().tabs;
        if (!tabDefs.some((tab) => tab.id === state.activityTab)) state.activityTab = 'context';
        const content = sessionDockView.update({
            tabs: tabDefs,
            activeId: state.activityTab,
            menuOpen: state.dockMenuOpen,
            commands: dockMenuCommands(),
        });
        content.replaceChildren();
        const viewState = deriveWorkbenchViewState(current);
        const activeDefinition = tabDefs.find((tab) => tab.id === state.activityTab) || tabDefs[0];
        const activeKind = activeDefinition?.kind || 'context';

        if (activeKind === 'connection') {
            content.append(activityReadonlyView.buildConnection(current, viewState));
        } else if (activeKind === 'approvals') {
            content.append(approvalView.build({
                localApprovals,
                backendApprovals,
                interactions: passiveInteractions,
                existingInteractions,
            }));
        } else if (activeKind === 'context') {
            content.append(activityReadonlyView.buildUsage(current));
        } else if (activeKind === 'plan') {
            content.append(activityReadonlyView.buildPlan(current));
        } else if (activeKind === 'changes') {
            const selectedSessionId = current.selectedSessionId || current.selectedTopic?.topicId || '';
            content.append(activityReadonlyView.buildChanges(current, {
                sessionId: selectedSessionId,
                workspaceRevision: state.workspaceBrowser.sessionId === selectedSessionId
                    ? state.workspaceBrowser.workspaceRevision : '',
            }));
        } else if (activeKind === 'files') {
            workspaceView.update({ identity: syncWorkspaceScope(current), browser: state.workspaceBrowser });
            content.append(workspaceView.element);
        } else if (activeKind === 'file') {
            syncWorkspaceScope(current);
            const ref = createWorkspacePathRef({
                sessionId: activeDefinition.sessionId,
                workspaceRevision: activeDefinition.workspaceRevision,
                relativePath: activeDefinition.relativePath,
                source: 'tree',
            });
            if (state.workspaceBrowser.preview?.relativePath !== activeDefinition.relativePath
                || state.workspaceBrowser.preview?.workspaceRevision !== activeDefinition.workspaceRevision) {
                content.append(node('div', 'agent-chat-activity-empty', '正在读取文件…'));
                if (!state.workspaceBrowser.previewLoading) queueMicrotask(() => run(() => openWorkspacePreview(ref)));
            } else content.append(workspaceView.renderPreview(state.workspaceBrowser));
        } else {
            const notification = notificationView.build(current, {
                cards: existingActivityCards,
                openKeys,
            });
            content.append(notification.content);
        }
        for (const details of content.querySelectorAll('details[data-activity-key]')) {
            if (openKeys.has(details.dataset.activityKey)) details.open = true;
        }
        const scrollTarget = activeKind === 'notifications'
            ? content.querySelector('.agent-chat-activity-list')
            : content;
        if (scrollTarget) scrollTarget.scrollTop = scrollTop;
        if (searchFocused) {
            const nextSearch = content.querySelector('.agent-chat-activity-filters input[type="search"]');
            nextSearch?.focus();
            if (searchSelection) nextSearch?.setSelectionRange?.(...searchSelection);
        }
    }

    function patchStreamingFeed(event) {
        // Deltas share the same requestAnimationFrame batcher as all other
        // timeline parts.  The keyed reconciler changes only this message row
        // and keeps tool cards, expanded details and the composer intact.
        if (event?.messageId) queueRender({ feed: true });
    }

    function queueRender(parts = {}) {
        if (state.disposed) return;
        Object.assign(pendingRender, parts);
        if (renderFrame !== null) return;
        renderFrame = lifecycle.frame('render', () => {
            renderFrame = null;
            const next = { ...pendingRender };
            Object.keys(pendingRender).forEach((key) => { pendingRender[key] = false; });
            if (next.shell) renderSidebar();
            if (next.header) renderHeader();
            if (next.feed) renderFeed();
            if (next.activity) renderActivity();
            if (next.composer) renderComposer();
            if (next.topicFlow) renderTopicFlow();
        });
    }

    function patchSidebarTopicSelection() {
        const selectedTopicId = store.getState().selectedSessionId || store.getState().selectedTopic?.topicId || null;
        for (const row of sidebar.querySelectorAll('.agent-chat-session-row[data-topic-id]')) {
            const active = Boolean(selectedTopicId && row.dataset.topicId === selectedTopicId);
            const activity = sessionActivity(row.dataset.topicId, row.dataset.runtimeActivity || 'idle');
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

    function settleTurnStartIndicator(event) {
        const eventSessionId = event?.sessionId || event?.topicId || null;
        const pending = eventSessionId ? state.turnStarts.get(eventSessionId) : selectedTurnStart();
        if (event && pending) {
            const turnMatches = !event.turnId || !pending.turnId || event.turnId === pending.turnId;
            const sessionMatches = eventSessionId === pending.topicId;
            if (sessionMatches && event.type === 'turn.started') {
                state.turnStarts.set(pending.topicId, {
                    ...pending,
                    turnId: event.turnId || pending.turnId,
                    phase: 'thinking',
                    seenRunning: true,
                });
            }
            if (sessionMatches && turnMatches && (
            event.type === 'assistant.started'
            || event.type === 'assistant.delta'
            || event.type === 'reasoning.delta'
            || event.type === 'turn.completed'
            || event.type === 'turn.failed'
            || event.type === 'turn.cancelled'
            || event.type === 'runtime.crashed'
            )) {
                state.turnStarts.delete(pending.topicId);
                return;
            }
        }
        // Codex projection notifications are reduced through store.setState
        // with no synthetic business event.  A real assistant message is the
        // authoritative replacement for the ephemeral thinking row.
        if (!event) {
            const current = store.getState();
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
                if (hasAssistant) {
                    uxMark('first-assistant-item', entry.turnId,
                        state.uxTimings.get(`turn-start:${entry.topicId || 'new'}`) || null);
                }
                state.turnStarts.delete(sessionId);
            }
        }
    }

    function renderForStoreEvent(event) {
        if (event?.type === 'toolbox.ws' || event?.type === 'marker.observed') {
            state.sessionDock.setSession(selectedDockSessionId());
            state.sessionDock.ensureKind('notifications');
        }
        if (event?.type?.startsWith('approval.') || event?.type?.startsWith('interaction.')) {
            state.sessionDock.setSession(selectedDockSessionId());
            state.sessionDock.ensureKind('approvals');
        }
        if (event?.type && state.activityOpen) {
            const eventTab = event.type === 'toolbox.ws' || event.type === 'marker.observed' ? 'notifications'
                : event.type.startsWith('approval.') || event.type.startsWith('interaction.') ? 'approvals'
                    : event.type === 'plan.updated' ? 'context'
                        : event.type === 'context.usage' || event.type.includes('compaction') ? 'context'
                            : null;
            const activeKind = state.sessionDock.snapshot().tabs.find((tab) => tab.id === state.activityTab)?.kind;
            if (eventTab === activeKind) clearActivityUnread(eventTab);
        }
        if (event?.type === 'turn.started' && event.turnId) {
            const rawTimestamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number(event.timestamp);
            const eventTime = Number.isFinite(rawTimestamp) && rawTimestamp >= 1_000_000_000_000
                ? rawTimestamp
                : Number.isFinite(rawTimestamp) && rawTimestamp >= 1_000_000_000
                    ? rawTimestamp * 1000
                    : Date.now();
            if (!state.turnStartedAt.has(event.turnId)) state.turnStartedAt.set(event.turnId, eventTime);
        } else if (event?.turnId && ['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) {
            state.turnStartedAt.delete(event.turnId);
        }
        settleTurnStartIndicator(event);
        if (!event?.type) {
            // A snapshot preview changes only the visible projection.  Do not
            // rebuild the sidebar shell/list (and therefore do not lose its
            // row identity, focus or scroll anchor) merely to mark one Topic
            // active.
            patchSidebarTopicSelection();
            queueRender({ header: true, feed: true, composer: true });
            return;
        }
        if (event.type === 'assistant.delta' || event.type === 'reasoning.delta') {
            const tokenKey = `first-visible-delta:${event.turnId || event.messageId || 'current'}`;
            if (!state.uxTimings.has(tokenKey)) {
                state.uxTimings.set(tokenKey, uxMark('first-visible-delta', event.turnId || event.messageId));
            }
            noteTimelineActivity();
            // Delta events are the hot path.  Preserve focus, scroll anchors,
            // expanded tool cards and pending approval buttons by changing
            // only the matching assistant node.
            patchStreamingFeed(event);
            return;
        }
        if (event.type === 'interaction.consumed') {
            // Codex Thread and Projection Store are authoritative for order. Reload the
            // bounded queue projection rather than guessing which item moved
            // at a tool-safe boundary.
            void refreshControlPlane();
            queueRender({ header: true, composer: true });
            return;
        }
        if (event.type.startsWith('tool.') || event.type.startsWith('approval.')
            || event.type === 'assistant.started' || event.type === 'assistant.completed'
            || event.type === 'user.message' || event.type.startsWith('turn.')
            || event.type === 'ui.user_message.pending') {
            if (event.type !== 'approval.requested' && event.type !== 'approval.resolved' && event.type !== 'approval.expired') {
                noteTimelineActivity();
            }
            // Approvals live in the activity panel now; keep it in sync too.
            maybeAutoOpenActivity();
            queueRender({ feed: true, header: true, activity: true, composer: true });
            return;
        }
        if (event.type === 'toolbox.ws') {
            // Observer events moved out of the chat feed into the activity panel.
            queueRender({ activity: true });
            return;
        }
        if (event.type.startsWith('session.')) {
            queueRender({ shell: true, header: true, feed: true, composer: true });
            return;
        }
        if (event.type.startsWith('runtime.') || event.type.startsWith('context.')) {
            maybeAutoOpenActivity();
            queueRender({ header: true, activity: true, composer: true });
            return;
        }
        queueRender({ feed: true, activity: true, composer: true });
    }

    function latestRunningTool(current, turnId) {
        const tools = current.tools instanceof Map ? [...current.tools.values()] : [];
        return tools
            .filter((tool) => (!turnId || !tool.turnId || tool.turnId === turnId)
                && ['requested', 'running'].includes(tool.state))
            .sort((left, right) => Number(right.lastTimestamp || right.firstTimestamp || 0)
                - Number(left.lastTimestamp || left.firstTimestamp || 0))[0] || null;
    }

    function syncRunStatus(current = store.getState()) {
        const pendingTurnStart = selectedTurnStart(current);
        const turnId = selectedActiveTurnId(current) || pendingTurnStart?.turnId || null;
        const visible = Boolean(turnId || pendingTurnStart);
        if (!visible) {
            runStatusView.update({ visible: false });
            return;
        }
        const startedAt = turnId
            ? (state.turnStartedAt.get(turnId) || pendingTurnStart?.startedAt || Date.now())
            : (pendingTurnStart?.startedAt || Date.now());
        if (turnId && !state.turnStartedAt.has(turnId)) state.turnStartedAt.set(turnId, startedAt);
        const viewState = deriveWorkbenchViewState(current);
        const label = viewState === 'awaiting-approval'
            ? '等待审批'
            : pendingTurnStart?.phase === 'starting' && !selectedActiveTurnId(current)
                ? '正在启动 Agent'
                : '正在运行';
        const runningTool = latestRunningTool(current, turnId);
        runStatusView.update({
            visible: true,
            state: viewState,
            label,
            detail: runningTool
                ? `正在执行 ${projectVcpToolPresentation(runningTool).label}`
                : 'Agent 正在处理当前任务',
            startedAt,
            canStop: Boolean(selectedActiveTurnId(current)),
        });
    }

    function renderComposer() {
        const current = store.getState();
        const sessionId = selectedSessionKey(current);
        const composerState = selectedComposerState(current);
        const viewState = deriveWorkbenchViewState(current);
        // The composer is live only when the fixed R3 lifecycle state machine
        // reports the agent as idle, running, or parked on an actionable
        // approval — never while it is starting, reconnecting, or down.
        const previewReady = Boolean(current.selectedTopic?.mode === 'preview'
            && (viewState === 'idle' || viewState === 'running' || viewState === 'awaiting-approval'));
        const selectedArchived = Boolean(current.selectedTopic?.archivedAt);
        const composerReady = Boolean(!selectedArchived && (current.selectedSessionId || previewReady)
            && (viewState === 'idle' || viewState === 'running' || viewState === 'awaiting-approval'));
        const activeTurnId = selectedActiveTurnId(current);
        const hasActiveTurn = Boolean(activeTurnId);
        const pendingTurnStart = selectedTurnStart(current);
        // Once Codex confirms the Turn via turn.started/projection, the
        // normal running composer is usable again (steer/follow-up/cancel).
        // The ephemeral thinking row can remain until the first assistant
        // item arrives.
        const isStartingTurn = Boolean(pendingTurnStart && !hasActiveTurn);
        const canSend = Boolean(composerReady && (composerState.draft.trim()
            || (!hasActiveTurn && composerState.attachments.length)));
        const sendTitle = hasActiveTurn
            ? (composerState.activeInputMode === 'steer' ? '立即调整当前任务' : '排队到当前任务完成后')
            : '发送消息';
        const sendLabel = hasActiveTurn
            ? (composerState.activeInputMode === 'steer' ? '立即调整当前任务' : '排队后续指令')
            : '发送消息';
        const placeholder = selectedArchived
            ? '该会话已归档；恢复后才能继续发送。'
            : isStartingTurn
            ? (pendingTurnStart?.phase === 'thinking' ? '正在思考…' : '正在启动 Agent…')
            : (viewState === 'reconnecting' || viewState === 'error')
            ? '正在重新连接 Codex App Server…'
            : previewReady
            ? '输入消息…（发送时启动此会话）'
            : !current.selectedSessionId
            ? '请先创建 Agent 会话…'
            : viewState === 'starting'
            ? 'Agent Runtime 正在准备…'
            : hasActiveTurn
                ? (composerState.activeInputMode === 'steer'
                    ? '输入要立即调整的指令…'
                    : '输入任务完成后继续执行的指令…')
                : '输入消息…（Shift + Enter 换行）';
        const snapshot = current.selectedTopic?.configSnapshot || {};
        const instructionLabel = snapshot.instructionMode === 'codex-managed' ? 'Codex 指令' : 'VChat 身份';
        const reasoningLabel = snapshot.reasoningEffort ? `推理 ${snapshot.reasoningEffort}` : '推理 默认';
        const permissionLabel = state.permissionMode === 'always-approve' ? '本地审批：YOLO（设置）' : '本地审批：逐次确认（设置）';
        composerView.update({
            draft: composerState.draft,
            inputDisabled: !composerReady || isStartingTurn,
            sendDisabled: !composerReady || isStartingTurn || !canSend,
            // Attachment import is Session-scoped and remains available in a
            // normal SQLite preview, but never for archived/running Sessions.
            attachDisabled: !composerReady || hasActiveTurn || composerState.attachments.length >= 8,
            attachments: composerState.attachments,
            removeAttachment: (index) => {
                const next = composerState.attachments.slice();
                next.splice(index, 1);
                state.composerStateBySession.setAttachments(sessionId, next);
                renderComposer();
            },
            sendTitle,
            sendLabel,
            placeholder,
            busy: hasActiveTurn,
            ready: canSend,
            inputMode: composerState.activeInputMode,
            configText: `${snapshot.model || state.model || '模型默认'} · ${state.permissionMode === 'always-approve' ? '本地自动允许' : '逐次审批'} · ${instructionLabel} · ${reasoningLabel}`,
            configDisabled: !sessionId,
            permissionLabel,
            permissionActive: state.permissionMode === 'always-approve',
            newDisabled: state.topicCreating,
        });
        syncRunStatus(current);
    }

    function render() {
        if (state.disposed) return;
        renderSidebar();
        renderHeader();
        renderFeed();
        renderActivity();
        renderComposer();
        renderTopicFlow();
    }

    input.addEventListener('input', () => {
        state.composerStateBySession.setDraft(selectedSessionKey(), input.value);
        renderComposer();
    });
    feed.addEventListener('scroll', () => {
        const following = isFollowingContainer(feed);
        if (following === state.followingFeed && !(following && state.unreadTimelineCount)) return;
        state.followingFeed = following;
        if (following) state.unreadTimelineCount = 0;
        renderJumpToLatest();
    }, { passive: true });
    jumpToLatest.addEventListener('click', () => {
        state.followingFeed = true;
        state.unreadTimelineCount = 0;
        renderJumpToLatest();
        scrollFeed(feed, true);
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendButton.click(); }
    });
    attachButton.addEventListener('click', () => run(async () => {
        const result = await controller.selectAttachments();
        const imported = Array.isArray(result?.attachments) ? result.attachments : [];
        const sessionId = selectedSessionKey();
        const composerState = state.composerStateBySession.get(sessionId);
        const attachments = composerState.attachments.slice();
        const existing = new Set(attachments.map((item) => item.id));
        for (const attachment of imported) {
            if (!existing.has(attachment.id) && attachments.length < 8) {
                attachments.push(attachment);
                existing.add(attachment.id);
            }
        }
        state.composerStateBySession.setAttachments(sessionId, attachments);
        if (result?.errors?.length) notify(result.errors.join('；'), imported.length ? 'warning' : 'error');
        renderComposer();
    }));
    sendButton.addEventListener('click', () => run(async () => {
        const current = store.getState();
        const sessionId = selectedSessionKey(current);
        const composerState = state.composerStateBySession.get(sessionId);
        const prompt = composerState.draft.trim();
        const activeTurnId = selectedActiveTurnId(current);
        if (activeTurnId) {
            if (!prompt) return;
            const steering = prompt.match(/^\/steer\s+([\s\S]+)$/i);
            if (steering || composerState.activeInputMode === 'steer') {
                await controller.steerTurn(steering ? steering[1].trim() : prompt);
                notify('已插入即时 steering 指令。', 'success');
            } else {
                await controller.followUpTurn(prompt);
                notify('已加入后续指令队列。', 'success');
            }
            state.composerStateBySession.setDraft(sessionId, '');
            renderComposer();
            await refreshControlPlane();
            return;
        }
        if (!prompt && !composerState.attachments.length) return;
        const attachments = composerState.attachments.map((item) => ({ ...item }));
        const topicId = selectedSessionKey(current);
        const pendingTurnStart = {
            topicId,
            prompt,
            attachments,
            phase: 'starting',
            turnId: null,
            startedAt: Date.now(),
            createdAt: Date.now(),
        };
        state.turnStarts.set(topicId, pendingTurnStart);
        state.uxTimings.set(`turn-start:${topicId || 'new'}`, window.performance?.now?.() || Date.now());
        // Paint before awaiting Session Runtime/thread startup. This is the
        // same immediate feedback users get in main chat, while remaining a
        // renderer-only placeholder until Codex returns a real Turn ID.
        renderFeed();
        queueRender({ feed: true, header: true, composer: true });
        try {
            const accepted = await controller.startTurn(prompt, attachments);
            const currentStart = state.turnStarts.get(topicId);
            if (currentStart === pendingTurnStart) {
                state.turnStarts.set(topicId, {
                    ...currentStart,
                    phase: accepted?.turnId ? 'thinking' : 'starting',
                    turnId: accepted?.turnId || null,
                });
            }
            if (accepted?.turnId && !state.turnStartedAt.has(accepted.turnId)) {
                state.turnStartedAt.set(accepted.turnId, pendingTurnStart.startedAt || Date.now());
            }
            uxMark('turn-start-ack', accepted?.turnId, state.uxTimings.get(`turn-start:${topicId || 'new'}`) || null);
            // Preserve the draft if Runtime startup or Turn acceptance fails.
            // Codex is the only place that can confirm a Turn.
            state.composerStateBySession.clearAfterAcceptedSend(sessionId);
            settleTurnStartIndicator();
            queueRender({ feed: true, header: true, composer: true });
        } catch (error) {
            if (state.turnStarts.get(topicId) === pendingTurnStart
                || state.turnStarts.get(topicId)?.turnId === pendingTurnStart.turnId) {
                state.turnStarts.delete(topicId);
            }
            queueRender({ feed: true, header: true, composer: true });
            throw error;
        }
    }));
    newButton.addEventListener('click', openNewTopicFlow);

    const unsubscribe = store.subscribe((_nextState, event) => renderForStoreEvent(event));
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
        workspaceCoordinator.dispose();
        settingsState.dispose();
        closeTopicContextMenu();
        fullPresentation.dispose();
        activityReadonlyView.dispose();
        approvalView.dispose();
        notificationView.dispose();
        sessionDockView.dispose();
        topicFlowView.dispose();
        workspaceView.dispose();
        headerView.dispose();
        sidebarView?.dispose();
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
