import fs from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const report = path.join(root, 'reports/vcp-select-production.json');
const image = path.join(root, 'reports/vcp-select-production.png');
if (!(await fs.stat(report).catch(() => null)) || !(await fs.stat(image).catch(() => null))) {
    throw new Error('VCP Select fixture is not captured; run the Electron generated-artifact capture harness');
}
const capture = JSON.parse(await fs.readFile(report, 'utf8'));
if (capture.source !== 'VCP generated artifact Electron fixture' || capture.viewport?.width !== 800 || capture.items?.length < 1) throw new Error('invalid VCP Select fixture provenance');
console.log(`VCP Select fixture available (${capture.items.length} menuitems).`);
