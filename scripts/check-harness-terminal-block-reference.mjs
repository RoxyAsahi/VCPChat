import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-primitives/src');
const sourcePath = path.join(sourceDir, 'TerminalBlock.tsx');
const cssPath = path.join(sourceDir, 'TerminalBlock.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/terminal-block.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/terminal-block.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-terminal-block-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['export function TerminalBlock', 'DEFAULT_TERMINAL_MAX_LINES = 16', 'data-terminal=""', 'data-running', 'parseAnsiLines', 'headTailCap', 'useCopyFeedback', 'aria-expanded={expanded}']) {
  assert.ok(source.includes(token), `TerminalBlock source missing ${token}`);
}
assert.equal(dom.root.data, 'terminal; data-running while command active');
assert.equal(dom.status.signalPrecedence, true);
assert.equal(dom.output.cap, 'head/tail expansion');
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
  ['.block', 'padding-left', geometry.selectors['.block'].paddingLeft],
  ['.block', 'border-radius', geometry.selectors['.block'].borderRadius],
  ['.block', 'overflow', geometry.selectors['.block'].overflow],
  ['.header', 'display', geometry.selectors['.header'].display],
  ['.header', 'align-items', geometry.selectors['.header'].alignItems],
  ['.header', 'gap', geometry.selectors['.header'].gap],
  ['.header', 'padding', geometry.selectors['.header'].padding],
  ['.header', 'max-height', geometry.selectors['.header'].maxHeight],
  ['.header', 'overflow-y', geometry.selectors['.header'].overflowY],
  ['.prompt', 'display', geometry.selectors['.prompt'].display],
  ['.prompt', 'flex-direction', geometry.selectors['.prompt'].flexDirection],
  ['.prompt', 'min-width', geometry.selectors['.prompt'].minWidth],
  ['.prompt', 'flex', geometry.selectors['.prompt'].flex],
  ['.promptLine', 'position', geometry.selectors['.promptLine'].position],
  ['.promptLine', 'display', geometry.selectors['.promptLine'].display],
  ['.promptLine', 'align-items', geometry.selectors['.promptLine'].alignItems],
  ['.promptLine', 'gap', geometry.selectors['.promptLine'].gap],
  ['.promptLine', 'min-width', geometry.selectors['.promptLine'].minWidth],
  ['.promptLine', 'line-height', geometry.selectors['.promptLine'].lineHeight],
  ['.output', 'max-height', geometry.selectors['.output'].maxHeight],
  ['.output', 'padding', geometry.selectors['.output'].padding],
  ['.output', 'overflow-x', geometry.selectors['.output'].overflowX],
  ['.output', 'overflow-y', geometry.selectors['.output'].overflowY],
  ['.line', 'min-height', geometry.selectors['.line'].minHeight],
  ['.line', 'white-space', geometry.selectors['.line'].whiteSpace],
  ['.expand', 'display', geometry.selectors['.expand'].display],
  ['.expand', 'width', geometry.selectors['.expand'].width],
  ['.expand', 'padding', geometry.selectors['.expand'].padding],
  ['.expand', 'text-align', geometry.selectors['.expand'].textAlign],
  ['.empty', 'padding', geometry.selectors['.empty'].padding],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness TerminalBlock CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

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
  note: 'Read-only frozen tool-detail evidence; shell execution, chat rendering and transport ownership remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness TerminalBlock reference audit: ${report.cssGeometry} CSS checks; frozen-domain boundary retained.`);
