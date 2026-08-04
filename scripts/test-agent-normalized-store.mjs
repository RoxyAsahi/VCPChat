import assert from 'node:assert/strict';
import {
    applyProjectionPatch,
    applyProjectionSnapshot,
    projectionToNormalized,
    sessionProjectionFromState,
} from '../modules/ui-system/agent-normalized-store.js';
import { createAgentTimelineParts } from '../modules/ui-system/agent-workbench-timeline.js';

function canonicalBlock(sessionId, threadId, itemId, options = {}) {
    const ordinal = Number.isInteger(options.ordinal) ? options.ordinal : 0;
    return {
        schemaVersion: 2,
        blockId: `block:${sessionId}:${itemId}:${ordinal}`,
        sessionId,
        threadId,
        turnId: options.turnId || null,
        itemId,
        messageId: options.messageId || `message:${itemId}`,
        kind: options.kind || 'message',
        itemType: options.itemType || null,
        authority: options.authority || 'codex',
        status: options.status || 'completed',
        sourceOrder: Number(options.sourceOrder || 0),
        ordinal,
        content: options.content || { text: '' },
        createdAt: options.createdAt || 1,
        updatedAt: options.updatedAt || 1,
    };
}

function canonicalSnapshot(sessionId, threadId, projectionRevision, blocks = []) {
    return {
        session: { sessionId, threadId: threadId || null },
        projectionRevision,
        normalized: { schemaVersion: 2, sessionId, threadId: threadId || '', projectionRevision, blocks },
    };
}

let state = { sessionsById: new Map(), blocksById: new Map(), projectionRevisions: new Map() };
state = { ...state, ...applyProjectionSnapshot(state, canonicalSnapshot('session-a', 'thread-a', 2, [
    canonicalBlock('session-a', 'thread-a', 'i1', {
        messageId: 'm1', turnId: 't1', kind: 'reasoning', status: 'inProgress',
        content: { summary: ['x'], content: [] },
    }),
])) };
assert.equal(state.blocksById.get('block:session-a:i1:0').sessionId, 'session-a');
assert.equal(state.projectionRevisions.get('session-a'), 2);
assert.throws(() => projectionToNormalized({
    session: { sessionId: 'session-a', threadId: 'thread-a' },
    history: [{ id: 'legacy', content: 'must not be projected' }],
}), (error) => error.code === 'INVALID_AGENT_PROJECTION_SNAPSHOT',
'legacy history snapshots must fail closed instead of creating synthetic Blocks');

let result = applyProjectionPatch(state, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a',
    baseProjectionRevision: 1, projectionRevision: 3, upsertBlocks: [],
});
assert.equal(result.applied, false);
assert.equal(applyProjectionPatch(state, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-b',
    baseProjectionRevision: 2, projectionRevision: 3, upsertBlocks: [],
}).reason, 'identity-mismatch');
result = applyProjectionPatch(state, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a',
    baseProjectionRevision: 2, projectionRevision: 3,
    upsertBlocks: [canonicalBlock('session-a', 'thread-a', 'i2', {
        messageId: 'm2', kind: 'tool', sourceOrder: 2, content: {},
    })],
});
assert.equal(result.applied, true);
assert.equal(result.state.blocksById.has('block:session-a:i2:0'), true);
state = result.state;

result = applyProjectionPatch(state, {
    schemaVersion: 1, sessionId: 'session-b', threadId: 'thread-b',
    baseProjectionRevision: 0, projectionRevision: 1,
    upsertBlocks: [canonicalBlock('session-b', 'thread-b', 'i1', {
        messageId: 'm1', sourceOrder: 1, content: { text: 'background B' },
    })],
});
assert.equal(result.applied, true, 'a background Session patch must populate the normalized store');
state = result.state;
assert.equal(sessionProjectionFromState(state, 'session-a').projection.messages
    .some((message) => message.content === 'background B'), false,
'a background Session patch must not alter Session A derived projection');
assert.equal(sessionProjectionFromState(state, 'session-b').projection.messages[0].content, 'background B');

const isolatedA = projectionToNormalized(canonicalSnapshot('session-a', 'thread-a', 1, [
    canonicalBlock('session-a', 'thread-a', 'same', { messageId: 'ma', content: { text: 'a' } }),
]));
const normalized = projectionToNormalized(canonicalSnapshot('session-b', 'thread-b', 1, [
    canonicalBlock('session-b', 'thread-b', 'same', { messageId: 'mb', content: { text: 'b' } }),
]));
assert.equal(normalized.blocks[0].sessionId, 'session-b');
assert.notEqual(isolatedA.blocks[0].blockId, normalized.blocks[0].blockId,
'fork Sessions with identical Codex Item IDs must retain Session-scoped Block IDs');

assert.equal(applyProjectionPatch(state, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a',
    baseProjectionRevision: 3, projectionRevision: 4,
    upsertBlocks: [canonicalBlock('session-b', 'thread-b', 'foreign')],
}).reason, 'identity-mismatch', 'foreign Blocks must fail closed before mutating the Store');

state = { ...state, ...applyProjectionSnapshot(state, canonicalSnapshot('session-a', '', 5)) };
assert.equal(state.sessionsById.get('session-a').threadId, 'thread-a',
'an empty canonical snapshot must not erase an already verified Thread identity');
assert.equal(applyProjectionPatch(state, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-b',
    baseProjectionRevision: 5, projectionRevision: 6, upsertBlocks: [],
}).reason, 'identity-mismatch');

let damagedOrderState = { sessionsById: new Map(), blocksById: new Map(), projectionRevisions: new Map() };
damagedOrderState = { ...damagedOrderState, ...applyProjectionSnapshot(damagedOrderState,
    canonicalSnapshot('session-order', 'thread-order', 1, [
        canonicalBlock('session-order', 'thread-order', 'tool-item', {
            messageId: 'tool-message', turnId: 'turn-order', kind: 'tool', authority: 'toolbox',
            itemType: 'dynamicToolCall', sourceOrder: 1,
            content: { item: { type: 'dynamicToolCall', tool: 'FileOperator' } },
        }),
        canonicalBlock('session-order', 'thread-order', 'user-item', {
            messageId: 'user-message', turnId: 'turn-order', sourceOrder: 10,
            content: { parts: [{ type: 'text', text: 'inspect' }] },
        }),
        canonicalBlock('session-order', 'thread-order', 'assistant-item', {
            messageId: 'assistant-message', turnId: 'turn-order', sourceOrder: 11,
            content: { text: 'finished' },
        }),
    ])) };
const repairedProjection = sessionProjectionFromState(damagedOrderState, 'session-order').projection;
assert.deepEqual(createAgentTimelineParts(repairedProjection).map((part) => part.kind), [
    'message', 'tool', 'message',
], 'cold-open projection must place a retained tool inside its Turn instead of at the global page top');
console.log('Agent normalized store tests passed.');
