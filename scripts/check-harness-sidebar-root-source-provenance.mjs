import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-sidebar-root-source-provenance.json');
const files = {
  component: path.join(harnessRoot, 'packages/client/ui-sidebar/src/client/SidebarRoot.tsx'),
  style: path.join(harnessRoot, 'packages/client/ui-sidebar/src/client/SidebarRoot.module.css'),
  shellTest: path.join(harnessRoot, 'packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx'),
  scrollbarTest: path.join(harnessRoot, 'packages/client/ui-sidebar/tests/pointer-scrollbars.client.spec.tsx'),
};
const anchors = {
  component: ['COLLAPSE_SETTLE_MS = 150', 'SCROLLBAR_LINGER_MS = 2000', 'setTimeout', 'pointermove', 'toggleSidebar()', 'startSession()', "renderSlot('sidebar.workspaces'", "renderSlot('sidebar.settings'", 'css.fading', 'css.quietBars'],
  style: ['.root {', '.root.collapsed {', '.logoRow {', '.collapsed .logoRow {', '.iconButton {', '.collapsed .iconButton {', '.newSession {', '.collapsed .newSession {', '.regionArea {', '.fading > * {'],
  shellTest: ["describe('SidebarRoot shell'", 'New Session', 'collapse', 'wide flag', 'cold start'],
  scrollbarTest: ['pointer', 'scrollbar', 'linger', 'quiet'],
};
const read = file => fs.readFileSync(file, 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const entries = Object.entries(files).map(([name, file]) => {
  const present = fs.existsSync(file); const source = present ? read(file) : '';
  const checks = anchors[name].map(anchor => ({ anchor, pass: source.includes(anchor) }));
  return { name, file: path.relative(harnessRoot, file), sha256: present ? sha256(source) : null, checks, pass: present && checks.every(item => item.pass) };
});
const dom = JSON.parse(read(path.join(referenceRoot, 'sidebar-root.dom.json')));
const geometry = JSON.parse(read(path.join(referenceRoot, 'sidebar-root.geometry.json')));
const report = {
  generatedAt: new Date().toISOString(), harnessRoot, sourceKind: dom.sourceKind, source: dom.provenance.sources, files: entries,
  reference: { dom: dom.sourceKind === 'harness-composite-source-only' && dom.provenance.sources.length === 4, geometry: path.normalize(geometry.source).endsWith(path.normalize('packages/client/ui-sidebar/src/client/SidebarRoot.module.css')) },
  candidate: { present: false, status: 'source-only; no VCP shell/sidebar consumer or paired capture' },
  contract: { tree: dom.tree, aria: dom.aria, ownership: dom.ownership, states: dom.states, vcpBoundary: dom.vcpBoundary },
  pass: false,
  missingEvidence: ['VCP Candidate shell implementation/capture (sidebar/session/settings consumers are frozen)', 'same-semantic Harness/VCP DOM/ARIA and computed-style diff', 'same-semantic Harness/VCP pixel diff across wide/collapse/rail/pointer-scrollbar states', 'cross-platform Electron evidence and teardown stress for the shell owner'],
  note: 'Reference-only provenance evidence. No VCP sidebar consumer is synthesized; this report is permanently non-promoting.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness SidebarRoot source provenance: files=${entries.filter(item => item.pass).length}/${entries.length}; pass=false; reference remains source-only.`);
