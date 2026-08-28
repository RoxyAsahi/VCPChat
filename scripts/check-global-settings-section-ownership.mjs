import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../modules/ui-system/settings-bridge.js', import.meta.url), 'utf8');
const doc = fs.readFileSync(new URL('../docs/global-settings-section-ownership.md', import.meta.url), 'utf8');
const sections = ['user-identity', 'server-connection', 'appearance-settings', 'render-settings', 'selection-assistant', 'voice-settings', 'advanced-features', 'quick-actions'];
for (const section of sections) assert.ok(doc.includes(`| \`${section}\` |`), `ownership document must list ${section}`);
assert.match(bridge, /function enhanceGlobalSettings\(root, form\)/, 'bridge must retain one global section entry point during migration');
assert.match(bridge, /function mountTypedAvatarColorPair\(/, 'identity owner must remain explicit');
assert.match(bridge, /function mountTypedGlobalChoiceGroups\(/, 'choice owner must remain explicit');
assert.match(bridge, /function mountHarnessInputs\(/, 'input owner must remain explicit');
assert.doesNotMatch(bridge, /createGlobalSettingsStore|new GlobalSettingsStore/, 'section contract must not add a second durable store');
console.log(`Global Settings section ownership contract passed (${sections.length} sections; single bridge entry preserved).`);
