import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-permission-presets/src/client');
const sourcePath = path.join(sourceDir, 'PermissionRow.tsx');
const cssPath = path.join(sourceDir, 'PermissionRow.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/permission-row.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/permission-row.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-permission-row-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['PermissionRow', 'aria-haspopup="menu"', 'aria-expanded={open}', 'portal', 'align="end"', 'RiskConfirmation']) {
  assert.ok(source.includes(token), `PermissionRow source missing ${token}`);
}
assert.equal(dom.root.tag, 'div');
assert.equal(dom.trigger.ariaHasPopup, 'menu');
assert.equal(dom.menu.portal, true);
assert.equal(dom.menu.align, 'end');
assert.equal(geometry.candidateStatus, 'source-only; no VCP permission-settings consumer or paired visual capture');

const declarations = new Map();
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
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const cssChecks = [
  ['.row', 'display', geometry.selectors['.row'].display],
  ['.row', 'align-items', geometry.selectors['.row'].alignItems],
  ['.row', 'gap', geometry.selectors['.row'].gap],
  ['.row', 'padding', geometry.selectors['.row'].padding],
  ['.rowText', 'min-width', geometry.selectors['.rowText'].minWidth],
  ['.rowText', 'gap', geometry.selectors['.rowText'].gap],
  ['.selector', 'height', geometry.selectors['.selector'].height],
  ['.selector', 'padding', geometry.selectors['.selector'].padding],
  ['.selector', 'border-radius', geometry.selectors['.selector'].borderRadius],
  ['.selector', 'gap', geometry.selectors['.selector'].gap],
  ['.chevron', 'flex', geometry.selectors['.chevron'].flex],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness PermissionRow CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source: path.relative(harnessRoot, sourcePath),
  styleSource: path.relative(harnessRoot, cssPath),
  domContract: true,
  cssGeometry: `${cssChecks.filter(check => check.pass).length}/${cssChecks.length}`,
  cssChecks,
  candidateStatus: geometry.candidateStatus,
  evidenceGaps: ['no VCP permission-settings consumer', 'no paired Harness/VCP browser capture', 'no computed-style or pixel diff'],
  note: 'Read-only frozen-domain evidence; Settings persistence, IPC and production ownership remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness PermissionRow reference audit: ${report.cssGeometry} CSS checks; candidate remains source-only.`);

