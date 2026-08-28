/**
 * Runs the full real-Electron visual-forensics matrix into an exclusive report
 * directory.  Shared light/dark report locations are useful for browsing, but
 * cannot prove a paired run while concurrent QA work is active.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportRoot = path.join(root, 'reports', 'visual-forensics-qa');
await fs.mkdir(reportRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(reportRoot, 'run-'));

const run = (script, args = [], env = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  child.once('close', code => resolve(code ?? 1));
});

let failed = false;
for (const theme of ['light', 'dark']) {
  const code = await run('visual-forensics-qa.mjs', [], {
    VCPCHAT_VISUAL_QA_THEME: theme,
    VCPCHAT_VISUAL_QA_OUTPUT: path.join(output, theme),
  });
  if (code !== 0) failed = true;
}
const themeDirs = ['light', 'dark'].map(theme => path.join(output, theme));
for (const verifier of ['check-visual-forensics-evidence.mjs', 'check-visual-forensics-baseline.mjs']) {
  const code = await run(verifier, themeDirs);
  if (code !== 0) failed = true;
}
console.log(JSON.stringify({ output, themes: ['light', 'dark'], verified: !failed }, null, 2));
process.exitCode = failed ? 2 : 0;
