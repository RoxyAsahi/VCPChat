import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-primitives/src');
const sourcePath = path.join(sourceDir, 'JsonTree.tsx');
const cssPath = path.join(sourceDir, 'JsonTree.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/json-tree.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/json-tree.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-json-tree-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['export function JsonTree', 'role="treeitem"', 'role="group"', 'data-json-expander', 'aria-expanded={expanded}', 'aria-controls={expanded ? contentsId : undefined}', 'setTimeout', 'clearTimeout', "window.addEventListener('scroll', reposition, true)", "window.removeEventListener('resize', reposition)"]) {
  assert.ok(source.includes(token), `JsonTree source missing ${token}`);
}
assert.equal(dom.root.tag, 'div');
assert.equal(dom.tree.role, 'tree');
assert.equal(dom.tree.expand, 'span.expander[role=button][aria-expanded][aria-controls]');
assert.equal(dom.copy.reset, 'copy state resets after 1500ms');
assert.equal(geometry.candidateStatus, 'source-only frozen trajectory/tool inspection; no VCP structured-message consumer or paired visual capture');

const declarations = new Map();
const ast = csstree.parse(css);
csstree.walk(ast, {
  visit: 'Rule',
  enter(node) {
    if (node.type !== 'Rule') return;
    const selectors = csstree.generate(node.prelude).split(',').map(value => value.replace(/(['"])([^'"]*)\1/g, '$2').trim()).filter(Boolean);
    if (!selectors.length) return;
    const values = {};
    csstree.walk(node.block, { visit: 'Declaration', enter(declaration) { values[declaration.property] = csstree.generate(declaration.value); } });
    for (const selector of selectors) declarations.set(selector, { ...(declarations.get(selector) ?? {}), ...values });
  },
});
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
const cssChecks = [
  ['.root', 'min-width', geometry.selectors['.root'].minWidth],
  ['.root', 'overflow', geometry.selectors['.root'].overflow],
  ['.root', 'position', geometry.selectors['.root'].position],
  ['.root', 'font', geometry.selectors['.root'].font],
  ['.root', 'overscroll-behavior-x', geometry.selectors['.root'].overscrollBehaviorX],
  ['.container', 'box-sizing', geometry.selectors['.container'].boxSizing],
  ['.container', 'width', geometry.selectors['.container'].width],
  ['.container', 'min-width', geometry.selectors['.container'].minWidth],
  ['.container', 'margin', geometry.selectors['.container'].margin],
  ['.container', 'padding', geometry.selectors['.container'].padding],
  ['.container', 'white-space', geometry.selectors['.container'].whiteSpace],
  ['.row', 'position', geometry.selectors['.row'].position],
  ['.row', 'box-sizing', geometry.selectors['.row'].boxSizing],
  ['.row', 'min-width', geometry.selectors['.row'].minWidth],
  ['.row', 'min-height', geometry.selectors['.row'].minHeight],
  ['.row', 'margin', geometry.selectors['.row'].margin],
  ['.row', 'padding', geometry.selectors['.row'].padding],
  ['.copyAnchor', 'position', geometry.selectors['.copyAnchor'].position],
  ['.copyAnchor', 'z-index', geometry.selectors['.copyAnchor'].zIndex],
  ['.copyAnchor', 'display', geometry.selectors['.copyAnchor'].display],
  ['.copyButton', 'box-sizing', geometry.selectors['.copyButton'].boxSizing],
  ['.copyButton', 'display', geometry.selectors['.copyButton'].display],
  ['.copyButton', 'align-items', geometry.selectors['.copyButton'].alignItems],
  ['.copyButton', 'justify-content', geometry.selectors['.copyButton'].justifyContent],
  ['.copyButton', 'width', geometry.selectors['.copyButton'].width],
  ['.copyButton', 'height', geometry.selectors['.copyButton'].height],
  ['.copyButton', 'border-radius', geometry.selectors['.copyButton'].borderRadius],
  ['.expander', 'position', geometry.selectors['.expander'].position],
  ['.expander', 'z-index', geometry.selectors['.expander'].zIndex],
  ['.expander', 'top', geometry.selectors['.expander'].top],
  ['.expander', 'left', geometry.selectors['.expander'].left],
  ['.expander', 'width', geometry.selectors['.expander'].width],
  ['.expander', 'height', geometry.selectors['.expander'].height],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness JsonTree CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source: path.relative(harnessRoot, sourcePath),
  styleSource: path.relative(harnessRoot, cssPath),
  domContract: true,
  cssGeometry: `${cssChecks.filter(check => check.pass).length}/${cssChecks.length}`,
  cssChecks,
  candidateStatus: geometry.candidateStatus,
  evidenceGaps: ['no VCP structured-message consumer', 'no paired Harness/VCP browser capture', 'no computed-style or pixel diff'],
  note: 'Read-only frozen trajectory/tool evidence; structured-message rendering, copy transport and chat ownership remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness JsonTree reference audit: ${report.cssGeometry} CSS checks; frozen-domain boundary retained.`);

