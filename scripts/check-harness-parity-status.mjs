import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const reportsDir = path.join(root, 'reports');
const read = name => JSON.parse(fs.readFileSync(path.join(reportsDir, name), 'utf8'));
const inventory = read('harness-ui-inventory.json');
const coverage = read('harness-fixture-coverage.json');
const candidateGaps = read('harness-candidate-capture-gaps.json');
const guards = [
  ['agent-preset-seat', 'harness-agent-preset-seat-source-provenance.json'],
  ['agent-preset-row', 'harness-agent-preset-row-source-provenance.json'],
  ['disclosure-row', 'harness-disclosure-row-source-provenance.json'],
  ['popup-select', 'harness-popup-select-source-provenance.json'],
  ['language-row', 'harness-language-row-source-provenance.json'],
  ['agent-preset-label', 'harness-agent-preset-label-source-provenance.json'],
  ['agent-preset-section', 'harness-agent-preset-section-source-provenance.json'],
  ['workspace-browser', 'harness-workspace-browser-source-provenance.json'],
  ['settings-root', 'harness-settings-root-source-provenance.json'],
].map(([name, file]) => {
  const present = fs.existsSync(path.join(reportsDir, file));
  return { name, report: file, present, pass: present ? read(file).pass === true : false };
});
const report = {
  generatedAt: new Date().toISOString(),
  status: inventory.status === 'inventory-scoped-complete' && coverage.status === 'coverage-scoped-complete' && candidateGaps.status === 'candidate-capture-gaps-recorded' ? 'parity-scope-accounted' : 'parity-scope-incomplete',
  pass: false,
  inventory: { status: inventory.status, counts: inventory.counts, nextCandidates: inventory.nextCandidates },
  coverage: { status: coverage.status, counts: coverage.counts, uncoveredByBoundary: coverage.uncoveredByBoundary, fixtureOnlyCandidates: coverage.fixtureOnlyCandidates },
  candidateCaptureGaps: { status: candidateGaps.status, counts: candidateGaps.counts, entries: candidateGaps.entries.map(entry => ({ name: entry.name, provenanceGuardPass: entry.provenanceGuardPass, captureGap: entry.captureGap, gaps: entry.gaps })) },
  provenanceGuards: guards,
  openBoundaries: [
    'Candidate Lab evidence is non-promoting without an authorized VCP production consumer',
    'same-semantic Harness/VCP DOM, computed-style, and pixel evidence remains component/state-specific',
    'chat, Composer, Settings main-thread, persistence, Plugin Loader, manifest, and dynamic-wallpaper boundaries remain frozen',
  ],
  note: 'This is a read-only scope ledger. Inventory/coverage completeness and source provenance do not establish product parity, consumer adoption, or authorization to change frozen surfaces.',
};
fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(path.join(reportsDir, 'harness-parity-status.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness parity status: ${report.status}; pass=false; exports=${inventory.counts.exports}; contracts=${coverage.counts.contracts}; captureGaps=${candidateGaps.counts.captureGaps}.`);
