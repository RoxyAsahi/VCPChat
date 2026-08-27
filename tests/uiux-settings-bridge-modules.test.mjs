import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Settings bridge split invariants (refactor 2026-08-27, R2-02E item 4b).
// settings-bridge.js was a 2200-line module mixing a dozen concerns. This
// wave extracts the single-concern modules under modules/ui-system/settings/;
// these tests keep the extraction honest: one home per function, no cycles,
// and the entry stays the only writer of the public bridge global.

const root = process.cwd();
const bridgeEntry = path.join(root, 'modules', 'ui-system', 'settings-bridge.js');
const settingsDir = path.join(root, 'modules', 'ui-system', 'settings');
const read = file => fs.readFileSync(file, 'utf8');

test('single-concern modules import cleanly and expose their contract', async () => {
    const projection = await import(pathToFileURL(path.join(settingsDir, 'select-projection.js')).href);
    assert.equal(typeof projection.createSelectProjection, 'function');
    const api = projection.createSelectProjection({ ensurePresentationScope: () => null });
    assert.equal(typeof api.mount, 'function');
    assert.equal(typeof api.teardown, 'function');

    const autosave = await import(pathToFileURL(path.join(settingsDir, 'autosave.js')).href);
    assert.deepEqual(
        Object.keys(autosave).sort(),
        ['flushLegacyAutosave', 'mountSettingsAutosave', 'teardownLegacyAutosave'],
    );
    // Bridge-free operation: flush/teardown on an empty registry must no-op.
    autosave.flushLegacyAutosave();
    autosave.teardownLegacyAutosave();

    const rows = await import(pathToFileURL(path.join(settingsDir, 'canonical-rows.js')).href);
    assert.deepEqual(Object.keys(rows).sort(), ['mountCanonicalSettingsRows', 'removeLegacySubsectionHeadings']);
});

test('each extracted function has exactly one home (entry or module, never both)', () => {
    const entry = read(bridgeEntry);
    const functions = [
        'mountSelectKeyboardGlue', 'mountHarnessSelects', 'teardownHarnessSelects',
        'removeLegacySubsectionHeadings', 'mountCanonicalSettingsRows', 'composeCanonicalRowSlots',
        'mountSettingsAutosave', 'flushLegacyAutosave', 'teardownLegacyAutosave',
    ];
    const moduleSource = fs.readdirSync(settingsDir).filter(name => name.endsWith('.js'))
        .map(name => read(path.join(settingsDir, name))).join('\n');
    for (const name of functions) {
        const inModule = moduleSource.includes(`function ${name}(`);
        const inEntry = entry.includes(`function ${name}(`);
        assert.notEqual(inModule, inEntry, `function ${name} must live in exactly one place`);
    }
    // The entry must not keep the extracted legacy registries as dead state.
    for (const state of ['primitiveSelectStates', 'selectObserverStates', 'autosaveStates']) {
        assert.ok(!new RegExp(`(?:^|\n)const ${state} =`).test(entry), `entry must not re-declare module-owned state ${state}`);
    }
});

test('no import cycles: settings/* modules never import the bridge entry', () => {
    const names = fs.readdirSync(settingsDir).filter(name => name.endsWith('.js'));
    for (const name of names) {
        const source = read(path.join(settingsDir, name));
        const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
        for (const target of imports) {
            assert.ok(!target.includes('settings-bridge'), `${name} must not import the bridge entry (cycle risk)`);
        }
    }
});

test('the bridge entry wires the modules and stays the sole bridge-global owner', () => {
    const entry = read(bridgeEntry);
    assert.ok(entry.includes("from './settings/select-projection.js'"), 'entry must import the select projection');
    assert.ok(entry.includes("from './settings/autosave.js'"), 'entry must import the autosave module');
    assert.ok(entry.includes("from './settings/canonical-rows.js'"), 'entry must import the canonical rows module');
    assert.match(entry, /createSelectProjection\(\{ ensurePresentationScope \}\)/, 'entry must inject the presentation scope');
    const globalOwners = [...entry.matchAll(/window\.VCPUISettingsBridge\s*=/g)].length;
    assert.equal(globalOwners, 1, 'exactly one window.VCPUISettingsBridge assignment');
});
