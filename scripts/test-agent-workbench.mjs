import { assert, fs, path, pathToFileURL, readCssWithImports, waitFor, root, workbenchProjectionPatch, dom, resizeObservers, TestResizeObserver, revokedAvatarUrl, unsubscribeCalls, eventCallback, runtimeStatus, activeRuntimeSession, presenceCalls, startedTurns, importedAttachment, importedVideoAttachment, selectedAttachments, followUpTurns, steeringTurns, cancelledTurns, interactionQueue, replacedInteractionQueues, resolvedPendingInputs, createdSessions, createdTopics, renamedTopics, compactedSessions, approvalResponses, interactionResponses, openedExternalLinks, workspaceActions, savedWorkbenchSettings, sessionConfigRevisions, sessionConfigSnapshots, savedAvatars, savedAgentProfiles, runtimeTransitions, runtimeEnsures, exportedSessions, mainCreateProxyCalls, sharedCreateActionCalls, releaseAgentCatalog, buildAgentProfiles, agentCatalogGate, topicCatalog, secondaryTopicCatalog, archivedTopicCatalog, topicListRequests, topicSearchRequests, canonicalSessionProjection, runtimeEventNumber, emitDaemonEvent, fixtureProjectionRevisionBySession, emitProjectionBlock, setSelectedAttachments, setInteractionQueue, setRuntimeStatus } from './fixtures/agent-workbench-harness.mjs';

// next-ui-apps overwrites the stub; capture registrations via its real registry.
await import(`${pathToFileURL(path.join(root, 'modules/ui-system/agent-workbench.js')).href}?test=${Date.now()}`);
const registeredApp = window.nextUiApps.get('agent-workbench');
assert.ok(registeredApp, 'Agent Workbench must register as an internal app');
assert.equal(registeredApp.kind, 'internal');

const host = document.getElementById('host');
const mainCreateProxy = document.createElement('button');
mainCreateProxy.id = 'nextUiCreateItemBtn';
mainCreateProxy.addEventListener('click', () => { mainCreateProxyCalls += 1; });
document.body.append(mainCreateProxy);
window.topTabManager = {
    openCreateDialog() { sharedCreateActionCalls += 1; },
};
// The Workbench uses its own Topic controls while routing their actions to
// Codex-owned Agent Sessions.  The only main-chat element below exists to retain
// the compatibility fallback for a partially initialized shell.
const mainTopicToolbar = document.createElement('div');
mainTopicToolbar.innerHTML = `
    <button id="nextUiCreateTopicBtn" class="next-ui-create-topic-trigger" type="button"><span>新建话题</span></button>
    <button id="nextUiManageTopicsBtn" class="next-ui-topic-icon-trigger" type="button" aria-pressed="false">管理</button>
    <button id="nextUiTopicSearchTrigger" class="next-ui-topic-icon-trigger" type="button" aria-expanded="false">搜索</button>
    <div id="tabContentTopics"><div class="sidebar-subtab-item sidebar-search-subtab"><div class="topic-search-container"><input id="topicSearchInput" class="topic-search-input"><button class="next-ui-topic-search-close" type="button">关闭</button></div></div></div>
`;
document.body.append(mainTopicToolbar);
// The normal VCPChat sidebar has already painted this cached display catalog
// before the internal Workbench opens. It must be usable for its first frame
// even while the authoritative IPC catalog remains deliberately delayed.
const mainAgentList = document.createElement('ul');
mainAgentList.id = 'agentList';
mainAgentList.innerHTML = '<li data-item-type="agent" data-item-id="123"><img class="avatar" src="assets/default_avatar.png"><span class="agent-name">123</span></li>';
document.body.append(mainAgentList);
window.prompt = () => '重命名后的 Topic';
window.confirm = () => true;
window.VCPUI = { feedback: {
    confirm: async () => true,
    prompt: async () => '重命名后的 Topic',
    toast: () => {},
} };
window.localStorage.setItem('vcpchat.agentWorkbench.lastTopic.v1', JSON.stringify({
    sessionId: 'topic-restored', title: '可恢复的 Codex Session', agentId: 'Nova',
    model: 'gpt-5.6-terra', workspaceRoot: root,
}));
window.localStorage.setItem('vcpchat.agentWorkbench.sidebarWidth', '600');
const dispose = registeredApp.mount(host, {});
await new Promise((resolve) => setTimeout(resolve, 100));
const workbenchRoot = host.querySelector('.agent-chat-root');
const workbenchSidebar = host.querySelector('.agent-chat-sidebar');
workbenchRoot.getBoundingClientRect = () => ({ left: 0, width: 900 });
resizeObservers.filter((observer) => observer.targets.has(workbenchRoot)).forEach((observer) => observer.callback());
assert.ok(workbenchSidebar.classList.contains('agent-chat-sidebar-width-560'),
    'a saved 600px sidebar preference must temporarily clamp when the Workbench leaves only a 320px chat column');
assert.equal(workbenchSidebar.getAttribute('style'), null,
    'the resizable sidebar must use governed width classes instead of Renderer inline styles');
workbenchRoot.getBoundingClientRect = () => ({ left: 0, width: 1_200 });
resizeObservers.filter((observer) => observer.targets.has(workbenchRoot)).forEach((observer) => observer.callback());
assert.ok(workbenchSidebar.classList.contains('agent-chat-sidebar-width-600'),
    'expanding the Workbench must restore the saved sidebar preference instead of persisting the temporary clamp');
assert.equal(createdSessions.length, 0,
    'renderer reload must preview the saved Codex Session without acquiring a writable Session');
assert.deepEqual(JSON.parse(window.localStorage.getItem('vcpchat.agentWorkbench.lastTopic.v1')), { sessionId: 'topic-restored' },
    'localStorage must retain only the durable Topic pointer');
assert.ok([...host.querySelectorAll('.message-item .md-content')]
    .some((node) => node.textContent.includes('restored answer')),
    'a restored Codex Session must render its saved history rather than an empty feed');
const restoredReasoning = host.querySelector('[data-message-id="msg_reason_saved"] .agent-chat-reasoning-block');
assert.ok(restoredReasoning, 'a SQLite-first cold mount must restore reasoning as a compact thought card');
assert.equal(restoredReasoning.closest('.message-item')?.querySelector('.md-content')?.textContent?.trim() || '', '',
    'restored reasoning must not degrade into a normal large assistant text bubble');
assert.equal(restoredReasoning.closest('.message-item')?.querySelector('.md-content')?.hidden, true,
    'a reasoning-only message must hide its empty standard bubble in bubble presentation mode');
assert.ok(restoredReasoning.closest('.message-item')?.classList.contains('agent-chat-reasoning-only'),
    'reasoning-only state must be explicit so later text can restore the same message bubble');
const restoredReasoningHeader = restoredReasoning.querySelector('.vcp-thought-chain-header');
const restoredReasoningBubble = restoredReasoning.querySelector('.vcp-thought-chain-bubble');
assert.equal(restoredReasoningBubble.classList.contains('expanded'), false,
    'completed reasoning restored from SQLite must start collapsed');
restoredReasoningHeader.click();
assert.equal(restoredReasoningBubble.classList.contains('expanded'), true,
    'restored reasoning must remain clickable after a cold mount');
restoredReasoningHeader.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
assert.equal(restoredReasoningBubble.classList.contains('expanded'), false,
    'restored reasoning must support keyboard collapse without relying on the live event path');
restoredReasoningHeader.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
assert.equal(restoredReasoningBubble.classList.contains('expanded'), true,
    'restored reasoning must support Space-key expansion');
assert.equal(restoredReasoning.querySelector('.agent-chat-reasoning-copy'), null,
    'restored completed reasoning must not render a duplicate copy action');
const restoredToolCard = host.querySelector('.agent-chat-tool-activity[data-tool-call-id="tool_saved"]');
assert.ok(restoredToolCard,
    'a SQLite-first cold mount must restore structured tool activity instead of flattening it into text');
assert.match(restoredToolCard.textContent, /FileOperator/,
    'a restored dynamic vcp_invoke item must display the actual ToolBox target');
assert.ok(restoredToolCard.querySelector('.agent-chat-tool-chevron'),
    'nested dynamicToolCall arguments and results must make a restored tool card expandable');
restoredToolCard.querySelector('.agent-chat-tool-chevron').click();
assert.match(restoredToolCard.querySelector('.agent-chat-tool-detail')?.textContent || '', /operation.*read.*package\.json/s,
    'expanded restored tools must expose their durable arguments and result');
assert.doesNotMatch(host.querySelector('.agent-chat-messages')?.textContent || '', /恢复计划/,
    'a durable Plan Item must not duplicate itself as a normal assistant bubble');
workbenchRoot.getBoundingClientRect = () => ({ left: 0, width: 900 });
resizeObservers.filter((observer) => observer.targets.has(workbenchRoot)).forEach((observer) => observer.callback());
assert.ok(workbenchSidebar.classList.contains('agent-chat-sidebar-width-560'),
    'the narrow Workbench baseline must restore before testing an open Activity panel');
host.querySelector('.agent-chat-header-activity')?.click();
const activityPanelSplitter = host.querySelector('.agent-chat-activity-splitter[role="separator"]');
const activityPanelElement = host.querySelector('.agent-chat-activity-panel');
assert.ok(workbenchSidebar.classList.contains('agent-chat-sidebar-width-180'),
    'opening Activity must temporarily reduce a wide saved sidebar preference before it crowds out the chat column');
assert.ok(activityPanelSplitter?.classList.contains('is-active'),
    'opening Session information must expose the chat/panel resize handle');
assert.ok(activityPanelElement?.classList.contains('agent-chat-activity-width-420'),
    'Session information must retain the original compact default width');
activityPanelSplitter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
assert.ok(activityPanelElement.classList.contains('agent-chat-activity-width-440'),
    'moving the outer splitter left must widen Session information');
activityPanelSplitter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
assert.ok(activityPanelElement.classList.contains('agent-chat-activity-width-420'),
    'moving the outer splitter right must restore the compact panel width');
assert.equal(host.querySelector('.agent-chat-activity-tab[data-tab="plan"]'), null,
    'the toolbox-only product must hide Plan until collaboration mode is wired to turn/start');
assert.equal(host.querySelector('.agent-chat-inspector-plan'), null,
    'the Context tab must not invent a Plan when the projection has no authoritative Plan item');
host.querySelector('.agent-chat-activity-tab[data-tab="context"]')?.click();
assert.match(host.querySelector('.agent-chat-activity-usage')?.textContent || '', /42/,
    'a cold SQLite projection must restore durable usage metrics');
assert.match(host.querySelector('.agent-chat-activity-usage')?.textContent || '', /已恢复压缩摘要/,
    'a cold SQLite projection must restore the last compaction summary');
host.querySelector('.agent-chat-activity-close')?.click();
assert.ok(workbenchSidebar.classList.contains('agent-chat-sidebar-width-560'),
    'closing Activity must restore the saved sidebar preference instead of persisting the temporary clamp');
assert.ok(host.querySelector('.agent-chat-root.container'));
assert.ok(host.querySelector('.agent-chat-sidebar.sidebar'), 'Agent sessions must reuse the main sidebar shell');
assert.ok(host.querySelector('.agent-chat-main-content.main-content'), 'Agent conversation must reuse the main chat content shell');
assert.ok(host.querySelector('.agent-chat-main-content .chat-header'), 'Agent conversation must reuse the main chat header');
assert.ok(host.querySelector('.agent-chat-messages-container.chat-messages-container'), 'Agent feed must reuse the main message scroller');
assert.ok(host.querySelector('.agent-chat-composer.chat-input-area'), 'Agent composer must reuse the main chat input area');
assert.ok(host.querySelector('.agent-chat-composer .chat-input-card'), 'Agent composer must reuse the main chat input card');
assert.ok(host.querySelector('.agent-chat-sidebar .sidebar-tabs'), 'Agent navigation must retain the redesigned sidebar tabs');
assert.ok(host.querySelector('.agent-chat-sidebar .agent-chat-sidebar-content.sidebar-tab-content.active'),
    'Agent sidebar must own a dedicated full-width tab content container');
assert.equal(host.querySelector('.agent-chat-sidebar .sidebar-tab-content.active')?.classList.contains('agent-chat-pane'), false,
    'sidebar tab content must never inherit the main conversation pane flex contract');
const assistantTab = [...host.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
    .find((tab) => tab.textContent.trim() === '助手');
assert.ok(assistantTab, 'Assistant tab must be available');
assistantTab.click();
assert.ok([...host.querySelectorAll('.agent-chat-agent-row .agent-name')].some((node) => node.textContent === 'Nova'),
    'a slow Build Agent profile IPC must not leave the Assistant list blank before Nova renders');
assert.equal([...host.querySelectorAll('.agent-chat-agent-row .agent-name')].some((node) => node.textContent === '123'), false,
    'the Workbench must not import a same-named Agent from the normal-chat sidebar');
releaseAgentCatalog();
await new Promise((resolve) => setTimeout(resolve, 30));
const sessionsBeforeAgentBrowse = createdSessions.length;
const secondaryAgent = [...host.querySelectorAll('.agent-chat-agent-row')]
    .find((row) => row.querySelector('.agent-name')?.textContent === '123');
assert.ok(secondaryAgent, 'a second Build Agent profile must be selectable for Topic browsing');
secondaryAgent.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('.sidebar-tab-button.active')?.textContent, '会话',
    'selecting an Agent must open its Topic catalog without requiring New Topic');
assert.ok([...host.querySelectorAll('.agent-chat-persisted-topic .topic-title-display')]
    .some((node) => node.textContent === '123 的既有 Topic'),
    'the selected Agent history must render immediately from SQLite Session metadata');
assert.equal(createdSessions.length, sessionsBeforeAgentBrowse,
    'browsing an Agent history must not create an empty Agent Session');
assert.equal(topicListRequests.at(-1), '123',
    'the Workbench must request the selected Agent Topic catalog explicitly');
assert.match(host.querySelector('.agent-chat-title')?.textContent || '', /123/,
    'switching Build Agents must clear the previous Agent Session projection instead of showing its running state');
assert.equal([...host.querySelectorAll('.message-item .md-content')]
    .some((node) => node.textContent.includes('restored answer')), false,
    'switching Build Agents must not retain the previous Agent transcript in the main pane');
await new Promise((resolve) => setTimeout(resolve, 300));
const profileSettingsTab = [...host.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
    .find((tab) => tab.textContent.trim() === '设置');
profileSettingsTab.click();
const profileSettingsFields = [...host.querySelectorAll('.agent-chat-settings-pane .agent-chat-setting-field')];
const profileWorkspace = profileSettingsFields
    .find((item) => item.querySelector('.agent-chat-setting-label')?.textContent.includes('工作目录'))?.querySelector('input');
const profileModel = profileSettingsFields
    .find((item) => item.querySelector('.agent-chat-setting-label')?.textContent === '模型')?.querySelector('select');
const profilePermission = profileSettingsFields
    .find((item) => item.querySelector('.agent-chat-setting-label')?.textContent === '本地工具审批')?.querySelector('select');
profileWorkspace.value = `${root}\\agent-123-updated`;
profileWorkspace.dispatchEvent(new window.Event('change', { bubbles: true }));
profileModel.value = 'gpt-5.6-terra';
profileModel.dispatchEvent(new window.Event('change', { bubbles: true }));
profilePermission.value = 'always-approve';
profilePermission.dispatchEvent(new window.Event('change', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 100));
assert.deepEqual({
    agentId: savedAgentProfiles.at(-1).agentId,
    model: savedAgentProfiles.at(-1).model,
    workspaceRoot: savedAgentProfiles.at(-1).workspaceRoot,
    permissionMode: savedAgentProfiles.at(-1).permissionMode,
}, {
    agentId: '123', model: 'gpt-5.6-terra', workspaceRoot: `${root}\\agent-123-updated`, permissionMode: 'always-approve',
}, 'settings with no selected Session must update the current Agent Profile inherited by future Sessions');
assistantTab.click();
const novaAgent = [...host.querySelectorAll('.agent-chat-sidebar .agent-chat-agent-row')]
    .find((row) => row.querySelector('.agent-name')?.textContent === 'Nova');
assert.ok(novaAgent, 'the Nova Agent must remain available after browsing another Agent');
novaAgent.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assistantTab.click();
const sharedCreate = host.querySelector('.next-ui-create-item-trigger');
const agentSearchTrigger = host.querySelector('.next-ui-agent-search-trigger');
assert.ok(sharedCreate && agentSearchTrigger, 'Agent assistant sidebar must reuse the main shared create-and-search controls');
assert.match(sharedCreate.textContent, /新建 Build Agent/);
sharedCreate.click();
await new Promise((resolve) => setTimeout(resolve, 30));
const agentDialog = host.querySelector('.agent-chat-topic-flow-dialog');
assert.ok(agentDialog, 'Build Agent creation must use an isolated Workbench dialog');
agentDialog.querySelector('[aria-label="Build Agent 名称"]').value = 'Research Agent';
agentDialog.querySelector('[aria-label="Build Agent 名称"]').dispatchEvent(new window.Event('input', { bubbles: true }));
agentDialog.querySelector('[aria-label="Build Agent 提示词"]').value = '{{Research}}';
agentDialog.querySelector('[aria-label="Build Agent 提示词"]').dispatchEvent(new window.Event('input', { bubbles: true }));
agentDialog.querySelector('[aria-label="Build Agent 默认工作目录"]').value = `${root}\\research-profile`;
agentDialog.querySelector('[aria-label="Build Agent 默认工作目录"]').dispatchEvent(new window.Event('input', { bubbles: true }));
agentDialog.querySelector('[aria-label="Build Agent 默认审批模式"]').value = 'always-approve';
agentDialog.querySelector('[aria-label="Build Agent 默认审批模式"]').dispatchEvent(new window.Event('change', { bubbles: true }));
agentDialog.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 30));
const createdAgentProfile = savedAgentProfiles.find((profile) => profile.name === 'Research Agent');
assert.ok(createdAgentProfile, 'Build Agent creation must persist through the isolated runtime profile IPC');
assert.equal(createdAgentProfile.systemPrompt, '{{Research}}');
assert.equal(createdAgentProfile.workspaceRoot, `${root}\\research-profile`);
assert.equal(createdAgentProfile.permissionMode, 'always-approve');
assert.ok([...host.querySelectorAll('.agent-chat-agent-row .agent-name')].some((item) => item.textContent === 'Research Agent'),
    'a successfully created Build Agent must appear in the Build Agent list');
assert.equal(sharedCreateActionCalls, 0, 'Build Agent creation must not write to the main-chat Agent directory');
assert.equal(mainCreateProxyCalls, 0, 'Build Agent creation must not proxy the main-chat creation button');
const recreatedNova = [...host.querySelectorAll('.agent-chat-agent-row')]
    .find((row) => row.querySelector('.agent-name')?.textContent === 'Nova');
recreatedNova.click();
await new Promise((resolve) => setTimeout(resolve, 30));
[...host.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
    .find((tab) => tab.textContent.trim() === '助手').click();
host.querySelector('.next-ui-agent-search-trigger').click();
const agentSearch = host.querySelector('.agents-header .topic-search-input');
assert.ok(agentSearch && host.querySelector('.agents-header.is-searching'),
    'the shared assistant search affordance must become interactive in the Agent projection');
agentSearch.value = '123';
agentSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(host.querySelector('.agent-chat-agent-row[data-agent-search*="nova"]').hidden, true,
    'assistant search must filter the projected shared Agent catalog');
host.querySelector('.next-ui-agent-search-close').click();
assert.equal(agentSearch.value, '', 'closing assistant search must clear its transient query');
const headerNewTopic = host.querySelector('.agent-chat-composer-new');
assert.ok(headerNewTopic, 'Agent composer must retain the separate new-Topic action');
const topicCountBeforeDirectCreate = createdTopics.length;
headerNewTopic.click();
headerNewTopic.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('.agent-chat-topic-flow-dialog'), null,
    'new Agent conversations must be created immediately without a redundant modal');
assert.equal(createdTopics.length, topicCountBeforeDirectCreate + 1,
    'double-clicking New Session while creation is in flight must produce exactly one Main request');
assert.equal(createdTopics.at(-1).agent, 'Nova',
    'a direct new Session must inherit the selected Profile identity');
assert.match(createdTopics.at(-1).title, /^新会话 /,
    'a direct new Session must receive the standard generated title');
assert.deepEqual(Object.keys(createdTopics.at(-1)).sort(), ['agent', 'title'],
    'new Agent Sessions must send only identity and title so Main freezes the selected Profile configuration');
assert.equal(createdSessions.length, 0, 'creating a Session must not replace or stop another Session Runtime');
assert.equal(host.querySelector('.agent-chat-message-input').disabled, false, 'a newly created Codex Session preview must keep the composer send-capable');

// Legacy Build Agents created before prompts became mandatory must fail in
// the Renderer as a single actionable configuration state. They must never
// spam create-topic or silently inherit another Agent's identity.
[...host.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
    .find((tab) => tab.textContent.trim() === '助手').click();
const legacyAgent = [...host.querySelectorAll('.agent-chat-agent-row')]
    .find((row) => row.querySelector('.agent-name')?.textContent === 'Legacy Empty');
assert.ok(legacyAgent?.classList.contains('configuration-required'),
    'an old Build Agent without a prompt must be marked as requiring configuration');
legacyAgent.click();
await new Promise((resolve) => setTimeout(resolve, 30));
const topicsBeforeMissingPromptClick = createdTopics.length;
host.querySelector('.agent-chat-composer-new').click();
host.querySelector('.agent-chat-composer-new').click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(createdTopics.length, topicsBeforeMissingPromptClick,
    'a missing-prompt Agent must not invoke create-topic even after repeated clicks');
assert.equal(host.querySelector('.agent-chat-topic-flow-dialog'), null,
    'missing Agent configuration must not reintroduce the removed new-Session modal');
assert.equal(host.querySelector('.sidebar-tab-button.active')?.textContent, '设置',
    'a missing-prompt Agent must route to its actionable settings page');
assert.match(host.querySelector('.agent-chat-profile-configuration-warning')?.textContent || '', /缺少|提示词|不能创建/,
    'the settings page must explain why this Agent cannot create a Session');
const legacyPrompt = host.querySelector('[aria-label="VChat 身份提示词"]');
assert.equal(legacyPrompt?.readOnly, false,
    'the old Agent prompt must be editable in place instead of remaining permanently blocked');
legacyPrompt.value = '{{LegacyEmpty}}';
legacyPrompt.dispatchEvent(new window.Event('input', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 580));
assert.equal(savedAgentProfiles.at(-1).baseInstructions, '{{LegacyEmpty}}',
    'repairing a legacy Agent must persist only that Agent prompt');
assert.equal([...host.querySelectorAll('.agent-chat-settings-save')]
    .some((button) => button.textContent === '用此配置新建会话'), false,
    'settings must not duplicate the one-click new Session action');
host.querySelector('.agent-chat-composer-new').click();
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(createdTopics.length, topicsBeforeMissingPromptClick + 1,
    'after repairing its prompt, the same Agent may create one direct Session');
assert.equal(createdTopics.at(-1).agent, 'Legacy-Empty');

[...host.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
    .find((tab) => tab.textContent.trim() === '助手').click();
[...host.querySelectorAll('.agent-chat-agent-row')]
    .find((row) => row.querySelector('.agent-name')?.textContent === 'Nova').click();
await new Promise((resolve) => setTimeout(resolve, 30));
const sessionTab = [...host.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
    .find((tab) => tab.textContent.trim() === '会话');
assert.ok(sessionTab, 'Assistant and session tabs must both be available');
sessionTab.click();
assert.ok(host.querySelector('.agent-chat-session-row'));
assert.ok([...host.querySelectorAll('.agent-chat-session-row .topic-title-display')]
    .some((node) => node.textContent === '另一条持久 Topic'),
    'the sidebar must render durable Codex Sessions, not only the current in-memory session');
const stableTopicRow = host.querySelector('.agent-chat-persisted-topic[data-session-id="topic-archived"]');
const stableTopicScroll = host.querySelector('.agent-chat-sidebar .sidebar-list-scroll');
stableTopicScroll.scrollTop = 37;
sessionTab.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.strictEqual(host.querySelector('.agent-chat-persisted-topic[data-session-id="topic-archived"]'), stableTopicRow,
    'a background Codex Session refresh must reconcile the existing sidebar row instead of rebuilding the list');
assert.equal(host.querySelector('.agent-chat-sidebar .sidebar-list-scroll').scrollTop, 37,
    'a background Codex Session refresh must keep the sidebar reading anchor');
const topicToolbar = host.querySelector('.topics-header-container .next-ui-topic-tools');
assert.ok(topicToolbar, 'Agent sessions must use the same Topic toolbar shell as main chat');
assert.ok(topicToolbar.querySelector('.next-ui-create-topic-trigger'), 'Agent sessions must expose a new Topic control');
const topicManage = topicToolbar.querySelector('.next-ui-topic-icon-trigger[aria-label="管理会话"]');
const topicSearchTrigger = topicToolbar.querySelector('.next-ui-topic-icon-trigger[aria-label="搜索会话"]');
assert.ok(topicManage && topicSearchTrigger, 'Agent sessions must expose the same manage-and-search controls as main chat');
topicSearchTrigger.click();
const topicSearch = host.querySelector('.topics-header-container.is-searching .topic-search-input');
assert.ok(topicSearch, 'Agent Topic search must expand from the shared Topic toolbar rather than remain permanently visible');
topicSearch.value = '另一条';
topicSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(host.querySelector('.agent-chat-persisted-topic[data-session-id="topic-restored"]').hidden, true,
    'expanded Topic search must filter durable Codex Sessions');
await new Promise((resolve) => setTimeout(resolve, 240));
assert.deepEqual(topicSearchRequests.at(-1), { query: '另一条', agentId: 'Nova' },
    'Topic search must cross the narrow Agent IPC instead of remaining a local DOM filter');
assert.ok(host.querySelector('.agent-chat-persisted-topic[data-session-id="topic-archived"]'),
    'SQLite search hits must project back into the Topic list using their durable sessionId');
host.querySelector('.topics-header-container .next-ui-topic-search-close').click();
assert.equal(host.querySelector('.topic-search-input')?.value || '', '', 'closing Topic search must clear its transient query');
topicManage.click();
assert.equal(host.querySelector('.topics-header-container .next-ui-topic-icon-trigger[aria-label="管理会话"]')?.getAttribute('aria-pressed'), 'true',
    'Topic manage control must enter renderer-local management mode');
assert.ok(host.querySelector('.agent-chat-sidebar-content.is-managing .agent-chat-topic-manage-panel'),
    'Topic manage mode must expose the same bottom management affordance as main chat');
const selectableTopic = host.querySelector('.agent-chat-persisted-topic[data-session-id="topic-archived"]');
selectableTopic.click();
assert.match(host.querySelector('.agent-chat-topic-selection-count').textContent, /1/,
    'management mode must select a Codex Session rather than opening it');
host.querySelector('.agent-chat-topic-manage-panel [aria-label="退出会话管理"]').click();
assert.equal(host.querySelector('.agent-chat-sidebar-content').classList.contains('is-managing'), false,
    'exiting Topic management must discard renderer-only selection state');
const persistedTopicMenu = host.querySelector('.agent-chat-persisted-topic .agent-chat-session-menu');
assert.ok(persistedTopicMenu, 'a free durable Topic must expose its own management menu');
const managedSessionId = persistedTopicMenu.closest('.agent-chat-persisted-topic')?.dataset.sessionId;
persistedTopicMenu.click();
const topicContextMenu = document.querySelector('.agent-chat-topic-context-menu');
assert.ok(topicContextMenu?.parentElement === document.body,
    'Topic actions must be a document-level popover so the sidebar scroller cannot clip it');
assert.equal(topicContextMenu?.getAttribute('role'), 'menu', 'Topic actions must expose a real menu role');
assert.ok(topicContextMenu?.classList.contains('context-menu'),
    'Agent Topics must reuse the main-chat context-menu visual primitive');
assert.ok(topicContextMenu?.querySelectorAll('.context-menu-item > i.fas').length >= 4,
    'Agent Topic actions must reuse the main-chat FontAwesome icon hierarchy');
const renameTopicButton = [...topicContextMenu.querySelectorAll('[role="menuitem"]')]
    .find((button) => button.textContent === '重命名');
assert.ok(renameTopicButton, 'Topic management menu must offer rename');
renameTopicButton.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(renamedTopics, [{ sessionId: managedSessionId, title: '重命名后的 Topic' }],
    'Topic rename must use the narrow Codex Agent IPC, not write renderer-side storage');
const persistedTopicRow = host.querySelector('.agent-chat-persisted-topic[data-session-id="topic-restored"]');
persistedTopicRow.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 32, clientY: 48,
}));
const rightClickTopicMenu = document.querySelector('.agent-chat-topic-context-menu');
assert.ok(rightClickTopicMenu, 'right-clicking a free Codex Session must open the same context menu');
assert.ok([...rightClickTopicMenu.querySelectorAll('[role="menuitem"]')]
    .some((button) => button.textContent === '归档会话'),
    'active Sessions must expose recoverable archive through the narrow Codex Agent IPC');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(document.querySelector('.agent-chat-topic-context-menu'), null,
    'Escape must close the transient Topic menu rather than leaving a stale overlay');
const archivedToggle = host.querySelector('[aria-label="查看归档会话"]');
assert.ok(archivedToggle, 'the Session toolbar must expose archived history without mixing it into the active list');
archivedToggle.click();
await new Promise((resolve) => setTimeout(resolve, 30));
const archivedRow = host.querySelector('.agent-chat-persisted-topic[data-session-id="topic-permanent-archive"]');
assert.ok(archivedRow, 'the archived view must come from the projection-only Session catalog');
archivedRow.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('.agent-chat-message-input').disabled, true,
    'an archived Session may be read but cannot implicitly resume on selection');
assert.equal(runtimeEnsures.length, 0, 'projection preview must not eagerly ensure a Codex runtime');
archivedRow.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 32, clientY: 48,
}));
const archivedMenu = document.querySelector('.agent-chat-topic-context-menu');
assert.ok([...archivedMenu.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === '恢复会话'));
assert.ok([...archivedMenu.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === '永久删除'));
assert.ok([...archivedMenu.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === '导出 Markdown'));
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
host.querySelector('[aria-label="返回当前会话"]').click();
await new Promise((resolve) => setTimeout(resolve, 30));
const inUseTopicRow = [...host.querySelectorAll('.agent-chat-persisted-topic')]
    .find((row) => row.querySelector('.topic-title-display')?.textContent === '并行研究 Session');
assert.ok(inUseTopicRow, 'legacy inUse metadata must not hide a durable Codex Session');
assert.doesNotMatch(inUseTopicRow.textContent || '', /使用中|占用/,
    'obsolete concurrency metadata must not leak into the Codex Session row');
inUseTopicRow.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 32, clientY: 48,
}));
const occupiedTopicMenu = document.querySelector('.agent-chat-topic-context-menu');
assert.ok(occupiedTopicMenu, 'right-clicking a legacy-marked Session must expose its normal management menu');
assert.ok([...occupiedTopicMenu.querySelectorAll('[role="menuitem"]')]
    .some((button) => button.textContent === '打开会话'),
    'legacy metadata must not replace the normal open action');
assert.ok([...occupiedTopicMenu.querySelectorAll('[role="menuitem"]')]
    .some((button) => button.textContent === '归档会话'),
    'ordinary Session removal must be presented as recoverable archive');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
inUseTopicRow.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('.agent-chat-topic-conflict-dialog'), null,
    'Codex Session selection must never open the retired runtime-conflict dialog');
assert.equal(host.querySelector('.agent-chat-persisted-topic[data-session-id="topic-in-use"]')?.classList.contains('active'), true,
    'legacy inUse metadata must not prevent immediate SQLite projection selection');
assert.ok(host.querySelector('.agent-chat-header-actions'), 'Tool and approval activity must remain reachable from the redesigned header');
const editableTitle = host.querySelector('.agent-chat-title.is-editable');
assert.ok(editableTitle, 'the active durable Session title must expose an inline rename affordance');
editableTitle.click();
const inlineRenameInput = host.querySelector('.agent-chat-title-input');
assert.ok(inlineRenameInput, 'clicking the active Session title must replace it with an inline editor');
const headerRenameCount = renamedTopics.filter((entry) => entry.sessionId === 'topic-in-use').length;
inlineRenameInput.value = 'Header 内联重命名';
inlineRenameInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await waitFor(() => renamedTopics.filter((entry) => entry.sessionId === 'topic-in-use').length > headerRenameCount);
const renamedHeaderTitle = await waitFor(() => {
    const value = host.querySelector('.agent-chat-title')?.textContent || '';
    return value.includes('Header 内联重命名') ? value : null;
}, 3_000);
assert.match(renamedHeaderTitle || '', /Header 内联重命名/,
    'an inline header rename must persist through the narrow Session rename IPC and return to display mode');
const compactButton = host.querySelector('.agent-chat-compact');
assert.ok(compactButton?.disabled,
    'a projection-only Session preview must not infer an active runtime or enable compaction');
assert.deepEqual(compactedSessions, [], 'preview selection must not invoke Codex thread compaction');
assert.ok(host.querySelector('.agent-chat-message-input'), 'Agent prompt must use the shared main-chat textarea styling contract');
assert.ok(host.querySelector('.agent-chat-composer .chat-input-actions'), 'Agent must reuse the main chat action row');
assert.ok(host.querySelector('.agent-chat-send-button'), 'Agent must expose a real send/cancel control');
assert.equal(typeof eventCallback, 'function');
assert.deepEqual(presenceCalls, [true]);

const prompt = host.querySelector('.agent-chat-message-input');
const attachButton = host.querySelector('[aria-label="添加图片、音频或视频附件"]');
assert.ok(attachButton, 'the composer must expose a narrow attachment-selection action');
attachButton.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.match(host.querySelector('.agent-chat-composer-attachments')?.textContent || '', /设计图\.png/,
    'the Renderer may preview a Main descriptor but must not receive its source path or bytes');
host.querySelector('.agent-chat-send-button').click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(startedTurns[0], { sessionId: 'topic-in-use', prompt: '', attachments: [importedAttachment] },
    'an attachment-only turn must pass the descriptor to Main rather than stringify it into text');
const thinkingRow = await waitFor(() => host.querySelector('.agent-chat-turn-starting'), 3_000);
assert.ok(thinkingRow,
    `the Workbench must show a thinking row before the first Codex item notification: ${host.querySelector('.agent-chat-feed-items')?.innerHTML || ''}`);
assert.ok(thinkingRow.querySelector('.thinking-indicator'),
    `the pre-item thinking row must use the main-chat thinking animation: ${thinkingRow.innerHTML}`);
assert.equal(host.querySelector('.agent-chat-composer-attachments')?.childElementCount || 0, 0,
    'accepted descriptors leave the transient composer tray after they are submitted');
// The ACK-to-first-event gap now has an explicit renderer-only thinking row;
// close the synthetic attachment turn before exercising the next composer
// interaction so the fixture mirrors Codex's terminal notification.
emitDaemonEvent({ sessionId: 'topic-in-use', turnId: 'attachment_turn', type: 'turn.completed' });
await new Promise((resolve) => setTimeout(resolve, 30));
setSelectedAttachments([importedVideoAttachment]);
const mediaAttachButton = await waitFor(() => {
    const candidate = host.querySelector('[aria-label="添加图片、音频或视频附件"]');
    return candidate && !candidate.disabled ? candidate : null;
}, 3_000);
assert.ok(mediaAttachButton, 'a terminal event must re-enable attachment import for the selected Session');
mediaAttachButton.click();
await new Promise((resolve) => setTimeout(resolve, 30));
const videoChip = host.querySelector('.agent-chat-composer-attachments .agent-chat-attachment-chip');
assert.match(videoChip?.textContent || '', /演示\.mp4[\s\S]*视频[\s\S]*4 KB/,
    'audio/video descriptors must render as compact media chips instead of image dimensions');
assert.doesNotMatch(videoChip?.textContent || '', /\?×\?/,
    'non-image media must not pretend to have unknown image dimensions');
videoChip?.querySelector('.agent-chat-attachment-remove')?.click();
assert.equal(host.querySelector('.agent-chat-composer-attachments')?.childElementCount || 0, 0,
    'a queued media descriptor remains a renderer-only draft and can be removed before send');
prompt.value = '请介绍一下自己';
prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(host.querySelector('.agent-chat-send-button').disabled, false,
    `a terminal event must re-enable the composer before the next Turn (placeholder: ${host.querySelector('.agent-chat-message-input')?.placeholder})`);
host.querySelector('.agent-chat-send-button').click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(startedTurns[1], { sessionId: 'topic-in-use', prompt: '请介绍一下自己', attachments: [] }, 'Send must start a real Runtime turn, not save a local draft');
assert.ok([...host.querySelectorAll('.message-item.user .md-content')]
    .some((node) => node.textContent.includes('请介绍一下自己')),
    'an accepted start-turn ACK must project the user message before the first runtime event arrives');
const pendingUserRow = [...host.querySelectorAll('.message-item.user')]
    .find((row) => row.textContent.includes('请介绍一下自己'));
assert.match(pendingUserRow?.textContent || '', /发送中/,
    'the temporary local projection must disclose that durable confirmation is still pending');
// A command ACK only confirms acceptance.  The Workbench must not infer a
// running Turn from it; only Codex's authoritative event may establish
// the live turn used by steering and follow-up controls.
emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', sequence: 3,
    messageId: 'msg_turn_test_user',
    type: 'turn.started', payload: { prompt: '请介绍一下自己' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.ok([...host.querySelectorAll('.message-item.user .md-content')]
    .some((node) => node.textContent.includes('请介绍一下自己')),
    'Codex turn.started must render the submitted user message immediately');
const activeSendButton = host.querySelector('.agent-chat-send-button');
const activeStatusChip = host.querySelector('.agent-chat-status-chip');
assert.equal(activeStatusChip?.dataset.state, 'running', 'an active Turn must expose running state in the header');
assert.match(activeStatusChip?.textContent || '', /运行中\s*\d+s/,
    'the header status must show explicit running state and elapsed time');
const runningSessionRow = host.querySelector('.agent-chat-session-row[data-session-id="topic-in-use"]');
assert.ok(runningSessionRow?.classList.contains('is-running'),
    'the owning Session row must expose its own running state');
assert.ok(runningSessionRow.querySelector('.agent-chat-session-avatar.is-running'),
    'background activity must be rendered as a glow ring around the owning Session avatar');
const idleSessionRow = host.querySelector('.agent-chat-session-row[data-session-id="topic-restored"]');
prompt.value = 'running-session draft';
prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
idleSessionRow.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(prompt.value, '', 'switching Session must not show the running Session draft in another Session');
prompt.value = 'idle-session draft';
prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.notEqual(host.querySelector('.agent-chat-status-chip')?.dataset.state, 'running',
    'switching to an idle Session must hide another Session\'s running status');
assert.ok(runningSessionRow.classList.contains('is-running'),
    'switching away must preserve the background glow on the running Session row');
assert.equal(idleSessionRow.querySelector('.agent-chat-session-avatar')?.classList.contains('is-running'), false,
    'the selected idle Session avatar must not inherit another Session\'s running state');
runningSessionRow.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(prompt.value, 'running-session draft',
    'switching back must restore the draft bound to that durable Session ID');
prompt.value = '';
prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(host.querySelector('.agent-chat-status-chip')?.dataset.state, 'running',
    'switching back to the owning Session must restore its Session-scoped running status');
host.querySelector('.agent-chat-status-chip')?.click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(cancelledTurns, [],
    'the header status chip must remain read-only and must never cancel the active Turn');
assert.equal(activeSendButton.querySelector('.vcp-ui-icon')?.textContent, 'arrow_upward',
    'the running composer send action must remain available for explicit steer and follow-up input');
assert.equal(activeSendButton.disabled, true,
    'an empty running composer must not implicitly cancel the Turn');
const runningModes = host.querySelector('.agent-chat-composer-modes');
assert.equal(runningModes.hidden, false, 'running input must expose steer and follow-up modes');
assert.ok([...runningModes.querySelectorAll('button')].some((button) => button.textContent === '立即调整'));
prompt.value = '完成后再列出风险';
prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
host.querySelector('.agent-chat-send-button').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(followUpTurns.length, 1,
    'while a turn is active, normal composer input must queue exactly one Codex follow-up');
assert.equal(followUpTurns[0].sessionId, 'topic-in-use');
assert.equal(followUpTurns[0].turnId, 'turn_test');
assert.equal(followUpTurns[0].afterTurnId, 'turn_test');
assert.equal(followUpTurns[0].prompt, '完成后再列出风险');
assert.match(String(followUpTurns[0].submissionId || ''), /.+/,
    'follow-up submission must carry a stable submissionId');
const steerMode = [...host.querySelectorAll('.agent-chat-composer-mode')]
    .find((button) => button.textContent === '立即调整');
steerMode.click();
prompt.value = '先检查风险';
prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
host.querySelector('.agent-chat-send-button').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(steeringTurns.length, 1,
    'the explicit running mode must insert exactly one immediate steering command');
assert.equal(steeringTurns[0].sessionId, 'topic-in-use');
assert.equal(steeringTurns[0].turnId, 'turn_test');
assert.equal(steeringTurns[0].prompt, '先检查风险');
assert.match(String(steeringTurns[0].submissionId || ''), /.+/,
    'steering submission must carry a stable submissionId');
await new Promise((resolve) => setTimeout(resolve, 30));
const queueToggle = host.querySelector('.agent-chat-queue-toggle');
assert.ok(queueToggle, 'the header must expose the persisted interaction queue');
queueToggle.click();
assert.match(host.querySelector('.agent-chat-queue-panel').textContent, /完成后再列出风险/,
    'the queue panel must render follow-up prompts from Main state');
assert.match(host.querySelector('.agent-chat-queue-panel').textContent, /先检查风险/,
    'the queue panel must distinguish steering prompts from Main state');
const removeQueueButton = host.querySelector('.agent-chat-queue-remove');
assert.ok(removeQueueButton, 'queue items must provide a safe remove operation when Main exposes replacement');
removeQueueButton.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(replacedInteractionQueues.length, 1, 'removing one queue item must replace the Main-owned queue snapshot once');
assert.equal(replacedInteractionQueues[0].length, 1, 'removing one queue item must preserve remaining interactions');
setInteractionQueue([{
    inputId: 'uncertain-input-1', interactionId: 'uncertain-input-1', kind: 'follow-up',
    prompt: '可能已经发送的长任务', state: 'uncertain', error: '连接在 ACK 前后中断',
}]);
prompt.value = '刷新队列投影';
prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
host.querySelector('.agent-chat-send-button').click();
await new Promise((resolve) => setTimeout(resolve, 30));
const resendQueueButton = host.querySelector('.agent-chat-queue-edit[title="重新发送"]');
assert.ok(resendQueueButton, 'uncertain input must expose an explicit resend decision');
resendQueueButton.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(resolvedPendingInputs, [{
    sessionId: 'topic-in-use', inputId: 'uncertain-input-1', action: 'resend',
}], 'Workbench must route the user decision to the exact Session/input identity');
emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', sequence: 4,
    type: 'context.usage',
    payload: { source: 'real', inputTokens: 12, outputTokens: 8, cacheWriteTokens: 2,
        totalTokens: 20, usedTokens: 20, contextWindow: 100, requests: 1 },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const usageToggle = host.querySelector('.agent-chat-usage-toggle');
assert.ok(usageToggle, 'the header must expose Codex usage state');
assert.equal(usageToggle.querySelector('.agent-chat-context-ring-core')?.textContent, '20',
    'the header must expose an always-visible OpenCode-style context percentage indicator');
usageToggle.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelectorAll('.agent-chat-activity-tab-group').length, 0,
    'the remaining right-panel tabs must share one compact row');
assert.deepEqual([...host.querySelectorAll('.agent-chat-activity-tabs > .agent-chat-activity-tab')]
    .map((tab) => tab.dataset.tab), ['files', 'context'],
    'the compact Dock must initially expose only the file launcher and active Context tab');
assert.equal(host.querySelector('.agent-chat-activity-tab-group-label'), null,
    'the two tab rows must not spend visible space on redundant group headings');
assert.equal(host.querySelector('.agent-chat-activity-tab[data-tab="changes"]'), null,
    'the toolbox-only product must hide Changes until VCP file mutations have a reliable receipt');
assert.equal(host.querySelector('.agent-chat-activity-tab[data-tab="plan"]'), null,
    'the toolbox-only product must hide Plan until Codex collaboration mode is explicitly supported');
assert.equal(host.querySelector('.agent-chat-activity-tab[data-tab="connection"]'), null,
    'internal runtime diagnostics must not occupy a product-facing tab');
assert.match(host.querySelector('.agent-chat-activity-usage').textContent, /Tokens/,
    'usage panel must present the runtime-projected aggregate rather than a fake cost');
assert.match(host.querySelector('.agent-chat-activity-usage').textContent, /20/,
    'usage panel must display total tokens from the runtime event');
assert.equal(host.querySelector('.agent-chat-usage-budget'), null,
    'runtime budgets are settings and must not be mixed into the read-only Context inspector');
assert.match(host.querySelector('.agent-chat-context-stats')?.textContent || '', /模型.*消息/s,
    'the Context inspector must expose stable session metadata alongside token usage');
assert.match(host.querySelector('.agent-chat-usage-stats')?.textContent || '', /缓存写入.*2/s,
    'the Context inspector must retain cache write usage when the provider reports it');
const stableUsagePanel = host.querySelector('[data-activity-panel="context"]');
stableUsagePanel.scrollTop = 47;
host.querySelector('.agent-chat-activity-tab[data-tab="files"]').click();
host.querySelector('.agent-chat-activity-tab[data-tab="context"]').click();
assert.strictEqual(host.querySelector('[data-activity-panel="context"]'), stableUsagePanel,
    'switching right-panel tabs must retain the Context panel DOM identity');
assert.equal(stableUsagePanel.scrollTop, 47,
    'each right-panel tab must retain its own scroll position');

host.querySelector('.agent-chat-activity-tab[data-tab="files"]').click();
await new Promise((resolve) => setTimeout(resolve, 30));
const workspaceBrowser = host.querySelector('.agent-workspace-browser');
const workspaceSplitter = host.querySelector('.agent-workspace-splitter[role="separator"]');
assert.ok(workspaceBrowser && workspaceSplitter,
    'Workspace must render as a resizable preview/tree split view');
workspaceSplitter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
assert.ok(workspaceBrowser.classList.contains('agent-workspace-split-48'),
    'Workspace splitter keyboard controls must resize the preview pane without inline styles');
for (let index = 0; index < 21; index += 1) {
    workspaceSplitter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
}
assert.ok(workspaceBrowser.classList.contains('agent-workspace-split-100'),
    'moving the Workspace splitter to the far right must collapse the tree into a single preview column');
workspaceSplitter.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
assert.ok(workspaceBrowser.classList.contains('agent-workspace-split-88'),
    'moving left from the collapsed edge must restore the Workspace tree');
assert.deepEqual([...host.querySelectorAll('.agent-workspace-tree-row')].map((row) => row.dataset.workspacePath), ['src', 'README.md'],
    'Workspace tab must lazily render the selected Session root without exposing an arbitrary root input');
host.querySelector('.agent-workspace-tree-row[data-workspace-path="src"]').click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.ok(host.querySelector('.agent-workspace-tree-row[data-workspace-path="src/index.js"]'),
    'expanding a directory must load its children without rebuilding the Workbench shell');
host.querySelector('.agent-workspace-tree-row[data-workspace-path="README.md"]').click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.match(host.querySelector('.agent-workspace-preview-text')?.textContent || '', /preview/,
    'selecting a file must show the bounded Main-provided preview');
host.querySelector('.agent-workspace-tree-row[data-workspace-path="README.md"]')
    .dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 30));
const fileDockTab = [...host.querySelectorAll('.agent-chat-activity-tab')]
    .find((tab) => tab.title === 'README.md');
assert.ok(fileDockTab && fileDockTab.dataset.tab.startsWith('file:'),
    'double-clicking a Workspace file must promote it to a top-level Session Dock tab');
assert.equal(host.querySelector('.agent-workspace-preview-tabs'), null,
    'Workspace preview must not retain a nested duplicate tab strip');
host.querySelector('.agent-chat-activity-tab[data-tab="files"]').click();
const copyRelative = host.querySelector('.agent-workspace-path-actions button[aria-label="复制相对路径"]');
assert.ok(copyRelative, 'Workspace preview must expose the copy-relative-path action by accessible name');
copyRelative.click();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(workspaceActions.at(-1)?.action, 'copy-relative-path');
assert.equal(workspaceActions.at(-1)?.workspaceRevision, 'workspace-revision-test');
host.querySelector('.agent-chat-activity-tab[data-tab="context"]').click();

emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', sequence: 5, type: 'toolbox.ws',
    payload: {
        channel: 'Info', kind: 'notification',
        value: { message: 'ToolBox 只读通知 <img src=x>' },
    },
});
await new Promise((resolve) => setTimeout(resolve, 30));
host.querySelector('.agent-chat-activity-tab[data-tab="notifications"]')?.click();
await new Promise((resolve) => setTimeout(resolve, 0));
const toolboxObservation = host.querySelector('.agent-chat-toolbox-ws-card');
assert.ok(toolboxObservation, 'ToolBox WS observations must render in their own non-tool block');
assert.match(toolboxObservation.textContent, /服务通知/);
assert.match(toolboxObservation.textContent, /ToolBox 只读通知/);
assert.equal(toolboxObservation.querySelector('img'), null, 'ToolBox WS text must never be interpreted as renderer HTML');
const activityListBeforeFilter = host.querySelector('.agent-chat-activity-list');
assert.ok(activityListBeforeFilter, 'the notification cards need a dedicated scroller below the fixed filters');
activityListBeforeFilter.scrollTop = 33;
const activitySearch = host.querySelector('.agent-chat-activity-filters input[type="search"]');
activitySearch.value = 'ToolBox';
activitySearch.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(host.querySelector('.agent-chat-activity-list').scrollTop, 33,
    'filter rerenders must retain the notification-list scroll position without scrolling the toolbar');
host.querySelector('.agent-chat-activity-filters input[type="search"]').value = '';
host.querySelector('.agent-chat-activity-filters input[type="search"]')
    .dispatchEvent(new window.Event('input', { bubbles: true }));
emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', sequence: 6, type: 'toolbox.ws',
    payload: {
        channel: 'Log', kind: 'backend-approval-request',
        value: { type: 'tool_approval_request', data: { requestId: 'approve-1', toolName: 'PowerShellExecutor', approvalTtlMs: 300000 } },
    },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const backendApprovalObservation = host.querySelector('.agent-chat-toolbox-ws-backend-approval-request');
assert.ok(backendApprovalObservation, 'a ToolBox backend approval request needs its own status block');
assert.match(backendApprovalObservation.textContent, /后端审核请求（未关联）/);
assert.match(backendApprovalObservation.textContent, /PowerShellExecutor/);
const backendActions = backendApprovalObservation.querySelectorAll('.agent-chat-approval-actions button');
assert.equal(backendActions.length, 0,
    'unassociated VCPLog approval observations must remain read-only without an authority generation');
assert.equal(approvalResponses.length, 0,
    'a display-only ToolBox observation must never emit an approval response');
approvalResponses.length = 0;
emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', toolCallId: 'tool-risk', sequence: 7,
    type: 'approval.requested',
    payload: {
        approval: {
            approvalId: 'approval-risk', sessionId: 'topic-in-use', turnId: 'turn_test', toolCallId: 'tool-risk',
            toolName: 'PowerShellExecutorWithAnIntentionallyVeryLongIdentifierForNarrowLayouts',
            riskLevel: 'high', reason: '长参数必须在窄窗口安全折行',
            argumentSummary: 'a'.repeat(8_192), argumentsHash: 'bound-hash',
            expiresAtMs: Date.now() + 100,
        },
    },
});
await new Promise((resolve) => setTimeout(resolve, 30));
host.querySelector('.agent-chat-activity-tab[data-tab="approvals"]')?.click();
const localApproval = host.querySelector('.agent-chat-approval-card');
assert.ok(localApproval, 'local ToolBox preflight approval must render in a dedicated bounded card');
const localApprovalActions = localApproval.querySelector('.agent-chat-approval-actions');
assert.ok(localApprovalActions, 'a local approval card must always render its decision row');
assert.deepEqual([...localApprovalActions.querySelectorAll('button')].map((button) => button.textContent), ['拒绝', '允许一次'],
    'the real local deny and allow-once actions must be visible before verbose approval bindings');
assert.ok(localApprovalActions.compareDocumentPosition(localApproval.querySelector('.agent-chat-approval-binding')) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    'the decision row must appear before long approval binding data and remain reachable in a narrow panel');
assert.equal(localApproval.querySelector('.agent-chat-approval-args').textContent.length, 8_192,
    'approval parameters must remain text rather than being dropped or interpreted as HTML');
await new Promise((resolve) => setTimeout(resolve, 650));
assert.equal(approvalResponses.length, 0,
    'Renderer must not manufacture a deny when the Codex-owned deadline expires');
assert.match(localApproval.querySelector('.agent-chat-approval-countdown').textContent,
    /等待 Codex App Server/);

// A fresh approval with a real future deadline proves the visible actions use
// the complete Main-owned four-part binding; the renderer never invents an
// unbound approval decision.
emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', toolCallId: 'tool-action', sequence: 8,
    type: 'approval.requested',
    payload: { approval: {
        approvalId: 'approval-action', sessionId: 'topic-in-use', turnId: 'turn_test', toolCallId: 'tool-action',
        toolName: 'FileOperator', riskLevel: 'medium', argumentsHash: 'bound-action-hash',
        expiresAtMs: Date.now() + 60_000,
    } },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const actionableApproval = [...host.querySelectorAll('.agent-chat-approval-card')]
    .find((card) => card.textContent.includes('FileOperator'));
assert.ok(actionableApproval, 'a new pending local approval must be rendered after a previous timeout');
actionableApproval.querySelector('.agent-chat-approval-actions button.danger').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(approvalResponses.at(-1), {
    approvalId: 'approval-action', decision: 'deny', sessionId: 'topic-in-use', turnId: 'turn_test',
    toolCallId: 'tool-action', argumentsHash: 'bound-action-hash',
}, 'the visible deny button must invoke the narrow approval IPC with its exact Codex binding');

emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', sequence: 9, type: 'interaction.requested',
    payload: {
        source: 'codex-native', requestId: 'input-request-1', kind: 'user-input', state: 'pending',
        expiresAtMs: Date.now() + 60_000,
        payload: { questions: [{ id: 'choice', header: '选择', question: '请选择一个选项', isOther: true,
            options: [{ label: 'Alpha', description: '第一个选项' }, { label: 'Beta', description: '第二个选项' }] },
        { id: 'secret', header: '秘密', question: '输入一次性秘密', isSecret: true }] },
    },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const interactionCard = host.querySelector('[data-interaction-id="input-request-1"]');
assert.ok(interactionCard, 'Codex requestUserInput must render as an actionable Interaction Center form');
const otherAnswer = interactionCard.querySelector('[name="other:choice"]');
otherAnswer.value = '自定义回答';
const secretAnswer = interactionCard.querySelector('[name="other:secret"]');
assert.equal(secretAnswer?.type, 'password', 'secret user-input questions must use password controls');
secretAnswer.value = 'never-persist-this-secret';
emitDaemonEvent({
    sessionId: 'runtime', sequence: 10, type: 'toolbox.ws',
    payload: { channel: 'Info', kind: 'notification', value: { message: 'unrelated refresh' } },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('[data-interaction-id="input-request-1"]'), interactionCard,
    'unrelated Activity traffic must retain the same pending interaction DOM node');
assert.equal(otherAnswer.value, '自定义回答', 'Activity updates must not erase an in-progress user answer');
interactionCard.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(interactionResponses.at(-1), {
    source: 'codex-native', requestId: 'input-request-1', kind: 'user-input',
    response: { answers: { choice: { answers: ['自定义回答'] }, secret: { answers: ['never-persist-this-secret'] } } },
});
assert.doesNotMatch(JSON.stringify({ ...window.localStorage }), /never-persist-this-secret/,
    'secret interaction answers must never be written to localStorage');

emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', sequence: 10, type: 'interaction.requested',
    payload: { source: 'codex-native', requestId: 'permission-request-1', kind: 'permission', state: 'pending',
        payload: { cwd: root, permissions: { network: { enabled: true }, fileSystem: { read: [root], write: [] } } } },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const permissionCard = host.querySelector('[data-interaction-id="permission-request-1"]');
assert.match(permissionCard?.textContent || '', /工作目录.*按请求授权/s,
    'Codex permission requests must expose their bounded request and explicit decision controls');
permissionCard.querySelector('select').value = 'session';
[...permissionCard.querySelectorAll('button')].find((item) => item.textContent === '按请求授权').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(interactionResponses.at(-1), {
    source: 'codex-native', requestId: 'permission-request-1', kind: 'permission',
    response: { decision: 'accept', scope: 'session' },
});

emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', sequence: 11, type: 'interaction.requested',
    payload: { source: 'codex-native', requestId: 'mcp-form-1', kind: 'mcp-elicitation', state: 'pending',
        payload: { mode: 'form', requestedSchema: { type: 'object', required: ['name'], properties: {
            name: { type: 'string', title: '名称' }, enabled: { type: 'boolean', title: '启用' },
        } } } },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const mcpFormCard = host.querySelector('[data-interaction-id="mcp-form-1"]');
mcpFormCard.querySelector('[name="name"]').value = 'fixture';
mcpFormCard.querySelector('[name="enabled"]').checked = true;
mcpFormCard.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(interactionResponses.at(-1), {
    source: 'codex-native', requestId: 'mcp-form-1', kind: 'mcp-elicitation',
    response: { action: 'accept', content: { name: 'fixture', enabled: true } },
}, 'typed MCP elicitation must submit only the rendered structured fields');

emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', sequence: 12, type: 'interaction.requested',
    payload: { source: 'codex-native', requestId: 'mcp-url-1', kind: 'mcp-elicitation', state: 'pending',
        payload: { mode: 'url', url: 'https://example.com/authorize' } },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const mcpUrlCard = host.querySelector('[data-interaction-id="mcp-url-1"]');
const responseCountBeforeOpen = interactionResponses.length;
[...mcpUrlCard.querySelectorAll('button')].find((item) => item.textContent === '在系统浏览器打开').click();
assert.deepEqual(openedExternalLinks, ['https://example.com/authorize']);
assert.equal(interactionResponses.length, responseCountBeforeOpen,
    'opening an MCP URL must remain separate from accepting the elicitation');
mcpUrlCard.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(interactionResponses.at(-1), {
    source: 'codex-native', requestId: 'mcp-url-1', kind: 'mcp-elicitation',
    response: { action: 'accept', content: {} },
});

host.querySelector('.agent-chat-activity-tab[data-tab="notifications"]')?.click();
host.querySelector('.agent-chat-activity-tab[data-tab="approvals"]')?.click();
emitDaemonEvent({
    sessionId: 'runtime', sequence: 13, type: 'toolbox.ws',
    payload: { channel: 'Info', kind: 'notification', value: { message: 'one unread activity item' } },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.match(host.querySelector('.agent-chat-activity-tab[data-tab="notifications"]')?.textContent || '', /通知1/,
    'background Activity updates must increment only their own tab unread count');
assert.doesNotMatch(host.querySelector('.agent-chat-activity-tab[data-tab="approvals"]')?.textContent || '', /·/,
    'the currently visible Activity tab must not accumulate unread state');
host.querySelector('.agent-chat-activity-tab[data-tab="notifications"]')?.click();
assert.doesNotMatch(host.querySelector('.agent-chat-activity-tab[data-tab="notifications"]')?.textContent || '', /1/,
    'entering a tab must acknowledge only that tab unread count');

setRuntimeStatus('ready');
emitDaemonEvent({
    sessionId: 'runtime', type: 'runtime.state_changed', payload: { state: 'ready' },
});
emitDaemonEvent({
    sessionId: 'runtime', type: 'runtime.readiness', payload: {
        server: { state: 'configured', detail: '共享 VCPChat 设置已加载' },
        profile: { state: 'ready', detail: 'Nova · gpt-5.6-terra' },
        toolbox: { state: 'ready', detail: 'VCPToolBox 受认证探测成功' },
        capability: { state: 'unknown', detail: '等待 VCPLog 节点事件' },
    },
});
emitProjectionBlock({
    turnId: 'turn_live', messageId: 'msg_live', itemId: 'assistant-live-item', kind: 'message',
    sourceOrder: 20, status: 'inProgress', content: { text: 'live Codex delta' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('.agent-wb-runtime-dock'), null, 'Runtime lifecycle controls must stay out of the Agent UI');
assert.ok([...host.querySelectorAll('.message-item .md-content')].some((node) => node.textContent.includes('live Codex delta')), 'Runtime delta must render in the migrated chat shell');
assert.equal(host.querySelector('.agent-chat-status-chip')?.dataset.action, undefined,
    'the header runtime status must remain informative without opening a hidden diagnostics surface');
assert.equal(host.querySelectorAll('.agent-chat-readiness-card').length, 0,
    'internal readiness details must not render after the Diagnostics tab is hidden');

// Streaming is the hot path. A replacement Block Patch must update the existing message
// in place rather than replace the feed, composer or focused draft.
const liveMessage = host.querySelector('[data-message-id="block:topic-in-use:assistant-live-item:0"]');
assert.ok(liveMessage, 'the Main-authored assistant Block must own the visible message identity');
const stableComposer = host.querySelector('.agent-chat-message-input');
assert.equal(stableComposer.disabled, false,
    `the active Session composer must remain focusable before a streaming delta (placeholder: ${stableComposer.placeholder})`);
stableComposer.value = '保持中的草稿';
stableComposer.dispatchEvent(new window.Event('input', { bubbles: true }));
stableComposer.focus();
emitProjectionBlock({
    turnId: 'turn_live', messageId: 'msg_live', itemId: 'assistant-live-item', kind: 'message',
    sourceOrder: 20, status: 'inProgress', content: { text: 'live Codex delta and another delta' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('[data-message-id="block:topic-in-use:assistant-live-item:0"]'), liveMessage,
    'streaming Block Patches must retain the existing assistant DOM node');
assert.equal(host.querySelector('.agent-chat-message-input'), stableComposer,
    'streaming Block Patches must not replace the composer node');
assert.equal(document.activeElement, stableComposer,
    'streaming Block Patches must preserve focused input');
assert.equal(stableComposer.value, '保持中的草稿',
    'streaming Block Patches must preserve the user draft');
assert.match(liveMessage.querySelector('.md-content').textContent, /live Codex delta and another delta/,
    'streaming Block Patches must preserve the complete Main-authored assistant text');

emitProjectionBlock({
    turnId: 'turn_live', messageId: 'msg_reason_live', itemId: 'reason-live-item', kind: 'reasoning',
    sourceOrder: 19, status: 'inProgress',
    content: { summary: ['Inspecting the VCPToolBox environment before choosing the next safe action.'], content: [] },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const reasoningMessage = host.querySelector('[data-message-id="msg_reason_live"]');
const reasoningCard = reasoningMessage?.querySelector('.agent-chat-reasoning-block');
assert.ok(reasoningCard, 'reasoning Blocks must render the dedicated compact thinking card');
assert.equal(liveMessage.querySelector('.md-content').hidden, false,
    'assistant text must keep its standard bubble beside the separate Codex reasoning Item');
assert.match(reasoningCard.querySelector('.vcp-thought-chain-label').textContent, /思考中.*s/,
    'a streaming thought card must show a Cherry-style thinking status and live duration');
assert.equal(reasoningCard.querySelector('.vcp-thought-chain-icon').textContent, 'lightbulb',
    'the Agent Workbench thinking card must use the compact lightbulb treatment rather than a decorative brain emoji');
assert.equal(reasoningCard.querySelector('.vcp-thought-chain-icon').dataset.vcpIcon, 'lightbulb',
    'the reasoning icon must declare its Lucide identity before post-render processing');
assert.ok(reasoningCard.querySelector('.vcp-thought-chain-icon').classList.contains('vcp-ui-icon'),
    'the reasoning icon must enter the shared Lucide observer contract when it is created');
assert.equal(reasoningCard.querySelectorAll('.vcp-result-toggle-icon').length, 1,
    'a reasoning card must render exactly one disclosure control');
const workbenchCss = readCssWithImports(path.join(root, 'styles', 'ui-system', 'agent-workbench.css'));
assert.match(workbenchCss,
    /:is\(\.agent-chat-reasoning-block, \.agent-chat-tool-group\) \.vcp-result-toggle-icon::after\s*\{[^}]*content:\s*none;[^}]*display:\s*none;/s,
    'reasoning and folded tools must share one rule that removes the inherited second toggle stroke');
assert.match(workbenchCss,
    /agent-chat-reasoning-block \.vcp-thought-chain-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;/s,
    'the Lucide lightbulb must remain compact rather than filling the reasoning header');
assert.match(workbenchCss,
    /:is\(\.agent-chat-reasoning-block, \.agent-chat-tool-group\) \.vcp-result-toggle-icon::before\s*\{[^}]*width:\s*7px;[^}]*height:\s*7px;[^}]*border-right:/s,
    'reasoning and folded tools must consume the same centered geometric arrow rather than a font glyph');
assert.match(workbenchCss,
    /agent-chat-tool-activity\.vcp-tool-call-summary-bubble\s*\{[^}]*width:\s*min\(680px,[^}]*margin:[^}]*var\(--vcp-ui-message-avatar\)/s,
    'tool cards must share the reasoning-card width and align to the assistant content column');
assert.match(workbenchCss,
    /agent-chat-run-status\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s,
    'the explicit Turn status rail must remain vertically aligned above the composer');
assert.match(workbenchCss,
    /agent-chat-session-avatar\.is-running::before[\s\S]*conic-gradient[\s\S]*agent-chat-session-runtime-ring/,
    'running Session identity must be expressed by the animated avatar ring');
assert.match(workbenchCss,
    /prefers-reduced-motion:\s*reduce[\s\S]*agent-chat-session-avatar\.is-running::before[\s\S]*animation:\s*none/,
    'the running avatar ring must respect reduced-motion preferences');
reasoningCard.querySelector('.vcp-thought-chain-header').click();
assert.equal(reasoningCard.querySelector('.vcp-thought-chain-bubble').classList.contains('expanded'), false,
    'the fallback thinking header must remain explicitly collapsible');
reasoningCard.querySelector('.vcp-thought-chain-header').click();
emitProjectionBlock({
    method: 'item/completed', turnId: 'turn_live', messageId: 'msg_reason_live', itemId: 'reason-live-item',
    kind: 'reasoning', sourceOrder: 19, status: 'completed',
    content: { summary: ['Inspecting the VCPToolBox environment before choosing the next safe action.'], content: [] },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const completedReasoningMessage = host.querySelector('[data-message-id="msg_reason_live"]');
assert.match(completedReasoningMessage.querySelector('.agent-chat-reasoning-block .vcp-thought-chain-label').textContent, /已深度思考.*s/,
    'a completed thought card must collapse to a concise duration summary');
assert.equal(completedReasoningMessage.querySelector('.agent-chat-reasoning-copy'), null,
    'completed reasoning must not render a duplicate copy action');

emitProjectionBlock({
    method: 'item/completed', activity: 'idle', turnId: 'turn_projected',
    messageId: 'msg_reason_projected', itemId: 'reason_projected', kind: 'reasoning', sourceOrder: 21,
    status: 'completed', content: { summary: ['reasoning delivered through the real projection.updated path'], content: [] },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const projectedReasoning = host.querySelector('[data-message-id="msg_reason_projected"] .agent-chat-reasoning-block');
assert.ok(projectedReasoning,
    'the current Codex projection.updated event path must render reasoning without a synthetic reasoning.delta event');
assert.match(projectedReasoning.textContent, /real projection\.updated path/);
assert.equal(projectedReasoning.closest('.message-item')?.querySelector('.md-content')?.hidden, true,
    'projection reasoning without assistant text must not leave a visible empty bubble');

// OpenCode's timeline model is the relevant interaction reference: a single
// turn can include assistant text, a tool call, then more assistant text.  The
// Workbench must preserve Main's sequence order instead of batching all
// tools beside the first user message for that turn.
emitProjectionBlock({
    turnId: 'turn-order', messageId: 'msg-order-before', itemId: 'order-before-item', kind: 'message',
    sourceOrder: 30, status: 'inProgress', content: { text: 'before tool' },
});
emitProjectionBlock({
    turnId: 'turn-order', messageId: 'msg-tool-order', itemId: 'tool-order', kind: 'tool',
    sourceOrder: 31, status: 'inProgress', content: {
        toolName: 'vcp_invoke', argumentSummary: 'FileOperator.ReadFile package.json',
        item: { type: 'dynamicToolCall', tool: 'vcp_invoke' },
    },
});
emitProjectionBlock({
    turnId: 'turn-order', messageId: 'msg-order-after', itemId: 'order-after-item', kind: 'message',
    sourceOrder: 32, status: 'inProgress', content: { text: 'after tool' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const sequenceParts = [...host.querySelector('.agent-chat-messages').children];
const beforeIndex = sequenceParts.findIndex((element) => element.dataset.messageId === 'block:topic-in-use:order-before-item:0');
const toolIndex = sequenceParts.findIndex((element) => element.dataset.toolCallId === 'tool-order');
const afterIndex = sequenceParts.findIndex((element) => element.dataset.messageId === 'block:topic-in-use:order-after-item:0');
assert.ok(beforeIndex >= 0 && beforeIndex < toolIndex && toolIndex < afterIndex,
    'message → tool → message must retain runtime sequence order in the visible timeline');
const requestedToolCard = host.querySelector('[data-tool-call-id="tool-order"]');
emitProjectionBlock({
    method: 'item/completed', turnId: 'turn-order', messageId: 'msg-tool-order', itemId: 'tool-order',
    kind: 'tool', sourceOrder: 31, status: 'completed', content: {
        toolName: 'vcp_invoke',
        outputSummary: 'FileOperator 已返回 package.json',
        result: 'x'.repeat(1_024),
        resources: [{ type: 'file', name: 'package.json', url: 'file-ref:package.json' }],
        warnings: ['只读预览'],
        task: { status: 'accepted', id: 'task-1' },
        item: { type: 'dynamicToolCall', tool: 'vcp_invoke' },
    },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const completedToolCard = host.querySelector('[data-tool-call-id="tool-order"]');
assert.strictEqual(completedToolCard, requestedToolCard,
    'a terminal ToolBox update must patch its Codex callId row instead of rebuilding the feed');
assert.ok(completedToolCard?.querySelector('.agent-chat-tool-chevron'),
    'a terminal tool with a result must expose an explicit detail control');
assert.equal(completedToolCard.querySelector('.agent-chat-tool-detail'), null,
    'collapsed long results must not eagerly mount Markdown/detail DOM for every completed tool');
completedToolCard.querySelector('.agent-chat-tool-chevron').click();
assert.ok(completedToolCard.querySelector('.agent-chat-tool-detail-result'),
    'opening a completed tool must mount its preserved runtime result on demand');
assert.equal(completedToolCard.querySelector('.agent-chat-tool-detail-result').textContent.length, 1_024);
assert.match(completedToolCard.querySelector('.agent-chat-tool-resource-list').textContent, /package\.json/);
assert.match(completedToolCard.querySelector('.agent-chat-tool-warning-list').textContent, /只读预览/);
assert.match(completedToolCard.querySelector('.agent-chat-tool-task').textContent, /task-1/);

emitProjectionBlock({
    turnId: 'turn-tool-group', messageId: 'msg-tool-group-a', itemId: 'tool-group-a', kind: 'tool',
    sourceOrder: 40, status: 'inProgress', content: {
        toolName: 'FileOperator', argumentSummary: 'ReadFile README.md',
        item: { type: 'dynamicToolCall', tool: 'FileOperator' },
    },
});
emitProjectionBlock({
    turnId: 'turn-tool-group', messageId: 'msg-tool-group-b', itemId: 'tool-group-b', kind: 'tool',
    sourceOrder: 41, status: 'inProgress', content: {
        toolName: 'DeepWikiVCP', argumentSummary: 'Inspect repository',
        item: { type: 'dynamicToolCall', tool: 'DeepWikiVCP' },
    },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const groupedTools = host.querySelector('.agent-chat-tool-group[data-turn-id="turn-tool-group"]');
assert.ok(groupedTools, 'adjacent tools from one identified Turn must render as one compact group');
assert.equal(groupedTools.querySelectorAll('.agent-chat-tool-group-item').length, 2,
    'the group must retain both real toolCallId child cards');
assert.equal(groupedTools.querySelector('.agent-chat-tool-group-body').hidden, true,
    'a multi-tool group must default collapsed');
groupedTools.querySelector('.agent-chat-tool-group-toggle').click();
assert.equal(groupedTools.querySelector('.agent-chat-tool-group-body').hidden, false,
    'the group header must reveal the preserved structured tool cards');
const groupedFirstCard = groupedTools.querySelector('[data-tool-call-id="tool-group-a"]');
emitProjectionBlock({
    method: 'item/completed', turnId: 'turn-tool-group', messageId: 'msg-tool-group-a', itemId: 'tool-group-a',
    kind: 'tool', sourceOrder: 40, status: 'completed', content: {
        toolName: 'FileOperator', outputSummary: 'README.md loaded',
        item: { type: 'dynamicToolCall', tool: 'FileOperator' },
    },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.strictEqual(groupedTools.querySelector('[data-tool-call-id="tool-group-a"]'), groupedFirstCard,
    'a grouped tool status update must patch the child card in place');
assert.equal(groupedTools.querySelector('.agent-chat-tool-group-body').hidden, false,
    'patching a child tool must preserve the group expansion state');

// Let the final normalized tool Patch settle before the following scroll-anchor
// regression probe installs its synthetic geometry.
await new Promise((resolve) => setTimeout(resolve, 50));

// Run this after the preceding streaming frame has settled. A full rerender
// from a ToolBox status event must not force a reader who is inspecting older
// output back to the live bottom edge.
const scrollContainer = host.querySelector('.agent-chat-messages-container');
Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 120 });
Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 1_000 });
scrollContainer.scrollTop = 320;
emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', sequence: 8, type: 'toolbox.ws',
    payload: { channel: 'Log', kind: 'log', value: { message: 'older-reading-scroll-anchor' } },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(scrollContainer.scrollTop, 320,
    'a reader who scrolled up must retain their anchor when a ToolBox status block causes a full feed render');

// VCPInfo stays outside the conversation/Topic.  The Workbench may make the
// well-known observer shapes compact and readable, but the renderer must not
// reclassify them as tool calls or model messages.
for (const [sequence, kind, value] of [
    [9, 'rag', { type: 'RAG_RETRIEVAL_DETAILS', dbName: '项目笔记', query: '上次发布进度', results: [{ id: 1 }, { id: 2 }] }],
    [10, 'memory', { type: 'AI_MEMO_RETRIEVAL', dbNames: ['日记 A', '日记 B'], fileCount: 4, query: '用户偏好', extractedMemories: '偏好简洁答复' }],
    [11, 'agent-preview', { type: 'AGENT_PRIVATE_CHAT_PREVIEW', agentName: 'Nova', query: '检查状态', response: '状态正常' }],
    [12, 'diary', { type: 'DailyNote', title: '日记已保存', dbName: '日记 A' }],
    [13, 'dream', { type: 'AGENT_DREAM_FINISHED', status: '已完成', agentName: 'Nova' }],
]) {
    emitDaemonEvent({
        sessionId: 'topic-in-use', turnId: 'turn_test', sequence, type: 'toolbox.ws',
        payload: { channel: 'Info', kind, value },
    });
}
await new Promise((resolve) => setTimeout(resolve, 30));
host.querySelector('.agent-chat-activity-tab[data-tab="notifications"]')?.click();
assert.match(host.querySelector('.agent-chat-activity-note')?.textContent || '', /仅保留本次运行/,
    'global VCPLog and VCPInfo observations must be labelled as ephemeral rather than durable Session history');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.match(host.querySelector('.agent-chat-toolbox-ws-rag .agent-chat-toolbox-ws-detail').textContent, /项目笔记[\s\S]*2 条命中/,
    'RAG VCPInfo must be compactly projected instead of exposing raw JSON as the primary card text');
assert.match(host.querySelector('.agent-chat-toolbox-ws-memory .agent-chat-toolbox-ws-detail').textContent, /日记 A、日记 B[\s\S]*4 个来源[\s\S]*偏好简洁答复/,
    'memory VCPInfo must retain only its readable source/count/summary projection');
assert.match(host.querySelector('.agent-chat-toolbox-ws-agent-preview .agent-chat-toolbox-ws-detail').textContent, /Nova 的私聊预览[\s\S]*检查状态[\s\S]*状态正常/,
    'private Agent previews must remain observer blocks, not transcript messages');
assert.match(host.querySelector('.agent-chat-toolbox-ws-diary .agent-chat-toolbox-ws-detail').textContent, /日记已保存.*日记 A/);
assert.match(host.querySelector('.agent-chat-toolbox-ws-dream .agent-chat-toolbox-ws-detail').textContent, /已完成.*Nova/);
emitDaemonEvent({
    sessionId: 'topic-in-use', turnId: 'turn_test', messageId: 'assistant-marker', sequence: 14,
    type: 'marker.observed',
    payload: { kind: 'dynamic-fold', summary: '动态上下文摘要', detail: '这段正文只应在用户主动展开时出现。' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const markerCard = host.querySelector('.agent-chat-marker-dynamic-fold');
assert.ok(markerCard, 'Core-filtered VCP markers need a dedicated display-only Activity card');
assert.match(markerCard.querySelector('.agent-chat-toolbox-ws-detail').textContent, /动态上下文摘要/);
assert.equal(markerCard.querySelector('.agent-chat-toolbox-ws-output').hidden, true,
    'marker detail must stay collapsed until an explicit user action');
assert.equal(host.querySelector('[data-message-id="assistant-marker"]'), null,
    'marker observations must never become a conversation message');

// A new transcript Part while reading older output must not steal the anchor,
// but must give the reader an explicit route back to the live edge.
emitProjectionBlock({
    turnId: 'turn-order', messageId: 'msg-reader-new', itemId: 'reader-new-item', kind: 'message',
    sourceOrder: 50, status: 'inProgress', content: { text: 'new live timeline item' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const jumpToLatest = host.querySelector('.agent-chat-jump-to-latest');
assert.ok(jumpToLatest && !jumpToLatest.hidden,
    'new live timeline activity while the reader is away from the bottom must expose a return-to-latest action');
assert.match(jumpToLatest.textContent, /回到最新/);
jumpToLatest.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(jumpToLatest.hidden, true, 'return-to-latest must clear the local unread indicator');
assert.equal(scrollContainer.scrollTop, scrollContainer.scrollHeight,
    'return-to-latest must intentionally move the reader to the live bottom edge');

emitDaemonEvent({
    sessionId: 'topic-in-use', type: 'runtime.crashed',
    payload: { error: 'simulated App Server crash', recoverable: true },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const reconnect = host.querySelector('.agent-chat-status-chip[data-state="error"]');
assert.equal(reconnect?.getAttribute('role'), 'button',
    'a App Server crash must turn the compact header status into an explicit reconnect action');
assert.equal(host.querySelector('.agent-chat-activity-connection'), null,
    'runtime failure must not reopen the hidden Diagnostics surface');
const sessionsBeforeRecovery = createdSessions.length;
reconnect.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(runtimeTransitions.slice(-2), ['stop', 'start'], 'recovery must restart the Main-supervised App Server boundary');
assert.equal(createdSessions.length, sessionsBeforeRecovery,
    'recovery must restore the SQLite projection without silently resuming a Session Runtime or replaying a Turn');

const restoredTopicRow = [...host.querySelectorAll('.agent-chat-session-row')]
    .find((row) => row.dataset.sessionId === 'topic-archived');
assert.ok(restoredTopicRow, 'durable Topic row must retain its Topic identifier');
const topicSidebar = host.querySelector('.agent-chat-sidebar');
topicSidebar.scrollTop = 73;
const sessionsBeforeTopicPreview = createdSessions.length;
restoredTopicRow.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('.agent-chat-topic-flow-dialog'), null,
    'clicking an idle Topic row must not show a blocking restore dialog');
assert.equal(createdSessions.length, sessionsBeforeTopicPreview,
    'clicking a durable Session must preview SQLite persistence without starting its Runtime');
assert.strictEqual(host.querySelector('.agent-chat-session-row[data-session-id="topic-archived"]'), restoredTopicRow,
    'preview selection must patch the existing sidebar row instead of rebuilding the session list');
assert.equal(topicSidebar.scrollTop, 73,
    'preview selection must preserve the conversation-list scroll position');

const settingsTab = [...host.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
    .find((tab) => tab.textContent.trim() === '设置');
settingsTab.click();
assert.ok(host.querySelector('.agent-chat-settings-pane .agent-chat-settings-form'),
    'settings must render inside a dedicated padded pane instead of placing fields against the sidebar edge');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual([...host.querySelectorAll('.agent-settings-section-title')].map((title) => title.textContent),
    ['基础信息', '模型设置', '系统提示词'],
    'settings must use the same collapsed identity, model, and prompt sections as main chat');
const settingsScopes = [...host.querySelectorAll('.agent-chat-settings-scope')];
assert.deepEqual(settingsScopes.map((scope) => scope.textContent.trim()), ['Agent 默认', '当前会话', '高级'],
    'Build settings must expose explicit Profile, current Session, and advanced ownership scopes');
assert.equal(settingsScopes.find((scope) => scope.textContent.trim() === 'Agent 默认')?.getAttribute('aria-selected'), 'true',
    'opening settings must default to Agent Profile ownership rather than silently mutating a Session');
const openSettingsSection = (key) => {
    const section = host.querySelector(`.agent-settings-section[data-section-key="${key}"]`);
    assert.ok(section, `settings must contain the ${key} section`);
    if (section.classList.contains('collapsed')) section.querySelector('.agent-settings-section-header').click();
    return section;
};
openSettingsSection('identity');
const avatarSettings = host.querySelector('.agent-identity-main');
assert.ok(avatarSettings, 'Agent settings must expose the shared main-chat identity layout');
assert.match(avatarSettings.querySelector('.agent-avatar-display')?.src || '', /nova-avatar\.png/,
    'avatar preview must use the selected Agent catalog avatar');
assert.ok(avatarSettings.querySelector('.agent-avatar-wrapper .avatar-upload-overlay'),
    'Build Agent settings must use the shared main-chat avatar picker and camera overlay');
assert.equal([...avatarSettings.querySelectorAll('button')].some((item) => item.textContent.includes('选择头像')), false,
    'the legacy standalone avatar upload button must be removed');
const avatarInput = avatarSettings.querySelector('input[type="file"]');
const avatarBytes = new Uint8Array([1, 2, 3]).buffer;
const avatarFile = { name: 'nova.png', type: 'image/png', arrayBuffer: async () => avatarBytes };
Object.defineProperty(avatarInput, 'files', { configurable: true, value: [avatarFile] });
avatarInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(savedAvatars.length, 1, 'selecting an avatar must save through the Build Agent profile IPC');
assert.equal(savedAvatars[0].agentId, 'Nova', 'avatar save must target the selected Agent identity');
assert.equal(savedAvatars[0].avatarData.name, 'nova.png');
assert.equal(savedAvatars[0].avatarData.type, 'image/png');
assert.ok(savedAvatars[0].avatarData.buffer instanceof ArrayBuffer,
    'avatar save must pass binary data without persisting Base64 in renderer state');
openSettingsSection('model');
assert.ok(host.querySelector('.agent-chat-settings-pane .agent-chat-setting-field select'),
    'the expanded model section must expose its model and approval controls');
openSettingsSection('prompt');
const promptEditor = host.querySelector('.agent-chat-settings-pane textarea:not([readonly])');
assert.equal(promptEditor?.value, '{{Nova}}',
    'the prompt section must expose the selected Agent instructions without reintroducing a settings sub-tab');

dispose();
assert.equal(unsubscribeCalls, 1, 'Workbench unmount must release runtime event subscription');
assert.deepEqual(presenceCalls, [true, false]);
assert.equal(host.childElementCount, 0);

window.localStorage.setItem('vcpchat.agentWorkbench.lastTopic.v1', JSON.stringify({ sessionId: 'topic-missing-session' }));
const missingSessionDispose = registeredApp.mount(host, {});
for (let attempt = 0; attempt < 100
    && window.localStorage.getItem('vcpchat.agentWorkbench.lastTopic.v1') !== null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(host.classList.contains('agent-workbench-root') && host.querySelector('.agent-chat-root.container'),
    'a deleted remembered Session must leave the Workbench usable instead of failing startup');
assert.equal(window.localStorage.getItem('vcpchat.agentWorkbench.lastTopic.v1'), null,
    'a missing Session must clear only the renderer convenience pointer');
assert.equal([...host.querySelectorAll('.agent-chat-toast, .vcp-ui-toast')]
    .some((toast) => /Agent 页面初始化失败|Session was not found/.test(toast.textContent || '')), false,
    'a missing remembered Session must not surface as a page initialization error');
assert.equal(host.querySelector('.agent-chat-toolbox-ws-backend-approval-request'), null,
    'global VCPLog/VCPInfo observations from the previous Workbench lifetime must not reappear as Session history');
missingSessionDispose();
assert.equal(unsubscribeCalls, 2, 'missing Session recovery mount must also release its runtime subscription');
assert.deepEqual(presenceCalls, [true, false, true, false]);
assert.equal(host.childElementCount, 0);

console.log('Agent Workbench mount, event rendering, and unmount cleanup tests passed.');
// JSDOM retains animation/timer handles after the internal app unmounts.
// Close the synthetic window so this hermetic test can participate in the
// chained Codex-stack gate instead of silently blocking later checks.
window.close();
process.exit(0);
