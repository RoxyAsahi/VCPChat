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
const candidateContracts = [
  ['connection-banner', 'reports/vcp-connection-banner-candidate.json', 'connection-banner.dom.json', report => report.connectedHidden?.present === false && report.reconnectingVisible?.present === true && report.labelUpdate?.present === true],
  ['menu', 'reports/vcp-menu-candidate.json', 'menu.dom.json', report => report.open?.present === true && report.outsideClosed === true && report.escapeClosed === true && report.submenuItems?.length > 0],
  ['onboarding-surface', 'reports/vcp-onboarding-surface-candidate.json', 'onboarding-surface.dom.json', report => report.closed?.present === false && report.open?.present === true && report.close?.present === false && report.reopen?.present === true],
  ['pill', 'reports/vcp-pill-candidate.json', 'pill.dom.json', report => report.static?.tag === 'span' && report.interactive?.tag === 'button' && report.active?.tag === 'button' && report.clicks > 0],
  ['tooltip', 'reports/vcp-tooltip-candidate.json', 'tooltip.dom.json', report => report.beforeDelay === 0 && report.hover?.role === 'tooltip' && report.focusImmediate === true && report.flipped?.side === 'top' && report.disabled?.bubbleCount === 0 && report.disposed?.bubbles === 0 && report.reloaded?.bubbles === 0],
  ['hover-card', 'reports/vcp-hover-card-candidate.json', 'hover-card.dom.json', report => report.beforeDelay === 0 && report.open?.role === 'button' && report.graceOpen === true && report.graceClosed === true && report.copied?.status === 'Copied' && report.disabled === true && report.disposed?.cards === 0 && report.reloaded?.cards === 0],
];
const candidateCaptures = candidateContracts.map(([name, file, contractFile, validate]) => {
  const capture = read(file);
  const captured = capture !== null;
  const contract = `docs/reference/deepseek-harness-primitives/${contractFile}`;
  const sourceContractPresent = exists(contract);
  const contractPass = captured && sourceContractPresent && validate(capture);
  return { name, file, contract, captured, sourceContractPresent, contractPass, state: 'vcp-candidate-capture-only', missingEvidence: [
    ...contractPass ? [] : ['VCP Candidate state-matrix/teardown capture'],
    'Harness same-semantic capture', 'computed-style cross-page diff', 'pixel diff', 'VCP production consumer',
  ] };
});
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
  status: pairedSelect.state === 'paired-roi-pass' && candidateCaptures.every(item => item.contractPass) ? 'paired-evidence-scoped' : 'paired-evidence-incomplete',
  pass: false,
  note: 'A scoped evidence inventory, not a production-parity verdict. pass remains false until all authorized paired states and production boundaries are closed.',
  counts: {
    pairedRoiPasses: pairedSelect.state === 'paired-roi-pass' ? 1 : 0,
    vcpCandidateCaptures: candidateCaptures.filter(item => item.captured).length,
    candidateCaptureMissing: candidateCaptures.filter(item => !item.captured).length,
    candidateContractPasses: candidateCaptures.filter(item => item.contractPass).length,
    candidateContractMissing: candidateCaptures.filter(item => !item.contractPass).length,
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
