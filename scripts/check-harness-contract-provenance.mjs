import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const referenceDir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const reportPath = path.join(root, 'reports/harness-contract-provenance.json');
const strict = process.argv.includes('--strict');

const resolve = value => {
  if (typeof value !== 'string' || value.length === 0) return null;
  return path.isAbsolute(value) ? value : path.join(harnessRoot, value);
};
const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];
const domFiles = fs.existsSync(referenceDir)
  ? fs.readdirSync(referenceDir).filter(file => file.endsWith('.dom.json')).sort()
  : [];
const entries = [];
const gaps = [];
for (const domFile of domFiles) {
  const name = domFile.replace(/\.dom\.json$/, '');
  const dom = JSON.parse(fs.readFileSync(path.join(referenceDir, domFile), 'utf8'));
  const geometryFile = `${name}.geometry.json`;
  const geometry = JSON.parse(fs.readFileSync(path.join(referenceDir, geometryFile), 'utf8'));
  const sourceKind = typeof dom.sourceKind === 'string' && dom.sourceKind.length > 0 ? dom.sourceKind : null;
  const sources = asArray(dom.provenance?.sources ?? dom.source);
  const styles = asArray(dom.styleSource ?? dom.provenance?.style ?? geometry.styleSource);
  const sourceChecks = [...sources.map(value => ({ kind: 'source', declared: value })), ...styles.map(value => ({ kind: 'style', declared: value }))].map(item => {
    // A VCP-local contract is intentionally not a Harness provenance claim.
    // Its human-readable source names the local semantic boundary, so resolving
    // it below the Harness root would fabricate a missing Harness file.
    if (sourceKind === 'vcp-local-contract' && item.kind === 'source') {
      return { ...item, kind: 'local-contract', resolved: null, exists: typeof item.declared === 'string' && item.declared.length > 0, evidence: 'declared-vcp-local-boundary' };
    }
    const resolved = resolve(item.declared);
    const exists = resolved !== null && fs.existsSync(resolved);
    if (!exists) gaps.push(`${name}: missing ${item.kind} ${item.declared}`);
    return { ...item, resolved, exists };
  });
  const candidateStatus = geometry.candidateStatus ?? dom.candidateStatus ?? null;
  const selectors = geometry.selectors && typeof geometry.selectors === 'object' ? Object.keys(geometry.selectors) : [];
  const tokens = Array.isArray(geometry.tokens) ? geometry.tokens : [];
  if (candidateStatus === null) gaps.push(`${name}: missing candidateStatus boundary`);
  if (tokens.length === 0) gaps.push(`${name}: missing geometry tokens`);
  if (sourceKind === 'vcp-local-contract' && (typeof dom.provenanceNote !== 'string' || dom.provenanceNote.length === 0)) gaps.push(`${name}: missing vcp-local provenanceNote`);
  entries.push({ name, domFile, geometryFile, sourceKind, candidateStatus, selectors: selectors.length, tokens: tokens.length, provenance: sourceChecks, pass: sourceChecks.length > 0 && sourceChecks.every(item => item.exists) && candidateStatus !== null && tokens.length > 0 });
}
const sourceKinds = entries.reduce((counts, entry) => {
  const key = entry.sourceKind ?? 'undeclared';
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  referenceDir,
  status: gaps.length === 0 ? 'provenance-complete' : 'provenance-gaps-present',
  pass: gaps.length === 0,
  counts: { contracts: entries.length, provenanceRecords: entries.reduce((sum, item) => sum + item.provenance.length, 0), complete: entries.filter(item => item.pass).length, gaps: gaps.length, sourceKindDeclared: entries.filter(item => item.sourceKind !== null).length, sourceKinds },
  entries,
  gaps,
  note: 'Read-only reference provenance gate; it does not create or authorize any VCP Settings/Chat consumer.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness contract provenance: ${report.status} (${report.counts.complete}/${report.counts.contracts}; gaps=${gaps.length}).`);
if (strict && !report.pass) process.exitCode = 1;
