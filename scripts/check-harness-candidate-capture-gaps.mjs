import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-candidate-capture-gaps.json');
const specs = [
  { name: 'agent-preset-seat', source: ['packages/client/ui-agent-preset/src/client/AgentPresetSeat.tsx', 'packages/client/ui-agent-preset/src/client/PresetMenu.tsx'], candidate: 'modules/uiux/primitives/agent-preset-seat.ts', provenanceGuard: 'scripts/check-harness-agent-preset-seat-source-provenance.mjs', boundary: 'VCP assistantAgent/chat switching chain is frozen', gaps: ['same roster/copy Harness-VCP fixture', 'same-semantic DOM/ARIA and computed-style diff', 'same-semantic pixel diff'] },
  { name: 'agent-preset-row', source: ['packages/client/ui-agent-preset/src/client/AgentPresetRow.tsx', 'packages/client/ui-agent-preset/src/client/PresetMenu.tsx'], candidate: 'modules/uiux/primitives/agent-preset-row.ts', provenanceGuard: 'scripts/check-harness-agent-preset-row-source-provenance.mjs', boundary: 'VCP has no equivalent non-frozen preset preference business capability', gaps: ['real Harness source browser capture', 'same-semantic DOM/ARIA and computed-style diff', 'same-semantic pixel diff'] },
  { name: 'popup-select', source: ['packages/client/ui-commands/src/client/popup.ts', 'packages/client/ui-commands/src/client/PopupSelectView.tsx'], candidate: 'modules/uiux/primitives/popup-select.ts', provenanceGuard: 'scripts/check-harness-popup-select-source-provenance.mjs', boundary: 'Composer/input overlay and command wiring are frozen', gaps: ['real Harness PopupSelectView browser capture', 'same-semantic DOM/ARIA and computed-style diff', 'same-semantic pixel diff'] },
  { name: 'disclosure-row', source: ['packages/client/ui-primitives/src/DisclosureRow.tsx'], candidate: 'modules/uiux/primitives/disclosure-row.ts', provenanceGuard: 'scripts/check-harness-disclosure-row-source-provenance.mjs', boundary: 'VCP chat/message consumer is frozen', gaps: ['same-semantic strict pixel baseline is measured but non-passing', 'authorized non-chat/non-message VCP production consumer'] },
];
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness';
const entries = specs.map(spec => {
  const dom = readJson(path.join(referenceRoot, `${spec.name}.dom.json`));
  const geometry = readJson(path.join(referenceRoot, `${spec.name}.geometry.json`));
  const candidateFile = path.join(root, spec.candidate);
  const sourcePass = spec.source.every(file => fs.existsSync(path.join(harnessRoot, file)));
  const candidatePass = fs.existsSync(candidateFile);
  const status = String(dom.candidateStatus ?? '');
  const provenanceGuardPass = fs.existsSync(path.join(root, spec.provenanceGuard));
  return { ...spec, sourcePass, candidatePass, referencePass: Boolean(dom.provenance?.sources?.length && geometry.styleSource), provenanceGuardPass, candidateStatus: status, captureGap: /pending|frozen/.test(status), pass: false };
});
const report = { generatedAt: new Date().toISOString(), status: entries.every(item => item.sourcePass && item.candidatePass && item.referencePass && item.captureGap) ? 'candidate-capture-gaps-recorded' : 'candidate-capture-gap-ledger-incomplete', pass: false, note: 'Read-only planning ledger. It inventories source-backed Candidate Lab controls lacking the listed real-source capture evidence; no entry is a production parity claim or authorization to connect a frozen consumer.', counts: { candidates: entries.length, sourceBacked: entries.filter(item => item.sourcePass).length, candidateImplementations: entries.filter(item => item.candidatePass).length, captureGaps: entries.filter(item => item.captureGap).length }, nextCandidate: 'agent-preset-seat', entries };
fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(`Harness Candidate capture gaps: ${report.status}; candidates=${report.counts.candidates}; gaps=${report.counts.captureGaps}.`);
