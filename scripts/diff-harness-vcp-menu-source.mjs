import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const harness = read('reports/harness-menu-source.json');
const vcp = read('reports/vcp-menu-candidate.json');

const harnessItems = harness.open.items.map(item => ({
    text: item.text,
    disabled: item.disabled,
    selected: String(item.selected),
}));
const candidateSharedItems = vcp.open.items
    .filter(item => !['Remove view', 'View settings'].includes(item.text))
    .map(item => ({ text: item.text, disabled: item.disabled, selected: item.selected }));
const styleFields = ['position', 'zIndex', 'padding', 'borderRadius', 'minWidth', 'fontFamily'];
const computedStyle = styleFields.map(field => ({
    field,
    harness: harness.open.style[field],
    vcp: vcp.open.style[field],
    pass: harness.open.style[field] === vcp.open.style[field],
}));
const interaction = {
    outsideClose: { harness: harness.outsideClosed, vcp: vcp.outsideClosed, pass: harness.outsideClosed === true && vcp.outsideClosed === true },
    escapeClose: { harness: harness.escapeClosed, vcp: vcp.escapeClosed, pass: harness.escapeClosed === true && vcp.escapeClosed === true },
    submenuFocus: { harness: harness.submenuItems, vcp: vcp.submenuItems, pass: JSON.stringify(harness.submenuItems) === JSON.stringify(vcp.submenuItems) },
    unmountOrDispose: { harness: harness.unmounted, vcp: vcp.disposed, pass: harness.unmounted.rootEmpty === true && harness.unmounted.menus === 0 && vcp.disposed?.restored === true },
};
const report = {
    generatedAt: new Date().toISOString(),
    comparison: 'same Chromium engine, real Harness Menu.tsx source fixture versus VCP Candidate fixture',
    semanticFixture: { harness: harness.semanticFixture, vcp: vcp.semanticFixture, pass: harness.semanticFixture === vcp.semanticFixture },
    domAria: {
        menuRole: { harness: harness.open.role, vcp: vcp.open.role, pass: harness.open.role === vcp.open.role },
        triggerHasPopup: { harness: harness.open.aria.triggerHasPopup, vcp: vcp.open.aria.triggerHasPopup, pass: harness.open.aria.triggerHasPopup === vcp.open.aria.triggerHasPopup, note: 'Harness Menu owns no trigger ARIA mutation; Candidate adapter does.' },
        triggerExpanded: { harness: harness.open.aria.triggerExpanded, vcp: vcp.open.aria.triggerExpanded, pass: harness.open.aria.triggerExpanded === vcp.open.aria.triggerExpanded, note: 'Harness Menu owns no trigger ARIA mutation; Candidate adapter does.' },
        sharedItems: { harness: harnessItems, vcp: candidateSharedItems, pass: JSON.stringify(harnessItems) === JSON.stringify(candidateSharedItems) },
        separators: { harness: harness.open.separators, vcp: vcp.open.separators, pass: harness.open.separators === vcp.open.separators },
        candidateOnly: { dangerItem: 'Remove view', footerItem: 'View settings', pass: false, note: 'The source fixture intentionally lacks danger and footer rows; no structural parity is claimed.' },
    },
    computedStyle: { checks: computedStyle, pass: computedStyle.every(item => item.pass) },
    geometry: {
        harness: harness.open.rect,
        vcp: vcp.open.rect,
        comparable: harness.open.rect.width === vcp.open.rect.width && harness.open.rect.height === vcp.open.rect.height,
        pass: false,
        note: 'Candidate includes its extra danger/footer rows, so its 218×290 card is not a strict-ROI peer of the Harness 218×211 fixture.',
    },
    interaction,
    pass: false,
    missingEvidence: [
        'same-semantic source danger/footer fixture',
        'strict Menu ROI pixel diff',
        'VCP production Menu consumer',
    ],
};
fs.writeFileSync(path.join(root, 'reports/harness-vcp-menu-source-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Menu source diff: sharedItems=${report.domAria.sharedItems.pass}; interaction=${Object.values(interaction).every(item => item.pass)}; style=${report.computedStyle.pass}; geometryComparable=${report.geometry.comparable}.`);
