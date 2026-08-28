import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// This is an intentionally negative gate.  The typed picker is a real Agent
// Settings consumer, but it is not yet a complete replacement for the legacy
// modal.  Keep the old capability surface present until parity evidence makes
// its removal safe, and keep the primitive behind injected capabilities.
const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('main.html');
const manager = read('modules/settingsManager.js');
const bridge = read('modules/ui-system/settings-bridge.js');
const directory = read('modules/ui-system/settings/agent-model-picker-directory.js');
const primitive = read('modules/uiux/primitives/agent-model-picker.ts');
const artifact = read('modules/uiux/generated/primitives/agent-model-picker.js');
const audit = read('docs/agent-model-picker-legacy-parity-audit.md');

// The modal remains a shared consumer for topicSummaryModel.  Deleting its
// template or manager helpers before that caller is migrated would break a
// non-Agent Settings path.
assert.match(html, /id="modelSelectModalTemplate"/, 'legacy model picker template must remain during parity migration');
assert.match(html, /id="modelSelectModal"/, 'legacy model picker modal must remain during parity migration');
assert.match(manager, /function\s+handleOpenModelSelect\s*\(/, 'legacy model picker open handler must remain during parity migration');
assert.match(manager, /function\s+populateModelList\s*\(/, 'legacy model list projection must remain during parity migration');
assert.match(manager, /function\s+handleRefreshModels\s*\(/, 'legacy explicit refresh capability must remain during parity migration');
assert.match(manager, /function\s+filterModels\s*\(/, 'legacy search capability must remain during parity migration');
assert.match(manager, /topicSummaryModel/, 'topic summary model must retain an audited model-picker caller');

// The typed bridge must be the sole chatAPI boundary for the new picker and
// must write the existing native input contract rather than a second store.
assert.match(bridge, /function\s+mountTypedAgentModelPicker\s*\(/, 'typed AgentModelPicker production owner is missing');
assert.match(bridge, /api\.mountAgentModelPicker\(host,/, 'typed AgentModelPicker must be mounted by the Settings bridge');
assert.match(bridge, /createAgentModelPickerDirectory/, 'typed picker must receive the isolated directory capability');
assert.doesNotMatch(bridge, /getCachedModels|getHotModels|getFavoriteModels|toggleFavoriteModel/,
    'Settings bridge must not re-embed the model directory capability after extraction');
assert.match(directory, /getCachedModels/, 'typed picker must consume cached model capability');
assert.match(directory, /refreshModels/, 'typed picker must retain refresh capability while parity is incomplete');
assert.match(directory, /getHotModels/, 'typed picker must retain hot-model metadata capability while parity is incomplete');
assert.match(directory, /getFavoriteModels/, 'typed picker must retain favorite-model metadata capability while parity is incomplete');
assert.match(directory, /toggleFavoriteModel/, 'typed picker must retain favorite mutation capability while parity is incomplete');
assert.match(directory, /inOrder\(hotIds, '热门模型'\)/, 'typed picker must project the legacy ordered hot-model section');
assert.match(directory, /inOrder\(favoriteIds, '收藏模型'\)/, 'typed picker must project the legacy ordered favorite-model section');
assert.match(bridge, /grouped:\s*true/, 'typed picker must render the explicit ordered directory sections');
assert.match(bridge, /input\.dispatchEvent\(new Event\('input'/, 'typed picker must preserve canonical input event semantics');
assert.match(bridge, /input\.dispatchEvent\(new Event\('change'/, 'typed picker must preserve canonical change event semantics');
assert.match(bridge, /modelSelectModal.*parity|Hot\/favorite sections.*legacy|legacy modal remains.*topicSummaryModel/is,
    'bridge must document the deliberate legacy parity boundary');

// The primitive remains transport-agnostic: directory operations are injected
// and no primitive or generated artifact may import chatAPI directly.
assert.match(primitive, /interface\s+AgentModelDirectoryCapability/, 'directory capability must remain explicit');
assert.match(primitive, /directory\?/, 'picker must accept an injected directory capability');
assert.match(primitive, /subscribeUpdated/, 'models-updated must remain an explicit popup-local capability');
assert.match(primitive, /agent-model-picker-directory-updates/, 'directory update release must remain owned by the picker');
assert.doesNotMatch(primitive, /(?:\bimport\s+[^\n]*chatAPI|\bwindow\.chatAPI\s*[.?])/i,
    'primitive must not import or access chatAPI directly');
assert.doesNotMatch(artifact, /(?:\bimport\s+[^\n]*chatAPI|\bwindow\.chatAPI\s*[.?])/i,
    'generated primitive must not import or access chatAPI directly');

// Keep the audit itself honest: these three capability groups are implemented,
// but their production Electron parity is still a deletion blocker. A future
// retirement must update the audit and this gate together.
for (const blocker of ['热门模型', '收藏模型分区', '显式刷新']) {
    assert.match(audit, new RegExp(blocker), `legacy parity audit must retain blocker: ${blocker}`);
}
assert.match(audit, /不得删除 `modelSelectModal`/, 'audit must keep the current deletion stop condition');

console.log('Agent ModelPicker legacy parity boundary passed: legacy modal retained, canonical input preserved, capability injection enforced.');
