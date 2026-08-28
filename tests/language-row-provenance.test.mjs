import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('LanguageRow provenance remains source-only without locale consumer', () => {
  execFileSync(process.execPath, ['scripts/check-harness-language-row-source-provenance.mjs'], { cwd: root, stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-language-row-source-provenance.json'), 'utf8'));
  assert.equal(report.files.length, 3);
  assert.equal(report.files.every(file => file.pass), true);
  assert.equal(report.reference.dom, true);
  assert.equal(report.reference.geometry, true);
  assert.equal(report.candidate.present, true);
  assert.equal(report.candidate.shape, true);
  assert.equal(report.pass, false);
  assert.equal(report.browserEvidence.directCaptureAttempt.status, 'blocked-complete-harness-composition-required');
  assert.ok(report.missingEvidence.some(item => item.includes('complete locale/slot/runtime composition')));
  assert.ok(report.missingEvidence.some(item => item.includes('persisted UI-language key')));
});
