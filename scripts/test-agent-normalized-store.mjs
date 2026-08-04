import assert from 'node:assert/strict';
import { applyProjectionPatch, applyProjectionSnapshot, projectionToNormalized } from '../modules/ui-system/agent-normalized-store.js';

let state = { sessionsById: new Map(), blocksById: new Map(), projectionRevisions: new Map() };
state = { ...state, ...applyProjectionSnapshot(state, {
    session: { sessionId: 'session-a', threadId: 'thread-a' }, projectionRevision: 2,
    messages: [{ messageId: 'm1', itemId: 'i1', turnId: 't1', status: 'inProgress', blocks: [{ blockId: 'b1', kind: 'reasoning', ordinal: 0, content: { summary: ['x'], content: [] } }] }],
}) };
assert.equal(state.blocksById.get('b1').sessionId, 'session-a');
assert.equal(state.projectionRevisions.get('session-a'), 2);
let result = applyProjectionPatch(state, { sessionId: 'session-a', threadId: 'thread-a', baseProjectionRevision: 1, projectionRevision: 3, upsertBlocks: [] });
assert.equal(result.applied, false);
assert.equal(applyProjectionPatch(state, {
    sessionId: 'session-a', threadId: 'thread-b', baseProjectionRevision: 2,
    projectionRevision: 3, upsertBlocks: [],
}).reason, 'identity-mismatch');
result = applyProjectionPatch(state, { sessionId: 'session-a', threadId: 'thread-a', baseProjectionRevision: 2, projectionRevision: 3, upsertBlocks: [{ schemaVersion: 2, blockId: 'b2', sessionId: 'session-a', threadId: 'thread-a', kind: 'tool', content: {} }] });
assert.equal(result.applied, true);
assert.equal(result.state.blocksById.has('b2'), true);
const normalized = projectionToNormalized({ session: { sessionId: 'session-b', threadId: 'thread-b' }, messages: [{ messageId: 'm', itemId: 'same', blocks: [{ blockId: 'b', kind: 'message', content: { text: 'b' } }] }] });
assert.equal(normalized.blocks[0].sessionId, 'session-b');
console.log('Agent normalized store tests passed.');
