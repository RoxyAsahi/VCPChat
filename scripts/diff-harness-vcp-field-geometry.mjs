import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = ['description', 'error'];
const styleKeys = ['display', 'padding', 'gap', 'height', 'borderRadius', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'borderColor'];
const nodes = ['root', 'head', 'label', 'input', 'message'];
const tolerance = 1;
const normalize = value => typeof value === 'string' ? value.trim().replace(/(^|\s)0(?=\s|$)/g, '$10px') : value;
const close = (left, right) => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
const read = file => fs.readFile(file, 'utf8').then(JSON.parse);

const comparisons = [];
for (const state of cases) {
    const [harness, vcp] = await Promise.all([
        read(path.join(root, `reports/harness-field-${state}.json`)),
        read(path.join(root, `reports/vcp-field-${state}.json`)),
    ]);
    const sameViewport = harness.viewport?.width === vcp.viewport?.width
        && harness.viewport?.height === vcp.viewport?.height
        && harness.viewport?.deviceScaleFactor === vcp.viewport?.deviceScaleFactor;
    const checks = [];
    for (const node of nodes) {
        for (const property of styleKeys) {
            const expected = harness[node].style[property];
            const actual = vcp[node].style[property];
            checks.push({ node, property, expected, actual, pass: normalize(expected) === normalize(actual) });
        }
        for (const property of ['width', 'height']) {
            const expected = harness[node].rect[property];
            const actual = vcp[node].rect[property];
            checks.push({ node, property: `rect.${property}`, expected, actual, tolerance, pass: close(expected, actual) });
        }
        if (node !== 'root') {
            for (const property of ['x', 'y']) {
                const expected = harness[node].rect[property] - harness.root.rect[property];
                const actual = vcp[node].rect[property] - vcp.root.rect[property];
                checks.push({ node, property: `rect.local${property.toUpperCase()}`, expected, actual, tolerance, pass: close(expected, actual) });
            }
        }
    }
    comparisons.push({
        state,
        semanticFixture: {
            same: harness.state === vcp.state && sameViewport,
            harness: `${harness.source}/${harness.state}`,
            vcp: `${vcp.source}/${vcp.state}`,
        },
        checks,
        pass: checks.every(check => check.pass),
    });
}
const report = {
    generatedAt: new Date().toISOString(),
    viewport: comparisons.length === 0 ? null : {
        harness: (await read(path.join(root, 'reports/harness-field-description.json'))).viewport,
        vcp: (await read(path.join(root, 'reports/vcp-field-description.json'))).viewport,
    },
    comparison: 'contract-scoped computed-style and geometry only',
    tolerance: { rectPx: tolerance, styles: 'exact after zero normalization' },
    cases: comparisons,
    pass: comparisons.every(item => item.semanticFixture.same && item.pass),
    status: comparisons.every(item => item.semanticFixture.same && item.pass) ? 'cross-page-field-geometry-equivalent' : 'cross-page-field-geometry-mismatch',
    missingEvidence: [],
};
await fs.writeFile(path.join(root, 'reports/harness-vcp-field-geometry-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Field geometry report written (${report.status}; pass=${report.pass}).`);
