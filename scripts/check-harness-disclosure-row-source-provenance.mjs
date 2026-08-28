import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceRoot = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-disclosure-row-source-provenance.json');
const files = {
  component: path.join(harnessRoot, 'packages/client/ui-primitives/src/DisclosureRow.tsx'),
  style: path.join(harnessRoot, 'packages/client/ui-primitives/src/DisclosureRow.module.css'),
};
const anchors = {
  component: [
    'expandOnRowClick = false',
    'previewChevron = expandable',
    'keepContentWhenOpen = false',
    "event.key !== 'Enter' && event.key !== ' '",
    "role={rowExpands ? 'button' : undefined}",
    'aria-expanded={rowExpands ? open : undefined}',
    'aria-expanded={open}',
    '{(keepContentWhenOpen || !open) && collapsedContent}',
    '{open && children}',
  ],
  style: [
    '.root {',
    'width: 100%',
    '.row {',
    'height: 24px',
    '.leading {',
    'width: 16px',
    'margin-right: 6px',
    'transition: opacity 100ms ease',
    '.title {',
    'font-size: 14px',
    'line-height: 24px',
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
const dom = JSON.parse(read(path.join(referenceRoot, 'disclosure-row.dom.json')));
const geometry = JSON.parse(read(path.join(referenceRoot, 'disclosure-row.geometry.json')));
const candidate = JSON.parse(read(path.join(root, 'reports/vcp-harness-disclosure-row-candidate.json')));
const sourceCapturePath = path.join(root, 'reports/harness-disclosure-row-source.json');
const sourceCapture = fs.existsSync(sourceCapturePath) ? JSON.parse(read(sourceCapturePath)) : null;
const referencePass = dom.sourceKind === 'harness-primitive-source-only'
  && dom.provenance?.sources?.length === 2
  && geometry.styleSource === 'packages/client/ui-primitives/src/DisclosureRow.module.css';
const candidatePass = candidate.source === 'generated-artifact-electron'
  && candidate.viewport?.width === 800
  && candidate.viewport?.height === 600
  && candidate.state === 'row-click-open-keep-content'
  && candidate.row?.role === 'button'
  && candidate.row?.tabIndex === 0
  && candidate.row?.ariaExpanded === 'true'
  && candidate.summaryVisible === true
  && candidate.bodyVisible === true;
const sourceCapturePass = sourceCapture?.sourcePath === 'packages/client/ui-primitives/src/DisclosureRow.tsx'
  && sourceCapture?.styleSource === 'packages/client/ui-primitives/src/DisclosureRow.module.css'
  && sourceCapture?.status === 'harness-source-component-capture'
  && sourceCapture?.viewport?.width === 800
  && sourceCapture?.viewport?.height === 600
  && sourceCapture?.collapsed?.row?.role === 'button'
  && sourceCapture?.collapsed?.row?.height === '24px'
  && sourceCapture?.rowOpen?.row?.ariaExpanded === 'true'
  && sourceCapture?.keyboardClosed?.row?.ariaExpanded === 'false'
  && sourceCapture?.leadingClosed?.leading?.tag === 'BUTTON'
  && sourceCapture?.leadingOpen?.leading?.ariaExpanded === 'true'
  && sourceCapture?.forcedOpen?.row?.role === null
  && sourceCapture?.forcedOpen?.bodyVisible === true
  && sourceCapture?.unmounted?.rootEmpty === true
  && sourceCapture?.unmounted?.rows === 0;
const report = {
  generatedAt: new Date().toISOString(), harnessRoot, sourceKind: dom.sourceKind,
  source: dom.provenance.sources, files: entries,
  reference: { dom: referencePass, geometry: referencePass },
  sourceCapture: { capture: 'reports/harness-disclosure-row-source.json', present: Boolean(sourceCapture), shape: sourceCapturePass, status: sourceCapture?.status ?? 'missing' },
  candidate: { capture: 'reports/vcp-harness-disclosure-row-candidate.json', present: true, shape: candidatePass, status: dom.candidateStatus },
  contract: dom.contract, pass: false,
  missingEvidence: [
    'same-semantic Harness/VCP DOM/ARIA and computed-style diff',
    'same-semantic Harness/VCP pixel diff',
    'authorized non-chat/non-message VCP production consumer evidence',
  ],
  note: 'Source provenance and Candidate shape evidence only. The chat/message integration boundary remains frozen; this report does not claim parity or authorize consumer wiring.',
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness DisclosureRow source provenance: files=${entries.filter(item => item.pass).length}/${entries.length}; pass=false; candidate remains source-only.`);
