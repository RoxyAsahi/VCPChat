import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const capture = JSON.parse(await fs.readFile(path.join(root, 'reports/vcp-select-production.json'), 'utf8'));
if (capture.source !== 'VCP generated artifact Electron fixture' || capture.status !== 'captured' || !capture.dom.includes('vcp-harness-menu-list') || capture.items.length !== 4) throw new Error('VCP Select capture failed provenance contract');
const dir = path.join(root, 'docs/reference/deepseek-harness-primitives/fixtures/vcp'); await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(dir, 'select.production.dom.html'), `${capture.dom}\n`, 'utf8');
await fs.copyFile(path.join(root, 'reports/vcp-select-production.png'), path.join(dir, 'select.production.png'));
console.log(`Promoted VCP Select production fixture (${capture.items.length} menuitems).`);
