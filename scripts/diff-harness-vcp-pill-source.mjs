import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const harness = read('reports/harness-pill-source.json');
const vcp = read('reports/vcp-pill-candidate.json');
const names = ['static', 'interactive', 'active'];
const structuralFields = ['tag', 'type'];
const styleFields = ['display', 'alignItems', 'gap', 'height', 'padding', 'borderRadius', 'fontSize', 'lineHeight', 'cursor', 'backgroundColor'];
const states = names.map(name => {
  const source = harness.states[name], candidate = vcp[name];
  const structural = structuralFields.map(field => ({ field, harness: source?.[field], vcp: candidate?.[field], pass: source?.[field] === candidate?.[field] }));
  const computedStyle = styleFields.map(field => ({ field, harness: source?.style?.[field], vcp: candidate?.style?.[field], pass: source?.style?.[field] === candidate?.style?.[field] }));
  return { name, structural, computedStyle, structuralPass: structural.every(item => item.pass), computedStylePass: computedStyle.every(item => item.pass) };
});
const interaction = {
  hover: { harness: harness.hover, vcp: vcp.hover?.interactive?.style?.backgroundColor, pass: harness.hover === vcp.hover?.interactive?.style?.backgroundColor },
  clicks: { harness: harness.clicks, vcp: vcp.clicks, pass: harness.clicks === vcp.clicks },
  unmountOrDispose: { harness: harness.unmounted?.rootEmpty, vcp: vcp.disposed?.restored, pass: harness.unmounted?.rootEmpty === true && vcp.disposed?.restored === true },
};
const pixelPath = path.join(root, 'reports/harness-vcp-pill-roi-pixel-diff.json');
const pixelResult = fs.existsSync(pixelPath) ? read('reports/harness-vcp-pill-roi-pixel-diff.json') : null;
const report = { generatedAt: new Date().toISOString(), comparison: 'same Chromium engine, real Harness Pill.tsx source fixture versus VCP Candidate fixture', semanticFixture: { pass: harness.semanticFixture === vcp.semanticFixture }, states, structuralPass: states.every(state => state.structuralPass), computedStylePass: states.every(state => state.computedStylePass), interaction, pixel: pixelResult ? { status: 'strict-fixture-measured', comparable: pixelResult.comparable, exactPixelPass: pixelResult.exactPixelPass, differentPixels: pixelResult.differentPixels, pixelRatio: pixelResult.pixelRatio, pass: pixelResult.pass } : { status: 'pending-strict-fixture-capture' }, pass: false, missingEvidence: ['VCP production consumer'] };
fs.writeFileSync(path.join(root, 'reports/harness-vcp-pill-source-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Pill source diff: structural=${report.structuralPass}; computedStyle=${report.computedStylePass}; interaction=${Object.values(interaction).every(item => item.pass)}.`);
