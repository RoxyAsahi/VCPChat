import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-agent-preset-seat-source-provenance.json');
const files = {
  seat: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/AgentPresetSeat.tsx'),
  menu: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/PresetMenu.tsx'),
  style: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/AgentPresetSeat.module.css'),
};
const anchors = {
  seat: ['useAgentPresetSeat(snapshot => snapshot)', '<Menu', 'align="start"', 'portal', 'aria-haspopup="menu"', 'aria-expanded={open}', 'disabled={state.busy}', 'css.itemName', 'css.itemDesc', 'onSelect={(id) => {', 'setOpen(false)', 'void select(id)'],
  menu: ['portal', 'align="end"', 'selectedId={selectedId}', 'aria-haspopup="menu"', 'aria-expanded={open}'],
  style: ['.seat {', 'min-height: 28px', 'padding: 0 8px', 'border-radius: 16px', '.itemName {', '.itemDesc {'],
};
const read = file => fs.readFileSync(file, 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const entries = Object.entries(files).map(([name, file]) => {
  const present = fs.existsSync(file);
  const text = present ? read(file) : '';
  const checks = anchors[name].map(anchor => ({ anchor, pass: text.includes(anchor) }));
  return { name, file: path.relative(harnessRoot, file), sha256: present ? sha256(text) : null, checks, pass: present && checks.every(item => item.pass) };
});
const dom = JSON.parse(read(path.join(referenceRoot, 'agent-preset-seat.dom.json')));
const geometry = JSON.parse(read(path.join(referenceRoot, 'agent-preset-seat.geometry.json')));
const candidate = JSON.parse(read(path.join(root, 'reports/vcp-harness-agent-preset-seat-candidate.json')));
const referencePass = dom.sourceKind === 'harness-composite-source-only' && dom.provenance?.sources?.length === 3 && geometry.styleSource === 'packages/client/ui-agent-preset/src/client/AgentPresetSeat.module.css';
const candidatePass = candidate.source === 'generated-artifact-electron' && candidate.viewport?.width === 800 && candidate.viewport?.height === 600 && candidate.state === 'open-selected-busy-error-closed';
const report = {
  generatedAt: new Date().toISOString(), harnessRoot, sourceKind: dom.sourceKind, source: dom.provenance.sources, files: entries,
  reference: { dom: referencePass, geometry: referencePass },
  candidate: { capture: 'reports/vcp-harness-agent-preset-seat-candidate.json', present: true, shape: candidatePass, status: dom.candidateStatus },
  contract: dom.harnessContract, pass: false,
  missingEvidence: ['real Harness AgentPresetSeat browser capture through the source dependency closure', 'same-semantic Harness/VCP DOM/ARIA and computed-style diff', 'same-semantic Harness/VCP pixel diff', 'VCP production consumer (assistantAgent/chat switching remains frozen)'],
  note: 'Source provenance and Candidate shape evidence only. This report is permanently non-promoting; it does not claim Harness/VCP parity or authorize a production consumer.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness AgentPresetSeat source provenance: files=${entries.filter(item => item.pass).length}/${entries.length}; pass=false; candidate remains source-only.`);
