import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness/packages/client/ui-model-selection/src/client';
const read = file => fs.readFileSync(file, 'utf8');
const source = read(path.join(harnessRoot, 'ModelSelect.tsx'));
const css = read(path.join(harnessRoot, 'ModelSelect.module.css'));
const dom = JSON.parse(read(path.join(root, 'docs/reference/deepseek-harness-primitives/model-picker.dom.json')));
const matrix = JSON.parse(read(path.join(root, 'docs/reference/deepseek-harness-primitives/fixture-matrix.json')));
const requiredSourceTokens = ['useSyncExternalStore', 'aria-haspopup="menu"', 'aria-busy', "event.key === 'Escape'", 'pane !== \'root\''];
for (const token of requiredSourceTokens) {
    assert.ok(source.includes(token) || source.includes(token.replaceAll('"', "'")), `Harness ModelSelect source missing ${token}`);
}
for (const token of ['.trigger', '.menu', '.cell', '.option', '.groupTitle', 'max-height: min(360px']) {
    assert.ok(css.includes(token), `Harness ModelSelect CSS missing ${token}`);
}
assert.equal(dom.trigger.ariaHaspopup, 'menu');
assert.deepEqual(dom.menu.panes, ['root', 'model', 'effort']);
for (const state of ['loading', 'error-retry', 'selecting', 'locked']) {
    assert.ok(matrix.cases.some(([name, value]) => name === 'agent-model-picker' && value === state), `fixture matrix missing ${state}`);
}
console.log('Harness ModelSelect reference contract passed (source, CSS, DOM, fixture matrix).');
