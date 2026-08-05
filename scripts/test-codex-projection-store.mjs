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

const unsupportedDb = new Database(':memory:');
unsupportedDb.exec('CREATE TABLE projection_schema (version INTEGER NOT NULL); INSERT INTO projection_schema VALUES (5)');
assert.throws(() => migrate(unsupportedDb), /minimum migratable schema is 6/,
    'schemas older than the supported migration floor must fail closed');
unsupportedDb.close();

const migrationDb = new Database(path.join(root, 'projection-v6.sqlite'));
migrationDb.exec(`
    CREATE TABLE projection_schema (version INTEGER NOT NULL);
    INSERT INTO projection_schema(version) VALUES (6);
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
assert.equal(migratedRepository.schemaVersion, 12, 'schema 6 databases must migrate to schema 12');
assert.ok(migrationDb.prepare("PRAGMA table_info('projection_state')").all()
    .some((column) => column.name === 'activity_json' && String(column.dflt_value).includes('{}')),
    'schema 6 migration must add the durable Activity projection column');
migratedRepository.close();

const repository = new AgentProjectionRepository({ databasePath: path.join(root, 'projection.sqlite') });
assert.equal(repository.schemaVersion, 12);
repository.saveSession({
    sessionId: 'session_1',
    threadId: 'thr_1',
    agentId: 'Nova',
    configSnapshot: { model: 'Nova', developerInstructions: 'test' },
});
const protocolDiagnostics = [];
const projector = new CodexProjectionProjector(repository, {
    onProtocolDiagnostic: (diagnostic) => protocolDiagnostics.push(diagnostic),
});
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
    method: 'item/started',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'unknown_1', type: 'futureSecretItem', status: 'inProgress',
        name: 'bounded fallback', secretPayload: 'must-not-enter-diagnostics',
    } },
});
projector.projectNotification({
    method: 'item/completed',
    params: { threadId: 'thr_1', turnId: 'turn_1', item: {
        id: 'unknown_1', type: 'futureSecretItem', status: 'completed',
        name: 'bounded fallback', secretPayload: 'must-not-enter-diagnostics',
    } },
});
assert.equal(protocolDiagnostics.length, 1, 'an unknown Item lifecycle must emit one bounded protocol diagnostic');
assert.deepEqual(protocolDiagnostics[0], {
    sessionId: 'session_1', threadId: 'thr_1', turnId: 'turn_1', itemId: 'unknown_1',
    itemType: 'futureSecretItem', fields: ['id', 'name', 'secretPayload', 'status', 'type'],
});
assert.doesNotMatch(JSON.stringify(protocolDiagnostics[0]), /must-not-enter-diagnostics/,
    'unknown Item diagnostics must never contain raw field values');
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
projector.projectNotification({
    method: 'item/started',
    params: {
        threadId: 'thr_1', turnId: 'turn_1',
        item: { id: 'reason_omitted_by_read', type: 'reasoning', status: 'inProgress', summary: [] },
    },
});
projector.projectNotification({
    method: 'item/reasoning/summaryTextDelta',
    params: {
        threadId: 'thr_1', itemId: 'reason_omitted_by_read', summaryIndex: 0,
        delta: 'durable reasoning summary',
    },
});
projector.projectNotification({
    method: 'item/reasoning/textDelta',
    params: {
        threadId: 'thr_1', itemId: 'reason_omitted_by_read', contentIndex: 0,
        delta: 'durable reasoning detail',
    },
});
projector.projectNotification({
    method: 'item/completed',
    params: {
        threadId: 'thr_1', turnId: 'turn_1',
        item: { id: 'reason_omitted_by_read', type: 'reasoning', status: 'completed' },
    },
});
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
assert.equal(reconciled.messages.some((message) => message.itemId === 'reason_1'), true,
    'Codex 0.146 thread/read omission must not delete a reasoning Item observed live');
const omittedReasoning = reconciled.messages.find((message) => message.itemId === 'reason_omitted_by_read');
assert.deepEqual(omittedReasoning.blocks[0].content.summary, ['durable reasoning summary'],
    'a full thread/read snapshot that omits reasoning must preserve its streamed summary');
assert.deepEqual(omittedReasoning.blocks[0].content.content, ['durable reasoning detail'],
    'a full thread/read snapshot that omits reasoning must preserve its streamed detail');
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

const imageRepository = new AgentProjectionRepository({ databasePath: ':memory:' });
imageRepository.saveSession({
    sessionId: 'session_image', threadId: 'thread_image', agentId: 'Nova', title: 'Image privacy',
});
const imageProjector = new CodexProjectionProjector(imageRepository);
imageProjector.projectNotification({
    method: 'item/completed',
    params: {
        threadId: 'thread_image', turnId: 'turn_image',
        item: { id: 'image_item', type: 'imageView', path: 'C:\\private\\capture.png', status: 'completed' },
    },
});
const imageProjection = imageRepository.readProjection('session_image');
assert.equal(imageProjection.messages[0].blocks[0].content.item.name, 'capture.png');
assert.equal(JSON.stringify(imageProjection).includes('C:\\private'), false,
    'imageView projection must not persist an absolute path in Agent SQLite');
imageProjector.dispose();
imageRepository.close();

const boundedRepository = new AgentProjectionRepository({ databasePath: ':memory:' });
boundedRepository.saveSession({
    sessionId: 'session_bounded', threadId: 'thread_bounded', agentId: 'Nova', title: 'Bounded content',
});
const boundedProjector = new CodexProjectionProjector(boundedRepository);
boundedProjector.projectNotification({
    method: 'item/completed',
    params: {
        threadId: 'thread_bounded', turnId: 'turn_bounded', item: {
            id: 'bounded_user', type: 'userMessage', content: [
                { type: 'text', text: 'inspect attachments' },
                { type: 'localImage', path: 'C:\\private\\capture.png', detail: 'high' },
                { type: 'localAudio', path: '\\\\server\\private\\voice.wav' },
                { type: 'image', url: `data:image/png;base64,${'A'.repeat(12_000)}` },
                { type: 'audio', url: 'https://example.test/voice.mp3' },
                { type: 'skill', name: 'Safe skill', path: 'C:\\private\\skill.md' },
                { type: 'mention', name: 'Safe mention', path: '/private/mention.md' },
            ],
        },
    },
});
boundedProjector.projectNotification({
    method: 'item/completed',
    params: {
        threadId: 'thread_bounded', turnId: 'turn_bounded', item: {
            id: 'bounded_tool', type: 'dynamicToolCall', status: 'completed', tool: 'vcp_invoke',
            arguments: { tool: 'FileOperator', arguments: {
                action: 'read', absolutePath: 'C:\\private\\secret.txt', apiKey: 'do-not-persist',
                blob: 'A'.repeat(12_000),
            } },
            success: true,
        },
    },
});
boundedProjector.projectNotification({
    method: 'item/completed',
    params: {
        threadId: 'thread_bounded', turnId: 'turn_bounded', item: {
            id: 'bounded_reasoning', type: 'reasoning', status: 'completed',
            summary: Array.from({ length: 80 }, () => 's'.repeat(70_000)),
            content: Array.from({ length: 80 }, () => 'c'.repeat(70_000)),
        },
    },
});
boundedProjector.projectNotification({
    method: 'item/completed',
    params: {
        threadId: 'thread_bounded', turnId: 'turn_bounded',
        item: { id: 'bounded_plan', type: 'plan', status: 'completed', text: 'p'.repeat(80_000) },
    },
});
boundedProjector.projectNotification({
    method: 'item/started', params: {
        threadId: 'thread_bounded', turnId: 'turn_bounded',
        item: { id: 'stream_message', type: 'agentMessage', status: 'inProgress', text: '' },
    },
});
boundedProjector.projectNotification({
    method: 'item/agentMessage/delta', params: {
        threadId: 'thread_bounded', turnId: 'turn_bounded', itemId: 'stream_message', delta: 'm'.repeat(300_000),
    },
});
boundedProjector.projectNotification({
    method: 'item/started', params: {
        threadId: 'thread_bounded', turnId: 'turn_bounded',
        item: { id: 'stream_reasoning', type: 'reasoning', status: 'inProgress', summary: [], content: [] },
    },
});
boundedProjector.projectNotification({
    method: 'item/reasoning/textDelta', params: {
        threadId: 'thread_bounded', turnId: 'turn_bounded', itemId: 'stream_reasoning',
        contentIndex: 0, delta: 'r'.repeat(80_000),
    },
});
assert.equal(boundedProjector.projectNotification({
    method: 'item/reasoning/summaryPartAdded', params: {
        threadId: 'thread_bounded', turnId: 'turn_bounded', itemId: 'stream_reasoning', summaryIndex: 64,
    },
}), false, 'reasoning indices outside the durable contract must fail closed');
const boundedProjection = boundedRepository.readProjection('session_bounded');
const boundedJson = JSON.stringify(boundedProjection);
assert.doesNotMatch(boundedJson, /C:\\\\private|\\\\server\\private|\/private\/mention|do-not-persist|data:image/i,
    'known Item normalization must keep absolute paths, credentials and data URLs out of SQLite and Renderer JSON');
assert.match(boundedJson, /capture\.png/);
assert.match(boundedJson, /voice\.wav/);
assert.match(boundedJson, /\[redacted\]/);
assert.match(boundedJson, /\[binary data omitted\]/);
const boundedUser = boundedProjection.messages.find((message) => message.itemId === 'bounded_user').blocks[0].content.parts;
assert.equal(boundedUser.find((part) => part.type === 'image').url, undefined,
    'data URLs must not become durable user attachment URLs');
assert.equal(boundedUser.find((part) => part.type === 'audio').url, 'https://example.test/voice.mp3');
const boundedReasoning = boundedProjection.messages.find((message) => message.itemId === 'bounded_reasoning').blocks[0].content;
assert.equal(boundedReasoning.truncated, true);
assert.ok([...boundedReasoning.summary, ...boundedReasoning.content]
    .reduce((total, value) => total + value.length, 0) <= 512 * 1024,
    'reasoning snapshot content must have a durable aggregate cap');
const boundedPlan = boundedProjection.messages.find((message) => message.itemId === 'bounded_plan').blocks[0].content;
assert.ok(boundedPlan.text.length <= 64 * 1024, 'plan snapshots must have a durable cap');
const streamedMessage = boundedProjection.messages.find((message) => message.itemId === 'stream_message').blocks[0].content;
assert.equal(streamedMessage.text.length, 256 * 1024);
assert.equal(streamedMessage.truncated, true, 'message deltas must not grow SQLite Blocks without a bound');
const streamedReasoning = boundedProjection.messages.find((message) => message.itemId === 'stream_reasoning').blocks[0].content;
assert.equal(streamedReasoning.content[0].length, 64 * 1024);
assert.equal(streamedReasoning.truncated, true, 'reasoning deltas must retain truncation state at the durable cap');
boundedProjector.dispose();
boundedRepository.close();

const damagedOrderRepository = new AgentProjectionRepository({ databasePath: ':memory:' });
damagedOrderRepository.saveSession({
    sessionId: 'session_order', threadId: 'thread_order', agentId: 'Nova', title: 'Order repair',
});
const damagedOrderProjector = new CodexProjectionProjector(damagedOrderRepository);
damagedOrderProjector.projectNotification({
    method: 'item/completed',
    params: { threadId: 'thread_order', turnId: 'turn_order', item: {
        id: 'tool_before_history', type: 'dynamicToolCall', status: 'completed',
        tool: 'vcp_invoke', arguments: { tool: 'FileOperator', arguments: { action: 'read' } },
        contentItems: [{ type: 'inputText', text: 'done' }], success: true,
    } },
});
const repairedPartialOrder = damagedOrderProjector.reconcileThread('session_order', {
    id: 'thread_order', turns: [{ id: 'turn_order', items: [
        { id: 'user_after_reopen', type: 'userMessage', content: [{ type: 'text', text: 'inspect' }] },
        { id: 'assistant_after_reopen', type: 'agentMessage', text: 'finished', status: 'completed' },
    ] }],
});
assert.equal(repairedPartialOrder.partial, true);
assert.deepEqual(damagedOrderRepository.readProjection('session_order').messages.map((message) => message.itemId), [
    'user_after_reopen', 'tool_before_history', 'assistant_after_reopen',
], 'partial history must re-anchor an omitted ToolBox card inside its Turn instead of leaving it at the page top');
damagedOrderProjector.dispose();
damagedOrderRepository.close();

const interleavedOrderRepository = new AgentProjectionRepository({ databasePath: ':memory:' });
interleavedOrderRepository.saveSession({
    sessionId: 'session_interleaved', threadId: 'thread_interleaved', agentId: 'Nova', title: 'Interleaved tools',
});
const interleavedProjector = new CodexProjectionProjector(interleavedOrderRepository);
const projectInterleaved = (item) => interleavedProjector.projectNotification({
    method: 'item/completed', params: { threadId: 'thread_interleaved', turnId: 'turn_interleaved', item },
});
projectInterleaved({ id: 'live_user', type: 'userMessage', content: [{ type: 'text', text: 'inspect' }] });
projectInterleaved({ id: 'live_intro', type: 'agentMessage', text: 'I will inspect it.', status: 'completed' });
projectInterleaved({ id: 'live_tool_a', type: 'dynamicToolCall', status: 'completed', tool: 'vcp_invoke',
    arguments: { tool: 'FileOperator', arguments: { action: 'list' } }, success: true });
projectInterleaved({ id: 'live_middle', type: 'agentMessage', text: 'I found the target.', status: 'completed' });
projectInterleaved({ id: 'live_tool_b', type: 'dynamicToolCall', status: 'completed', tool: 'vcp_invoke',
    arguments: { tool: 'FileOperator', arguments: { action: 'read' } }, success: true });
projectInterleaved({ id: 'live_final', type: 'agentMessage', text: 'Finished.', status: 'completed' });
const rewrittenIdentity = interleavedProjector.reconcileThread('session_interleaved', {
    id: 'thread_interleaved', turns: [{ id: 'turn_interleaved', itemsView: 'full', items: [
        { id: 'snapshot_user', type: 'userMessage', content: [{ type: 'text', text: 'inspect' }] },
        { id: 'snapshot_intro', type: 'agentMessage', text: 'I will inspect it.', status: 'completed' },
        { id: 'snapshot_middle', type: 'agentMessage', text: 'I found the target.', status: 'completed' },
        { id: 'snapshot_final', type: 'agentMessage', text: 'Finished.', status: 'completed' },
    ] }],
});
assert.equal(rewrittenIdentity.applied, true);
assert.deepEqual(interleavedOrderRepository.readProjection('session_interleaved').messages
    .map((message) => message.itemId), [
        'snapshot_user', 'snapshot_intro', 'live_tool_a',
        'snapshot_middle', 'live_tool_b', 'snapshot_final',
    ], 'thread/read identity rewrites must replace Codex slots without extracting ToolBox cards from the Turn');
interleavedProjector.dispose();
interleavedOrderRepository.close();

const clusteredTimelinePath = path.join(root, 'clustered-timeline.sqlite');
const clusteredOrderRepository = new AgentProjectionRepository({ databasePath: clusteredTimelinePath });
clusteredOrderRepository.saveSession({
    sessionId: 'session_clustered', threadId: 'thread_clustered', agentId: 'Nova', title: 'Clustered tools',
});
const clusteredProjector = new CodexProjectionProjector(clusteredOrderRepository);
const projectClustered = (item) => clusteredProjector.projectNotification({
    method: 'item/completed', params: { threadId: 'thread_clustered', turnId: 'turn_clustered', item },
});
projectClustered({ id: 'cluster_tool_a', type: 'dynamicToolCall', status: 'completed', tool: 'vcp_invoke',
    arguments: { tool: 'FileOperator', arguments: { action: 'list' } }, success: true });
projectClustered({ id: 'cluster_tool_b', type: 'dynamicToolCall', status: 'completed', tool: 'vcp_invoke',
    arguments: { tool: 'FileOperator', arguments: { action: 'read' } }, success: true });
projectClustered({ id: 'cluster_user', type: 'userMessage', content: [{ type: 'text', text: 'inspect' }] });
projectClustered({ id: 'cluster_intro', type: 'agentMessage', text: 'Starting.', status: 'completed' });
projectClustered({ id: 'cluster_middle', type: 'agentMessage', text: 'Continuing.', status: 'completed' });
projectClustered({ id: 'cluster_final', type: 'agentMessage', text: 'Finished.', status: 'completed' });
clusteredOrderRepository.db.prepare(`
    UPDATE agent_messages SET source_order = CASE codex_item_id
        WHEN 'cluster_tool_a' THEN 1 WHEN 'cluster_tool_b' THEN 3 WHEN 'cluster_user' THEN 10
        WHEN 'cluster_intro' THEN 11 WHEN 'cluster_middle' THEN 12 WHEN 'cluster_final' THEN 13
        ELSE source_order END WHERE session_id = 'session_clustered'
`).run();
assert.deepEqual(clusteredOrderRepository.readProjection('session_clustered').messages
    .map((message) => message.itemId), [
        'cluster_user', 'cluster_intro', 'cluster_tool_a',
        'cluster_middle', 'cluster_tool_b', 'cluster_final',
    ], 'cold-open history must distribute clustered tool batches through their owning Turn instead of grouping them at the top');
assert.deepEqual(clusteredOrderRepository.stmt.listMessages.all('session_clustered')
    .map((row) => row.codex_item_id), [
        'cluster_user', 'cluster_intro', 'cluster_tool_a',
        'cluster_middle', 'cluster_tool_b', 'cluster_final',
    ], 'the first authoritative read must durably repair clustered tool rows in the current Main process');
clusteredProjector.dispose();
clusteredOrderRepository.close();
const reopenedClusteredRepository = new AgentProjectionRepository({ databasePath: clusteredTimelinePath });
assert.deepEqual(reopenedClusteredRepository.stmt.listMessages.all('session_clustered')
    .map((row) => row.codex_item_id), [
        'cluster_user', 'cluster_intro', 'cluster_tool_a',
        'cluster_middle', 'cluster_tool_b', 'cluster_final',
    ], 'Main startup must durably repair legacy top-clustered tool rows in SQLite');
assert.deepEqual(reopenedClusteredRepository.readProjection('session_clustered').messages
    .map((message) => message.itemId), [
        'cluster_user', 'cluster_intro', 'cluster_tool_a',
        'cluster_middle', 'cluster_tool_b', 'cluster_final',
    ], 'a later cold reopen must use the repaired durable order without Renderer inference');
reopenedClusteredRepository.close();

const realBurstTimelinePath = path.join(root, 'real-burst-timeline.sqlite');
const realBurstRepository = new AgentProjectionRepository({ databasePath: realBurstTimelinePath });
realBurstRepository.saveSession({
    sessionId: 'session_real_burst', threadId: 'thread_real_burst', agentId: 'Nova',
    title: 'Real 11-tool burst placement',
});
const realBurstProjector = new CodexProjectionProjector(realBurstRepository);
const realBurstTurnId = 'turn_real_burst';
const realBurstToolOrders = [7, 8, 9, 12, 15, 16, 19, 20, 21, 24, 25];
for (let index = 0; index < realBurstToolOrders.length; index += 1) {
    realBurstProjector.projectNotification({
        method: 'item/completed',
        params: {
            threadId: 'thread_real_burst', turnId: realBurstTurnId,
            item: {
                id: `real_tool_${index + 1}`, type: 'dynamicToolCall', status: 'completed',
                tool: 'vcp_invoke', arguments: { tool: 'FileOperator', arguments: { action: 'read' } },
                success: true,
            },
        },
    });
}
realBurstProjector.projectNotification({
    method: 'item/completed', params: {
        threadId: 'thread_real_burst', turnId: realBurstTurnId,
        item: { id: 'real_user', type: 'userMessage', content: [{ type: 'text', text: 'inspect' }] },
    },
});
for (let index = 0; index < 6; index += 1) {
    realBurstProjector.projectNotification({
        method: 'item/completed', params: {
            threadId: 'thread_real_burst', turnId: realBurstTurnId,
            item: { id: `real_assistant_${index + 1}`, type: 'agentMessage', status: 'completed', text: `part ${index + 1}` },
        },
    });
}
const realBurstOrderUpdates = [
    ...realBurstToolOrders.map((sourceOrder, index) => [`real_tool_${index + 1}`, sourceOrder]),
    ['real_user', 28],
    ...Array.from({ length: 6 }, (_, index) => [`real_assistant_${index + 1}`, 29 + index]),
];
const setRealBurstOrder = realBurstRepository.db.prepare(`
    UPDATE agent_messages SET source_order = ? WHERE session_id = 'session_real_burst' AND codex_item_id = ?
`);
for (const [itemId, sourceOrder] of realBurstOrderUpdates) setRealBurstOrder.run(sourceOrder, itemId);
realBurstProjector.dispose();
realBurstRepository.close();
const reopenedRealBurstRepository = new AgentProjectionRepository({ databasePath: realBurstTimelinePath });
const realBurstSignature = reopenedRealBurstRepository.stmt.listMessages.all('session_real_burst')
    .map((row) => row.codex_item_id);
assert.deepEqual(realBurstSignature, [
    'real_user', 'real_assistant_1',
    'real_tool_1', 'real_tool_2', 'real_tool_3', 'real_assistant_2',
    'real_tool_4', 'real_assistant_3',
    'real_tool_5', 'real_tool_6', 'real_assistant_4',
    'real_tool_7', 'real_tool_8', 'real_tool_9', 'real_assistant_5',
    'real_tool_10', 'real_tool_11', 'real_assistant_6',
], 'startup repair must restore the five original tool batches from the real 11-tool legacy shape');
assert.deepEqual(reopenedRealBurstRepository.readProjection('session_real_burst').messages
    .map((message) => message.itemId), realBurstSignature,
    'subsequent cold reads must use the durable repaired order without regrouping tools at the top');
reopenedRealBurstRepository.close();

const durableTimelinePath = path.join(root, 'durable-timeline.sqlite');
const durableTimelineRepository = new AgentProjectionRepository({ databasePath: durableTimelinePath });
durableTimelineRepository.saveSession({
    sessionId: 'session_durable_timeline', threadId: 'thread_durable_timeline', agentId: 'Nova',
    title: 'Durable tool placement',
});
const durableTimelineProjector = new CodexProjectionProjector(durableTimelineRepository);
const projectDurableTimeline = (item, turnId = 'turn_durable_timeline') => durableTimelineProjector.projectNotification({
    method: 'item/completed',
    params: { threadId: 'thread_durable_timeline', turnId, item },
});
projectDurableTimeline({ id: 'previous_user', type: 'userMessage', content: [{ type: 'text', text: 'earlier' }] },
    'turn_previous');
projectDurableTimeline({ id: 'previous_assistant', type: 'agentMessage', text: 'Previous answer.', status: 'completed' },
    'turn_previous');
projectDurableTimeline({ id: 'live_user', type: 'userMessage', content: [{ type: 'text', text: 'inspect' }] });
projectDurableTimeline({ id: 'live_intro', type: 'agentMessage', text: 'Starting.', status: 'completed' });
projectDurableTimeline({ id: 'live_tool_a', type: 'dynamicToolCall', status: 'completed', tool: 'vcp_invoke',
    arguments: { tool: 'FileOperator', arguments: { action: 'list' } }, success: true });
projectDurableTimeline({ id: 'live_middle', type: 'agentMessage', text: 'Continuing.', status: 'completed' });
projectDurableTimeline({ id: 'live_tool_b', type: 'dynamicToolCall', status: 'completed', tool: 'vcp_invoke',
    arguments: { tool: 'FileOperator', arguments: { action: 'read' } }, success: true });
projectDurableTimeline({ id: 'live_final', type: 'agentMessage', text: 'Finished.', status: 'completed' });
const timelineSignature = (projection) => projection.messages.map((message) => {
    const block = message.blocks[0] || {};
    if (message.role === 'user') return 'user';
    if (block.kind === 'tool') return `tool:${block.content?.item?.tool || 'unknown'}`;
    return `assistant:${block.content?.text || ''}`;
});
const expectedTimelineSignature = [
    'user', 'assistant:Previous answer.',
    'user', 'assistant:Starting.', 'tool:FileOperator',
    'assistant:Continuing.', 'tool:FileOperator', 'assistant:Finished.',
];
assert.deepEqual(timelineSignature(durableTimelineRepository.readProjection('session_durable_timeline')),
    expectedTimelineSignature, 'live projection must place each tool batch where the user originally saw it');
const durableReconcile = durableTimelineProjector.reconcileThread('session_durable_timeline', {
    id: 'thread_durable_timeline', turns: [
        { id: 'turn_previous', itemsView: 'full', items: [
            { id: 'snapshot_previous_user', type: 'userMessage', content: [{ type: 'text', text: 'earlier' }] },
            { id: 'snapshot_previous_assistant', type: 'agentMessage', text: 'Previous answer.', status: 'completed' },
        ] },
        { id: 'turn_durable_timeline', itemsView: 'full', items: [
            { id: 'snapshot_user', type: 'userMessage', content: [{ type: 'text', text: 'inspect' }] },
            { id: 'snapshot_intro', type: 'agentMessage', text: 'Starting.', status: 'completed' },
            { id: 'snapshot_middle', type: 'agentMessage', text: 'Continuing.', status: 'completed' },
            { id: 'snapshot_final', type: 'agentMessage', text: 'Finished.', status: 'completed' },
        ] },
    ],
});
assert.equal(durableReconcile.applied, true);
assert.deepEqual(timelineSignature(durableTimelineRepository.readProjection('session_durable_timeline')),
    expectedTimelineSignature,
    'thread/read may replace Codex identities but must not move retained ToolBox cards');
durableTimelineProjector.dispose();
durableTimelineRepository.close();
const reopenedDurableTimelineRepository = new AgentProjectionRepository({ databasePath: durableTimelinePath });
assert.deepEqual(timelineSignature(reopenedDurableTimelineRepository.readProjection('session_durable_timeline')),
    expectedTimelineSignature,
    'closing and reopening Projection SQLite must preserve the exact tool-card placement');
reopenedDurableTimelineRepository.close();

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
assert.equal(reopenedMessages.some((message) => message.itemId === 'reason_1'), true);
assert.deepEqual(reopenedMessages.find((message) => message.itemId === 'reason_omitted_by_read')
    ?.blocks[0].content.summary, ['durable reasoning summary'],
    'reasoning omitted by thread/read must survive a real SQLite close and reopen');
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
assert.equal(migratedFromDisk.schemaVersion, 12);
migratedFromDisk.close();
assert.equal(fs.existsSync(`${backupDatabasePath}.schema-6.bak`), true,
    'an on-disk schema migration must create a versioned backup before mutation');

const canonicalDatabasePath = path.join(root, 'projection-schema-12.sqlite');
const canonicalSeed = new AgentProjectionRepository({ databasePath: canonicalDatabasePath });
canonicalSeed.saveSession({ sessionId: 'legacy-session', threadId: 'legacy-thread', agentId: 'Nova' });
canonicalSeed.upsertItem('legacy-session', {
    threadId: 'legacy-thread', turnId: 'legacy-turn', itemId: 'legacy-reasoning',
    role: 'assistant', status: 'completed',
}, { kind: 'reasoning', ordinal: 0, content: { summary: ['placeholder'], content: [] } });
canonicalSeed.upsertItem('legacy-session', {
    threadId: 'legacy-thread', turnId: 'legacy-turn', itemId: 'legacy-tool',
    role: 'tool', status: 'completed',
}, { kind: 'tool', ordinal: 0, authority: 'codex', content: {
    item: { id: 'legacy-tool', type: 'dynamicToolCall', tool: 'vcp_invoke' },
} });
canonicalSeed.close();
const canonicalLegacy = new Database(canonicalDatabasePath);
canonicalLegacy.prepare('UPDATE projection_schema SET version = 11').run();
canonicalLegacy.prepare(`
    UPDATE agent_blocks SET block_id = 'legacy-reasoning-block', content_schema_version = 1,
        content_json = '{"text":"legacy reasoning"}'
    WHERE message_id = (SELECT message_id FROM agent_messages WHERE codex_item_id = 'legacy-reasoning')
`).run();
canonicalLegacy.prepare(`
    UPDATE agent_blocks SET block_id = 'legacy-tool-block', content_schema_version = 1, authority = 'codex'
    WHERE message_id = (SELECT message_id FROM agent_messages WHERE codex_item_id = 'legacy-tool')
`).run();
canonicalLegacy.close();
const canonicalRepository = new AgentProjectionRepository({ databasePath: canonicalDatabasePath });
assert.equal(canonicalRepository.schemaVersion, 12);
const canonicalProjection = canonicalRepository.readProjection('legacy-session');
assert.deepEqual(canonicalProjection.messages.find((message) => message.itemId === 'legacy-reasoning')
    .blocks[0].content.summary, ['legacy reasoning']);
assert.equal(canonicalProjection.messages.find((message) => message.itemId === 'legacy-tool')
    .blocks[0].authority, 'toolbox');
for (const row of canonicalRepository.db.prepare(`
    SELECT b.block_id, b.content_schema_version, m.session_id, m.codex_item_id, b.ordinal
    FROM agent_blocks AS b JOIN agent_messages AS m ON m.message_id = b.message_id
`).all()) {
    assert.equal(row.content_schema_version, 2);
    assert.equal(row.block_id, `block:${row.session_id}:${row.codex_item_id}:${row.ordinal}`);
}
canonicalRepository.close();

const malformedDatabasePath = path.join(root, 'projection-malformed-v11.sqlite');
const malformedSeed = new AgentProjectionRepository({ databasePath: malformedDatabasePath });
malformedSeed.saveSession({ sessionId: 'malformed-session', threadId: 'malformed-thread', agentId: 'Nova' });
malformedSeed.upsertItem('malformed-session', {
    threadId: 'malformed-thread', itemId: 'malformed-item', role: 'assistant', status: 'completed',
}, { kind: 'message', ordinal: 0, content: { text: 'valid before corruption' } });
malformedSeed.close();
const malformedLegacy = new Database(malformedDatabasePath);
malformedLegacy.prepare('UPDATE projection_schema SET version = 11').run();
malformedLegacy.prepare("UPDATE agent_blocks SET content_schema_version = 1, content_json = '{bad json'").run();
malformedLegacy.close();
assert.throws(() => new AgentProjectionRepository({ databasePath: malformedDatabasePath }), /malformed Block JSON/,
    'schema 12 migration must fail closed on malformed Block content');
assert.equal(fs.existsSync(`${malformedDatabasePath}.schema-11.bak`), true,
    'a failed schema 12 migration must retain its pre-migration backup');
const malformedAfterFailure = new Database(malformedDatabasePath, { readonly: true });
assert.equal(malformedAfterFailure.prepare('SELECT version FROM projection_schema').get().version, 11,
    'a failed schema 12 migration must roll back the schema version');
malformedAfterFailure.close();
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
