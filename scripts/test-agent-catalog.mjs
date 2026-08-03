import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LocalToolCatalog } = require('../archive/agent-runtime/catalog/localToolCatalog.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-catalog-'));
const plugin = path.join(root, 'Plugin', 'Example');
fs.mkdirSync(plugin, { recursive: true });
const secret = 'SHOULD_NOT_APPEAR';
fs.writeFileSync(path.join(plugin, 'plugin-manifest.json'), JSON.stringify({
    name: 'Example',
    displayName: '<button onclick="attack()">Example</button>',
    configSchema: { API_KEY: { default: secret } },
    capabilities: {
        invocationCommands: [
            { command: 'ReadThing', description: '<script>not executable</script>' },
            { command: 'WriteThing', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        ],
    },
}));

let cached;
const catalog = new LocalToolCatalog({
    roots: [{ id: 'fixture', path: root }],
    cacheAdapter: { load: async () => cached, save: async (snapshot) => { cached = snapshot; } },
});
const first = await catalog.refresh();
assert.equal(first.tools.length, 2);
assert.equal(first.tools[0].id, 'Example:ReadThing');
assert.equal(first.tools[0].schema.status, 'unknown');
assert.equal(first.tools[0].reliability.level, 'unknown');
assert.equal(first.tools[0].risk.level, 'unknown');
assert.equal(first.tools[1].schema.status, 'declared');
assert.equal(first.tools[1].risk.level, 'high');
assert.equal(JSON.stringify(first).includes(secret), false, 'catalog must not expose manifest config values');
assert.match(first.tools[0].manifestHash, /^[a-f0-9]{64}$/);
assert.equal(first.drift.hasDrift, true);

fs.renameSync(path.join(plugin, 'plugin-manifest.json'), path.join(plugin, 'plugin-manifest.json.block'));
const second = await catalog.refresh();
assert.equal(second.tools.every((tool) => tool.enabled === false), true);
assert.equal(second.drift.changed.length, 2);
const legacy = catalog.describeLegacyUnknown('MissingTool', 'DoIt');
assert.equal(legacy.risk.level, 'unknown');
assert.equal(legacy.source.kind, 'vcp-legacy-unknown');

const restored = new LocalToolCatalog({ roots: [root], cacheAdapter: { load: async () => cached } });
await restored.loadCache();
assert.equal(restored.getSnapshot().catalogHash, second.catalogHash);
fs.rmSync(root, { recursive: true, force: true });
console.log('Agent Runtime catalog tests passed.');
