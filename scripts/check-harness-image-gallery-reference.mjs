import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourcePath = path.join(harnessRoot, 'packages/client/ui-attachment/src/MessageImage.tsx');
const cssPath = path.join(harnessRoot, 'packages/client/ui-attachment/src/MessageImage.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/image-gallery.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/image-gallery.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-image-gallery-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['export function ImageGallery', 'if (images.length === 0) return null', "images.length === 1 ? 'single' : 'tile'", 'data-align={align}', 'attachment.attachmentId}:${index}', '...image', 'variant={variant}']) {
  assert.ok(source.includes(token), `ImageGallery source missing ${token}`);
}
assert.equal(dom.root.empty, 'null when images.length === 0');
assert.equal(dom.root.dataAlign, 'start | end');
assert.equal(dom.children.key, 'attachmentId:index');
assert.equal(geometry.candidateStatus, 'source-only frozen chat attachment; no VCP consumer or paired visual capture');

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
  ['.gallery', 'display', geometry.selectors['.gallery'].display],
  ['.gallery', 'flex-wrap', geometry.selectors['.gallery'].flexWrap],
  ['.gallery', 'gap', geometry.selectors['.gallery'].gap],
  ['.gallery', 'max-width', geometry.selectors['.gallery'].maxWidth],
  [".gallery[data-align='end']", 'justify-content', geometry.selectors[".gallery[data-align='end']"].justifyContent],
  [".gallery[data-align='end']", 'align-self', geometry.selectors[".gallery[data-align='end']"].alignSelf],
  [".gallery[data-align='start']", 'justify-content', geometry.selectors[".gallery[data-align='start']"].justifyContent],
  [".gallery[data-align='start']", 'align-self', geometry.selectors[".gallery[data-align='start']"].alignSelf],
  [".frame[data-variant='tile']", 'width', geometry.selectors[".frame[data-variant='tile']"].width],
  [".frame[data-variant='tile']", 'height', geometry.selectors[".frame[data-variant='tile']"].height],
  [".frame[data-variant='tile']", 'min-width', geometry.selectors[".frame[data-variant='tile']"].minWidth],
  [".frame[data-variant='tile']", 'min-height', geometry.selectors[".frame[data-variant='tile']"].minHeight],
].map(([selector, property, expected]) => {
  const actual = declarations.get(selector.replace(/(['"])([^'"]*)\1/g, '$2'))?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness ImageGallery CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source: path.relative(harnessRoot, sourcePath),
  styleSource: path.relative(harnessRoot, cssPath),
  domContract: true,
  cssGeometry: `${cssChecks.filter(check => check.pass).length}/${cssChecks.length}`,
  cssChecks,
  candidateStatus: geometry.candidateStatus,
  evidenceGaps: ['no VCP chat attachment consumer', 'no paired Harness/VCP browser capture', 'no computed-style or pixel diff'],
  note: 'Read-only frozen-domain aggregation evidence; child MessageImage owns loading/retry/lightbox behavior and chat rendering remains frozen.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness ImageGallery reference audit: ${report.cssGeometry} CSS checks; frozen-domain boundary retained.`);

