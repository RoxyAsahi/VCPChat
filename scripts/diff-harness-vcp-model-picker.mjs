import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const candidatePath = process.env.VCP_MODEL_PICKER_REPORT || path.join(root, 'reports/vcp-agent-model-picker-candidate.json');
const harnessPath = process.env.HARNESS_MODEL_PICKER_REPORT || path.join(root, 'reports/harness-agent-model-picker.json');
const geometryPath = path.join(root, 'docs/reference/deepseek-harness-primitives/model-picker.geometry.json');
const schemaPath = path.join(root, 'docs/reference/deepseek-harness-primitives/model-picker.capture.schema.json');
const outputPath = path.join(root, 'reports/harness-vcp-model-picker-diff.json');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();

const report = { generatedAt: new Date().toISOString(), candidate: candidatePath, harness: harnessPath, comparison: 'ModelSelect Candidate vs Harness capture', pass: false, missingEvidence: [] };
try {
    const candidate = readJson(candidatePath);
    const geometry = readJson(geometryPath);
    const schema = readJson(schemaPath);
    report.captureSchema = { name: schema.name, version: schema.version, path: schemaPath };
    report.viewport = candidate.viewport ?? geometry.viewport ?? null;
    report.candidateStatus = candidate.status ?? null;
    report.productionConsumer = candidate.productionConsumer ?? null;
    const dom = new JSDOM(candidate.dom ?? '').window.document;
    const rootNode = dom.querySelector('.vcp-harness-agent-model-picker');
    const trigger = dom.querySelector('.vcp-harness-agent-model-picker-trigger');
    report.dom = {
        rootPresent: Boolean(rootNode),
        triggerPresent: Boolean(trigger),
        triggerTag: trigger?.tagName.toLowerCase() ?? null,
        triggerHasPopup: trigger?.getAttribute('aria-haspopup') ?? null,
        triggerControlsMenu: Boolean(trigger?.getAttribute('aria-controls')),
        ariaContractPass: trigger?.tagName.toLowerCase() === 'button' && trigger?.getAttribute('aria-haspopup') === 'menu' && Boolean(trigger?.getAttribute('aria-controls')),
    };
    const expected = geometry.selectors;
    const actual = {
        '.trigger': candidate.trigger ?? {},
        '.menu': candidate.menu?.cssContract ?? {},
    };
    const styleChecks = [];
    for (const [selector, properties] of Object.entries(expected)) {
        const source = selector === '.trigger' ? actual['.trigger'] : selector === '.menu' ? actual['.menu'] : null;
        if (!source) continue;
        for (const [property, expectedValue] of Object.entries(properties)) {
            if (property === 'offset') continue;
            const actualValue = source[property] ?? null;
            styleChecks.push({ selector, property, expected: expectedValue, actual: actualValue, pass: actualValue != null && normalize(actualValue) === normalize(expectedValue) });
        }
    }
    report.computedStyle = { checks: styleChecks, pass: styleChecks.length > 0 && styleChecks.every(check => check.pass) };
    report.interaction = {
        candidateStatus: candidate.status ?? null,
        paneEvidence: Boolean(candidate.rootPane && candidate.modelPane && candidate.effortPane),
        keyboardEscapeFocusDispose: Boolean(candidate.keyboardNavigation && candidate.modelEscape && candidate.effortEscape && candidate.focusRestored && candidate.disposed),
    };
    if (!fs.existsSync(harnessPath)) {
        report.status = 'pending-harness-capture';
        report.missingEvidence.push('Harness ModelSelect browser capture (DOM + computed style)');
    } else {
        const harness = readJson(harnessPath);
        const requiredFields = schema.required.filter(field => harness[field] == null);
        const viewportPass = JSON.stringify(harness.viewport ?? null) === JSON.stringify(schema.viewport);
        const harnessSchemaPass = requiredFields.length === 0 && viewportPass && harness.productionConsumer === false;
        report.harnessCapture = { source: harness.source ?? null, viewport: harness.viewport ?? null, domPresent: Boolean(harness.dom), computedStylePresent: Boolean(harness.trigger || harness.menu || harness.computedStyle), schema: { requiredFields, viewportPass, productionConsumerPass: harness.productionConsumer === false, pass: harnessSchemaPass } };
        if (!harnessSchemaPass) report.missingEvidence.push('Harness capture schema/viewport/production boundary');
        report.status = 'harness-capture-available-pixel-pending';
        report.missingEvidence.push('same-semantic ModelSelect pixel diff');
    }
    if (!report.dom.ariaContractPass) report.missingEvidence.push('Candidate DOM/ARIA contract');
    if (!report.computedStyle.pass) report.missingEvidence.push('Candidate computed-style contract');
    report.pass = report.status === 'harness-capture-available-pixel-pending' && report.missingEvidence.length === 1 && report.dom.ariaContractPass && report.computedStyle.pass;
} catch (error) {
    report.status = 'pending-missing-or-invalid-input';
    report.error = error.message;
    report.missingEvidence.push('VCP ModelSelect Candidate capture');
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness↔VCP ModelSelect diff report written (status=${report.status}; pass=${report.pass}).`);
