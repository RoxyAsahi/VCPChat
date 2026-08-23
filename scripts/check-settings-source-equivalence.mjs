import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const bridge = read('modules/ui-system/settings-bridge.js');
const css = read('styles/ui-system/settings.css');
const html = read('main.html');
const settingsEntry = read('styles/settings.css');

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
assert.doesNotMatch(css, /vcp-harness-legacy-anchor/, 'legacy anchor CSS must be deleted');
assert.doesNotMatch(bridge, /vcp-settings-navigation-restored|originalLegacyClasses|originalPanelNodes/, 'retired legacy SettingsRoot restoration path must be deleted');
assert.match(bridge, /nav\.classList\.remove\('vcp-settings-source-nav'\)/, 'source nav marker must leave live tree');
assert.match(bridge, /content\.classList\.remove\('vcp-settings-source-content'\)/, 'source content marker must leave live tree');

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
assert.match(css, /vcp-harness-general-row[\s\S]*?border-radius:\s*8px[\s\S]*?font-size:\s*14px[\s\S]*?line-height:\s*22px/);
// The projection must retain the same primitive ownership layers as Harness
// Menu, including the portal case (the menu leaves the modal subtree).
for (const primitive of [
    'vcp-harness-menu-list',
    'vcp-harness-menu-viewport',
    'vcp-harness-menu-item-wrap',
    'vcp-harness-menu-item',
    'vcp-harness-menu-item-label',
    'vcp-harness-menu-check',
]) {
    assert.match(bridge, new RegExp(primitive.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')), `Select/Menu primitive missing: ${primitive}`);
}
assert.match(css, /\.vcp-harness-menu-portal\.vcp-harness-menu-list[\s\S]*?border-radius:\s*12px/);
assert.match(css, /\.vcp-harness-menu-portal \.vcp-harness-menu-item[\s\S]*?min-height:\s*40px/);
assert.match(bridge, /dataset\.settingPrimitive\s*=\s*'disclosure'/);
assert.match(bridge, /vcp-harness-row-copy/);
assert.match(bridge, /dataset\.settingPrimitive\s*=\s*'appearance-row'/);
assert.match(bridge, /dataset\.settingPrimitive\s*=\s*'disclosure'/);
assert.match(css, /vcp-harness-appearance-row[\s\S]*?gap:\s*8px[\s\S]*?padding:\s*16px\s+0/);
assert.match(bridge, /popover\.setAttribute\('role', 'menu'\)/, 'Select projection must use Harness Menu semantics');
assert.match(bridge, /item\.setAttribute\('role', 'menuitem'\)/, 'Select projection entries must be Menu items');
assert.match(bridge, /vcp-ui-icon[^;]*check|textContent\s*=\s*'check'/, 'selection marker must use the shared icon adapter');
assert.match(bridge, /rebuildOptions/, 'projection must expose an atomic option rebuild owner');
assert.match(bridge, /aria-controls/, 'Menu trigger/disclosure must expose controlled content');
assert.match(bridge, /item\.append\(\.\.\.\[\.\.\.row\.childNodes\]\)/, 'legacy row wrapper must be physically removed');
assert.doesNotMatch(bridge, /item\.append\(row\)/, 'canonical row must not wrap legacy row');
assert.match(css, /vcp-harness-disclosure-row[\s\S]*?border-top:\s*1px\s+solid/);
assert.doesNotMatch(settingsEntry, /settings-global-modal\.css/, 'legacy global modal stylesheet must not be loaded');
assert.equal(fs.existsSync(path.join(root, 'styles/setting/settings-global-modal.css')), false, 'legacy global modal stylesheet must be deleted');

const template = html.match(/<template id="globalSettingsModalTemplate">[\s\S]*?<\/template>/)?.[0] || '';
assert.match(template, /vcp-settings-source-panel/, 'settings source panel marker must be explicit');
assert.match(template, /vcp-settings-source-title/, 'settings source title marker must be explicit');
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
