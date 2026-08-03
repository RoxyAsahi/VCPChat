import { createWorkspaceTreeModel } from './agent-workspace-model.js';
import { createSessionDockModel } from './agent-session-dock.js';
import { createAgentComposerState } from './agent-composer-state.js';

export function createAgentWorkbenchState({ window, agentCatalog, rememberedTopic }) {
    return {
        tab: 'agents', selectedAgent: 'Nova', agentCatalog, agentSearch: '', modelCatalog: [],
        topics: [], topicsByAgent: new Map(), archivedTopicsByAgent: new Map(), showArchivedTopics: false,
        topicListLoading: false, topicSearch: '', topicSearchResults: [], topicSearchLoading: false,
        topicSearchError: '', topicSearchOpen: false, topicManaging: false, topicSelectedIds: new Set(),
        queue: [], queueOpen: false, budget: { maxRequestsPerTurn: null, maxTokensPerTurn: null },
        budgetSaving: false, settingsSaveState: 'idle', settingsSaveMessage: '', settingsScope: 'profile',
        settingsSaveByScope: new Map([
            ['profile', { state: 'idle', message: '' }],
            ['session', { state: 'idle', message: '' }],
            ['advanced', { state: 'idle', message: '' }],
        ]),
        recoveryOperations: [], recoveryThreads: [], recoveryLoading: false, recoveryError: '',
        permissionMode: 'ask', permissionSaving: false, modelSaving: false, avatarSaving: false,
        modelDraft: null, modelDraftSessionId: null, recovering: false, activityOpen: false,
        activityPanelWidth: 420, activityTab: 'notifications',
        sessionDock: createSessionDockModel(window.sessionStorage), dockMenuOpen: false,
        lastViewState: null, hadApprovals: false, workspace: '',
        workspaceBrowser: {
            scope: '', sessionId: '', workspaceRevision: '', model: createWorkspaceTreeModel(),
            inflight: new Map(), inflightRequestIds: new Map(), previewRequestId: '', searchRequestId: '',
            error: '', preview: null, previewLoading: false, search: '', searchResults: [],
            searchLoading: false, selectedPath: '', splitPercent: 46,
        },
        model: 'gpt-5.6-terra', composerStateBySession: createAgentComposerState(), rememberedTopic,
        followingFeed: true, unreadTimelineCount: 0, timelineRows: new Map(), turnStarts: new Map(),
        topicCreating: false, profileConfigurationNotice: '', topicFlow: null, topicContextMenu: null,
        uxTimings: new Map(), turnStartedAt: new Map(), disposed: false,
    };
}
