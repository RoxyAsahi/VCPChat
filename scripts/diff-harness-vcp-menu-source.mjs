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
const candidateItems = vcp.open.items.map(item => ({
    text: item.text,
    disabled: item.disabled,
    selected: item.selected,
}));
const styleFields = ['position', 'zIndex', 'padding', 'borderRadius', 'minWidth', 'fontFamily'];
const computedStyle = styleFields.map(field => ({
    field,
    harness: harness.open.style[field],
    vcp: vcp.open.style[field],
    pass: harness.open.style[field] === vcp.open.style[field],
}));
const pixelPath = path.join(root, 'reports/harness-vcp-menu-roi-pixel-diff.json');
const pixelResult = fs.existsSync(pixelPath) ? read('reports/harness-vcp-menu-roi-pixel-diff.json') : null;
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
        items: { harness: harnessItems, vcp: candidateItems, pass: JSON.stringify(harnessItems) === JSON.stringify(candidateItems) },
        separators: { harness: harness.open.separators, vcp: vcp.open.separators, pass: harness.open.separators === vcp.open.separators },
        footer: { harness: harness.open.footer, vcp: vcp.open.footer, pass: harness.open.footer === vcp.open.footer },
    },
    computedStyle: { checks: computedStyle, pass: computedStyle.every(item => item.pass) },
    geometry: {
        harness: harness.open.rect,
        vcp: vcp.open.rect,
        comparable: harness.open.rect.width === vcp.open.rect.width && harness.open.rect.height === vcp.open.rect.height,
        pass: false,
        note: 'The real-source danger/footer fixture has the same semantic rows, but its measured 218×287 card remains three CSS pixels shorter than the 218×290 Candidate card.',
    },
    interaction,
    pixel: pixelResult ? { status: 'strict-roi-measured', comparable: pixelResult.comparable, exactPixelPass: pixelResult.exactPixelPass, differentPixels: pixelResult.differentPixels, pixelRatio: pixelResult.pixelRatio, pass: pixelResult.pass } : { status: 'pending-strict-roi-capture' },
    pass: false,
    missingEvidence: [
        'VCP production Menu consumer',
    ],
};
fs.writeFileSync(path.join(root, 'reports/harness-vcp-menu-source-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Menu source diff: items=${report.domAria.items.pass}; interaction=${Object.values(interaction).every(item => item.pass)}; style=${report.computedStyle.pass}; geometryComparable=${report.geometry.comparable}.`);
