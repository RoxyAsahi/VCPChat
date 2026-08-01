import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentProjectionRepository, CodexProjectionProjector } = require('../modules/codex-runtime/projection/index.js');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-projection-'));

const migrationDb = new Database(path.join(root, 'projection-v5.sqlite'));
migrationDb.exec(`
    CREATE TABLE projection_schema (version INTEGER NOT NULL);
    INSERT INTO projection_schema(version) VALUES (5);
    CREATE TABLE projection_state (
        session_id TEXT PRIMARY KEY,
        next_source_order INTEGER NOT NULL DEFAULT 1,
        mutation_generation INTEGER NOT NULL DEFAULT 0,
        last_reconciled_at INTEGER,
        last_error TEXT,
        updated_at INTEGER NOT NULL
    );
`);
const migratedRepository = new AgentProjectionRepository({ db: migrationDb });
assert.equal(migratedRepository.schemaVersion, 6, 'schema 5 databases must migrate to schema 6');
assert.ok(migrationDb.prepare("PRAGMA table_info('projection_state')").all()
    .some((column) => column.name === 'activity_json' && String(column.dflt_value).includes('{}')),
    'schema 5 migration must add the durable Activity projection column');
migratedRepository.close();

const repository = new AgentProjectionRepository({ databasePath: path.join(root, 'projection.sqlite') });
assert.equal(repository.schemaVersion, 6);
repository.saveSession({
    sessionId: 'session_1',
    threadId: 'thr_1',
    agentId: 'Nova',
    configSnapshot: { model: 'Nova', developerInstructions: 'test' },
});
const projector = new CodexProjectionProjector(repository);
repository.updateActivity('session_1', {
    usage: { source: 'real', model: 'test-model', provider: 'vcp_toolbox', totalTokens: 42 },
    compaction: { state: 'completed', summary: 'durable summary', error: '' },
});
assert.equal(repository.readProjection('session_1').projection.activity.usage.totalTokens, 42,
    'session Activity metrics must be durable in Projection SQLite');
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
projector.projectNotification({ method: 'item/agentMessage/delta', params: {
    threadId: 'thr_1', itemId: 'item_1', delta: 'hello world',
} });
projector.projectNotification({ method: 'item/agentMessage/delta', params: {
    threadId: 'thr_1', itemId: 'item_1', delta: 'world!',
} });
projector.projectNotification({
    method: 'item/completed',
    params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        item: { id: 'item_1', type: 'agentMessage', text: 'hello world!', status: 'completed' },
    },
});
const projection = repository.readProjection('session_1');
assert.equal(projection.messages.length, 1);
assert.equal(projection.messages[0].blocks[0].content.text, 'hello world!',
    'incremental, cumulative, and overlapping deltas must not duplicate projection text');
assert.equal(projection.messages[0].status, 'completed');
projector.projectNotification({
    method: 'item/completed',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'marker_1', type: 'agentMessage', status: 'completed',
        text: 'safe<<<[TOOL_REQUEST]>>>{"tool":"PowerShellExecutor"}<<<[END_TOOL_REQUEST]>>>tail',
    } },
});
const marked = repository.readProjection('session_1').messages.find((message) => message.itemId === 'marker_1');
assert.equal(marked.blocks[0].content.text, 'safe\n[VCP 协议标记已移除]\ntail');
assert.equal(marked.blocks[1].kind, 'observation');
assert.equal(marked.blocks[1].content.marker.kind, 'protocol-warning');
assert.doesNotMatch(marked.blocks[0].content.text, /PowerShellExecutor/,
    'marker tool names must not remain in normal assistant text');
projector.projectNotification({
    method: 'item/started',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'reason_1', type: 'reasoning', summary: [] } },
});
projector.projectNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: { threadId: 'thr_1', itemId: 'reason_1', summaryIndex: 0, delta: 'first summary' },
});
projector.projectNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: { threadId: 'thr_1', itemId: 'reason_1', summaryIndex: 1, delta: 'second summary' },
});
projector.projectNotification({
    method: 'item/completed',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'reason_1', type: 'reasoning', status: 'completed', summary: [], content: [],
    } },
});
const reasoning = repository.readProjection('session_1').messages.find((message) => message.itemId === 'reason_1');
assert.equal(reasoning.blocks[0].content.text, 'first summary',
    'an empty completed reasoning item must not erase its streamed first block');
assert.equal(reasoning.blocks[1].content.text, 'second summary', 'reasoning deltas may create later summary blocks');
projector.projectNotification({
    method: 'item/started',
    params: {
        threadId: 'thr_1', turnId: 'turn_1',
        item: { id: 'compact_1', type: 'contextCompaction', status: 'inProgress', message: '正在整理本轮上下文。' },
    },
});
const compaction = repository.readProjection('session_1').messages.find((message) => message.itemId === 'compact_1');
assert.equal(compaction.blocks[0].content.text, '正在整理本轮上下文。',
    'context compaction must project a bounded presentation summary instead of raw item JSON');
projector.projectNotification({
    method: 'item/started',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'file_1', type: 'fileChange', status: 'inProgress',
        changes: [{ path: 'src/example.ts', kind: 'update', diff: '@@\n-old\n+new\n' }],
    } },
});
const fileChange = repository.readProjection('session_1').messages.find((message) => message.itemId === 'file_1');
assert.deepEqual(fileChange.blocks[0].content.changes.files[0], {
    path: 'src/example.ts', status: 'modified', patch: '@@\n-old\n+new\n', truncated: false, additions: 1, deletions: 1,
}, 'fileChange must preserve only Codex-origin structured diff data');
projector.projectNotification({
    method: 'item/completed',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'plan_1', type: 'plan', status: 'completed', text: '1. 收集证据\n2. 只读汇总',
    } },
});
const plan = repository.readProjection('session_1').messages.find((message) => message.itemId === 'plan_1');
assert.equal(plan.blocks[0].kind, 'observation');
assert.equal(plan.blocks[0].content.text, '1. 收集证据\n2. 只读汇总');
projector.reconcileThread('session_1', {
    id: 'thr_1',
    turns: [{
        id: 'turn_1',
        items: [{ id: 'item_1', type: 'agentMessage', text: 'authoritative text', status: 'completed' }],
    }],
});
const reconciled = repository.readProjection('session_1');
assert.ok(reconciled.messages.some((message) => message.itemId === 'reason_1'),
    'thread/read reconciliation must retain event-captured reasoning omitted by a sparse Codex Thread snapshot');
assert.ok(reconciled.messages.some((message) => message.itemId === 'file_1'),
    'thread/read reconciliation must retain durable tool and diff presentation items omitted by a sparse snapshot');
assert.equal(reconciled.messages.find((message) => message.itemId === 'item_1').blocks[0].content.text, 'authoritative text');
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
repository.setPinned('session_1', true);
assert.ok(repository.getSession('session_1').pinnedAt, 'pin must be durable VChat presentation metadata');
repository.archiveSession('session_1');
assert.equal(repository.listSessions().length, 0, 'archived Sessions must leave the default navigation list');
assert.equal(repository.listSessions({ archived: true })[0].sessionId, 'session_1');
repository.unarchiveSession('session_1');
assert.equal(repository.listSessions()[0].sessionId, 'session_1');
repository.setPinned('session_1', false);
assert.equal(repository.getSession('session_1').pinnedAt, null);
const pending = repository.enqueuePendingInput('session_1', { dedupeKey: 'same-message', prompt: 'continue after this turn' });
const repeated = repository.enqueuePendingInput('session_1', { dedupeKey: 'same-message', prompt: 'continue after this turn' });
assert.equal(pending.input_id, repeated.input_id, 'queued follow-ups must dedupe per Session');
assert.equal(repository.listPendingInputs('session_1')[0].prompt, 'continue after this turn');
repository.removePendingInput(pending.input_id);
assert.equal(repository.listPendingInputs('session_1').length, 0);
repository.close();
const reopenedRepository = new AgentProjectionRepository({ databasePath: path.join(root, 'projection.sqlite') });
const reopenedReasoning = reopenedRepository.readProjection('session_1').messages
    .find((message) => message.itemId === 'reason_1');
assert.equal(reopenedReasoning.blocks[0].content.text, 'first summary',
    'reasoning must survive a real SQLite close and reopen');
assert.equal(reopenedReasoning.blocks[1].content.text, 'second summary');
assert.ok(reopenedRepository.readProjection('session_1').messages.some((message) => message.itemId === 'file_1'),
    'tool and structured activity projection must survive a real SQLite close and reopen');
reopenedRepository.close();
fs.rmSync(root, { recursive: true, force: true });
console.log('Codex projection store tests passed.');
