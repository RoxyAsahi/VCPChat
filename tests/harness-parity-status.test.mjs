import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const run = script => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' });

test('Harness parity status accounts for scope without promoting Candidate evidence', () => {
  run('scripts/scan-harness-ui-inventory.mjs');
  run('scripts/check-harness-fixture-coverage.mjs');
  run('scripts/check-harness-candidate-capture-gaps.mjs');
  run('scripts/check-harness-parity-status.mjs');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-parity-status.json'), 'utf8'));

  assert.equal(report.status, 'parity-scope-accounted');
  assert.equal(report.pass, false, 'scope accounting must never claim production parity');
  assert.equal(report.inventory.counts.missingContracts, 0);
  assert.equal(report.coverage.counts.candidateFixtureGaps, 0);
  assert.ok(report.inventory.counts.scopeBlockedSurfaces > 0);
  assert.ok(report.coverage.counts.scopeBlockedContracts > 0);
  assert.equal(report.candidateCaptureGaps.counts.captureGaps, 4);
  assert.equal(report.provenanceGuards.length, 12);
  assert.equal(report.provenanceGuards.every(guard => guard.present && guard.pass === false), true);
  assert.equal(report.provenanceGuards.find(guard => guard.name === 'language-row')?.present, true);
  assert.equal(report.provenanceGuards.find(guard => guard.name === 'agent-preset-label')?.present, true);
  assert.equal(report.provenanceGuards.find(guard => guard.name === 'agent-preset-section')?.present, true);
  assert.equal(report.provenanceGuards.find(guard => guard.name === 'workspace-browser')?.present, true);
  assert.equal(report.provenanceGuards.find(guard => guard.name === 'settings-root')?.present, true);
  assert.equal(report.provenanceGuards.find(guard => guard.name === 'sidebar-root')?.present, true);
  assert.equal(report.provenanceGuards.find(guard => guard.name === 'input')?.present, true);
  assert.equal(report.provenanceGuards.find(guard => guard.name === 'preset-menu')?.present, true);
  assert.ok(report.openBoundaries.some(boundary => boundary.includes('non-promoting')));
});
