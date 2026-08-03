import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
    classifyAgentMessageGroups,
    createAgentTimelineParts,
    groupConsecutiveToolParts,
    projectVcpToolPresentation,
    reconcileAgentTimeline,
    timelinePartKey,
} from '../modules/ui-system/agent-workbench-timeline.js';

const state = {
    messages: [
        {
            id: 'message-before', role: 'assistant', content: 'before',
            firstSequence: 10, createdAt: 10,
            reasoning: 'reasoning', attachments: [{ id: 'attachment-1' }],
        },
        { id: 'message-after', role: 'assistant', content: 'after', firstSequence: 12, createdAt: 12 },
    ],
    tools: new Map([['tool-1', {
        toolCallId: 'tool-1', name: 'vcp_invoke', firstSequence: 11, firstTimestamp: 11,
    }]]),
    // Activity-only daemon projections must never be made into feed rows.
    approvals: [{ approvalId: 'approval-1' }],
    toolboxWs: [{ id: 'Info:notification:1' }],
};

const parts = createAgentTimelineParts(state);
assert.deepEqual(parts.map(timelinePartKey), [
    'message:message-before', 'tool:tool-1', 'message:message-after',
]);
assert.deepEqual(parts[0].blocks.map((block) => block.kind), ['message', 'reasoning', 'attachment'],
    'a message projection must explicitly retain its renderer-only subparts');
assert.deepEqual(projectVcpToolPresentation({ payload: { toolName: 'FileOperator' } }), {
    icon: 'folder', label: 'FileOperator', kind: 'file', target: 'FileOperator', fallback: false,
});
assert.equal(projectVcpToolPresentation({ payload: { toolName: 'PluginFromToolBox' } }).kind, 'unknown',
    'an unknown ToolBox target must remain a display-only fallback rather than being rewritten');

const groupedParts = groupConsecutiveToolParts([
    { kind: 'message', id: 'm1', messageId: 'm1', turnId: 'turn-1' },
    { kind: 'tool', id: 'a', toolCallId: 'a', turnId: 'turn-1', value: { toolCallId: 'a' }, blocks: [] },
    { kind: 'tool', id: 'b', toolCallId: 'b', turnId: 'turn-1', value: { toolCallId: 'b' }, blocks: [] },
    { kind: 'message', id: 'm2', messageId: 'm2', turnId: 'turn-1' },
    { kind: 'tool', id: 'c', toolCallId: 'c', turnId: 'turn-1', value: { toolCallId: 'c' }, blocks: [] },
    { kind: 'tool', id: 'd', toolCallId: 'd', turnId: 'turn-2', value: { toolCallId: 'd' }, blocks: [] },
    { kind: 'tool', id: 'orphan', toolCallId: 'orphan', turnId: null, value: { toolCallId: 'orphan' }, blocks: [] },
]);
assert.deepEqual(groupedParts.map(timelinePartKey), [
    'message:m1', 'tool-group:a', 'message:m2', 'tool:c', 'tool:d', 'tool:orphan',
], 'only adjacent tools with the same explicit turn identity may share a display group');
assert.deepEqual(groupedParts[1].toolCallIds, ['a', 'b']);

const messageGroups = classifyAgentMessageGroups([
    { kind: 'message', id: 'user-1', messageId: 'user-1', turnId: 'turn-1', value: { role: 'user' } },
    { kind: 'message', id: 'assistant-1', messageId: 'assistant-1', turnId: 'turn-1', value: { role: 'assistant', agentId: 'nova' } },
    { kind: 'tool', id: 'tool-1', toolCallId: 'tool-1', turnId: 'turn-1', value: {} },
    { kind: 'message', id: 'assistant-2', messageId: 'assistant-2', turnId: 'turn-1', value: { role: 'assistant', agentId: 'nova' } },
    { kind: 'message', id: 'assistant-3', messageId: 'assistant-3', turnId: 'turn-2', value: { role: 'assistant', agentId: 'nova' } },
    { kind: 'message', id: 'assistant-4', messageId: 'assistant-4', turnId: 'turn-2', value: { role: 'assistant', agentId: 'other' } },
]);
assert.equal(messageGroups.get('message:assistant-1').position, 'first');
assert.equal(messageGroups.get('tool:tool-1').position, 'continuation');
assert.equal(messageGroups.get('message:assistant-2').position, 'continuation',
    'tool activity in the same Turn must not restart the Agent avatar');
assert.equal(messageGroups.get('message:assistant-3').position, 'first', 'a new Turn must show the avatar again');
assert.equal(messageGroups.get('message:assistant-4').position, 'first', 'a different Agent must show its avatar');

const dom = new JSDOM('<!doctype html><div id="feed"></div>');
const feed = dom.window.document.getElementById('feed');
feed.replaceChildren = () => { throw new Error('timeline reconciliation must not clear the feed'); };
const rows = new Map();
const create = (part) => {
    const node = dom.window.document.createElement('article');
    node.dataset.createdFor = timelinePartKey(part);
    node.textContent = part.value.content || part.value.name;
    if (part.kind === 'message' && part.value.role === 'assistant') {
        const avatar = dom.window.document.createElement('img');
        avatar.className = 'chat-avatar';
        node.append(avatar);
    }
    return node;
};
const patch = (node, part) => { node.textContent = `${part.value.content || part.value.name}:patched`; };

reconcileAgentTimeline(feed, parts, { create, patch }, rows);
const stableMessage = feed.firstElementChild;
const stableTool = feed.children[1];
const updated = createAgentTimelineParts({
    ...state,
    messages: state.messages.map((message) => message.id === 'message-before' ? { ...message, content: 'before+' } : message),
    tools: new Map([['tool-1', { ...state.tools.get('tool-1'), state: 'completed' }]]),
});
reconcileAgentTimeline(feed, updated, { create, patch }, rows);
assert.strictEqual(feed.firstElementChild, stableMessage, 'messageId must retain its existing row');
assert.strictEqual(feed.children[1], stableTool, 'toolCallId must retain its existing row');
assert.match(stableMessage.textContent, /before\+:patched/);

const groupedDomParts = [
    { kind: 'message', id: 'group-a', messageId: 'group-a', turnId: 'turn-group', value: { role: 'assistant', agentId: 'nova', content: 'a' } },
    { kind: 'message', id: 'group-b', messageId: 'group-b', turnId: 'turn-group', value: { role: 'assistant', agentId: 'nova', content: 'b' } },
];
reconcileAgentTimeline(feed, groupedDomParts, { create, patch }, rows);
assert.equal(feed.children[0].dataset.agentAvatarPosition, 'first');
assert.equal(feed.children[1].dataset.agentAvatarPosition, 'continuation');
assert.equal(feed.children[0].querySelector('.chat-avatar').hasAttribute('aria-hidden'), false);
assert.equal(feed.children[1].querySelector('.chat-avatar').getAttribute('aria-hidden'), 'true');

dom.window.close();
console.log('Agent Workbench timeline adapter tests passed.');
