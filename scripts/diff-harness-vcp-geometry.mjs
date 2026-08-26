import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const referencePath = path.join(root, 'docs/reference/deepseek-harness-primitives');
const vcpPath = path.join(root, 'reports/vcp-primitive-geometry.json');
const harnessPath = path.join(root, 'reports/harness-primitive-geometry.json');
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
const harness = await readJson(harnessPath);
const harnessSelect = await readJson(path.join(root, 'reports/harness-select-menu-open.json'));
const vcpSelect = await readJson(path.join(root, 'reports/vcp-select-browser-production.json'));

// This report deliberately separates a one-sided contract check from a real
// Harness↔VCP computed-style diff. The latter is pending until a browser capture
// from the Harness production page is supplied.
const checks = [
    ['input.root.height', harness?.computedStyle?.height ?? reference?.root?.height, vcp?.geometry?.inputWrapHeight],
    ['input.root.padding', reference?.root?.padding, vcp?.geometry?.inputWrapPadding],
    ['input.padding', harness?.computedStyle?.padding, vcp?.geometry?.inputPadding],
    ['input.root.borderRadius', harness?.computedStyle?.borderRadius ?? reference?.root?.borderRadius, vcp?.geometry?.inputWrapRadius],
    ['input.fontSize', harness?.computedStyle?.fontSize ?? reference?.input?.fontSize, vcp?.geometry?.inputFontSize],
    ['input.lineHeight', harness?.computedStyle?.lineHeight ?? reference?.input?.lineHeight, vcp?.geometry?.inputLineHeight],
    ['select.list.minWidth', harnessSelect?.style?.minWidth ?? select?.selectors?.['.list']?.minWidth, vcp?.geometry?.menuMinWidth],
    ['select.list.borderRadius', harnessSelect?.style?.borderRadius ?? select?.selectors?.['.list']?.borderRadius, vcp?.geometry?.menuRadius],
    ['select.item.minHeight', harnessSelect?.items?.[0]?.style?.minHeight ?? select?.selectors?.['.item']?.minHeight, vcp?.geometry?.minHeight],
    ['select.item.padding', harnessSelect?.items?.[0]?.style?.padding ?? select?.selectors?.['.item']?.padding, vcp?.geometry?.padding],
    ['select.item.gap', harnessSelect?.items?.[0]?.style?.gap ?? select?.selectors?.['.item']?.gap, vcp?.geometry?.itemGap],
    ['select.item.borderRadius', harnessSelect?.items?.[0]?.style?.borderRadius ?? select?.selectors?.['.item']?.borderRadius, vcp?.geometry?.itemRadius],
    ['select.item.fontSize', harnessSelect?.items?.[0]?.style?.fontSize ?? select?.selectors?.['.item']?.fontSize, vcp?.geometry?.itemFontSize],
    ['select.item.lineHeight', harnessSelect?.items?.[0]?.style?.lineHeight ?? select?.selectors?.['.item']?.lineHeight, vcp?.geometry?.itemLineHeight],
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

const closeNumber = (expected, actual, tolerance = 1) => Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) <= tolerance;
const selectGeometry = [];
if (harnessSelect && vcpSelect) {
    for (const property of ['x', 'y', 'width', 'height']) {
        selectGeometry.push({ property: `select.list.rect.${property}`, expected: harnessSelect.rect?.[property] ?? null, actual: vcpSelect.rect?.[property] ?? null, tolerance: 1, pass: closeNumber(harnessSelect.rect?.[property], vcpSelect.rect?.[property]) });
    }
    for (const property of ['padding', 'borderRadius', 'minWidth', 'boxShadow']) {
        const expected = harnessSelect.style?.[property] ?? null;
        const actual = vcpSelect.style?.[property] ?? null;
        selectGeometry.push({ property: `select.list.style.${property}`, expected, actual, pass: canonicalize(expected) === canonicalize(actual) });
    }
    harnessSelect.items?.forEach((item, index) => {
        for (const property of ['x', 'y', 'width', 'height']) {
            const expected = item.rect?.[property] ?? null;
            const actual = vcpSelect.items?.[index]?.rect?.[property] ?? null;
            selectGeometry.push({ property: `select.item.${index}.rect.${property}`, expected, actual, tolerance: 1, pass: closeNumber(expected, actual) });
        }
    });
}
const selectGeometryPass = selectGeometry.length > 0 && selectGeometry.every(item => item.pass);

const report = {
    generatedAt: new Date().toISOString(),
    viewport: vcp?.viewport ?? null,
    status: selectGeometryPass ? 'cross-page-select-geometry-equivalent' : (harness && vcp ? 'cross-page-select-geometry-mismatch' : (vcp ? 'contract-scoped-one-sided-check' : 'pending-vcp-capture')),
    pass: contract.every(item => item.pass) && selectGeometryPass,
    harnessComputedStyleCapture: { status: harness ? 'available' : 'pending', path: 'reports/harness-primitive-geometry.json' },
    vcpComputedStyleCapture: { status: vcp ? 'available' : 'missing', path: 'reports/vcp-primitive-geometry.json' },
    semanticFixture: { harness: harnessSelect?.semanticFixture ?? harness?.selector ?? null, vcp: vcpSelect?.semanticFixture ?? vcp?.primitive ?? null, same: Boolean(harnessSelect?.semanticFixture && harnessSelect.semanticFixture === vcpSelect?.semanticFixture), reason: !harnessSelect || !vcpSelect ? 'one or both Select-only captures missing' : harnessSelect.semanticFixture === vcpSelect.semanticFixture ? null : 'fixture identifiers differ' },
    contract,
    selectGeometry,
    missingEvidence: [
        ...(harness ? [] : ['Harness browser computed-style capture']),
        ...(harnessSelect ? [] : ['Harness Select browser computed-style capture']),
        ...(selectGeometryPass ? [] : ['complete cross-page Select geometry diff']),
        'screenshot/pixel diff',
    ],
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness↔VCP geometry report written (${report.status}; pass=${report.pass}).`);
