import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('WorkspaceBrowser provenance remains source-only at the frozen sidebar boundary', () => {
  execFileSync(process.execPath, ['scripts/check-harness-workspace-browser-source-provenance.mjs'], { cwd: root, stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-workspace-browser-source-provenance.json'), 'utf8'));
  assert.equal(report.files.length, 4);
  assert.equal(report.files.every(file => file.pass), true);
  assert.equal(report.reference.dom, true);
  assert.equal(report.reference.geometry, true);
  assert.equal(report.candidate.present, false);
  assert.equal(report.pass, false);
  assert.ok(report.contract.states.includes('remote-search-abort'));
  assert.ok(report.contract.states.includes('collapse-unmount'));
  assert.ok(report.missingEvidence.some(item => item.includes('wide/rail/search/drag')));
});
