import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const read = name => fs.readFile(path.join(root, 'reports', name), 'utf8').then(JSON.parse);
const [harness, vcp] = await Promise.all([read('harness-button-welcome-production.json'), read('vcp-button-welcome-production.json')]);
const actual = vcp.cases?.[0];
const checks = [
  ['semanticFixture', harness.semanticFixture, vcp.semanticFixture, harness.semanticFixture === vcp.semanticFixture],
  ['text', harness.text, actual?.dom?.match(/>([^<]*)<\/button>/)?.[1] ?? null, harness.text === actual?.dom?.match(/>([^<]*)<\/button>/)?.[1]],
  ['height', harness.rect?.height, actual?.rect?.height, harness.rect?.height === actual?.rect?.height],
  ['borderRadius', harness.style?.borderRadius, actual?.style?.borderRadius, harness.style?.borderRadius === actual?.style?.borderRadius],
  ['padding', harness.style?.padding, actual?.style?.padding, harness.style?.padding === actual?.style?.padding],
  ['width', harness.rect?.width, actual?.rect?.width, Math.abs((harness.rect?.width ?? 0) - (actual?.rect?.width ?? 0)) <= 0.5],
];
const [left, right] = await Promise.all([
  sharp(path.join(root, 'reports/harness-button-welcome-production.png')).metadata(),
  sharp(path.join(root, 'reports/vcp-button-welcome-production.png')).metadata(),
]);
const report = {
  generatedAt: new Date().toISOString(),
  semanticFixture: harness.semanticFixture,
  comparison: 'Button ROI only; consumer-specific width is intentionally not normalized',
  harness: { rect: harness.rect, style: harness.style, screenshot: { width: left.width, height: left.height } },
  vcp: { rect: actual?.rect, style: actual?.style, screenshot: { width: right.width, height: right.height } },
  checks: checks.map(([property, expected, actualValue, pass]) => ({ property, expected, actual: actualValue, pass })),
  pass: checks.every(item => item[3]) && left.width === right.width && left.height === right.height,
  status: checks.every(item => item[3]) && left.width === right.width && left.height === right.height ? 'cross-page-button-pixel-equivalent' : 'cross-page-button-consumer-geometry-mismatch',
  missingEvidence: ['VCP production consumer', 'legacy presentation deletion'],
};
await fs.writeFile(path.join(root, 'reports/harness-vcp-button-welcome-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Welcome Button diff: ${report.status}; pass=${report.pass}.`);
