const NOVA_CATALOG_FALLBACK = Object.freeze({
    id: 'Nova', name: 'Nova', model: '', systemPrompt: '{{Nova}}', avatarUrl: null,
});

function seedBuildAgentCatalog() {
    return [{ ...NOVA_CATALOG_FALLBACK }];
}

function sameAgent(left, right) {
    return String(left || '').trim().toLocaleLowerCase()
        === String(right || '').trim().toLocaleLowerCase();
}

function agentCacheKey(agentId) {
    return String(agentId || '').trim().toLocaleLowerCase();
}

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

function normalizeAgentProfile(agent) {
    const config = agent?.config || {};
    const instructionMode = (config.instructionMode || agent?.instructionMode) === 'codex-managed'
        ? 'codex-managed' : 'vchat-identity';
    const baseInstructions = config.baseInstructions || agent?.baseInstructions
        || config.systemPrompt || agent?.systemPrompt || '';
    return {
        id: agent?.id || agent?.name,
        name: agent?.name || agent?.id,
        model: config.model || agent?.model || '',
        instructionMode,
        baseInstructions,
        systemPrompt: config.systemPrompt || agent?.systemPrompt || '',
        developerInstructions: config.developerInstructions || agent?.developerInstructions || '',
        personality: ['friendly', 'pragmatic'].includes(config.personality || agent?.personality)
            ? (config.personality || agent.personality) : 'none',
        reasoningEffort: config.reasoningEffort || agent?.reasoningEffort || null,
        reasoningEfforts: Array.isArray(config.reasoningEfforts || agent?.reasoningEfforts)
            ? (config.reasoningEfforts || agent.reasoningEfforts) : [],
        workspaceRoot: config.workspaceRoot || agent?.workspaceRoot || '',
        permissionMode: (config.permissionMode || agent?.permissionMode) === 'always-approve'
            ? 'always-approve' : 'ask',
        revision: Number(config.revision || agent?.revision || 1),
        profileRevision: Number(config.profileRevision || agent?.profileRevision
            || config.revision || agent?.revision || 1),
        avatarUrl: agent?.avatarUrl || null,
        configurationRequired: instructionMode !== 'codex-managed' && !String(baseInstructions).trim(),
    };
}

function createAgentSessionCatalogCoordinator({
    state,
    store,
    controller,
    listAgentProfiles,
    getCachedModels,
    queueRender,
    syncPermissionModeFromSelectedSession,
    syncModelFromSelectedSession,
    uxMark,
    requestAnimationFrame,
}) {
    if (typeof requestAnimationFrame !== 'function') {
        throw new TypeError('Session catalog requires a Workbench lifecycle frame scheduler');
    }
    let controlPlaneRequest = 0;
    let topicCatalogRequest = 0;
    let disposed = false;

    function selectedAgentProfile() {
        return state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, state.selectedAgent)) || null;
    }

    function profileNeedsConfiguration(profile = selectedAgentProfile()) {
        const agentId = String(profile?.id || profile?.name || '').trim();
        const instructionMode = profile?.instructionMode === 'codex-managed' ? 'codex-managed' : 'vchat-identity';
        return Boolean(agentId && instructionMode === 'vchat-identity'
            && !String(profile?.baseInstructions || profile?.systemPrompt || '').trim());
    }

    function selectAgent(agentId) {
        const profile = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, agentId));
        if (!profile) return null;
        state.selectedAgent = profile.id || profile.name;
        state.model = profile.model || '';
        state.workspace = profile.workspaceRoot || '';
        state.permissionMode = profile.permissionMode === 'always-approve' ? 'always-approve' : 'ask';
        state.modelDraft = null;
        state.modelDraftSessionId = null;
        return profile;
    }

    function paintCatalogTiming(agentId, key) {
        const clickedAt = state.uxTimings.get(`agent-click:${key}`) || null;
        requestAnimationFrame(() => uxMark('session-cache-painted', agentId, clickedAt));
    }

    async function refreshTopicsForAgent(agentId, archived = state.showArchivedTopics) {
        const selectedAgentId = String(agentId || state.selectedAgent || 'Nova').trim();
        const key = agentCacheKey(selectedAgentId);
        const cache = archived ? state.archivedTopicsByAgent : state.topicsByAgent;
        const cached = cache.get(key);
        state.topics = Array.isArray(cached) ? cached : [];
        state.topicListLoading = !cached;
        queueRender({ shell: true, header: true, composer: true });
        if (cached) paintCatalogTiming(selectedAgentId, key);
        const request = ++topicCatalogRequest;
        try {
            const topics = await controller.listSessions(selectedAgentId, { archived });
            if (disposed || state.disposed || request !== topicCatalogRequest
                || !sameAgent(selectedAgentId, state.selectedAgent)) return;
            const received = Array.isArray(topics) ? topics : topics?.topics || [];
            cache.set(key, received);
            state.topics = received;
            uxMark('projection-list-returned', selectedAgentId, state.uxTimings.get(`agent-click:${key}`) || null);
            paintCatalogTiming(selectedAgentId, key);
        } finally {
            if (!disposed && !state.disposed && request === topicCatalogRequest
                && sameAgent(selectedAgentId, state.selectedAgent)) {
                state.topicListLoading = false;
                queueRender({ shell: true, header: true, composer: true });
            }
        }
    }

    async function refreshControlPlane() {
        const request = ++controlPlaneRequest;
        const optional = (fn) => Promise.resolve().then(fn).catch(() => []);
        const sharedAgents = await optional(listAgentProfiles);
        if (disposed || state.disposed || request !== controlPlaneRequest) return;
        const normalizedAgents = Array.isArray(sharedAgents) ? sharedAgents.map(normalizeAgentProfile) : [];
        if (!normalizedAgents.some((agent) => sameAgent(agent.id || agent.name, 'Nova'))) {
            normalizedAgents.unshift({ ...NOVA_CATALOG_FALLBACK });
        }
        state.agentCatalog = normalizedAgents;
        if (!selectedAgentProfile()) {
            const fallback = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, 'Nova'))
                || state.agentCatalog[0];
            if (fallback) selectAgent(fallback.id || fallback.name);
        } else if (!store.getState().selectedSessionId) {
            selectAgent(state.selectedAgent);
        }
        const selectedAgentId = state.selectedAgent || 'Nova';
        queueRender({ shell: true, header: true, composer: true });

        void optional(getCachedModels).then((models) => {
            if (disposed || state.disposed || request !== controlPlaneRequest
                || !sameAgent(selectedAgentId, state.selectedAgent)) return;
            const rawModels = Array.isArray(models) ? models : models?.models || [];
            state.modelCatalog = rawModels.map((model) => typeof model === 'string'
                ? { id: model, name: model }
                : {
                    ...model,
                    id: model?.id || model?.name || '',
                    name: model?.name || model?.id || '',
                    reasoningEfforts: reasoningEffortsForModel(model),
                }).filter((model) => model.id);
            if (!state.modelDraft && !state.model) state.model = state.modelCatalog[0]?.id || '';
            queueRender({ shell: true, header: true, composer: true });
        });

        const [topics, queue, workbenchSettings] = await Promise.all([
            optional(() => controller.listSessions(selectedAgentId, { archived: state.showArchivedTopics })),
            optional(() => controller.listInteractionQueue()),
            optional(() => controller.getWorkbenchSettings()),
        ]);
        if (disposed || state.disposed || request !== controlPlaneRequest
            || !sameAgent(selectedAgentId, state.selectedAgent)) return;
        const receivedTopics = Array.isArray(topics) ? topics : topics?.topics || [];
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
            if (!selectedAgentProfile() && !store.getState().selectedTopic?.configSnapshot?.model
                && workbenchSettings.model) state.model = String(workbenchSettings.model);
        }
        syncPermissionModeFromSelectedSession();
        syncModelFromSelectedSession();
        queueRender({ shell: true, header: true, composer: true });
    }

    function dispose() {
        disposed = true;
        controlPlaneRequest += 1;
        topicCatalogRequest += 1;
    }

    return Object.freeze({
        selectedAgentProfile,
        profileNeedsConfiguration,
        selectAgent,
        refreshTopicsForAgent,
        refreshControlPlane,
        dispose,
    });
}

export {
    NOVA_CATALOG_FALLBACK,
    agentCacheKey,
    createAgentSessionCatalogCoordinator,
    sameAgent,
    seedBuildAgentCatalog,
};
