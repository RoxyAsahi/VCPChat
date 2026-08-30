import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const harnessPath = path.join(root, 'reports', 'harness-agent-model-picker-keyboard-focus.png');
const vcpPath = path.join(root, 'reports', 'vcp-agent-model-picker-harness-equivalent-keyboard-path-keyboard-focus.png');
const harnessReport = JSON.parse(fs.readFileSync(path.join(root, 'reports', 'harness-agent-model-picker.json'), 'utf8'));
const vcpReport = JSON.parse(fs.readFileSync(path.join(root, 'reports', 'vcp-agent-model-picker-harness-equivalent-keyboard-path.json'), 'utf8'));
const outputPath = path.join(root, 'reports', 'harness-vcp-model-picker-keyboard-focus-diff.json');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));

const report = {
  generatedAt: new Date().toISOString(),
  comparison: 'Harness production vs VCP generated-artifact trusted keyboard-focus menu ROI',
  evidenceKind: 'same viewport, separate production/source captures; not a same-engine pixel proof',
  pass: false,
  missingEvidence: [],
  computed: {
    harness: harnessReport.keyboardNavigation?.modelPath?.optionStyle ?? null,
    vcp: vcpReport.trustedKeyboardNavigation?.optionStyle ?? null,
  },
  policy,
};

for (const [label, file] of [['Harness keyboard-focus screenshot', harnessPath], ['VCP keyboard-focus screenshot', vcpPath]]) {
  if (!fs.existsSync(file)) report.missingEvidence.push(label);
}
if (report.missingEvidence.length === 0) {
  const [harness, vcp] = await Promise.all([
    sharp(harnessPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(vcpPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  report.dimensions = { harness: harness.info, vcp: vcp.info };
  if (harness.info.width !== vcp.info.width || harness.info.height !== vcp.info.height) {
    report.status = 'pending-keyboard-focus-geometry';
    report.missingEvidence.push('matching keyboard-focus ROI dimensions');
  } else {
    let differentPixels = 0;
    let totalDelta = 0;
    const totalPixels = harness.info.width * harness.info.height;
    for (let index = 0; index < harness.data.length; index += 4) {
      const delta = Math.max(
        Math.abs(harness.data[index] - vcp.data[index]),
        Math.abs(harness.data[index + 1] - vcp.data[index + 1]),
        Math.abs(harness.data[index + 2] - vcp.data[index + 2]),
        Math.abs(harness.data[index + 3] - vcp.data[index + 3]),
      );
      totalDelta += delta;
      if (delta > 0) differentPixels += 1;
    }
    report.status = 'cross-capture-keyboard-focus-result';
    report.differentPixels = differentPixels;
    report.totalPixels = totalPixels;
    report.differingRatio = differentPixels / totalPixels;
    report.meanChannelDelta = totalDelta / totalPixels;
    report.note = 'This result records a cross-capture signal only. It cannot promote parity because the Harness and VCP captures are separate renderers.';
  }
} else {
  report.status = 'pending-keyboard-focus-capture';
}

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP keyboard-focus evidence written (status=${report.status}; pass=${report.pass}).`);
