import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-primitives/src');
const source = fs.readFileSync(path.join(sourceDir, 'DiffBlock.tsx'), 'utf8');
const css = fs.readFileSync(path.join(sourceDir, 'DiffBlock.module.css'), 'utf8');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/diff-block.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/diff-block.geometry.json'), 'utf8'));
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

for (const token of ['DEFAULT_DIFF_MAX_LINES', 'data-diff', 'copyButton', 'aria-expanded', 'aria-label', 'className', 'setExpanded']) {
    assert.ok(source.includes(token), `Harness DiffBlock source missing ${token}`);
}
for (const selector of ['.block', '.copyButton', '.body', '.line', '.path', '.gap', '.del', '.add', '.expand', '.footer']) {
    assert.ok(css.includes(selector), `Harness DiffBlock CSS missing ${selector}`);
}
assert.equal(dom.root.tag, 'div');
assert.equal(dom.root.dataDiff, '');
assert.equal(dom.rowSemantics.expand.ariaExpanded, 'expanded state');
assert.deepEqual(dom.states, ['empty-null', 'default', 'collapsed', 'expanded', 'copy-success', 'dispose']);

const declarations = new Map();
const customProperties = Object.fromEntries([...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
const ast = csstree.parse(css);
csstree.walk(ast, {
    visit: 'Rule',
    enter(node) {
        if (node.type !== 'Rule') return;
        const selectors = new Set();
        csstree.walk(node.prelude, { visit: 'ClassSelector', enter(selector) { selectors.add(`.${selector.name}`); } });
        if (!selectors.size) return;
        const values = {};
        csstree.walk(node.block, { visit: 'Declaration', enter(declaration) { values[declaration.property] = csstree.generate(declaration.value); } });
        for (const selector of selectors) declarations.set(selector, { ...(declarations.get(selector) ?? {}), ...values });
    },
});
const resolveVars = (value, seen = new Set()) => String(value ?? '').replace(/var\((--[A-Za-z0-9_-]+)\)/g, (_, name) => {
    if (seen.has(name) || customProperties[name] == null) return `var(${name})`;
    const next = new Set(seen); next.add(name);
    return resolveVars(customProperties[name], next);
});
const normalize = value => resolveVars(value).replace(/\s+/g, ' ').trim();
const cssChecks = [
    ['.block', 'border-radius', geometry.root.borderRadius],
    ['.block', 'margin', geometry.root.margin],
    ['.copyButton', 'top', geometry.copyButton.top],
    ['.copyButton', 'right', geometry.copyButton.right],
    ['.body', 'padding', geometry.body.padding],
    ['.line', 'min-height', geometry.line.minHeight],
    ['.line', 'white-space', geometry.line.whiteSpace],
    ['.path', 'font-weight', geometry.path.fontWeight],
    ['.path', 'padding-right', geometry.path.paddingRight],
    ['.footer', 'padding', geometry.footer.padding],
].map(([selector, property, expected]) => {
    const actual = declarations.get(selector)?.[property] ?? null;
    return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness DiffBlock CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);
const report = {
    contract: 'Harness DiffBlock',
    sourcePath: path.relative(harnessRoot, path.join(sourceDir, 'DiffBlock.tsx')),
    styleSource: path.relative(harnessRoot, path.join(sourceDir, 'DiffBlock.module.css')),
    source: true,
    dom: true,
    cssGeometry: `${cssChecks.filter(check => check.pass).length}/${cssChecks.length}`,
    candidateStatus: geometry.candidateStatus,
};
const reportPath = path.join(root, 'reports/harness-diff-block-reference.json');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
