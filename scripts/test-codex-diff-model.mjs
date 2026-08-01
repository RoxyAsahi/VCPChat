import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countPatchLines, normalizeCodexFileChanges } = require('../modules/codex-runtime/diffModel.js');

assert.deepEqual(countPatchLines('--- a/a\n+++ b/a\n-old\n+new\n same'), { additions: 1, deletions: 1 });
const model = normalizeCodexFileChanges([
    { path: 'src/a.ts', kind: 'update', diff: '@@\n-old\n+new\n' },
    { path: 'src/b.ts', kind: 'add', diff: '+created\n' },
]);
assert.deepEqual(model.files.map((file) => [file.path, file.status, file.additions, file.deletions]), [
    ['src/a.ts', 'modified', 1, 1], ['src/b.ts', 'added', 1, 0],
]);
assert.equal(model.additions, 2);
assert.equal(model.deletions, 1);
assert.equal(normalizeCodexFileChanges([{ path: '', diff: '+ignored' }]).files.length, 0);
assert.equal(normalizeCodexFileChanges([{ path: 'big', diff: '+'.repeat(200_000) }]).files[0].truncated, true);
console.log('Codex file-change diff model tests passed.');
