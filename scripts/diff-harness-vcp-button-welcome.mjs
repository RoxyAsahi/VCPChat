import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const read = name => fs.readFile(path.join(root, 'reports', name), 'utf8').then(JSON.parse);
const [harness, vcp] = await Promise.all([read('harness-button-welcome-production.json'), read('vcp-button-welcome-projection.json')]);
const actual = vcp.cases?.[0];
const policy = JSON.parse(await fs.readFile(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));
const styleKeys = ['display', 'alignItems', 'justifyContent', 'gap', 'padding', 'border', 'borderWidth', 'borderStyle', 'borderColor', 'borderRadius', 'boxSizing', 'appearance', 'outline', 'backgroundColor', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'boxShadow', 'cursor', 'opacity'];
const normalizeStyle = (key, value) => key === 'fontFamily' && typeof value === 'string'
  ? value.replace(/"(system-ui)"/g, '$1')
  : value;
const checks = [
  ['semanticFixture', harness.semanticFixture, vcp.semanticFixture, harness.semanticFixture === vcp.semanticFixture],
  ['text', harness.text, actual?.dom?.match(/>([^<]*)<\/button>/)?.[1] ?? null, harness.text === actual?.dom?.match(/>([^<]*)<\/button>/)?.[1]],
  ['height', harness.rect?.height, actual?.rect?.height, harness.rect?.height === actual?.rect?.height],
  ['borderRadius', harness.style?.borderRadius, actual?.style?.borderRadius, harness.style?.borderRadius === actual?.style?.borderRadius],
  ['padding', harness.style?.padding, actual?.style?.padding, harness.style?.padding === actual?.style?.padding],
  ['width', harness.rect?.width, actual?.rect?.width, Math.abs((harness.rect?.width ?? 0) - (actual?.rect?.width ?? 0)) <= 0.5],
  ['authored.display', harness.authored?.matchedRules?.some(rule => rule.declarations?.display === 'inline-flex') || harness.authored?.inline?.display === 'inline-flex', actual?.authored?.matchedRules?.some(rule => rule.declarations?.display === 'inline-flex') || actual?.authored?.inline?.display === 'inline-flex', (harness.authored?.matchedRules?.some(rule => rule.declarations?.display === 'inline-flex') || harness.authored?.inline?.display === 'inline-flex') && (actual?.authored?.matchedRules?.some(rule => rule.declarations?.display === 'inline-flex') || actual?.authored?.inline?.display === 'inline-flex')],
  ...styleKeys.map(key => {
    const expected = harness.style?.[key] ?? null;
    const actualValue = actual?.style?.[key] ?? null;
    return [`style.${key}`, expected, actualValue, normalizeStyle(key, expected) === normalizeStyle(key, actualValue)];
  }),
];
const [left, right] = await Promise.all([
  sharp(path.join(root, 'reports/harness-button-welcome-production.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  sharp(path.join(root, 'reports/vcp-button-welcome-projection.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
]);
const comparable = left.info.width === right.info.width && left.info.height === right.info.height;
let differentPixels = 0;
let meanChannelDelta = null;
let pixelDiffPath = null;
if (comparable) {
  const diff = Buffer.alloc(left.data.length); let totalDelta = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(left.data[index + channel] - right.data[index + channel])));
    if (delta) differentPixels += 1;
    totalDelta += delta; diff[index] = delta ? 255 : 0; diff[index + 3] = 255;
  }
  meanChannelDelta = totalDelta / (left.info.width * left.info.height);
  pixelDiffPath = path.join(root, 'reports/harness-vcp-button-welcome-pixel-diff.png');
  await sharp(diff, { raw: { width: left.info.width, height: left.info.height, channels: 4 } }).png().toFile(pixelDiffPath);
}
const report = {
  generatedAt: new Date().toISOString(),
  semanticFixture: harness.semanticFixture,
  comparison: 'Button element ROI only; VCP fixture reproduces documented WelcomeNotice consumer min-width and primary token, but remains Candidate Lab only',
  harness: { rect: harness.rect, style: harness.style, screenshot: { width: left.info.width, height: left.info.height } },
  vcp: { rect: actual?.rect, style: actual?.style, screenshot: { width: right.info.width, height: right.info.height } },
  checks: checks.map(([property, expected, actualValue, pass]) => ({ property, expected, actual: actualValue, pass })),
  pixels: { comparable, differentPixels, totalPixels: comparable ? left.info.width * left.info.height : 0, differingRatio: comparable ? differentPixels / (left.info.width * left.info.height) : null, meanChannelDelta, diffImage: pixelDiffPath },
  policy,
  pass: comparable && checks.every(([, , , pass]) => pass) && differentPixels / (left.info.width * left.info.height) <= policy.maxDifferingRatio && meanChannelDelta <= policy.maxMeanChannelDelta,
  status: !comparable ? 'pending-button-roi-dimension-mismatch' : null,
  missingEvidence: ['VCP production consumer', 'legacy presentation deletion'],
};
report.status ??= report.pass ? 'candidate-button-roi-pixel-policy-pass' : 'cross-page-button-pixel-mismatch';
await fs.writeFile(path.join(root, 'reports/harness-vcp-button-welcome-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Welcome Button diff: ${report.status}; pass=${report.pass}.`);
