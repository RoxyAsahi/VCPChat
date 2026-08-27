import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const source = path.join(harnessRoot, 'packages/client/ui-jobs/src/client/JobListAction.tsx');
const reportPath = path.join(root, 'reports/harness-job-list-action-source.json');
const strict = process.argv.includes('--strict');

const checks = [
  ['exported component', /export function JobListAction\b/],
  ['empty state retracts the control', /if \(jobs\.length === 0\) return null/],
  ['live statuses are explicit', /job\.status === 'running' \|\| job\.status === 'stopping'/],
  ['live rows sort before settled rows', /if \(liveLeft !== isLive\(right\)\) return liveLeft \? -1 : 1/],
  ['settled rows sort newest-first', /const finished = \(right\.finishedAt \?\? right\.startedAt\) - \(left\.finishedAt \?\? left\.startedAt\)/],
  ['outside dismissal listener is installed', /document\.addEventListener\('pointerdown', closeOutside\)/],
  ['outside dismissal listener is removed', /document\.removeEventListener\('pointerdown', closeOutside\)/],
  ['clock is interval-driven', /const timer = setInterval\(\(\) => \{ setNow\(Date\.now\(\)\) \}, 1_000\)/],
  ['clock interval is cleaned up', /return \(\) => \{ clearInterval\(timer\) \}/],
  ['Escape restores trigger focus', /event\.key !== 'Escape'|triggerRef\.current\?\.focus\(\)/],
];

const exists = fs.existsSync(source);
const text = exists ? fs.readFileSync(source, 'utf8') : '';
const results = checks.map(([name, pattern]) => ({ name, pass: exists && pattern.test(text) }));
const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source,
  status: !exists ? 'source-missing' : results.every(item => item.pass) ? 'source-contract-pass' : 'source-contract-gaps',
  pass: exists && results.every(item => item.pass),
  checks: results,
  note: 'Read-only source evidence; this does not create a VCP jobs consumer or promote Candidate Lab work.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness JobListAction source audit: ${report.status} (${results.filter(item => item.pass).length}/${results.length}).`);
if (strict && !report.pass) process.exitCode = 1;
