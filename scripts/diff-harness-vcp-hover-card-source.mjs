import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const harness = read('reports/harness-hover-card-source.json');
const vcp = read('reports/vcp-hover-card-candidate.json');
const pixelResult = read('reports/harness-vcp-hover-card-roi-pixel-diff.json');
const styleKeys = ['position', 'zIndex', 'width', 'padding', 'borderRadius', 'boxSizing'];
const styles = styleKeys.map(key => ({ key, harness: harness.open.style[key], vcp: vcp.open.style[key], pass: harness.open.style[key] === vcp.open.style[key] }));
const interaction = {
  graceClosed: { harness: harness.closedAfterGrace, vcp: vcp.graceClosed, pass: harness.closedAfterGrace === vcp.graceClosed },
  copied: { harness: harness.copied?.text === 'Copied', vcp: vcp.copied?.text === 'Copied', pass: harness.copied?.text === vcp.copied?.text },
  disabled: { harness: harness.disabled?.cards === 0, vcp: vcp.disabled === true, pass: harness.disabled?.cards === 0 && vcp.disabled === true },
  unmountOrDispose: { harness: harness.unmounted?.rootEmpty === true, vcp: vcp.disposed?.cards === 0, pass: harness.unmounted?.rootEmpty === true && vcp.disposed?.cards === 0 },
};
interaction.pass = Object.values(interaction).every(item => item.pass);
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
  interaction,
  geometry: { harness: harness.open.rect, vcp: vcp.open.rect, pass: harness.open.rect.x === vcp.open.rect.x && harness.open.rect.y === vcp.open.rect.y },
  structuralPass: harness.open.role === vcp.open.role && harness.open.ariaLabel === vcp.open.ariaLabel && harness.open.parent === vcp.open.parent,
  pixel: { status: 'strict-roi-measured', comparable: pixelResult.comparable, exactPixelPass: pixelResult.exactPixelPass, differentPixels: pixelResult.differentPixels, pixelRatio: pixelResult.pixelRatio, pass: pixelResult.pass },
  pass: false,
  missingEvidence: ['VCP Candidate anchor-root geometry differs from Harness source fixture', 'VCP production consumer'],
};
fs.writeFileSync(path.join(root, 'reports/harness-vcp-hover-card-source-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP HoverCard source diff: structuralPass=${report.structuralPass}; computedStylePass=${report.computedStyle.pass}; geometryPass=${report.geometry.pass}; pixel=${report.pixel.status}.`);
