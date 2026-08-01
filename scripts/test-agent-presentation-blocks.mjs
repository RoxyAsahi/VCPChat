import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

import { createAgentBlockPresentation } from '../modules/ui-system/agent-presentation/blocks/registry.js';

const workbenchSource = await readFile(new URL('../modules/ui-system/agent-workbench.js', import.meta.url), 'utf8');
assert.match(workbenchSource, /createAgentBlockPresentation/);
for (const removedRenderer of [
    'function createToolCard',
    'function patchToolCard',
    'function createApprovalCard',
    'function createToolboxWsCard',
    'function createMarkerObservationCard',
]) {
    assert.doesNotMatch(workbenchSource, new RegExp(removedRenderer), `${removedRenderer} must stay in Presentation, not Workbench`);
}

const dom = new JSDOM('<!doctype html><div id="feed"></div>');
const { document, MouseEvent } = dom.window;
const cancelled = [];
const backendDecisions = [];
const rendered = [];
const presentation = createAgentBlockPresentation({
    document,
    renderContent: (text) => `<p>${String(text)}</p>`,
    postRender: (element) => rendered.push(element),
    actions: {
        cancelTool: (tool) => cancelled.push(tool.payload?.revision),
        respondToolboxApproval: (approvalId, decision) => backendDecisions.push([approvalId, decision]),
    },
});

const running = {
    kind: 'tool', id: 'call-1', toolCallId: 'call-1',
    value: {
        toolCallId: 'call-1', name: 'FileOperator', state: 'running',
        payload: { toolName: 'FileOperator', revision: 'running', arguments: { path: 'package.json' } },
    },
};
const card = presentation.timelineCallbacks.create(running);
assert.equal(card.dataset.toolCallId, 'call-1');
assert.ok(card.classList.contains('vcp-tool-call-summary-bubble'),
    'Agent tools must use the main-chat VCP tool summary visual contract');
assert.ok(card.querySelector('.vcp-tool-call-summary-header'));
assert.equal(card.dataset.status, 'running');
assert.match(card.textContent, /FileOperator/);
assert.ok(card.querySelector('.agent-chat-tool-cancel'));
card.querySelector('.agent-chat-tool-cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }));
assert.deepEqual(cancelled, ['running']);

const completed = {
    ...running,
    value: {
        ...running.value,
        state: 'completed',
        payload: {
            ...running.value.payload,
            revision: 'complete',
            result: 'first result',
            resources: [{ uri: 'file:///package.json' }],
            warnings: ['display only'],
            task: { id: 'task-1', state: 'accepted' },
        },
    },
};
assert.strictEqual(presentation.timelineCallbacks.patch(card, completed), card);
assert.equal(card.dataset.status, 'completed');
assert.equal(card.querySelector('.agent-chat-tool-cancel'), null, 'terminal transition must remove stale cancel action');
assert.ok(card.querySelector('.agent-chat-tool-chevron'));
card.querySelector('.agent-chat-tool-chevron').dispatchEvent(new MouseEvent('click', { bubbles: true }));
assert.ok(card.querySelector('.vcp-tool-result-bubble'));
assert.ok(card.querySelector('.vcp-tool-use-bubble'));
assert.match(card.querySelector('.agent-chat-tool-detail-result').textContent, /first result/);
assert.match(card.querySelector('.agent-chat-tool-resource-list').textContent, /package\.json/);
assert.match(card.querySelector('.agent-chat-tool-warning-list').textContent, /display only/);
assert.match(card.querySelector('.agent-chat-tool-task').textContent, /task-1/);

const updated = {
    ...completed,
    value: { ...completed.value, payload: { ...completed.value.payload, revision: 'updated', result: 'latest result' } },
};
presentation.timelineCallbacks.patch(card, updated);
assert.match(card.querySelector('.agent-chat-tool-detail-result').textContent, /latest result/,
    'expanded detail must read the latest projection payload');
assert.ok(rendered.length >= 2);

const approvals = [];
const approvalRegistry = new Map();
const approval = presentation.createApproval({
    approvalId: 'approval-1', sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1',
    argumentsHash: 'hash-1', toolName: 'FileOperator', riskLevel: 'high', expiresAtMs: Date.now() + 10_000,
}, {
    registry: approvalRegistry,
    ensureTicker: () => {},
    onDecision: (item, decision) => approvals.push([item.approvalId, decision]),
});
assert.match(approval.textContent, /session-1/);
approval.querySelector('.agent-chat-approval-actions .secondary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
approval.querySelector('.agent-chat-approval-actions .danger').dispatchEvent(new MouseEvent('click', { bubbles: true }));
assert.deepEqual(approvals, [['approval-1', 'allow']], 'approval action must be exactly once');
assert.equal(approvalRegistry.has('approval-1'), false);

const toolbox = presentation.createToolboxObservation({
    kind: 'backend-approval-request', channel: 'VCPLog',
    value: { requestId: 'toolbox-approval-1', toolName: 'PowerShellExecutor', approvalTtlMs: 60_000 },
});
assert.match(toolbox.textContent, /未关联/);
toolbox.querySelector('.agent-chat-approval-actions .danger').dispatchEvent(new MouseEvent('click', { bubbles: true }));
toolbox.querySelector('.agent-chat-approval-actions .secondary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
assert.deepEqual(backendDecisions, [['toolbox-approval-1', 'deny']], 'ToolBox approval action must be exactly once');

const marker = presentation.createMarkerObservation({ kind: 'dynamic-fold', summary: '摘要', detail: '完整内容' });
marker.querySelector('.agent-chat-toolbox-ws-summary').dispatchEvent(new MouseEvent('click', { bubbles: true }));
assert.equal(marker.querySelector('.agent-chat-toolbox-ws-output').hidden, false);

const unknown = presentation.timelineCallbacks.create({ kind: 'future-block', id: 'future-1' });
assert.equal(unknown.getAttribute('role'), 'alert');
assert.match(unknown.textContent, /暂不支持/);

dom.window.close();
console.log('Agent structured Block registry tests passed.');
