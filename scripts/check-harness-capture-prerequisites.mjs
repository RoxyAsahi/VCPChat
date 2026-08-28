import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const reportPath = path.join(root, 'reports/harness-capture-prerequisites.json');
const webPackage = path.join(harnessRoot, 'apps/web/package.json');
const resolveFromWeb = packageName => {
    try {
        return createRequire(webPackage).resolve(packageName);
    } catch {
        return null;
    }
};
const checks = [
    ['Harness checkout', harnessRoot],
    ['Harness web package', webPackage],
    ['Harness workspace Cordis source', path.join(harnessRoot, 'vendor/cordis/package.json')],
    ['Harness Vitest runner', path.join(harnessRoot, 'node_modules/.bin/vitest')],
    ['Harness web scaffold', path.join(harnessRoot, 'apps/web/tests/scaffold.ts')],
    ['Harness source ModelSelect', path.join(harnessRoot, 'packages/client/ui-model-selection/src/client/ModelSelect.tsx')],
];
const result = checks.map(([name, target]) => ({ name, target, exists: fs.existsSync(target) }));
const playwright = resolveFromWeb('playwright');
result.push({
    name: 'Playwright resolver from Harness web',
    target: playwright || path.join(harnessRoot, 'apps/web/node_modules/playwright'),
    exists: playwright !== null,
});
const missing = result.filter(item => !item.exists).map(item => item.name);
const report = {
    generatedAt: new Date().toISOString(),
    harnessRoot,
    status: missing.length ? 'capture-prerequisites-missing' : 'capture-prerequisites-ready',
    pass: missing.length === 0,
    checks: result,
    missing,
    note: 'Read-only check of the same pnpm/Vitest workspace topology used by Harness capture; it does not install or mutate the Harness checkout.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness capture prerequisites: ${report.status}; missing=${missing.length}.`);
