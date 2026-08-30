import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const reportsDir = path.join(root, 'reports');
const inventory = JSON.parse(fs.readFileSync(path.join(reportsDir, 'harness-ui-inventory.json'), 'utf8'));
const referenceDir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const sourceOnly = fs.readdirSync(referenceDir)
  .filter(name => name.endsWith('.dom.json'))
  .map(name => JSON.parse(fs.readFileSync(path.join(referenceDir, name), 'utf8')))
  .filter(contract => contract.primitive && /^(source-only|reference-only)/.test(contract.candidateStatus ?? ''))
  .map(contract => ({ name: contract.primitive.replace(/[A-Z]/g, (m, i) => (i ? `-${m.toLowerCase()}` : m.toLowerCase())), candidateStatus: contract.candidateStatus }));
const entries = sourceOnly.map(item => {
  const reportName = `harness-${item.name}-source-provenance.json`;
  const reportPath = path.join(reportsDir, reportName);
  const present = fs.existsSync(reportPath);
  const report = present ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
  return { name: item.name, report: reportName, present, nonPromoting: present && report.pass === false, sourceKind: report?.sourceKind ?? null };
});
const report = {
  generatedAt: new Date().toISOString(),
  inventoryStatus: inventory.status,
  sourceOnlyCount: sourceOnly.length,
  entries,
  pass: inventory.status === 'inventory-scoped-complete'
    && entries.length > 0
    && entries.every(entry => entry.present && entry.nonPromoting),
  note: 'Guard coverage checks evidence registration only; it never promotes Candidate Lab artifacts or claims product parity.',
};
fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(path.join(reportsDir, 'harness-source-only-guard-coverage.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness source-only guard coverage: ${entries.filter(entry => entry.present).length}/${entries.length}; pass=${report.pass}.`);
if (!report.pass) process.exitCode = 1;
