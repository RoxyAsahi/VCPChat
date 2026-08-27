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

test('Model picker diff stays pending until a Harness capture exists', () => {
    execFileSync(process.execPath, ['scripts/diff-harness-vcp-model-picker.mjs'], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-vcp-model-picker-diff.json'), 'utf8'));
    assert.equal(report.status, 'pending-harness-capture');
    assert.equal(report.pass, false);
    assert.equal(report.dom.ariaContractPass, true);
    assert.ok(report.missingEvidence.includes('Harness ModelSelect browser capture (DOM + computed style)'));
    assert.ok(report.missingEvidence.includes('Candidate computed-style contract'));
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
    assert.ok(report.checks.some(item => item.status !== 'source-equivalent'));
});
