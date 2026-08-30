import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const strict = process.argv.includes('--strict');
const reportPath = path.join(root, 'reports/harness-capture-freshness.json');
const expectedViewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const pairs = [
    { name: 'harness-model-picker', json: 'reports/harness-agent-model-picker.json', png: 'reports/harness-agent-model-picker.png' },
    { name: 'harness-model-picker-selection-error-toast', json: 'reports/harness-agent-model-picker-selection-error-toast.json', png: 'reports/harness-agent-model-picker-selection-error-toast.png' },
    { name: 'vcp-model-picker-candidate', json: 'reports/vcp-agent-model-picker-candidate.json', png: 'reports/vcp-agent-model-picker-candidate.png' },
];
const checks = [];
let sharp;
try { sharp = createRequire(import.meta.url)('sharp'); } catch { sharp = null; }

for (const pair of pairs) {
    const jsonPath = path.join(root, pair.json);
    const pngPath = path.join(root, pair.png);
    const entry = { ...pair, jsonExists: fs.existsSync(jsonPath), pngExists: fs.existsSync(pngPath), viewportPass: false, pngPass: false, orderingPass: false, missing: [] };
    if (!entry.jsonExists) entry.missing.push('capture JSON');
    if (!entry.pngExists) entry.missing.push('capture PNG');
    if (entry.jsonExists) {
        try {
            const capture = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            entry.viewport = capture.viewport ?? null;
            entry.viewportPass = JSON.stringify(entry.viewport) === JSON.stringify(expectedViewport);
            if (!entry.viewportPass) entry.missing.push('fixed 800x600@1 viewport');
        } catch (error) { entry.missing.push(`valid JSON: ${error.message}`); }
    }
    if (entry.pngExists) {
        if (!sharp) entry.missing.push('sharp decoder');
        else {
            try {
                const metadata = await sharp(pngPath).metadata();
                entry.png = { width: metadata.width ?? null, height: metadata.height ?? null, format: metadata.format ?? null };
                entry.pngPass = metadata.format === 'png' && (metadata.width ?? 0) > 0 && (metadata.height ?? 0) > 0;
                if (!entry.pngPass) entry.missing.push('non-empty PNG');
            } catch (error) { entry.missing.push(`readable PNG: ${error.message}`); }
        }
    }
    if (entry.jsonExists && entry.pngExists) {
        entry.orderingPass = fs.statSync(jsonPath).mtimeMs >= fs.statSync(pngPath).mtimeMs;
        if (!entry.orderingPass) entry.missing.push('JSON written after PNG');
    }
    entry.pass = entry.jsonExists && entry.pngExists && entry.viewportPass && entry.pngPass && entry.orderingPass;
    checks.push(entry);
}

const report = {
    generatedAt: new Date().toISOString(),
    strict,
    expectedViewport,
    status: checks.every(check => check.pass) ? 'capture-pairs-fresh' : 'capture-pairs-incomplete',
    pass: checks.every(check => check.pass),
    checks,
    note: 'Read-only evidence gate; it does not create, rewrite, or promote captures.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness capture freshness: ${report.status}; pairs=${checks.filter(check => check.pass).length}/${checks.length}.`);
if (strict && !report.pass) process.exitCode = 1;
