import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRuntimeServiceContext } = require('../modules/codex-runtime/runtime-service-contexts.js');

const context = createRuntimeServiceContext('session', {
    repository: () => ({ open: true }),
    assertGeneration: () => true,
});
assert.equal(Object.isFrozen(context), true);
assert.equal(Object.isFrozen(Object.getPrototypeOf(context)), true);
assert.deepEqual(context.capabilityNames, ['repository', 'assertGeneration']);
assert.equal(context.repository().open, true);
assert.equal(Object.prototype.hasOwnProperty.call(context, 'manager'), false);
assert.throws(() => createRuntimeServiceContext('host', { manager: {} }), /cannot expose Runtime Manager/);
assert.throws(() => createRuntimeServiceContext('host', { runtime: {} }), /cannot expose Runtime Manager/);
console.log('Runtime service capability context tests passed.');
