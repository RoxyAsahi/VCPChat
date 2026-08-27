import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const source = path.join(harnessRoot, 'packages/client/ui-permission-presets/src/client/PermissionRow.tsx');
const reportPath = path.join(root, 'reports/harness-permission-row-source.json');
const strict = process.argv.includes('--strict');

const checks = [
  ['exported component', /export function PermissionRow\b/],
  ['descriptor load is invoked on mount', /useEffect\(\(\) => \{\s*void load\(\)/],
  ['unavailable state renders null', /if \(state\.status === 'unavailable'\) return null/],
  ['non-writable or unavailable state closes overlays', /if \(state\.writable && state\.status !== 'unavailable'\) return/, /setConfirmingFullAccess\(false\)/],
  ['busy state disables selector', /const busy = state\.status === 'loading' \|\| state\.status === 'saving' \|\| confirmingFullAccess/],
  ['Menu is portal aligned to the end', /portal\s*\n?\s*anchor=/, /align="end"/],
  ['same-value selection is a no-op', /if \(id === state\.currentValue\) return/],
  ['Full access requires confirmation', /if \(id === FULL_ACCESS_PRESET\)/, /setConfirmingFullAccess\(true\)/],
  ['error description exposes alert', /role=\{state\.error === null \? undefined : 'alert'\}/],
  ['confirmation is acknowledged before persistence', /disabled=\{!state\.writable \|\| state\.status === 'saving'\}/, /void select\(FULL_ACCESS_PRESET\)/],
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
  note: 'Read-only source evidence; this does not create a VCP permission-settings consumer or promote Candidate Lab work.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness PermissionRow source audit: ${report.status} (${results.filter(item => item.pass).length}/${results.length}).`);
if (strict && !report.pass) process.exitCode = 1;
