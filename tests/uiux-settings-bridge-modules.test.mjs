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
const eventListeners = path.join(root, 'modules', 'event-listeners.js');
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

    const advanced = await import(pathToFileURL(path.join(settingsDir, 'advanced-visibility.js')).href);
    assert.equal(typeof advanced.syncAdvancedSettingsVisibility, 'function');
    const rust = await import(pathToFileURL(path.join(settingsDir, 'rust-visibility.js')).href);
    assert.equal(typeof rust.syncRustAssistantVisibility, 'function');
    const render = await import(pathToFileURL(path.join(settingsDir, 'render-visibility.js')).href);
    assert.equal(typeof render.syncRenderSettingsVisibility, 'function');
    const appearance = await import(pathToFileURL(path.join(settingsDir, 'appearance-controls.js')).href);
    assert.equal(typeof appearance.mountAppearanceSelects, 'function');
    const ranges = await import(pathToFileURL(path.join(settingsDir, 'appearance-ranges.js')).href);
    assert.equal(typeof ranges.mountAppearanceRanges, 'function');
    const toggles = await import(pathToFileURL(path.join(settingsDir, 'appearance-toggles.js')).href);
    assert.equal(typeof toggles.mountAppearanceToggles, 'function');
    const home = await import(pathToFileURL(path.join(settingsDir, 'home-controls.js')).href);
    assert.equal(typeof home.mountHomeTaglineInput, 'function');
    const identity = await import(pathToFileURL(path.join(settingsDir, 'identity-controls.js')).href);
    assert.equal(typeof identity.mountIdentityColorPairs, 'function');
    const choices = await import(pathToFileURL(path.join(settingsDir, 'choice-controls.js')).href);
    assert.equal(typeof choices.mountChoiceControls, 'function');
    const forum = await import(pathToFileURL(path.join(settingsDir, 'forum-controls.js')).href);
    assert.equal(typeof forum.mountForumCredentialInputs, 'function');
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
    assert.match(entry, /from '\.\/settings\/advanced-visibility\.js'/, 'entry must import the advanced section helper');
    assert.match(entry, /from '\.\/settings\/rust-visibility\.js'/, 'entry must import the Rust section helper');
    assert.match(entry, /from '\.\/settings\/render-visibility\.js'/, 'entry must import the render section helper');
    assert.match(entry, /from '\.\/settings\/appearance-controls\.js'/, 'entry must import the appearance helper');
    const globalOwners = [...entry.matchAll(/window\.VCPUISettingsBridge\s*=/g)].length;
    assert.equal(globalOwners, 1, 'exactly one window.VCPUISettingsBridge assignment');
});

test('legacy Rust visibility listeners are fallback-only when typed consumer is active', () => {
    const source = read(eventListeners);
    const binder = source.slice(source.indexOf('async function setupRustAssistantConfigListeners'), source.indexOf('async function loadAndPopulateRustConfig'));
    assert.match(binder, /await loadAndPopulateRustConfig\(\);/);
    assert.match(binder, /if \(window\.VCPUISettingsBridge\?\.getRustAssistantService\?\.\(\)\) return;/,
        'legacy Rust binder must exit when the typed section owner is available');
});

test('legacy ColorPair binder is artifact-fallback-only', () => {
    const source = read(eventListeners);
    const bind = source.slice(source.indexOf('if (!modal.dataset.globalSettingsControlsBound)'), source.indexOf('const openGlobalSettings'));
    assert.match(bind, /if \(!window\.VCPUIUX\?\.mountColorPair\) setupColorSyncListeners\(\);/,
        'legacy color mirror listeners must not run beside generated ColorPair');
});

test('render visibility helper projects all custom typography rows', async () => {
    const { syncRenderSettingsVisibility } = await import(pathToFileURL(path.join(settingsDir, 'render-visibility.js')).href);
    const dom = new JSDOM(`<!doctype html><form>
        <select id="chatFontPreset"><option value="system">system</option><option value="custom">custom</option></select><div id="chatFontCustomRow"></div>
        <select id="chatCodeFontPreset"><option value="system">system</option><option value="custom">custom</option></select><div id="chatCodeFontCustomRow"></div>
        <select id="chatDiaryFontPreset"><option value="system">system</option><option value="custom">custom</option></select><div id="chatDiaryFontCustomRow"></div>
        <select id="chatToolFontPreset"><option value="system">system</option><option value="custom">custom</option></select><div id="chatToolFontCustomRow"></div>
    </form>`);
    const form = dom.window.document.querySelector('form');
    syncRenderSettingsVisibility(form);
    for (const id of ['chatFontCustomRow', 'chatCodeFontCustomRow', 'chatDiaryFontCustomRow', 'chatToolFontCustomRow']) {
        assert.equal(form.querySelector(`#${id}`).style.display, 'none');
    }
    form.querySelector('#chatCodeFontPreset').value = 'custom';
    form.querySelector('#chatToolFontPreset').value = 'custom';
    syncRenderSettingsVisibility(form);
    assert.equal(form.querySelector('#chatCodeFontCustomRow').style.display, 'block');
    assert.equal(form.querySelector('#chatToolFontCustomRow').style.display, 'block');
    assert.equal(form.querySelector('#chatFontCustomRow').style.display, 'none');
});

test('render preset listeners retract with the typed field owner', () => {
    const entry = read(bridgeEntry);
    const owner = entry.slice(entry.indexOf('function mountTypedFieldOwner'), entry.indexOf('function flushSettingsAutosave'));
    assert.match(owner, /renderPresetIds = \['chatFontPreset', 'chatCodeFontPreset', 'chatDiaryFontPreset', 'chatToolFontPreset'\]/);
    assert.match(owner, /select\.addEventListener\('change', onRenderPresetChange\)/);
    assert.match(owner, /state\.cleanups\.push\(\(\) => select\.removeEventListener\('change', onRenderPresetChange\)\)/);
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

test('global network-path add action uses the generated Button owner', () => {
    const entry = read(bridgeEntry);
    const shellCss = read(path.join(root, 'styles', 'ui-system', 'settings-shell.css'));
    const owner = entry.match(/function mountGlobalSettingsPathAction\(root\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(entry, /mountGlobalSettingsPathAction\(globalSettingsModal\);/,
        'global Settings refresh must adopt the network-path action');
    assert.match(owner, /#addNetworkPathBtn/);
    assert.match(owner, /api\.mountButton\(button, \{ variant: 'outline', size: 'sm' \}, scope\)/);
    assert.match(owner, /delete button\.dataset\.vcpTypedNetworkPathAction/);
    assert.match(shellCss, /#openTopicSummaryModelSelectBtn\)\:not\(\.vcp-harness-button\)/,
        'legacy Settings action CSS must exclude generated Buttons');
});

test('Agent section disclosures use one generated presentation owner and preserve manager-owned collapse state', () => {
    const entry = read(bridgeEntry);
    const disclosureModule = read(path.join(settingsDir, 'agent-disclosures.js'));
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const owner = disclosureModule;
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
    assert.match(owner, /try \{[\s\S]*?api\.mountDisclosureRowController[\s\S]*?\} catch \(error\) \{/,
        'one failed generated adoption must leave the remaining form eligible for legacy fallback');
    assert.match(entry, /if \(!typedAgentSectionOwners\.has\(section\)\) enhance\('SettingsSection', section\)/,
        'a section without the generated artifact must retain the legacy fallback owner');
    assert.doesNotMatch(entry, /form\.querySelectorAll\('\.agent-settings-section, \.group-settings-section'\)/,
        'Agent sections must not be bulk-enhanced alongside a typed owner');
});

test('Agent TTS Range has one presentation output owner and no manager-side listener', () => {
    const entry = read(bridgeEntry);
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const rangeOwner = entry.match(/function mountTypedAgentTtsSpeedRange\(form\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const controlsCss = read(path.join(root, 'styles', 'setting', 'settings-form-controls.css'));
    assert.match(rangeOwner, /api\.mountRange\(input, \{ output, format: value => Number\.parseFloat\(value\)\.toFixed\(1\) \}, scope\)/,
        'generated Range must preserve the existing one-decimal TTS speed presentation');
    assert.doesNotMatch(manager, /function syncRangeProgress\(/,
        'the retired manager-only range progress projection must not remain after the typed Range owns presentation');
    assert.doesNotMatch(manager, /agentTtsSpeedSlider\.addEventListener\('input'/,
        'SettingsManager must not retain a second TTS output listener beside the generated Range');
    assert.doesNotMatch(manager, /ttsSpeedValueSpan/,
        'SettingsManager must not retain a display-node reference after the generated Range owns output projection');
    assert.doesNotMatch(controlsCss, /#agentTtsSpeed\s*\{/,
        'the typed Range wrapper, not an Agent-id selector, must own flexible row geometry');
});

test('Agent TTS Voice Select keeps business option loading while one typed projection owns presentation', () => {
    const entry = read(bridgeEntry);
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const selectProjection = read(path.join(settingsDir, 'select-projection.js'));
    const agentCss = read(path.join(root, 'styles', 'setting', 'settings-agent-card-shell.css'));
    const enhanceForm = entry.slice(entry.indexOf('function enhanceForm(form)'), entry.indexOf('function mountHarnessSwitches', entry.indexOf('function enhanceForm(form)')));

    assert.match(enhanceForm, /selectProjection\.mount\(form\)/,
        'Agent TTS Voice Select must mount through the shared generated Select projection');
    assert.match(enhanceForm, /if \(!select\.closest\('\.vcp-harness-select'\)\) enhance\('Select'/,
        'legacy VCPUI Select enhancement must not mount inside a typed Select wrapper');
    assert.match(selectProjection, /select\.dataset\.vcpTypedPrimitiveMounted === 'true'/,
        'a native node already owned by the generated primitive must not receive a second projection');
    assert.match(selectProjection, /selectScope = scope\.child\(`select-projection:/,
        'each Select presentation owner must retract with its own child scope');
    assert.match(selectProjection, /new window\.MutationObserver\(/,
        'dynamic model option replacement must be observed by the one Select projection owner');
    assert.match(manager, /async function populateTtsModels\(currentPrimaryVoice, currentSecondaryVoice\)/,
        'TTS voice model discovery remains the canonical business loader');
    assert.match(manager, /commitOptions\(agentTtsVoicePrimarySelect, primaryOptions, currentPrimaryVoice\)/,
        'the primary native select remains the canonical option/value node');
    assert.match(manager, /commitOptions\(agentTtsVoiceSecondarySelect, secondaryOptions, currentSecondaryVoice\)/,
        'the secondary native select remains the canonical option/value node');
    assert.match(manager, /await electronAPI\.sovitsGetModels\(true\)/,
        'the refresh command remains on the native TTS model path');
    assert.doesNotMatch(manager, /agentTtsVoice(?:Primary|Secondary)Select\.addEventListener\(/,
        'SettingsManager must not register a competing TTS Select presentation listener');
    assert.ok(agentCss.includes('#agentSettingsContainer select:not(.vcp-harness-select-native)'), 'legacy Select CSS must exclude the typed native node');
    assert.ok(/body(?:\.light-theme|\[data-vcp-theme="light"\]) #agentSettingsContainer select:not\(\.vcp-harness-select-native\)/.test(agentCss), 'light Select CSS must exclude the typed native node');
    assert.ok(/body(?::not\(\.light-theme\)|\[data-vcp-theme="dark"\]) #agentSettingsContainer select:not\(\.vcp-harness-select-native\)/.test(agentCss), 'dark Select CSS must exclude the typed native node');
});

test('Agent shell CSS leaves typed primitive inner controls to their own presentation owner', () => {
    const shellCss = read(path.join(root, 'styles', 'ui-system', 'settings-shell.css'));
    const cardCss = read(path.join(root, 'styles', 'setting', 'settings-agent-card-shell.css'));
    const legacyControlsCss = read(path.join(root, 'styles', 'setting', 'agent', 'agent-card-controls.css'));
    const paramsCss = read(path.join(root, 'styles', 'setting', 'settings-agent-params.css'));
    for (const selector of [
        '.vcp-uiux-input-wrap > input',
        '.vcp-uiux-color-pair > input',
        '.vcp-uiux-range > input',
        '.vcp-harness-select-native',
    ]) {
        assert.ok(shellCss.includes(selector), `legacy Agent shell selectors must exclude typed primitive internals: ${selector}`);
    }
    assert.match(shellCss, /Generated primitives own the inner native control's geometry and focus/,
        'the ownership boundary must remain explicit rather than relying on cascade order');
    assert.match(cardCss, /input\[type="text"\][\s\S]*?:not\(\.input\):not\(:is\(\.vcp-uiux-color-pair > input\)\)/,
        'legacy Agent card text rules must exclude generated Input and ColorPair inner nodes');
    assert.match(legacyControlsCss, /input\[type="text"\][\s\S]*?:not\(\.input\):not\(:is\(\.vcp-uiux-color-pair > input\)\)/,
        'the still-loaded Agent control fallback must also exclude generated Input and ColorPair inner nodes');
    assert.match(legacyControlsCss, /select:not\(\.vcp-harness-select-native\)/,
        'the still-loaded Agent control fallback must not style a typed Select native node');
    assert.match(paramsCss, /\.params-content input\[type="number"\]:not\(\.input\)/,
        'the parameter-sheet numeric fallback must exclude generated Input nodes');
    assert.doesNotMatch(paramsCss, /\.params-content input\[type="number"\](?!:not\(\.input\))/,
        'the parameter sheet must not retain a competing numeric Input presentation owner');
});

test('Agent ColorPairs have one generated synchronization owner and preserve canonical color controls', () => {
    const entry = read(bridgeEntry);
    const manager = read(path.join(root, 'modules', 'settingsManager.js'));
    const owner = entry.match(/function mountTypedAgentColorPairs\(form\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(owner, /api\.mountColorPair\(color, text, scope, \{/, 'Agent ColorPairs must inject the generated presentation contract');
    assert.match(owner, /onValueChange: value =>/, 'avatar border preview must be an injected presentation reaction');
    assert.match(owner, /onInvalid: \(\) => window\.uiHelperFunctions\?\.showToastNotification/, 'invalid hex feedback must remain on the owned presentation path');
    assert.doesNotMatch(manager, /function setupColorPickerSync\(/,
        'SettingsManager must not retain duplicate color/text synchronization listeners');
    assert.doesNotMatch(manager, /function updateAvatarPreviewStyle\(/,
        'avatar border preview updates must not retain a manager-side presentation helper');
    assert.doesNotMatch(manager, /setupColorPickerSync\(\)/,
        'SettingsManager init must not remount the retired ColorPair listener bundle');
    for (const id of ['agentAvatarBorderColor', 'agentAvatarBorderColorText', 'agentNameTextColor', 'agentNameTextColorText']) {
        assert.match(manager, new RegExp(id), `canonical Agent color control ${id} must remain available to persistence/reset commands`);
    }
});

test('global voice mode adopts generated Choice without extending the frozen chat radio surface', () => {
    const entry = read(bridgeEntry);
    const css = read(path.join(root, 'styles', 'ui-system', 'settings-overrides.css'));
    assert.match(entry, /mountChoiceControls\(form, window\.VCPUIUX, ensurePresentationScope\(\)\)/, 'global settings enhancement wires the Choice batch');
    const choiceOwner = read(path.join(settingsDir, 'choice-controls.js'));
    assert.match(choiceOwner, /#voiceModeLocal/, 'voice mode is the active high-frequency native radio consumer');
    assert.match(choiceOwner, /api\.mountChoice\(voice, scope\)/, 'the generated Choice mounts under the presentation owner');
    assert.doesNotMatch(choiceOwner, /chatLayoutMode/, 'the frozen chat-layout radio group is excluded from this presentation batch');
    assert.doesNotMatch(css, /#voiceModeLocal/, 'the retired page-local voice radio CSS no longer competes with Choice');
});

test('global typed primitive mounts keep one lifecycle registration per primitive', () => {
    const entry = read(bridgeEntry);
    const appearance = read(path.join(settingsDir, 'appearance-controls.js'));
    const ranges = read(path.join(settingsDir, 'appearance-ranges.js'));
    const toggles = read(path.join(settingsDir, 'appearance-toggles.js'));
    const home = read(path.join(settingsDir, 'home-controls.js'));
    const identity = read(path.join(settingsDir, 'identity-controls.js'));
    const choices = read(path.join(settingsDir, 'choice-controls.js'));
    const forum = read(path.join(settingsDir, 'forum-controls.js'));
    const globalTypedOwners = entry.slice(
        entry.indexOf('function mountTypedRadiusChoice'),
        entry.indexOf('// Single-line text inputs are projected'),
    ) + '\n' + appearance + '\n' + ranges + '\n' + toggles + '\n' + home + '\n' + identity + '\n' + choices + '\n' + forum;
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
