import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const bridge = fs.readFileSync(path.join(root, 'modules/ui-system/settings-bridge.js'), 'utf8');
const canonicalRows = fs.readFileSync(path.join(root, 'modules/ui-system/settings/canonical-rows.js'), 'utf8');
const selectProjection = fs.readFileSync(path.join(root, 'modules/ui-system/settings/select-projection.js'), 'utf8');

const readCssEntry = file => {
    const entry = fs.readFileSync(path.join(root, file), 'utf8');
    const imports = [...entry.matchAll(/@import\s+url\(['"]([^'"]+)['"]\)\s*;/g)]
        .map(match => path.posix.normalize(path.posix.join(path.posix.dirname(file.replaceAll(path.sep, '/')), match[1])));
    return [entry, ...imports.map(f => fs.readFileSync(path.join(root, f), 'utf8'))].join('\n');
};
const css = readCssEntry('styles/ui-system/settings.css');
const html = fs.readFileSync(path.join(root, 'main.html'), 'utf8');

assert.match(canonicalRows, /function mountCanonicalSettingsRows/, 'canonical row mounting must live in settings/canonical-rows.js');
assert.match(bridge, /mountCanonicalSettingsRows/, 'bridge must import the canonical row mount from its extracted module');
assert.match(bridge, /vcp-harness-settings-panel/);
assert.match(bridge, /vcp-harness-settings-header/);
assert.match(bridge, /vcp-harness-settings-options/);
assert.match(canonicalRows, /dataset\.canonicalRow = 'true'/, 'canonical row marker must be set in settings/canonical-rows.js');
assert.match(bridge, /removeLegacySubsectionHeadings/);
assert.match(bridge, /window\.MutationObserver/);
assert.match(selectProjection, /primitiveSelectStates/, 'select projection state tracking must live in settings/select-projection.js');
assert.doesNotMatch(bridge, /function isNextUi\s*\(/);
assert.doesNotMatch(bridge, /vcp-global-settings-next/);
assert.match(css, /vcp-harness-general-item/);
assert.match(css, /\.vcp-harness-editor-section\s*\{[\s\S]*?background:\s*transparent/);
assert.doesNotMatch(css, /#globalSettingsModal\.vcp-global-settings-next/);
assert.match(html, /id="tabContentSettings"[^>]*data-settings-presentation="unified"/);
assert.match(css, /vcp-harness-settings-panel/);

console.log('Unified settings surface contract passed.');
