import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const source = path.join(harnessRoot, 'packages/client/ui-deliverables/src/client/ProducedFiles.tsx');
const reportPath = path.join(root, 'reports/harness-produced-files-source.json');
const strict = process.argv.includes('--strict');

const checks = [
  ['fit helper is exported', /export function fitProducedFiles\b/],
  ['visible chip limit is six', /const SHOWN_LIMIT = 6/],
  ['chip fitting accounts for gap and remainder', /const needed = width \+ \(more \?\? 0\) \+ Math\.max\(0, items - 1\) \* gap/],
  ['full path opens through owner capability', /openFile\(path\)/],
  ['folder action is capability-gated', /isLoopback && hostCanOpenPath/],
  ['folder action opens the host directory', /openFile\('\.'\)/],
  ['ResizeObserver tracks the measured row', /const observer = new ResizeObserver\(measure\)/, /observer\.observe\(row\)/],
  ['ResizeObserver disconnects on cleanup', /return \(\) => \{ observer\.disconnect\(\) \}/],
];

const exists = fs.existsSync(source);
const text = exists ? fs.readFileSync(source, 'utf8') : '';
const results = checks.map(([name, ...patterns]) => ({ name, pass: exists && patterns.every(pattern => pattern.test(text)) }));
const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source,
  status: !exists ? 'source-missing' : results.every(item => item.pass) ? 'source-contract-pass' : 'source-contract-gaps',
  pass: exists && results.every(item => item.pass),
  checks: results,
  note: 'Read-only frozen-domain evidence; this does not create a VCP turn-tail consumer or modify chat rendering.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness ProducedFiles source audit: ${report.status} (${results.filter(item => item.pass).length}/${results.length}).`);
if (strict && !report.pass) process.exitCode = 1;
