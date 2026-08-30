import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const harness = read('reports/harness-tooltip-source.json');
const vcp = read('reports/vcp-tooltip-candidate.json');
const pixelResult = read('reports/harness-vcp-tooltip-roi-pixel-diff.json');
const styleKeys = ['position', 'zIndex', 'width', 'maxWidth', 'padding', 'borderRadius', 'fontSize', 'lineHeight', 'pointerEvents', 'transform'];
const style = styleKeys.map(key => ({ key, harness: harness.hover.style[key], vcp: vcp.hover.style[key], pass: harness.hover.style[key] === vcp.hover.style[key] }));
const interaction = {
  focusImmediate: { harness: harness.focusImmediate, vcp: vcp.focusImmediate, pass: harness.focusImmediate === vcp.focusImmediate },
  hiddenAfterBlur: { harness: harness.hiddenAfterBlur, vcp: vcp.hiddenAfterBlur, pass: harness.hiddenAfterBlur === vcp.hiddenAfterBlur },
  flippedTop: { harness: harness.flipped?.side === 'top', vcp: vcp.flipped?.side === 'top', pass: harness.flipped?.side === vcp.flipped?.side },
  disabledSuppressed: { harness: harness.disabled?.bubbleCount === 0, vcp: vcp.disabled?.bubbleCount === 0, pass: harness.disabled?.bubbleCount === vcp.disabled?.bubbleCount },
  unmountOrDispose: { harness: harness.unmounted?.rootEmpty === true, vcp: vcp.disposed?.bubbles === 0, pass: harness.unmounted?.rootEmpty === true && vcp.disposed?.bubbles === 0 },
};
interaction.pass = Object.values(interaction).every(item => item.pass);
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
  interaction,
  structuralPass: harness.hover.parent === vcp.hover.parent,
  pixel: { status: 'strict-roi-measured', comparable: pixelResult.comparable, exactPixelPass: pixelResult.exactPixelPass, differentPixels: pixelResult.differentPixels, pixelRatio: pixelResult.pixelRatio, pass: pixelResult.pass },
  pass: false,
  missingEvidence: ['VCP Candidate uses body portal while Harness source keeps the bubble in the anchor parent', 'VCP production consumer'],
};
fs.writeFileSync(path.join(root, 'reports/harness-vcp-tooltip-source-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Tooltip source diff: structuralPass=${report.structuralPass}; computedStylePass=${report.computedStyle.pass}; pixel=${report.pixel.status}.`);
