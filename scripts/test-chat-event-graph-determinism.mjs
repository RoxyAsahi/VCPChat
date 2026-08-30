import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcpchat-event-graph-'));
const output = path.join(tempDir, 'graph.json');
const run = spawnSync(process.execPath, ['scripts/build-chat-event-graph.mjs'], {
    cwd: root,
    env: { ...process.env, VCPCHAT_GRAPH_OUTPUT: output },
    encoding: 'utf8',
});
assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
const first = fs.readFileSync(output, 'utf8');
const secondRun = spawnSync(process.execPath, ['scripts/build-chat-event-graph.mjs'], {
    cwd: root,
    env: { ...process.env, VCPCHAT_GRAPH_OUTPUT: output },
    encoding: 'utf8',
});
assert.equal(secondRun.status, 0, `${secondRun.stderr}\n${secondRun.stdout}`);
assert.equal(fs.readFileSync(output, 'utf8'), first, 'event graph generation must be byte deterministic');
console.log('Chat event graph determinism passed.');
