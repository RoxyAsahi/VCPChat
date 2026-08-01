import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InteractionRegistry, interactionKey } = require('../modules/codex-runtime/interactionRegistry.js');

assert.equal(interactionKey('toolbox', 'same'), 'toolbox:same');
assert.equal(interactionKey('codex-native', 'same'), 'codex-native:same');
const registry = new InteractionRegistry();
assert.equal(registry.enqueue({ source: 'toolbox', requestId: 'same', sessionId: 'a' }).accepted, true);
assert.equal(registry.enqueue({ source: 'codex-native', requestId: 'same', sessionId: 'b' }).accepted, true,
    'different sources must not collide on request IDs');
assert.equal(registry.enqueue({ source: 'toolbox', requestId: 'same' }).accepted, false,
    'a replayed request must not be shown or answered twice');
assert.equal(registry.begin('toolbox', 'same')?.state, 'responding');
assert.equal(registry.begin('toolbox', 'same'), null, 'response can begin exactly once');
assert.equal(registry.rollback('toolbox', 'same')?.state, 'pending');
assert.equal(registry.complete('toolbox', 'same')?.state, 'completed');
assert.equal(registry.begin('toolbox', 'same'), null, 'completed request cannot replay');
registry.enqueue({ source: 'codex-native', requestId: 'expired', expiresAtMs: 10 });
assert.equal(registry.begin('codex-native', 'expired', 11), null);
assert.equal(registry.active().length, 1, 'expired entries must leave the active interaction center');
const payloadRecord = registry.enqueue({
    source: 'codex-native', requestId: 'payload', kind: 'user-input', method: 'item/tool/requestUserInput',
    payload: { questions: [{ id: 'choice', question: 'Pick one' }] },
}).record;
assert.equal(payloadRecord.kind, 'user-input');
assert.equal(payloadRecord.payload.questions[0].id, 'choice');
console.log('Codex interaction registry tests passed.');
