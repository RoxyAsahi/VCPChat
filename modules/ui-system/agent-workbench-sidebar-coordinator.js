import { projectSession } from './agent-workbench-projections.js';
import { createAgentWorkbenchSidebarView } from './agent-workbench-sidebar-view.js';
import { selectedSessionId } from './agent-selected-session.js';

export function createAgentWorkbenchSidebarCoordinator({
    state, store, controller, element, accountView, lifecycle, document, run, notify,
    sameAgent, agentCacheKey, selectedAgentProfile, profileNeedsConfiguration,
    sessionActivity, createSessionAvatar, appendSessionActions, closeSessionContextMenu,
    openNewSession, openNewAgentFlow, refreshControlPlane, refreshRecoveryOperations,
    refreshTopicsForAgent, selectAgent, rememberTopic, rememberedSessionForAgent,
    forgetRememberedSession, forgetTopic, syncModel, host,
    renderSettings, queueRender, uxMark,
}) {
    let view = null;
    let disposed = false;
    let agentSelectionRequest = 0;

    function entries() {
        const current = store.getState();
        const liveSessions = (state.showArchivedTopics ? []
            : (current.activeRuntimes instanceof Map ? [...current.activeRuntimes.values()] : []))
            .filter((runtime) => sameAgent(runtime.agentId, state.selectedAgent))
            .map((runtime) => projectSession({
                ...(state.topics.find((topic) => topic.id === runtime.sessionId) || {}),
                ...runtime,
            }));
        const liveSessionIds = new Set(liveSessions.map((session) => session.sessionId).filter(Boolean));
        return {
            liveSessions,
            persistedTopics: state.topics.filter((topic) => topic.agentId
                && sameAgent(topic.agentId, state.selectedAgent) && !liveSessionIds.has(topic.id)),
            selectedSessionId: selectedSessionId(current),
        };
    }

    function model() {
        syncModel();
        const current = store.getState();
        const { liveSessions, persistedTopics, selectedSessionId } = entries();
        return {
            tab: state.tab,
            selectedAgent: state.selectedAgent,
            selectedAgentName: selectedAgentProfile()?.name || state.selectedAgent,
            profileHistorical: Boolean(selectedAgentProfile()?.historical),
            agentCatalog: state.agentCatalog,
            agentSearch: state.agentSearch,
            topics: state.topics,
            topicCreating: state.topicCreating,
            topicManaging: state.topicManaging,
            topicSelectedIds: new Set(state.topicSelectedIds),
            showArchivedTopics: state.showArchivedTopics,
            topicSearch: state.topicSearch,
            topicSearchResults: state.topicSearchResults.filter((topic) => topic.agentId
                && sameAgent(topic.agentId, state.selectedAgent)),
            topicSearchLoading: state.topicSearchLoading,
            topicSearchError: state.topicSearchError,
            topicSearchOpen: state.topicSearchOpen,
            topicListLoading: state.topicListLoading,
            profileConfigurationRequired: profileNeedsConfiguration(),
            profileConfigurationNotice: state.profileConfigurationNotice,
            liveSessions: liveSessions.map((session) => ({
                ...session, activity: sessionActivity(session.sessionId, session.activity),
            })),
            persistedTopics,
            selectedSessionId,
            selectedMessageCount: current.messages.length,
        };
    }

    function resetSessionTools() {
        lifecycle.clear('topic-search');
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
                    closeSessionContextMenu();
                    state.tab = id;
                    if (id !== 'sessions') resetSessionTools();
                    render();
                    if (id === 'sessions') run(() => refreshControlPlane());
                    else if (id === 'settings') void refreshRecoveryOperations();
                },
                openNewSession,
                toggleTopicManagement() {
                    closeSessionContextMenu();
                    state.topicManaging = !state.topicManaging;
                    if (!state.topicManaging) state.topicSelectedIds.clear();
                    render();
                },
                toggleArchivedSessions() {
                    closeSessionContextMenu();
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
                appendSessionActions,
                hydrateSession: (session) => run(async () => {
                    if (!session.agentId) return;
                    await controller.hydrateTopic(session.sessionId, session, null, session.agentId);
                    if (!disposed) rememberTopic({ sessionId: session.sessionId, agentId: session.agentId });
                }),
                previewSession: (topic) => run(async () => {
                    if (!topic.agentId) return;
                    await controller.previewTopic(topic.id, topic.agentId, topic);
                    if (!disposed) rememberTopic({ sessionId: topic.id, agentId: topic.agentId });
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
                        if (!topics.length) return;
                        const accepted = await host.feedback.confirm({
                            title: '批量归档 Agent 会话',
                            message: `确定归档选中的 ${topics.length} 个 Agent 会话吗？`,
                        });
                        if (accepted !== true) return;
                        for (const topic of topics) {
                            await controller.archiveSession(topic.id);
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
                        const request = ++agentSelectionRequest;
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
                        if (disposed || state.disposed || request !== agentSelectionRequest
                            || !sameAgent(agentId, state.selectedAgent)) return;
                        const rememberedSessionId = rememberedSessionForAgent(agentId);
                        if (!rememberedSessionId) return;
                        const topic = state.topics.find((item) => item.id === rememberedSessionId
                            && !item.archivedAt && item.agentId && sameAgent(item.agentId, agentId));
                        const runtime = store.getState().activeRuntimes instanceof Map
                            ? store.getState().activeRuntimes.get(rememberedSessionId) : null;
                        const candidate = topic || (runtime?.agentId && sameAgent(runtime.agentId, agentId)
                            ? { ...runtime, id: runtime.sessionId } : null);
                        if (!candidate) {
                            forgetRememberedSession({ agentId, sessionId: rememberedSessionId });
                            return;
                        }
                        if (runtime) {
                            await controller.hydrateTopic(rememberedSessionId, runtime, null, runtime.agentId);
                        } else {
                            await controller.previewTopic(rememberedSessionId, candidate.agentId, candidate);
                        }
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
            agentSelectionRequest += 1;
            view?.dispose();
            view = null;
        },
    };
}
