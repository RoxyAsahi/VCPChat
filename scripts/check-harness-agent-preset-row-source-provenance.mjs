import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-agent-preset-row-source-provenance.json');
const files = {
  row: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/AgentPresetRow.tsx'),
  menu: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/PresetMenu.tsx'),
  style: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/AgentPresetRow.module.css'),
};
const anchors = {
  row: [
    'useAgentPreset(snapshot => snapshot)',
    "state.status === 'unavailable'",
    "state.status === 'loading' || state.status === 'saving'",
    "role={state.error === null ? undefined : 'alert'}",
    'disabled={busy || !state.writable || state.options.length === 0}',
    '<PresetMenu',
    'void select(id)',
  ],
  menu: [
    'onOpenChange',
    'selectedId={selectedId}',
    'align="end"',
    'portal',
    'aria-haspopup="menu"',
    'aria-expanded={open}',
    "option.trust === 'user'",
    "t('userTrust')",
  ],
  style: [
    '.row {',
    'gap: 8px',
    'padding: 16px 0',
    'border-bottom: 1px solid',
    '.selector {',
    'height: 36px',
    'padding: 0 14px',
    'border-radius: 18px',
    'gap: 12px',
  ],
};
const read = file => fs.readFileSync(file, 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const entries = Object.entries(files).map(([name, file]) => {
  const present = fs.existsSync(file);
  const text = present ? read(file) : '';
  const checks = anchors[name].map(anchor => ({ anchor, pass: text.includes(anchor) }));
  return { name, file: path.relative(harnessRoot, file), sha256: present ? sha256(text) : null, checks, pass: present && checks.every(item => item.pass) };
});
const dom = JSON.parse(read(path.join(referenceRoot, 'agent-preset-row.dom.json')));
const geometry = JSON.parse(read(path.join(referenceRoot, 'agent-preset-row.geometry.json')));
const candidate = JSON.parse(read(path.join(root, 'reports/vcp-harness-agent-preset-row-candidate.json')));
const referencePass = dom.sourceKind === 'harness-composite-source-only'
  && dom.provenance?.sources?.length === 3
  && geometry.styleSource === 'packages/client/ui-agent-preset/src/client/AgentPresetRow.module.css';
const candidatePass = candidate.source === 'generated-artifact-electron'
  && candidate.primitive === 'AgentPresetRow'
  && candidate.viewport?.width === 800
  && candidate.viewport?.height === 600
  && candidate.state === 'open-selected-busy-error-picked-closed'
  && candidate.open?.alignEnd === true
  && candidate.open?.portalToBody === true
  && candidate.errorRole === 'alert';
const report = {
  generatedAt: new Date().toISOString(), harnessRoot, sourceKind: dom.sourceKind,
  source: dom.provenance.sources, files: entries,
  reference: { dom: referencePass, geometry: referencePass },
  candidate: { capture: 'reports/vcp-harness-agent-preset-row-candidate.json', present: true, shape: candidatePass, status: dom.candidateStatus },
  contract: dom.harnessContract, pass: false,
  missingEvidence: [
    'real Harness AgentPresetRow browser capture through the source dependency closure',
    'same-semantic Harness/VCP DOM/ARIA and computed-style diff',
    'same-semantic Harness/VCP pixel diff',
    'VCP production consumer (no equivalent non-frozen preset preference capability)',
  ],
  note: 'Source provenance and Candidate shape evidence only. This report is permanently non-promoting; it does not claim Harness/VCP parity or authorize a production consumer.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness AgentPresetRow source provenance: files=${entries.filter(item => item.pass).length}/${entries.length}; pass=false; candidate remains source-only.`);
