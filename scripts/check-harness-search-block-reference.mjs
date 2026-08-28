import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-primitives/src');
const sourcePath = path.join(sourceDir, 'SearchBlock.tsx');
const cssPath = path.join(sourceDir, 'SearchBlock.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/search-block.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/search-block.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-search-block-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['export function SearchBlock', 'DEFAULT_SEARCH_MAX_LINES = 16', "kind: 'matches'", "kind: 'paths'", 'aria-expanded={!row.collapsed}', 'useCopyFeedback', 'headTailCap', 'data-search={props.kind}']) {
  assert.ok(source.includes(token), `SearchBlock source missing ${token}`);
}
assert.equal(dom.root.data, 'search kind or paths');
assert.equal(dom.body.cap, '16 flattened rows default with head/tail retention');
assert.equal(dom.copy.scope, 'full structured result, independent of cap/collapse');
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
  ['.block', 'position', geometry.selectors['.block'].position],
  ['.block', 'margin', geometry.selectors['.block'].margin],
  ['.block', 'border-radius', geometry.selectors['.block'].borderRadius],
  ['.header', 'display', geometry.selectors['.header'].display],
  ['.header', 'align-items', geometry.selectors['.header'].alignItems],
  ['.header', 'gap', geometry.selectors['.header'].gap],
  ['.header', 'padding', geometry.selectors['.header'].padding],
  ['.summary', 'flex', geometry.selectors['.summary'].flex],
  ['.summary', 'min-width', geometry.selectors['.summary'].minWidth],
  ['.summary', 'overflow', geometry.selectors['.summary'].overflow],
  ['.summary', 'text-overflow', geometry.selectors['.summary'].textOverflow],
  ['.summary', 'white-space', geometry.selectors['.summary'].whiteSpace],
  ['.body', 'padding', geometry.selectors['.body'].padding],
  ['.body', 'overflow-x', geometry.selectors['.body'].overflowX],
  ['.body', 'overflow-y', geometry.selectors['.body'].overflowY],
  ['.line', 'min-height', geometry.selectors['.line'].minHeight],
  ['.line', 'padding-left', geometry.selectors['.line'].paddingLeft],
  ['.line', 'white-space', geometry.selectors['.line'].whiteSpace],
  ['.fileHeader', 'display', geometry.selectors['.fileHeader'].display],
  ['.fileHeader', 'align-items', geometry.selectors['.fileHeader'].alignItems],
  ['.fileHeader', 'gap', geometry.selectors['.fileHeader'].gap],
  ['.fileHeader', 'width', geometry.selectors['.fileHeader'].width],
  ['.fileHeader', 'min-height', geometry.selectors['.fileHeader'].minHeight],
  ['.fileHeader', 'padding', geometry.selectors['.fileHeader'].padding],
  ['.expand', 'display', geometry.selectors['.expand'].display],
  ['.expand', 'width', geometry.selectors['.expand'].width],
  ['.expand', 'padding', geometry.selectors['.expand'].padding],
  ['.expand', 'text-align', geometry.selectors['.expand'].textAlign],
  ['.empty', 'padding', geometry.selectors['.empty'].padding],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness SearchBlock CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

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
  note: 'Read-only frozen tool-detail evidence; search result ownership, tool rendering and chat protocol remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness SearchBlock reference audit: ${report.cssGeometry} CSS checks; frozen-domain boundary retained.`);
