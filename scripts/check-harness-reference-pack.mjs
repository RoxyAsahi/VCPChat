import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const primitives = ['settings-root', 'field', 'select', 'menu', 'modal', 'tooltip', 'hover-card', 'input', 'range', 'toggle', 'color-pair'];
const required = [
  'reference.css',
  'fixture-matrix.json',
  ...primitives.flatMap(name => [`${name}.dom.json`, `${name}.geometry.json`]),
];

const fail = message => { throw new Error(`[harness-reference-pack] ${message}`); };
for (const file of required) {
  const absolute = path.join(dir, file);
  if (!fs.existsSync(absolute)) fail(`missing ${file}`);
}

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
  catch (error) { fail(`invalid JSON ${file}: ${error.message}`); }
};

for (const name of primitives) {
  const dom = readJson(`${name}.dom.json`);
  const geometry = readJson(`${name}.geometry.json`);
  if (!dom || typeof dom !== 'object' || Array.isArray(dom)) fail(`${name}.dom.json must be an object`);
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) fail(`${name}.geometry.json must be an object`);
  if (!Object.keys(dom).length) fail(`${name}.dom.json is empty`);
  if (!Object.keys(geometry).length) fail(`${name}.geometry.json is empty`);
}

const css = fs.readFileSync(path.join(dir, 'reference.css'), 'utf8');
if (!css.includes('--harness-') && !css.includes('.harness-')) {
  fail('reference.css has no Harness token or selector contract');
}

const matrix = readJson('fixture-matrix.json');
if (matrix.viewport?.width !== 800 || matrix.viewport?.height !== 600 || matrix.viewport?.deviceScaleFactor !== 1) {
  fail('fixture-matrix.json must pin 800x600 @1x for cross-page capture');
}
if (!Array.isArray(matrix.cases) || matrix.cases.length < 10) fail('fixture matrix must retain at least the ten original primitive state cases');

console.log(`Harness reference pack passed (${required.length} files; ${primitives.length} primitive contracts).`);
