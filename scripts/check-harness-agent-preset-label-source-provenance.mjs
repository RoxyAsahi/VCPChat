import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-agent-preset-label-source-provenance.json');
const files = { component: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/AgentPresetLabel.tsx'), style: path.join(harnessRoot, 'packages/client/ui-agent-preset/src/client/AgentPresetLabel.module.css') };
const anchors = { component: ['useSessions(state => state.byId[sessionId]?.agentPreset)', 'if (preset !== undefined) void load()', 'if (preset === undefined) return null', '<span', 'title={text?.description ?? t(\'headerHint\')}', 'size={14}', '{text?.name ?? preset}'], style: ['.label {', 'display: inline-flex', 'height: 22px', 'max-width: 180px', 'gap: 4px', 'border-radius: 6px', '.icon {', 'opacity: 0.7'] };
const read = file => fs.readFileSync(file, 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const entries = Object.entries(files).map(([name, file]) => { const present = fs.existsSync(file); const text = present ? read(file) : ''; const checks = anchors[name].map(anchor => ({ anchor, pass: text.includes(anchor) })); return { name, file: path.relative(harnessRoot, file), sha256: present ? sha256(text) : null, checks, pass: present && checks.every(item => item.pass) }; });
const dom = JSON.parse(read(path.join(referenceRoot, 'agent-preset-label.dom.json')));
const geometry = JSON.parse(read(path.join(referenceRoot, 'agent-preset-label.geometry.json')));
const candidatePath = path.join(root, 'modules/uiux/primitives/agent-preset-label.ts');
const report = { generatedAt: new Date().toISOString(), harnessRoot, sourceKind: dom.sourceKind, source: dom.provenance.sources, files: entries, reference: { dom: dom.provenance.sources.length === 2 && dom.sourceKind === 'harness-composite-source-only', geometry: path.normalize(geometry.source).endsWith(path.normalize('packages/client/ui-agent-preset/src/client/AgentPresetLabel.module.css')) }, candidate: { source: 'modules/uiux/primitives/agent-preset-label.ts', present: fs.existsSync(candidatePath), status: 'reference-only; no VCP candidate implementation or production consumer' }, contract: { root: dom.root, children: dom.children, aria: dom.aria, states: dom.states }, pass: false, missingEvidence: ['VCP Candidate implementation/capture (not authorized without a session-header consumer)', 'same-semantic Harness/VCP DOM/ARIA and computed-style diff', 'same-semantic Harness/VCP pixel diff', 'VCP session-header production consumer; chat/session header boundary remains frozen'], note: 'Reference-only provenance evidence. No Candidate implementation is synthesized because VCP has no legal session-header consumer; this report is permanently non-promoting.' };
fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(`Harness AgentPresetLabel source provenance: files=${entries.filter(item => item.pass).length}/${entries.length}; pass=false; reference remains source-only.`);
