import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-settings-root-source-provenance.json');
const files = {
  component: path.join(harnessRoot, 'packages/client/ui-settings-general/src/client/SettingsRoot.tsx'),
  style: path.join(harnessRoot, 'packages/client/ui-settings-general/src/client/SettingsRoot.module.css'),
};
const anchors = {
  component: [
    'aria-haspopup="dialog"', 'aria-expanded={open}', 'role="presentation"',
    'role="dialog"', 'aria-modal="true"', 'aria-labelledby={titleId}',
    "e.key === 'Escape'", 'document.addEventListener', 'renderSlot(\'settings.section\'',
    'setActiveId(undefined)', 'onClick={onClose}',
  ],
  style: [
    '.trigger {', '.trigger.rail {', '.overlay {', '.mask {', '.panel {',
    'width: 800px', 'height: min(800px, calc(100vh - 48px))', '.nav {',
    '.navCell {', '.header {', '.options {', '.close {',
  ],
};
const read = file => fs.readFileSync(file, 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const entries = Object.entries(files).map(([name, file]) => {
  const present = fs.existsSync(file); const source = present ? read(file) : '';
  const checks = anchors[name].map(anchor => ({ anchor, pass: source.includes(anchor) }));
  return { name, file: path.relative(harnessRoot, file), sha256: present ? sha256(source) : null, checks, pass: present && checks.every(item => item.pass) };
});
const dom = JSON.parse(read(path.join(referenceRoot, 'settings-root.dom.json')));
const geometry = JSON.parse(read(path.join(referenceRoot, 'settings-root.geometry.json')));
const report = {
  generatedAt: new Date().toISOString(), harnessRoot, sourceKind: dom.sourceKind, source: dom.provenance.sources, files: entries,
  reference: { dom: dom.sourceKind === 'harness-composite-source-only' && dom.provenance.sources.length === 2, geometry: path.normalize(geometry.source).endsWith(path.normalize('packages/client/ui-settings-general/src/client/SettingsRoot.module.css')) },
  candidate: { present: false, status: 'source-only; Settings production consumer and bridge are frozen' },
  contract: dom.contract,
  pass: false,
  missingEvidence: [
    'VCP Candidate implementation/capture (Settings bridge/presentation owner are actively owned elsewhere)',
    'same-semantic Harness/VCP DOM/ARIA and computed-style diff',
    'same-semantic Harness/VCP pixel diff across open/close/nav/focus states',
    'reload/close-flush and teardown stress evidence for the production Settings surface',
  ],
  note: 'Reference-only provenance evidence. This guard does not alter Settings production code or authorize a VCP consumer.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness SettingsRoot source provenance: files=${entries.filter(item => item.pass).length}/${entries.length}; pass=false; reference remains source-only.`);
