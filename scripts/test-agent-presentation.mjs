import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
    createAgentActionDescriptors,
    normalizeAgentPresentationPart,
} from '../modules/ui-system/agent-presentation/contract.js';
import { createAgentPresentationCallbacks } from '../modules/ui-system/agent-presentation/renderer.js';
import { createAnimationFrameBatcher } from '../modules/ui-system/agent-presentation/stream-batcher.js';
import { reconcileAgentTimeline } from '../modules/ui-system/agent-workbench-timeline.js';

const dom = new JSDOM('<!doctype html><div id="feed"></div>');
const { document } = dom.window;
const feed = document.getElementById('feed');
feed.replaceChildren = () => { throw new Error('presentation renderer must not clear the feed'); };

const postRendered = [];
const createMessageSkeleton = (message) => {
    const row = document.createElement('div');
    row.className = `message-item ${message.role}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'details-and-bubble-wrapper';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'md-content';
    wrapper.append(contentDiv);
    row.append(wrapper);
    return { messageItem: row, detailsAndBubbleWrapper: wrapper, contentDiv };
};
const callbacks = createAgentPresentationCallbacks({
    document,
    createMessageSkeleton,
    renderContent: (text, { streaming }) => `<p data-mode="${streaming ? 'stream' : 'full'}">${text}</p>`,
    renderReasoning: (text) => `<div class="vcp-thought-chain-bubble">${text}</div>`,
    runPostRender: (element) => postRendered.push(element),
});

const messagePart = {
    kind: 'message',
    id: 'item-1',
    messageId: 'item-1',
    value: {
        id: 'item-1',
        role: 'assistant',
        state: 'streaming',
        content: 'hello',
        reasoning: 'thinking',
        attachments: [{ id: 'attachment-1', name: 'report.txt' }],
    },
};
const toolPart = {
    kind: 'tool',
    id: 'call-1',
    toolCallId: 'call-1',
    value: { toolCallId: 'call-1', name: 'vcp_invoke', state: 'requested', summary: 'FileOperator' },
};

const normalized = normalizeAgentPresentationPart(messagePart);
assert.deepEqual(normalized.blocks.map((block) => block.kind), ['text', 'reasoning', 'attachment']);
assert.throws(() => normalizeAgentPresentationPart({ kind: 'message', value: { content: 'missing id' } }), /messageId/);
assert.deepEqual(createAgentActionDescriptors(messagePart, { interrupt: true, fork: true }).map((item) => item.id), ['copy', 'interrupt']);

const rows = new Map();
reconcileAgentTimeline(feed, [messagePart, toolPart], callbacks, rows);
const stableMessage = feed.children[0];
const stableTool = feed.children[1];
assert.ok(stableMessage.classList.contains('message-item'));
assert.equal(stableMessage.querySelector('.md-content').textContent, 'hello');
assert.equal(stableMessage.querySelector('.md-content p'), null, 'streaming must use the text fast path');
assert.match(stableMessage.querySelector('.vcp-thought-chain-bubble').textContent, /thinking/);
assert.match(stableMessage.querySelector('.message-attachment-item').textContent, /report\.txt/);
assert.match(stableTool.querySelector('.agent-presentation-tool-title').textContent, /requested/);
assert.equal(postRendered.length, 0, 'streaming content must defer expensive post processing');

const completedMessage = {
    ...messagePart,
    value: { ...messagePart.value, state: 'complete', content: 'hello complete' },
};
const completedTool = {
    ...toolPart,
    value: { ...toolPart.value, state: 'completed', summary: 'done' },
};
reconcileAgentTimeline(feed, [completedMessage, completedTool], callbacks, rows);
assert.strictEqual(feed.children[0], stableMessage, 'message DOM identity must survive streaming completion');
assert.strictEqual(feed.children[1], stableTool, 'tool DOM identity must survive state transitions');
assert.equal(stableMessage.querySelector('.md-content p').dataset.mode, 'full');
assert.match(stableTool.querySelector('.agent-presentation-tool-title').textContent, /completed/);
assert.ok(postRendered.length >= 2, 'completed text and reasoning must run shared post processing');

const scheduled = [];
const flushed = [];
const batcher = createAnimationFrameBatcher({
    requestFrame: (callback) => { scheduled.push(callback); return scheduled.length; },
    cancelFrame: () => {},
    flush: (batch) => flushed.push(batch),
});
batcher.enqueue('item-1', 'a');
batcher.enqueue('item-1', 'ab');
batcher.enqueue('item-2', 'x');
assert.equal(scheduled.length, 1, 'multiple deltas in one frame must schedule one render');
scheduled.shift()();
assert.equal(flushed.length, 1);
assert.equal(flushed[0].get('item-1'), 'ab', 'the latest delta for a stable item must win within a frame');
assert.equal(flushed[0].get('item-2'), 'x');
batcher.dispose();
assert.equal(batcher.enqueue('item-3', 'ignored'), false);

dom.window.close();
console.log('Agent presentation contract, renderer, and stream batcher tests passed.');
