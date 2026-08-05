import assert from 'node:assert/strict';
import {
    AGENT_CONFIG_DESCRIPTORS,
    PROFILE_CONFIG_FIELDS,
    SESSION_CONFIG_FIELDS,
    configOptions,
    hasConfigField,
    normalizeAgentConfig,
    normalizeConfigField,
} from '../modules/agent-config-descriptors.js';

assert.deepEqual(PROFILE_CONFIG_FIELDS, SESSION_CONFIG_FIELDS,
    'Profile and Session must share the same canonical identity/config fields');
assert.equal(normalizeConfigField('permissionMode', 'invalid').value, 'ask');
assert.equal(normalizeConfigField('instructionMode', undefined, { baseInstructions: '{{Nova}}' }).value, 'vchat-identity');
assert.equal(normalizeConfigField('instructionMode', undefined, { baseInstructions: '' }).value, 'codex-managed');
assert.equal(normalizeConfigField('budget.maxTokensPerTurn', '1000').value, 1000);
assert.equal(normalizeConfigField('budget.maxTokensPerTurn', '-1').valid, false);
assert.equal(hasConfigField({ systemPrompt: '{{Nova}}' }, 'baseInstructions'), true);
assert.deepEqual(configOptions('permissionMode').map((item) => item.value), ['ask', 'always-approve']);
const normalized = normalizeAgentConfig({
    model: '  gpt-5.6-terra ', systemPrompt: ' {{Nova}} ', permissionMode: 'always-approve',
}, { context: { reasoningEfforts: ['low', 'high'] } });
assert.deepEqual(normalized.values, {
    model: 'gpt-5.6-terra', workspaceRoot: '', permissionMode: 'always-approve',
    baseInstructions: '{{Nova}}', instructionMode: 'vchat-identity', reasoningEffort: null,
    toolPolicy: { schemaVersion: 1, preset: 'full', enabledCodexCapabilities: [], enabledVcpTools: [] },
});
assert.equal(normalized.errors.length, 0);
assert.ok(Object.keys(AGENT_CONFIG_DESCRIPTORS).includes('budget.maxRequestsPerTurn'));
console.log('Agent config descriptor tests passed.');
