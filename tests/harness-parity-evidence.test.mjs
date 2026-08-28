import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const reportPath = path.join(root, 'reports/harness-parity-evidence.json');

test('Harness parity evidence audit preserves provenance and explicit gaps', () => {
    execFileSync(process.execPath, ['scripts/check-harness-parity-evidence.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.status, 'evidence-gaps-present');
    assert.equal(report.pass, false, 'open evidence gaps must not be reported as complete');
    assert.ok(report.counts.primitives >= 20);
    assert.ok(report.counts.provenanceRecords >= report.counts.primitives);
    assert.ok(report.counts.provenanceComplete > 0);
    assert.ok(report.counts.provenanceGaps > 0);
    assert.ok(report.primitives.some(item => item.name === 'model-picker'));
    assert.equal(report.primitives.find(item => item.name === 'model-picker')?.provenancePass, true);
    assert.ok(report.primitives.some(item => item.name === 'field' && item.provenance.some(source => source.declared.endsWith('fields.tsx'))));
    assert.equal(report.primitives.find(item => item.name === 'field')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'input')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'settings-root')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'button')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'menu')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'modal')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'tooltip')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'hover-card')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'disclosure-row')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'state-dot')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'toast')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'risk-confirmation')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'semantic-icon')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'agent-preset-label')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'agent-preset-row')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'agent-preset-section')?.provenancePass, true);
    assert.equal(report.primitives.find(item => item.name === 'agent-preset-seat')?.provenancePass, true);
    assert.ok(report.missingEvidence.includes('select/busy-trigger-disabled: blocked-vcp-consumer'));
    assert.ok(report.missingEvidence.includes('language-row/open-select-dismiss-focus-dispose: candidate-source-only'));
    assert.equal(report.nextCandidate, 'select/busy-trigger-disabled');
});

test('Model picker diff reports pending or compares when a Harness capture exists', () => {
    execFileSync(process.execPath, ['scripts/diff-harness-vcp-model-picker.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-vcp-model-picker-diff.json'), 'utf8'));
    assert.ok(['pending-harness-capture', 'pending-harness-interaction-evidence', 'harness-capture-available-pixel-pending'].includes(report.status));
    assert.equal(report.dom.ariaContractPass, true);
    assert.equal(report.dom.deviations[0].declared, true);
    if (report.status === 'pending-harness-capture') {
        assert.equal(report.pass, false);
        assert.equal(report.dom.structuralPass, false);
        assert.ok(report.missingEvidence.includes('Candidate DOM/ARIA structural contract'));
        assert.ok(report.missingEvidence.includes('Harness ModelSelect browser capture (DOM + computed style)'));
        assert.ok(report.missingEvidence.includes('Candidate computed-style contract'));
    } else if (report.status === 'pending-harness-interaction-evidence') {
        assert.equal(report.pass, false);
        assert.equal(report.harnessCapture.interaction.pass, false);
        assert.ok(report.missingEvidence.includes('Harness ModelSelect keyboard/focus interaction evidence'));
    } else {
        assert.equal(report.pass, true, 'source and computed-style comparison should pass before pixel evidence');
        assert.equal(report.dom.structuralPass, true);
        assert.equal(report.computedStyle.pass, true);
        assert.ok(report.missingEvidence.includes('same-semantic ModelSelect pixel diff'));
    }
});

test('Harness UI inventory separates frozen surfaces from contract candidates', () => {
    execFileSync(process.execPath, ['scripts/scan-harness-ui-inventory.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-ui-inventory.json'), 'utf8'));
    assert.ok(['inventory-gaps-present', 'inventory-scoped-complete'].includes(report.status));
    assert.ok(report.counts.portablePrimitives > 0);
    assert.ok(report.counts.composites > 0);
    assert.ok(report.counts.frozenDomainSurfaces > 0);
    assert.equal(report.counts.missingContracts, 0);
    assert.ok(report.entries.some(item => item.name === 'ModelSelect' && item.category === 'composite-surface'));
    assert.ok(report.entries.some(item => item.category === 'frozen-domain-surface'));
    assert.ok(report.counts.scopeBlockedSurfaces > 0);
    assert.ok(report.entries.some(item => item.scopeBoundary === 'composer-goal-surface-frozen'));
    assert.ok(report.entries.some(item => item.scopeBoundary === 'chat-feedback-surface-frozen'));
    assert.ok(report.entries.some(item => item.scopeBoundary === 'chat-toolview-surface-frozen'));
    assert.ok(report.entries.some(item => item.scopeBoundary === 'settings-theme-surface-owned-by-main-thread'));
    assert.ok(report.entries.some(item => item.scopeBoundary === 'workspace-persistence-and-chat-entry-frozen'));
    assert.ok(report.entries.some(item => item.scopeBoundary === 'plugin-loader-runtime-shell-frozen'));
    assert.ok(report.entries.some(item => item.scopeBoundary === 'chat-session-provider-runtime-frozen'));
    assert.equal(report.nextCandidates.some(item => ['ui-goal', 'ui-message-feedback', 'ui-skill', 'ui-subagent', 'ui-trajectory', 'ui-workflow-run', 'ui-theme', 'ui-user-questions', 'ui-workspace', 'web', 'web-react'].includes(item.package)), false);
    assert.equal(report.nextCandidates.length, 0);
    assert.ok(report.entries.filter(item => item.relative.includes('ui-primitives/src/icons/index.tsx')).every(item => item.referenceContract === true));
    assert.equal(report.missingContracts.some(item => item.relative.includes('ui-primitives/src/icons/index.tsx')), false);
    assert.ok(report.surfacePatterns.some(item => item.pattern === 'ui-permission-presets' && item.composites > 0));
    assert.ok(report.surfacePatterns.some(item => item.frozenDomainSurfaces > 0));
});

test('Harness geometry audit reports source equivalence without hiding gaps', () => {
    execFileSync(process.execPath, ['scripts/check-harness-geometry-contracts.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-geometry-contracts.json'), 'utf8'));
    assert.ok(['geometry-evidence-gaps-present', 'source-equivalent'].includes(report.status));
    assert.ok(report.counts.contracts >= 20);
    assert.ok(report.checks.some(item => item.name === 'model-picker' && item.status === 'source-equivalent'));
    assert.ok(report.checks.find(item => item.name === 'model-picker')?.tokens.pass);
    assert.ok(report.checks.some(item => item.status !== 'source-equivalent'));
});

test('Model picker pixel diff remains pending or records a real mismatch', () => {
    execFileSync(process.execPath, ['scripts/diff-harness-vcp-model-picker-pixels.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-vcp-model-picker-pixel-diff.json'), 'utf8'));
    assert.equal(report.pass, false);
    assert.ok(['pending-screenshot-capture', 'pending-semantic-fixture-alignment', 'pixel-dimension-mismatch', 'compared'].includes(report.status));
    if (report.status === 'pending-screenshot-capture') {
        assert.ok(report.missingEvidence.includes('Harness ModelSelect capture report paired with screenshot') || report.missingEvidence.includes('Harness ModelSelect screenshot'));
    } else if (report.status === 'pending-semantic-fixture-alignment') {
        assert.ok(report.missingEvidence.includes('semantic fixture alignment'));
        assert.equal(report.semanticEquivalent, false);
    } else {
        assert.ok(report.missingEvidence.includes('same viewport dimensions') || report.missingEvidence.includes('pixel tolerance'));
    }
});

test('Harness capture freshness gate reports paired artifacts without promoting them', () => {
    execFileSync(process.execPath, ['scripts/check-harness-capture-freshness.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-capture-freshness.json'), 'utf8'));
    assert.ok(['capture-pairs-fresh', 'capture-pairs-incomplete'].includes(report.status));
    assert.equal(report.pass, report.checks.every(item => item.pass));
    assert.equal(report.note.includes('does not create'), true);
});

test('AgentPreset Select paired Harness/VCP evidence remains semantic-fixture scoped', () => {
    execFileSync(process.execPath, ['scripts/check-harness-fixture-evidence.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-vcp-fixture-evidence.json'), 'utf8'));
    assert.equal(report.pass, true);
    assert.equal(report.harnessSelectStatus, 'available');
    assert.equal(report.vcpBrowserSelectStatus, 'available');
    assert.equal(report.geometryStatus, 'cross-page-select-geometry-equivalent');
    assert.equal(report.geometryPass, true);
    assert.equal(report.pixelStatus, 'compared');
    assert.equal(report.pixelPass, true);
});

test('Paired evidence ledger keeps Candidate captures and blocked boundaries explicit', () => {
    execFileSync(process.execPath, ['scripts/check-harness-paired-evidence-boundaries.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-paired-evidence-boundaries.json'), 'utf8'));
    assert.equal(report.status, 'paired-evidence-scoped');
    assert.equal(report.pass, false);
    assert.equal(report.counts.pairedRoiPasses, 1);
    assert.equal(report.counts.vcpCandidateCaptures, 4);
    assert.equal(report.counts.candidateCaptureMissing, 0);
    assert.equal(report.pairedSelect.state, 'paired-roi-pass');
    assert.ok(report.pairedSelect.missingEvidence.includes('closed trigger'));
    assert.equal(report.candidateCaptures.every(item => item.state === 'vcp-candidate-capture-only' && item.captured), true);
    assert.ok(report.sourceOrConsumerBoundaries.some(item => item.state === 'consumer-boundary'));
    assert.equal(report.activeExternalBoundary.name, 'model-picker');
});

test('Harness capture prerequisites follow the real pnpm workspace resolver', () => {
    execFileSync(process.execPath, ['scripts/check-harness-capture-prerequisites.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-capture-prerequisites.json'), 'utf8'));
    assert.equal(report.status, 'capture-prerequisites-ready');
    assert.equal(report.pass, true);
    assert.equal(report.missing.length, 0);
    assert.equal(report.checks.find(item => item.name === 'Harness workspace Cordis source')?.exists, true);
    assert.equal(report.checks.find(item => item.name === 'Playwright resolver from Harness web')?.exists, true);
});

test('ConnectionBanner Candidate capture records DOM, geometry, states, and teardown', () => {
    execFileSync(process.execPath, ['scripts/capture-vcp-connection-banner-candidate.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/vcp-connection-banner-candidate.json'), 'utf8'));
    assert.equal(report.candidateStatus.includes('no VCP connection consumer'), true);
    assert.equal(report.connectedHidden.present, false);
    assert.equal(report.reconnectingVisible.present, true);
    assert.deepEqual(report.reconnectingVisible.aria, { role: 'status', live: 'polite' });
    assert.equal(report.reconnectingVisible.style.position, 'fixed');
    assert.equal(report.reconnectingVisible.style.padding, '4px 12px');
    assert.equal(report.labelUpdate.text, 'Reconnecting to Harness…');
    assert.equal(report.ownerRegistrations, 1);
});

test('Menu Candidate capture records portal, interaction states, and teardown', () => {
    execFileSync(process.execPath, ['scripts/capture-vcp-menu-candidate.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/vcp-menu-candidate.json'), 'utf8'));
    assert.equal(report.candidateStatus.includes('no VCP production consumer'), true);
    assert.equal(report.open.present, true);
    assert.equal(report.open.role, 'menu');
    assert.deepEqual(report.open.aria, { triggerHasPopup: 'menu', triggerExpanded: 'true' });
    assert.equal(report.open.style.position, 'fixed');
    assert.equal(report.open.items.filter(item => item.selected === 'true').length, 2);
    assert.deepEqual(report.submenuItems, ['List', 'Grid']);
    assert.equal(report.outsideClosed, true);
    assert.equal(report.escapeClosed, true);
});

test('OnboardingSurface Candidate capture records portal, inert lifecycle, and teardown', () => {
    execFileSync(process.execPath, ['scripts/capture-vcp-onboarding-surface-candidate.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/vcp-onboarding-surface-candidate.json'), 'utf8'));
    assert.equal(report.candidateStatus.includes('no VCP first-run consumer'), true);
    assert.deepEqual(report.closed, { present: false, rootInert: false, contentInRoot: true });
    assert.equal(report.open.present, true);
    assert.equal(report.open.rootInert, true);
    assert.equal(report.open.contentInRoot, false);
    assert.deepEqual(report.open.aria, { overlayRole: 'presentation', maskHidden: 'true' });
    assert.equal(report.open.style.overlay.position, 'fixed');
    assert.equal(report.open.style.mask.top, '80px');
    assert.equal(report.open.style.stage.justifyContent, 'center');
    assert.deepEqual(report.close, { present: false, rootInert: false, contentInRoot: true });
    assert.equal(report.reopen.present, true);
});

test('Pill Candidate capture records native states, hover, click, and teardown', () => {
    execFileSync(process.execPath, ['scripts/capture-vcp-pill-candidate.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/vcp-pill-candidate.json'), 'utf8'));
    assert.equal(report.candidateStatus.includes('no VCP production consumer'), true);
    assert.equal(report.static.tag, 'span');
    assert.equal(report.interactive.tag, 'button');
    assert.equal(report.interactive.type, 'button');
    assert.equal(report.static.style.display, 'inline-flex');
    assert.equal(report.static.style.height, '24px');
    assert.equal(report.static.style.padding, '0px 8px');
    assert.equal(report.active.className, 'vcp-harness-pill pill active');
    assert.equal(report.hover.interactive.style.backgroundColor, 'rgba(0, 0, 0, 0.06)');
    assert.equal(report.clicks, 1);
    assert.equal(report.ownerRegistrations, 4);
});

test('Harness reference pack validates fixture case shape while retaining pending candidates', () => {
    execFileSync(process.execPath, ['scripts/check-harness-reference-pack.mjs'], { cwd: root, stdio: 'pipe' });
    const matrix = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/fixture-matrix.json'), 'utf8'));
    assert.ok(matrix.cases.every(([primitive, state]) => typeof primitive === 'string' && primitive.length > 0 && typeof state === 'string' && state.length > 0));
    assert.ok(matrix.cases.some(([primitive]) => primitive === 'language-row'));
    assert.ok(matrix.cases.some(([primitive]) => primitive === 'permission-row'));
});

test('JobListAction source audit preserves lifecycle and ordering evidence', () => {
    execFileSync(process.execPath, ['scripts/check-harness-job-list-action-source.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-job-list-action-source.json'), 'utf8'));
    assert.equal(report.status, 'source-contract-pass');
    assert.equal(report.pass, true);
    assert.equal(report.checks.length, 10);
    assert.ok(report.note.includes('does not create a VCP jobs consumer'));
});

test('JobListAction reference audit preserves DOM and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-job-list-action-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-job-list-action-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '21/21');
    assert.equal(report.candidateStatus, 'source-only; no VCP jobs consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP jobs consumer or runtime registry'));
});

test('PermissionRow source audit preserves settings capability boundaries', () => {
    execFileSync(process.execPath, ['scripts/check-harness-permission-row-source.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-permission-row-source.json'), 'utf8'));
    assert.equal(report.status, 'source-contract-pass');
    assert.equal(report.pass, true);
    assert.equal(report.checks.length, 10);
    assert.ok(report.note.includes('does not create a VCP permission-settings consumer'));
});

test('PermissionRow reference audit preserves DOM and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-permission-row-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-permission-row-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '11/11');
    assert.equal(report.candidateStatus, 'source-only; no VCP permission-settings consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP permission-settings consumer'));
});

test('Harness fixture matrix guard preserves explicit Candidate boundaries', () => {
    execFileSync(process.execPath, ['scripts/check-harness-fixture-matrix.mjs'], { cwd: root, stdio: 'pipe' });
});

test('ProducedFiles source audit preserves frozen-domain measurement boundaries', () => {
    execFileSync(process.execPath, ['scripts/check-harness-produced-files-source.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-produced-files-source.json'), 'utf8'));
    assert.equal(report.status, 'source-contract-pass');
    assert.equal(report.pass, true);
    assert.equal(report.checks.length, 8);
    assert.ok(report.note.includes('does not create a VCP turn-tail consumer'));
});

test('ProducedFiles reference audit preserves DOM and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-produced-files-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-produced-files-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '23/23');
    assert.equal(report.candidateStatus, 'source-only frozen chat deliverables; no VCP production consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP turn-tail consumer'));
});

test('Harness fixture coverage reports contracts without replayable cases', () => {
    execFileSync(process.execPath, ['scripts/check-harness-fixture-coverage.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-fixture-coverage.json'), 'utf8'));
    assert.equal(report.status, 'coverage-scoped-complete');
    assert.equal(report.pass, false);
    assert.ok(report.counts.contracts > report.counts.contractsWithFixtures);
    assert.ok(report.uncoveredContracts.includes('settings-root'));
    assert.equal(report.counts.effectiveContractsWithFixtures, report.counts.contractsWithFixtures + 2);
    assert.deepEqual(report.candidateFixtureGaps, []);
    assert.ok(report.counts.scopeBlockedContracts > 0);
    assert.equal(report.uncoveredByBoundary.find(item => item.name === 'model-picker')?.category, 'covered-by-semantic-fixture-alias');
    assert.equal(report.uncoveredByBoundary.find(item => item.name === 'model-picker')?.fixture, 'agent-model-picker');
    assert.equal(report.uncoveredByBoundary.find(item => item.name === 'settings-root')?.category, 'source-only-boundary');
    assert.equal(report.uncoveredByBoundary.find(item => item.name === 'color-pair')?.category, 'vcp-local-contract');
    assert.ok(report.note.includes('no category implies production parity'));
});

test('MessageImage source audit preserves frozen attachment lifecycle evidence', () => {
    execFileSync(process.execPath, ['scripts/check-harness-message-image-source.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-message-image-source.json'), 'utf8'));
    assert.equal(report.status, 'source-contract-pass');
    assert.equal(report.pass, true);
    assert.equal(report.checks.length, 10);
    assert.ok(report.note.includes('does not create a VCP chat attachment consumer'));
});

test('MessageImage reference audit preserves DOM and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-message-image-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-message-image-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '30/30');
    assert.equal(report.candidateStatus, 'source-only frozen chat attachment; no VCP consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP chat attachment consumer'));
});

test('ImageGallery reference audit preserves aggregation and alignment provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-image-gallery-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-image-gallery-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '12/12');
    assert.equal(report.candidateStatus, 'source-only frozen chat attachment; no VCP consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP chat attachment consumer'));
});

test('PlanChip reference audit preserves projection and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-plan-chip-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-plan-chip-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '18/18');
    assert.equal(report.candidateStatus, 'source-only frozen Composer plan slot; no VCP consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP Composer consumer'));
});

test('JsonTree reference audit preserves tree semantics and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-json-tree-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-json-tree-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '33/33');
    assert.equal(report.candidateStatus, 'source-only frozen trajectory/tool inspection; no VCP structured-message consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP structured-message consumer'));
});

test('ReadBlock reference audit preserves source-window and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-read-block-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-read-block-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '28/28');
    assert.equal(report.candidateStatus, 'source-only frozen tool detail; no VCP consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP tool-detail consumer'));
});

test('SearchBlock reference audit preserves result-shape and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-search-block-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-search-block-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '29/29');
    assert.equal(report.candidateStatus, 'source-only frozen tool detail; no VCP consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP tool-detail consumer'));
});

test('TerminalBlock reference audit preserves command-state and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-terminal-block-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-terminal-block-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '32/32');
    assert.equal(report.candidateStatus, 'source-only frozen tool detail; no VCP consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP tool-detail consumer'));
});

test('WebBlock reference audit preserves retrieval-shape and geometry provenance', () => {
    execFileSync(process.execPath, ['scripts/check-harness-web-block-reference.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-web-block-reference.json'), 'utf8'));
    assert.equal(report.domContract, true);
    assert.equal(report.cssGeometry, '24/24');
    assert.equal(report.candidateStatus, 'source-only frozen tool detail; no VCP consumer or paired visual capture');
    assert.ok(report.evidenceGaps.includes('no VCP tool-detail consumer'));
});

test('Unified contract provenance gate reports every reference boundary', () => {
    execFileSync(process.execPath, ['scripts/check-harness-contract-provenance.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-contract-provenance.json'), 'utf8'));
    assert.ok(report.counts.contracts >= 49, 'new source-backed contracts must not be rejected by the baseline count');
    assert.equal(report.counts.sourceKindDeclared > 0, true);
    assert.ok(report.counts.sourceKinds['vcp-local-contract'] >= 2);
    assert.equal(report.entries.find(item => item.name === 'range')?.sourceKind, 'vcp-local-contract');
    for (const name of ['range', 'toggle', 'color-pair']) {
        const entry = report.entries.find(item => item.name === name);
        assert.equal(entry?.pass, true, `${name} must remain a declared VCP-local boundary rather than a missing Harness path`);
        assert.equal(entry?.provenance[0]?.kind, 'local-contract');
        assert.equal(entry?.provenance[0]?.evidence, 'declared-vcp-local-boundary');
    }
    assert.equal(report.status, 'provenance-complete');
    assert.equal(report.pass, true);
    assert.equal(report.counts.gaps, 0);
    assert.deepEqual(report.gaps, []);
    assert.ok(report.entries.some(item => item.pass === true));
});
