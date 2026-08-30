import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const read = name => fs.readFile(path.join(root, 'reports', name), 'utf8').then(JSON.parse);
const [harness, vcp] = await Promise.all([
  read('harness-button-settings-document-production.json'),
  read('vcp-button-settings-document-candidate.json'),
]);
const actual = vcp.cases?.[0];
const policy = JSON.parse(await fs.readFile(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));
const normalize = (key, value) => key === 'fontFamily' && typeof value === 'string' ? value.replace(/"(system-ui)"/g, '$1') : value;
const styleKeys = ['display', 'alignItems', 'justifyContent', 'gap', 'padding', 'border', 'borderWidth', 'borderStyle', 'borderColor', 'borderRadius', 'boxSizing', 'appearance', 'outline', 'backgroundColor', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'boxShadow', 'cursor', 'opacity'];
const checks = [
  ['semanticFixture', harness.semanticFixture, vcp.semanticFixture, harness.semanticFixture === vcp.semanticFixture],
  ['text', harness.text, actual?.dom?.match(/>([^<]*)<\/button>/)?.[1] ?? null, harness.text === actual?.dom?.match(/>([^<]*)<\/button>/)?.[1]],
  ['height', harness.rect?.height, actual?.rect?.height, harness.rect?.height === actual?.rect?.height],
  ['width', harness.rect?.width, actual?.rect?.width, Math.abs((harness.rect?.width ?? 0) - (actual?.rect?.width ?? 0)) <= 0.5],
  ['authored.display', harness.authored?.matchedRules?.some(rule => rule.declarations?.display === 'inline-flex') || harness.authored?.inline?.display === 'inline-flex', actual?.authored?.matchedRules?.some(rule => rule.declarations?.display === 'inline-flex') || actual?.authored?.inline?.display === 'inline-flex', (harness.authored?.matchedRules?.some(rule => rule.declarations?.display === 'inline-flex') || harness.authored?.inline?.display === 'inline-flex') && (actual?.authored?.matchedRules?.some(rule => rule.declarations?.display === 'inline-flex') || actual?.authored?.inline?.display === 'inline-flex')],
  ...styleKeys.map(key => { const expected = harness.style?.[key] ?? null; const value = actual?.style?.[key] ?? null; return [`style.${key}`, expected, value, normalize(key, expected) === normalize(key, value)]; }),
];
const [left, right] = await Promise.all([
  sharp(path.join(root, 'reports/harness-button-settings-document-production.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  sharp(path.join(root, 'reports/vcp-button-settings-document-candidate.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
]);
const comparable = left.info.width === right.info.width && left.info.height === right.info.height;
let differentPixels = 0; let totalDelta = 0;
if (comparable) for (let index = 0; index < left.data.length; index += 4) {
  const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(left.data[index + channel] - right.data[index + channel])));
  if (delta) differentPixels += 1;
  totalDelta += delta;
}
const totalPixels = comparable ? left.info.width * left.info.height : 0;
const meanChannelDelta = comparable ? totalDelta / totalPixels : null;
const pass = comparable && checks.every(([, , , value]) => value) && differentPixels / totalPixels <= policy.maxDifferingRatio && meanChannelDelta <= policy.maxMeanChannelDelta;
const report = { semanticFixture: harness.semanticFixture, comparison: 'SettingsDocumentAction enabled outline/sm Button; VCP remains Candidate Lab only', harness: { rect: harness.rect, style: harness.style, screenshot: { width: left.info.width, height: left.info.height } }, vcp: { rect: actual?.rect, style: actual?.style, screenshot: { width: right.info.width, height: right.info.height } }, checks: checks.map(([property, expected, value, valuePass]) => ({ property, expected, actual: value, pass: valuePass })), pixels: { comparable, differentPixels, totalPixels, differingRatio: comparable ? differentPixels / totalPixels : null, meanChannelDelta }, policy, pass, status: !comparable ? 'pending-button-settings-document-roi-dimension-mismatch' : pass ? 'candidate-button-settings-document-pixel-policy-pass' : 'cross-page-button-settings-document-pixel-mismatch', missingEvidence: ['VCP production consumer', 'legacy presentation deletion'] };
await fs.writeFile(path.join(root, 'reports/harness-vcp-button-settings-document-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP SettingsDocumentAction Button diff: ${report.status}; pass=${report.pass}.`);
