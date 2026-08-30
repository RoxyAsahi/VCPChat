import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const source = path.join(harnessRoot, 'packages/client/ui-primitives/src/DiffBlock.tsx');
const reportPath = path.join(root, 'reports/harness-diff-block-source.json');
const strict = process.argv.includes('--strict');

const checks = [
  ['source exists', () => fs.existsSync(source)],
  ['empty diff returns null', text => /if \(rows\.length === 0\) return null/.test(text)],
  ['default line cap is sixteen', text => /DEFAULT_DIFF_MAX_LINES = 16/.test(text)],
  ['same-file hunks flatten to a gap row', text => /diff\.path !== prevPath/.test(text) && /kind: 'gap'/.test(text)],
  ['distinct paths determine file count', text => /const paths = new Set<string>\(\)/.test(text) && /files: paths\.size/.test(text)],
  ['single trailing newline is not a phantom row', text => /text\.endsWith\('\\n'\) \? text\.slice\(0, -1\)/.test(text)],
  ['copy preserves textual diff signs', text => /`- \$\{row\.text\}`/.test(text) && /`\+ \$\{row\.text\}`/.test(text)],
  ['copy feedback is one second and liveness guarded', text => /if \(copied\) return/.test(text) && /window\.setTimeout\(\(\) => \{ setCopied\(false\) \}, 1000\)/.test(text)],
  ['expand control exposes expanded state and label', text => /aria-expanded=\{expanded\}/.test(text) && /aria-label=\{expanded \?/.test(text)],
  ['root carries diff marker', text => /data-diff=""/.test(text)],
];

const exists = fs.existsSync(source);
const text = exists ? fs.readFileSync(source, 'utf8') : '';
const results = checks.map(([name, check]) => ({ name, pass: check(text) }));
const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  source,
  status: !exists ? 'source-missing' : results.every(item => item.pass) ? 'source-contract-pass' : 'source-contract-gaps',
  pass: exists && results.every(item => item.pass),
  checks: results,
  candidateStatus: 'candidate-source-only',
  evidenceGaps: [
    'same-semantic Harness/VCP browser capture is pending',
    'computed-style and pixel diff are pending',
    'candidate punctuation/footer/copy-feedback details are intentionally not promoted to production',
  ],
  note: 'Read-only frozen-domain evidence; no VCP tool-result or chat consumer is authorized.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness DiffBlock source audit: ${report.status} (${results.filter(item => item.pass).length}/${results.length}).`);
if (strict && !report.pass) process.exitCode = 1;

