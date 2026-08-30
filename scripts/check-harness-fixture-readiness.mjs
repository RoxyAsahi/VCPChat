import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harness = '/Users/asahi/Documents/Codex/deepseek-harness';
const required = [
  path.join(harness, 'apps/web/dist/index.html'),
  path.join(harness, 'packages/client/ui-primitives/src/Input.tsx'),
  path.join(harness, 'packages/client/ui-primitives/src/Menu.tsx'),
  path.join(harness, 'packages/client/ui-primitives/src/Input.module.css'),
  path.join(harness, 'packages/client/ui-primitives/src/Menu.module.css'),
  path.join(root, 'modules/uiux/generated/browser-entry.js'),
];
const missing = required.filter(file => !fs.existsSync(file));
if (missing.length) throw new Error(`[harness-fixture-readiness] missing: ${missing.join(', ')}`);
console.log('Harness fixture readiness passed (production web artifact + Input/Menu sources + VCP generated entry present).');
