import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    EVENT_TYPES,
    RUNTIME_KINDS,
    assertEventEnvelope,
    hashArguments,
} = require('../archive/agent-runtime/contracts.js');
const { SessionEventSequencer } = require('../archive/agent-runtime/eventFactory.js');
const { isLegalTransition, TURN_STATES } = require('../archive/agent-runtime/runtimeState.js');
const { redactValue } = require('../archive/agent-runtime/secretRedactor.js');
const { BoundedEventBuffer } = require('../archive/agent-runtime/eventBuffer.js');

const sequencer = new SessionEventSequencer('sess_test', RUNTIME_KINDS.PI);
const one = sequencer.next(EVENT_TYPES.TURN_STARTED, { prompt: 'hello' }, { turnId: 'turn_1' });
const two = sequencer.next(EVENT_TYPES.ASSISTANT_DELTA, { text: 'world' }, { turnId: 'turn_1' });
assert.equal(one.sequence, 1);
assert.equal(two.sequence, 2);
assert.equal(assertEventEnvelope(two), two);
assert.throws(() => assertEventEnvelope({ ...two, schemaVersion: 99 }), /schemaVersion/);
assert.throws(() => assertEventEnvelope({ ...two, type: 'unknown.event' }), /Unknown event type/);

assert.equal(isLegalTransition('turn', TURN_STATES.QUEUED, TURN_STATES.RUNNING), true);
assert.equal(isLegalTransition('turn', TURN_STATES.COMPLETED, TURN_STATES.RUNNING), false);
assert.equal(hashArguments({ b: 2, a: 1 }), hashArguments({ a: 1, b: 2 }));

const redacted = redactValue({ Authorization: 'Bearer secret-token-123', nested: { apiKey: 'abcdef123456' } });
assert.equal(redacted.Authorization, '[REDACTED]');
assert.equal(redacted.nested.apiKey, '[REDACTED]');

const buffer = new BoundedEventBuffer('sess_test', 2);
buffer.push(one);
buffer.push(two);
buffer.push({ ...two, eventId: 'evt_3', sequence: 3 });
assert.equal(buffer.size(), 2);
assert.equal(buffer.droppedCount, 1);
assert.deepEqual(buffer.since(2).map((event) => event.sequence), [3]);

console.log('Agent Runtime contract tests passed.');
