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

const generationState = { ...state, runtime: { state: 'ready', generation: 4 } };
assert.equal(applyProjectionPatch(generationState, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a', runtimeGeneration: 3,
    baseProjectionRevision: 3, projectionRevision: 4, upsertBlocks: [],
}).reason, 'stale-runtime-generation', 'an old Runtime generation must not mutate the normalized Store');
assert.equal(applyProjectionPatch(generationState, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a',
    baseProjectionRevision: 3, projectionRevision: 4, upsertBlocks: [],
}).reason, 'stale-runtime-generation', 'a generation-less Patch must fail closed once Runtime identity is known');
const newerGeneration = applyProjectionPatch(generationState, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a', runtimeGeneration: 5,
    baseProjectionRevision: 3, projectionRevision: 4, upsertBlocks: [],
});
assert.equal(newerGeneration.applied, true);
assert.equal(newerGeneration.state.runtime.generation, 5,
    'the first Patch from a newer Runtime generation must advance Renderer authority');

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
const malformedPatchBlock = canonicalBlock('session-a', 'thread-a', 'malformed', { messageId: 'malformed-message' });
malformedPatchBlock.blockId = 'block:session-a:forged:0';
assert.equal(applyProjectionPatch(state, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a',
    baseProjectionRevision: 3, projectionRevision: 4, upsertBlocks: [malformedPatchBlock],
}).reason, 'identity-mismatch', 'a Patch Block with a forged canonical id must fail closed');
const invalidOrdinalBlock = canonicalBlock('session-a', 'thread-a', 'bad-ordinal', {
    messageId: 'bad-ordinal-message',
});
invalidOrdinalBlock.ordinal = -1;
invalidOrdinalBlock.blockId = 'block:session-a:bad-ordinal:-1';
assert.equal(applyProjectionPatch(state, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-a',
    baseProjectionRevision: 3, projectionRevision: 4, upsertBlocks: [invalidOrdinalBlock],
}).reason, 'identity-mismatch', 'negative Patch Block ordinals must fail closed');

state = { ...state, ...applyProjectionSnapshot(state, canonicalSnapshot('session-a', '', 5)) };
assert.equal(state.sessionsById.get('session-a').threadId, 'thread-a',
'an empty canonical snapshot must not erase an already verified Thread identity');
assert.equal(applyProjectionPatch(state, {
    schemaVersion: 1, sessionId: 'session-a', threadId: 'thread-b',
    baseProjectionRevision: 5, projectionRevision: 6, upsertBlocks: [],
}).reason, 'identity-mismatch');

let orderedTimelineState = { sessionsById: new Map(), blocksById: new Map(), projectionRevisions: new Map() };
orderedTimelineState = { ...orderedTimelineState, ...applyProjectionSnapshot(orderedTimelineState,
    canonicalSnapshot('session-order', 'thread-order', 1, [
        canonicalBlock('session-order', 'thread-order', 'user-item', {
            messageId: 'user-message', turnId: 'turn-order', sourceOrder: 1,
            content: { parts: [{ type: 'text', text: 'inspect' }] },
        }),
        canonicalBlock('session-order', 'thread-order', 'tool-item', {
            messageId: 'tool-message', turnId: 'turn-order', kind: 'tool', authority: 'toolbox',
            itemType: 'dynamicToolCall', sourceOrder: 2,
            content: { item: { type: 'dynamicToolCall', tool: 'FileOperator' } },
        }),
        canonicalBlock('session-order', 'thread-order', 'assistant-item', {
            messageId: 'assistant-message', turnId: 'turn-order', sourceOrder: 3,
            content: { text: 'finished' },
        }),
    ])) };
const orderedProjection = sessionProjectionFromState(orderedTimelineState, 'session-order').projection;
assert.deepEqual(createAgentTimelineParts(orderedProjection).map((part) => part.kind), [
    'message', 'tool', 'message',
], 'Renderer must preserve the authoritative Main projection order without inferring a second timeline');

let clusteredTimelineState = { sessionsById: new Map(), blocksById: new Map(), projectionRevisions: new Map() };
clusteredTimelineState = { ...clusteredTimelineState, ...applyProjectionSnapshot(clusteredTimelineState,
    canonicalSnapshot('session-clustered', 'thread-clustered', 1, [
        canonicalBlock('session-clustered', 'thread-clustered', 'previous-user', {
            messageId: 'previous-user', turnId: 'turn-previous', sourceOrder: 1,
            content: { parts: [{ type: 'text', text: 'earlier' }] },
        }),
        canonicalBlock('session-clustered', 'thread-clustered', 'previous-assistant', {
            messageId: 'previous-assistant', turnId: 'turn-previous', sourceOrder: 2,
            content: { text: 'previous' },
        }),
        canonicalBlock('session-clustered', 'thread-clustered', 'user-clustered', {
            messageId: 'user-clustered', turnId: 'turn-clustered', sourceOrder: 3,
            content: { parts: [{ type: 'text', text: 'inspect' }] },
        }),
        canonicalBlock('session-clustered', 'thread-clustered', 'assistant-intro', {
            messageId: 'assistant-intro', turnId: 'turn-clustered', sourceOrder: 4,
            content: { text: 'intro' },
        }),
        canonicalBlock('session-clustered', 'thread-clustered', 'tool-a', {
            messageId: 'tool-a-message', turnId: 'turn-clustered', kind: 'tool', authority: 'toolbox',
            itemType: 'dynamicToolCall', sourceOrder: 5,
            content: { item: { type: 'dynamicToolCall', tool: 'FileOperator' } },
        }),
        canonicalBlock('session-clustered', 'thread-clustered', 'assistant-middle', {
            messageId: 'assistant-middle', turnId: 'turn-clustered', sourceOrder: 6,
            content: { text: 'middle' },
        }),
        canonicalBlock('session-clustered', 'thread-clustered', 'tool-b', {
            messageId: 'tool-b-message', turnId: 'turn-clustered', kind: 'tool', authority: 'toolbox',
            itemType: 'dynamicToolCall', sourceOrder: 7,
            content: { item: { type: 'dynamicToolCall', tool: 'FileOperator' } },
        }),
        canonicalBlock('session-clustered', 'thread-clustered', 'assistant-final', {
            messageId: 'assistant-final', turnId: 'turn-clustered', sourceOrder: 8,
            content: { text: 'final' },
        }),
    ])) };
assert.deepEqual(createAgentTimelineParts(sessionProjectionFromState(clusteredTimelineState, 'session-clustered').projection)
    .map((part) => `${part.kind}:${part.id}`), [
        'message:block:session-clustered:previous-user:0',
        'message:block:session-clustered:previous-assistant:0',
        'message:block:session-clustered:user-clustered:0',
        'message:block:session-clustered:assistant-intro:0',
        'tool:tool-a',
        'message:block:session-clustered:assistant-middle:0',
        'tool:tool-b',
        'message:block:session-clustered:assistant-final:0',
    ], 'Renderer must keep multiple tool batches at the exact Main-provided timeline positions');
console.log('Agent normalized store tests passed.');
