import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-deliverables/src/client');
const sourcePath = path.join(sourceDir, 'ProducedFiles.tsx');
const cssPath = path.join(sourceDir, 'ProducedFiles.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/produced-files.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/produced-files.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-produced-files-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['fitProducedFiles', 'SHOWN_LIMIT = 6', 'aria-label={t(\'produced.open\'', 'openFile(path)', 'openFile(\'.\')', 'ResizeObserver', 'observer.disconnect()']) {
  assert.ok(source.includes(token), `ProducedFiles source missing ${token}`);
}
assert.equal(dom.root.tag, 'div');
assert.equal(dom.row.overflow, 'hidden paths become localized span.more');
assert.equal(dom.measurement.ariaHidden, true);
assert.equal(geometry.candidateStatus, 'source-only frozen chat deliverables; no VCP production consumer or paired visual capture');

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
  ['.root', 'display', geometry.selectors['.root'].display],
  ['.root', 'grid-template-columns', geometry.selectors['.root'].gridTemplateColumns],
  ['.root', 'align-items', geometry.selectors['.root'].alignItems],
  ['.root', 'column-gap', geometry.selectors['.root'].columnGap],
  ['.root', 'row-gap', geometry.selectors['.root'].rowGap],
  ['.root', 'margin-top', geometry.selectors['.root'].marginTop],
  ['.row', 'display', geometry.selectors['.row'].display],
  ['.row', 'flex-wrap', geometry.selectors['.row'].flexWrap],
  ['.row', 'gap', geometry.selectors['.row'].gap],
  ['.row', 'min-width', geometry.selectors['.row'].minWidth],
  ['.row', 'overflow', geometry.selectors['.row'].overflow],
  ['.file', 'max-width', geometry.selectors['.file'].maxWidth],
  ['.file', 'padding', geometry.selectors['.file'].padding],
  ['.file', 'border-radius', geometry.selectors['.file'].borderRadius],
  ['.file', 'white-space', geometry.selectors['.file'].whiteSpace],
  ['.more', 'white-space', geometry.selectors['.more'].whiteSpace],
  ['.showFolder', 'grid-column', geometry.selectors['.showFolder'].gridColumn],
  ['.showFolder', 'grid-row', geometry.selectors['.showFolder'].gridRow],
  ['.showFolder', 'padding', geometry.selectors['.showFolder'].padding],
  ['.measure', 'position', geometry.selectors['.measure'].position],
  ['.measure', 'width', geometry.selectors['.measure'].width],
  ['.measure', 'height', geometry.selectors['.measure'].height],
  ['.measure', 'contain', geometry.selectors['.measure'].contain],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness ProducedFiles CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source: path.relative(harnessRoot, sourcePath),
  styleSource: path.relative(harnessRoot, cssPath),
  domContract: true,
  cssGeometry: `${cssChecks.filter(check => check.pass).length}/${cssChecks.length}`,
  cssChecks,
  candidateStatus: geometry.candidateStatus,
  evidenceGaps: ['no VCP turn-tail consumer', 'no paired Harness/VCP browser capture', 'no computed-style or pixel diff'],
  note: 'Read-only frozen-domain evidence; produced-file matching, persistence and chat rendering remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness ProducedFiles reference audit: ${report.cssGeometry} CSS checks; frozen-domain boundary retained.`);

