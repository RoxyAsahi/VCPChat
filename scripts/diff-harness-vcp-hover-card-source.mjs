import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const harness = read('reports/harness-hover-card-source.json');
const vcp = read('reports/vcp-hover-card-candidate.json');
const styleKeys = ['position', 'zIndex', 'width', 'padding', 'borderRadius', 'boxSizing'];
const styles = styleKeys.map(key => ({ key, harness: harness.open.style[key], vcp: vcp.open.style[key], pass: harness.open.style[key] === vcp.open.style[key] }));
const report = {
  generatedAt: new Date().toISOString(),
  comparison: 'same Chromium engine, real Harness HoverCard.tsx source fixture versus VCP Candidate fixture',
  semanticFixture: { harness: harness.semanticFixture, vcp: vcp.semanticFixture, pass: harness.semanticFixture === vcp.semanticFixture },
  dom: {
    role: { harness: harness.open.role, vcp: vcp.open.role, pass: harness.open.role === vcp.open.role },
    ariaLabel: { harness: harness.open.ariaLabel, vcp: vcp.open.ariaLabel, pass: harness.open.ariaLabel === vcp.open.ariaLabel },
    parent: { harness: harness.open.parent, vcp: vcp.open.parent, pass: harness.open.parent === vcp.open.parent },
  },
  computedStyle: { checks: styles, pass: styles.every(item => item.pass) },
  geometry: { harness: harness.open.rect, vcp: vcp.open.rect, pass: harness.open.rect.x === vcp.open.rect.x && harness.open.rect.y === vcp.open.rect.y },
  structuralPass: harness.open.role === vcp.open.role && harness.open.ariaLabel === vcp.open.ariaLabel && harness.open.parent === vcp.open.parent,
  pixel: { status: 'pending-roi-diff', missingEvidence: 'normalized HoverCard ROI pixel comparator' },
  pass: false,
  missingEvidence: ['VCP Candidate anchor-root geometry differs from Harness source fixture', 'disabled/dispose Harness source capture', 'normalized HoverCard ROI pixel diff', 'VCP production consumer'],
};
fs.writeFileSync(path.join(root, 'reports/harness-vcp-hover-card-source-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP HoverCard source diff: structuralPass=${report.structuralPass}; computedStylePass=${report.computedStyle.pass}; geometryPass=${report.geometry.pass}; pixel=${report.pixel.status}.`);
