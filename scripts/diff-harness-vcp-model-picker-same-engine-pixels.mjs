import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const referenceScreenshot = path.join(root, 'reports/harness-agent-model-picker-electron-reference.png');
const referenceReportPath = path.join(root, 'reports/harness-agent-model-picker-electron-reference.json');
const candidateScreenshot = path.join(root, 'reports/vcp-agent-model-picker-harness-equivalent.png');
const candidateReportPath = path.join(root, 'reports/vcp-agent-model-picker-harness-equivalent.json');
const outputPath = path.join(root, 'reports/harness-vcp-model-picker-same-engine-pixel-diff.json');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));

const report = {
    generatedAt: new Date().toISOString(),
    comparison: 'Harness ModelSelect source DOM/CSS static reference vs VCP Harness-equivalent fixture in one Electron renderer',
    referenceScreenshot,
    candidateScreenshot,
    policy,
    pass: false,
    missingEvidence: [],
};

try {
    for (const [label, file] of [
        ['Harness source reference screenshot', referenceScreenshot],
        ['Harness source reference report', referenceReportPath],
        ['VCP Harness-equivalent screenshot', candidateScreenshot],
        ['VCP Harness-equivalent report', candidateReportPath],
    ]) {
        if (!fs.existsSync(file)) report.missingEvidence.push(label);
    }
    if (report.missingEvidence.length) {
        report.status = 'pending-same-engine-capture';
    } else {
        const [reference, candidate] = await Promise.all([
            fs.promises.readFile(referenceReportPath, 'utf8').then(JSON.parse),
            fs.promises.readFile(candidateReportPath, 'utf8').then(JSON.parse),
        ]);
        assert.equal(reference.referenceKind, 'same-engine-static-source-reference; not a Harness production consumer',
            'same-engine baseline must remain explicitly labelled as a static Harness source reference');
        assert.equal(reference.renderingEngine, 'VCP Electron renderer',
            'source reference must be evaluated in the VCP Electron renderer');
        assert.equal(candidate.fixtureMode, 'harness-equivalent',
            'candidate must use the declared Harness-equivalent fixture, not the enhanced production variant');
        assert.equal(reference.modelPane?.groupCount, candidate.modelPane?.groupCount,
            'same-engine fixture must preserve provider-group cardinality');
        assert.equal(reference.modelPane?.options?.length, candidate.modelPane?.optionCount,
            'same-engine fixture must preserve ModelSelect option cardinality');
        assert.equal(reference.effortPane?.options?.length, candidate.effortPane?.optionCount,
            'same-engine fixture must preserve effort option cardinality');
        assert.equal(reference.interaction?.searchVisible, candidate.modelPane?.searchVisible,
            'same-engine fixture must preserve search visibility');

        const [harness, vcp] = await Promise.all([
            sharp(referenceScreenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
            sharp(candidateScreenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
        ]);
        report.dimensions = { reference: harness.info, candidate: vcp.info };
        assert.equal(harness.info.width, vcp.info.width, 'same-engine ROI widths must match');
        assert.equal(harness.info.height, vcp.info.height, 'same-engine ROI heights must match');

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
        report.status = 'compared';
        report.semanticEquivalent = true;
        report.differentPixels = differentPixels;
        report.totalPixels = totalPixels;
        report.differingRatio = differentPixels / totalPixels;
        report.meanChannelDelta = totalDelta / totalPixels;
        report.pass = report.differingRatio <= policy.maxDifferingRatio
            && report.meanChannelDelta <= policy.maxMeanChannelDelta;
        if (!report.pass) report.missingEvidence.push('pixel tolerance');
    }
} catch (error) {
    report.status = 'pending-invalid-same-engine-evidence';
    report.error = error.message;
    report.missingEvidence.push('valid same-engine source-reference evidence');
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness↔VCP ModelSelect same-engine pixel diff written (status=${report.status}; pass=${report.pass}).`);
