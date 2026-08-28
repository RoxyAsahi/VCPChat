import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

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

test('typed Agent Inputs share one private owner while preserving canonical native controls', () => {
    const entry = read(bridgeEntry);
    const helper = entry.match(/function mountTypedAgentInput\(form, \{ id, marker, ownerKey, placeholder = false, restoreClass = false \}\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(helper, /api\.mountInput\(input, props, scope\)/, 'the helper must mount on the injected presentation owner');
    assert.match(helper, /delete input\.dataset\[marker\]/, 'scope teardown must remove each input marker');
    assert.match(helper, /restoreClass && input\.isConnected/, 'only configured fields restore their native class');

    const callers = entry.slice(
        entry.indexOf('function mountTypedAgentRegexInputs'),
        entry.indexOf('function mountTypedAgentStreamChoice'),
    );
    assert.doesNotMatch(callers, /api\.mountInput\(/, 'callers must not grow a second primitive owner');
    for (const marker of [
        'vcpTypedAgentIdentity', 'vcpTypedAgentModel', 'vcpTypedAgentTemperature',
        'vcpTypedAgentContextLimit', 'vcpTypedAgentMaxOutput', 'vcpTypedAgentTopP',
        'vcpTypedAgentTopK', 'vcpTypedPrimitiveMounted',
    ]) {
        assert.match(callers, new RegExp(marker), `typed Agent Input marker must remain configured: ${marker}`);
    }
});

test('Agent section disclosures use one generated presentation owner and preserve manager-owned collapse state', () => {
    const entry = read(bridgeEntry);
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const owner = entry.slice(
        entry.indexOf('function mountTypedAgentSectionDisclosures(form)'),
        entry.indexOf('// The Agent inputs differ', entry.indexOf('function mountTypedAgentSectionDisclosures(form)')),
    );
    assert.match(owner, /api\?\.mountDisclosureRowController/, 'Agent headers must use the generated Light-DOM DisclosureRow controller');
    assert.match(owner, /manager\.toggleAgentSettingsSection\(key\)/, 'presentation must call the manager command, not mutate DOM/config itself');
    assert.match(owner, /new window\.MutationObserver\(sync\)/, 'selection restore must project canonical collapsed DOM state into ARIA');
    assert.match(owner, /scope\.own\(state\.cleanup/, 'the observer and marker must retract with the presentation owner');
    for (const key of ['identity', 'prompt', 'model', 'params', 'tts', 'regex']) {
        assert.match(owner, new RegExp(`['\"]${key}['\"]`), `section ${key} must be owned by the migration slice`);
    }
    assert.match(manager, /toggleAgentSettingsSection:\s*\(key\)\s*=>\s*toggleAgentSettingsSection\(key\)/,
        'SettingsManager must expose one narrow canonical toggle command');
    const controller = manager.slice(
        manager.indexOf('function createSectionController(key, buildSummary)'),
        manager.indexOf('function buildIdentitySummary()', manager.indexOf('function createSectionController(key, buildSummary)')),
    );
    assert.doesNotMatch(controller, /header\.addEventListener\('click'/,
        'legacy manager header listeners must be retired once the typed owner owns activation');
    assert.match(owner, /const mounted = new Set\(\)/,
        'the typed owner must report exactly which canonical sections it adopted');
    assert.match(entry, /if \(!typedAgentSectionOwners\.has\(section\)\) enhance\('SettingsSection', section\)/,
        'a section without the generated artifact must retain the legacy fallback owner');
    assert.doesNotMatch(entry, /form\.querySelectorAll\('\.agent-settings-section, \.group-settings-section'\)/,
        'Agent sections must not be bulk-enhanced alongside a typed owner');
});

test('global voice mode adopts generated Choice without extending the frozen chat radio surface', () => {
    const entry = read(bridgeEntry);
    const css = read(path.join(root, 'styles', 'ui-system', 'settings-overrides.css'));
    assert.match(entry, /mountTypedGlobalChoiceGroups\(root, form\)/, 'global settings enhancement wires the Choice batch');
    const choiceOwner = entry.match(/function mountTypedGlobalChoiceGroups\(root, form\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(choiceOwner, /\['voiceModeLocal', 'voice-mode-choice'\]/, 'voice mode is the active high-frequency native radio consumer');
    assert.match(choiceOwner, /api\.mountChoice\(group, scope\)/, 'the generated Choice mounts under the presentation owner');
    assert.doesNotMatch(choiceOwner, /chatLayoutMode/, 'the frozen chat-layout radio group is excluded from this presentation batch');
    assert.doesNotMatch(css, /#voiceModeLocal/, 'the retired page-local voice radio CSS no longer competes with Choice');
});

test('global typed primitive mounts keep one lifecycle registration per primitive', () => {
    const entry = read(bridgeEntry);
    const globalTypedOwners = entry.slice(
        entry.indexOf('function mountTypedRadiusChoice'),
        entry.indexOf('// Single-line text inputs are projected'),
    );
    // Each generated primitive calls scope.own() internally.  The bridge can
    // own its DOM marker, but must not register the returned release again:
    // that adds a second resource to every Settings-open cycle and asks the
    // same idempotent disposer to run twice during teardown.
    assert.doesNotMatch(globalTypedOwners, /scope\.own\(\w*release[,) ]/i,
        'bridge must not duplicate generated primitive disposers in the presentation scope');
    for (const primitive of ['mountChoice', 'mountRange', 'mountToggle', 'mountColorPair', 'mountInput', 'mountSelect']) {
        assert.match(globalTypedOwners, new RegExp(`api\\.${primitive}\\(`),
            `${primitive} must remain mounted by the generated primitive`);
    }
});

test('Select option rebuild turns are owned and retract cleanly with the presentation scope', async () => {
    const dom = new JSDOM('<!doctype html><form><select id="voice"><option value="one">One</option><option value="two">Two</option></select></form>');
    const previous = Object.fromEntries([
        'window', 'document', 'Element', 'Node', 'Event', 'MutationObserver', 'Option', 'HTMLElement',
    ].map(key => [key, globalThis[key]]));
    const records = new Set();
    const createScope = () => {
        let active = true;
        const scope = {
            get active() { return active; },
            own(disposer) {
                let released = false;
                const release = () => {
                    if (released) return Promise.resolve();
                    released = true;
                    records.delete(release);
                    return Promise.resolve(disposer());
                };
                records.add(release);
                return release;
            },
            child() {
                const child = createScope();
                scope.own(() => child.dispose());
                return child;
            },
            async dispose() {
                if (!active) return;
                active = false;
                await Promise.all([...records].reverse().map(release => release()));
            },
        };
        return scope;
    };
    const scope = createScope();
    try {
        Object.assign(globalThis, {
            window: dom.window,
            document: dom.window.document,
            Element: dom.window.Element,
            Node: dom.window.Node,
            Event: dom.window.Event,
            MutationObserver: dom.window.MutationObserver,
            Option: dom.window.Option,
            HTMLElement: dom.window.HTMLElement,
        });
        let mounts = 0;
        dom.window.VCPUIUX = {
            mountSelect(select, _props, selectScope) {
                mounts += 1;
                const parent = select.parentNode;
                const wrap = dom.window.document.createElement('span');
                wrap.className = 'vcp-harness-select';
                parent.insertBefore(wrap, select);
                wrap.append(select);
                return selectScope.own(() => {
                    if (select.parentNode === wrap) parent.insertBefore(select, wrap);
                    wrap.remove();
                });
            },
        };
        const projectionModule = await import(`${pathToFileURL(path.join(settingsDir, 'select-projection.js')).href}?scope-owner=${Date.now()}`);
        const projection = projectionModule.createSelectProjection({ ensurePresentationScope: () => scope });
        const form = dom.window.document.querySelector('form');
        const select = dom.window.document.querySelector('select');
        projection.mount(form);
        assert.equal(mounts, 1, 'initial native select receives one projection');

        select.append(new dom.window.Option('Three', 'three'));
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(mounts, 2, 'option-list change remounts exactly one projection');
        assert.equal(form.dataset.vcpSelectRebuilding, undefined, 'rebuild guard releases after the owned continuation');

        await scope.dispose();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(form.querySelectorAll('.vcp-harness-select').length, 0, 'scope disposal restores the canonical select DOM');
        assert.equal(records.size, 0, 'observer and deferred turns are retracted from the owner');
    } finally {
        Object.entries(previous).forEach(([key, value]) => {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        });
        dom.window.close();
    }
});
