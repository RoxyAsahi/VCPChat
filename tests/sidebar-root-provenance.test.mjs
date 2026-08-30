import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
test('SidebarRoot provenance remains source-only while shell ownership is frozen', () => {
  execFileSync(process.execPath, ['scripts/check-harness-sidebar-root-source-provenance.mjs'], { cwd: root, stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-sidebar-root-source-provenance.json'), 'utf8'));
  assert.equal(report.files.length, 4);
  assert.equal(report.files.every(file => file.pass), true);
  assert.equal(report.reference.dom, true);
  assert.equal(report.reference.geometry, true);
  assert.equal(report.candidate.present, false);
  assert.equal(report.pass, false);
  assert.ok(report.contract.states.includes('pointer-scrollbars-visible'));
  assert.ok(report.missingEvidence.some(item => item.includes('cross-platform Electron')));
});
