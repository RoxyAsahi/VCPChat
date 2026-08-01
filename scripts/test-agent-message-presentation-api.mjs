import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div class="chat-messages-container"><div id="feed"></div></div></body>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.NodeFilter = window.NodeFilter;
globalThis.MutationObserver = window.MutationObserver;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};
window.IntersectionObserver = globalThis.IntersectionObserver;
window.CSS ||= { escape: (value) => String(value) };

const { createAgentMessagePresentation } = await import('../modules/ui-system/agent-presentation/index.js');
const { reconcileAgentTimeline } = await import('../modules/ui-system/agent-workbench-timeline.js');

const feed = window.document.getElementById('feed');
const projectedMessages = [{ id: 'item-1', role: 'assistant', content: '**hello**', createdAt: 1 }];
const actions = [];
const parser = {
    parse(text) {
        return `<p>${String(text).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</p>`;
    },
};
const presentation = createAgentMessagePresentation({
    window,
    document: window.document,
    container: feed,
    markedInstance: parser,
    getSessionContext: () => ({
        sessionId: 'session-1',
        threadId: 'thread-1',
        participant: { id: 'nova', name: 'Nova', avatarUrl: '' },
        messages: projectedMessages,
        settings: { userName: '用户', enableUserChatBubbleUi: true },
    }),
    actions: {
        copy: ({ text }) => actions.push(['copy', text]),
        fork: ({ part }) => actions.push(['fork', part.id]),
        retry: ({ part }) => actions.push(['retry', part.id]),
        edit: ({ part }) => actions.push(['edit', part.id]),
        forward: ({ part }) => actions.push(['forward', part.id]),
        interrupt: ({ part }) => actions.push(['interrupt', part.id]),
    },
    electronAPI: {
        getEmoticonLibrary: async () => [],
        openImageViewer() {},
        showImageContextMenu() {},
        sovitsStop() {},
    },
});
presentation.bindInteractions();

const rows = new Map();
const ephemeralPart = {
    kind: 'message',
    id: 'turn-start:session-1',
    presentationKey: 'turn-start:session-1',
    value: {
        id: 'turn-start:session-1', role: 'assistant', state: 'streaming',
        content: '正在启动 Agent…', presentationRole: 'turn-start', presentationPhase: 'starting',
        presentationKey: 'turn-start:session-1',
    },
};
reconcileAgentTimeline(feed, [ephemeralPart], presentation.timelineCallbacks, rows);
const ephemeralRow = feed.querySelector('.agent-chat-turn-starting');
assert.ok(ephemeralRow?.classList.contains('streaming'), 'first-send placeholder must use the main-chat streaming row');
assert.equal(ephemeralRow.querySelector('.sender-name').textContent, 'Nova');
assert.ok(ephemeralRow.querySelector('.avatar, .message-avatar, img'), 'first-send placeholder must include the Agent avatar skeleton');
assert.match(ephemeralRow.querySelector('.thinking-indicator').textContent, /正在启动 Agent/);
const messagePart = {
    kind: 'message',
    id: 'item-1',
    messageId: 'item-1',
    value: projectedMessages[0],
};
reconcileAgentTimeline(feed, [messagePart], presentation.timelineCallbacks, rows);
await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
const stableRow = feed.querySelector('.message-item[data-message-id="item-1"]');
assert.ok(stableRow, 'full fork must create the main-chat message skeleton');
assert.ok(stableRow.querySelector('.details-and-bubble-wrapper .md-content'));
assert.match(stableRow.querySelector('.md-content').innerHTML, /<strong>hello<\/strong>/);
assert.equal(stableRow.querySelector('.sender-name').textContent, 'Nova');

const streamingPart = {
    ...messagePart,
    value: { ...messagePart.value, content: 'stream delta', state: 'streaming' },
};
reconcileAgentTimeline(feed, [streamingPart], presentation.timelineCallbacks, rows);
assert.strictEqual(feed.firstElementChild, stableRow);
assert.equal(stableRow.querySelector('.md-content').textContent, 'stream delta');
assert.ok(stableRow.classList.contains('streaming'));

const completedPart = {
    ...messagePart,
    value: { ...messagePart.value, content: '**complete**', state: 'complete' },
};
reconcileAgentTimeline(feed, [completedPart], presentation.timelineCallbacks, rows);
await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
assert.strictEqual(feed.firstElementChild, stableRow, 'completion must preserve the keyed message row');
assert.match(stableRow.querySelector('.md-content').innerHTML, /<strong>complete<\/strong>/);

stableRow.querySelector('.md-content').dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
}));
const menu = window.document.getElementById('chatContextMenu');
assert.ok(menu);
menu.querySelector('[data-agent-action="fork"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await Promise.resolve();
assert.deepEqual(actions[0], ['fork', 'item-1']);

presentation.dispose();
assert.equal(window.document.getElementById('chatContextMenu'), null);
dom.window.close();
for (const key of ['window', 'document', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver']) {
    delete globalThis[key];
}
console.log('Agent full-fork public presentation API tests passed.');
