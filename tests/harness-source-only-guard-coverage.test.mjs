import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
test('every source-only Harness candidate has a non-promoting provenance guard', () => {
  execFileSync(process.execPath, ['scripts/scan-harness-ui-inventory.mjs'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/check-harness-source-only-guard-coverage.mjs'], { cwd: root, stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(path.join(root, 'reports/harness-source-only-guard-coverage.json'), 'utf8'));
  assert.equal(report.pass, true);
  assert.ok(report.sourceOnlyCount >= 5);
  assert.equal(report.entries.every(entry => entry.present && entry.nonPromoting), true);
});
