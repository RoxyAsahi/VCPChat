import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const referenceDir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-fixture-coverage.json');
const strict = process.argv.includes('--strict');
const matrix = JSON.parse(fs.readFileSync(path.join(referenceDir, 'fixture-matrix.json'), 'utf8'));
const contracts = fs.readdirSync(referenceDir)
  .filter(file => file.endsWith('.dom.json'))
  .map(file => file.replace(/\.dom\.json$/, ''))
  .sort();
const fixtureNames = [...new Set((matrix.cases ?? []).map(item => Array.isArray(item) ? item[0] : null).filter(Boolean))].sort();
const contractSet = new Set(contracts);
const fixtureSet = new Set(fixtureNames);
const uncoveredContracts = contracts.filter(name => !fixtureSet.has(name));
const fixtureAliases = {
  'model-picker': 'agent-model-picker',
  'preset-menu': 'agent-preset-row',
};
const contractMetadata = name => JSON.parse(fs.readFileSync(path.join(referenceDir, `${name}.dom.json`), 'utf8'));
const classifyUncovered = name => {
  const contract = contractMetadata(name);
  const candidateStatus = String(contract.candidateStatus ?? '');
  const alias = fixtureAliases[name];
  if (alias && fixtureSet.has(alias)) return { name, category: 'covered-by-semantic-fixture-alias', fixture: alias, candidateStatus };
  if (contract.sourceKind === 'vcp-local-contract') return { name, category: 'vcp-local-contract', candidateStatus };
  if (/^(source-only|reference-only)/.test(candidateStatus)) return { name, category: 'source-only-boundary', candidateStatus };
  return { name, category: 'candidate-fixture-pending', candidateStatus };
};
const uncoveredByBoundary = uncoveredContracts.map(classifyUncovered);
const candidateFixtureGaps = uncoveredByBoundary.filter(item => item.category === 'candidate-fixture-pending').map(item => item.name);
const aliasCovered = uncoveredByBoundary.filter(item => item.category === 'covered-by-semantic-fixture-alias');
const scopeBlocked = uncoveredByBoundary.filter(item => ['vcp-local-contract', 'source-only-boundary'].includes(item.category));
const fixtureOnlyCandidates = fixtureNames.filter(name => !contractSet.has(name));
const report = {
  generatedAt: new Date().toISOString(),
  viewport: matrix.viewport ?? null,
  status: candidateFixtureGaps.length ? 'coverage-gaps-present' : scopeBlocked.length ? 'coverage-scoped-complete' : 'coverage-complete',
  pass: uncoveredContracts.length === 0,
  counts: {
    contracts: contracts.length,
    contractsWithFixtures: contracts.length - uncoveredContracts.length,
    uncoveredContracts: uncoveredContracts.length,
    effectiveContractsWithFixtures: contracts.length - uncoveredContracts.length + aliasCovered.length,
    candidateFixtureGaps: candidateFixtureGaps.length,
    scopeBlockedContracts: scopeBlocked.length,
    fixturePrimitives: fixtureNames.length,
    fixtureOnlyCandidates: fixtureOnlyCandidates.length,
  },
  uncoveredContracts,
  uncoveredByBoundary,
  candidateFixtureGaps,
  fixtureOnlyCandidates,
  note: 'Literal fixture coverage remains separate from explicit semantic aliases, VCP-local contracts, and source-only boundaries. Candidate fixture gaps remain actionable; no category implies production parity.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness fixture coverage: ${report.status}; literal=${report.counts.contractsWithFixtures}/${report.counts.contracts}; effective=${report.counts.effectiveContractsWithFixtures}/${report.counts.contracts}; candidateGaps=${candidateFixtureGaps.length}; fixture-only=${fixtureOnlyCandidates.length}.`);
if (strict && !report.pass) process.exitCode = 1;
