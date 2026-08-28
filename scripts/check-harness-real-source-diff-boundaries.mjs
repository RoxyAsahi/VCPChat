import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const load = file => {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
  catch { return null; }
};
const specs = [
  { name: 'tooltip', diff: 'reports/harness-vcp-tooltip-source-diff.json', pixel: 'reports/harness-vcp-tooltip-roi-pixel-diff.json' },
  { name: 'hover-card', diff: 'reports/harness-vcp-hover-card-source-diff.json', pixel: 'reports/harness-vcp-hover-card-roi-pixel-diff.json' },
  { name: 'state-dot', diff: 'reports/harness-vcp-state-dot-source-diff.json', pixel: 'reports/harness-vcp-state-dot-roi-pixel-diff.json' },
  { name: 'semantic-icon', diff: 'reports/harness-vcp-semantic-icon-source-diff.json', pixel: 'reports/harness-vcp-semantic-icon-roi-pixel-diff.json' },
];
const entries = specs.map(spec => {
  const report = load(spec.diff);
  const pixel = load(spec.pixel);
  const perState = Array.isArray(pixel?.cases);
  const pixelMeasured = perState || typeof pixel?.comparable === 'boolean';
  const pixelPass = pixelMeasured && pixel?.pass === true;
  return { name: spec.name, file: spec.diff, present: report !== null, semantic: report?.semanticFixture?.pass ?? false, pass: report?.pass ?? false, pixel, pixelMeasured, pixelPass, pixelMode: perState ? 'per-state-strict-roi' : pixelMeasured ? 'strict-roi' : 'not-measured', missingEvidence: report?.missingEvidence ?? ['real-source diff artifact missing'] };
});
const output = { generatedAt: new Date().toISOString(), status: entries.every(entry => entry.present && entry.semantic) ? 'real-source-diff-boundaries-recorded' : 'real-source-diff-boundaries-incomplete', pass: false, note: 'A cross-component evidence inventory. pass stays false: it records observed Harness/VCP source boundaries and never promotes Candidate Lab artifacts to production parity.', counts: { realSourceDiffs: entries.filter(item => item.present).length, semanticFixtureMatches: entries.filter(item => item.semantic).length, parityPasses: entries.filter(item => item.pass).length, pixelMeasured: entries.filter(item => item.pixelMeasured).length, pixelPasses: entries.filter(item => item.pixelPass).length, pendingPixelDiffs: entries.filter(item => !item.pixelMeasured).length }, entries };
fs.writeFileSync(path.join(root, 'reports/harness-real-source-diff-boundaries.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Harness real-source diff boundaries: ${output.status}; diffs=${output.counts.realSourceDiffs}; pixelMeasured=${output.counts.pixelMeasured}; pixelPasses=${output.counts.pixelPasses}.`);
