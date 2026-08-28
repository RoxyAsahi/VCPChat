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
    assert.equal(report.status, 'inventory-gaps-present');
    assert.ok(report.counts.portablePrimitives > 0);
    assert.ok(report.counts.composites > 0);
    assert.ok(report.counts.frozenDomainSurfaces > 0);
    assert.ok(report.counts.missingContracts > 0);
    assert.ok(report.entries.some(item => item.name === 'ModelSelect' && item.category === 'composite-surface'));
    assert.ok(report.entries.some(item => item.category === 'frozen-domain-surface'));
    assert.ok(report.nextCandidates.length > 0);
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
    assert.equal(report.status, 'coverage-gaps-present');
    assert.equal(report.pass, false);
    assert.ok(report.counts.contracts > report.counts.contractsWithFixtures);
    assert.ok(report.uncoveredContracts.includes('settings-root'));
    assert.ok(report.note.includes('does not imply a replayable visual fixture'));
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
    assert.equal(report.counts.contracts, 49);
    assert.equal(report.status, 'provenance-gaps-present');
    assert.equal(report.pass, false);
    assert.ok(report.counts.gaps > 0);
    assert.ok(report.gaps.some(item => item.includes('missing candidateStatus boundary')));
    assert.ok(report.entries.some(item => item.pass === true));
});
