import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-workspace-browser-source-provenance.json');
const files = {
  component: path.join(harnessRoot, 'packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx'),
  style: path.join(harnessRoot, 'packages/client/ui-workspace/src/client/WorkspaceBrowser.module.css'),
  browserTest: path.join(harnessRoot, 'packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx'),
  styleTest: path.join(harnessRoot, 'packages/client/ui-workspace/tests/browser-styles.client.spec.ts'),
};
const anchors = {
  component: [
    'SEARCH_DEBOUNCE_MS = 250', 'SEARCH_QUERY_MAX_CODE_UNITS = 500', 'new AbortController()',
    'document.addEventListener(\'dragover\'', 'WorkspacePickFlow', 'onRenameRequest',
    'onDeleteRequest', 'expandSidebar()', 'searchExpanded', 'setTimeout',
  ],
  style: [
    '.root {', '.root.rail {', '.sectionHeader {', '.searchExpanded {', '.rail .iconButton {',
    '.listArea {', '.fade {', '@media (prefers-reduced-motion: reduce)',
  ],
  browserTest: ['describe(\'WorkspaceBrowser\'', 'drag order', 'search', 'rename', 'delete', 'Escape'],
  styleTest: ['describe(\'WorkspaceBrowser.module.css list\'', 'scrolling region', 'rail controls', 'column slide'],
};
const read = file => fs.readFileSync(file, 'utf8');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const entries = Object.entries(files).map(([name, file]) => {
  const present = fs.existsSync(file); const source = present ? read(file) : '';
  const checks = anchors[name].map(anchor => ({ anchor, pass: source.includes(anchor) }));
  return { name, file: path.relative(harnessRoot, file), sha256: present ? sha256(source) : null, checks, pass: present && checks.every(item => item.pass) };
});
const dom = JSON.parse(read(path.join(referenceRoot, 'workspace-browser.dom.json')));
const geometry = JSON.parse(read(path.join(referenceRoot, 'workspace-browser.geometry.json')));
const report = {
  generatedAt: new Date().toISOString(), harnessRoot, sourceKind: dom.sourceKind, source: dom.provenance.sources, files: entries,
  reference: {
    dom: dom.sourceKind === 'harness-composite-source-only' && dom.provenance.sources.length === 4,
    geometry: path.normalize(geometry.source).endsWith(path.normalize('packages/client/ui-workspace/src/client/WorkspaceBrowser.module.css')),
  },
  candidate: { present: false, status: 'source-only; no VCP Workspace/session consumer, capture, or parity claim' },
  contract: { tree: dom.tree, aria: dom.aria, ownership: dom.ownership, states: dom.states, vcpBoundary: dom.vcpBoundary },
  pass: false,
  missingEvidence: [
    'VCP Candidate implementation/capture (Workspace persistence, directory IPC and sidebar/session actions are frozen)',
    'same-semantic Harness/VCP DOM/ARIA and computed-style diff',
    'same-semantic Harness/VCP pixel diff across wide/rail/search/drag states',
    'authorized VCP Workspace production consumer; chat/sidebar navigation boundary remains frozen',
  ],
  note: 'Reference-only provenance evidence. Complex injected workspace/session state is not synthesized in Candidate Lab; this report is permanently non-promoting.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness WorkspaceBrowser source provenance: files=${entries.filter(item => item.pass).length}/${entries.length}; pass=false; reference remains source-only.`);
