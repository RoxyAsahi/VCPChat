import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentProjectionRepository, CodexProjectionProjector } = require('../modules/codex-runtime/projection/index.js');
const { migrate } = require('../modules/codex-runtime/projection/migrations.js');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-projection-'));

const quickCheckDatabase = new Database(':memory:');
const quickCheckFailure = new Proxy(quickCheckDatabase, {
    get(target, property) {
        if (property === 'pragma') return (statement, options) => (
            statement === 'quick_check' ? 'fixture-corrupt' : target.pragma(statement, options)
        );
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
    },
});
assert.throws(() => migrate(quickCheckFailure), /quick_check failed: fixture-corrupt/,
    'projection startup must fail before schema mutation when SQLite quick_check is not ok');
quickCheckDatabase.close();

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
assert.equal(migratedRepository.schemaVersion, 11, 'schema 5 databases must migrate to schema 11');
assert.ok(migrationDb.prepare("PRAGMA table_info('projection_state')").all()
    .some((column) => column.name === 'activity_json' && String(column.dflt_value).includes('{}')),
    'schema 5 migration must add the durable Activity projection column');
migratedRepository.close();

const repository = new AgentProjectionRepository({ databasePath: path.join(root, 'projection.sqlite') });
assert.equal(repository.schemaVersion, 11);
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
assert.equal(projector.projectNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr_1', itemId: 'delta_before_item', delta: 'buffered first' },
}), true);
projector.projectNotification({
    method: 'item/started',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'delta_before_item', type: 'agentMessage', text: '', status: 'inProgress',
    } },
});
assert.equal(repository.readProjection('session_1').messages
    .find((message) => message.itemId === 'delta_before_item').blocks[0].content.text, 'buffered first',
    'a bounded delta received before item/started must replay after Item creation');
assert.equal(projector.projectNotification({
    method: 'item/reasoning/summaryPartAdded',
    params: { threadId: 'thr_1', itemId: 'reasoning_before_item', summaryIndex: 0 },
}), true);
assert.equal(projector.projectNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: { threadId: 'thr_1', itemId: 'reasoning_before_item', summaryIndex: 0, delta: 'buffered reasoning' },
}), true);
projector.projectNotification({
    method: 'item/started',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'reasoning_before_item', type: 'reasoning', summary: [], content: [], status: 'inProgress',
    } },
});
assert.deepEqual(repository.readProjection('session_1').messages
    .find((message) => message.itemId === 'reasoning_before_item').blocks[0].content.summary,
['buffered reasoning'], 'reasoning slots and deltas must replay together after Item creation');

let pendingClock = 1_000;
const pendingTimers = [];
const scheduledReconciles = [];
const pendingProjector = new CodexProjectionProjector(repository, {
    pendingDeltaTtlMs: 10,
    maxPendingDeltaItems: 1,
    maxPendingDeltasPerItem: 2,
    maxPendingDeltaBytesPerItem: 32,
    maxPendingDeltaBytes: 32,
    clock: () => pendingClock,
    setTimer: (callback, delay) => {
        const timer = { callback, delay, cleared: false, unref() {} };
        pendingTimers.push(timer);
        return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    scheduleReconcile: async (details) => { scheduledReconciles.push(details); },
});
assert.equal(pendingProjector.projectNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr_1', itemId: 'expires_before_start', delta: 'orphaned' },
}), true);
assert.equal(pendingProjector.pendingDeltas.size, 1);
assert.equal(pendingTimers.at(-1).delay, 10);
pendingClock += 11;
pendingTimers.at(-1).callback();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pendingProjector.pendingDeltas.size, 0);
assert.match(repository.readProjection('session_1').projection.lastError,
    /pending delta expired before item\/started/);
assert.deepEqual(scheduledReconciles.map(({ sessionId, itemId }) => ({ sessionId, itemId })), [{
    sessionId: 'session_1', itemId: 'expires_before_start',
}], 'an expired delta buffer must schedule one Session-scoped reconcile');

assert.equal(pendingProjector.projectNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr_1', itemId: 'capacity_oldest', delta: 'first' },
}), true);
assert.equal(pendingProjector.projectNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr_1', itemId: 'capacity_newest', delta: 'second' },
}), true);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(pendingProjector.pendingDeltas.size, 1,
    'the Main-only pending delta map must remain globally bounded');
assert.equal(pendingProjector.pendingDeltas.has('thr_1:capacity_newest'), true,
    'capacity pressure must retain the newest pending Item');
assert.match(repository.readProjection('session_1').projection.lastError,
    /pending delta item limit exceeded/);
const activeTimer = pendingProjector.pendingDeltaTimer;
pendingProjector.dispose();
assert.equal(activeTimer.cleared, true, 'Runtime disposal must release pending delta timers');
assert.equal(pendingProjector.pendingDeltas.size, 0);
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
const projectedItem = projection.messages.find((message) => message.itemId === 'item_1');
assert.equal(projectedItem.blocks[0].content.text, 'hello world!',
    'incremental, cumulative, and overlapping deltas must not duplicate projection text');
assert.equal(projectedItem.status, 'completed');
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
    method: 'item/completed',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'marker_reconcile', type: 'agentMessage', status: 'completed',
        text: 'visible<<<[TOOL_REQUEST]>>>{"tool":"FileOperator"}<<<[END_TOOL_REQUEST]>>>tail',
    } },
});
assert.equal(repository.readProjection('session_1').messages
    .find((message) => message.itemId === 'marker_reconcile').blocks.length, 2);
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
    method: 'item/reasoning/textDelta',
    params: { threadId: 'thr_1', itemId: 'reason_1', contentIndex: 0, delta: 'private detail' },
});
const liveReasoning = repository.readProjection('session_1').messages.find((message) => message.itemId === 'reason_1');
assert.deepEqual(liveReasoning.blocks[0].content.summary, ['first summary', 'second summary']);
assert.deepEqual(liveReasoning.blocks[0].content.content, ['private detail'],
    'summaryIndex and contentIndex must never collide');
projector.projectNotification({
    method: 'item/completed',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'reason_1', type: 'reasoning', status: 'completed', summary: [], content: [],
    } },
});
const reasoning = repository.readProjection('session_1').messages.find((message) => message.itemId === 'reason_1');
assert.deepEqual(reasoning.blocks[0].content.summary, [],
    'an explicit completed summary array may clear streamed summary parts');
assert.deepEqual(reasoning.blocks[0].content.content, [],
    'an explicit completed content array may clear streamed reasoning content');
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
    method: 'item/completed',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'reason_clear', type: 'reasoning', status: 'completed', summary: ['old'], content: ['preserve-me'],
    } },
});
projector.projectNotification({
    method: 'item/completed',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'compact_clear', type: 'contextCompaction', status: 'completed', summary: 'old summary',
    } },
});
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
        id: 'dynamic_tool_1', type: 'dynamicToolCall', status: 'completed',
        tool: 'vcp_invoke', arguments: { tool: 'FileOperator', arguments: { action: 'list' } },
        contentItems: [{ type: 'inputText', text: 'tool result' }], success: true,
    } },
});
const dynamicTool = repository.readProjection('session_1').messages.find((message) => message.itemId === 'dynamic_tool_1');
assert.equal(dynamicTool.blocks[0].authority, 'toolbox',
    'VCP dynamic tool display Blocks must remain outside Codex snapshot deletion');
assert.equal(dynamicTool.blocks[0].content.item.wrapperTool, 'vcp_invoke');
assert.equal(dynamicTool.blocks[0].content.item.tool, 'FileOperator');
assert.deepEqual(dynamicTool.blocks[0].content.item.arguments, { action: 'list' });
projector.projectNotification({
    method: 'item/completed',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'plan_1', type: 'plan', status: 'completed', text: '1. 收集证据\n2. 只读汇总',
    } },
});
const plan = repository.readProjection('session_1').messages.find((message) => message.itemId === 'plan_1');
assert.equal(plan.blocks[0].kind, 'observation');
assert.equal(plan.blocks[0].content.text, '1. 收集证据\n2. 只读汇总');
projector.projectNotification({
    method: 'item/started',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'future_item', type: 'futureProtocolItem', status: 'inProgress',
        arguments: { secret: 'must-not-persist' }, name: 'bounded future item',
        path: 'C:\\private\\absolute.txt', command: 'print-sensitive-command', query: 'private search terms',
    } },
});
const unknown = repository.readProjection('session_1').messages
    .find((message) => message.itemId === 'future_item').blocks[0].content;
assert.equal(unknown.unknown.type, 'futureProtocolItem');
assert.equal(Object.prototype.hasOwnProperty.call(unknown.unknown, 'arguments'), false,
    'unknown protocol Items must use a bounded sanitized fallback');
assert.equal(Object.prototype.hasOwnProperty.call(unknown.unknown, 'path'), false);
assert.equal(Object.prototype.hasOwnProperty.call(unknown.unknown, 'command'), false);
assert.equal(Object.prototype.hasOwnProperty.call(unknown.unknown, 'query'), false);
assert.ok(unknown.unknown.fields.includes('path'),
    'unknown protocol diagnostics may retain bounded field names but never their values');
assert.doesNotMatch(JSON.stringify(unknown), /private|sensitive/i,
    'unknown protocol values must not reach SQLite or the Renderer contract');
repository.upsertItem('session_1', {
    threadId: 'thr_1', turnId: 'turn_local', itemId: 'local_observation', role: 'system', status: 'completed',
}, {
    kind: 'observation', status: 'completed', ordinal: 0, authority: 'vchat', content: { text: 'local-only' },
});
repository.upsertItem('session_1', {
    threadId: 'thr_1', turnId: 'turn_mixed', itemId: 'mixed_observation', role: 'assistant', status: 'completed',
}, [{
    kind: 'message', status: 'completed', ordinal: 0, authority: 'codex', content: { text: 'stale codex content' },
}, {
    kind: 'observation', status: 'completed', ordinal: 1, authority: 'toolbox', content: { text: 'durable local observation' },
}]);
const authoritativeReconcile = projector.reconcileThread('session_1', {
    id: 'thr_1',
    turns: [{
        id: 'turn_1',
        itemsView: 'full',
        items: [
            { id: 'marker_reconcile', type: 'agentMessage', text: 'plain authoritative text', status: 'completed' },
            { id: 'item_1', type: 'agentMessage', text: 'authoritative text', status: 'completed' },
            { id: 'reason_clear', type: 'reasoning', status: 'completed', summary: [] },
            { id: 'compact_clear', type: 'contextCompaction', status: null, summary: '' },
        ],
    }],
});
assert.equal(authoritativeReconcile.patch.baseProjectionRevision < authoritativeReconcile.patch.projectionRevision, true);
assert.ok(authoritativeReconcile.patch.deleteBlockIds.length > 0,
    'full reconciliation must report exact deleted Codex Blocks');
assert.equal(authoritativeReconcile.patch.deleteBlockIds.includes('block:session_1:dynamic_tool_1:0'), false,
    'ToolBox-owned Blocks are outside Codex deletion authority');
const reconciled = repository.readProjection('session_1');
assert.ok(reconciled.messages.findIndex((message) => message.itemId === 'marker_reconcile')
    < reconciled.messages.findIndex((message) => message.itemId === 'item_1'),
    'full reconciliation must repair Codex Item order from the authoritative Turn snapshot');
assert.ok(reconciled.messages.findIndex((message) => message.itemId === 'local_observation')
    < reconciled.messages.findIndex((message) => message.itemId === 'mixed_observation'),
    'full reconciliation must preserve the relative order of VChat/ToolBox local messages');
assert.equal(reconciled.messages.some((message) => message.itemId === 'reason_1'), false,
    'thread/read reconciliation must remove Codex items absent from the authoritative snapshot');
assert.equal(reconciled.messages.some((message) => message.itemId === 'file_1'), false,
    'thread/read reconciliation must remove stale tool and diff items absent from the authoritative snapshot');
const preservedDynamicTool = reconciled.messages.find((message) => message.itemId === 'dynamic_tool_1');
assert.ok(preservedDynamicTool,
    'thread/read reconciliation must preserve a completed VCP dynamic tool omitted by App Server history');
assert.equal(preservedDynamicTool.blocks[0].authority, 'toolbox');
const localObservation = reconciled.messages.find((message) => message.itemId === 'local_observation');
assert.equal(localObservation.blocks.length, 1,
    'thread/read reconciliation must preserve local-only observations absent from the Codex snapshot');
assert.equal(localObservation.blocks[0].authority, 'vchat');
const mixedObservation = reconciled.messages.find((message) => message.itemId === 'mixed_observation');
assert.equal(mixedObservation.blocks.length, 1,
    'thread/read reconciliation must remove stale Codex Blocks without deleting local Blocks on the same Message');
assert.equal(mixedObservation.blocks[0].authority, 'toolbox');
assert.equal(mixedObservation.blocks[0].content.text, 'durable local observation');
assert.equal(reconciled.messages.find((message) => message.itemId === 'item_1').blocks[0].content.text, 'authoritative text');
assert.equal(reconciled.messages.find((message) => message.itemId === 'marker_reconcile').blocks.length, 1,
    'authoritative reconciliation must delete stale Codex-owned Blocks absent from the snapshot');
const clearedReasoning = reconciled.messages.find((message) => message.itemId === 'reason_clear').blocks[0].content;
assert.deepEqual(clearedReasoning.summary, [], 'an explicit empty snapshot array must clear stale content');
assert.deepEqual(clearedReasoning.content, ['preserve-me'], 'a snapshot-omitted optional field must preserve live content');
const clearedCompaction = reconciled.messages.find((message) => message.itemId === 'compact_clear').blocks[0].content;
assert.equal(clearedCompaction.text, '', 'an explicit empty compaction summary must clear stale text');
assert.equal(clearedCompaction.phase, null, 'an explicit null compaction status must clear stale phase data');
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
assert.equal(projector.reconcileThread('session_1', {
    id: 'wrong-thread', turns: [{ id: 'turn_1', itemsView: 'full', items: [] }],
}).reason, 'thread-identity-mismatch');
const missingItemsViewReconcile = projector.reconcileThread('session_1', {
    id: 'thr_1', turns: [{ id: 'turn_1', items: [{
        id: 'missing-view-item', type: 'agentMessage', text: 'unverified history shape', status: 'completed',
    }] }],
});
assert.equal(missingItemsViewReconcile.partial, true,
    'a Turn without explicit itemsView=full must not receive deletion authority');
assert.ok(repository.readProjection('session_1').messages.some((message) => message.itemId === 'item_live'),
    'missing itemsView must preserve durable Items that were not returned');
const partialReconcile = projector.reconcileThread('session_1', {
    id: 'thr_1', turns: [{ id: 'turn_1', itemsView: 'summary', items: [{
        id: 'partial-summary-item', type: 'agentMessage', text: 'summary only', status: 'completed',
    }] }],
});
assert.equal(partialReconcile.applied, true);
assert.equal(partialReconcile.partial, true);
assert.ok(repository.readProjection('session_1').messages.some((message) => message.itemId === 'partial-summary-item'),
    'partial history may upsert returned Items');
assert.ok(repository.readProjection('session_1').messages.some((message) => message.itemId === 'item_live'),
    'summary/notLoaded thread/read payloads cannot delete durable Items');
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
assert.equal(pending.inputId, repeated.inputId, 'queued follow-ups must dedupe per Session');
assert.equal(repository.listPendingInputs('session_1')[0].prompt, 'continue after this turn');
repository.removePendingInput(pending.inputId);
assert.equal(repository.listPendingInputs('session_1').length, 0);
repository.close();
const reopenedRepository = new AgentProjectionRepository({ databasePath: path.join(root, 'projection.sqlite') });
const reopenedMessages = reopenedRepository.readProjection('session_1').messages;
assert.equal(reopenedMessages.find((message) => message.itemId === 'item_1')?.blocks[0].content.text,
    'authoritative text', 'the reconciled authoritative projection must survive a real SQLite close and reopen');
assert.equal(reopenedMessages.some((message) => message.itemId === 'reason_1'), false);
reopenedRepository.close();
const readOnlyRepository = new AgentProjectionRepository({
    databasePath: path.join(root, 'projection.sqlite'), readOnly: true, degradedReason: 'fixture write failure',
});
assert.equal(readOnlyRepository.readProjection('session_1').storage.readOnly, true,
    'a degraded projection store must remain readable');
assert.throws(() => readOnlyRepository.assertWritable(), (error) => error.code === 'PROJECTION_READ_ONLY');
readOnlyRepository.close();
const backupDatabasePath = path.join(root, 'projection-backup.sqlite');
const backupSeed = new AgentProjectionRepository({ databasePath: backupDatabasePath });
backupSeed.close();
const downgraded = new Database(backupDatabasePath);
downgraded.prepare('UPDATE projection_schema SET version = 6').run();
downgraded.close();
const migratedFromDisk = new AgentProjectionRepository({ databasePath: backupDatabasePath });
assert.equal(migratedFromDisk.schemaVersion, 11);
migratedFromDisk.close();
assert.equal(fs.existsSync(`${backupDatabasePath}.schema-6.bak`), true,
    'an on-disk schema migration must create a versioned backup before mutation');

const recoveryDatabasePath = path.join(root, 'projection-legacy-tool-recovery.sqlite');
const recoverySeed = new AgentProjectionRepository({ databasePath: recoveryDatabasePath });
recoverySeed.saveSession({ sessionId: 'legacy-session', threadId: 'legacy-thread', agentId: 'Nova' });
recoverySeed.close();
const recoveryCurrent = new Database(recoveryDatabasePath);
recoveryCurrent.prepare('UPDATE projection_schema SET version = 10').run();
recoveryCurrent.close();
const legacyBackup = new Database(`${recoveryDatabasePath}.schema-6.bak`);
legacyBackup.exec(`
    CREATE TABLE projection_schema (version INTEGER NOT NULL);
    INSERT INTO projection_schema(version) VALUES (6);
    CREATE TABLE agent_messages (
        message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT, codex_item_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
        source_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE agent_blocks (
        block_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        ordinal INTEGER NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
`);
const legacyNow = Date.now();
legacyBackup.prepare(`INSERT INTO agent_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('legacy-tool-message', 'legacy-session', 'legacy-thread', 'legacy-turn', 'legacy-tool-item',
        'tool', 'completed', 4, legacyNow, legacyNow);
legacyBackup.prepare(`INSERT INTO agent_blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('legacy-tool-block', 'legacy-tool-message', 'tool', 'completed', 0, JSON.stringify({
        item: { id: 'legacy-tool-item', type: 'dynamicToolCall', tool: 'vcp_invoke', arguments: { tool: 'FileOperator' } },
    }), legacyNow, legacyNow);
legacyBackup.close();
const recoveredRepository = new AgentProjectionRepository({ databasePath: recoveryDatabasePath });
assert.equal(recoveredRepository.schemaVersion, 11);
const recoveredTool = recoveredRepository.readProjection('legacy-session').messages
    .find((message) => message.itemId === 'legacy-tool-item');
assert.equal(recoveredTool?.blocks[0]?.authority, 'toolbox',
    'schema 11 may recover only a verified dynamic tool receipt from the fixed schema 6 backup');
assert.ok(recoveredRepository.db.prepare('SELECT next_source_order FROM projection_state WHERE session_id = ?')
    .get('legacy-session').next_source_order >= 5,
    'legacy recovery must advance the Session source-order watermark before future live events arrive');
recoveredRepository.close();
const reopenedRecoveredRepository = new AgentProjectionRepository({ databasePath: recoveryDatabasePath });
assert.equal(reopenedRecoveredRepository.readProjection('legacy-session').messages
    .filter((message) => message.itemId === 'legacy-tool-item').length, 1,
    'legacy tool recovery must be idempotent after the schema is upgraded');
reopenedRecoveredRepository.close();
const foreignKeyDatabasePath = path.join(root, 'projection-foreign-key.sqlite');
const foreignKeySeed = new AgentProjectionRepository({ databasePath: foreignKeyDatabasePath });
foreignKeySeed.close();
const foreignKeyDatabase = new Database(foreignKeyDatabasePath);
foreignKeyDatabase.pragma('foreign_keys = OFF');
foreignKeyDatabase.prepare(`
    INSERT INTO agent_messages (
        message_id, session_id, codex_thread_id, codex_turn_id, codex_item_id,
        role, status, source_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run('orphan-message', 'missing-session', 'missing-thread', null, 'orphan-item',
    'assistant', 'completed', 1, Date.now(), Date.now());
foreignKeyDatabase.close();
assert.throws(() => new AgentProjectionRepository({ databasePath: foreignKeyDatabasePath }), /foreign_key_check failed/,
    'writable startup must reject a database with broken Session ownership');
assert.throws(() => new AgentProjectionRepository({
    databasePath: foreignKeyDatabasePath, readOnly: true, degradedReason: 'fixture',
}), /foreign_key_check failed in read-only mode/,
'read-only degraded mode must not silently expose an integrity-broken projection');
fs.rmSync(root, { recursive: true, force: true });
console.log('Codex projection store tests passed.');
