import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('AgentPresetSection provenance remains reference-only without a VCP consumer', () => {
  execFileSync(process.execPath, ['scripts/check-harness-agent-preset-section-source-provenance.mjs'], { cwd: root, stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-agent-preset-section-source-provenance.json'), 'utf8'));
  assert.equal(report.files.length, 2);
  assert.equal(report.files.every(file => file.pass), true);
  assert.equal(report.reference.dom, true);
  assert.equal(report.reference.geometry, true);
  assert.equal(report.candidate.present, false);
  assert.equal(report.pass, false);
  assert.ok(report.contract.states.includes('dispose'));
  assert.ok(report.missingEvidence.some(item => item.includes('computed-style diff')));
});
