import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-primitives/src');
const sourcePath = path.join(sourceDir, 'WebBlock.tsx');
const cssPath = path.join(sourceDir, 'WebBlock.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/web-block.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/web-block.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-web-block-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['export function WebBlock', "kind: 'search'", "kind: 'fetch'", 'safeHref', 'target="_blank"', 'rel="noopener noreferrer"', 'hostname', 'max-height: 320px']) {
  assert.ok(source.includes(token) || css.includes(token), `WebBlock source/style missing ${token}`);
}
assert.equal(dom.root.data, 'web=search | fetch');
assert.equal(dom.search.link, 'http(s) only external anchor');
assert.equal(dom.fetch.status, 'HTTP status code');
assert.equal(geometry.candidateStatus, 'source-only frozen tool detail; no VCP consumer or paired visual capture');

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
  ['.block', 'margin', geometry.selectors['.block'].margin],
  ['.block', 'padding', geometry.selectors['.block'].padding],
  ['.block', 'border-radius', geometry.selectors['.block'].borderRadius],
  ['.answer', 'margin-bottom', geometry.selectors['.answer'].marginBottom],
  ['.sources', 'margin', geometry.selectors['.sources'].margin],
  ['.sources', 'padding-left', geometry.selectors['.sources'].paddingLeft],
  ['.sources', 'display', geometry.selectors['.sources'].display],
  ['.sources', 'flex-direction', geometry.selectors['.sources'].flexDirection],
  ['.sources', 'gap', geometry.selectors['.sources'].gap],
  ['.sources', 'max-height', geometry.selectors['.sources'].maxHeight],
  ['.sources', 'overflow-y', geometry.selectors['.sources'].overflowY],
  ['.sourceLink', 'font-size', geometry.selectors['.sourceLink'].fontSize],
  ['.sourceLink', 'line-height', geometry.selectors['.sourceLink'].lineHeight],
  ['.sourceLink', 'word-break', geometry.selectors['.sourceLink'].wordBreak],
  ['.snippet', 'margin-top', geometry.selectors['.snippet'].marginTop],
  ['.snippet', 'font-size', geometry.selectors['.snippet'].fontSize],
  ['.snippet', 'line-height', geometry.selectors['.snippet'].lineHeight],
  ['.snippet', 'word-break', geometry.selectors['.snippet'].wordBreak],
  ['.fetch', 'display', geometry.selectors['.fetch'].display],
  ['.fetch', 'flex-direction', geometry.selectors['.fetch'].flexDirection],
  ['.fetch', 'gap', geometry.selectors['.fetch'].gap],
  ['.fetchMeta', 'display', geometry.selectors['.fetchMeta'].display],
  ['.fetchMeta', 'align-items', geometry.selectors['.fetchMeta'].alignItems],
  ['.fetchMeta', 'gap', geometry.selectors['.fetchMeta'].gap],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness WebBlock CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source: path.relative(harnessRoot, sourcePath),
  styleSource: path.relative(harnessRoot, cssPath),
  domContract: true,
  cssGeometry: `${cssChecks.filter(check => check.pass).length}/${cssChecks.length}`,
  cssChecks,
  candidateStatus: geometry.candidateStatus,
  evidenceGaps: ['no VCP tool-detail consumer', 'no paired Harness/VCP browser capture', 'no computed-style or pixel diff'],
  note: 'Read-only frozen tool-detail evidence; web retrieval ownership, chat rendering and protocol remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness WebBlock reference audit: ${report.cssGeometry} CSS checks; frozen-domain boundary retained.`);

