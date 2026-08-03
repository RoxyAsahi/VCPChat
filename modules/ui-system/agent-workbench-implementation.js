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
        activitySearch: '',
        activitySourceFilter: 'all',
        activityKindFilter: 'all',
        activityTabPanels: new Map(),
        activityTabButtons: new Map(),
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
        // The Session sidebar is a stable DOM shell while its normal list is
        // visible. Projection refreshes patch its rows in place so a
        // background catalog read cannot discard the reader's scroll anchor,
        // search control or selected row.
        sessionSidebar: null,
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
    let topicSearchRequest = 0;
    let topicSearchTimer = null;
    let workspaceSearchTimer = null;
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
        activityPanel, activitySplitter, activityTabs, activityAdd, activityContent, activityTabRow,
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
    const workspaceRequests = createWorkspaceRequestCoordinator({
        cancel: ({ requestId, sessionId }) => {
            try { void controller.workspaceCancel({ requestId, sessionId }).catch(() => null); } catch {}
        },
    });
    let budgetAutosaveTimer = null;
    const settingsState = createAgentSettingsState();
    const sessionConfigRevisions = new Map();
    runStatusStop.addEventListener('click', () => run(async () => {
        runStatusStop.disabled = true;
        await controller.cancelTurn();
    }));

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
    const approvalRegistry = new Map();
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

    function patchSessionSidebar() {
        const shell = state.sessionSidebar;
        if (!shell || shell.agentId !== state.selectedAgent || state.tab !== 'sessions'
            || state.topicManaging || state.topicSearchOpen || state.topicSearch.trim()) return false;
        const { liveSessions, persistedTopics, selectedTopicId } = sessionSidebarEntries();
        const desired = [
            ...liveSessions.map((session) => ({ id: session.topicId, live: true, value: session })),
            ...persistedTopics.map((topic) => ({ id: topic.id, live: false, value: topic })),
        ];
        // `children` avoids a JSDOM/Chromium `:scope` edge case and makes the
        // ownership boundary explicit: only direct Topic rows participate in
        // keyed reconciliation, never the empty/search status helpers.
        const rows = [...shell.list.children].filter((row) => row.classList.contains('agent-chat-session-row'));
        if (rows.length !== desired.length || rows.some((row, index) => row.dataset.topicId !== desired[index].id)) {
            return false;
        }

        for (const [index, entry] of desired.entries()) {
            const row = rows[index];
            const active = entry.id === selectedTopicId;
            const activity = sessionActivity(entry.id, entry.value.activity);
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
            row.dataset.topicSearch = `${entry.value.title || entry.id} ${entry.value.model || ''}`.toLocaleLowerCase();
            const title = row.querySelector('.topic-title-display');
            if (title) title.textContent = entry.value.title || entry.id;
            if (entry.live) {
                const count = row.querySelector('.message-count');
                if (count) count.textContent = active
                    ? String(store.getState().messages.length)
                    : activity === 'awaiting-approval' ? '!' : '';
            } else {
                row.title = entry.value.searchHit?.snippet || '';
            }
        }
        return true;
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

    function renderSidebar() {
        syncModelFromSelectedSession();
        if (patchSessionSidebar()) return;
        // A change of sidebar mode/form is intentionally a shell transition.
        // Ordinary Topic refreshes take the keyed fast path above instead.
        state.sessionSidebar = null;
        // Topic selection is allowed to update the renderer projection, but
        // it must not throw the conversation list back to its top.
        const scrollTop = sidebar.scrollTop;
        sidebar.replaceChildren();
        const tabs = node('div', 'sidebar-tabs');
        for (const [id, label] of [['agents', '助手'], ['sessions', '会话'], ['settings', '设置']]) {
            const tab = node('button', `sidebar-tab-button${state.tab === id ? ' active' : ''}`, label);
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(state.tab === id));
            tab.addEventListener('click', () => {
                closeTopicContextMenu();
                state.tab = id;
                // Topic management is a transient renderer affordance. Never
                // leave selection mode active while the Topic page is hidden.
                if (id !== 'sessions') {
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    state.topicSearchOpen = false;
                    state.topicSearch = '';
                    state.topicSearchResults = [];
                    state.topicSearchLoading = false;
                    state.topicSearchError = '';
                    topicSearchRequest += 1;
                }
                renderSidebar();
                // Session projection metadata may have changed while
                // this page was hidden. Opening the tab never creates a
                // Session; it simply refreshes the selected Agent's history.
                if (id === 'sessions') run(() => refreshControlPlane());
                else if (id === 'settings') void refreshRecoveryOperations();
            });
            tabs.append(tab);
        }
        const content = node('div', 'sidebar-tab-content active agent-chat-sidebar-content');
        if (state.tab === 'sessions') {
            const header = node('div', 'topics-header-container');
            const tools = node('div', 'next-ui-topic-tools');
            // Keep the Topic toolbar structurally identical to the main
            // chat's Topic toolbar. The callbacks deliberately stay local to
            // the Workbench: Agent Sessions are SQLite/Codex-owned objects.
            const add = visualActionButton('add', '新建会话', 'next-ui-create-topic-trigger', '新建会话');
            add.disabled = state.topicCreating;
            add.addEventListener('click', openNewTopicFlow);
            const manage = visualActionButton('checklist', '管理会话', 'next-ui-topic-icon-trigger');
            manage.disabled = state.showArchivedTopics;
            manage.addEventListener('click', () => {
                closeTopicContextMenu();
                state.topicManaging = !state.topicManaging;
                if (!state.topicManaging) state.topicSelectedIds.clear();
                renderSidebar();
            });
            manage.classList.toggle('active', state.topicManaging);
            manage.setAttribute('aria-pressed', String(state.topicManaging));
            const searchTrigger = visualActionButton('search', '搜索会话', 'next-ui-topic-icon-trigger');
            searchTrigger.setAttribute('aria-expanded', String(state.topicSearchOpen));
            const archiveToggle = visualActionButton('archive', state.showArchivedTopics ? '返回当前会话' : '查看归档会话', 'next-ui-topic-icon-trigger');
            archiveToggle.setAttribute('aria-pressed', String(state.showArchivedTopics));
            archiveToggle.addEventListener('click', () => {
                closeTopicContextMenu();
                state.showArchivedTopics = !state.showArchivedTopics;
                state.topicManaging = false;
                state.topicSelectedIds.clear();
                state.topicSearchOpen = false;
                state.topicSearch = '';
                state.topicSearchResults = [];
                renderSidebar();
                run(() => refreshTopicsForAgent(state.selectedAgent, state.showArchivedTopics));
            });
            tools.append(add, manage, searchTrigger, archiveToggle);

            const { panel: searchPanel, input: search, close: closeSearch } = createSidebarSearchPanel(
                'agentWorkbenchTopicSearchInput', '搜索 Agent 会话', '搜索会话...',
                'next-ui-topic-search-close', '关闭会话搜索',
            );
            search.value = state.topicSearch;
            closeSearch.title = '关闭搜索';
            closeSearch.setAttribute('aria-label', '关闭会话搜索');
            searchTrigger.setAttribute('aria-controls', search.id);
            header.classList.toggle('is-searching', state.topicSearchOpen);
            const setSearchOpen = (open, clear = !open) => {
                state.topicSearchOpen = open;
                searchTrigger.setAttribute('aria-expanded', String(open));
                header.classList.toggle('is-searching', open);
                if (clear) {
                    state.topicSearch = '';
                    state.topicSearchResults = [];
                    state.topicSearchLoading = false;
                    state.topicSearchError = '';
                    topicSearchRequest += 1;
                    search.value = '';
                    applyTopicFilter();
                }
                if (open) queueMicrotask(() => search.focus());
            };
            searchTrigger.addEventListener('click', () => setSearchOpen(true, false));
            closeSearch.addEventListener('click', () => setSearchOpen(false));
            search.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    setSearchOpen(false);
                    searchTrigger.focus();
                }
            });
            header.append(tools, searchPanel);
            content.append(header);
            if (profileNeedsConfiguration()) {
                const warning = node('section', 'agent-chat-profile-configuration-warning');
                warning.setAttribute('role', 'status');
                warning.append(
                    node('strong', '', '需要配置 Agent 提示词'),
                    node('span', '', state.profileConfigurationNotice
                        || `Agent「${selectedAgentProfile()?.name || state.selectedAgent}」缺少提示词，暂时不能新建会话。`),
                );
                const configure = button('去设置', 'secondary agent-chat-profile-configuration-action');
                configure.addEventListener('click', () => {
                    state.tab = 'settings';
                    renderSidebar();
                });
                warning.append(configure);
                content.append(warning);
            }
            const list = node('ul', 'topic-list agent-chat-session-list');
            const { liveSessions, persistedTopics: normalPersistedTopics, selectedTopicId } = sessionSidebarEntries();
            const indexedTopics = state.topicSearch.trim()
                ? state.topicSearchResults.map((hit) => ({
                    id: hit.topicId,
                    title: hit.title || hit.topicId,
                    agentId: hit.agentId || state.selectedAgent,
                    inUse: hit.inUse === true,
                    readOnly: hit.readOnly === true,
                    model: hit.model || '',
                    workspaceRef: hit.workspaceRef || '',
                    updatedAt: hit.updatedAt || hit.timestamp || 0,
                    searchHit: hit,
                }))
                : normalPersistedTopics;
            const persistedTopics = indexedTopics.filter((topic) => !liveSessions.some((session) => session.topicId === topic.id));
            if (!state.topicSearch.trim() && !liveSessions.length && !persistedTopics.length) {
                if (state.topicListLoading) {
                    for (let index = 0; index < 4; index += 1) {
                        list.append(node('li', 'topic-item agent-chat-session-row agent-chat-session-skeleton', ''));
                    }
                } else {
                    list.append(node('li', 'agent-chat-empty-list', state.showArchivedTopics
                        ? `${state.selectedAgent || '当前 Agent'} 没有已归档会话。`
                        : `${state.selectedAgent || '当前 Agent'} 还没有会话。创建一个会话后即可开始。`));
                }
            }
            for (const session of liveSessions) {
                const active = session.topicId === selectedTopicId;
                // Keep this deliberately isomorphic to topicListManager's main
                // chat rows.  The only different bit is the select callback.
                const activity = sessionActivity(session.topicId, session.activity);
                const row = node('li', `topic-item agent-chat-session-row${active ? ' active active-topic-glowing' : ''}${['starting', 'running'].includes(activity) ? ' is-running' : ''}${activity === 'awaiting-approval' ? ' is-awaiting-approval' : ''}`);
                row.tabIndex = 0;
                row.dataset.itemId = session.agentId || state.selectedAgent || 'Nova';
                row.dataset.itemType = 'agent-runtime';
                row.dataset.topicId = session.topicId;
                row.dataset.topicInUse = 'false';
                row.dataset.runtimeActivity = activity;
                row.dataset.topicSearch = `${session.title} ${session.model}`.toLocaleLowerCase();
                const avatar = createSessionAvatar(session.topicId, session.agentId || state.selectedAgent,
                    `${state.selectedAgent || 'Nova'} - ${session.title}`, activity);
                const title = node('span', 'topic-title-display', session.title);
                const count = node('span', 'message-count', active
                    ? String(store.getState().messages.length)
                    : activity === 'awaiting-approval' ? '!' : '');
                row.append(avatar, title, count);
                // The row represents a live Session Runtime. Its transcript is
                // still rebuilt only from the durable Session projection.
                row.addEventListener('click', () => run(() => controller.hydrateTopic(session.topicId, session, null, session.agentId)));
                if (!state.topicManaging && session.topicId) {
                    appendTopicActions(row, {
                        id: session.topicId,
                        title: session.title,
                        agentId: session.agentId,
                        model: session.model,
                        workspaceRef: session.workspaceRoot,
                        inUse: false,
                    }, { live: true });
                }
                list.append(row);
            }
            // Persisted Sessions render with the same main-chat row contract.
            // Selection changes only the SQLite projection being viewed.
            for (const topic of persistedTopics) {
                const selectable = true;
                const selected = state.topicSelectedIds.has(topic.id);
                const active = topic.id === selectedTopicId;
                const row = node('li', `topic-item agent-chat-session-row agent-chat-persisted-topic${selected ? ' selected' : ''}${active ? ' active active-topic-glowing' : ''}`);
                row.tabIndex = 0;
                row.dataset.itemId = topic.agentId || state.selectedAgent || 'Nova';
                row.dataset.itemType = 'agent-topic';
                row.dataset.topicId = topic.id;
                row.dataset.topicSearch = `${topic.title || topic.id} ${topic.model || ''}`.toLocaleLowerCase();
                const avatar = createSessionAvatar(topic.id, topic.agentId || state.selectedAgent,
                    `${topic.agentId || 'Nova'} - ${topic.title || topic.id}`);
                const title = node('span', 'topic-title-display', topic.title || topic.id);
                const status = topic.searchHit ? node('span', 'message-count', '匹配') : null;
                if (topic.searchHit?.snippet) row.title = topic.searchHit.snippet;
                row.append(avatar, title);
                if (status) row.append(status);
                if (selectable) {
                    const selectIcon = node('span', 'vcp-ui-icon next-ui-topic-select-icon', selected ? 'check_box' : 'check_box_outline_blank');
                    selectIcon.setAttribute('aria-hidden', 'true');
                    row.prepend(selectIcon);
                }
                row.setAttribute('aria-selected', String(selected));
                row.addEventListener('click', (event) => run(async () => {
                    if (event.target.closest('.agent-chat-session-menu')) return;
                    if (state.topicManaging) {
                        if (!selectable) return;
                        if (state.topicSelectedIds.has(topic.id)) state.topicSelectedIds.delete(topic.id);
                        else state.topicSelectedIds.add(topic.id);
                        renderSidebar();
                        return;
                    }
                    await controller.previewTopic(topic.id, topic.agentId, topic);
                    rememberTopic({ topicId: topic.id });
                }));
                if (!state.topicManaging) appendTopicActions(row, topic);
                list.append(row);
            }
            const applyTopicFilter = () => {
                const query = search.value.trim().toLocaleLowerCase();
                state.topicSearch = search.value;
                for (const row of list.querySelectorAll('[data-topic-search]')) {
                    row.hidden = Boolean(query) && !state.topicSearchResults.length && !row.dataset.topicSearch.includes(query);
                }
            };
            search.addEventListener('input', () => {
                applyTopicFilter();
                lifecycle.clear('topic-search');
                const query = search.value.trim();
                const request = ++topicSearchRequest;
                if (!query) {
                    state.topicSearchResults = [];
                    state.topicSearchLoading = false;
                    state.topicSearchError = '';
                    renderSidebar();
                    return;
                }
                state.topicSearchLoading = true;
                state.topicSearchError = '';
                topicSearchTimer = lifecycle.timeout('topic-search', () => run(async () => {
                    try {
                        const hits = await controller.searchTopics(query, state.selectedAgent, 50);
                        if (request !== topicSearchRequest || query !== state.topicSearch.trim()) return;
                        state.topicSearchResults = Array.isArray(hits) ? hits : [];
                    } catch (error) {
                        if (request !== topicSearchRequest) return;
                        state.topicSearchResults = [];
                        state.topicSearchError = error?.message || String(error);
                    } finally {
                        if (request === topicSearchRequest) {
                            state.topicSearchLoading = false;
                            renderSidebar();
                            queueMicrotask(() => {
                                const active = document.getElementById('agentWorkbenchTopicSearchInput');
                                active?.focus();
                                active?.setSelectionRange(active.value.length, active.value.length);
                            });
                        }
                    }
                }), 180);
            });
            applyTopicFilter();
            const scroll = node('div', 'sidebar-list-scroll');
            scroll.append(list);
            if (state.topicSearchLoading) scroll.prepend(node('div', 'agent-chat-empty-list', '正在搜索 Agent 会话…'));
            else if (state.topicSearchError) scroll.prepend(node('div', 'agent-chat-empty-list', `索引搜索不可用：${state.topicSearchError}`));
            else if (state.topicSearch.trim() && !persistedTopics.length) scroll.prepend(node('div', 'agent-chat-empty-list', '没有匹配的 Agent Topic。'));
            content.append(scroll);
            if (state.topicManaging) {
                content.classList.add('is-managing');
                const panel = node('div', 'next-ui-topic-manage-panel agent-chat-topic-manage-panel');
                panel.setAttribute('aria-hidden', 'false');
                const selection = node('div', 'next-ui-topic-manage-selection');
                const selectAll = button('', 'next-ui-topic-manage-button');
                selectAll.title = '全选可归档会话';
                selectAll.setAttribute('aria-label', '全选可归档会话');
                const visibleSelectableIds = [...list.querySelectorAll('.agent-chat-persisted-topic[data-topic-id]')]
                    .filter((row) => !row.hidden && !state.topics.find((topic) => topic.id === row.dataset.topicId)?.inUse)
                    .map((row) => row.dataset.topicId);
                const allSelected = visibleSelectableIds.length > 0
                    && visibleSelectableIds.every((topicId) => state.topicSelectedIds.has(topicId));
                selectAll.append(...icon(allSelected ? 'check_box' : 'check_box_outline_blank'));
                selectAll.addEventListener('click', () => {
                    if (allSelected) visibleSelectableIds.forEach((topicId) => state.topicSelectedIds.delete(topicId));
                    else visibleSelectableIds.forEach((topicId) => state.topicSelectedIds.add(topicId));
                    renderSidebar();
                });
                const selectionCount = node('span', 'agent-chat-topic-selection-count', `已选择 ${state.topicSelectedIds.size} 项`);
                selectionCount.setAttribute('aria-live', 'polite');
                selection.append(selectAll, selectionCount);
                const actions = node('div', 'next-ui-topic-manage-actions');
                const removeSelected = button('', 'next-ui-topic-manage-button danger');
                removeSelected.title = '归档所选会话';
                removeSelected.setAttribute('aria-label', '归档所选会话');
                removeSelected.disabled = state.topicSelectedIds.size === 0;
                removeSelected.append(...icon('delete'));
                removeSelected.addEventListener('click', () => run(async () => {
                    const selectedTopics = persistedTopics.filter((topic) => state.topicSelectedIds.has(topic.id));
                    if (!selectedTopics.length) return;
                    const confirmed = window.confirm?.(`确定归档选中的 ${selectedTopics.length} 个 Agent 会话吗？`);
                    if (!confirmed) return;
                    for (const topic of selectedTopics) {
                        await controller.deleteTopic(topic.id, topic.agentId);
                        forgetTopic(topic.id);
                    }
                    state.topicSelectedIds.clear();
                    state.topicManaging = false;
                    await refreshTopicsForAgent(agentId);
                    notify(`已归档 ${selectedTopics.length} 个 Agent 会话。`, 'success');
                }));
                const exit = button('', 'next-ui-topic-manage-button');
                exit.title = '退出管理';
                exit.setAttribute('aria-label', '退出会话管理');
                exit.append(...icon('close'));
                exit.addEventListener('click', () => {
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    renderSidebar();
                });
                actions.append(removeSelected, exit);
                panel.append(selection, actions);
                content.append(panel);
            }
            if (!state.topicManaging && !state.topicSearchOpen && !state.topicSearch.trim()) {
                state.sessionSidebar = { tabs, content, header, list, scroll, agentId: state.selectedAgent };
            }
        } else if (state.tab === 'agents') {
            const header = node('div', 'agents-header');
            const tools = node('div', 'next-ui-agent-tools');
            const add = visualActionButton('add', '新建 Build Agent', 'next-ui-create-item-trigger', '新建 Build Agent');
            add.addEventListener('click', openNewAgentFlow);
            const searchTrigger = visualActionButton('search', '搜索助手或群', 'next-ui-agent-search-trigger');
            searchTrigger.setAttribute('aria-expanded', String(Boolean(state.agentSearch)));
            tools.append(add, searchTrigger);

            const { panel: searchPanel, input: search, close: closeSearch } = createSidebarSearchPanel(
                'agentWorkbenchSearchInput', '搜索助手或群', '搜索助手或群...',
                'next-ui-agent-search-close', '关闭助手搜索',
            );
            search.value = state.agentSearch;
            closeSearch.title = '关闭搜索';
            closeSearch.setAttribute('aria-label', '关闭助手搜索');
            searchTrigger.setAttribute('aria-controls', search.id);
            const setSearchOpen = (open, clear = !open) => {
                header.classList.toggle('is-searching', open);
                searchTrigger.setAttribute('aria-expanded', String(open));
                if (clear) {
                    state.agentSearch = '';
                    search.value = '';
                }
                if (open) queueMicrotask(() => search.focus());
            };
            searchTrigger.addEventListener('click', () => setSearchOpen(true, false));
            closeSearch.addEventListener('click', () => setSearchOpen(false));
            search.addEventListener('input', () => {
                state.agentSearch = search.value;
                for (const row of list.querySelectorAll('[data-agent-search]')) {
                    row.hidden = Boolean(state.agentSearch.trim())
                        && !row.dataset.agentSearch.includes(state.agentSearch.trim().toLocaleLowerCase());
                }
            });
            search.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    setSearchOpen(false);
                    searchTrigger.focus();
                }
            });
            header.append(tools, searchPanel);
            content.append(header);
            const list = node('ul', 'agent-list agent-chat-agent-list');
            for (const agent of state.agentCatalog) {
                const agentId = agent.id || agent.name;
                const row = node('li', `agent-chat-agent-row${sameAgent(agentId, state.selectedAgent) ? ' active' : ''}${agent.configurationRequired ? ' configuration-required' : ''}`);
                row.tabIndex = 0;
                row.dataset.agentSearch = `${agent.name || ''} ${agentId || ''}`.toLocaleLowerCase();
                const avatar = document.createElement('img');
                avatar.className = 'avatar';
                avatar.src = agent.avatarUrl || 'assets/default_avatar.png';
                avatar.alt = `${agent.name || agentId} 头像`;
                avatar.onerror = () => { avatar.src = 'assets/default_avatar.png'; };
                row.append(avatar, node('span', 'agent-name', agent.name || agentId));
                if (agent.configurationRequired) {
                    const warning = node('span', 'vcp-ui-icon agent-chat-agent-configuration-icon', 'warning');
                    warning.title = '缺少 Agent 提示词';
                    warning.setAttribute('aria-label', '缺少 Agent 提示词');
                    row.append(warning);
                }
                row.addEventListener('click', () => run(async () => {
                    state.uxTimings.set(`agent-click:${agentCacheKey(agentId)}`, uxMark('agent-click', agentId));
                    const currentSelection = store.getState();
                    const selectedSessionAgent = currentSelection.selectedTopic?.agentId;
                    if (currentSelection.selectedSessionId
                        && (!selectedSessionAgent || !sameAgent(selectedSessionAgent, agentId))) {
                        controller.clearSelection();
                    }
                    selectAgent(agentId);
                    // Selecting an Agent is a browse action, not an implicit
                    // create-session action. Go straight to its durable SQLite
                    // Session catalog so prior history is visible immediately.
                    state.tab = 'sessions';
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    state.topicSearchOpen = false;
                    state.topicSearch = '';
                    queueRender({ shell: true, header: true, composer: true });
                    await refreshControlPlane();
                }));
                list.append(row);
            }
            if (!state.agentCatalog.length) list.append(node('li', 'agent-chat-empty-list', '正在读取 Agent 目录…'));
            const scroll = node('div', 'sidebar-list-scroll');
            scroll.append(list);
            content.append(scroll);
        } else {
            content.append(renderAgentSettingsPane({
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
            }));
        }
        accountView.update();
        sidebar.append(tabs, content, accountView.element);
        if (sidebar.scrollTop !== scrollTop) sidebar.scrollTop = scrollTop;
    }

    function renderTopicFlow() {
        topicFlowLayer.replaceChildren();
        const flow = state.topicFlow;
        topicFlowLayer.hidden = !flow;
        if (!flow) return;

        const backdrop = node('div', 'agent-chat-topic-flow-backdrop');
        const dialog = node('section', 'agent-chat-topic-flow-dialog');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'agentChatTopicFlowTitle');
        dialog.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !flow.saving) closeTopicFlow();
        });
        backdrop.addEventListener('click', () => { if (!flow.saving) closeTopicFlow(); });

        if (flow.kind === 'create') {
            const title = node('h2', 'agent-chat-topic-flow-title', '新建 Agent 会话');
            title.id = 'agentChatTopicFlowTitle';
            const description = node('p', 'agent-chat-topic-flow-description',
                '创建独立的 Codex 会话并继承 Agent Profile。其它 Thread 可继续运行；首次发送时才会启动此 Thread。');
            const context = node('section', 'agent-chat-topic-flow-context');
            context.setAttribute('aria-label', 'Topic 创建配置来源');
            const addContext = (label, value) => {
                const item = node('div', 'agent-chat-topic-flow-context-item');
                item.append(node('span', 'agent-chat-topic-flow-context-label', label), node('strong', 'agent-chat-topic-flow-context-value', value));
                context.append(item);
            };
            const profile = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, flow.agent));
            addContext('Agent Profile', profile?.name || flow.agent || '尚未选择');
            addContext('模型', profile?.model || '使用 VCPChat 默认模型');
            addContext('工作目录', profile?.workspaceRoot || '使用 VCPChat 当前工作目录');
            addContext('本地工具审批', profile?.permissionMode === 'always-approve' ? 'YOLO：本地自动允许' : '每次确认');
            const form = node('form', 'agent-chat-topic-flow-form');
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                run(async () => {
                    if (!state.topicFlow || state.topicFlow.kind !== 'create') return;
                    state.topicFlow = { ...state.topicFlow, saving: true };
                    queueRender({ topicFlow: true });
                    try {
                        const created = await createTopic({
                            title: state.topicFlow.title.trim() || nextSessionTitle(),
                            agent: state.topicFlow.agent,
                        });
                        state.topicFlow = null;
                        state.tab = 'sessions';
                        notify(`已新建 Topic「${created.title || created.topicId}」。`, 'success');
                    } finally {
                        if (state.topicFlow?.kind === 'create') state.topicFlow = { ...state.topicFlow, saving: false };
                        queueRender({ shell: true, header: true, feed: true, composer: true, topicFlow: true });
                    }
                });
            });
            const field = (label, control) => {
                const wrap = node('label', 'agent-chat-topic-flow-field');
                wrap.append(node('span', 'agent-chat-topic-flow-label', label), control);
                return wrap;
            };
            const titleInput = document.createElement('input');
            titleInput.className = 'agent-chat-topic-flow-input';
            titleInput.value = flow.title;
            titleInput.maxLength = 120;
            titleInput.setAttribute('aria-label', 'Topic 标题');
            titleInput.addEventListener('input', () => { if (state.topicFlow?.kind === 'create') state.topicFlow.title = titleInput.value; });

            const actions = node('div', 'agent-chat-topic-flow-actions');
            const cancel = button('取消', 'secondary');
            cancel.disabled = flow.saving;
            cancel.addEventListener('click', closeTopicFlow);
            const submit = button(flow.saving ? '正在创建…' : '创建并打开', 'primary');
            submit.type = 'submit';
            submit.disabled = flow.saving || !flow.agent;
            actions.append(cancel, submit);
            form.append(
                field('Topic 标题', titleInput),
                node('p', 'agent-chat-topic-flow-description', '模型、提示词、工作目录和审批模式来自上方 Agent Profile；创建后可在 Session 设置中调整允许变更的字段。'),
                actions,
            );
            dialog.append(title, description, context, form);
        } else if (flow.kind === 'agent') {
            const title = node('h2', 'agent-chat-topic-flow-title', '新建 Build Agent');
            title.id = 'agentChatTopicFlowTitle';
            const description = node('p', 'agent-chat-topic-flow-description',
                '创建独立于主聊天助手目录的 Build Agent。提示词会冻结到以后新建的 Session。');
            const form = node('form', 'agent-chat-topic-flow-form');
            const field = (label, control) => {
                const wrap = node('label', 'agent-chat-topic-flow-field');
                wrap.append(node('span', 'agent-chat-topic-flow-label', label), control);
                return wrap;
            };
            const nameInput = document.createElement('input');
            nameInput.className = 'agent-chat-topic-flow-input';
            nameInput.value = flow.name;
            nameInput.maxLength = 80;
            nameInput.required = true;
            nameInput.setAttribute('aria-label', 'Build Agent 名称');
            nameInput.addEventListener('input', () => { if (state.topicFlow?.kind === 'agent') state.topicFlow.name = nameInput.value; });
            const promptInput = document.createElement('textarea');
            promptInput.className = 'agent-chat-topic-flow-input agent-chat-setting-prompt';
            promptInput.value = flow.systemPrompt;
            promptInput.rows = 7;
            promptInput.required = true;
            promptInput.placeholder = '例如：{{Nova}}';
            promptInput.setAttribute('aria-label', 'Build Agent 提示词');
            promptInput.addEventListener('input', () => { if (state.topicFlow?.kind === 'agent') state.topicFlow.systemPrompt = promptInput.value; });
            const modelInput = document.createElement('input');
            modelInput.className = 'agent-chat-topic-flow-input';
            modelInput.value = flow.model;
            modelInput.setAttribute('aria-label', 'Build Agent 默认模型');
            modelInput.setAttribute('list', 'agentChatAgentFlowModels');
            modelInput.addEventListener('input', () => { if (state.topicFlow?.kind === 'agent') state.topicFlow.model = modelInput.value; });
            const modelList = document.createElement('datalist');
            modelList.id = 'agentChatAgentFlowModels';
            for (const model of state.modelCatalog) {
                const option = document.createElement('option');
                option.value = model.id || model.name || String(model);
                modelList.append(option);
            }
            const workspaceInput = document.createElement('input');
            workspaceInput.className = 'agent-chat-topic-flow-input';
            workspaceInput.value = flow.workspaceRoot;
            workspaceInput.placeholder = '留空使用 VCPChat 当前工作目录';
            workspaceInput.setAttribute('aria-label', 'Build Agent 默认工作目录');
            workspaceInput.addEventListener('input', () => {
                if (state.topicFlow?.kind === 'agent') state.topicFlow.workspaceRoot = workspaceInput.value;
            });
            const permissionSelect = document.createElement('select');
            permissionSelect.className = 'agent-chat-topic-flow-input';
            permissionSelect.setAttribute('aria-label', 'Build Agent 默认审批模式');
            for (const [value, label] of [
                ['ask', '每次确认（推荐）'],
                ['always-approve', 'YOLO：本地自动允许'],
            ]) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                option.selected = value === flow.permissionMode;
                permissionSelect.append(option);
            }
            permissionSelect.addEventListener('change', () => {
                if (state.topicFlow?.kind === 'agent') state.topicFlow.permissionMode = permissionSelect.value;
            });
            const actions = node('div', 'agent-chat-topic-flow-actions');
            const cancel = button('取消', 'secondary');
            cancel.type = 'button';
            cancel.disabled = flow.saving;
            cancel.addEventListener('click', closeTopicFlow);
            const submit = button(flow.saving ? '正在创建…' : '创建助手', 'primary');
            submit.type = 'submit';
            submit.disabled = flow.saving || !flow.name.trim() || !flow.systemPrompt.trim();
            actions.append(cancel, submit);
            form.append(
                field('名称', nameInput),
                field('提示词', promptInput),
                field('默认模型（可留空）', modelInput),
                modelList,
                field('默认工作目录（可留空）', workspaceInput),
                field('默认本地工具审批', permissionSelect),
                actions,
            );
            form.addEventListener('input', () => {
                submit.disabled = Boolean(state.topicFlow?.saving) || !nameInput.value.trim() || !promptInput.value.trim();
            });
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                run(async () => {
                    if (!state.topicFlow || state.topicFlow.kind !== 'agent' || state.topicFlow.saving) return;
                    const request = {
                        name: state.topicFlow.name.trim(),
                        systemPrompt: state.topicFlow.systemPrompt.trim(),
                        model: state.topicFlow.model.trim() || undefined,
                        workspaceRoot: state.topicFlow.workspaceRoot.trim() || undefined,
                        permissionMode: state.topicFlow.permissionMode,
                    };
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
            });
            dialog.append(title, description, form);
        }
        topicFlowLayer.append(backdrop, dialog);
        // A microtask avoids stealing the click that opened the dialog while
        // still providing predictable keyboard focus for the next action.
        queueMicrotask(() => dialog.focus());
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

    function buildDockMenu() {
        const menu = node('div', 'agent-chat-dock-menu');
        menu.setAttribute('role', 'menu');
        const current = store.getState();
        const changesAvailable = [...(current.tools instanceof Map ? current.tools.values() : [])]
            .some((tool) => Array.isArray(tool?.payload?.changes?.files) && tool.payload.changes.files.length);
        const commands = [
            ['folder_open', '打开文件', () => openDockKind('files')],
            ...(changesAvailable ? [['difference', '查看变更', () => openDockKind('changes')]] : []),
            ['data_usage', '上下文', () => openDockKind('context')],
            ['notifications', '通知', () => openDockKind('notifications')],
            ['approval', '审批', () => openDockKind('approvals')],
            ['terminal', '在 VChat 终端中打开', () => run(async () => {
                const result = await runtimeApi().desktopLaunchVchatApp?.('open-powershell-executor-terminal');
                if (result && result.success === false) throw new Error(result.error || '无法打开 VChat 终端。');
                state.dockMenuOpen = false;
                renderActivity();
            })],
        ];
        for (const [symbol, label, action] of commands) {
            const item = button('', 'agent-chat-dock-menu-item');
            item.setAttribute('role', 'menuitem');
            item.append(node('span', 'vcp-ui-icon', symbol), node('span', '', label));
            item.addEventListener('click', action);
            menu.append(item);
        }
        return menu;
    }

    activityAdd.addEventListener('click', (event) => {
        event.stopPropagation();
        state.dockMenuOpen = !state.dockMenuOpen;
        activityAdd.setAttribute('aria-expanded', String(state.dockMenuOpen));
        renderActivity();
    });
    const closeDockMenuOnOutsideClick = (event) => {
        if (!state.dockMenuOpen || activityTabRow.contains(event.target)) return;
        state.dockMenuOpen = false;
        activityAdd.setAttribute('aria-expanded', 'false');
        renderActivity();
    };
    lifecycle.listen(document, 'click', closeDockMenuOnOutsideClick);

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

    function buildConnectionPanel(current, viewState) {
        const wrap = node('div', 'agent-chat-activity-connection');
        const stateMap = {
            idle: { icon: 'check_circle', tone: 'success', title: '连接正常' },
            running: { icon: 'check_circle', tone: 'success', title: '运行中' },
            starting: { icon: 'pending', tone: 'warning', title: '正在启动' },
            'awaiting-approval': { icon: 'pending', tone: 'warning', title: '等待审批' },
            reconnecting: { icon: 'sync', tone: 'warning', title: '正在重新连接' },
            disconnected: { icon: 'cloud_off', tone: 'muted', title: '未连接' },
            error: { icon: 'error', tone: 'danger', title: '连接错误' },
        };
        const stateInfo = stateMap[viewState] || stateMap.disconnected;
        const card = node('div', `agent-chat-connection-card agent-chat-connection-${stateInfo.tone}`);
        const status = node('div', 'agent-chat-connection-status');
        status.append(...icon(stateInfo.icon), node('span', '', stateInfo.title));
        card.append(status);
        if (viewState === 'error') {
            const runtime = current.runtime || {};
            const rawError = typeof runtime.lastError === 'object' ? runtime.lastError?.error : runtime.lastError;
            const message = String(rawError || 'Codex App Server 已中断').slice(0, 280);
            card.append(node('p', 'agent-chat-connection-message', message));
            const reconnect = button('重新连接', 'primary agent-chat-connection-reconnect');
            reconnect.addEventListener('click', () => run(recoverRuntime));
            card.append(reconnect);
        } else if (viewState === 'reconnecting') {
            card.append(node('p', 'agent-chat-connection-message', '正在重新连接 Codex App Server，并从 Projection SQLite 对账会话展示…'));
        } else {
            card.append(node('p', 'agent-chat-connection-message', WORKBENCH_VIEW_STATE_LABELS[viewState] || viewState));
        }
        wrap.append(card);
        const readiness = current.readiness || {};
        const readinessGrid = node('section', 'agent-chat-readiness-grid');
        readinessGrid.setAttribute('aria-label', 'Codex Agent readiness');
        const readinessEntries = [
            ['server', 'Codex App Server'],
            ['profile', 'Projection SQLite / Agent 配置'],
            ['toolbox', 'VCPToolBox Bridge'],
            ['capability', 'VCPToolBox 动态能力'],
        ];
        const readinessState = {
            ready: { icon: 'check_circle', label: '就绪', tone: 'success' },
            configured: { icon: 'settings', label: '已配置', tone: 'success' },
            checking: { icon: 'pending', label: '检查中', tone: 'warning' },
            unknown: { icon: 'help', label: '未知', tone: 'muted' },
            unavailable: { icon: 'cloud_off', label: '不可用', tone: 'danger' },
            missing: { icon: 'error', label: '缺少配置', tone: 'danger' },
        };
        for (const [key, label] of readinessEntries) {
            const item = readiness[key] || { state: 'unknown', detail: '等待 Agent Runtime 状态事件' };
            const info = readinessState[item.state] || readinessState.unknown;
            const readinessCard = node('article', `agent-chat-readiness-card agent-chat-readiness-${info.tone}`);
            readinessCard.dataset.readiness = key;
            const heading = node('div', 'agent-chat-readiness-heading');
            heading.append(...icon(info.icon), node('span', '', label), node('span', 'agent-chat-readiness-state', info.label));
            const detail = node('p', 'agent-chat-readiness-detail', String(item.detail || '—'));
            readinessCard.append(heading, detail);
            readinessGrid.append(readinessCard);
        }
        wrap.append(readinessGrid);
        return wrap;
    }

    function buildUsagePanel(current) {
        const wrap = node('div', 'agent-chat-activity-usage');
        const usage = current.context || {};
        const format = (value) => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
        const placeholder = '—';
        const hasUsage = usage.usageAvailable === true;
        const usageSourceLabel = usage.source === 'real' ? '模型实际返回'
            : usage.source === 'estimated' ? '估算（ToolBox 未返回真实 usage）'
                : '未知（未报告 usage）';
        const messages = current.messages || [];
        const selected = current.selectedTopic || {};
        const snapshot = selected.configSnapshot || {};
        const instructionMode = snapshot.instructionMode === 'codex-managed'
            ? 'codex-managed' : 'vchat-identity';
        const prompt = instructionMode === 'vchat-identity' ? snapshot.baseInstructions || '' : '';
        const userCount = messages.filter((message) => message.role === 'user').length;
        const assistantCount = messages.filter((message) => message.role === 'assistant').length;
        const timestamps = messages.map((message) => Number(message.createdAt || message.timestamp)).filter(Number.isFinite);
        const formatTimeValue = (value) => value ? new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).format(new Date(value)) : placeholder;
        const total = hasUsage ? (usage.totalTokens ?? usage.usedTokens) : null;
        const totalText = total != null ? format(total) : placeholder;
        const contextPct = usage.contextWindow ? usage.percentage : null;

        const summary = node('div', 'agent-chat-usage-summary');
        const totalChip = node('div', 'agent-chat-usage-metric');
        totalChip.append(node('span', 'agent-chat-usage-label', 'Tokens'), node('span', 'agent-chat-usage-value', totalText));
        if (contextPct != null) totalChip.append(node('span', 'agent-chat-usage-pill', `${contextPct}%`));
        summary.append(totalChip);

        const costChip = node('div', 'agent-chat-usage-metric');
        costChip.append(node('span', 'agent-chat-usage-label', '费用'), node('span', 'agent-chat-usage-value', '不可用'));
        summary.append(costChip);
        wrap.append(summary);

        const identity = node('dl', 'agent-chat-context-stats');
        const identityStat = (label, value) => {
            const row = node('div', 'agent-chat-context-stat');
            row.append(node('dt', '', label), node('dd', '', value || placeholder));
            identity.append(row);
        };
        identityStat('会话', selected.title || selected.topicId || current.selectedSessionId);
        identityStat('Provider', usage.provider);
        identityStat('模型', usage.model || selected.model || snapshot.model);
        identityStat('指令来源', instructionMode === 'codex-managed' ? 'Codex 0.146 管理' : 'VChat 身份');
        identityStat('Reasoning', snapshot.reasoningEffort || '模型默认');
        const desiredRevision = Number(selected.configRevision || 0);
        const appliedRevision = Number(selected.appliedRuntimeConfigRevision || 0);
        const applyState = selected.configApplyState || (desiredRevision === appliedRevision ? 'applied' : 'pending');
        identityStat('配置状态', applyState === 'applied' && desiredRevision === appliedRevision
            ? `已应用 r${appliedRevision}`
            : `已保存 r${desiredRevision} · Runtime r${appliedRevision} · ${applyState}`);
        identityStat('消息', `${messages.length}（用户 ${userCount} / 助手 ${assistantCount}）`);
        identityStat('创建时间', formatTimeValue(timestamps.length ? Math.min(...timestamps) : null));
        identityStat('最后活动', formatTimeValue(timestamps.length ? Math.max(...timestamps) : null));
        wrap.append(identity);

        if (usage.compactionState) {
            const text = usage.compactionState === 'started' ? '正在等待 Codex 上下文压缩的终态事件…'
                : usage.compactionState === 'completed' ? (usage.summary || '上下文压缩已完成，已从 Thread 对账恢复。')
                    : usage.compactionError || '上下文压缩失败。';
            const status = node('p', `agent-chat-usage-note agent-chat-compaction-${usage.compactionState}`, text);
            status.setAttribute('role', 'status');
            wrap.append(status);
        }

        if (usage.contextWindow) {
            const context = node('div', 'agent-chat-usage-context');
            const bar = node('div', 'agent-chat-usage-context-bar');
            const fill = document.createElement('progress');
            fill.className = 'agent-chat-usage-context-fill';
            fill.max = 100;
            fill.value = Math.min(100, Math.max(0, usage.percentage || 0));
            fill.setAttribute('aria-label', '上下文使用率');
            bar.append(fill);
            context.append(bar, node('span', 'agent-chat-usage-context-label', `${format(usage.usedTokens)} / ${format(usage.contextWindow)} tokens`));
            wrap.append(context);
        }

        const stats = node('ul', 'agent-chat-usage-stats');
        const stat = (label, value) => {
            const li = node('li');
            li.append(node('span', 'agent-chat-usage-label', label), node('span', 'agent-chat-usage-value', value != null ? format(value) : placeholder));
            stats.append(li);
        };
        stat('输入', hasUsage ? usage.inputTokens : null);
        stat('输出', hasUsage ? usage.outputTokens : null);
        stat('推理', hasUsage ? usage.reasoningTokens : null);
        stat('缓存读取', hasUsage ? usage.cacheReadTokens : null);
        stat('缓存写入', hasUsage ? usage.cacheWriteTokens : null);
        wrap.append(stats);

        const identityLabel = [usage.model, usage.provider].filter(Boolean).join(' · ');
        wrap.append(node('p', 'agent-chat-usage-note', `${usageSourceLabel}${identityLabel ? `；${identityLabel}` : ''}。此处是最近一次可靠报告，不伪装为 Session 累计费用。`));

        if (usage.inputTokens && messages.length) {
            const charCount = (value) => typeof value === 'string' ? value.length : JSON.stringify(value || '').length;
            const raw = {
                system: charCount(prompt),
                user: messages.filter((message) => message.role === 'user').reduce((sum, message) => sum + charCount(message.content || message.blocks), 0),
                assistant: messages.filter((message) => message.role === 'assistant').reduce((sum, message) => sum + charCount(message.content || message.blocks), 0),
                tool: [...(current.tools instanceof Map ? current.tools.values() : [])].reduce((sum, tool) => sum + charCount(tool.payload), 0),
            };
            const estimated = Object.fromEntries(Object.entries(raw).map(([key, chars]) => [key, Math.ceil(chars / 4)]));
            const known = Object.values(estimated).reduce((sum, value) => sum + value, 0);
            estimated.other = Math.max(0, Number(usage.inputTokens) - known);
            const denominator = Math.max(1, Object.values(estimated).reduce((sum, value) => sum + value, 0));
            const breakdown = node('section', 'agent-chat-context-breakdown');
            breakdown.append(node('strong', 'agent-chat-context-section-title', '上下文构成（估算）'));
            const bar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            bar.classList.add('agent-chat-context-breakdown-bar');
            bar.setAttribute('viewBox', '0 0 100 8');
            bar.setAttribute('preserveAspectRatio', 'none');
            const legend = node('div', 'agent-chat-context-breakdown-legend');
            let offset = 0;
            for (const [key, label] of [['system', '系统'], ['user', '用户'], ['assistant', '助手'], ['tool', '工具'], ['other', '其他']]) {
                const value = estimated[key] || 0;
                if (!value) continue;
                const pct = Math.round((value / denominator) * 1000) / 10;
                const segment = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                segment.classList.add('agent-chat-context-segment', `is-${key}`);
                segment.setAttribute('x', String(offset)); segment.setAttribute('y', '0');
                segment.setAttribute('width', String(pct)); segment.setAttribute('height', '8');
                segment.setAttribute('aria-label', `${label} ${pct}%`);
                bar.append(segment);
                offset += pct;
                const item = node('span', `agent-chat-context-legend-item is-${key}`);
                item.append(node('i'), document.createTextNode(`${label} ${pct}%`));
                legend.append(item);
            }
            breakdown.append(bar, legend, node('p', 'agent-chat-usage-note', '构成仅根据 VChat 可见消息和工具投影估算，不代表模型服务端精确计费。'));
            wrap.append(breakdown);
        }

        if (instructionMode === 'codex-managed') {
            const managedDetails = node('details', 'agent-chat-context-prompt');
            const managedBody = node('div', 'agent-chat-context-effective-instructions');
            managedBody.append(
                node('p', 'agent-chat-usage-note', '基础身份由 Codex App Server 0.146 管理；协议不返回完整内部 prompt，VChat 不伪造展示。'),
                node('p', 'agent-chat-usage-note', `Personality：${snapshot.personality || 'none'}`),
            );
            if (snapshot.developerInstructions) {
                managedBody.append(node('pre', 'agent-chat-toolbox-ws-output', String(snapshot.developerInstructions).slice(0, 32_768)));
            }
            managedDetails.append(node('summary', 'agent-chat-context-section-title', '有效指令'), managedBody);
            wrap.append(managedDetails);
        } else if (prompt) {
            const promptDetails = node('details', 'agent-chat-context-prompt');
            promptDetails.append(node('summary', 'agent-chat-context-section-title', '有效指令（VChat 身份）'),
                node('pre', 'agent-chat-toolbox-ws-output', String(prompt).slice(0, 32_768)));
            wrap.append(promptDetails);
        }

        if (current.plan?.text) wrap.append(buildPlanInspector(current));

        return wrap;
    }

    function buildPlanInspector(current) {
        const wrap = node('section', 'agent-chat-activity-usage agent-chat-inspector-plan');
        const plan = current.plan;
        wrap.append(node('strong', '', '最新计划'));
        if (!plan?.text) {
            wrap.append(node('p', 'agent-chat-muted', '当前会话尚未收到 Codex Plan Item。'));
            return wrap;
        }
        const content = node('pre', 'agent-chat-toolbox-ws-output', String(plan.text).slice(0, 16_384));
        content.hidden = false;
        wrap.append(content);
        return wrap;
    }

    function buildChangeInspector(current) {
        const wrap = node('section', 'agent-chat-activity-usage agent-chat-inspector-changes');
        const changes = [...(current.tools instanceof Map ? current.tools.values() : [])]
            .flatMap((tool) => Array.isArray(tool?.payload?.changes?.files) ? tool.payload.changes.files : []);
        wrap.append(node('strong', '', 'Codex 文件变化（只读）'));
        if (!changes.length) {
            wrap.append(node('p', 'agent-chat-muted', '当前会话尚未收到 Codex fileChange Item。'));
            return wrap;
        }
        for (const change of changes.slice(0, 16)) {
            const item = node('details', 'agent-chat-toolbox-ws-card agent-chat-diff-file');
            item.dataset.activityKey = `diff:${change.path || 'unknown'}:${change.status || 'modified'}`;
            const summary = node('summary', 'agent-chat-toolbox-ws-title', `${change.status || 'modified'} · ${change.path || 'unknown'}`);
            summary.append(node('span', 'agent-chat-toolbox-ws-channel', `+${Number(change.additions) || 0} −${Number(change.deletions) || 0}`));
            const patch = node('pre', 'agent-chat-toolbox-ws-output', String(change.patch || '').slice(0, 131_072));
            patch.hidden = false;
            const selectedSessionId = current.selectedSessionId || current.selectedTopic?.topicId || '';
            const workspaceRevision = state.workspaceBrowser.sessionId === selectedSessionId
                ? state.workspaceBrowser.workspaceRevision : '';
            if (change.path && selectedSessionId && workspaceRevision) {
                try {
                    const actions = node('div', 'agent-workspace-path-actions');
                    const open = button('预览', 'secondary');
                    const reveal = button('定位', 'secondary');
                    const ref = createWorkspacePathRef({ sessionId: selectedSessionId, workspaceRevision, relativePath: change.path, source: 'diff' });
                    open.addEventListener('click', () => run(() => openWorkspaceFileTab(ref)));
                    reveal.addEventListener('click', () => run(() => performWorkspaceAction(ref, 'reveal-in-explorer')));
                    actions.append(open, reveal);
                    item.append(summary, actions, patch);
                } catch {
                    item.append(summary, patch);
                }
            } else item.append(summary, patch);
            wrap.append(item);
        }
        return wrap;
    }

    function selectedWorkspaceIdentity(current = store.getState()) {
        const selected = current.selectedTopic || {};
        return {
            sessionId: current.selectedSessionId || selected.topicId || selected.sessionId || '',
            workspaceRoot: selected.workspaceRef || selected.workspaceRoot || '',
        };
    }

    function syncWorkspaceScope(current = store.getState()) {
        const identity = selectedWorkspaceIdentity(current);
        const scope = `${identity.sessionId}:${identity.workspaceRoot}`;
        const browser = state.workspaceBrowser;
        if (browser.scope === scope) return identity;
        if (browser.sessionId && browser.sessionId === identity.sessionId) {
            state.composerStateBySession.setAttachments(identity.sessionId, []);
        }
        workspaceRequests.cancelAll();
        browser.scope = scope;
        browser.sessionId = identity.sessionId;
        browser.workspaceRevision = '';
        browser.model.reset(scope);
        browser.inflight.clear();
        browser.inflightRequestIds.clear();
        browser.previewRequestId = '';
        browser.searchRequestId = '';
        browser.error = '';
        browser.preview = null;
        browser.previewLoading = false;
        browser.search = '';
        browser.searchResults = [];
        browser.selectedPath = '';
        return identity;
    }

    async function loadWorkspaceDirectory(relativePath = '') {
        const identity = syncWorkspaceScope();
        const browser = state.workspaceBrowser;
        if (!identity.sessionId || !identity.workspaceRoot) return;
        const key = String(relativePath || '').replace(/\\/g, '/');
        if (browser.model.hasChildren(key)) return;
        if (browser.inflight.has(key)) return browser.inflight.get(key);
        browser.model.setLoading(key, true);
        browser.error = '';
        renderActivity();
        const scope = browser.scope;
        const token = workspaceRequests.begin({
            key: `directory:${key}`,
            operation: 'directory',
            sessionId: identity.sessionId,
            workspaceRevision: browser.workspaceRevision,
            relativePath: key,
        });
        const request = controller.workspaceListDirectory({
            requestId: token.requestId,
            sessionId: identity.sessionId,
            workspaceRevision: browser.workspaceRevision || undefined,
            relativePath: key,
            limit: 1000,
        }).then((result) => {
            if (browser.scope !== scope || !workspaceRequests.isCurrent(token, {
                sessionId: browser.sessionId,
                relativePath: key,
            })) return;
            browser.workspaceRevision = result.workspaceRevision;
            browser.model.setChildren(key, result.entries || []);
        }).catch((error) => {
            if (browser.scope === scope && workspaceRequests.isCurrent(token, {
                sessionId: browser.sessionId,
                relativePath: key,
            })) browser.error = error?.message || String(error);
            throw error;
        }).finally(() => {
            if (browser.scope === scope && workspaceRequests.finish(token)) {
                browser.model.setLoading(key, false);
                browser.inflight.delete(key);
                browser.inflightRequestIds.delete(key);
                renderActivity();
            }
        });
        browser.inflight.set(key, request);
        browser.inflightRequestIds.set(key, token.requestId);
        return request;
    }

    async function openWorkspacePreview(ref) {
        const browser = state.workspaceBrowser;
        browser.selectedPath = ref.relativePath;
        browser.previewLoading = true;
        browser.error = '';
        renderActivity();
        const scope = browser.scope;
        const token = workspaceRequests.begin({
            key: 'preview', operation: 'preview', sessionId: ref.sessionId,
            workspaceRevision: ref.workspaceRevision, relativePath: ref.relativePath,
        });
        browser.previewRequestId = token.requestId;
        try {
            const preview = await controller.workspaceReadPreview({ ...ref, requestId: token.requestId });
            if (browser.scope === scope && workspaceRequests.isCurrent(token, {
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision,
                relativePath: browser.selectedPath,
            })) browser.preview = preview;
        } catch (error) {
            if (browser.scope === scope && workspaceRequests.isCurrent(token, {
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision,
                relativePath: browser.selectedPath,
            })) browser.error = error?.message || String(error);
            throw error;
        } finally {
            if (browser.scope === scope && workspaceRequests.finish(token)) {
                browser.previewRequestId = '';
                browser.previewLoading = false;
                renderActivity();
            }
        }
    }

    async function openWorkspaceFileTab(ref) {
        state.sessionDock.setSession(selectedDockSessionId());
        const snapshot = state.sessionDock.openFile(ref);
        if (!snapshot) throw new Error('文件引用不属于当前会话或工作区版本已失效。');
        state.activityTab = snapshot.activeId;
        await openWorkspacePreview(ref);
        setActivityOpen(true);
    }

    async function performWorkspaceAction(ref, action) {
        const token = workspaceRequests.begin({
            key: `action:${action}`, operation: `action:${action}`, sessionId: ref.sessionId,
            workspaceRevision: ref.workspaceRevision, relativePath: ref.relativePath,
        });
        try {
            const result = await controller.workspacePerformPathAction({ ...ref, action, requestId: token.requestId });
            if (workspaceRequests.isCurrent(token, {
                sessionId: state.workspaceBrowser.sessionId,
                workspaceRevision: state.workspaceBrowser.workspaceRevision,
                relativePath: ref.relativePath,
            }) && (action === 'preview' || action === 'open-in-vchat')) state.workspaceBrowser.preview = result;
            if (action.startsWith('copy-')) notify(action === 'copy-relative-path' ? '已复制相对路径。' : '已复制绝对路径。', 'success');
            return result;
        } finally {
            workspaceRequests.finish(token);
        }
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
        const browser = state.workspaceBrowser;
        browser.search = value;
        workspaceSearchTimer = lifecycle.timeout('workspace-search', () => {
            const query = browser.search.trim();
            browser.searchRequestId = '';
            if (!query) {
                browser.searchResults = [];
                browser.searchLoading = false;
                renderActivity();
                return;
            }
            browser.searchLoading = true;
            renderActivity();
            const scope = browser.scope;
            const token = workspaceRequests.begin({
                key: 'search', operation: 'search', sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision, relativePath: query,
            });
            browser.searchRequestId = token.requestId;
            void controller.workspaceSearchFiles({
                requestId: token.requestId,
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision || undefined,
                query,
                limit: 200,
            }).then((result) => {
                if (browser.scope === scope && workspaceRequests.isCurrent(token, {
                    sessionId: browser.sessionId,
                    relativePath: browser.search.trim(),
                })) {
                    browser.workspaceRevision = result.workspaceRevision;
                    browser.searchResults = result.entries || [];
                }
            }).catch((error) => {
                if (browser.scope === scope && workspaceRequests.isCurrent(token, {
                    sessionId: browser.sessionId,
                    relativePath: browser.search.trim(),
                })) browser.error = error?.message || String(error);
            }).finally(() => {
                if (browser.scope === scope && workspaceRequests.finish(token)) {
                    browser.searchRequestId = '';
                    browser.searchLoading = false;
                    renderActivity();
                }
            });
        }, 180);
    }

    function buildInteractionCard(interaction) {
        const payload = interaction.payload || {};
        const card = node('section', 'agent-chat-toolbox-ws-card agent-chat-interaction-card');
        card.dataset.interactionSource = String(interaction.source || 'unknown');
        card.dataset.interactionState = String(interaction.state || 'pending');
        card.dataset.interactionId = String(interaction.requestId || '');
        const labels = {
            'user-input': 'Codex 需要你的输入',
            permission: 'Codex 请求额外权限',
            'mcp-elicitation': 'MCP 请求用户交互',
        };
        card.append(node('strong', 'agent-chat-toolbox-ws-title', labels[interaction.kind] || `受限交互 · ${interaction.kind || 'unknown'}`));
        card.append(node('p', 'agent-chat-toolbox-ws-detail', [payload.header, payload.message, payload.reason]
            .filter(Boolean).join(' · ') || `${interaction.source || 'unknown'} / ${interaction.requestId || 'unknown'}`));
        if (interaction.expiresAtMs) {
            approvalRegistry.set(interaction.requestId, { deadline: interaction.expiresAtMs, expired: false });
            const countdown = node('p', 'agent-chat-approval-countdown', '超时后安全取消');
            card.dataset.approvalId = interaction.requestId;
            card.append(countdown);
            ensureApprovalTicker();
        }

        if (interaction.kind === 'user-input') {
            const form = node('form', 'agent-chat-interaction-form');
            for (const question of (payload.questions || []).slice(0, 16)) {
                const fieldset = node('fieldset', 'agent-chat-interaction-fieldset');
                fieldset.dataset.questionId = String(question.id || '');
                fieldset.append(node('legend', '', question.header || question.question || '需要输入'));
                if (question.question && question.question !== question.header) fieldset.append(node('p', 'agent-chat-muted', question.question));
                const options = Array.isArray(question.options) ? question.options : [];
                for (const [index, option] of options.entries()) {
                    const label = node('label', 'agent-chat-interaction-option');
                    const input = document.createElement('input');
                    input.type = 'radio';
                    input.name = `question:${question.id}`;
                    input.value = String(option.label || '');
                    if (index === 0) input.required = !question.isOther;
                    label.append(input, node('span', '', option.label || '选项'));
                    if (option.description) label.append(node('small', '', option.description));
                    fieldset.append(label);
                }
                if (!options.length || question.isOther) {
                    const input = document.createElement(options.length || question.isSecret ? 'input' : 'textarea');
                    input.name = `other:${question.id}`;
                    if (input.tagName === 'INPUT') input.type = question.isSecret ? 'password' : 'text';
                    if (input.tagName === 'TEXTAREA') input.rows = 3;
                    input.autocomplete = question.isSecret ? 'off' : 'on';
                    input.placeholder = options.length ? '其他答案' : '输入回答';
                    fieldset.append(input);
                }
                form.append(fieldset);
            }
            const actions = node('div', 'agent-chat-approval-actions');
            const cancel = button('取消', 'secondary');
            cancel.type = 'button';
            cancel.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { answers: {} })));
            const submit = button('提交回答', 'primary');
            submit.type = 'submit';
            actions.append(cancel, submit);
            form.append(actions);
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                const answers = {};
                for (const question of (payload.questions || []).slice(0, 16)) {
                    const selected = form.querySelector(`input[name="question:${cssEscape(question.id)}"]:checked`)?.value;
                    const other = form.querySelector(`[name="other:${cssEscape(question.id)}"]`)?.value?.trim();
                    const answer = other || selected;
                    if (answer) answers[question.id] = { answers: [answer] };
                }
                run(() => controller.respondInteraction(interaction, { answers }));
            });
            card.append(form);
            return card;
        }

        if (interaction.kind === 'permission') {
            card.append(node('p', 'agent-chat-approval-binding-value', `工作目录：${payload.cwd || '未知'}`));
            card.append(node('pre', 'agent-chat-approval-args', JSON.stringify(payload.permissions || {}, null, 2).slice(0, 16_384)));
            const scope = document.createElement('select');
            scope.setAttribute('aria-label', '授权范围');
            for (const [value, label] of [['turn', '仅当前 Turn'], ['session', '当前 Session']]) {
                const option = document.createElement('option'); option.value = value; option.textContent = label; scope.append(option);
            }
            const actions = node('div', 'agent-chat-approval-actions');
            const deny = button('拒绝', 'danger');
            const accept = button('按请求授权', 'secondary');
            deny.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { decision: 'decline' })));
            accept.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { decision: 'accept', scope: scope.value })));
            actions.append(scope, deny, accept);
            card.append(actions);
            return card;
        }

        if (interaction.kind === 'mcp-elicitation') {
            const mode = payload.mode || 'form';
            const schema = payload.requestedSchema || {};
            if (mode === 'url') {
                const url = String(payload.url || '');
                card.append(node('p', 'agent-chat-toolbox-ws-detail', url));
                const open = button('在系统浏览器打开', 'secondary');
                open.disabled = !/^https?:\/\//i.test(url);
                open.addEventListener('click', () => runtimeApi().sendOpenExternalLink?.(url));
                card.append(open);
            }
            const form = node('form', 'agent-chat-interaction-form');
            if (mode !== 'url') {
                const properties = Object.entries(schema.properties || {}).slice(0, 64);
                for (const [key, definition] of properties) {
                    const field = node('label', 'agent-chat-interaction-field');
                    field.append(node('span', '', definition.title || key));
                    let input;
                    if (Array.isArray(definition.enum)) {
                        input = document.createElement('select');
                        for (const value of definition.enum) {
                            const option = document.createElement('option'); option.value = value; option.textContent = value; input.append(option);
                        }
                    } else {
                        input = document.createElement('input');
                        input.type = definition.format === 'password' ? 'password'
                            : definition.type === 'boolean' ? 'checkbox'
                                : ['number', 'integer'].includes(definition.type) ? 'number' : 'text';
                    }
                    input.name = key;
                    if ((schema.required || []).includes(key)) input.required = true;
                    field.append(input);
                    form.append(field);
                }
                if (!properties.length) {
                    const rawField = node('label', 'agent-chat-interaction-field');
                    rawField.append(node('span', '', '结构化响应（JSON）'));
                    const raw = document.createElement('textarea');
                    raw.name = '__json';
                    raw.rows = 6;
                    raw.placeholder = '{}';
                    rawField.append(raw);
                    form.append(rawField);
                }
            }
            const actions = node('div', 'agent-chat-approval-actions');
            const cancel = button('取消', 'danger');
            cancel.type = 'button';
            cancel.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { action: 'cancel' })));
            const decline = button('拒绝', 'secondary');
            decline.type = 'button';
            decline.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { action: 'decline' })));
            const accept = button('接受', 'primary');
            accept.type = 'submit';
            actions.append(cancel, decline, accept);
            form.append(actions);
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                const content = {};
                for (const control of form.elements) {
                    if (!control.name) continue;
                    if (control.name === '__json') {
                        try { Object.assign(content, JSON.parse(control.value || '{}')); }
                        catch { notify('MCP 表单 JSON 无效。', 'error'); return; }
                        continue;
                    }
                    content[control.name] = control.type === 'checkbox' ? control.checked
                        : control.type === 'number' ? Number(control.value) : control.value;
                }
                run(() => controller.respondInteraction(interaction, { action: 'accept', content }));
            });
            card.append(form);
            return card;
        }

        card.append(node('p', 'agent-chat-muted', '该交互类型没有可用响应控件，保持 fail-closed。'));
        return card;
    }

    function renderActivity() {
        if (state.disposed) return;
        const current = store.getState();
        const previousContent = state.activityTabPanels.get(state.activityTab);
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
        const visibleTabIds = new Set(tabDefs.map(({ id }) => id));
        for (const [id, tab] of state.activityTabButtons) {
            if (visibleTabIds.has(id)) continue;
            tab.remove();
            state.activityTabButtons.delete(id);
        }
        for (const definition of tabDefs) {
            const { id } = definition;
            const count = Number(definition.badge || 0);
            let tab = state.activityTabButtons.get(id);
            if (!tab) {
                tab = node('button', 'agent-chat-activity-tab');
                tab.type = 'button';
                tab.dataset.tab = id;
                tab.setAttribute('role', 'tab');
                tab.addEventListener('click', (event) => {
                    if (event.target.closest('.agent-chat-dock-tab-close')) return;
                    state.sessionDock.activate(id);
                    state.activityTab = id;
                    clearActivityUnread(definition.kind);
                    renderActivity();
                });
                tab.addEventListener('auxclick', (event) => {
                    if (event.button !== 1 || !definition.closeable) return;
                    event.preventDefault();
                    state.sessionDock.close(id);
                    state.activityTab = state.sessionDock.snapshot().activeId;
                    renderActivity();
                });
                tab.addEventListener('keydown', (event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    const tabs = state.sessionDock.snapshot().tabs;
                    const index = tabs.findIndex((item) => item.id === id);
                    const next = tabs[index + (event.key === 'ArrowRight' ? 1 : -1)];
                    if (!next) return;
                    event.preventDefault();
                    state.sessionDock.activate(next.id);
                    state.activityTab = next.id;
                    renderActivity();
                    queueMicrotask(() => state.activityTabButtons.get(next.id)?.focus());
                });
                state.activityTabButtons.set(id, tab);
            }
            activityTabs.append(tab);
            tab.dataset.kind = definition.kind;
            tab.classList.toggle('is-launcher', definition.kind === 'files');
            tab.replaceChildren(node('span', 'vcp-ui-icon agent-chat-dock-tab-icon', definition.icon));
            const label = node('span', 'agent-chat-dock-tab-label', definition.title);
            tab.append(label);
            tab.title = definition.kind === 'file' ? definition.relativePath : definition.title;
            if (count) tab.append(node('span', 'agent-chat-dock-tab-badge', String(Math.min(99, count))));
            if (definition.closeable) {
                const close = node('span', 'agent-chat-dock-tab-close');
                close.setAttribute('role', 'button');
                close.setAttribute('aria-label', `关闭${definition.title}标签`);
                close.append(node('span', 'vcp-ui-icon agent-chat-dock-tab-close-icon', 'close'));
                close.addEventListener('click', (event) => {
                    event.stopPropagation();
                    state.sessionDock.close(id);
                    state.activityTab = state.sessionDock.snapshot().activeId;
                    renderActivity();
                });
                tab.append(close);
            }
            tab.classList.toggle('is-active', state.activityTab === id);
            tab.setAttribute('aria-selected', String(state.activityTab === id));
        }
        activityAdd.setAttribute('aria-expanded', String(state.dockMenuOpen));
        activityTabRow.querySelector('.agent-chat-dock-menu')?.remove();
        if (state.dockMenuOpen) activityTabRow.append(buildDockMenu());

        for (const [id, panel] of state.activityTabPanels) {
            if (visibleTabIds.has(id)) continue;
            panel.remove();
            state.activityTabPanels.delete(id);
        }

        for (const { id } of tabDefs) {
            let panel = state.activityTabPanels.get(id);
            if (!panel) {
                panel = node('div', 'agent-chat-activity-tabpanel');
                panel.dataset.activityPanel = id;
                panel.setAttribute('role', 'tabpanel');
                state.activityTabPanels.set(id, panel);
                activityContent.append(panel);
            }
            panel.hidden = id !== state.activityTab;
        }
        const content = state.activityTabPanels.get(state.activityTab);
        content.replaceChildren();
        const viewState = deriveWorkbenchViewState(current);
        const activeDefinition = tabDefs.find((tab) => tab.id === state.activityTab) || tabDefs[0];
        const activeKind = activeDefinition?.kind || 'context';

        if (activeKind === 'connection') {
            content.append(buildConnectionPanel(current, viewState));
        } else if (activeKind === 'approvals') {
            if (!pendingApprovals) {
                content.append(node('div', 'agent-chat-activity-empty', '没有待确认的审批。'));
            } else {
                for (const approval of localApprovals) {
                    content.append(blockPresentation.createApproval(approval, {
                        onDecision: (item, decision) => {
                        approvalRegistry.delete(item.approvalId);
                        run(() => controller.respondApproval(item, decision));
                        },
                        registry: approvalRegistry,
                        ensureTicker: ensureApprovalTicker,
                    }));
                }
                // ToolBox approval IDs have no trustworthy Topic correlation.
                // They live in this global center, never on a Topic card.
                for (const observation of backendApprovals) {
                    content.append(blockPresentation.createToolboxObservation(observation));
                }
                for (const interaction of passiveInteractions) {
                    content.append(existingInteractions.get(String(interaction.requestId)) || buildInteractionCard(interaction));
                }
            }
        } else if (activeKind === 'context') {
            content.append(buildUsagePanel(current));
        } else if (activeKind === 'plan') {
            content.append(buildPlanInspector(current));
        } else if (activeKind === 'changes') {
            content.append(buildChangeInspector(current));
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
            // This is a process-global observation feed, not a Session feed;
            // backend approval cards may also be reached from Approvals.
            const ws = current.toolboxWs || [];
            const markers = current.markerObservations || [];
            content.append(node('div', 'agent-chat-activity-note', '全局 VCPLog/VCPInfo 仅保留本次运行；会话关联的工具、推理和检查结果会随会话恢复。'));
            const controls = node('div', 'agent-chat-activity-filters');
            const search = document.createElement('input');
            search.type = 'search';
            search.placeholder = '搜索活动';
            search.value = state.activitySearch;
            search.setAttribute('aria-label', '搜索工具活动');
            search.addEventListener('input', () => { state.activitySearch = search.value; renderActivity(); });
            const sourceFilter = document.createElement('select');
            sourceFilter.setAttribute('aria-label', '活动来源');
            for (const value of ['all', ...new Set(ws.map((item) => item.channel).filter(Boolean))]) {
                const option = document.createElement('option'); option.value = value; option.textContent = value === 'all' ? '全部来源' : value; sourceFilter.append(option);
            }
            sourceFilter.value = state.activitySourceFilter;
            sourceFilter.addEventListener('change', () => { state.activitySourceFilter = sourceFilter.value; renderActivity(); });
            const kindFilter = document.createElement('select');
            kindFilter.setAttribute('aria-label', '活动类型');
            for (const value of ['all', ...new Set([...ws.map((item) => item.kind), ...markers.map((item) => item.kind)].filter(Boolean))]) {
                const option = document.createElement('option'); option.value = value; option.textContent = value === 'all' ? '全部类型' : value; kindFilter.append(option);
            }
            kindFilter.value = state.activityKindFilter;
            kindFilter.addEventListener('change', () => { state.activityKindFilter = kindFilter.value; renderActivity(); });
            controls.append(search, sourceFilter, kindFilter);
            content.append(controls);
            const query = state.activitySearch.trim().toLocaleLowerCase();
            const visibleWs = ws.filter((item) => (state.activitySourceFilter === 'all' || item.channel === state.activitySourceFilter)
                && (state.activityKindFilter === 'all' || item.kind === state.activityKindFilter)
                && (!query || JSON.stringify(item).toLocaleLowerCase().includes(query)));
            const visibleMarkers = markers.filter((item) => (state.activitySourceFilter === 'all')
                && (state.activityKindFilter === 'all' || item.kind === state.activityKindFilter)
                && (!query || JSON.stringify(item).toLocaleLowerCase().includes(query)));
            const list = node('div', 'agent-chat-activity-list');
            if (!visibleWs.length && !visibleMarkers.length) {
                list.append(node('div', 'agent-chat-activity-empty', '暂无 VCPToolBox 或 VCP 内容观察事件。'));
            } else {
                for (const observation of visibleWs) {
                    const card = existingActivityCards.get(observation.id) || blockPresentation.createToolboxObservation(observation);
                    card.dataset.activityKey = observation.id;
                    list.append(card);
                }
                for (const observation of visibleMarkers) {
                    const card = existingActivityCards.get(observation.id) || blockPresentation.createMarkerObservation(observation);
                    card.dataset.activityKey = observation.id;
                    list.append(card);
                }
            }
            content.append(list);
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
        workspaceRequests.dispose();
        settingsState.dispose();
        closeTopicContextMenu();
        fullPresentation.dispose();
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
