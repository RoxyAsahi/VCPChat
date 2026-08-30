import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-plan/src/client');
const sourcePath = path.join(sourceDir, 'PlanModeControl.tsx');
const cssPath = path.join(sourceDir, 'PlanModeControl.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/plan-chip.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/plan-chip.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-plan-chip-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['export function PlanChip', "useProjection('plan')", 'plan.pending ? !plan.active : plan.active', 'aliveRef.current', 'disabled={locked || leaving}', 'role="status"', 'exitPlanMode()']) {
  assert.ok(source.includes(token), `PlanChip source missing ${token}`);
}
assert.equal(dom.root.tag, 'span');
assert.equal(dom.projection.target, 'plan.pending ? !plan.active : plan.active');
assert.equal(dom.exit.lateResult, 'ignored after owner dispose');
assert.equal(geometry.candidateStatus, 'source-only frozen Composer plan slot; no VCP consumer or paired visual capture');

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
  ['.wrap', 'display', geometry.selectors['.wrap'].display],
  ['.wrap', 'align-items', geometry.selectors['.wrap'].alignItems],
  ['.wrap', 'gap', geometry.selectors['.wrap'].gap],
  ['.chip', 'display', geometry.selectors['.chip'].display],
  ['.chip', 'align-items', geometry.selectors['.chip'].alignItems],
  ['.chip', 'gap', geometry.selectors['.chip'].gap],
  ['.chip', 'min-width', geometry.selectors['.chip'].minWidth],
  ['.chip', 'padding', geometry.selectors['.chip'].padding],
  ['.chip', 'border-radius', geometry.selectors['.chip'].borderRadius],
  ['.chip', 'font-size', geometry.selectors['.chip'].fontSize],
  ['.chip', 'font-weight', geometry.selectors['.chip'].fontWeight],
  ['.chip', 'line-height', geometry.selectors['.chip'].lineHeight],
  ['.close', 'display', geometry.selectors['.close'].display],
  ['.close', 'align-items', geometry.selectors['.close'].alignItems],
  ['.close', 'color', geometry.selectors['.close'].color],
  ['.error', 'color', geometry.selectors['.error'].color],
  ['.error', 'font-size', geometry.selectors['.error'].fontSize],
  ['.error', 'line-height', geometry.selectors['.error'].lineHeight],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness PlanChip CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source: path.relative(harnessRoot, sourcePath),
  styleSource: path.relative(harnessRoot, cssPath),
  domContract: true,
  cssGeometry: `${cssChecks.filter(check => check.pass).length}/${cssChecks.length}`,
  cssChecks,
  candidateStatus: geometry.candidateStatus,
  evidenceGaps: ['no VCP Composer consumer', 'no paired Harness/VCP browser capture', 'no computed-style or pixel diff'],
  note: 'Read-only frozen Composer-domain evidence; plan projection, exit command and chat rendering remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness PlanChip reference audit: ${report.cssGeometry} CSS checks; frozen-domain boundary retained.`);

