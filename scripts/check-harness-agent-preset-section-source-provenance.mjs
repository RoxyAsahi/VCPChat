import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-agent-preset-section-source-provenance.json');
const files = {
  component: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/AgentPresetSection.tsx'),
  style: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/AgentPresetSection.module.css'),
};
const anchors = {
  component: [
    "state.status === 'unavailable'",
    "state.status === 'error'",
    "state.rows.some(row => row.id === 'cordis')",
    "row.broken !== undefined",
    'aria-pressed={row.isDefault}',
    'role="alert"',
    '<CopyDialog',
    '<Tooltip',
    'pendingDelete !== null',
    'void props.remove()',
  ],
  style: [
    '.section {', 'max-width: 720px', 'gap: 12px', '.group {', '.cards {',
    'grid-template-columns: repeat(auto-fill, minmax(268px, 1fr))',
    '.cardBroken {', '.cardActive {', '.cardMain {', '.cardFoot {',
    '.viewerCode {', '.deleteDialog {', '.creatorButton {',
  ],
};
const read = file => fs.readFileSync(file, 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const entries = Object.entries(files).map(([name, file]) => {
  const present = fs.existsSync(file);
  const source = present ? read(file) : '';
  const checks = anchors[name].map(anchor => ({ anchor, pass: source.includes(anchor) }));
  return { name, file: path.relative(harnessRoot, file), sha256: present ? sha256(source) : null, checks, pass: present && checks.every(item => item.pass) };
});
const dom = JSON.parse(read(path.join(referenceRoot, 'agent-preset-section.dom.json')));
const geometry = JSON.parse(read(path.join(referenceRoot, 'agent-preset-section.geometry.json')));
const report = {
  generatedAt: new Date().toISOString(), harnessRoot, sourceKind: dom.sourceKind, source: dom.provenance.sources, files: entries,
  reference: {
    dom: dom.sourceKind === 'harness-composite-source-only' && dom.provenance.sources.length === 2,
    geometry: path.normalize(geometry.source).endsWith(path.normalize('packages/client/ui-agent-preset/src/client/AgentPresetSection.module.css')),
  },
  candidate: { present: false, status: 'reference-only; no VCP production consumer or paired visual capture' },
  contract: { root: dom.root, groups: dom.groups, card: dom.card, overlays: dom.overlays, aria: dom.aria, states: dom.states },
  pass: false,
  missingEvidence: [
    'VCP Candidate implementation/capture (Settings preset persistence consumer is out of scope)',
    'same-semantic Harness/VCP DOM/ARIA and computed-style diff',
    'same-semantic Harness/VCP pixel diff',
    'authorized VCP production consumer; Settings persistence and chat/session boundaries remain frozen',
  ],
  note: 'Reference-only provenance evidence. No Candidate implementation is synthesized; this report is permanently non-promoting.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness AgentPresetSection source provenance: files=${entries.filter(item => item.pass).length}/${entries.length}; pass=false; reference remains source-only.`);
