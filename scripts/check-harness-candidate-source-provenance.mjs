import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const referenceDir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-candidate-source-provenance.json');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const candidates = [
  {
    name: 'tooltip',
    source: 'packages/client/ui-primitives/src/Tooltip.tsx',
    style: 'packages/client/ui-primitives/src/Tooltip.module.css',
    capture: 'reports/vcp-tooltip-candidate.json',
    semanticFixture: 'tooltip/bottom-delayed-hover-focus-flip-disabled-dispose',
    sourceAnchors: ['cloneElement(children', "role=\"tooltip\"", 'delayMs <= 0', "setPlacement('top')", 'disabled) {'],
    styleAnchors: ['position: fixed', 'z-index: 100', 'max-width: 50vw', "[data-side='top']"],
  },
  {
    name: 'hover-card',
    source: 'packages/client/ui-primitives/src/HoverCard.tsx',
    style: 'packages/client/ui-primitives/src/HoverCard.module.css',
    capture: 'reports/vcp-hover-card-candidate.json',
    semanticFixture: 'hover-card/portal-grace-copy-disabled-dispose',
    sourceAnchors: ['createPortal(card, document.body)', 'usePointerGrace(close)', "role={copyable ? 'button'", 'copyEpochRef.current += 1', 'onPointerDownCapture'],
    styleAnchors: ['position: fixed', 'z-index: 100', 'width: 244px', 'padding: 12px 16px'],
  },
];

const entries = candidates.map(candidate => {
  const sourceFile = path.join(harnessRoot, candidate.source);
  const styleFile = path.join(harnessRoot, candidate.style);
  const domFile = path.join(referenceDir, `${candidate.name}.dom.json`);
  const geometryFile = path.join(referenceDir, `${candidate.name}.geometry.json`);
  const captureFile = path.join(root, candidate.capture);
  const sourceExists = fs.existsSync(sourceFile);
  const styleExists = fs.existsSync(styleFile);
  const dom = fs.existsSync(domFile) ? json(domFile) : null;
  const geometry = fs.existsSync(geometryFile) ? json(geometryFile) : null;
  const capture = fs.existsSync(captureFile) ? json(captureFile) : null;
  const sourceText = sourceExists ? read(sourceFile) : '';
  const styleText = styleExists ? read(styleFile) : '';
  const sourceAnchorPasses = candidate.sourceAnchors.map(anchor => ({ anchor, pass: sourceText.includes(anchor) }));
  const styleAnchorPasses = candidate.styleAnchors.map(anchor => ({ anchor, pass: styleText.includes(anchor) }));
  const referencePass = dom?.source === candidate.source && dom?.styleSource === candidate.style
    && geometry?.source === candidate.style && geometry?.styleSource === candidate.style;
  const capturePass = capture?.semanticFixture === candidate.semanticFixture
    && typeof capture?.candidateStatus === 'string'
    && capture.candidateStatus.includes('no same-semantic Harness');
  const pass = sourceExists && styleExists && referencePass && capturePass
    && sourceAnchorPasses.every(item => item.pass) && styleAnchorPasses.every(item => item.pass);
  return {
    name: candidate.name,
    source: { file: candidate.source, sha256: sourceExists ? sha256(sourceText) : null, anchors: sourceAnchorPasses },
    style: { file: candidate.style, sha256: styleExists ? sha256(styleText) : null, anchors: styleAnchorPasses },
    referencePass,
    capture: candidate.capture,
    capturePass,
    pass,
  };
});
const report = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  status: entries.every(entry => entry.pass) ? 'candidate-source-provenance-complete' : 'candidate-source-provenance-drift',
  pass: entries.every(entry => entry.pass),
  note: 'Read-only source drift evidence for Candidate Lab baselines. Matching source anchors and captures do not establish a Harness/VCP DOM, computed-style, pixel, or production-consumer parity claim.',
  entries,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness Candidate source provenance: ${report.status}; pass=${report.pass}; candidates=${entries.length}.`);
if (!report.pass) process.exitCode = 1;
