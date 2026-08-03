import assert from 'node:assert/strict';
import { createAgentSettingsCoordinator } from '../modules/ui-system/agent-settings-coordinator.js';
import { createAgentSettingsState } from '../modules/ui-system/agent-settings-state.js';

function deferred() {
    let resolve;
    const promise = new Promise((accept) => { resolve = accept; });
    return { promise, resolve };
}

const saveA = deferred();
const state = {
    selectedAgent: 'Nova',
    settingsSaveState: 'idle',
    settingsSaveMessage: '',
    settingsSaveByScope: new Map(),
    profileConfigurationNotice: '',
    permissionMode: 'ask',
    model: 'model-b',
    modelDraft: 'model-b-draft',
    budget: {},
    disposed: false,
};
let projection = {
    selectedSessionId: 'session-a',
    selectedTopic: { sessionId: 'session-a', configRevision: 3, configSnapshot: { model: 'old-a' } },
};
const storeWrites = [];
const store = {
    getState: () => projection,
    setState(patch) { storeWrites.push(patch); projection = { ...projection, ...patch }; },
};
const coordinator = createAgentSettingsCoordinator({
    state,
    store,
    settingsState: createAgentSettingsState({ delayMs: 1 }),
    controller: {
        updateWorkbenchSettings: () => saveA.promise,
        hydrateTopic: async () => {},
    },
    selectedAgentProfile: () => ({ id: 'Nova', profileRevision: 1 }),
    selectAgent() {},
    saveAgentProfile: async () => null,
    refreshTopicsForAgent: async () => {},
    notify() {},
    refreshViews() {},
});

const pending = coordinator.persist({ model: 'model-a-new', permissionMode: 'always-approve' }, 'session-a');
projection = {
    selectedSessionId: 'session-b',
    selectedTopic: { sessionId: 'session-b', configRevision: 7, configSnapshot: { model: 'model-b' } },
};
saveA.resolve({
    settings: { model: 'model-a-new', permissionMode: 'always-approve' },
    session: {
        sessionId: 'session-a',
        configRevision: 4,
        configSnapshot: { model: 'model-a-new', permissionMode: 'always-approve' },
    },
});
await pending;
assert.equal(state.model, 'model-b', 'Session A completion must not replace Session B model');
assert.equal(state.permissionMode, 'ask', 'Session A completion must not replace Session B permission');
assert.equal(state.modelDraft, 'model-b-draft', 'Session B draft must remain owned by Session B');
assert.equal(storeWrites.length, 0, 'Session A completion must not patch Session B projection');
assert.equal(coordinator.sessionConfigRevisions.get('session-a'), 4,
    'the completed Session keeps its own CAS revision for future saves');
coordinator.dispose();

console.log('Agent settings coordinator Session isolation tests passed.');
