import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';

test('consumer inventory excludes local probes and nested worktrees while retaining product descendants', () => {
    const source = fs.readFileSync(new URL('../scripts/check-chat-kernel-consumers.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('const ignoredProductionDirectoryNames');
    const end = source.indexOf('productionFiles.sort();', start);
    assert.ok(start >= 0 && end > start, 'exercise the actual production collector');
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-consumer-'));
    try {
        for (const file of ['main.js', 'modules/nested/controller.js', 'workspace/model.js', 'work/probe.html', 'work/another-checkout/renderer.js', 'outputs/evidence/view.html', 'scratch/probe.js', 'node_modules/package/index.js']) {
            const target = path.join(fixture, file);
            fs.mkdirSync(path.dirname(target), {recursive:true});
            fs.writeFileSync(target, 'window.testConsumer = true;');
        }
        const actual = vm.runInNewContext(source.slice(start, end) + '\nproductionFiles.sort(); productionFiles;', {fs, path, root:fixture});
        assert.deepEqual(Array.from(actual), ['main.js', 'modules/nested/controller.js', 'workspace/model.js']);
    } finally {
        assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(fixture).startsWith('handoff-consumer-'));
        fs.rmSync(fixture, {recursive:true,force:true});
    }
});
