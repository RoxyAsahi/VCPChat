import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const referencePath = path.join(root, 'docs/reference/deepseek-harness-primitives');
const vcpPath = path.join(root, 'reports/vcp-primitive-geometry.json');
const outputPath = path.join(root, 'reports/harness-vcp-geometry-diff.json');

const readJson = async file => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
};

const reference = await readJson(path.join(referencePath, 'input.geometry.json'));
const select = await readJson(path.join(referencePath, 'select.geometry.json'));
const vcp = await readJson(vcpPath);

// This report deliberately separates a one-sided contract check from a real
// Harness↔VCP computed-style diff. The latter is pending until a browser capture
// from the Harness production page is supplied.
const checks = [
    ['input.root.height', reference?.root?.height, vcp?.geometry?.inputWrapHeight],
    ['input.root.gap', reference?.root?.gap, vcp?.geometry?.inputWrapGap],
    ['input.root.padding', reference?.root?.padding, vcp?.geometry?.inputWrapPadding],
    ['input.root.borderRadius', reference?.root?.borderRadius, vcp?.geometry?.inputWrapRadius],
    ['input.fontSize', reference?.input?.fontSize, vcp?.geometry?.inputFontSize],
    ['input.lineHeight', reference?.input?.lineHeight, vcp?.geometry?.inputLineHeight],
    ['select.list.minWidth', select?.selectors?.['.list']?.minWidth, vcp?.geometry?.menuMinWidth],
    ['select.list.borderRadius', select?.selectors?.['.list']?.borderRadius, vcp?.geometry?.menuRadius],
    ['select.item.minHeight', select?.selectors?.['.item']?.minHeight, vcp?.geometry?.minHeight],
    ['select.item.padding', select?.selectors?.['.item']?.padding, vcp?.geometry?.padding],
    ['select.item.gap', select?.selectors?.['.item']?.gap, vcp?.geometry?.itemGap],
    ['select.item.borderRadius', select?.selectors?.['.item']?.borderRadius, vcp?.geometry?.itemRadius],
    ['select.item.fontSize', select?.selectors?.['.item']?.fontSize, vcp?.geometry?.itemFontSize],
    ['select.item.lineHeight', select?.selectors?.['.item']?.lineHeight, vcp?.geometry?.itemLineHeight],
];

const canonicalize = value => {
    if (typeof value !== 'string') return value;
    return value.trim().split(/\s+/).map(token => token === '0' ? '0px' : token).join(' ');
};

const contract = checks.map(([property, expected, actual]) => ({
    property,
    expected: expected ?? null,
    actual: actual ?? null,
    pass: expected != null && actual != null && canonicalize(expected) === canonicalize(actual),
}));

const report = {
    generatedAt: new Date().toISOString(),
    viewport: vcp?.viewport ?? null,
    status: vcp ? 'contract-scoped-one-sided-check' : 'pending-vcp-capture',
    pass: false,
    harnessComputedStyleCapture: { status: 'pending', path: 'reports/harness-primitive-geometry.json' },
    vcpComputedStyleCapture: { status: vcp ? 'available' : 'missing', path: 'reports/vcp-primitive-geometry.json' },
    contract,
    missingEvidence: ['Harness browser computed-style capture', 'cross-page geometry diff', 'screenshot/pixel diff'],
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness↔VCP geometry report written (${contract.filter(item => item.pass).length}/${contract.length} contract checks; cross-page diff pending).`);
