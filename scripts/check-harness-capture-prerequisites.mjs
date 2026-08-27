import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const reportPath = path.join(root, 'reports/harness-capture-prerequisites.json');
const checks = [
    ['Harness checkout', harnessRoot],
    ['Cordis package alias', path.join(harnessRoot, 'node_modules/@deepseek-ai/cordis')],
    ['Playwright package alias', path.join(harnessRoot, 'node_modules/playwright')],
    ['Playwright pnpm store', path.join(harnessRoot, 'node_modules/.pnpm/playwright@1.61.1')],
    ['Harness web scaffold', path.join(harnessRoot, 'apps/web/tests/scaffold.ts')],
    ['Harness source ModelSelect', path.join(harnessRoot, 'packages/client/ui-model-selection/src/client/ModelSelect.tsx')],
];
const result = checks.map(([name, target]) => ({ name, target, exists: fs.existsSync(target) }));
const missing = result.filter(item => !item.exists).map(item => item.name);
const report = {
    generatedAt: new Date().toISOString(),
    harnessRoot,
    status: missing.length ? 'capture-prerequisites-missing' : 'capture-prerequisites-ready',
    pass: missing.length === 0,
    checks: result,
    missing,
    note: 'Read-only environment check; it does not install or mutate the Harness checkout.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness capture prerequisites: ${report.status}; missing=${missing.length}.`);
