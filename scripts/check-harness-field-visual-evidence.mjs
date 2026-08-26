import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const geometry = read('reports/harness-vcp-field-geometry-diff.json');
const pixels = read('reports/harness-vcp-field-pixel-diff.json');
const expectedStates = ['description', 'error'];
const errors = [];

if (geometry.status !== 'cross-page-field-geometry-equivalent' || geometry.pass !== true) errors.push('Field geometry/computed-style evidence is not equivalent');
if (pixels.status !== 'cross-page-field-pixel-equivalent' || pixels.pass !== true) errors.push('Field pixel evidence is not equivalent');
for (const state of expectedStates) {
    const geometryCase = geometry.cases?.find(item => item.state === state);
    const pixelCase = pixels.cases?.find(item => item.state === state);
    if (!geometryCase?.semanticFixture?.same || geometryCase.pass !== true) errors.push(`Field ${state} lacks a same-semantic passing geometry case`);
    if (!pixelCase?.comparable || pixelCase.pass !== true) errors.push(`Field ${state} lacks a comparable passing pixel case`);
}
if (errors.length) throw new Error(`[harness-field-visual-evidence] ${errors.join('; ')}`);
console.log('Harness/VCP Field visual evidence passed (description and error production fixtures).');
