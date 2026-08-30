import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const candidatePath = path.join(root, 'reports', 'vcp-agent-model-picker-harness-equivalent-hover-focus-hover.png');
const referencePath = path.join(root, 'reports', 'harness-agent-model-picker-electron-reference-hover-focus-hover.png');
const candidateReportPath = path.join(root, 'reports', 'vcp-agent-model-picker-harness-equivalent-hover-focus.json');
const referenceReportPath = path.join(root, 'reports', 'harness-agent-model-picker-electron-reference-hover-focus.json');
const outputPath = path.join(root, 'reports', 'vcp-model-picker-hover-same-engine-diff.json');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));

const report = {
    generatedAt: new Date().toISOString(),
    comparison: 'VCP generated AgentModelPicker versus actual Harness ModelSelect.module.css static source reference in the same Electron renderer',
    evidenceKind: 'same-engine-static-source-reference hover ROI; not a Harness production-consumer comparison',
    pass: false,
    policy,
    missingEvidence: [],
};

for (const file of [candidatePath, referencePath, candidateReportPath, referenceReportPath]) {
    if (!fs.existsSync(file)) report.missingEvidence.push(path.basename(file));
}

if (report.missingEvidence.length === 0) {
    const candidateReport = JSON.parse(fs.readFileSync(candidateReportPath, 'utf8'));
    const referenceReport = JSON.parse(fs.readFileSync(referenceReportPath, 'utf8'));
    report.hoverContract = {
        candidateHover: candidateReport.hoverFocus?.hovered?.pseudo?.hover ?? null,
        candidateFocus: candidateReport.hoverFocus?.hovered?.pseudo?.focus ?? null,
        referenceHover: referenceReport.hover?.pseudo?.hover ?? null,
        referenceFocus: referenceReport.hover?.pseudo?.focus ?? null,
        candidateBackground: candidateReport.hoverFocus?.hovered?.computed?.backgroundColor ?? null,
        referenceBackground: referenceReport.hover?.computed?.backgroundColor ?? null,
    };
    const [candidate, reference] = await Promise.all([
        sharp(candidatePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        sharp(referencePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    report.dimensions = { candidate: candidate.info, reference: reference.info };
    if (candidate.info.width !== reference.info.width || candidate.info.height !== reference.info.height) {
        report.status = 'pending-same-engine-hover-geometry';
        report.missingEvidence.push('matching hover ROI dimensions');
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
        report.status = 'same-engine-hover-result';
        report.differentPixels = differentPixels;
        report.totalPixels = totalPixels;
        report.differingRatio = differentPixels / totalPixels;
        report.meanChannelDelta = totalDelta / totalPixels;
        report.pass = report.hoverContract.candidateHover === true
            && report.hoverContract.candidateFocus === false
            && report.hoverContract.referenceHover === true
            && report.hoverContract.referenceFocus === false
            && report.hoverContract.candidateBackground === report.hoverContract.referenceBackground
            && report.differingRatio <= policy.maxDifferingRatio
            && report.meanChannelDelta <= policy.maxMeanChannelDelta;
    }
} else {
    report.status = 'pending-same-engine-hover-capture';
}

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`VCP ModelPicker hover same-engine diff: status=${report.status}; pass=${report.pass}.`);
