import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="flow"></div><aside id="sidebar"></aside></body>');
const { document } = dom.window;
globalThis.window = dom.window;
globalThis.document = document;
const { createAgentProfileFlowFeature } = await import('../modules/ui-system/agent-profile-flow-feature.js');
const { createAgentSessionManagementFeature } = await import('../modules/ui-system/agent-session-management-feature.js');
const { createAgentSettingsPaneFeature } = await import('../modules/ui-system/agent-settings-pane-feature.js');
const { node, visualActionButton } = await import('../modules/ui-system/agent-workbench-dom.js');
let pendingRun = Promise.resolve();
const run = (work) => {
    pendingRun = Promise.resolve().then(work);
    return pendingRun;
};

const profileEvents = [];
const profileState = { topicFlow: null, selectedAgent: 'Nova', model: 'deepseek-v4-flash', modelCatalog: [] };
const profileFeature = createAgentProfileFlowFeature({
    state: profileState,
    controller: {
        workspaceSelectRoot: async () => ({
            cancelled: false,
            workspaceRoot: 'C:\\workspace\\research',
        }),
        saveAgentProfile: async (request) => ({
            success: true,
            profile: { id: 'Research-Agent', name: request.name },
        }),
    },
    element: document.getElementById('flow'),
    document,
    run,
    queueRender: (parts) => profileEvents.push({ type: 'render', parts }),
    refreshControlPlane: async () => profileEvents.push({ type: 'refresh' }),
    notify: (message, level) => profileEvents.push({ type: 'notify', message, level }),
});
profileFeature.open();
profileFeature.render();
const profileForm = profileFeature.view.element.querySelector('form');
profileForm.querySelector('[aria-label="选择 Build Agent 默认工作目录"]').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(profileForm.querySelector('[aria-label="Build Agent 默认工作目录"]').value, 'C:\\workspace\\research');
assert.equal(profileState.topicFlow.workspaceRoot, 'C:\\workspace\\research',
    'the native workspace picker must update the isolated Agent profile draft');
profileForm.querySelector('[aria-label="Build Agent 名称"]').value = 'Research Agent';
profileForm.querySelector('[aria-label="Build Agent 提示词"]').value = '{{Research}}';
profileForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
await pendingRun;
assert.equal(profileState.selectedAgent, 'Research-Agent');
assert.equal(profileState.topicFlow, null);
assert.equal(profileState.tab, 'sessions');
assert.ok(profileEvents.some((event) => event.type === 'refresh'));
assert.ok(profileEvents.some((event) => event.type === 'notify' && event.level === 'success'));

const sessionEvents = [];
const composerStateBySession = new Map([['session-a', { draft: 'local' }]]);
const sessionState = { topicManaging: false, composerStateBySession };
const sessionFeature = createAgentSessionManagementFeature({
    state: sessionState,
    controller: {
        archiveSession: async (sessionId) => sessionEvents.push({ type: 'archive', sessionId }),
    },
    document,
    window: dom.window,
    node: (tag, className, text) => node(tag, className, text, document),
    visualActionButton: (iconName, label, className, text) => (
        visualActionButton(iconName, label, className, text, document)
    ),
    run,
    host: { feedback: { confirm: async () => true } },
    notify: (message, level) => sessionEvents.push({ type: 'notify', message, level }),
    rememberTopic() {},
    rememberTopicTitle() {},
    forgetTopic: (sessionId) => sessionEvents.push({ type: 'forget', sessionId }),
    refreshControlPlane: async () => sessionEvents.push({ type: 'refresh' }),
});
const sessionRow = document.createElement('div');
document.body.append(sessionRow);
sessionFeature.appendActions(sessionRow, { id: 'session-a', title: 'Session A' });
sessionRow.querySelector('button').click();
const archiveItem = [...document.querySelectorAll('.agent-chat-topic-context-menu-item')]
    .find((item) => item.textContent.includes('归档会话'));
assert.ok(archiveItem, 'Session management feature must expose the archive command');
archiveItem.click();
await pendingRun;
assert.equal(composerStateBySession.has('session-a'), false);
assert.deepEqual(sessionEvents.filter((event) => ['archive', 'forget', 'refresh'].includes(event.type))
    .map((event) => event.type), ['archive', 'forget', 'refresh']);

const sidebar = document.getElementById('sidebar');
const status = document.createElement('p');
status.className = 'agent-chat-settings-save-status';
sidebar.append(status);
const settingsState = {
    tab: 'settings',
    settingsScope: 'session',
    settingsSaveByScope: new Map([['session', { state: 'saving', message: '正在保存工作目录' }]]),
};
const settingsFeature = createAgentSettingsPaneFeature({
    state: settingsState,
    sidebar,
    settingsState: { value() {}, status() {}, schedule() {} },
    advancedSettingsFeature: { current: () => ({ model: {}, request: {} }), view: {}, load() {} },
});
settingsFeature.refreshStatus();
assert.equal(status.className, 'agent-chat-settings-save-status is-saving');
assert.equal(status.textContent, '正在保存工作目录');

sessionFeature.dispose();
profileFeature.dispose();
dom.window.close();
delete globalThis.window;
delete globalThis.document;
console.log('Agent Workbench feature composition tests passed.');
