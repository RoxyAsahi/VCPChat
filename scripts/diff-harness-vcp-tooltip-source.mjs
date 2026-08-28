import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const harness = read('reports/harness-tooltip-source.json');
const vcp = read('reports/vcp-tooltip-candidate.json');
const styleKeys = ['position', 'zIndex', 'width', 'maxWidth', 'padding', 'borderRadius', 'fontSize', 'lineHeight', 'pointerEvents', 'transform'];
const style = styleKeys.map(key => ({ key, harness: harness.hover.style[key], vcp: vcp.hover.style[key], pass: harness.hover.style[key] === vcp.hover.style[key] }));
const report = {
  generatedAt: new Date().toISOString(),
  comparison: 'same Chromium engine, real Harness Tooltip.tsx source fixture versus VCP Candidate fixture',
  semanticFixture: { harness: harness.semanticFixture, vcp: vcp.semanticFixture, pass: harness.semanticFixture === vcp.semanticFixture },
  dom: {
    role: { harness: harness.hover.role, vcp: vcp.hover.role, pass: harness.hover.role === vcp.hover.role },
    side: { harness: harness.hover.side, vcp: vcp.hover.side, pass: harness.hover.side === vcp.hover.side },
    parent: { harness: harness.hover.parent, vcp: vcp.hover.parent, pass: harness.hover.parent === vcp.hover.parent },
  },
  computedStyle: { checks: style, pass: style.every(item => item.pass) },
  structuralPass: harness.hover.parent === vcp.hover.parent,
  pixel: { status: 'pending-roi-diff', missingEvidence: 'normalized tooltip ROI pixel comparator' },
  pass: false,
  missingEvidence: ['VCP Candidate uses body portal while Harness source keeps the bubble in the anchor parent', 'focus/flip/disabled Harness source capture', 'normalized tooltip ROI pixel diff', 'VCP production consumer'],
};
fs.writeFileSync(path.join(root, 'reports/harness-vcp-tooltip-source-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Tooltip source diff: structuralPass=${report.structuralPass}; computedStylePass=${report.computedStyle.pass}; pixel=${report.pixel.status}.`);
