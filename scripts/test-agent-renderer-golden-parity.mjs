import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function render(mode) {
    const result = spawnSync(process.execPath, ['scripts/fixtures/render-message-contract-child.mjs', mode], {
        cwd: process.cwd(),
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${mode} renderer child failed:\n${result.stdout}\n${result.stderr}`);
    const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('CONTRACT_JSON:'));
    assert.ok(line, `${mode} renderer emitted no contract JSON`);
    return JSON.parse(line.slice('CONTRACT_JSON:'.length));
}

const main = render('main');
const fork = render('fork');
assert.deepEqual(fork, main, 'Agent Fork must match the normalized main-chat DOM contract');
console.log('Main-chat and Agent full-fork golden DOM parity tests passed.');
