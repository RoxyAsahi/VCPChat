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
const fixtureOnlyCandidates = fixtureNames.filter(name => !contractSet.has(name));
const report = {
  generatedAt: new Date().toISOString(),
  viewport: matrix.viewport ?? null,
  status: uncoveredContracts.length ? 'coverage-gaps-present' : 'coverage-complete',
  pass: uncoveredContracts.length === 0,
  counts: {
    contracts: contracts.length,
    contractsWithFixtures: contracts.length - uncoveredContracts.length,
    uncoveredContracts: uncoveredContracts.length,
    fixturePrimitives: fixtureNames.length,
    fixtureOnlyCandidates: fixtureOnlyCandidates.length,
  },
  uncoveredContracts,
  fixtureOnlyCandidates,
  note: 'Report-only coverage evidence; a contract does not imply a replayable visual fixture. Candidate and frozen-domain entries remain explicit.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness fixture coverage: ${report.status}; contracts=${report.counts.contractsWithFixtures}/${report.counts.contracts}; fixture-only=${fixtureOnlyCandidates.length}.`);
if (strict && !report.pass) process.exitCode = 1;
