import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const file = path.join(root, 'docs/reference/deepseek-harness-primitives/fixture-matrix.json');
const matrix = JSON.parse(fs.readFileSync(file, 'utf8'));
const fail = message => { throw new Error(`[harness-fixture-matrix] ${message}`); };
if (matrix.viewport?.width !== 800 || matrix.viewport?.height !== 600 || matrix.viewport?.deviceScaleFactor !== 1) fail('viewport must remain 800x600 @1x');
if (matrix.font !== 'system-ui') fail('font baseline must remain system-ui');
if (!Array.isArray(matrix.cases) || matrix.cases.length !== 10) fail('expected exactly 10 primitive state cases');
for (const [primitive, state] of matrix.cases) if (!['input', 'field', 'select'].includes(primitive) || typeof state !== 'string') fail(`invalid case ${primitive}/${state}`);
for (const output of ['dom', 'geometry', 'computed-style', 'screenshot', 'pixel-diff']) if (!matrix.outputs.includes(output)) fail(`missing output layer ${output}`);
console.log(`Harness fixture matrix passed (${matrix.cases.length} cases; ${matrix.outputs.length} output layers; status=${matrix.status}).`);
