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
const normalize = value => String(value ?? '')
    .replace(/\b0(?:px|rem|em|%|vh|vw)\b/g, '0')
    .replace(/min\(([^,]+),\s*(-[0-9.]+(?:px|rem|em|%|vh|vw))\s*\+\s*([^\)]+)\)/g, (_, limit, negative, viewport) => `min(${limit},calc(${viewport}-${negative.slice(1)}))`)
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*([+\-])\s*/g, '$1')
    .trim();

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
    const expectedDom = readJson(path.join(root, 'docs/reference/deepseek-harness-primitives/model-picker.dom.json'));
    const menuContract = expectedDom.menu;
    const structuralChecks = [
        { contract: 'root.tag', expected: expectedDom.root.tag, actual: rootNode?.tagName.toLowerCase() ?? null },
        { contract: 'trigger.tag', expected: expectedDom.trigger.tag, actual: trigger?.tagName.toLowerCase() ?? null },
        { contract: 'trigger.type', expected: expectedDom.trigger.type, actual: trigger?.getAttribute('type') ?? null },
        { contract: 'trigger.aria-haspopup', expected: menuContract.role, actual: trigger?.getAttribute('aria-haspopup') ?? null },
        { contract: 'menu.role', expected: menuContract.role, actual: candidate.menu?.role ?? null },
        { contract: 'root-pane.rows', expected: 2, actual: Number(candidate.rootPane?.modelRowVisible === true) + Number(candidate.rootPane?.effortRowVisible === true) },
        { contract: 'model-pane.options', expected: '>0', actual: candidate.modelPane?.optionCount ?? 0 },
    ];
    report.dom.structuralChecks = structuralChecks.map(check => ({ ...check, pass: check.expected === '>0' ? Number(check.actual) > 0 : check.actual === check.expected }));
    const rootDeviation = expectedDom.vcpDeviation?.rootTag;
    report.dom.deviations = rootDeviation ? [{ contract: 'root.tag', ...rootDeviation, observed: rootNode?.tagName.toLowerCase() ?? null, declared: rootDeviation.vcp === (rootNode?.tagName.toLowerCase() ?? null) }] : [];
    report.dom.structuralPass = report.dom.structuralChecks.every(check => check.pass || report.dom.deviations.some(deviation => deviation.contract === check.contract && deviation.declared));
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
        const interaction = harness.interaction ?? {};
        const interactionPass = interaction.rootPane === true
            && interaction.modelPane === true
            && interaction.effortPane === true
            && interaction.escapePaneBack?.modelRowVisible === true
            && interaction.escapePaneBack?.modelOptionsVisible === false
            && interaction.escapeClose === true
            && interaction.focusRestore === true
            && Array.isArray(harness.missingEvidence)
            && harness.missingEvidence.length === 0;
        report.harnessCapture = { source: harness.source ?? null, viewport: harness.viewport ?? null, domPresent: Boolean(harness.dom), computedStylePresent: Boolean(harness.trigger || harness.menu || harness.computedStyle), interaction: { ...interaction, pass: interactionPass }, schema: { requiredFields, viewportPass, productionConsumerPass: harness.productionConsumer === false, pass: harnessSchemaPass } };
        if (!harnessSchemaPass) report.missingEvidence.push('Harness capture schema/viewport/production boundary');
        if (!interactionPass) {
            report.status = 'pending-harness-interaction-evidence';
            report.missingEvidence.push('Harness ModelSelect keyboard/focus interaction evidence');
        }
        if (report.status !== 'pending-harness-interaction-evidence') report.status = 'harness-capture-available-pixel-pending';
        report.missingEvidence.push('same-semantic ModelSelect pixel diff');
        const textStyleKeys = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'];
        const textStyleChecks = [];
        for (const layer of ['groupTitles', 'modelNames', 'checks']) {
            const harnessStyles = harness.modelPane?.textStyles?.[layer] ?? [];
            const candidateStyles = candidate.modelPane?.textStyles?.[layer] ?? [];
            const count = Math.min(harnessStyles.length, candidateStyles.length);
            for (let index = 0; index < count; index += 1) {
                for (const key of textStyleKeys) {
                    if (harnessStyles[index]?.[key] == null && candidateStyles[index]?.[key] == null) continue;
                    textStyleChecks.push({ layer, index, property: key, harness: harnessStyles[index]?.[key] ?? null, vcp: candidateStyles[index]?.[key] ?? null,
                        pass: normalize(harnessStyles[index]?.[key]) === normalize(candidateStyles[index]?.[key]) });
                }
            }
            if (harnessStyles.length !== candidateStyles.length) textStyleChecks.push({ layer, property: 'count', harness: harnessStyles.length, vcp: candidateStyles.length, pass: false });
        }
        report.textStyle = { checks: textStyleChecks, pass: textStyleChecks.length > 0 && textStyleChecks.every(check => check.pass) };
    }
    if (!report.dom.ariaContractPass || !report.dom.structuralPass) report.missingEvidence.push('Candidate DOM/ARIA structural contract');
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
