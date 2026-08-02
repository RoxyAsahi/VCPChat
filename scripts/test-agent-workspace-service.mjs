import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentWorkspaceService } = require('../modules/codex-runtime/workspaceService.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-workspace-'));
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-outside-'));
try {
    fs.mkdirSync(path.join(tempRoot, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'README.md'), '# Workspace\nhello\n', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'src', 'zeta.js'), 'console.log("zeta");\n', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'src', 'alpha.js'), 'console.log("alpha");\n', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
    try { fs.symlinkSync(outsideRoot, path.join(tempRoot, 'escape'), 'junction'); } catch {}

    const clipboardWrites = [];
    const shellCalls = [];
    const service = new AgentWorkspaceService({
        getSession: (sessionId) => sessionId === 'session-a' ? { sessionId, workspaceRoot: tempRoot } : null,
        clipboard: { writeText: (value) => clipboardWrites.push(value) },
        shell: {
            showItemInFolder: (value) => shellCalls.push(['reveal', value]),
            openPath: async (value) => { shellCalls.push(['open', value]); return ''; },
        },
        confirmOpen: async () => true,
        limits: { maxDirectoryEntries: 2, maxPreviewBytes: 8, maxSearchResults: 10 },
    });

    const first = await service.listDirectory({ sessionId: 'session-a', relativePath: '' });
    assert.equal(first.entries.length, 2);
    assert.equal(first.entries[0].kind, 'directory');
    assert.ok(first.nextCursor);
    const second = await service.listDirectory({ sessionId: 'session-a', relativePath: '', cursor: first.nextCursor });
    assert.ok(second.entries.length > 0);
    assert.equal(second.workspaceRevision, first.workspaceRevision);

    const source = await service.listDirectory({ sessionId: 'session-a', relativePath: 'src', limit: 10 });
    assert.deepEqual(source.entries.map((entry) => entry.name), ['nested', 'alpha.js']);
    assert.equal(source.truncated, true);

    const preview = await service.readPreview({ sessionId: 'session-a', workspaceRevision: first.workspaceRevision, relativePath: 'README.md' });
    assert.equal(preview.kind, 'text');
    assert.equal(preview.content, '# Worksp');
    assert.equal(preview.truncated, true);
    assert.equal((await service.readPreview({ sessionId: 'session-a', relativePath: 'binary.bin' })).kind, 'binary');

    const search = await service.searchFiles({ sessionId: 'session-a', query: 'alpha' });
    assert.deepEqual(search.entries.map((entry) => entry.relativePath), ['src/alpha.js']);

    await service.performPathAction({ sessionId: 'session-a', workspaceRevision: first.workspaceRevision, relativePath: 'README.md', action: 'copy-relative-path' });
    await service.performPathAction({ sessionId: 'session-a', workspaceRevision: first.workspaceRevision, relativePath: 'README.md', action: 'reveal-in-explorer' });
    assert.deepEqual(clipboardWrites, ['README.md']);
    assert.equal(shellCalls[0][0], 'reveal');

    for (const relativePath of ['../secret.txt', 'C:/Windows/System32', '\\\\server\\share\\x', '/etc/passwd']) {
        await assert.rejects(() => service.readPreview({ sessionId: 'session-a', relativePath }), /not allowed|traversal/i);
    }
    await assert.rejects(() => service.readPreview({ sessionId: 'missing', relativePath: 'README.md' }), /not found/i);
    await assert.rejects(() => service.readPreview({ sessionId: 'session-a', workspaceRevision: 'stale', relativePath: 'README.md' }), /stale/i);
    if (fs.existsSync(path.join(tempRoot, 'escape'))) {
        await assert.rejects(() => service.readPreview({ sessionId: 'session-a', relativePath: 'escape/secret.txt' }), /escapes workspace root/i);
    }

    console.log('Agent workspace service tests passed.');
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
}
