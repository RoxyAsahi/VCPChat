import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const harness = read('reports/harness-state-dot-source.json');
const vcp = read('reports/vcp-state-dot-candidate.json');
const pixelPath = path.join(root, 'reports/harness-vcp-state-dot-roi-pixel-diff.json');
const pixelResult = fs.existsSync(pixelPath) ? read('reports/harness-vcp-state-dot-roi-pixel-diff.json') : null;
const names = ['done', 'warning', 'ongoing', 'error'];
const states = names.map(name => { const source = harness.states[name], candidate = vcp.states[name]; return { name, tag: source.tag === candidate.tag, aria: source.ariaHidden === candidate.ariaHidden, size: source.rect.width === candidate.rect.width && source.rect.height === candidate.rect.height, color: source.style.color === candidate.style.color, cells: source.cells === candidate.cells, delays: JSON.stringify(source.delays) === JSON.stringify(candidate.delays), display: source.style.display === candidate.style.display }; });
const pixel = pixelResult ? { status: 'strict-per-state-roi-measured', comparableCases: pixelResult.cases.filter(item => item.comparable).length, exactCases: pixelResult.cases.filter(item => item.exactPixelPass).length, pass: pixelResult.pass, cases: pixelResult.cases } : { status: 'pending-roi-diff' };
const report = { generatedAt: new Date().toISOString(), comparison: 'same Chromium engine, real Harness StateDot.tsx source fixture versus VCP Candidate fixture', semanticFixture: { pass: harness.semanticFixture === vcp.semanticFixture }, states, domAriaPass: states.every(item => item.tag && item.aria && item.size && item.cells && item.delays), colorPass: states.every(item => item.color), computedStylePass: states.every(item => item.display), pixel, pass: false, missingEvidence: ['display differs: Harness source fixture block versus VCP Candidate inline-block', 'source resize/dispose capture', 'VCP production consumer'] };
fs.writeFileSync(path.join(root, 'reports/harness-vcp-state-dot-source-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP StateDot source diff: domAria=${report.domAriaPass}; colors=${report.colorPass}; computedStyle=${report.computedStylePass}; pixel=${report.pixel.status}.`);
