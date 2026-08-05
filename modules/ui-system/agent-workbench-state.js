import { createSessionDockModel } from './agent-session-dock.js';
import { createWorkspaceTreeModel } from './agent-workspace-model.js';

const INPUT_MODES = new Set(['follow-up', 'steer']);

function emptyComposerState() {
    return { draft: '', attachments: [], activeInputMode: 'follow-up', scrollAnchor: null };
}

function createAgentComposerState() {
    const states = new Map();
    const get = (sessionId) => {
        const key = String(sessionId || '').trim();
        if (!key) return emptyComposerState();
        if (!states.has(key)) states.set(key, emptyComposerState());
        return states.get(key);
    };
    return {
        get,
        setDraft(sessionId, draft) { get(sessionId).draft = String(draft || ''); return get(sessionId); },
        setAttachments(sessionId, attachments) {
            get(sessionId).attachments = Array.isArray(attachments)
                ? attachments.map((item) => ({ ...item })) : [];
            return get(sessionId);
        },
        setMode(sessionId, mode) {
            get(sessionId).activeInputMode = INPUT_MODES.has(mode) ? mode : 'follow-up';
            return get(sessionId);
        },
        clearAfterAcceptedSend(sessionId) {
            const state = get(sessionId);
            state.draft = '';
            state.attachments = [];
            return state;
        },
        delete(sessionId) { return states.delete(String(sessionId || '').trim()); },
        clear() { states.clear(); },
        entries() { return [...states.entries()]; },
    };
}

function createWorkspaceViewState() {
    return {
        scope: '', sessionId: '', workspaceRevision: '', model: createWorkspaceTreeModel(),
        inflight: new Map(), inflightRequestIds: new Map(), previewRequestId: '', searchRequestId: '',
        error: '', preview: null, previewLoading: false, search: '', searchResults: [],
        searchLoading: false, selectedPath: '', splitPercent: 46,
    };
}

function createSidebarViewState() {
    return {
        tab: 'agents', agentSearch: '', topicSearch: '', topicSearchResults: [],
        topicSearchLoading: false, topicSearchError: '', topicSearchOpen: false,
        topicManaging: false, topicSelectedIds: new Set(), showArchivedTopics: false,
        topicListLoading: false,
    };
}

export function createAgentWorkbenchState({ window, agentCatalog, rememberedTopic }) {
    let storedSidebarWidth = NaN;
    try { storedSidebarWidth = Number(window?.localStorage?.getItem('vcpchat.agentWorkbench.sidebarWidth')); } catch { /* storage is optional */ }
    const agentSidebarWidth = Number.isFinite(storedSidebarWidth)
        ? Math.max(180, Math.min(600, Math.round(storedSidebarWidth)))
        : 260;
    return {
        ...createSidebarViewState(),
        selectedAgent: 'Nova', agentCatalog, modelCatalog: [],
        topics: [], topicsByAgent: new Map(), archivedTopicsByAgent: new Map(),
        queue: [], queueOpen: false, budget: { maxRequestsPerTurn: null, maxTokensPerTurn: null },
        budgetSaving: false, settingsSaveState: 'idle', settingsSaveMessage: '', settingsScope: 'profile',
        settingsSaveByScope: new Map([
            ['profile', { state: 'idle', message: '' }],
            ['session', { state: 'idle', message: '' }],
            ['advanced', { state: 'idle', message: '' }],
        ]),
        recoveryOperations: [], recoveryThreads: [], recoveryLoading: false, recoveryError: '',
        settingsDiagnostics: {
            sessionId: '', state: 'idle', config: null, error: null, requestId: 0, readAt: 0,
        },
        permissionMode: 'ask', permissionSaving: false, modelSaving: false, avatarSaving: false,
        modelDraft: null, modelDraftSessionId: null, recovering: false, activityOpen: false,
        activityPanelWidth: 420, agentSidebarWidth, activityTab: 'notifications',
        sessionDock: createSessionDockModel(window.sessionStorage), dockMenuOpen: false,
        lastViewState: null, hadApprovals: false, workspace: '',
        workspaceBrowser: createWorkspaceViewState(),
        model: 'gpt-5.6-terra', composerStateBySession: createAgentComposerState(), rememberedTopic,
        followingFeed: true, unreadTimelineCount: 0, timelineRows: new Map(), turnStarts: new Map(),
        topicCreating: false, profileConfigurationNotice: '', topicFlow: null, topicContextMenu: null,
        uxTimings: new Map(), turnStartedAt: new Map(), turnElapsedBySession: new Map(), disposed: false,
    };
}

export { createAgentComposerState, createSidebarViewState, createWorkspaceViewState };
