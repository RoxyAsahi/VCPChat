/** Run the real-Electron Sidebar Account/App Tray fixture as an isolated pair. */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportRoot = path.join(root, 'reports', 'visual-forensics-qa', 'sidebar-account-tray');
await fs.mkdir(reportRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(reportRoot, 'run-'));
const run = theme => new Promise(resolve => { const child = spawn(process.execPath, [path.join(root, 'scripts/visual-qa-next-sidebar-account-tray.mjs')], { cwd: root, env: { ...process.env, VCPCHAT_VISUAL_QA_THEME: theme, VCPCHAT_SIDEBAR_ACCOUNT_TRAY_QA_OUTPUT: path.join(output, theme) }, stdio: 'inherit' }); child.once('close', code => resolve(code ?? 1)); });
let failed = false;
for (const theme of ['light', 'dark']) if (await run(theme) !== 0) failed = true;
const verify = spawn(process.execPath, [path.join(root, 'scripts/check-visual-qa-next-sidebar-account-tray.mjs'), path.join(output, 'light'), path.join(output, 'dark')], { cwd: root, stdio: 'inherit' });
if (await new Promise(resolve => verify.once('close', code => resolve(code ?? 1))) !== 0) failed = true;
console.log(JSON.stringify({ output, themes: ['light', 'dark'], verified: !failed }, null, 2));
process.exitCode = failed ? 2 : 0;
