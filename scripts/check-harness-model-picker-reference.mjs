import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness/packages/client/ui-model-selection/src/client';
const read = file => fs.readFileSync(file, 'utf8');
const source = read(path.join(harnessRoot, 'ModelSelect.tsx'));
const css = read(path.join(harnessRoot, 'ModelSelect.module.css'));
const dom = JSON.parse(read(path.join(root, 'docs/reference/deepseek-harness-primitives/model-picker.dom.json')));
const geometry = JSON.parse(read(path.join(root, 'docs/reference/deepseek-harness-primitives/model-picker.geometry.json')));
const matrix = JSON.parse(read(path.join(root, 'docs/reference/deepseek-harness-primitives/fixture-matrix.json')));
const requiredSourceTokens = ['useSyncExternalStore', 'aria-haspopup="menu"', 'aria-busy', "event.key === 'Escape'", 'pane !== \'root\''];
for (const token of requiredSourceTokens) {
    assert.ok(source.includes(token) || source.includes(token.replaceAll('"', "'")), `Harness ModelSelect source missing ${token}`);
}
for (const token of ['.trigger', '.menu', '.cell', '.option', '.groupTitle', 'max-height: min(360px']) {
    assert.ok(css.includes(token), `Harness ModelSelect CSS missing ${token}`);
}
const require = createRequire(import.meta.url);
const csstree = require('css-tree');
const declarations = new Map();
const ast = csstree.parse(css);
csstree.walk(ast, {
    visit: 'Rule',
    enter(node) {
        if (node.type !== 'Rule' || node.prelude.type !== 'SelectorList') return;
        const selectors = [];
        csstree.walk(node.prelude, { visit: 'ClassSelector', enter(selector) { selectors.push(`.${selector.name}`); } });
        if (selectors.length === 0) return;
        const values = {};
        csstree.walk(node.block, { visit: 'Declaration', enter(declaration) { values[declaration.property] = csstree.generate(declaration.value); } });
        for (const selector of selectors) declarations.set(selector, { ...(declarations.get(selector) ?? {}), ...values });
    },
});
const cssChecks = [];
const propertyNames = { minWidth: 'min-width', maxWidth: 'max-width', maxHeight: 'max-height', borderRadius: 'border-radius', fontSize: 'font-size', lineHeight: 'line-height' };
for (const [selector, contract] of Object.entries(geometry.selectors)) {
    for (const [property, expected] of Object.entries(contract)) {
        if (property === 'offset') continue;
        const cssProperty = propertyNames[property] ?? property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        const actual = declarations.get(selector)?.[cssProperty] ?? null;
        const normalize = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
        const pass = normalize(actual) === normalize(expected);
        cssChecks.push({ selector, property: cssProperty, expected, actual, pass });
        assert.equal(pass, true, `Harness CSS geometry mismatch for ${selector} ${cssProperty}: expected ${expected}, got ${actual}`);
    }
}
assert.equal(dom.trigger.ariaHaspopup, 'menu');
assert.deepEqual(dom.menu.panes, ['root', 'model', 'effort']);
for (const state of ['loading', 'error-retry', 'selecting', 'locked']) {
    assert.ok(matrix.cases.some(([name, value]) => name === 'agent-model-picker' && value === state), `fixture matrix missing ${state}`);
}
console.log(JSON.stringify({ contract: 'Harness ModelSelect', source: true, dom: true, fixtureMatrix: true, cssGeometry: `${cssChecks.filter(check => check.pass).length}/${cssChecks.length}` }, null, 2));
