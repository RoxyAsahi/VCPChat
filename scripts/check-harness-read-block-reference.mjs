import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-primitives/src');
const sourcePath = path.join(sourceDir, 'ReadBlock.tsx');
const cssPath = path.join(sourceDir, 'ReadBlock.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/read-block.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/read-block.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-read-block-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['export function ReadBlock', 'DEFAULT_READ_MAX_LINES = 16', 'data-read=""', 'aria-hidden', 'aria-expanded={expanded}', 'highlightLines', 'writeClipboard(raw)', 'windowed']) {
  assert.ok(source.includes(token), `ReadBlock source missing ${token}`);
}
assert.equal(dom.root.data, 'read');
assert.equal(dom.body.cap, '16 lines default with head/tail retention');
assert.equal(dom.window.lineNumbers, 'source file numbers are preserved');
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
  ['.banner', 'display', geometry.selectors['.banner'].display],
  ['.banner', 'justify-content', geometry.selectors['.banner'].justifyContent],
  ['.banner', 'align-items', geometry.selectors['.banner'].alignItems],
  ['.banner', 'gap', geometry.selectors['.banner'].gap],
  ['.banner', 'padding', geometry.selectors['.banner'].padding],
  ['.action', 'display', geometry.selectors['.action'].display],
  ['.action', 'align-items', geometry.selectors['.action'].alignItems],
  ['.action', 'flex-shrink', geometry.selectors['.action'].flexShrink],
  ['.action', 'gap', geometry.selectors['.action'].gap],
  ['.body', 'padding', geometry.selectors['.body'].padding],
  ['.body', 'overflow-x', geometry.selectors['.body'].overflowX],
  ['.body', 'overflow-y', geometry.selectors['.body'].overflowY],
  ['.line', 'display', geometry.selectors['.line'].display],
  ['.line', 'min-height', geometry.selectors['.line'].minHeight],
  ['.line', 'line-height', geometry.selectors['.line'].lineHeight],
  ['.line', 'white-space', geometry.selectors['.line'].whiteSpace],
  ['.gutter', 'flex', geometry.selectors['.gutter'].flex],
  ['.gutter', 'width', geometry.selectors['.gutter'].width],
  ['.gutter', 'padding-right', geometry.selectors['.gutter'].paddingRight],
  ['.gutter', 'text-align', geometry.selectors['.gutter'].textAlign],
  ['.gutter', 'user-select', geometry.selectors['.gutter'].userSelect],
  ['.expand', 'display', geometry.selectors['.expand'].display],
  ['.expand', 'width', geometry.selectors['.expand'].width],
  ['.expand', 'padding', geometry.selectors['.expand'].padding],
  ['.expand', 'text-align', geometry.selectors['.expand'].textAlign],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness ReadBlock CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

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
  note: 'Read-only frozen tool-detail evidence; file reads, chat rendering and transport ownership remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness ReadBlock reference audit: ${report.cssGeometry} CSS checks; frozen-domain boundary retained.`);

