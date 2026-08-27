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
    assert.ok(report.primitives.some(item => item.name === 'model-picker'));
    assert.ok(report.primitives.some(item => item.name === 'field' && item.provenance.some(source => source.declared.endsWith('ModelsSection.tsx'))));
    assert.ok(report.missingEvidence.includes('select/busy-trigger-disabled: blocked-vcp-consumer'));
    assert.ok(report.missingEvidence.includes('language-row/open-select-dismiss-focus-dispose: candidate-source-only'));
    assert.equal(report.nextCandidate, 'select/busy-trigger-disabled');
});

test('Model picker diff reports pending or compares when a Harness capture exists', () => {
    execFileSync(process.execPath, ['scripts/diff-harness-vcp-model-picker.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-vcp-model-picker-diff.json'), 'utf8'));
    assert.ok(['pending-harness-capture', 'harness-capture-available-pixel-pending'].includes(report.status));
    assert.equal(report.dom.ariaContractPass, true);
    assert.equal(report.dom.deviations[0].declared, true);
    if (report.status === 'pending-harness-capture') {
        assert.equal(report.pass, false);
        assert.equal(report.dom.structuralPass, false);
        assert.ok(report.missingEvidence.includes('Candidate DOM/ARIA structural contract'));
        assert.ok(report.missingEvidence.includes('Harness ModelSelect browser capture (DOM + computed style)'));
        assert.ok(report.missingEvidence.includes('Candidate computed-style contract'));
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
