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
