import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const run = script => execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' });

test('DisclosureRow source/Candidate evidence records alignment without production promotion', () => {
  run('scripts/capture-harness-disclosure-row-source-fixture.mjs');
  run('scripts/diff-harness-vcp-disclosure-row.mjs');
  run('scripts/check-harness-disclosure-row-source-provenance.mjs');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-disclosure-row-source.json'), 'utf8'));
  const diff = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-vcp-disclosure-row-diff.json'), 'utf8'));
  const guard = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-disclosure-row-source-provenance.json'), 'utf8'));

  assert.equal(source.status, 'harness-source-component-capture');
  assert.deepEqual(source.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
  assert.equal(source.rowOpen.row.ariaExpanded, 'true');
  assert.equal(source.keyboardClosed.row.ariaExpanded, 'false');
  assert.equal(source.leadingClosed.leading.tag, 'BUTTON');
  assert.deepEqual(source.unmounted, { rootEmpty: true, rows: 0 });
  assert.equal(diff.semanticFixture.pass, true);
  assert.equal(diff.dom.structuralPass, true);
  assert.equal(diff.computedStyle.pass, true);
  assert.equal(diff.pixel.status, 'compared');
  assert.equal(diff.pixel.comparable, true);
  assert.ok(diff.pixel.differentPixels > 0, 'the baseline must preserve the measured visual mismatch');
  assert.equal(diff.pass, false, 'aligned Candidate evidence must not become production parity');
  assert.equal(guard.sourceCapture.shape, true);
  assert.equal(guard.diff.shape, true);
  assert.equal(guard.pass, false);
  assert.ok(guard.missingEvidence.some(item => item.includes('production consumer')));
});
