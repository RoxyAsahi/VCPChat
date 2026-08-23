import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const bridge = fs.readFileSync(path.join(root, 'modules/ui-system/settings-bridge.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles/ui-system/settings.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'main.html'), 'utf8');

assert.match(bridge, /function mountCanonicalSettingsRows/);
assert.match(bridge, /vcp-harness-settings-panel/);
assert.match(bridge, /vcp-harness-settings-header/);
assert.match(bridge, /vcp-harness-settings-options/);
assert.match(bridge, /dataset\.canonicalRow = 'true'/);
assert.match(bridge, /removeLegacySubsectionHeadings/);
assert.match(bridge, /window\.MutationObserver/);
assert.match(bridge, /harnessSelectOwnerMounted/);
assert.doesNotMatch(bridge, /function isNextUi\s*\(/);
assert.doesNotMatch(bridge, /vcp-global-settings-next/);
assert.match(css, /vcp-harness-general-item/);
assert.match(css, /\.data-vcp-settings-section\s*\{[\s\S]*?background:\s*transparent/);
assert.doesNotMatch(css, /#globalSettingsModal\.vcp-global-settings-next/);
assert.match(html, /id="tabContentSettings"[^>]*data-settings-presentation="unified"/);
assert.match(css, /vcp-harness-settings-panel/);

console.log('Unified settings surface contract passed.');
