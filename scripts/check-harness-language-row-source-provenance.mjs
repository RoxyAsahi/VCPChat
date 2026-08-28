import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-language-row-source-provenance.json');
const files = {
  component: path.join(harnessRoot, 'packages/client/locale/src/client/LanguageRow.tsx'),
  style: path.join(harnessRoot, 'packages/client/locale/src/client/LanguageRow.module.css'),
  menu: path.join(harnessRoot, 'packages/client/ui-primitives/src/Menu.tsx'),
};
const anchors = {
  component: ['useStore(s => s.active)', 'useStore(s => s.options)', 'setLocale(id)', 'aria-haspopup="menu"', 'aria-expanded={open}', 'align="end"', 'portal'],
  style: ['.row {', 'gap: 8px', 'padding: 16px 0', '.selector {', 'height: 36px', 'padding: 0 14px', 'border-radius: 18px', 'gap: 12px'],
  menu: ['role="menu"', 'role="menuitem"', 'createPortal', 'onClose', 'selectedId'],
};
const read = file => fs.readFileSync(file, 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const entries = Object.entries(files).map(([name, file]) => {
  const present = fs.existsSync(file); const text = present ? read(file) : '';
  const checks = anchors[name].map(anchor => ({ anchor, pass: text.includes(anchor) }));
  return { name, file: path.relative(harnessRoot, file), sha256: present ? sha256(text) : null, checks, pass: present && checks.every(item => item.pass) };
});
const dom = JSON.parse(read(path.join(referenceRoot, 'language-row.dom.json')));
const geometry = JSON.parse(read(path.join(referenceRoot, 'language-row.geometry.json')));
const candidatePath = path.join(root, 'modules/uiux/primitives/language-row.ts');
const candidate = fs.existsSync(candidatePath) ? read(candidatePath) : '';
const candidateAnchors = ['mountLanguageRow', 'align: \'end\'', 'portal: true', 'setOptions', 'setLoading', 'harness-language-row-menu', 'optionsGeneration'];
const candidateChecks = candidateAnchors.map(anchor => ({ anchor, pass: candidate.includes(anchor) }));
const candidatePass = candidateChecks.every(item => item.pass);
const report = {
  generatedAt: new Date().toISOString(), harnessRoot, sourceKind: dom.sourceKind, source: dom.provenance.sources, files: entries,
  reference: { dom: dom.sourceKind === 'harness-production-consumer-contract' && dom.provenance.sources.length === 3, geometry: path.normalize(geometry.source).endsWith(path.normalize('packages/client/locale/src/client/LanguageRow.module.css')) },
  candidate: { source: 'modules/uiux/primitives/language-row.ts', present: fs.existsSync(candidatePath), anchors: candidateChecks, shape: candidatePass, status: dom.candidateStatus },
  contract: dom.harnessContract, pass: false,
  missingEvidence: ['real Harness LanguageRow browser capture', 'same-semantic Harness/VCP DOM/ARIA and computed-style diff', 'same-semantic Harness/VCP pixel diff', 'VCP locale capability and persisted UI-language key (not in scope)'],
  note: 'Source provenance and Candidate implementation evidence only. VCP has no locale capability or persisted UI-language key; this report is permanently non-promoting and does not authorize a Settings consumer.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness LanguageRow source provenance: files=${entries.filter(item => item.pass).length}/${entries.length}; candidate=${candidatePass}; pass=false; candidate remains source-only.`);
