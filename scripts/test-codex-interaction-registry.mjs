import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InteractionRegistry, interactionKey } = require('../modules/codex-runtime/interactionRegistry.js');

assert.equal(interactionKey('toolbox', 'same'), 'toolbox:0:same');
assert.equal(interactionKey('codex-native', 'same', 2), 'codex-native:2:same');
let now = 100;
const registry = new InteractionRegistry({ terminalTtlMs: 10, maxRecords: 16, now: () => now });
registry.setGeneration('toolbox', 1);
registry.setGeneration('codex-native', 1);
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
assert.equal(registry.begin('codex-native', 'expired', 1, 11), null);
assert.equal(registry.active().length, 1, 'expired entries must leave the active interaction center');
const payloadRecord = registry.enqueue({
    source: 'codex-native', requestId: 'payload', kind: 'user-input', method: 'item/tool/requestUserInput',
    payload: { questions: [{ id: 'choice', question: 'Pick one' }] },
}).record;
assert.equal(payloadRecord.kind, 'user-input');
assert.equal(payloadRecord.payload.questions[0].id, 'choice');
registry.setGeneration('toolbox', 2);
assert.equal(registry.enqueue({ source: 'toolbox', requestId: 'same', sessionId: 'new-runtime' }).accepted, true,
    'the same upstream requestId must be accepted in a new authority generation');
assert.equal(registry.begin('toolbox', 'same', 1), null, 'an old-generation response must not resolve the new request');
assert.equal(registry.begin('toolbox', 'same', 2)?.generation, 2);
registry.complete('toolbox', 'same', 'completed', 2);
now = 111;
registry.prune();
assert.equal([...registry.records.values()].some((record) => record.state === 'completed'), false,
    'terminal records must be pruned after the bounded TTL');
const bounded = new InteractionRegistry({ terminalTtlMs: 60_000, maxRecords: 16, now: () => now });
bounded.setGeneration('codex-native', 1);
for (let index = 0; index < 40; index += 1) {
    bounded.enqueue({ source: 'codex-native', requestId: `bounded-${index}` });
    bounded.complete('codex-native', `bounded-${index}`, 'completed', 1);
}
assert.ok(bounded.records.size <= 16, 'terminal interaction history must remain capacity bounded');
console.log('Codex interaction registry tests passed.');
