import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const sourceDir = path.join(harnessRoot, 'packages/client/ui-attachment/src');
const sourcePath = path.join(sourceDir, 'MessageImage.tsx');
const cssPath = path.join(sourceDir, 'MessageImage.module.css');
const dom = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/message-image.dom.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/message-image.geometry.json'), 'utf8'));
const reportPath = path.join(root, 'reports/harness-message-image-reference.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');

const source = fs.readFileSync(sourcePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
for (const token of ['export function MessageImage', 'singleFit', 'let live = true', 'setAttempt(a => a + 1)', 'ImageLightbox', 'export function ImageGallery']) {
  assert.ok(source.includes(token), `MessageImage source missing ${token}`);
}
assert.equal(dom.trigger.type, 'button');
assert.equal(dom.image.objectFit, 'cover');
assert.equal(dom.loadingAndError.staleResolution, 'ignored after effect cleanup');
assert.equal(geometry.candidateStatus, 'source-only frozen chat attachment; no VCP consumer or paired visual capture');

const declarations = new Map();
const ast = csstree.parse(css);
csstree.walk(ast, {
  visit: 'Rule',
  enter(node) {
    if (node.type !== 'Rule') return;
    const selectorKeys = csstree.generate(node.prelude).split(',').map(value => value.replace(/(['"])([^'"]*)\1/g, '$2').trim()).filter(Boolean);
    if (!selectorKeys.length) return;
    const values = {};
    csstree.walk(node.block, { visit: 'Declaration', enter(declaration) { values[declaration.property] = csstree.generate(declaration.value); } });
    for (const selectorKey of selectorKeys) declarations.set(selectorKey, { ...(declarations.get(selectorKey) ?? {}), ...values });
  },
});
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
const cssChecks = [
  ['.gallery', 'display', geometry.selectors['.gallery'].display],
  ['.gallery', 'flex-wrap', geometry.selectors['.gallery'].flexWrap],
  ['.gallery', 'gap', geometry.selectors['.gallery'].gap],
  ['.gallery', 'max-width', geometry.selectors['.gallery'].maxWidth],
  ['.frame', 'display', geometry.selectors['.frame'].display],
  ['.frame', 'flex', geometry.selectors['.frame'].flex],
  ['.frame', 'place-items', geometry.selectors['.frame'].placeItems],
  ['.frame', 'min-width', geometry.selectors['.frame'].minWidth],
  ['.frame', 'min-height', geometry.selectors['.frame'].minHeight],
  ['.frame', 'padding', geometry.selectors['.frame'].padding],
  ['.frame', 'overflow', geometry.selectors['.frame'].overflow],
  ['.frame', 'border-radius', geometry.selectors['.frame'].borderRadius],
  [".frame[data-variant='tile']", 'width', geometry.selectors[".frame[data-variant='tile']"].width],
  [".frame[data-variant='tile']", 'height', geometry.selectors[".frame[data-variant='tile']"].height],
  [".frame[data-variant='tile']", 'min-width', geometry.selectors[".frame[data-variant='tile']"].minWidth],
  [".frame[data-variant='tile']", 'min-height', geometry.selectors[".frame[data-variant='tile']"].minHeight],
  ['.frame img', 'display', geometry.selectors['.frame img'].display],
  ['.frame img', 'width', geometry.selectors['.frame img'].width],
  ['.frame img', 'height', geometry.selectors['.frame img'].height],
  ['.frame img', 'object-fit', geometry.selectors['.frame img'].objectFit],
  ['.loading', 'font-size', geometry.selectors['.loading'].fontSize],
  ['.loading', 'line-height', geometry.selectors['.loading'].lineHeight],
  ['.error', 'max-width', geometry.selectors['.error'].maxWidth],
  ['.error', 'padding', geometry.selectors['.error'].padding],
  ['.error', 'border-radius', geometry.selectors['.error'].borderRadius],
  [".error[data-variant='tile']", 'width', geometry.selectors[".error[data-variant='tile']"].width],
  [".error[data-variant='tile']", 'height', geometry.selectors[".error[data-variant='tile']"].height],
  [".error[data-variant='tile']", 'padding', geometry.selectors[".error[data-variant='tile']"].padding],
  [".error[data-variant='tile']", 'overflow', geometry.selectors[".error[data-variant='tile']"].overflow],
  [".error[data-variant='tile']", 'border-radius', geometry.selectors[".error[data-variant='tile']"].borderRadius],
].map(([selector, property, expected]) => {
  const key = selector.replace(/(['"])([^'"]*)\1/g, '$2');
  const actual = declarations.get(key)?.[property] ?? null;
  return { selector, property, expected: String(expected), actual, pass: normalize(actual) === normalize(expected) };
});
for (const check of cssChecks) assert.equal(check.pass, true, `Harness MessageImage CSS mismatch for ${check.selector} ${check.property}: expected ${check.expected}, got ${check.actual}`);

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
  note: 'Read-only frozen-domain evidence; attachment loading, chat rendering and lightbox ownership remain outside this Candidate Lab slice.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness MessageImage reference audit: ${report.cssGeometry} CSS checks; frozen-domain boundary retained.`);
