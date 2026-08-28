import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessCandidates = [
    process.env.DEEPSEEK_HARNESS_ROOT,
    '/Users/asahi/Documents/Codex/deepseek-harness',
    'C:/VCP/vchat-develop/deepseek-harness',
].filter(Boolean);
const harnessRoot = harnessCandidates.find(candidate => fs.existsSync(candidate)) || harnessCandidates[0];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const bridge = read('modules/ui-system/settings-bridge.js');
const readCssEntry = file => {
    const entry = read(file);
    const imports = [...entry.matchAll(/@import\s+url\(['"]([^'"]+)['"]\)\s*;/g)]
        .map(match => path.posix.normalize(path.posix.join(path.posix.dirname(file.replaceAll(path.sep, '/')), match[1])));
    return [entry, ...imports.map(read)].join('\n');
};
const css = readCssEntry('styles/ui-system/settings.css');
const html = read('main.html');
const selectProjection = read('modules/ui-system/settings/select-projection.js');
const canonicalRows = read('modules/ui-system/settings/canonical-rows.js');
const settingsModules = `${bridge}\n${selectProjection}\n${canonicalRows}`;
const settingsEntry = read('styles/settings.css');
const agentFormCss = read('styles/setting/settings-agent-form.css');
const agentIdentityCss = read('styles/setting/settings-agent-identity.css');
const agentGroupSectionsCss = read('styles/setting/settings-group-sections.css');
const agentSidebarTabsCss = read('styles/setting/settings-sidebar-tabs.css');
const agentPromptCss = read('styles/setting/settings-agent-prompt.css');
const agentPromptEditorCss = read('styles/setting/agent/agent-prompt-editor.css');
const agentCardShellCss = read('styles/setting/settings-agent-card-shell.css');
const promptModulesCss = read('Promptmodules/prompt-modules.css');
const eventListeners = read('modules/event-listeners.js');
const uiHelpers = read('modules/ui-helpers.js');
const presentationOwner = read('modules/renderer/mainChatSettingsPresentationOwner.js');
const renderer = read('renderer.js');

// ---- Retirement evidence E1 (handoff ledger): main.html is the only
// document that renders the global settings form, and it declares
// uiMode=next statically.  The only uiMode:'classic' producer is the
// embedded-app session manager, whose allowlist pages never contain the
// settings modal, so the presentationOwner fallback can never be a
// cross-surface Classic compatibility layer; its only job is the
// startup/partial-mount window inside main.html. ----
assert.match(html, /data-ui-mode="next"/, 'main.html must declare the canonical next uiMode statically');
const embeddedAllowlistSource = read('modules/shared/embeddedAppAllowlist.js');
const embeddedPages = [...embeddedAllowlistSource.matchAll(/page:\s*'([^']+)'/g)].map(match => match[1]);
assert.ok(embeddedPages.length >= 9, `embedded allowlist must still enumerate its pages (${embeddedPages.length})`);
for (const page of embeddedPages) {
    const pageSource = read(page);
    assert.doesNotMatch(pageSource, /globalSettingsForm|globalSettingsModal/, `embedded page must not render the global settings surface: ${page}`);
}

// ---- Retirement (E1/E6, handoff ledger): main.html is the only document
// that renders the global settings form, and it declares uiMode=next
// statically.  The only uiMode:'classic' producer is the embedded-app
// session manager, whose allowlist pages never contain the settings modal.
// The presentationOwner startup fallback projection is retired; the typed
// projection owners are the sole form writers, and the control-touch
// inventory below guards every id against a new second writer. ----
assert.match(html, /data-ui-mode="next"/, 'main.html must declare the canonical next uiMode statically');
assert.doesNotMatch(presentationOwner, /typedSettingsProjectionActive/, 'the retired startup fallback guard must stay deleted');
assert.doesNotMatch(presentationOwner, /safeSet\('userName'|safeSet\('vcpServerUrl'|safeSet\('chatFontPreset'/, 'the retired fallback projection branches must stay deleted');
assert.match(bridge, /speechRecognizerPagePath', 'Voicechatmodules\/recognizer\.html'/, 'the ported speech page-path display default must live in the typed projection');
assert.match(bridge, /voiceNetworkProviderUrl', 'https:\/\/api\.siliconflow\.cn'/, 'the ported provider-url display default must live in the typed projection');
const FALLBACK_TOUCHERS = {
    userName: ['modules/global-settings-manager.js'],
    userAvatarBorderColor: ['modules/event-listeners.js', 'modules/global-settings-manager.js'],
    userAvatarBorderColorText: ['modules/event-listeners.js'],
    userNameTextColor: ['modules/event-listeners.js', 'modules/global-settings-manager.js'],
    userNameTextColorText: ['modules/event-listeners.js'],
    vcpServerUrl: ['modules/global-settings-manager.js', 'modules/settingsManager.js'],
    vcpApiKey: ['modules/global-settings-manager.js'],
    fileKey: ['modules/global-settings-manager.js'],
    vcpLogUrl: ['modules/global-settings-manager.js'],
    vcpLogKey: ['modules/global-settings-manager.js'],
    topicSummaryModel: ['modules/global-settings-manager.js', 'modules/settingsManager.js', 'renderer.js'],
    continueWritingPrompt: ['modules/global-settings-manager.js'],
    flowlockContinueDelay: ['modules/global-settings-manager.js'],
    speechRecognizerBrowserPath: ['modules/global-settings-manager.js'],
    speechRecognizerPagePath: ['modules/global-settings-manager.js'],
    voiceLocalSovitsUrl: ['modules/global-settings-manager.js'],
    voiceLocalSovitsKey: ['modules/global-settings-manager.js'],
    voiceNetworkProviderUrl: ['modules/global-settings-manager.js'],
    voiceNetworkProviderKey: ['modules/global-settings-manager.js'],
    enableSmoothStreaming: ['modules/global-settings-manager.js'],
    voiceModeLocal: [],
    voiceModeNetwork: ['modules/global-settings-manager.js'],
    chatFontPreset: ['modules/global-settings-manager.js'],
    chatFontCustom: ['modules/global-settings-manager.js'],
    chatCodeFontPreset: ['modules/global-settings-manager.js'],
    chatCodeFontCustom: ['modules/global-settings-manager.js'],
    chatDiaryFontPreset: ['modules/global-settings-manager.js'],
    chatDiaryFontCustom: ['modules/global-settings-manager.js'],
    chatToolFontPreset: ['modules/global-settings-manager.js'],
    chatToolFontCustom: ['modules/global-settings-manager.js'],
    chatLayoutModeWide: ['modules/global-settings-manager.js', 'modules/ui-system/appearance-studio.js'],
    chatLayoutModeNormal: [],
    enableUserChatBubbleUi: ['modules/global-settings-manager.js'],
    showUserMetaInChatBubbleUi: ['modules/global-settings-manager.js'],
    chatBubbleMaxWidthWideDefault: ['modules/global-settings-manager.js'],
    chatBubbleMaxWidthWideNotifications: ['modules/global-settings-manager.js'],
    chatBubbleMaxWidthWideNarrow: ['modules/global-settings-manager.js'],
    minChunkBufferSize: ['modules/global-settings-manager.js'],
    smoothStreamIntervalMs: ['modules/global-settings-manager.js'],
};
const OWNER_FILES = new Set(['modules/ui-system/settings-bridge.js', 'modules/renderer/mainChatSettingsPresentationOwner.js']);
const collectJsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJsFiles(child);
    return entry.name.endsWith('.js') ? [child] : [];
});
const moduleFiles = [...collectJsFiles(path.join(root, 'modules')), path.join(root, 'renderer.js')];
// Post-retirement negative guard: each fallback-era control id must still
// exist in main.html, must be covered by the typed projection/field owner
// (never by a resurrected presentationOwner fallback), and must keep its
// pinned external toucher set — a new second writer must update this
// inventory in the same commit.
for (const [id, expectedTouchers] of Object.entries(FALLBACK_TOUCHERS)) {
    assert.match(html, new RegExp(`id="${id}"`), `fallback id must exist as a control in main.html: ${id}`);
    assert.ok(bridge.includes(`'${id}'`), `the typed projection/field owner must cover the fallback id: ${id}`);
    const actualTouchers = moduleFiles
        .filter(file => !OWNER_FILES.has(path.relative(root, file).split(path.sep).join('/')))
        .filter(file => fs.readFileSync(file, 'utf8').includes(`getElementById('${id}')`))
        .map(file => path.relative(root, file).split(path.sep).join('/'))
        .sort();
    assert.deepEqual(actualTouchers, [...expectedTouchers].sort(), `unexpected control toucher set for fallback id ${id}`);
}

// These assertions are deliberately source-level.  A screenshot can prove a
// visual outcome but cannot prove that an old List/search owner is absent.
assert.ok(fs.existsSync(harnessRoot), `DeepSeek Harness checkout is required: ${harnessRoot}`);
const harnessRootCss = fs.readFileSync(path.join(harnessRoot, 'packages/client/ui-settings-general/src/client/SettingsRoot.module.css'), 'utf8');
const harnessMenuCss = fs.readFileSync(path.join(harnessRoot, 'packages/client/ui-primitives/src/Menu.module.css'), 'utf8');
const harnessInputCss = fs.readFileSync(path.join(harnessRoot, 'packages/client/ui-primitives/src/Input.module.css'), 'utf8');

// SettingsRoot tree contract: the bridge must construct one canonical root and
// direct panel/nav/content/header/options ownership.
assert.match(bridge, /root\.classList\.add\('vcp-harness-settings-root'/);
assert.match(bridge, /panel\.classList\.add\('vcp-harness-settings-panel'/);
assert.match(bridge, /nav\.replaceChildren\(title, canonicalNav\)/);
assert.match(bridge, /content\.replaceChildren\(header, options\)/);
assert.match(bridge, /panel\.replaceChildren\(nav, content\)/);
assert.match(bridge, /vcp-harness-settings-nav-cell/);
assert.match(bridge, /dataset\.vcpCanonicalNav/);
assert.doesNotMatch(bridge, /row\.setAttribute\('role', 'tab'\)/, 'Harness nav cells must remain ordinary buttons');
assert.doesNotMatch(bridge, /section\.setAttribute\('role', 'tabpanel'\)/, 'Harness settings sections must not retain tabpanel semantics');

// Retired shell owners must not be callable or mounted by the bridge.
for (const forbidden of [
    'mountLegacySearch',
    'vcp-ui-settings-search',
    "VCPUI.create('List'",
    'vcp-global-settings-next',
    'vcp-ui-settings-shell',
]) {
    assert.doesNotMatch(bridge, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `retired bridge owner remains: ${forbidden}`);
}
assert.doesNotMatch(bridge, /vcp-harness-legacy-anchor/, 'canonical rows must not retain legacy anchor presentation');
assert.doesNotMatch(bridge, /vcp-settings-source-item/, 'source nav items must not be a runtime owner');
assert.doesNotMatch(bridge, /global-settings-footer|data-vcp-settings-section/, 'retired settings group/footer owners must be absent');
assert.doesNotMatch(css, /vcp-harness-legacy-anchor/, 'legacy anchor CSS must be deleted');
assert.doesNotMatch(bridge, /vcp-settings-navigation-restored|originalLegacyClasses|originalPanelNodes/, 'retired legacy SettingsRoot restoration path must be deleted');
assert.match(bridge, /nav\.classList\.remove\('vcp-settings-source-nav'\)/, 'source nav marker must leave live tree');
assert.match(bridge, /content\.classList\.remove\('vcp-settings-source-content'\)/, 'source content marker must leave live tree');

// Forum credential seam (ownership ledger §5 candidate): the two inputs are
// projected by the typed forum consumer and saved only through
// ForumConfigUiService.save.execute; the legacy manager collect is gated on
// the typed owner being absent (Classic fallback).  A second writer outside
// the two owner files would break the single-route contract.
for (const forumId of ['adminUsername', 'adminPassword']) {
    const writers = moduleFiles
        .filter(file => fs.readFileSync(file, 'utf8').includes(`getElementById('${forumId}')`))
        .map(file => path.relative(root, file).split(path.sep).join('/'))
        .sort();
    assert.deepEqual(writers, ['modules/global-settings-manager.js'], `unexpected forum credential writer set for ${forumId}`);
    assert.ok(bridge.includes(`querySelector('#${forumId}')`), `the bridge typed forum consumer must own the ${forumId} projection`);
}
assert.match(bridge, /ForumConfigUiService|forum-config-ui/, 'the forum credential save route must go through the forum config service');
const globalSettingsManager = read('modules/global-settings-manager.js');
assert.match(globalSettingsManager, /forumFieldOwnerMounted/, 'the legacy forum collect must stay gated on the typed forum owner');

// Geometry values are copied from the Harness source, not inferred from VCP
// tokens.  Verify both the reference and the VCP canonical selectors.
const geometry = [
    [/width:\s*800px/, /\.vcp-harness-settings-panel[\s\S]*?width:\s*800px/],
    [/height:\s*min\(800px,\s*calc\(100vh\s*-\s*48px\)\)/, /\.vcp-harness-settings-panel[\s\S]*?height:\s*min\(800px,\s*calc\(100vh\s*-\s*48px\)\)/],
    [/width:\s*188px/, /\.vcp-harness-settings-nav[\s\S]*?width:\s*188px/],
    [/height:\s*54px/, /\.vcp-harness-settings-header[\s\S]*?height:\s*54px/],
    [/padding:\s*0\s+24px\s+24px/, /\.vcp-harness-settings-options[\s\S]*?padding:\s*0\s+24px\s+24px/],
    [/height:\s*40px/, /\.vcp-harness-settings-nav-cell[\s\S]*?height:\s*40px/],
    [/border-radius:\s*12px/, /\.vcp-harness-settings-nav-cell[\s\S]*?border-radius:\s*12px/],
];
for (const [reference, canonical] of geometry) {
    assert.match(harnessRootCss, reference, `Harness geometry missing: ${reference}`);
    assert.match(css, canonical, `VCP canonical geometry missing: ${canonical}`);
}
assert.match(harnessMenuCss, /border-radius:\s*12px/);
assert.match(harnessMenuCss, /min-height:\s*40px/);
assert.match(harnessInputCss, /height:\s*32px/);
assert.match(harnessInputCss, /border-radius:\s*8px/);
assert.match(css, /vcp-harness-general-row[\s\S]*?border-radius:\s*8px[\s\S]*?font-size:\s*var\(--vcp-ui-font-body\)[\s\S]*?line-height:\s*22px/);
// Select presentation is owned by the real library Select primitive
// (window.VCPUIUX.mountSelect): the bridge must mount it for every non-typed
// select and must not retain the retired local Harness Menu projection.
assert.match(settingsModules, /api\.mountSelect\(select, \{ label: labelText, portal: true \}, selectScope\)/, 'Select presentation must come from the library primitive');
assert.match(selectProjection, /scope\.child\(`select-projection:\$\{select\.id \|\| 'anonymous'\}`\)/,
    'every projected Select must have a disposable child owner');
assert.match(settingsModules, /primitiveSelectStates/, 'primitive select projections must be tracked for dispose/remount');
assert.match(settingsModules, /mountSelectKeyboardGlue/, 'select keyboard projection must keep a11y parity');
assert.match(selectProjection, /scope\.own\(\(\) => releaseObserverState\(state\), 'select-projection-observer', 'observer'\)/,
    'option-change observer must be owned by the presentation scope');
assert.match(selectProjection, /scheduleScopeContinuation\(scope, 'select-projection-remount'/,
    'option-list remount continuation must be owned by the presentation scope');
assert.doesNotMatch(selectProjection, /__vcpSelectRebuildTimer|__vcpSelectMountTimer/,
    'select rebuild timers must not escape through ad-hoc form properties');
assert.doesNotMatch(settingsModules, /vcp-harness-select-wrap|vcp-harness-choice-wrap|rebuildOptions/, 'retired local select/choice projection must be deleted');
assert.doesNotMatch(css, /vcp-harness-select-wrap|vcp-harness-choice-wrap|vcp-harness-menu-portal/, 'retired local select/menu CSS must be deleted');

// The Agent ColorPair is a real typed production consumer. Its historic
// 37px/pill selectors remain available only to unwrapped native fallbacks;
// they must never penetrate the typed wrapper and override its documented
// 32px/8px candidate contract.
assert.match(agentIdentityCss, /\.color-input-group > input\[type="color"\]/,
    'legacy ColorPair color styling must be limited to direct native controls');
assert.match(agentIdentityCss, /\.color-input-group > input\[type="text"\]/,
    'legacy ColorPair text styling must be limited to direct native controls');
assert.doesNotMatch(agentIdentityCss, /\.color-input-group input\[type=/,
    'legacy ColorPair selectors must not penetrate the typed wrapper');
assert.match(agentFormCss, /input\[type="text"\]:not\(\.input\)/,
    'typed Harness Inputs must be excluded from the generic Agent input rule');
assert.match(agentFormCss, /select:not\(\.vcp-harness-select-native\)/,
    'typed Harness Select business nodes must be excluded from the generic Agent select rule');

// Single-line text input presentation is owned by the real library Input
// primitive (window.VCPUIUX.mountInput): the bridge mounts it per control
// (static rows and dynamic network-path rows alike) and the retired local
// wrapper must be gone from bridge and CSS.  Textareas stay bare controls —
// the primitive wrap is a fixed 32px single-line frame.
assert.match(bridge, /api\.mountInput\(control, \{\}, scope\)/, 'Input presentation must come from the library primitive');
assert.match(bridge, /inputApi\.mountInput\(input, \{\}, inputScope\)/, 'dynamic network-path rows must adopt the library Input primitive');
assert.doesNotMatch(bridge, /vcp-harness-input-wrap/, 'retired local input wrapper must be deleted from the bridge');
assert.doesNotMatch(css, /vcp-harness-input-wrap/, 'retired local input wrapper CSS must be deleted');
assert.match(css, /vcp-uiux-input-wrap\.vcp-harness-input-fill/, 'bridge-mounted Input wraps keep the row fill contract');

// Switch presentation is owned by the real library Toggle primitive
// (window.VCPUIUX.mountToggle): the bridge mounts it per checkbox (typed
// home-visual toggles keep their own mounts) and the retired local `.slider`
// styling must be gone from the settings CSS.
assert.match(bridge, /function mountHarnessSwitches/, 'switch mounting must be a shared real-primitive owner');
assert.match(bridge, /api\.mountToggle\(input, scope\)/, 'Switch presentation must come from the library primitive');
assert.doesNotMatch(css, /\.slider/, 'retired local slider CSS must be deleted');

// Dynamic networkNotesPaths rows have one save owner (the typed field
// owner's container delegation).  Both row builders — the bridge's and the
// ui-helpers fallback — must mark rows into that owner and announce row
// removal, so no creation path can bypass the dirty chain.
assert.match(bridge, /networkNotesPaths: collectNetworkNotesPaths\(\)/, 'the typed field owner must recollect the dynamic path list as one unit');
assert.match(uiHelpers, /vcpTypedFieldOwnerMounted/, 'ui-helpers rows must join the typed field owner when it is mounted');
assert.match(uiHelpers, /container\.dispatchEvent\(new Event\('change'/, 'ui-helpers row removal must announce the change to the save owner');
assert.match(bridge, /inputScope\.listen\(removeBtn, 'click', removeRow, \{ once: true \}\)/,
    'dynamic network path row removal must be owned by the presentation scope');

// Per-agent high-frequency controls must remain on the typed presentation
// path.  These guards prevent a later broad enhancer change from silently
// reintroducing a second wrapper owner around the canonical Agent form nodes.
for (const marker of [
    'mountTypedAgentIdentityInput(form)',
    'mountTypedAgentModelInput(form)',
    'mountTypedAgentTemperatureInput(form)',
    'mountTypedAgentNumericInputs(form)',
    'mountTypedAgentRegexInputs(form)',
    'mountTypedAgentStreamChoice(form)',
    'mountTypedAgentTtsSpeedRange(form)',
    'mountTypedAgentColorPairs(form)',
    'mountTypedAgentButtons(form)',
    'mountTypedAgentModelPicker(form)',
    'mountTypedAgentPromptModeButtons(form)',
]) {
    assert.ok(bridge.includes(marker), `Agent control owner missing: ${marker}`);
}
assert.match(bridge, /mountChoice\(group, scope\)/, 'Agent stream output must use the Choice primitive');
assert.ok(html.includes('agentStreamOutputTrue') && html.includes('agentStreamOutputFalse'), 'Agent stream radio pair contract must remain explicit');
assert.match(bridge, /agentNameInput.*agentModel.*agentTemperature.*agentContextTokenLimit.*agentMaxOutputTokens.*agentTopP.*agentTopK/s, 'Agent Input exclusions must cover the complete high-frequency cluster');
const typedAgentInputHelper = bridge.match(/function mountTypedAgentInput\(form, \{ id, marker, ownerKey, placeholder = false, restoreClass = false \}\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
assert.match(typedAgentInputHelper, /api\.mountInput\(input, props, scope\)/,
    'the private Agent Input owner must keep the primitive mount on the injected presentation scope');
assert.match(typedAgentInputHelper, /delete input\.dataset\[marker\]/,
    'the private Agent Input owner must retract its marker with the scope');
assert.match(typedAgentInputHelper, /restoreClass && input\.isConnected/,
    'the private Agent Input owner must restore original native classes only for fields that previously required it');
const typedAgentInputConsumers = bridge.slice(
    bridge.indexOf('function mountTypedAgentRegexInputs'),
    bridge.indexOf('function mountTypedAgentStreamChoice'),
);
assert.doesNotMatch(typedAgentInputConsumers, /api\.mountInput\(/,
    'Agent Input callers must delegate lifecycle work to the one private helper');

// AgentModelPicker owns the model trigger as a distinct composite. Keep it
// out of the generic Button batch so a refresh can never install two
// presentation/lifecycle owners on #openModelSelectBtn again.
const agentButtonOwner = bridge.match(/function mountTypedAgentButtons\(form\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
assert.doesNotMatch(agentButtonOwner, /openModelSelectBtn/, 'ModelPicker trigger must not re-enter the generic Agent Button owner');
assert.match(bridge, /api\.mountAgentModelPicker\(host,/, 'Agent ModelPicker must have one explicit composite owner');

// Once a real Agent Settings node has been adopted by the generated Button,
// the historical Settings sheets may keep container layout and the unadopted
// fallback branch, but must no longer restyle that button's geometry, fill or
// prompt-mode state.  This is deliberately a negative owner gate: without
// it, a later high-specificity legacy rule can make a typed Button only a
// class marker while its visual owner remains the old CSS stack.
for (const [label, source] of Object.entries({
    shell: css,
    agentForm: agentFormCss,
    groupSections: agentGroupSectionsCss,
    sidebarTabs: agentSidebarTabsCss,
    identity: agentIdentityCss,
})) {
    assert.doesNotMatch(source, /#agentSettingsForm \.form-actions button(?:[.#\[:]|\s|,|\{)(?![^\{]*vcp-harness-button)/,
        `${label}: typed Agent action Buttons must be excluded from legacy action styling`);
}
for (const [label, source] of Object.entries({
    shell: css,
    prompt: agentPromptCss,
    promptEditor: agentPromptEditorCss,
    cardShell: agentCardShellCss,
    promptModules: promptModulesCss,
})) {
    assert.doesNotMatch(source, /\.prompt-mode-button(?:\.|:|\s|,|\{)(?![^\{]*vcp-harness-button)/,
        `${label}: typed Agent prompt buttons must be excluded from legacy visual styling`);
}
assert.doesNotMatch(agentIdentityCss, /\.reset-colors-btn(?:\.|:|\s|,|\{)(?![^\{]*vcp-harness-button)/,
    'typed Agent reset-color Button must be excluded from legacy visual styling');

// Primitive mount APIs already bind their disposer to the injected UiScope.
// Bridge-level Agent mounts may own marker/style restoration, but must not
// register a primitive return value a second time (the source of the retired
// duplicate lifecycle resources).
for (const functionName of [
    'mountTypedAgentRegexInputs',
    'mountTypedAgentButtons',
    'mountTypedAgentPromptModeButtons',
    'mountTypedAgentIdentityInput',
    'mountTypedAgentModelInput',
    'mountTypedAgentTemperatureInput',
    'mountTypedAgentNumericInputs',
    'mountTypedAgentStreamChoice',
    'mountTypedAgentTtsSpeedRange',
    'mountTypedAgentColorPairs',
]) {
    const body = bridge.match(new RegExp(`function ${functionName}\\(form\\)\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
    assert.doesNotMatch(body, /scope\.own\(release/, `${functionName} must not double-register a primitive disposer`);
}
assert.match(settingsModules, /vcp-harness-row-copy/);
assert.match(bridge, /vcp-harness-active-section/);
assert.match(bridge, /vcp-harness-section-bank/);
assert.match(bridge, /vcp-harness-settings-close-icon/);
assert.match(bridge, /vcp-harness-settings-close-label/);
assert.match(settingsModules, /dataset\.settingPrimitive\s*=\s*'appearance-row'/);
assert.match(bridge, /dataset\.settingPrimitive\s*=\s*'disclosure'/);
assert.match(css, /vcp-harness-appearance-row[\s\S]*?gap:\s*8px[\s\S]*?padding:\s*16px\s+0/);
// Menu semantics (role=menu, aria-haspopup, check marker) are owned inside the
// generated primitive; the bridge surfaces them through the mount contract.
assert.match(bridge, /aria-controls/, 'Menu trigger/disclosure must expose controlled content');
assert.match(settingsModules, /item\.append\(\.\.\.\[\.\.\.row\.childNodes\]\)/, 'legacy row wrapper must be physically removed');
assert.doesNotMatch(settingsModules, /item\.append\(row\)/, 'canonical row must not wrap legacy row');
assert.match(css, /vcp-harness-disclosure-row[\s\S]*?border-top:\s*1px\s+solid/);
assert.doesNotMatch(settingsEntry, /settings-global-modal\.css/, 'legacy global modal stylesheet must not be loaded');
assert.equal(fs.existsSync(path.join(root, 'styles/setting/settings-global-modal.css')), false, 'legacy global modal stylesheet must be deleted');
assert.doesNotMatch(eventListeners, /setupGlobalSettingsNavigation|settings-nav-item|switching-out|switching-in/, 'retired settings navigation owner must be absent');

const template = html.match(/<template id="globalSettingsModalTemplate">[\s\S]*?<\/template>/)?.[0] || '';
assert.match(template, /vcp-settings-source-panel/, 'settings source panel marker must be explicit');
assert.match(template, /vcp-settings-source-title/, 'settings source title marker must be explicit');
assert.doesNotMatch(template, /global-settings-footer|保存全局设置/, 'legacy save footer must be absent; autosave owns persistence feedback');
const legacyRows = (template.match(/class="[^"]*(?:settings-form-group|form-group-inline|settings-subsection)[^"]*"/g) || []).length;
const inlineStyles = (template.match(/\sstyle\s*=/g) || []).length;
const legacyCssSelectors = (css.match(/\.(?:settings-form-group|form-group-inline|settings-subsection|global-settings-layout|settings-nav-item|global-settings-nav|global-settings-content|global-settings-title|settings-nav-list|vcp-ui-list(?:-item|-copy)?|vcp-ui-settings-shell)\b/g) || []).length;

console.log(JSON.stringify({
    shellSourceEquivalent: true,
    retiredBridgeOwners: true,
    harnessGeometry: true,
    legacy: { rows: legacyRows, inlineStyles, cssSelectors: legacyCssSelectors },
    legacyClean: legacyRows === 0 && inlineStyles === 0 && legacyCssSelectors === 0,
}, null, 2));

// Do not hide unfinished cleanup behind a green check.  The shell gate above
// is complete, but this repository still has legacy business anchors by
// design; strict success is only allowed after those anchors are migrated to
// canonical slots and their CSS ownership is deleted.
if (legacyRows !== 0 || inlineStyles !== 0 || legacyCssSelectors !== 0) {
    console.error('Source-equivalence gate blocked: legacy settings presentation remains.');
    process.exitCode = 1;
}
