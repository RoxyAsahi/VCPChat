import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-popup-select-source-provenance.json');
const files = {
  controller: path.join(harnessRoot, 'packages/client/ui-commands/src/client/popup.ts'),
  view: path.join(harnessRoot, 'packages/client/ui-commands/src/client/PopupSelectView.tsx'),
  style: path.join(harnessRoot, 'packages/client/ui-commands/src/client/PopupSelectView.module.css'),
};
const read = file => fs.readFileSync(file, 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const anchors = {
  controller: ['export function filterOptions', 'new AbortController()', 'this.deps.focusComposer()', 'binding !== binding', 'dispose(): void'],
  view: ['role="listbox"', 'role="option"', 'role="alert"', 'focusComposer: true', '<RiskConfirmation'],
  style: ['.card', 'max-height: 320px', '.rowActive', '.search', '.error'],
};
const entries = Object.entries(files).map(([name, file]) => { const text = read(file); const checks = anchors[name].map(anchor => ({ anchor, pass: text.includes(anchor) })); return { name, file: path.relative(harnessRoot, file), sha256: sha(text), checks, pass: checks.every(item => item.pass) }; });
const dom = JSON.parse(read(path.join(referenceRoot, 'popup-select.dom.json'))); const geometry = JSON.parse(read(path.join(referenceRoot, 'popup-select.geometry.json'))); const capturePath = path.join(root, 'reports/vcp-harness-popup-select-candidate.json'); const capture = JSON.parse(read(capturePath));
const report = { generatedAt: new Date().toISOString(), sourceKind: dom.sourceKind, source: dom.provenance.sources, semanticFixture: { expected: 'popup-select/load-filter-keyboard-risk-dismiss-dispose', actual: 'candidate capture is model-picker-derived and not equivalent', pass: false }, files: entries, reference: { dom: dom.sourceKind === 'harness-composite-source-only' && dom.provenance.sources.length === 3, geometry: geometry.states?.includes('risk-confirmation') === true }, candidate: { capture: 'reports/vcp-harness-popup-select-candidate.json', present: true, lifecycle: capture.lifecycle }, pass: false, missingEvidence: ['real Harness PopupSelectView browser capture', 'same-semantic Harness/VCP computed-style diff', 'same-semantic Harness/VCP pixel diff', 'VCP production consumer (Composer/input overlay remains frozen)'], note: 'This is source provenance and scope evidence only. The existing Candidate capture is model-picker-derived and must not be promoted to PopupSelect parity.' };
fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); console.log(`Harness PopupSelect source provenance: files=${report.files.filter(item => item.pass).length}/${report.files.length}; pass=false; candidate remains source-only.`);
