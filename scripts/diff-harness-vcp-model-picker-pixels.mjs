import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const harnessPath = process.env.HARNESS_MODEL_PICKER_SCREENSHOT || path.join(root, 'reports/harness-agent-model-picker.png');
const vcpPath = process.env.VCP_MODEL_PICKER_SCREENSHOT || path.join(root, 'reports/vcp-agent-model-picker-candidate.png');
const harnessReportPath = process.env.HARNESS_MODEL_PICKER_REPORT || path.join(root, 'reports/harness-agent-model-picker.json');
const outputPath = path.join(root, 'reports/harness-vcp-model-picker-pixel-diff.json');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));
const report = { generatedAt: new Date().toISOString(), harness: harnessPath, vcp: vcpPath, policy, pass: false, missingEvidence: [] };

try {
    if (!fs.existsSync(harnessPath)) report.missingEvidence.push('Harness ModelSelect screenshot');
    else if (!fs.existsSync(harnessReportPath)) report.missingEvidence.push('Harness ModelSelect capture report paired with screenshot');
    if (!fs.existsSync(vcpPath)) report.missingEvidence.push('VCP ModelSelect Candidate screenshot');
    if (report.missingEvidence.length) {
        report.status = 'pending-screenshot-capture';
    } else {
        const [harnessReport, vcpReport] = await Promise.all([
            import('node:fs/promises').then(fs => fs.readFile(harnessReportPath, 'utf8')).then(JSON.parse),
            import('node:fs/promises').then(fs => fs.readFile(path.join(root, 'reports/vcp-agent-model-picker-candidate.json'), 'utf8')).then(JSON.parse),
        ]);
        report.semanticFixture = {
            harness: {
                modelOptions: harnessReport.modelPane?.options?.length ?? null,
                effortOptions: harnessReport.effortPane?.options?.length ?? null,
                searchVisible: null,
            },
            vcp: {
                modelOptions: vcpReport.modelPane?.optionCount ?? null,
                effortOptions: vcpReport.effortPane?.optionCount ?? null,
                searchVisible: vcpReport.modelPane?.searchVisible ?? null,
            },
        };
        report.semanticEquivalent = report.semanticFixture.harness.modelOptions === report.semanticFixture.vcp.modelOptions
            && report.semanticFixture.harness.effortOptions === report.semanticFixture.vcp.effortOptions;
        if (!report.semanticEquivalent) {
            report.status = 'pending-semantic-fixture-alignment';
            report.missingEvidence.push('semantic fixture alignment');
        }
        const [harness, vcp] = await Promise.all([sharp(harnessPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), sharp(vcpPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })]);
        report.dimensions = { harness: harness.info, vcp: vcp.info };
        const sameSize = harness.info.width === vcp.info.width && harness.info.height === vcp.info.height;
        if (!sameSize && report.semanticEquivalent) {
            report.status = 'pixel-dimension-mismatch';
            report.missingEvidence.push('same viewport dimensions');
        } else if (sameSize && report.semanticEquivalent) {
            let different = 0;
            let totalDelta = 0;
            const pixels = harness.info.width * harness.info.height;
            for (let index = 0; index < harness.data.length; index += 4) {
                const delta = Math.max(Math.abs(harness.data[index] - vcp.data[index]), Math.abs(harness.data[index + 1] - vcp.data[index + 1]), Math.abs(harness.data[index + 2] - vcp.data[index + 2]), Math.abs(harness.data[index + 3] - vcp.data[index + 3]));
                totalDelta += delta;
                if (delta > 0) different += 1;
            }
            report.status = 'compared';
            report.differentPixels = different;
            report.totalPixels = pixels;
            report.differingRatio = different / pixels;
            report.meanChannelDelta = totalDelta / pixels;
            report.pass = report.differingRatio <= policy.maxDifferingRatio && report.meanChannelDelta <= policy.maxMeanChannelDelta;
            if (!report.pass) report.missingEvidence.push('pixel tolerance');
        }
    }
} catch (error) {
    report.status = 'pending-invalid-screenshot';
    report.error = error.message;
    report.missingEvidence.push('valid RGBA PNG screenshots');
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness↔VCP ModelSelect pixel diff written (status=${report.status}; pass=${report.pass}).`);
