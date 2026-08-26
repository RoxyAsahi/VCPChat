import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const refDir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const sourceDir = path.join(root, 'modules/uiux/primitives');
const fail = message => { throw new Error(`[harness-contracts] ${message}`); };
const read = file => fs.readFileSync(path.join(sourceDir, file), 'utf8');
const json = file => JSON.parse(fs.readFileSync(path.join(refDir, file), 'utf8'));

const inputDom = json('input.dom.json');
const inputSource = read('input.ts');
for (const className of ['wrap', 'icon', 'input']) {
  const present = JSON.stringify(inputDom).includes(`"class": "${className}"`);
  if (present && !inputSource.includes(`'${className}'`) && !inputSource.includes(`"${className}"`)) fail(`Input source missing ${className} contract`);
}
for (const token of ['--dsw-alias-border-l2', '--dsw-alias-bg-layer-1', '--dsw-alias-label-primary']) {
  if (!inputSource.includes(token)) fail(`Input source missing token ${token}`);
}

const selectDom = json('select.dom.json');
const selectSource = read('select.ts');
for (const role of ['menu', 'menuitem']) {
  if (JSON.stringify(selectDom).includes(`"role": "${role}"`) && !selectSource.includes(`'${role}'`)) fail(`Select source missing role ${role}`);
}
for (const marker of ['vcp-uiux', 'menu-list', 'aria-expanded']) {
  if (!selectSource.includes(marker)) fail(`Select source missing structural marker ${marker}`);
}

console.log('Harness primitive source contracts passed (Input + Select structural/token checks).');
