import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-jobs/src/client');
const sourcePath = path.join(sourceDir, 'JobListAction.tsx');
const cssPath = path.join(sourceDir, 'JobListAction.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/job-list-action.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/job-list-action.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-job-list-action-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['JobListAction', 'aria-expanded={open}', 'aria-label={countLabel}', 'aria-label={t(\'list.aria\')}', 'setInterval', 'clearInterval']) {
  assert.ok(source.includes(token), `JobListAction source missing ${token}`);
}
assert.equal(dom.root.closedRender, 'null when jobs empty');
assert.equal(dom.trigger.ariaExpanded, 'open state');
assert.equal(dom.menu.tag, 'ul');
assert.equal(geometry.candidateStatus, 'source-only; no VCP jobs consumer or paired visual capture');

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
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
const cssChecks = [
  ['.root', 'position', geometry.selectors['.root'].position],
  ['.trigger', 'display', geometry.selectors['.trigger'].display],
  ['.trigger', 'align-items', geometry.selectors['.trigger'].alignItems],
  ['.trigger', 'gap', geometry.selectors['.trigger'].gap],
  ['.trigger', 'min-height', geometry.selectors['.trigger'].minHeight],
  ['.trigger', 'padding', geometry.selectors['.trigger'].padding],
  ['.trigger', 'border-radius', geometry.selectors['.trigger'].borderRadius],
  ['.menu', 'top', geometry.selectors['.menu'].top],
  ['.menu', 'width', geometry.selectors['.menu'].width],
  ['.menu', 'max-height', geometry.selectors['.menu'].maxHeight],
  ['.menu', 'padding', geometry.selectors['.menu'].padding],
  ['.menu', 'border-radius', geometry.selectors['.menu'].borderRadius],
  ['.row', 'display', geometry.selectors['.row'].display],
  ['.row', 'gap', geometry.selectors['.row'].gap],
  ['.row', 'min-height', geometry.selectors['.row'].minHeight],
  ['.row', 'padding', geometry.selectors['.row'].padding],
  ['.kind', 'padding', geometry.selectors['.kind'].padding],
  ['.kind', 'border-radius', geometry.selectors['.kind'].borderRadius],
  ['.label', 'min-width', geometry.selectors['.label'].minWidth],
  ['.status', 'max-width', geometry.selectors['.status'].maxWidth],
  ['.duration', 'font-size', geometry.selectors['.duration'].fontSize],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness JobListAction CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source: path.relative(harnessRoot, sourcePath),
  styleSource: path.relative(harnessRoot, cssPath),
  domContract: true,
  cssGeometry: `${cssChecks.filter(check => check.pass).length}/${cssChecks.length}`,
  cssChecks,
  candidateStatus: geometry.candidateStatus,
  evidenceGaps: ['no VCP jobs consumer or runtime registry', 'no paired Harness/VCP browser capture', 'no computed-style or pixel diff'],
  note: 'Read-only frozen-domain evidence; session job state, chat rendering and transport ownership remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness JobListAction reference audit: ${report.cssGeometry} CSS checks; candidate remains source-only.`);
