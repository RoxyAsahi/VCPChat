import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('MiMo clone distribution includes documented reference assets', async () => {
    const directory = path.join(root, 'AppData', 'mimotts');
    const readme = await fs.readFile(path.join(directory, 'README.md'), 'utf8');
    assert.match(readme, /MiMo TTS 克隆参考音频/);
    assert.match(readme, /克隆模型按官方协议/);

    for (const filename of ['aemeath.wav', 'nova.wav']) {
        const stat = await fs.stat(path.join(directory, filename));
        assert.ok(stat.isFile(), `${filename} must be shipped as a regular file`);
        assert.ok(stat.size > 1024, `${filename} must contain a usable reference recording`);
    }

    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    assert.match(gitignore, /!AppData\/mimotts\//);
    assert.match(gitignore, /!AppData\/mimotts\/\*\*/);
});
