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
    const largeDirectory = path.join(tempRoot, 'large');
    fs.mkdirSync(largeDirectory);
    for (let index = 0; index < 10_000; index += 1) {
        const name = index === 9_999 ? 'needle-9999.txt' : `file-${String(index).padStart(5, '0')}.txt`;
        fs.writeFileSync(path.join(largeDirectory, name), '');
    }
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
    assert.equal(preview.kind, 'markdown');
    assert.equal(preview.content, '# Worksp');
    assert.equal(preview.truncated, true);
    assert.equal(preview.editable, false);
    assert.equal((await service.readPreview({ sessionId: 'session-a', relativePath: 'binary.bin' })).kind, 'binary');

    const editingService = new AgentWorkspaceService({
        getSession: (sessionId) => sessionId === 'session-a' ? { sessionId, workspaceRoot: tempRoot } : null,
        limits: { maxPreviewBytes: 1024, maxEditableBytes: 1024 },
    });
    const editable = await editingService.readPreview({ sessionId: 'session-a', relativePath: 'README.md' });
    assert.equal(editable.editable, true);
    const saved = await editingService.saveText({
        sessionId: 'session-a', workspaceRevision: editable.workspaceRevision, relativePath: 'README.md',
        content: '# Updated\n', expectedContentRevision: editable.contentRevision,
    });
    assert.equal(saved.content, '# Updated\n');
    assert.notEqual(saved.contentRevision, editable.contentRevision);
    await assert.rejects(() => editingService.saveText({
        sessionId: 'session-a', workspaceRevision: editable.workspaceRevision, relativePath: 'README.md',
        content: '# Stale overwrite\n', expectedContentRevision: editable.contentRevision,
    }), (error) => error.code === 'WORKSPACE_EDIT_CONFLICT');

    const watchEvents = [];
    const watched = await editingService.watch({ sessionId: 'session-a', watchId: 'watch-a' }, (event) => watchEvents.push(event));
    fs.writeFileSync(path.join(tempRoot, '.README.md.vchat-123e4567-e89b-12d3-a456-426614174000.tmp'), 'temporary', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'src', 'watched.txt'), 'watch me', 'utf8');
    const watchDeadline = Date.now() + 3_000;
    while (!watchEvents.some((event) => event.relativePath === 'src/watched.txt') && Date.now() < watchDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(watchEvents.some((event) => event.relativePath === 'src/watched.txt' && event.sessionId === 'session-a'),
        'workspace watcher must emit Session-scoped relative paths');
    assert.equal(watchEvents.some((event) => event.relativePath?.includes('.vchat-')), false,
        'workspace watcher must ignore VChat atomic-save temporary files');
    fs.rmSync(path.join(tempRoot, '.README.md.vchat-123e4567-e89b-12d3-a456-426614174000.tmp'), { force: true });
    assert.deepEqual(await editingService.unwatch({ sessionId: 'session-a', watchId: watched.watchId }), {
        stopped: true, watchId: 'watch-a',
    });

    const search = await service.searchFiles({ sessionId: 'session-a', query: 'alpha' });
    assert.deepEqual(search.entries.map((entry) => entry.relativePath), ['src/alpha.js']);

    const stressService = new AgentWorkspaceService({
        getSession: (sessionId) => sessionId === 'session-a' ? { sessionId, workspaceRoot: tempRoot } : null,
        limits: { maxDirectoryEntries: 1000, maxSearchResults: 20, maxSearchEntries: 20_000, operationTimeoutMs: 30_000 },
    });
    const stressStart = performance.now();
    const largePage = await stressService.listDirectory({ sessionId: 'session-a', relativePath: 'large', limit: 1000 });
    assert.equal(largePage.entries.length, 1000);
    assert.equal(largePage.nextCursor, '1000');
    assert.equal(largePage.truncated, true);
    const largeSearch = await stressService.searchFiles({ sessionId: 'session-a', query: 'needle-9999', limit: 20 });
    assert.deepEqual(largeSearch.entries.map((entry) => entry.relativePath), ['large/needle-9999.txt']);
    assert.ok(performance.now() - stressStart < 30_000, '10k workspace fixture must remain within the bounded operation budget');

    // Search work is cooperatively abortable and uses a scheduler independent
    // from directory/preview operations. Delay the real root read so both the
    // concurrency ceiling and cancellation path are deterministic.
    const originalReaddir = fs.promises.readdir;
    const delayedReads = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    let trackTimedTraversal = false;
    let timedTraversalReadsAfterRoot = 0;
    fs.promises.readdir = async (...args) => {
        if (path.resolve(String(args[0])) !== path.resolve(tempRoot)) {
            if (trackTimedTraversal) timedTraversalReadsAfterRoot += 1;
            return originalReaddir(...args);
        }
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await new Promise((resolve) => delayedReads.push(resolve));
        try { return await originalReaddir(...args); }
        finally { activeReads -= 1; }
    };
    const waitForDelayedRead = async (count = 1) => {
        const deadline = Date.now() + 2_000;
        while (delayedReads.length < count && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.ok(delayedReads.length >= count, 'workspace fixture read did not enter the delayed section');
    };
    try {
        const cancellable = new AgentWorkspaceService({
            getSession: (sessionId) => sessionId === 'session-a' ? { sessionId, workspaceRoot: tempRoot } : null,
            limits: { maxConcurrentSearches: 1, operationTimeoutMs: 5_000 },
        });
        const firstSearch = cancellable.searchFiles({ sessionId: 'session-a', requestId: 'search-one', query: 'README', limit: 1 });
        await waitForDelayedRead();
        const secondSearch = cancellable.searchFiles({ sessionId: 'session-a', requestId: 'search-two', query: 'README', limit: 1 });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(delayedReads.length, 1, 'the search scheduler must not exceed its configured concurrency');
        assert.throws(() => cancellable.cancel({ sessionId: 'session-b', requestId: 'search-one' }),
            (error) => error.code === 'WORKSPACE_SESSION_MISMATCH',
            'one Session must not cancel another Session workspace request');
        assert.deepEqual(cancellable.cancel({ sessionId: 'session-a', requestId: 'search-one' }), {
            cancelled: true, requestId: 'search-one',
        });
        delayedReads.shift()();
        await assert.rejects(firstSearch, (error) => error.code === 'WORKSPACE_CANCELLED');
        await waitForDelayedRead();
        assert.equal(maxActiveReads, 1, 'cancelled search cleanup must release the scheduler before the next search starts');
        delayedReads.shift()();
        assert.deepEqual((await secondSearch).entries.map((entry) => entry.relativePath), ['README.md']);

        const timed = new AgentWorkspaceService({
            getSession: (sessionId) => sessionId === 'session-a' ? { sessionId, workspaceRoot: tempRoot } : null,
            limits: { maxConcurrentSearches: 1, operationTimeoutMs: 10 },
        });
        trackTimedTraversal = true;
        const timedSearch = timed.searchFiles({ sessionId: 'session-a', requestId: 'search-timeout', query: 'README', limit: 1 });
        await waitForDelayedRead();
        await new Promise((resolve) => setTimeout(resolve, 25));
        delayedReads.shift()();
        await assert.rejects(timedSearch, (error) => error.code === 'WORKSPACE_TIMEOUT');
        trackTimedTraversal = false;
        assert.equal(timed.operations.size, 0, 'a timed-out traversal must release its operation record');
        assert.equal(timedTraversalReadsAfterRoot, 0,
            'a timed-out traversal must stop after the in-flight directory read returns');
    } finally {
        fs.promises.readdir = originalReaddir;
    }

    const originalOpen = fs.promises.open;
    let releasePreviewRead;
    let previewReadEntered = false;
    let previewHandleClosed = 0;
    fs.promises.open = async (...args) => {
        if (path.resolve(String(args[0])) !== path.resolve(path.join(tempRoot, 'README.md'))) return originalOpen(...args);
        return {
            async read(buffer) {
                previewReadEntered = true;
                await new Promise((resolve) => { releasePreviewRead = resolve; });
                Buffer.from('# Workspace\nhello\n').copy(buffer);
                return { bytesRead: Math.min(buffer.length, 18), buffer };
            },
            async close() { previewHandleClosed += 1; },
        };
    };
    try {
        const timedPreviewService = new AgentWorkspaceService({
            getSession: (sessionId) => sessionId === 'session-a' ? { sessionId, workspaceRoot: tempRoot } : null,
            limits: { maxPreviewBytes: 64, operationTimeoutMs: 10 },
        });
        const timedPreview = timedPreviewService.readPreview({
            sessionId: 'session-a', requestId: 'preview-timeout', relativePath: 'README.md',
        });
        const previewDeadline = Date.now() + 2_000;
        while (!previewReadEntered && Date.now() < previewDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(previewReadEntered, true, 'preview fixture must enter the delayed file read');
        await new Promise((resolve) => setTimeout(resolve, 25));
        releasePreviewRead();
        await assert.rejects(timedPreview, (error) => error.code === 'WORKSPACE_TIMEOUT');
        assert.equal(previewHandleClosed, 1, 'a timed-out preview must close its file handle exactly once');
        assert.equal(timedPreviewService.operations.size, 0);
    } finally {
        fs.promises.open = originalOpen;
    }

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
