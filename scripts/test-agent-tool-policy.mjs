import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
    CODEX_CAPABILITIES,
    isCodexCapabilityEnabled,
    isVcpToolEnabled,
    normalizeToolPolicy,
} = require('../modules/codex-runtime/tool-policy.js');
const { listAgentToolCatalog } = require('../modules/codex-runtime/toolCatalogService.js');
const { responsesRequestToChat } = require('../modules/codex-runtime/toolboxResponsesAdapter.js');

const full = normalizeToolPolicy();
assert.equal(full.preset, 'full');
assert.equal(isCodexCapabilityEnabled(full, CODEX_CAPABILITIES.SHELL), true);
assert.equal(isVcpToolEnabled(full, 'FileOperator', 'EditFile'), true);

const readonly = normalizeToolPolicy({ preset: 'readonly' });
assert.equal(isCodexCapabilityEnabled(readonly, CODEX_CAPABILITIES.SHELL), false);
assert.equal(isCodexCapabilityEnabled(readonly, CODEX_CAPABILITIES.VIEW_IMAGE), true);
assert.equal(isVcpToolEnabled(readonly, 'FileOperator', 'ReadFile'), true);
assert.equal(isVcpToolEnabled(readonly, 'FileOperator', 'EditFile'), false);

const custom = normalizeToolPolicy({
    preset: 'custom',
    enabledCodexCapabilities: [CODEX_CAPABILITIES.VIEW_IMAGE],
    enabledVcpTools: ['vcp:FileOperator:ReadFile'],
});
assert.equal(isCodexCapabilityEnabled(custom, CODEX_CAPABILITIES.VIEW_IMAGE), true);
assert.equal(isCodexCapabilityEnabled(custom, CODEX_CAPABILITIES.PLAN), false);
assert.equal(isVcpToolEnabled(custom, 'FileOperator', 'ReadFile'), true);
assert.equal(isVcpToolEnabled(custom, 'FileOperator', 'WriteFile'), false);

const catalog = listAgentToolCatalog(root);
assert.ok(catalog.native.some((tool) => tool.id === CODEX_CAPABILITIES.SHELL));
const fileOperator = catalog.plugins.find((plugin) => plugin.pluginId === 'FileOperator');
assert.ok(fileOperator, 'enabled FileOperator plugin should be listed');
assert.ok(fileOperator.commands.some((command) => command.command === 'ReadFile'));

const chat = responsesRequestToChat({
    model: 'Nova',
    input: [{ role: 'user', content: 'inspect the project' }],
    tools: [
        { type: 'function', name: 'shell_command', description: 'Run a command', parameters: { type: 'object' } },
        { type: 'function', name: 'apply_patch', description: 'Edit files', parameters: { type: 'object' } },
        { type: 'function', name: 'view_image', description: 'View an image', parameters: { type: 'object' } },
        { type: 'function', name: 'vcp_invoke', description: 'untrusted', parameters: { type: 'object' } },
    ],
}, null, {
    stripEmbeddedInstructions: true,
    trustedInstructions: { mode: 'vchat-identity', baseInstructions: '{{Nova}}', toolPolicy: custom },
});
assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['view_image', 'vcp_invoke']);
assert.equal(chat.tools.at(-1).function.description,
    'Invoke one named VCPToolBox capability through the VCP bridge.');

console.log('Agent tool policy tests passed.');
