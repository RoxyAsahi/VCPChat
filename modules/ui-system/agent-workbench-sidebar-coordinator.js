import { projectSession } from './agent-workbench-projections.js';
import { createAgentWorkbenchSidebarView } from './agent-workbench-sidebar-view.js';

export function createAgentWorkbenchSidebarCoordinator({
    state, store, controller, element, accountView, lifecycle, document, run, notify,
    sameAgent, agentCacheKey, selectedAgentProfile, profileNeedsConfiguration,
    sessionActivity, createSessionAvatar, appendTopicActions, closeTopicContextMenu,
    openNewTopicFlow, openNewAgentFlow, refreshControlPlane, refreshRecoveryOperations,
    refreshTopicsForAgent, selectAgent, rememberTopic, forgetTopic, syncModel,
    renderSettings, queueRender, uxMark,
}) {
    let view = null;
    let disposed = false;

    function entries() {
        const current = store.getState();
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

    function model() {
        syncModel();
        const current = store.getState();
        const { liveSessions, persistedTopics, selectedTopicId } = entries();
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
                ...session, activity: sessionActivity(session.topicId, session.activity),
            })),
            persistedTopics,
            selectedTopicId,
            selectedMessageCount: current.messages.length,
        };
    }

    function resetSessionTools() {
        state.topicManaging = false;
        state.topicSelectedIds.clear();
        state.topicSearchOpen = false;
        state.topicSearch = '';
        state.topicSearchResults = [];
        state.topicSearchLoading = false;
        state.topicSearchError = '';
    }

    function ensureView() {
        if (view) return view;
        view = createAgentWorkbenchSidebarView({
            element,
            accountView,
            lifecycle,
            actions: {
                selectTab(id) {
                    closeTopicContextMenu();
                    state.tab = id;
                    if (id !== 'sessions') resetSessionTools();
                    render();
                    if (id === 'sessions') run(() => refreshControlPlane());
                    else if (id === 'settings') void refreshRecoveryOperations();
                },
                openNewSession: openNewTopicFlow,
                toggleTopicManagement() {
                    closeTopicContextMenu();
                    state.topicManaging = !state.topicManaging;
                    if (!state.topicManaging) state.topicSelectedIds.clear();
                    render();
                },
                toggleArchivedSessions() {
                    closeTopicContextMenu();
                    state.showArchivedTopics = !state.showArchivedTopics;
                    resetSessionTools();
                    render();
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
                    render();
                },
                setTopicSearch(query, { loading, error, render: shouldRender = false } = {}) {
                    state.topicSearch = query;
                    state.topicSearchLoading = Boolean(loading);
                    state.topicSearchError = error || '';
                    if (!query) state.topicSearchResults = [];
                    if (shouldRender) render();
                },
                searchSessions: (query, agentId, limit) => controller.searchTopics(query, agentId, limit),
                finishTopicSearch(query, { hits = [], error = '' } = {}) {
                    if (query !== state.topicSearch.trim() || disposed) return;
                    state.topicSearchResults = Array.isArray(hits) ? hits : [];
                    state.topicSearchLoading = false;
                    state.topicSearchError = error;
                    render();
                    queueMicrotask(() => {
                        if (disposed) return;
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
                    if (!disposed) rememberTopic({ topicId: topic.id });
                }),
                toggleTopicSelection(sessionId) {
                    if (state.topicSelectedIds.has(sessionId)) state.topicSelectedIds.delete(sessionId);
                    else state.topicSelectedIds.add(sessionId);
                    render();
                },
                selectVisibleSessions(sessionIds, selected) {
                    sessionIds.forEach((sessionId) => {
                        if (selected) state.topicSelectedIds.add(sessionId);
                        else state.topicSelectedIds.delete(sessionId);
                    });
                    render();
                },
                archiveSelectedSessions(topics) {
                    run(async () => {
                        if (!topics.length || !window.confirm?.(`确定归档选中的 ${topics.length} 个 Agent 会话吗？`)) return;
                        for (const topic of topics) {
                            await controller.deleteTopic(topic.id, topic.agentId);
                            if (disposed) return;
                            forgetTopic(topic.id);
                        }
                        state.topicSelectedIds.clear();
                        state.topicManaging = false;
                        await refreshTopicsForAgent(state.selectedAgent);
                        if (!disposed) notify(`已归档 ${topics.length} 个 Agent 会话。`, 'success');
                    });
                },
                exitTopicManagement() {
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    render();
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
                        resetSessionTools();
                        queueRender({ shell: true, header: true, composer: true });
                        await refreshControlPlane();
                    });
                },
                renderSettings,
            },
        });
        return view;
    }

    function render() {
        if (disposed || state.disposed) return;
        ensureView().update(model());
    }

    return {
        render,
        dispose() {
            disposed = true;
            view?.dispose();
            view = null;
        },
    };
}
