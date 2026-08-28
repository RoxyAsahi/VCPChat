import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const reportPath = path.join(root, 'reports/harness-paired-evidence-boundaries.json');
const read = file => {
  try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }
  catch { return null; }
};
const exists = file => fs.existsSync(path.join(root, file));
const select = read('reports/harness-vcp-fixture-evidence.json');
const parity = read('reports/harness-parity-evidence.json');
const coverage = read('reports/harness-fixture-coverage.json');
const candidateCaptures = [
  ['connection-banner', 'reports/vcp-connection-banner-candidate.json'],
  ['menu', 'reports/vcp-menu-candidate.json'],
  ['onboarding-surface', 'reports/vcp-onboarding-surface-candidate.json'],
  ['pill', 'reports/vcp-pill-candidate.json'],
  ['tooltip', 'reports/vcp-tooltip-candidate.json'],
  ['hover-card', 'reports/vcp-hover-card-candidate.json'],
].map(([name, file]) => ({ name, file, captured: exists(file), state: 'vcp-candidate-capture-only', missingEvidence: ['Harness same-semantic capture', 'computed-style cross-page diff', 'pixel diff', 'VCP production consumer'] }));
const sourceOrConsumerBoundaries = (parity?.missingEvidence ?? []).map(item => ({ evidence: item, state: /blocked-vcp-consumer/.test(item) ? 'consumer-boundary' : 'source-only-boundary' }));
const pairedSelect = {
  name: 'agent-preset-select-open-selected-hover',
  state: select?.pass === true ? 'paired-roi-pass' : 'paired-roi-pending',
  semanticFixture: 'agent-preset-selection/ready/Standard mode/open-selected-hover-menu',
  domAndGeometry: select?.geometryPass === true,
  pixel: select?.pixelPass === true,
  missingEvidence: ['closed trigger', 'busy trigger', 'VCP production consumer', 'legacy deletion'],
};
const report = {
  generatedAt: new Date().toISOString(),
  status: pairedSelect.state === 'paired-roi-pass' && candidateCaptures.every(item => item.captured) ? 'paired-evidence-scoped' : 'paired-evidence-incomplete',
  pass: false,
  note: 'A scoped evidence inventory, not a production-parity verdict. pass remains false until all authorized paired states and production boundaries are closed.',
  counts: {
    pairedRoiPasses: pairedSelect.state === 'paired-roi-pass' ? 1 : 0,
    vcpCandidateCaptures: candidateCaptures.filter(item => item.captured).length,
    candidateCaptureMissing: candidateCaptures.filter(item => !item.captured).length,
    sourceOrConsumerBoundaries: sourceOrConsumerBoundaries.length,
    fixtureScopeBlocked: coverage?.counts?.scopeBlockedContracts ?? null,
  },
  pairedSelect,
  candidateCaptures,
  sourceOrConsumerBoundaries,
  activeExternalBoundary: {
    name: 'model-picker',
    state: 'do-not-edit-while-shared-capture-and-diff-files-are-active',
    missingEvidence: ['full interaction-state paired capture', 'legacy modal parity/deletion'],
  },
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness paired evidence boundaries: ${report.status}; pairedROI=${report.counts.pairedRoiPasses}; candidateCaptures=${report.counts.vcpCandidateCaptures}; boundaries=${report.counts.sourceOrConsumerBoundaries}.`);
