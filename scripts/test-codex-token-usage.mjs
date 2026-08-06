import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeThreadTokenUsage, normalizeUsagePayload } = require('../modules/codex-runtime/token-usage.js');

const usage = normalizeThreadTokenUsage({
    turnId: 'turn-a',
    tokenUsage: {
        last: {
            inputTokens: 90, cachedInputTokens: 30, cacheWriteInputTokens: 5,
            outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 100,
        },
        total: {
            inputTokens: 900, cachedInputTokens: 300, cacheWriteInputTokens: 50,
            outputTokens: 100, reasoningOutputTokens: 40, totalTokens: 1_000,
        },
        modelContextWindow: 2_000,
    },
});
assert.equal(usage.contextTokens, 100);
assert.equal(usage.sessionTotalTokens, 1_000);
assert.equal(usage.percentage, 5);
assert.equal(usage.cacheReadTokens, 30);
assert.equal(usage.reasoningTokens, 4);

assert.deepEqual(normalizeUsagePayload({
    source: 'real', provenance: 'codex-thread', totalTokens: 100,
    secret: 'must not cross the usage contract', percentage: null,
}), {
    schemaVersion: 1, source: 'real', provenance: 'codex-thread', totalTokens: 100, percentage: null,
});
assert.equal(normalizeThreadTokenUsage({}), null);

console.log('Codex token usage normalization tests passed.');
