import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentProjectionRepository, CodexProjectionProjector } = require('../modules/codex-runtime/projection/index.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-projection-'));
const repository = new AgentProjectionRepository({ databasePath: path.join(root, 'projection.sqlite') });
assert.equal(repository.schemaVersion, 3);
repository.saveSession({
    sessionId: 'session_1',
    threadId: 'thr_1',
    agentId: 'Nova',
    configSnapshot: { model: 'Nova', developerInstructions: 'test' },
});
const projector = new CodexProjectionProjector(repository);
assert.equal(projector.projectNotification({
    method: 'item/started',
    params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { id: 'item_1', type: 'agentMessage', text: '' },
    },
}), true);
projector.projectNotification({ method: 'item/agentMessage/delta', params: {
    threadId: 'thr_1', itemId: 'item_1', delta: 'hello',
} });
projector.projectNotification({ method: 'item/agentMessage/delta', params: {
    threadId: 'thr_1', itemId: 'item_1', delta: ' world',
} });
projector.projectNotification({
    method: 'item/completed',
    params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { id: 'item_1', type: 'agentMessage', text: 'hello world', status: 'completed' },
    },
});
const projection = repository.readProjection('session_1');
assert.equal(projection.messages.length, 1);
assert.equal(projection.messages[0].blocks[0].content.text, 'hello world');
assert.equal(projection.messages[0].status, 'completed');
projector.projectNotification({
    method: 'item/started',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'reason_1', type: 'reasoning', summary: [] } },
});
projector.projectNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: { threadId: 'thr_1', itemId: 'reason_1', summaryIndex: 1, delta: 'second summary' },
});
const reasoning = repository.readProjection('session_1').messages.find((message) => message.itemId === 'reason_1');
assert.equal(reasoning.blocks[1].content.text, 'second summary', 'reasoning deltas may create later summary blocks');
projector.reconcileThread('session_1', {
    id: 'thr_1',
    turns: [{
        id: 'turn_1',
        items: [{ id: 'item_1', type: 'agentMessage', text: 'authoritative text', status: 'completed' }],
    }],
});
const reconciled = repository.readProjection('session_1');
assert.deepEqual(reconciled.messages.map((message) => message.itemId), ['item_1'],
    'thread/read reconciliation must remove projection items absent from the Codex Thread');
assert.equal(reconciled.messages[0].blocks[0].content.text, 'authoritative text');
// A `thread/read` snapshot is obtained asynchronously. If a live Item lands
// after the read began, reconciliation must not delete that newer projection.
const generationBeforeStaleRead = repository.projectionGeneration('session_1');
projector.projectNotification({
    method: 'item/started',
    params: { threadId: 'thr_1', turnId: 'turn_2', item: { id: 'item_live', type: 'agentMessage', text: 'new live item' } },
});
const staleReconcile = projector.reconcileThread('session_1', {
    id: 'thr_1',
    turns: [{ id: 'turn_1', items: [{ id: 'item_1', type: 'agentMessage', text: 'stale snapshot', status: 'completed' }] }],
}, generationBeforeStaleRead);
assert.equal(staleReconcile.applied, false, 'a stale thread/read must not mutate the SQLite projection');
assert.ok(repository.readProjection('session_1').messages.some((message) => message.itemId === 'item_live'));
assert.equal(projector.projectNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr_missing', itemId: 'item_1', delta: 'x' },
}), false);
repository.markOrphaned('session_1');
assert.equal(repository.getSession('session_1').orphaned, true);
repository.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('Codex projection store tests passed.');
