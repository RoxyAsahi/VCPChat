import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const policy = JSON.parse(await fs.readFile(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));
const [harness, vcp] = await Promise.all([
  fs.readFile(path.join(root, 'reports/harness-select-trigger-closed.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(root, 'reports/vcp-select-trigger-closed.json'), 'utf8').then(JSON.parse),
]);
const sameFixture = harness.semanticFixture === vcp.semanticFixture
  && harness.state === vcp.state
  && harness.text === vcp.text
  && JSON.stringify(harness.viewport) === JSON.stringify(vcp.viewport);
const normalizeClass = value => String(value || '').replace(/\b[A-Za-z0-9]+_seat\b/g, 'seat').trim();
const domShape = fixture => ({
  tag: fixture.dom.match(/^<([a-z0-9-]+)/i)?.[1] ?? null,
  class: normalizeClass(fixture.attributes?.class),
  aria: Object.fromEntries(Object.entries(fixture.attributes || {}).filter(([name]) => name.startsWith('aria-'))),
  children: [...fixture.dom.matchAll(/<(svg|span|path|mask|rect|circle)\b/gi)].map(match => match[1].toLowerCase()),
});
const dom = { generatedAt: new Date().toISOString(), semanticFixture: { same: sameFixture, harness: harness.semanticFixture, vcp: vcp.semanticFixture }, harness: domShape(harness), vcp: domShape(vcp) };
dom.pass = sameFixture && JSON.stringify(dom.harness) === JSON.stringify(dom.vcp);
await fs.writeFile(path.join(root, 'reports/harness-vcp-select-trigger-dom-diff.json'), `${JSON.stringify(dom, null, 2)}\n`);

const styleKeys = ['display', 'alignItems', 'gap', 'width', 'minHeight', 'padding', 'borderWidth', 'borderRadius', 'backgroundColor', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'boxShadow', 'cursor', 'opacity'];
const rectKeys = ['x', 'y', 'width', 'height'];
const close = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.5;
const checks = [
  ...styleKeys.map(property => ({ property: `style.${property}`, expected: harness.style[property], actual: vcp.style[property], pass: harness.style[property] === vcp.style[property] })),
  ...rectKeys.map(property => ({ property: `rect.${property}`, expected: harness.rect[property], actual: vcp.rect[property], tolerance: 0.5, pass: close(harness.rect[property], vcp.rect[property]) })),
];
const geometry = { generatedAt: new Date().toISOString(), semanticFixture: { same: sameFixture, harness: harness.semanticFixture, vcp: vcp.semanticFixture }, comparison: 'closed trigger contract-scoped computed-style and geometry', checks, pass: sameFixture && checks.every(check => check.pass), status: sameFixture && checks.every(check => check.pass) ? 'cross-page-select-trigger-geometry-equivalent' : 'cross-page-select-trigger-geometry-mismatch' };
await fs.writeFile(path.join(root, 'reports/harness-vcp-select-trigger-geometry-diff.json'), `${JSON.stringify(geometry, null, 2)}\n`);

const load = file => sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const [left, right] = await Promise.all([
  load(path.join(root, 'reports/harness-select-trigger-closed.png')),
  load(path.join(root, 'reports/vcp-select-trigger-closed.png')),
]);
const comparable = left.info.width === right.info.width && left.info.height === right.info.height;
let differentPixels = 0; let totalDelta = 0; let diffImage = null;
if (comparable) {
  const diff = Buffer.alloc(left.data.length);
  for (let index = 0; index < left.data.length; index += 4) {
    const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(left.data[index + channel] - right.data[index + channel])));
    if (delta) differentPixels++;
    totalDelta += delta;
    diff[index] = delta ? 255 : 0;
    diff[index + 3] = 255;
  }
  diffImage = path.join(root, 'reports/harness-vcp-select-trigger-pixel-diff.png');
  await sharp(diff, { raw: { width: left.info.width, height: left.info.height, channels: 4 } }).png().toFile(diffImage);
}
const totalPixels = comparable ? left.info.width * left.info.height : 0;
const differingRatio = totalPixels ? differentPixels / totalPixels : null;
const meanChannelDelta = totalPixels ? totalDelta / totalPixels : null;
const pixels = {
  generatedAt: new Date().toISOString(), policy, semanticFixture: { same: sameFixture, harness: harness.semanticFixture, vcp: vcp.semanticFixture }, comparisonRegion: 'direct closed trigger screenshot clip',
  harness: { width: left.info.width, height: left.info.height }, vcp: { width: right.info.width, height: right.info.height }, comparable, differentPixels, totalPixels, differingRatio, meanChannelDelta, diffImage,
  pass: sameFixture && comparable && differingRatio <= policy.maxDifferingRatio && meanChannelDelta <= policy.maxMeanChannelDelta,
  status: !sameFixture ? 'semantic-fixture-pending' : !comparable ? 'pending-trigger-dimension-mismatch' : differingRatio <= policy.maxDifferingRatio && meanChannelDelta <= policy.maxMeanChannelDelta ? 'cross-page-select-trigger-pixel-equivalent' : 'cross-page-select-trigger-pixel-mismatch',
};
await fs.writeFile(path.join(root, 'reports/harness-vcp-select-trigger-pixel-diff.json'), `${JSON.stringify(pixels, null, 2)}\n`);
console.log(`Harness↔VCP Select trigger: DOM=${dom.pass}, geometry=${geometry.pass}, pixels=${pixels.pass} (${pixels.status}).`);
