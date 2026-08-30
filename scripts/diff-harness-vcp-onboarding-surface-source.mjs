import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const harness = read('reports/harness-onboarding-surface-source.json');
const vcp = read('reports/vcp-onboarding-surface-candidate.json');
const styleGroups = ['overlay', 'mask', 'stage'];
const computedStyle = { checks: styleGroups.flatMap(group => Object.keys(harness.open.style[group]).map(key => ({ field: `${group}.${key}`, harness: harness.open.style[group][key], vcp: vcp.open.style[group][key], pass: harness.open.style[group][key] === vcp.open.style[group][key] }))) };
computedStyle.pass = computedStyle.checks.every(item => item.pass);
const pixelPath = path.join(root, 'reports/harness-vcp-onboarding-surface-roi-pixel-diff.json');
const pixelResult = fs.existsSync(pixelPath) ? read('reports/harness-vcp-onboarding-surface-roi-pixel-diff.json') : null;
const report = {
  generatedAt: new Date().toISOString(),
  comparison: 'same Chromium engine, real Harness OnboardingSurface.tsx source fixture versus VCP Candidate fixture',
  semanticFixture: { pass: harness.semanticFixture === vcp.semanticFixture },
  states: {
    closed: { harness: harness.closed.present === false && harness.closed.rootInert === false, vcp: vcp.closed.present === false && vcp.closed.rootInert === false, pass: harness.closed.present === vcp.closed.present && harness.closed.rootInert === vcp.closed.rootInert },
    open: { harness: harness.open.present && harness.open.rootInert, vcp: vcp.open.present && vcp.open.rootInert, pass: harness.open.present === vcp.open.present && harness.open.rootInert === vcp.open.rootInert },
    unmountOrDispose: { harness: harness.closedAfterUnmount.present === false && harness.closedAfterUnmount.rootInert === false && harness.rootUnmounted, vcp: vcp.close.present === false && vcp.close.rootInert === false, pass: harness.closedAfterUnmount.present === false && harness.closedAfterUnmount.rootInert === false && harness.rootUnmounted === true && vcp.close.present === false && vcp.close.rootInert === false },
  },
  domAria: { role: { harness: harness.open.aria.overlayRole, vcp: vcp.open.aria.overlayRole, pass: harness.open.aria.overlayRole === vcp.open.aria.overlayRole }, maskHidden: { harness: harness.open.aria.maskHidden, vcp: vcp.open.aria.maskHidden, pass: harness.open.aria.maskHidden === vcp.open.aria.maskHidden } },
  computedStyle,
  candidateExtraState: { reopenRecorded: vcp.reopen.present === true, note: 'Candidate controller reopen is an experimental fixture capability; Harness source represents reopen as a new mount.' },
  pixel: pixelResult ? { status: 'strict-full-surface-measured', comparable: pixelResult.comparable, exactPixelPass: pixelResult.exactPixelPass, differentPixels: pixelResult.differentPixels, pixelRatio: pixelResult.pixelRatio, pass: pixelResult.pass } : { status: 'pending-full-surface-diff' },
  pass: false,
  missingEvidence: ['VCP production first-run consumer'],
};
fs.writeFileSync(path.join(root, 'reports/harness-vcp-onboarding-surface-source-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP OnboardingSurface source diff: domAria=${report.domAria.role.pass && report.domAria.maskHidden.pass}; style=${computedStyle.pass}; pixel=${report.pixel.status}.`);
