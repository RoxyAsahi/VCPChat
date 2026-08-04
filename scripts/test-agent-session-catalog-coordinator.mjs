import assert from 'node:assert/strict';
import {
    createAgentSessionCatalogCoordinator,
    seedBuildAgentCatalog,
} from '../modules/ui-system/agent-session-catalog-coordinator.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

function createHarness() {
    const state = {
        agentCatalog: seedBuildAgentCatalog(),
        selectedAgent: 'Nova',
        model: '',
        workspace: '',
        permissionMode: 'ask',
        modelDraft: null,
        modelDraftSessionId: null,
        showArchivedTopics: false,
        topicsByAgent: new Map(),
        archivedTopicsByAgent: new Map(),
        topics: [],
        topicListLoading: false,
        queue: [],
        budget: {},
        uxTimings: new Map(),
        disposed: false,
    };
    const store = { getState: () => ({ selectedSessionId: null, selectedTopic: null }) };
    const renders = [];
    return { state, store, renders };
}

{
    const { state, store, renders } = createHarness();
    state.agentCatalog = [
        { id: 'Agent A', name: 'Agent A', model: 'a' },
        { id: 'Agent B', name: 'Agent B', model: 'b' },
    ];
    const a = deferred();
    const b = deferred();
    const controller = {
        listSessions(agentId) { return agentId === 'Agent A' ? a.promise : b.promise; },
    };
    const coordinator = createAgentSessionCatalogCoordinator({
        state, store, controller,
        listAgentProfiles: async () => state.agentCatalog,
        getCachedModels: async () => [],
        queueRender: (value) => renders.push(value),
        syncPermissionModeFromSelectedSession() {},
        syncModelFromSelectedSession() {},
        uxMark() {},
        requestAnimationFrame: (callback) => callback(),
    });
    coordinator.selectAgent('Agent A');
    const pendingA = coordinator.refreshTopicsForAgent('Agent A');
    coordinator.selectAgent('Agent B');
    const pendingB = coordinator.refreshTopicsForAgent('Agent B');
    b.resolve([{ id: 'b-session' }]);
    await pendingB;
    assert.deepEqual(state.topics, [{ id: 'b-session' }]);
    a.resolve([{ id: 'a-session' }]);
    await pendingA;
    assert.deepEqual(state.topics, [{ id: 'b-session' }], 'stale Agent A result must not replace Agent B');
    assert.equal(state.topicListLoading, false, 'stale finally must not change the current Agent loading owner');
    coordinator.dispose();
}

{
    const { state, store, renders } = createHarness();
    const profilesA = deferred();
    const profilesB = deferred();
    let profileCall = 0;
    const controller = {
        listSessions: async (agentId) => [{ id: `${agentId}-session` }],
        listInteractionQueue: async () => [],
        getWorkbenchSettings: async () => ({}),
    };
    const coordinator = createAgentSessionCatalogCoordinator({
        state, store, controller,
        listAgentProfiles: () => (++profileCall === 1 ? profilesA.promise : profilesB.promise),
        getCachedModels: async () => [],
        queueRender: (value) => renders.push(value),
        syncPermissionModeFromSelectedSession() {},
        syncModelFromSelectedSession() {},
        uxMark() {},
        requestAnimationFrame: (callback) => callback(),
    });
    const first = coordinator.refreshControlPlane();
    const second = coordinator.refreshControlPlane();
    profilesB.resolve([{ id: 'Agent B', name: 'Agent B', config: { systemPrompt: 'B' } }]);
    await second;
    profilesA.resolve([{ id: 'Agent A', name: 'Agent A', config: { systemPrompt: 'A' } }]);
    await first;
    assert.equal(state.agentCatalog.some((agent) => agent.id === 'Agent B'), true);
    assert.equal(state.agentCatalog.some((agent) => agent.id === 'Agent A'), false,
        'stale profile catalog must not replace the latest control-plane request');
    coordinator.dispose();
}

{
    const { state, store, renders } = createHarness();
    state.model = 'configured-model';
    let modelListener = null;
    let unsubscribeCalls = 0;
    let refreshCalls = 0;
    const coordinator = createAgentSessionCatalogCoordinator({
        state, store,
        controller: { listSessions: async () => [] },
        listAgentProfiles: async () => state.agentCatalog,
        getCachedModels: async () => [],
        refreshModels: async () => {
            refreshCalls += 1;
            return { success: true, models: [{ id: 'refreshed-model', reasoning_efforts: ['high'] }] };
        },
        onModelsUpdated(callback) {
            modelListener = callback;
            return () => { unsubscribeCalls += 1; };
        },
        queueRender: (value) => renders.push(value),
        syncPermissionModeFromSelectedSession() {},
        syncModelFromSelectedSession() {},
        uxMark() {},
        requestAnimationFrame: (callback) => callback(),
    });
    assert.equal(typeof modelListener, 'function', 'the model catalog subscription must start with the coordinator');
    modelListener([]);
    assert.deepEqual(state.modelCatalog, []);
    assert.equal(state.model, 'configured-model', 'an empty catalog must preserve the configured model');
    assert.match(state.modelCatalogError, /直接填写模型名称/);
    modelListener([{ id: 'live-model', reasoning_efforts: ['low', 'medium'] }]);
    assert.deepEqual(state.modelCatalog, [{
        id: 'live-model', name: 'live-model', reasoning_efforts: ['low', 'medium'], reasoningEfforts: ['low', 'medium'],
    }], 'a models-updated event must replace the stale Build catalog');
    assert.equal(state.model, 'configured-model', 'catalog updates must not overwrite an explicit profile model');
    const refreshed = await coordinator.refreshModelCatalog();
    assert.equal(refreshCalls, 1, 'manual refresh must invoke the shared Main-process model refresh');
    assert.equal(refreshed.success, true);
    assert.equal(state.modelCatalog[0].id, 'refreshed-model');
    coordinator.dispose();
    assert.equal(unsubscribeCalls, 1, 'disposing the coordinator must release the model update subscription');
    modelListener([{ id: 'late-model' }]);
    assert.equal(state.modelCatalog[0].id, 'refreshed-model', 'late model events must be ignored after disposal');
}

console.log('Agent Session catalog coordinator race tests passed.');
