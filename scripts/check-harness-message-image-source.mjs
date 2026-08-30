import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const source = path.join(harnessRoot, 'packages/client/ui-attachment/src/MessageImage.tsx');
const reportPath = path.join(root, 'reports/harness-message-image-source.json');
const strict = process.argv.includes('--strict');

const checks = [
  ['MessageImage and ImageGallery are exported', /export function MessageImage\b/, /export function ImageGallery\b/],
  ['single-image fit clamps aspect ratio', /Math\.min\(4, Math\.max\(0\.25, natural\)\)/],
  ['load effect has liveness guard', /let live = true/, /return \(\) => \{ live = false \}/],
  ['late successful resolution is ignored', /if \(live\) setSrc\(url\)/],
  ['late failed resolution is ignored', /if \(live\) setError\(true\)/],
  ['retry re-arms the load effect', /setAttempt\(a => a \+ 1\)/, /\[attachment, load, attempt\]/],
  ['preview opens only after source resolves', /if \(src !== null\) setOpen\(true\)/],
  ['lightbox mounts only while open and loaded', /open && src !== null && <ImageLightbox/],
  ['empty galleries render null', /if \(images\.length === 0\) return null/],
  ['gallery selects single versus tile variant', /images\.length === 1 \? 'single' : 'tile'/],
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
  note: 'Read-only frozen-domain evidence; this does not create a VCP chat attachment consumer or modify chat rendering.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness MessageImage source audit: ${report.status} (${results.filter(item => item.pass).length}/${results.length}).`);
if (strict && !report.pass) process.exitCode = 1;
