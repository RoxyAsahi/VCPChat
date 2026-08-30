import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const candidatePath = path.join(root, 'reports', 'vcp-agent-model-picker-harness-equivalent-keyboard-path-keyboard-focus.png');
const referencePath = path.join(root, 'reports', 'harness-agent-model-picker-electron-reference-keyboard-focus.png');
const candidateReportPath = path.join(root, 'reports', 'vcp-agent-model-picker-harness-equivalent-keyboard-path.json');
const outputPath = path.join(root, 'reports', 'vcp-model-picker-keyboard-focus-same-engine-diff.json');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));

const report = {
    generatedAt: new Date().toISOString(),
    comparison: 'VCP generated AgentModelPicker versus actual Harness ModelSelect.module.css static source reference in the same Electron renderer',
    evidenceKind: 'same-engine-static-source-reference keyboard-focus ROI; not a Harness production-consumer comparison',
    pass: false,
    policy,
    missingEvidence: [],
};
for (const file of [candidatePath, referencePath, candidateReportPath]) {
    if (!fs.existsSync(file)) report.missingEvidence.push(path.basename(file));
}
if (report.missingEvidence.length === 0) {
    const candidateReport = JSON.parse(fs.readFileSync(candidateReportPath, 'utf8'));
    report.keyboardContract = {
        candidateFocusVisible: candidateReport.trustedKeyboardNavigation?.optionStyle?.pseudo?.focusVisible ?? null,
        referenceFocusVisible: candidateReport.sameEngineKeyboardFocusReference?.optionStyle?.pseudo?.focusVisible ?? null,
        candidateOutline: candidateReport.trustedKeyboardNavigation?.optionStyle?.computed?.outline ?? null,
        referenceOutline: candidateReport.sameEngineKeyboardFocusReference?.optionStyle?.computed?.outline ?? null,
    };
    const [candidate, reference] = await Promise.all([
        sharp(candidatePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        sharp(referencePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    report.dimensions = { candidate: candidate.info, reference: reference.info };
    if (candidate.info.width !== reference.info.width || candidate.info.height !== reference.info.height) {
        report.status = 'pending-same-engine-keyboard-focus-geometry';
        report.missingEvidence.push('matching keyboard-focus ROI dimensions');
    } else {
        let differentPixels = 0;
        let totalDelta = 0;
        const totalPixels = candidate.info.width * candidate.info.height;
        for (let index = 0; index < candidate.data.length; index += 4) {
            const delta = Math.max(
                Math.abs(candidate.data[index] - reference.data[index]),
                Math.abs(candidate.data[index + 1] - reference.data[index + 1]),
                Math.abs(candidate.data[index + 2] - reference.data[index + 2]),
                Math.abs(candidate.data[index + 3] - reference.data[index + 3]),
            );
            totalDelta += delta;
            if (delta > 0) differentPixels += 1;
        }
        report.status = 'same-engine-keyboard-focus-result';
        report.differentPixels = differentPixels;
        report.totalPixels = totalPixels;
        report.differingRatio = differentPixels / totalPixels;
        report.meanChannelDelta = totalDelta / totalPixels;
        report.pass = report.keyboardContract.candidateFocusVisible === true
            && report.keyboardContract.referenceFocusVisible === true
            && report.keyboardContract.candidateOutline === report.keyboardContract.referenceOutline
            && report.differingRatio <= policy.maxDifferingRatio
            && report.meanChannelDelta <= policy.maxMeanChannelDelta;
    }
} else {
    report.status = 'pending-same-engine-keyboard-focus-capture';
}
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`VCP ModelPicker keyboard-focus same-engine diff: status=${report.status}; pass=${report.pass}.`);
