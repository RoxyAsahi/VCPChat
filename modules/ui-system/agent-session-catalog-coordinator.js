import { PROFILE_CONFIG_FIELDS, normalizeAgentConfig } from '../agent-config-descriptors.js';

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
    const normalized = normalizeProfileFields(agent, config);
    return {
        ...profileIdentityProjection(agent, config, normalized),
        ...profileRuntimeProjection(agent, config, normalized),
    };
}

function profileIdentityProjection(agent, config, normalized) {
    const personalityValue = config.personality || agent?.personality;
    return {
        id: agent?.id || agent?.name,
        name: agent?.name || agent?.id,
        model: normalized.model || '',
        instructionMode: normalized.instructionMode,
        baseInstructions: normalized.baseInstructions || '',
        systemPrompt: config.systemPrompt || agent?.systemPrompt || normalized.baseInstructions,
        developerInstructions: config.developerInstructions || agent?.developerInstructions || '',
        personality: ['friendly', 'pragmatic'].includes(personalityValue) ? personalityValue : 'none',
    };
}

function profileRuntimeProjection(agent, config, normalized) {
    const reasoningEfforts = config.reasoningEfforts || agent?.reasoningEfforts;
    return {
        reasoningEffort: normalized.reasoningEffort || null,
        reasoningEfforts: Array.isArray(reasoningEfforts) ? reasoningEfforts : [],
        workspaceRoot: normalized.workspaceRoot || '',
        permissionMode: normalized.permissionMode,
        revision: Number(config.revision || agent?.revision || 1),
        profileRevision: Number(config.profileRevision || agent?.profileRevision
            || config.revision || agent?.revision || 1),
        avatarUrl: agent?.avatarUrl || null,
        configurationRequired: normalized.instructionMode !== 'codex-managed'
            && !String(normalized.baseInstructions).trim(),
    };
}

function modelCatalogProjection(models) {
    const raw = Array.isArray(models) ? models : models?.models || [];
    return raw.map((model) => typeof model === 'string'
        ? { id: model, name: model }
        : {
            ...model,
            id: model?.id || model?.name || '',
            name: model?.name || model?.id || '',
            reasoningEfforts: reasoningEffortsForModel(model),
        }).filter((model) => model.id);
}

function controlPlaneCurrent(disposed, state, request, currentRequest, agentId) {
    return !disposed && !state.disposed && request === currentRequest
        && sameAgent(agentId, state.selectedAgent);
}

function installAgentCatalog(state, sharedAgents, selectedAgentProfile, selectAgent, store) {
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
    return state.selectedAgent || 'Nova';
}

function applyControlPlaneState({ state, store, selectedAgentId, topics, queue, workbenchSettings,
    selectedAgentProfile, syncPermissionModeFromSelectedSession, syncModelFromSelectedSession }) {
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
        const selectedTopic = store.getState().selectedTopic;
        if (!selectedAgentProfile() && !selectedTopic?.configSnapshot) {
            state.permissionMode = workbenchSettings.permissionMode === 'always-approve' ? 'always-approve' : 'ask';
        }
        if (!selectedAgentProfile() && !selectedTopic?.configSnapshot?.model && workbenchSettings.model) {
            state.model = String(workbenchSettings.model);
        }
    }
    syncPermissionModeFromSelectedSession();
    syncModelFromSelectedSession();
}

function normalizeProfileFields(agent, config) {
    return normalizeAgentConfig({ ...agent, ...config }, {
        fallback: agent,
        fields: PROFILE_CONFIG_FIELDS,
        context: { reasoningEfforts: config.reasoningEfforts || agent?.reasoningEfforts || [] },
    }).values;
}

function createAgentSessionCatalogCoordinator({
    state,
    store,
    controller,
    listAgentProfiles,
    getCachedModels,
    refreshModels,
    onModelsUpdated,
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
    let unsubscribeModels = null;

    function applyModelCatalog(models, errorMessage = '') {
        if (disposed || state.disposed) return [];
        const catalog = modelCatalogProjection(models);
        state.modelCatalog = catalog;
        state.modelCatalogLoading = false;
        state.modelCatalogError = catalog.length ? '' : errorMessage;
        if (!state.modelDraft && !state.model) state.model = catalog[0]?.id || '';
        queueRender({ shell: true, header: true, composer: true });
        return catalog;
    }

    function subscribeModelCatalog() {
        if (unsubscribeModels || typeof onModelsUpdated !== 'function') return;
        try {
            unsubscribeModels = onModelsUpdated((models) => {
                applyModelCatalog(models, '模型服务暂不可用，可直接填写模型名称。');
            });
        } catch {
            unsubscribeModels = null;
        }
    }

    async function refreshModelCatalog() {
        if (disposed || state.disposed) return { success: false, models: [] };
        state.modelCatalogLoading = true;
        state.modelCatalogError = '';
        queueRender({ shell: true, header: true, composer: true });
        try {
            const result = await refreshModels();
            const models = Array.isArray(result) ? result : result?.models;
            const catalog = applyModelCatalog(models,
                result?.success === false ? '模型服务暂不可用，可直接填写模型名称。' : '没有可用模型，可直接填写模型名称。');
            return { ...result, success: result?.success !== false && catalog.length > 0, models: catalog };
        } catch (error) {
            if (!disposed && !state.disposed) {
                state.modelCatalogLoading = false;
                state.modelCatalogError = error?.message || '模型列表刷新失败，可直接填写模型名称。';
                queueRender({ shell: true, header: true, composer: true });
            }
            throw error;
        }
    }

    subscribeModelCatalog();

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
        if (!controlPlaneCurrent(disposed, state, request, controlPlaneRequest, state.selectedAgent)) return;
        const selectedAgentId = installAgentCatalog(state, sharedAgents, selectedAgentProfile, selectAgent, store);
        queueRender({ shell: true, header: true, composer: true });

        void optional(getCachedModels).then((models) => {
            if (!controlPlaneCurrent(disposed, state, request, controlPlaneRequest, selectedAgentId)) return;
            applyModelCatalog(models, '模型服务暂不可用，可直接填写模型名称。');
        });

        const [topics, queue, workbenchSettings] = await Promise.all([
            optional(() => controller.listSessions(selectedAgentId, { archived: state.showArchivedTopics })),
            optional(() => controller.listInteractionQueue()),
            optional(() => controller.getWorkbenchSettings()),
        ]);
        if (!controlPlaneCurrent(disposed, state, request, controlPlaneRequest, selectedAgentId)) return;
        applyControlPlaneState({
            state, store, selectedAgentId, topics, queue, workbenchSettings,
            selectedAgentProfile, syncPermissionModeFromSelectedSession, syncModelFromSelectedSession,
        });
        queueRender({ shell: true, header: true, composer: true });
    }

    function dispose() {
        disposed = true;
        controlPlaneRequest += 1;
        topicCatalogRequest += 1;
        if (typeof unsubscribeModels === 'function') unsubscribeModels();
        unsubscribeModels = null;
    }

    return Object.freeze({
        selectedAgentProfile,
        profileNeedsConfiguration,
        selectAgent,
        refreshTopicsForAgent,
        refreshControlPlane,
        refreshModelCatalog,
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
