import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themes = (process.env.VCPCHAT_VISUAL_QA_THEMES || 'light,dark').split(',').map(value => value.trim()).filter(Boolean);
let failed = false;
for (const theme of themes) {
  const output = path.join(root, 'reports', 'visual-forensics-qa', theme);
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/visual-forensics-qa.mjs')], {
      cwd: root,
      env: { ...process.env, VCPCHAT_VISUAL_QA_THEME: theme, VCPCHAT_VISUAL_QA_OUTPUT: output },
      stdio: 'inherit',
    });
    child.once('close', code => resolve(code || 0));
  });
  if (result !== 0) failed = true;
}
process.exitCode = failed ? 2 : 0;
