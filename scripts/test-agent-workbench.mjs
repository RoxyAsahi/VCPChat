import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;
globalThis.Node = dom.window.Node;
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;

let registered = null;
let unsubscribeCalls = 0;
let eventCallback = null;
let runtimeStatus = 'stopped';
const presenceCalls = [];
const startedTurns = [];
const importedAttachment = {
    id: 'attachment_test_image', displayName: '设计图.png', kind: 'image', mimeType: 'image/png',
    byteLen: 314, width: 16, height: 16, sha256: 'a'.repeat(64), assetFile: 'a'.repeat(64) + '.png',
};
const importedVideoAttachment = {
    id: 'attachment_test_video', displayName: '演示.mp4', kind: 'video', mimeType: 'video/mp4',
    byteLen: 4_096, sha256: 'b'.repeat(64), assetFile: 'b'.repeat(64) + '.mp4',
};
let selectedAttachments = [importedAttachment];
const followUpTurns = [];
const steeringTurns = [];
let interactionQueue = [];
const replacedInteractionQueues = [];
const createdSessions = [];
const renamedTopics = [];
const compactedSessions = [];
const approvalResponses = [];
const savedWorkbenchSettings = [];
const runtimeTransitions = [];
const takeoverRequests = [];
let mainCreateProxyCalls = 0;
let sharedCreateActionCalls = 0;
let topicCatalog = [{
    id: 'topic-restored', title: '可恢复的 Rust Topic', agentId: 'Nova',
    model: 'gpt-5.6-terra', workspaceRef: root, inUse: false,
}, {
    id: 'topic-archived', title: '另一条持久 Topic', agentId: 'Nova',
    model: 'gpt-5.6-terra', workspaceRef: root, inUse: false,
}, {
    id: 'topic-in-use', title: '协作接管 Topic', agentId: 'Nova',
    model: 'gpt-5.6-terra', workspaceRef: root, inUse: true,
}];
const secondaryTopicCatalog = [{
        id: 'topic-agent-123', title: '123 的既有 Topic', agentId: '123',
        model: 'gpt-5.6-terra', workspaceRef: root, inUse: false,
    }];
const topicListRequests = [];
const topicSearchRequests = [];
window.nextUiApps = {
    register(definition) { registered = definition; return definition; },
    get() { return null; },
    list() { return []; },
};
window.chatAPI = {
    getAgents: async () => [
        { id: 'Nova', name: 'Nova', config: { model: 'gpt-5.6-terra', systemPrompt: '{{Nova}}' } },
        { id: '123', name: '123', config: { model: 'gpt-5.6-terra' } },
    ],
    // Match the main-chat contract: this is a Main-process cache, not an
    // Agent Workbench request to the ToolBox model endpoint.
    getCachedModels: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return [{ id: 'gpt-5.6-terra' }];
    },
    agentRuntimeGetStatus: async () => ({ state: runtimeStatus, worker: null, pendingApprovals: [] }),
    agentRuntimeStart: async () => { runtimeStatus = 'ready'; runtimeTransitions.push('start'); return { state: 'ready' }; },
    agentRuntimeStop: async () => { runtimeStatus = 'stopped'; runtimeTransitions.push('stop'); return { state: 'stopped' }; },
    agentRuntimeCreateSession: async (payload) => {
        createdSessions.push(payload);
        const session = {
            sessionId: 'sess_test', topicId: payload.resume || 'topic-new',
            title: payload.title || '可恢复的 Rust Topic', state: 'created',
            model: payload.model || 'gpt-5.6-terra', agentId: payload.agent || 'Nova',
        };
        return session;
    },
    agentRuntimeCompactSession: async ({ sessionId }) => { compactedSessions.push(sessionId); return { ok: true }; },
    agentRuntimeReadTopic: async ({ topicId }) => ({
        topicId,
        readOnly: true,
        history: [{ messageId: 'msg_saved', turnId: 'turn_saved', role: 'assistant', content: 'restored answer', timestamp: 1 }],
    }),
    agentRuntimeSelectAttachments: async () => ({ attachments: selectedAttachments }),
    agentRuntimeStartTurn: async (payload) => {
        startedTurns.push(payload);
        return { turnId: startedTurns.length === 1 ? 'attachment_turn' : 'turn_test', state: 'running' };
    },
    agentRuntimeFollowUpTurn: async (payload) => {
        followUpTurns.push(payload);
        interactionQueue = [...interactionQueue, { interactionId: 'follow-test', kind: 'follow-up', prompt: payload.prompt }];
        return { ok: true };
    },
    agentRuntimeSteerTurn: async (payload) => {
        steeringTurns.push(payload);
        interactionQueue = [...interactionQueue, { interactionId: 'steer-test', kind: 'steer', prompt: payload.prompt }];
        return { ok: true };
    },
    agentRuntimeCancelTurn: async () => ({ ok: true }),
    agentRuntimeRespondApproval: async (payload) => {
        approvalResponses.push(payload);
        return { approvalId: payload.approvalId, decision: payload.decision };
    },
    agentRuntimeListTopics: async ({ agentId } = {}) => {
        topicListRequests.push(agentId || 'Nova');
        return agentId === '123' ? secondaryTopicCatalog : topicCatalog;
    },
    agentRuntimeSearchTopics: async ({ query, agentId } = {}) => {
        topicSearchRequests.push({ query, agentId: agentId || 'Nova' });
        const catalog = agentId === '123' ? secondaryTopicCatalog : topicCatalog;
        return catalog
            .filter((topic) => `${topic.title} ${topic.id}`.toLocaleLowerCase().includes(String(query || '').toLocaleLowerCase()))
            .map((topic) => ({
                agentId: topic.agentId || agentId || 'Nova', topicId: topic.id, title: topic.title,
                inUse: topic.inUse === true, readOnly: topic.readOnly === true,
                model: topic.model, workspaceRef: topic.workspaceRef, updatedAt: topic.updatedAt,
                messageId: 'search-hit', snippet: topic.title, score: 1,
            }));
    },
    agentRuntimeSearchTopicMessages: async () => [],
    agentRuntimeGetTopicIndexStatus: async () => ({ available: true, rebuilding: false }),
    agentRuntimeRebuildTopicIndex: async () => ({ topicCount: topicCatalog.length }),
    agentRuntimeListInteractionQueue: async () => interactionQueue,
    agentRuntimeReplaceInteractionQueue: async ({ interactions }) => {
        interactionQueue = interactions;
        replacedInteractionQueues.push(interactions);
        return { ok: true };
    },
    agentRuntimeClearInteractionQueue: async () => { interactionQueue = []; return { ok: true }; },
    agentRuntimeGetWorkbenchSettings: async () => ({
        budget: { maxRequestsPerTurn: 8, maxTokensPerTurn: 120000 },
        permissionMode: 'ask',
    }),
    agentRuntimeUpdateWorkbenchSettings: async (payload) => {
        savedWorkbenchSettings.push(payload);
        return {
            restartRequired: true,
            settings: {
                budget: payload.budget || { maxRequestsPerTurn: 8, maxTokensPerTurn: 120000 },
                permissionMode: payload.permissionMode || 'ask',
            },
        };
    },
    agentRuntimeTakeoverTopic: async ({ topicId }) => {
        takeoverRequests.push(topicId);
        topicCatalog = topicCatalog.map((topic) => topic.id === topicId ? { ...topic, inUse: false } : topic);
        return { ok: true, topicId };
    },
    agentRuntimeRenameTopic: async ({ topicId, title }) => { renamedTopics.push({ topicId, title }); return { ok: true, topicId, title }; },
    agentRuntimeDeleteTopic: async ({ topicId }) => ({ ok: true, topicId }),
    agentRuntimeSetWorkbenchPresence: (mounted) => { presenceCalls.push(mounted); },
    onAgentRuntimeEvent(callback) {
        eventCallback = callback;
        return () => { unsubscribeCalls += 1; };
    },
};

let daemonEventNumber = 0;
function emitDaemonEvent(event) {
    daemonEventNumber += 1;
    eventCallback({
        eventId: `daemon-event-${daemonEventNumber}`,
        topicId: 'topic-in-use',
        sequence: daemonEventNumber,
        timestamp: 1_700_000_000_000 + daemonEventNumber,
        runtime: 'rust',
        ...event,
    });
}

await import(`${pathToFileURL(path.join(root, 'modules/ui-system/next-ui-apps.js')).href}?test=${Date.now()}`);
await import(`${pathToFileURL(path.join(root, 'modules/ui-system/vcp-ui.js')).href}?test=${Date.now()}`);
// next-ui-apps overwrites the stub; capture registrations via its real registry.
await import(`${pathToFileURL(path.join(root, 'modules/ui-system/agent-workbench.js')).href}?test=${Date.now()}`);
registered = window.nextUiApps.get('agent-workbench');
assert.ok(registered, 'Agent Workbench must register as an internal app');
assert.equal(registered.kind, 'internal');

const host = document.getElementById('host');
const mainCreateProxy = document.createElement('button');
mainCreateProxy.id = 'nextUiCreateItemBtn';
mainCreateProxy.addEventListener('click', () => { mainCreateProxyCalls += 1; });
document.body.append(mainCreateProxy);
window.topTabManager = {
    openCreateDialog() { sharedCreateActionCalls += 1; },
};
// The Workbench uses its own Topic controls while routing their actions to
// Rust-owned Agent Topics.  The only main-chat element below exists to retain
// the compatibility fallback for a partially initialized shell.
const mainTopicToolbar = document.createElement('div');
mainTopicToolbar.innerHTML = `
    <button id="nextUiCreateTopicBtn" class="next-ui-create-topic-trigger" type="button"><span>新建话题</span></button>
    <button id="nextUiManageTopicsBtn" class="next-ui-topic-icon-trigger" type="button" aria-pressed="false">管理</button>
    <button id="nextUiTopicSearchTrigger" class="next-ui-topic-icon-trigger" type="button" aria-expanded="false">搜索</button>
    <div id="tabContentTopics"><div class="sidebar-subtab-item sidebar-search-subtab"><div class="topic-search-container"><input id="topicSearchInput" class="topic-search-input"><button class="next-ui-topic-search-close" type="button">关闭</button></div></div></div>
`;
document.body.append(mainTopicToolbar);
window.prompt = () => '重命名后的 Topic';
window.confirm = () => true;
window.localStorage.setItem('vcpchat.agentWorkbench.lastTopic.v1', JSON.stringify({
    topicId: 'topic-restored', title: '可恢复的 Rust Topic', agentId: 'Nova',
    model: 'gpt-5.6-terra', workspaceRoot: root,
}));
const dispose = registered.mount(host, {});
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(createdSessions.length, 0,
    'renderer reload must preview the saved Rust Topic without acquiring a writable Session');
assert.deepEqual(JSON.parse(window.localStorage.getItem('vcpchat.agentWorkbench.lastTopic.v1')), { topicId: 'topic-restored' },
    'localStorage must retain only the durable Topic pointer');
assert.ok([...host.querySelectorAll('.message-item .md-content')]
    .some((node) => node.textContent.includes('restored answer')),
    'a resumed Rust Topic must render its saved history rather than an empty feed');
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
    'slow model discovery must not prevent the local Nova Agent catalog from rendering');
const sessionsBeforeAgentBrowse = createdSessions.length;
const secondaryAgent = [...host.querySelectorAll('.agent-chat-agent-row')]
    .find((row) => row.querySelector('.agent-name')?.textContent === '123');
assert.ok(secondaryAgent, 'a second shared Agent must be selectable for Topic browsing');
secondaryAgent.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('.sidebar-tab-button.active')?.textContent, '会话',
    'selecting an Agent must open its Topic catalog without requiring New Topic');
assert.ok([...host.querySelectorAll('.agent-chat-persisted-topic .topic-title-display')]
    .some((node) => node.textContent === '123 的既有 Topic'),
    'the selected Agent history must render immediately from Rust Topic metadata');
assert.equal(createdSessions.length, sessionsBeforeAgentBrowse,
    'browsing an Agent history must not create an empty Agent Session');
assert.equal(topicListRequests.at(-1), '123',
    'the Workbench must request the selected Agent Topic catalog explicitly');
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
assert.match(sharedCreate.textContent, /创建助手或群组/);
sharedCreate.click();
assert.equal(sharedCreateActionCalls, 1,
    'Agent assistant creation must call the shared VCPChat create action, not a sidebar DOM proxy');
assert.equal(mainCreateProxyCalls, 0,
    'the shared creation action must not depend on the current main sidebar button instance');
assert.equal(host.querySelector('.agent-chat-topic-flow-dialog'), null,
    'creating an assistant must not accidentally create a Rust Agent Topic');
agentSearchTrigger.click();
const agentSearch = host.querySelector('.agents-header .topic-search-input');
assert.ok(agentSearch && host.querySelector('.agents-header.is-searching'),
    'the shared assistant search affordance must become interactive in the Agent projection');
agentSearch.value = '123';
agentSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
assert.equal(host.querySelector('.agent-chat-agent-row[data-agent-search*="nova"]').hidden, true,
    'assistant search must filter the projected shared Agent catalog');
host.querySelector('.next-ui-agent-search-close').click();
assert.equal(agentSearch.value, '', 'closing assistant search must clear its transient query');
const headerNewTopic = host.querySelector('.agent-chat-header-actions .agent-chat-icon-button[title="新建 Agent 会话"]');
assert.ok(headerNewTopic, 'Agent header must retain the separate new-Topic action');
headerNewTopic.click();
await new Promise((resolve) => setTimeout(resolve, 30));
const createTopicFlow = host.querySelector('.agent-chat-topic-flow-dialog');
assert.ok(createTopicFlow, 'new Agent conversations must begin in the Workbench-owned Topic flow');
assert.match(createTopicFlow.textContent, /共享 Agent/);
assert.match(createTopicFlow.textContent, /共享模型/);
assert.ok(createTopicFlow.querySelector('.agent-chat-topic-flow-context'),
    'new Topic flow must show the selected Agent, model and workspace sources before creation');
const createTitle = createTopicFlow.querySelector('[aria-label="Topic 标题"]');
const createModel = createTopicFlow.querySelector('[aria-label="模型"]');
const createWorkspace = createTopicFlow.querySelector('[aria-label="工作目录"]');
assert.ok(createTitle && createModel && createWorkspace, 'the new Topic flow must expose title, shared model and workspace controls');
createTitle.value = '独立产品流程 Topic';
createTitle.dispatchEvent(new window.Event('input', { bubbles: true }));
createModel.value = 'gpt-5.6-terra';
createModel.dispatchEvent(new window.Event('input', { bubbles: true }));
createWorkspace.value = root;
createWorkspace.dispatchEvent(new window.Event('input', { bubbles: true }));
const createSubmit = [...createTopicFlow.querySelectorAll('button')].find((button) => button.textContent === '创建并打开');
assert.ok(createSubmit, 'the new Topic flow must require an explicit create action');
createSubmit.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual({
    title: createdSessions.at(-1).title,
    agent: createdSessions.at(-1).agent,
    model: createdSessions.at(-1).model,
    workspaceRoot: createdSessions.at(-1).workspaceRoot,
}, {
    title: '独立产品流程 Topic', agent: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: root,
}, 'new Agent conversations must pass the chosen shared Agent/model/workspace through Rust IPC');
assert.equal(host.querySelector('.agent-chat-message-input').disabled, false, 'a newly created Rust Session must unlock the composer');
const sessionTab = [...host.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
    .find((tab) => tab.textContent.trim() === '会话');
assert.ok(sessionTab, 'Assistant and session tabs must both be available');
sessionTab.click();
assert.ok(host.querySelector('.agent-chat-session-row'));
assert.ok([...host.querySelectorAll('.agent-chat-session-row .topic-title-display')]
    .some((node) => node.textContent === '另一条持久 Topic'),
    'the sidebar must render durable Rust Topics, not only the current in-memory session');
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
assert.equal(host.querySelector('.agent-chat-persisted-topic[data-topic-id="topic-restored"]').hidden, true,
    'expanded Topic search must filter durable Rust Topics');
await new Promise((resolve) => setTimeout(resolve, 240));
assert.deepEqual(topicSearchRequests.at(-1), { query: '另一条', agentId: 'Nova' },
    'Topic search must cross the narrow daemon IPC instead of remaining a local DOM filter');
assert.ok(host.querySelector('.agent-chat-persisted-topic[data-topic-id="topic-archived"]'),
    'daemon search hits must project back into the Topic list using their durable topicId');
host.querySelector('.topics-header-container .next-ui-topic-search-close').click();
assert.equal(host.querySelector('.topic-search-input')?.value || '', '', 'closing Topic search must clear its transient query');
topicManage.click();
assert.equal(host.querySelector('.topics-header-container .next-ui-topic-icon-trigger[aria-label="管理会话"]')?.getAttribute('aria-pressed'), 'true',
    'Topic manage control must enter renderer-local management mode');
assert.ok(host.querySelector('.agent-chat-sidebar-content.is-managing .agent-chat-topic-manage-panel'),
    'Topic manage mode must expose the same bottom management affordance as main chat');
const selectableTopic = host.querySelector('.agent-chat-persisted-topic[data-topic-id="topic-archived"]');
selectableTopic.click();
assert.match(host.querySelector('.agent-chat-topic-selection-count').textContent, /1/,
    'management mode must select a Rust Topic rather than opening it');
host.querySelector('.agent-chat-topic-manage-panel [aria-label="退出会话管理"]').click();
assert.equal(host.querySelector('.agent-chat-sidebar-content').classList.contains('is-managing'), false,
    'exiting Topic management must discard renderer-only selection state');
const persistedTopicMenu = host.querySelector('.agent-chat-persisted-topic .agent-chat-session-menu');
assert.ok(persistedTopicMenu, 'a free durable Topic must expose its own management menu');
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
assert.deepEqual(renamedTopics, [{ topicId: 'topic-restored', title: '重命名后的 Topic' }],
    'Topic rename must use the narrow Rust Agent runtime IPC, not write renderer-side storage');
const persistedTopicRow = host.querySelector('.agent-chat-persisted-topic[data-topic-id="topic-restored"]');
persistedTopicRow.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 32, clientY: 48,
}));
const rightClickTopicMenu = document.querySelector('.agent-chat-topic-context-menu');
assert.ok(rightClickTopicMenu, 'right-clicking a free Rust Topic must open the same context menu');
assert.ok([...rightClickTopicMenu.querySelectorAll('[role="menuitem"]')]
    .some((button) => button.textContent.includes('删除')),
    'free Topics may expose destructive actions only through Rust-authoritative IPC');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.equal(document.querySelector('.agent-chat-topic-context-menu'), null,
    'Escape must close the transient Topic menu rather than leaving a stale overlay');
const inUseTopicRow = [...host.querySelectorAll('.agent-chat-persisted-topic')]
    .find((row) => row.querySelector('.topic-title-display')?.textContent === '协作接管 Topic');
assert.ok(inUseTopicRow, 'a Topic held by another daemon must remain visible as a read-only row');
assert.doesNotMatch(inUseTopicRow.textContent || '', /使用中|占用/,
    'Topic lease state is a concurrency guard and must not leak into the ordinary sidebar row');
inUseTopicRow.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 32, clientY: 48,
}));
const occupiedTopicMenu = document.querySelector('.agent-chat-topic-context-menu');
assert.ok(occupiedTopicMenu, 'right-clicking an occupied Topic must expose its normal management menu');
assert.ok([...occupiedTopicMenu.querySelectorAll('[role="menuitem"]')]
    .some((button) => button.textContent === '打开会话'),
    'an occupied Topic may only enter the same conflict flow as a normal open');
assert.equal([...occupiedTopicMenu.querySelectorAll('[role="menuitem"]')]
    .some((button) => /只读|checkpoint|接管|重命名|删除/.test(button.textContent)), false,
    'occupied Topics must not expose destructive mutation actions while a Rust lease is active');
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
inUseTopicRow.click();
await new Promise((resolve) => setTimeout(resolve, 30));
const occupiedConflict = host.querySelector('.agent-chat-topic-conflict-dialog');
assert.ok(occupiedConflict, 'opening an occupied Topic must show only the explicit conflict confirmation');
assert.ok(occupiedConflict.closest('.agent-chat-main-column'),
    'the occupied Topic confirmation must stay in the active conversation rather than becoming an app-wide overlay');
assert.equal(host.querySelector('.agent-chat-topic-conflict-backdrop'), null,
    'the occupied Topic confirmation must not hide the transcript behind a blocking backdrop');
assert.equal(host.querySelector('.agent-chat-occupied-banner'), null,
    'opening a Topic must never replace the current transcript with an inline read-only preview');
assert.equal(host.querySelector('.agent-chat-topic-flow-dialog'), null,
    'opening an occupied Topic must not expose checkpoint/lease product state');
const takeoverButton = [...occupiedConflict.querySelectorAll('button')]
    .find((button) => button.textContent === '接管并继续');
assert.ok(takeoverButton, 'an occupied Topic must require one explicit safe takeover action');
takeoverButton.click();
await new Promise((resolve) => setTimeout(resolve, 650));
assert.deepEqual(takeoverRequests, ['topic-in-use'], 'a user click must request cooperative Rust Topic takeover exactly once');
assert.equal(createdSessions.at(-1).resume, 'topic-in-use',
    'after the owner releases its lease, Workbench must attach to the durable Topic automatically');
assert.ok(host.querySelector('.agent-chat-header-actions'), 'Tool and approval activity must remain reachable from the redesigned header');
const compactButton = host.querySelector('.agent-chat-compact');
assert.ok(compactButton && !compactButton.disabled, 'an active Rust Agent session must expose safe compaction');
compactButton.click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(compactedSessions, ['sess_test'], 'compaction must use the narrow Rust runtime IPC');
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
    'the Renderer may preview a daemon descriptor but must not receive its source path or bytes');
host.querySelector('.agent-chat-send-button').click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(startedTurns[0], { sessionId: 'sess_test', prompt: '', attachments: [importedAttachment] },
    'an attachment-only turn must pass the descriptor to Rust rather than stringify it into text');
assert.equal(host.querySelector('.agent-chat-composer-attachments')?.childElementCount || 0, 0,
    'accepted descriptors leave the transient composer tray after they are submitted');
selectedAttachments = [importedVideoAttachment];
attachButton.click();
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
host.querySelector('.agent-chat-send-button').click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(startedTurns[1], { sessionId: 'sess_test', prompt: '请介绍一下自己', attachments: [] }, 'Send must start a real Runtime turn, not save a local draft');
assert.ok([...host.querySelectorAll('.message-item.user .md-content')]
    .some((node) => node.textContent.includes('请介绍一下自己')),
    'an accepted start-turn ACK must project the user message before the first daemon event arrives');
assert.match(host.querySelector('.message-item.user')?.textContent || '', /发送中/,
    'the temporary local projection must disclose that durable confirmation is still pending');
// A command ACK only confirms acceptance.  The Workbench must not infer a
// running turn from it; only the daemon's authoritative event may establish
// the live turn used by steering and follow-up controls.
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_test', sequence: 3,
    messageId: 'msg_turn_test_user',
    type: 'turn.started', payload: { prompt: '请介绍一下自己' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.ok([...host.querySelectorAll('.message-item.user .md-content')]
    .some((node) => node.textContent.includes('请介绍一下自己')),
    'daemon turn.started must render the submitted user message immediately');
const activeSendButton = host.querySelector('.agent-chat-send-button');
assert.equal(activeSendButton.querySelector('.vcp-ui-icon')?.textContent, 'stop',
    'an active Rust turn must replace the send arrow with the main-chat stop icon');
assert.equal(activeSendButton.getAttribute('aria-label'), '取消当前任务');
assert.equal(activeSendButton.classList.contains('interrupt-mode'), true,
    'an empty composer during an active turn must use the shared interrupt visual state');
prompt.value = '完成后再列出风险';
prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
host.querySelector('.agent-chat-send-button').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(followUpTurns, [{ sessionId: 'sess_test', turnId: 'turn_test', prompt: '完成后再列出风险' }],
    'while a turn is active, normal composer input must queue a Rust follow-up instead of cancelling the task');
prompt.value = '/steer 先检查风险';
prompt.dispatchEvent(new window.Event('input', { bubbles: true }));
host.querySelector('.agent-chat-send-button').click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(steeringTurns, [{ sessionId: 'sess_test', turnId: 'turn_test', prompt: '先检查风险' }],
    'the explicit /steer prefix must insert immediate steering rather than a follow-up');
await new Promise((resolve) => setTimeout(resolve, 30));
const queueToggle = host.querySelector('.agent-chat-queue-toggle');
assert.ok(queueToggle, 'the header must expose the Rust interaction queue');
queueToggle.click();
assert.match(host.querySelector('.agent-chat-queue-popover').textContent, /完成后再列出风险/,
    'the queue panel must render follow-up prompts from Rust state');
assert.match(host.querySelector('.agent-chat-queue-popover').textContent, /先检查风险/,
    'the queue panel must distinguish steering prompts from Rust state');
const removeQueueButton = [...host.querySelectorAll('.agent-chat-queue-item-actions button')]
    .find((button) => button.textContent === '移除');
assert.ok(removeQueueButton, 'queue items must provide a safe remove operation when the daemon exposes replacement');
removeQueueButton.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(replacedInteractionQueues.length, 1, 'removing one queue item must replace the daemon-owned queue snapshot once');
assert.equal(replacedInteractionQueues[0].length, 1, 'removing one queue item must preserve remaining interactions');
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_test', sequence: 4,
    type: 'context.usage',
    payload: { inputTokens: 12, outputTokens: 8, totalTokens: 20, requests: 1, usageAvailable: true },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const usageToggle = host.querySelector('.agent-chat-usage-toggle');
assert.ok(usageToggle, 'the header must expose Rust usage state');
usageToggle.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.match(host.querySelector('.agent-chat-activity-usage').textContent, /Tokens/,
    'usage panel must present the daemon-projected aggregate rather than a fake cost');
assert.match(host.querySelector('.agent-chat-activity-usage').textContent, /20/,
    'usage panel must display total tokens from the runtime event');
const budgetForm = host.querySelector('.agent-chat-usage-budget');
assert.ok(budgetForm, 'usage panel must expose daemon-owned per-turn budget controls');
assert.equal(budgetForm.querySelector('[name="maxRequestsPerTurn"]').value, '8');
assert.equal(budgetForm.querySelector('[name="maxTokensPerTurn"]').value, '120000');
budgetForm.querySelector('[name="maxRequestsPerTurn"]').value = '12';
budgetForm.querySelector('[name="maxTokensPerTurn"]').value = '240000';
budgetForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(savedWorkbenchSettings, [{
    budget: { maxRequestsPerTurn: '12', maxTokensPerTurn: '240000' },
}], 'budget save must use the narrow Rust Agent settings IPC, never renderer storage');

emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_test', sequence: 5, type: 'toolbox.ws',
    payload: {
        channel: 'Info', kind: 'notification',
        value: { message: 'ToolBox 只读通知 <img src=x>' },
    },
});
await new Promise((resolve) => setTimeout(resolve, 30));
host.querySelector('.agent-chat-activity-tab[data-tab="activity"]')?.click();
await new Promise((resolve) => setTimeout(resolve, 0));
const toolboxObservation = host.querySelector('.agent-chat-toolbox-ws-card');
assert.ok(toolboxObservation, 'ToolBox WS observations must render in their own non-tool block');
assert.match(toolboxObservation.textContent, /服务通知/);
assert.match(toolboxObservation.textContent, /ToolBox 只读通知/);
assert.equal(toolboxObservation.querySelector('img'), null, 'ToolBox WS text must never be interpreted as renderer HTML');
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_test', sequence: 6, type: 'toolbox.ws',
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
assert.equal(backendActions.length, 2, 'ToolBox backend approval must expose explicit deny/allow actions without an Agent tool binding');
backendActions[0].click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(approvalResponses.at(-1), {
    approvalId: 'approve-1', decision: 'deny', scope: 'toolbox',
}, 'backend approval action must use the narrow IPC and only the ToolBox-owned request ID');
approvalResponses.length = 0;
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_test', toolCallId: 'tool-risk', sequence: 7,
    type: 'approval.requested',
    payload: {
        approval: {
            approvalId: 'approval-risk', sessionId: 'sess_test', turnId: 'turn_test', toolCallId: 'tool-risk',
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
    'Renderer must not manufacture a deny when the Rust Host-owned deadline expires');
assert.match(localApproval.querySelector('.agent-chat-approval-countdown').textContent,
    /等待 Rust Runtime/);

// A fresh approval with a real future deadline proves the visible actions use
// the complete Rust-owned four-part binding; the renderer never invents an
// unbound approval decision.
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_test', toolCallId: 'tool-action', sequence: 8,
    type: 'approval.requested',
    payload: { approval: {
        approvalId: 'approval-action', sessionId: 'sess_test', turnId: 'turn_test', toolCallId: 'tool-action',
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
    approvalId: 'approval-action', decision: 'deny', sessionId: 'sess_test', turnId: 'turn_test',
    toolCallId: 'tool-action', argumentsHash: 'bound-action-hash',
}, 'the visible deny button must invoke the real narrowed approval IPC with its exact Rust binding');

runtimeStatus = 'ready';
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
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_live', messageId: 'msg_live', sequence: 2,
    type: 'assistant.delta', payload: { text: 'live Rust delta' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('.agent-wb-runtime-dock'), null, 'Runtime lifecycle controls must stay out of the Agent UI');
assert.ok([...host.querySelectorAll('.message-item .md-content')].some((node) => node.textContent.includes('live Rust delta')), 'Runtime delta must render in the migrated chat shell');
host.querySelector('.agent-chat-status-chip[data-action="connection"]')?.click();
// `setActivityOpen` queues the activity projection through the same animation
// frame batcher used by streaming updates. Give JSDOM one actual frame rather
// than assuming a zero-delay timer has already flushed it.
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelectorAll('.agent-chat-readiness-card').length, 4,
    'the connection surface must render exactly the four daemon-owned readiness facts');
assert.match(host.querySelector('[data-readiness="toolbox"]').textContent, /VCPToolBox.*就绪/s,
    'ToolBox readiness must display the daemon probe result without a renderer HTTP request');
assert.match(host.querySelector('[data-readiness="capability"]').textContent, /未知/,
    'a missing DistributedServer lifecycle event must remain explicitly unknown instead of being guessed');

// Streaming is the hot path.  A second delta must update the existing message
// in place rather than replace the feed, composer or focused draft.
const liveMessage = host.querySelector('[data-message-id="msg_live"]');
const stableComposer = host.querySelector('.agent-chat-message-input');
stableComposer.value = '保持中的草稿';
stableComposer.dispatchEvent(new window.Event('input', { bubbles: true }));
stableComposer.focus();
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_live', messageId: 'msg_live', sequence: 3,
    type: 'assistant.delta', payload: { text: ' and another delta' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('[data-message-id="msg_live"]'), liveMessage,
    'streaming deltas must retain the existing assistant DOM node');
assert.equal(host.querySelector('.agent-chat-message-input'), stableComposer,
    'streaming deltas must not replace the composer node');
assert.equal(document.activeElement, stableComposer,
    'streaming deltas must preserve focused input');
assert.equal(stableComposer.value, '保持中的草稿',
    'streaming deltas must preserve the user draft');
assert.match(liveMessage.querySelector('.md-content').textContent, /live Rust delta and another delta/,
    'streaming deltas must append to the existing assistant message');

emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_live', messageId: 'msg_live', sequence: 4,
    type: 'reasoning.delta', payload: { text: 'Inspecting the VCPToolBox environment before choosing the next safe action.' },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const reasoningCard = liveMessage.querySelector('.agent-chat-reasoning-block');
assert.ok(reasoningCard, 'reasoning deltas must render the dedicated compact thinking card');
assert.match(reasoningCard.querySelector('.vcp-thought-chain-label').textContent, /思考中.*s/,
    'a streaming thought card must show a Cherry-style thinking status and live duration');
assert.equal(reasoningCard.querySelector('.vcp-thought-chain-icon').textContent, 'lightbulb',
    'the Agent Workbench thinking card must use the compact lightbulb treatment rather than a decorative brain emoji');
reasoningCard.querySelector('.vcp-thought-chain-header').click();
assert.equal(reasoningCard.querySelector('.vcp-thought-chain-bubble').classList.contains('expanded'), false,
    'the fallback thinking header must remain explicitly collapsible');
reasoningCard.querySelector('.vcp-thought-chain-header').click();
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_live', messageId: 'msg_live', sequence: 5,
    type: 'assistant.completed', payload: {},
});
await new Promise((resolve) => setTimeout(resolve, 30));
const completedLiveMessage = host.querySelector('[data-message-id="msg_live"]');
assert.match(completedLiveMessage.querySelector('.agent-chat-reasoning-block .vcp-thought-chain-label').textContent, /已深度思考.*s/,
    'a completed thought card must collapse to a concise duration summary');
assert.ok(completedLiveMessage.querySelector('.agent-chat-reasoning-copy'),
    'completed reasoning must expose a small copy action, matching the Cherry-style review workflow');

// OpenCode's timeline model is the relevant interaction reference: a single
// turn can include assistant text, a tool call, then more assistant text.  The
// Workbench must preserve the daemon's sequence order instead of batching all
// tools beside the first user message for that turn.
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn-order', messageId: 'msg-order-before', sequence: 20,
    type: 'assistant.started', payload: {},
});
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn-order', toolCallId: 'tool-order', sequence: 21,
    type: 'tool.requested', payload: { toolName: 'vcp_invoke', argumentSummary: 'FileOperator.ReadFile package.json' },
});
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn-order', messageId: 'msg-order-after', sequence: 22,
    type: 'assistant.started', payload: {},
});
await new Promise((resolve) => setTimeout(resolve, 30));
const sequenceParts = [...host.querySelector('.agent-chat-messages').children];
const beforeIndex = sequenceParts.findIndex((element) => element.dataset.messageId === 'msg-order-before');
const toolIndex = sequenceParts.findIndex((element) => element.dataset.toolCallId === 'tool-order');
const afterIndex = sequenceParts.findIndex((element) => element.dataset.messageId === 'msg-order-after');
assert.ok(beforeIndex >= 0 && beforeIndex < toolIndex && toolIndex < afterIndex,
    'message → tool → message must retain daemon sequence order in the visible timeline');
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn-order', toolCallId: 'tool-order', sequence: 23,
    type: 'tool.completed', payload: {
        toolName: 'vcp_invoke',
        outputSummary: 'FileOperator 已返回 package.json',
        result: 'x'.repeat(1_024),
        resources: [{ type: 'file', name: 'package.json', url: 'file-ref:package.json' }],
        warnings: ['只读预览'],
        task: { status: 'accepted', id: 'task-1' },
    },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const completedToolCard = host.querySelector('[data-tool-call-id="tool-order"]');
assert.ok(completedToolCard?.querySelector('.agent-chat-tool-chevron'),
    'a terminal tool with a result must expose an explicit detail control');
assert.equal(completedToolCard.querySelector('.agent-chat-tool-detail'), null,
    'collapsed long results must not eagerly mount Markdown/detail DOM for every completed tool');
completedToolCard.querySelector('.agent-chat-tool-chevron').click();
assert.ok(completedToolCard.querySelector('.agent-chat-tool-detail-result'),
    'opening a completed tool must mount its preserved daemon result on demand');
assert.equal(completedToolCard.querySelector('.agent-chat-tool-detail-result').textContent.length, 1_024);
assert.match(completedToolCard.querySelector('.agent-chat-tool-resource-list').textContent, /package\.json/);
assert.match(completedToolCard.querySelector('.agent-chat-tool-warning-list').textContent, /只读预览/);
assert.match(completedToolCard.querySelector('.agent-chat-tool-task').textContent, /task-1/);

// `assistant.completed` intentionally requests a full durable projection.
// Let that frame settle before the following scroll-anchor regression probe
// installs its synthetic geometry.
await new Promise((resolve) => setTimeout(resolve, 50));

// Run this after the preceding streaming frame has settled. A full rerender
// from a ToolBox status event must not force a reader who is inspecting older
// output back to the live bottom edge.
const scrollContainer = host.querySelector('.agent-chat-messages-container');
Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 120 });
Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 1_000 });
scrollContainer.scrollTop = 320;
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn_test', sequence: 8, type: 'toolbox.ws',
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
        sessionId: 'sess_test', turnId: 'turn_test', sequence, type: 'toolbox.ws',
        payload: { channel: 'Info', kind, value },
    });
}
await new Promise((resolve) => setTimeout(resolve, 30));
host.querySelector('.agent-chat-activity-tab[data-tab="activity"]')?.click();
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
    sessionId: 'sess_test', turnId: 'turn_test', messageId: 'assistant-marker', sequence: 14,
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
emitDaemonEvent({
    sessionId: 'sess_test', turnId: 'turn-order', messageId: 'msg-reader-new', sequence: 24,
    type: 'assistant.started', payload: {},
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
    sessionId: 'sess_test', type: 'runtime.crashed',
    payload: { error: 'simulated daemon crash', recoverable: true },
});
await new Promise((resolve) => setTimeout(resolve, 30));
const reconnect = host.querySelector('.agent-chat-connection-reconnect');
assert.ok(reconnect, 'a daemon crash must expose an explicit reconnect action instead of leaving a dead composer');
assert.match(host.querySelector('.agent-chat-activity-connection').textContent, /simulated daemon crash/);
const sessionsBeforeRecovery = createdSessions.length;
reconnect.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.deepEqual(runtimeTransitions.slice(-2), ['stop', 'start'], 'recovery must restart the Main-supervised daemon boundary');
assert.equal(createdSessions.length, sessionsBeforeRecovery,
    'recovery must restore a Rust snapshot without silently reacquiring a Topic lease or replaying a Turn');

const restoredTopicRow = [...host.querySelectorAll('.agent-chat-session-row')]
    .find((row) => row.dataset.topicId === 'topic-archived');
assert.ok(restoredTopicRow, 'durable Topic row must retain its Topic identifier');
const topicSidebar = host.querySelector('.agent-chat-sidebar');
topicSidebar.scrollTop = 73;
const sessionsBeforeTopicPreview = createdSessions.length;
restoredTopicRow.click();
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(host.querySelector('.agent-chat-topic-flow-dialog'), null,
    'clicking an idle Topic row must not show a blocking restore dialog');
assert.equal(createdSessions.length, sessionsBeforeTopicPreview,
    'clicking a durable Topic must preview Rust persistence without acquiring a Session');
assert.strictEqual(host.querySelector('.agent-chat-session-row[data-topic-id="topic-archived"]'), restoredTopicRow,
    'preview selection must patch the existing sidebar row instead of rebuilding the session list');
assert.equal(topicSidebar.scrollTop, 73,
    'preview selection must preserve the conversation-list scroll position');

const settingsTab = [...host.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
    .find((tab) => tab.textContent.trim() === '设置');
settingsTab.click();
assert.ok(host.querySelector('.agent-chat-settings-pane .agent-chat-settings-form'),
    'settings must render inside a dedicated padded pane instead of placing fields against the sidebar edge');
assert.equal(host.querySelector('.agent-chat-settings-pane > .agent-chat-settings-placeholder') !== null, true);
const permissionSelect = [...host.querySelectorAll('.agent-chat-settings-pane .agent-chat-setting-field select')]
    .find((control) => [...control.options].some((option) => option.value === 'always-approve'));
assert.ok(permissionSelect, 'Workbench settings must expose a visible local approval (YOLO) policy selector');
permissionSelect.value = 'always-approve';
permissionSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
const savePermission = [...host.querySelectorAll('.agent-chat-settings-pane button')]
    .find((button) => button.textContent === '保存本地审批策略');
assert.ok(savePermission, 'the local approval policy must have an explicit save action');
savePermission.click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(savedWorkbenchSettings.at(-1)?.permissionMode, 'always-approve',
    'saving YOLO must only persist the narrowed Rust Host permissionMode setting');

dispose();
assert.equal(unsubscribeCalls, 1, 'Workbench unmount must release runtime event subscription');
assert.deepEqual(presenceCalls, [true, false]);
assert.equal(host.childElementCount, 0);

console.log('Agent Workbench mount, event rendering, and unmount cleanup tests passed.');
// JSDOM retains animation/timer handles after the internal app unmounts.
// Close the synthetic window so this hermetic test can participate in the
// chained Rust-stack gate instead of silently blocking later checks.
window.close();
process.exit(0);
