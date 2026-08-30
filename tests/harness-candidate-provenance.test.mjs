import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cases = [
  ['agent-preset-seat', 'scripts/check-harness-agent-preset-seat-source-provenance.mjs', 'reports/harness-agent-preset-seat-source-provenance.json'],
  ['agent-preset-row', 'scripts/check-harness-agent-preset-row-source-provenance.mjs', 'reports/harness-agent-preset-row-source-provenance.json'],
  ['popup-select', 'scripts/check-harness-popup-select-source-provenance.mjs', 'reports/harness-popup-select-source-provenance.json'],
];

test('Harness Candidate provenance guards remain source-backed and non-promoting', () => {
  for (const [name, script, reportFile] of cases) {
    execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' });
    const report = JSON.parse(fs.readFileSync(path.join(root, reportFile), 'utf8'));
    assert.equal(report.pass, false, `${name} must remain Candidate-only`);
    assert.ok(Array.isArray(report.files), `${name} must record source files`);
    assert.equal(report.files.every(file => file.pass), true, `${name} source anchors drifted`);
    assert.ok(report.candidate?.present, `${name} Candidate capture must be recorded`);
    assert.ok(report.missingEvidence.length > 0, `${name} must retain open evidence gaps`);
  }
});
