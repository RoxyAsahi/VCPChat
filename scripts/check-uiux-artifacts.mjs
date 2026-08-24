import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedRoot = path.join(root, 'modules', 'uiux', 'generated');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-uiux-artifacts-'));
const tempGenerated = path.join(tempRoot, 'generated');

async function filesUnder(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await filesUnder(full)));
        else if (/\.(?:js|d\.ts)$/.test(entry.name)) files.push(full);
    }
    return files;
}

try {
    execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
        '--project', path.join(root, 'tsconfig.uiux.build.json'),
        '--outDir', tempGenerated,
        '--pretty', 'false'], { cwd: root, stdio: 'pipe' });
    const [expected, actual] = await Promise.all([filesUnder(generatedRoot), filesUnder(tempGenerated)]);
    const expectedRel = expected.map(file => path.relative(generatedRoot, file)).sort();
    const actualRel = actual.map(file => path.relative(tempGenerated, file)).sort();
    assert.deepEqual(actualRel, expectedRel, 'generated UIUX file set differs from a clean build');
    for (const relative of expectedRel) {
        const [committed, rebuilt] = await Promise.all([
            fs.readFile(path.join(generatedRoot, relative)),
            fs.readFile(path.join(tempGenerated, relative)),
        ]);
        assert.deepEqual(rebuilt, committed, `generated UIUX artifact is stale: ${relative}`);
    }
    console.log(`UIUX artifact consistency passed (${expectedRel.length} generated files).`);
} finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
}
