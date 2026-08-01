import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createAgentContentRendererFork } from '../modules/ui-system/agent-presentation/content-renderer-fork.js';
import { bindAgentPresentationContextMenu } from '../modules/ui-system/agent-presentation/context-menu.js';
import { createAgentPresentationCallbacks } from '../modules/ui-system/agent-presentation/renderer.js';
import { reconcileAgentTimeline } from '../modules/ui-system/agent-workbench-timeline.js';

const dom = new JSDOM('<!doctype html><body><div id="feed"></div></body>', { pretendToBeVisual: true });
const { document } = dom.window;
globalThis.window = dom.window;
globalThis.document = document;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.Node = dom.window.Node;

const parse = (source) => {
    const escaped = String(source)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    return `<p>${escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replaceAll('\n', '<br>')}</p>`;
};
let mermaidRuns = 0;
const contentFork = createAgentContentRendererFork({
    window: dom.window,
    marked: { parse },
    mermaid: {
        initialize() {},
        async run({ nodes }) {
            mermaidRuns += nodes.length;
            nodes.forEach((node) => { node.innerHTML = '<svg aria-label="diagram"></svg>'; });
        },
    },
    allowDetachedPostRender: true,
});

const unsafe = contentFork.renderContent('**bold**\n<script>alert(1)</script><style>body{display:none}</style>');
assert.match(unsafe, /<strong>bold<\/strong>/);
assert.doesNotMatch(unsafe, /<script|<style/i, 'the Agent fork must not allow active document content');
const mermaidHtml = contentFork.renderContent('```mermaid\ngraph TD\nA-->B\n```');
assert.match(mermaidHtml, /mermaid-placeholder/);
const thoughtHtml = contentFork.renderContent('<think>\nprivate reasoning\n</think>\nanswer');
assert.match(thoughtHtml, /vcp-thought-chain-bubble/);

const feed = document.getElementById('feed');
const callbacks = createAgentPresentationCallbacks({
    document,
    createMessageSkeleton(message) {
        const messageItem = document.createElement('article');
        messageItem.className = `message-item ${message.role}`;
        const body = document.createElement('div');
        body.className = 'details-and-bubble-wrapper';
        const contentDiv = document.createElement('div');
        contentDiv.className = 'md-content';
        body.append(contentDiv);
        messageItem.append(body);
        return { messageItem, detailsAndBubbleWrapper: body, contentDiv };
    },
    renderContent: contentFork.renderContent,
    renderReasoning: contentFork.renderReasoning,
    runPostRender: contentFork.runPostRender,
});
const part = {
    kind: 'message',
    id: 'item-fork-1',
    messageId: 'item-fork-1',
    value: {
        id: 'item-fork-1',
        role: 'assistant',
        state: 'complete',
        content: '**same pipeline**\n```mermaid\ngraph TD\nA-->B\n```',
        reasoning: 'reasoning details',
    },
};
const partMap = new Map([['message:item-fork-1', part]]);
reconcileAgentTimeline(feed, [part], callbacks, new Map());
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(feed.querySelector('.message-item.assistant .details-and-bubble-wrapper .md-content'));
assert.match(feed.querySelector('.md-content').innerHTML, /same pipeline/);
assert.ok(feed.querySelector('.vcp-thought-chain-bubble'));
assert.equal(mermaidRuns, 1);

const invoked = [];
const disposeMenu = bindAgentPresentationContextMenu({
    container: feed,
    document,
    getPart: (key) => partMap.get(key),
    actions: {
        copy: ({ text }) => invoked.push(['copy', text]),
        edit: () => invoked.push(['edit']),
        retry: () => invoked.push(['retry']),
        fork: () => invoked.push(['fork']),
        forward: () => invoked.push(['forward']),
    },
});
feed.querySelector('.md-content').dispatchEvent(new dom.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 20,
    clientY: 30,
}));
const menu = document.getElementById('chatContextMenu');
assert.ok(menu, 'Agent fork must use the main-chat context-menu visual hook');
assert.equal(menu.dataset.owner, 'agent-presentation');
assert.deepEqual([...menu.querySelectorAll('[data-agent-action]')].map((item) => item.dataset.agentAction), [
    'copy', 'edit', 'retry', 'fork', 'forward',
]);
menu.querySelector('[data-agent-action="copy"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
await Promise.resolve();
assert.equal(invoked[0][0], 'copy');
assert.match(invoked[0][1], /same pipeline/);

disposeMenu();
dom.window.close();
delete globalThis.window;
delete globalThis.document;
delete globalThis.NodeFilter;
delete globalThis.Node;
console.log('Agent message renderer fork and action-adapter tests passed.');
