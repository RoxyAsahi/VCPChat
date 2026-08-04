import assert from 'node:assert/strict';
import {
    applyProjectionPatch,
    applyProjectionSnapshot,
    projectionToNormalized,
    sessionProjectionFromState,
} from '../modules/ui-system/agent-normalized-store.js';

let state = { sessionsById: new Map(), blocksById: new Map(), projectionRevisions: new Map() };
state = { ...state, ...applyProjectionSnapshot(state, {
    session: { sessionId: 'session-a', threadId: 'thread-a' }, projectionRevision: 2,
    messages: [{ messageId: 'm1', itemId: 'i1', turnId: 't1', status: 'inProgress', blocks: [{ blockId: 'legacy-b1', kind: 'reasoning', ordinal: 0, content: { summary: ['x'], content: [] } }] }],
}) };
assert.equal(state.blocksById.get('block:session-a:i1:0').sessionId, 'session-a');
assert.equal(state.projectionRevisions.get('session-a'), 2);
let result = applyProjectionPatch(state, { schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a', baseProjectionRevision: 1, projectionRevision: 3, upsertBlocks: [] });
assert.equal(result.applied, false);
assert.equal(applyProjectionPatch(state, {
    schemaVersion: 1,
    sessionId: 'session-a', threadId: 'thread-b', baseProjectionRevision: 2,
    projectionRevision: 3, upsertBlocks: [],
}).reason, 'identity-mismatch');
result = applyProjectionPatch(state, { schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a', baseProjectionRevision: 2, projectionRevision: 3, upsertBlocks: [{ schemaVersion: 2, blockId: 'block:session-a:i2:0', sessionId: 'session-a', threadId: 'thread-a', itemId: 'i2', messageId: 'm2', kind: 'tool', sourceOrder: 2, ordinal: 0, content: {} }] });
assert.equal(result.applied, true);
assert.equal(result.state.blocksById.has('block:session-a:i2:0'), true);
state = result.state;

result = applyProjectionPatch(state, {
    schemaVersion: 1,
    sessionId: 'session-b', threadId: 'thread-b', baseProjectionRevision: 0, projectionRevision: 1,
    upsertBlocks: [{ schemaVersion: 2, blockId: 'block:session-b:i1:0', sessionId: 'session-b', threadId: 'thread-b', itemId: 'i1', messageId: 'm1', kind: 'message', sourceOrder: 1, ordinal: 0, content: { text: 'background B' } }],
});
assert.equal(result.applied, true, 'a background Session patch must populate the normalized store');
state = result.state;
assert.equal(sessionProjectionFromState(state, 'session-a').projection.messages.some((message) => message.content === 'background B'), false,
    'a background Session patch must not alter Session A derived projection');
assert.equal(sessionProjectionFromState(state, 'session-b').projection.messages[0].content, 'background B');

const isolatedA = projectionToNormalized({ session: { sessionId: 'session-a', threadId: 'thread-a' }, messages: [{ messageId: 'ma', itemId: 'same', blocks: [{ blockId: 'legacy-shared', kind: 'message', content: { text: 'a' } }] }] });
const normalized = projectionToNormalized({ session: { sessionId: 'session-b', threadId: 'thread-b' }, messages: [{ messageId: 'm', itemId: 'same', blocks: [{ blockId: 'legacy-shared', kind: 'message', content: { text: 'b' } }] }] });
assert.equal(normalized.blocks[0].sessionId, 'session-b');
assert.notEqual(isolatedA.blocks[0].blockId, normalized.blocks[0].blockId,
    'fork Sessions with identical Codex Item IDs must retain Session-scoped Block IDs');

assert.equal(applyProjectionPatch(state, {
    schemaVersion: 1,
    sessionId: 'session-a', threadId: 'thread-a', baseProjectionRevision: 3, projectionRevision: 4,
    upsertBlocks: [{ schemaVersion: 2, blockId: 'block:session-b:foreign:0', sessionId: 'session-b', threadId: 'thread-b' }],
}).reason, 'identity-mismatch', 'foreign Blocks must fail closed before mutating the Store');
console.log('Agent normalized store tests passed.');
