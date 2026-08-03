import assert from 'node:assert/strict';
import { createWorkspaceTreeModel } from '../modules/ui-system/agent-workspace-model.js';
import { createWorkspaceRequestCoordinator } from '../modules/ui-system/agent-workspace-requests.js';
import { createAgentWorkspaceCoordinator } from '../modules/ui-system/agent-workspace-coordinator.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

const calls = new Map();
const browser = {
    scope: 'session-a:workspace',
    sessionId: 'session-a',
    workspaceRevision: 'r1',
    model: createWorkspaceTreeModel(),
    inflight: new Map(),
    inflightRequestIds: new Map(),
    previewRequestId: '',
    searchRequestId: '',
    error: '',
    preview: null,
    previewLoading: false,
    search: '',
    searchResults: [],
    searchLoading: false,
    selectedPath: '',
};
const requests = createWorkspaceRequestCoordinator({ cancel() {} });
const lifecycle = { timeout(_key, callback) { callback(); return 1; } };
const coordinator = createAgentWorkspaceCoordinator({
    browser,
    requests,
    lifecycle,
    getIdentity: () => ({ sessionId: 'session-a', workspaceRoot: 'workspace' }),
    clearAttachments() {},
    refresh() {},
    notify() {},
    client: {
        readPreview(request) {
            const pending = deferred();
            calls.set(request.relativePath, pending);
            return pending.promise;
        },
        listDirectory: async () => ({ workspaceRevision: 'r1', entries: [] }),
        performPathAction: async () => ({}),
        searchFiles: async () => ({ workspaceRevision: 'r1', entries: [] }),
    },
});

const ref = (relativePath) => ({
    sessionId: 'session-a',
    workspaceRevision: 'r1',
    relativePath,
    kind: 'file',
    source: 'tree',
});
const first = coordinator.openPreview(ref('a.txt')).catch(() => null);
const second = coordinator.openPreview(ref('b.txt'));
calls.get('b.txt').resolve({ relativePath: 'b.txt', workspaceRevision: 'r1', content: 'B' });
await second;
assert.equal(browser.preview.relativePath, 'b.txt');
assert.equal(browser.previewLoading, false);

calls.get('a.txt').resolve({ relativePath: 'a.txt', workspaceRevision: 'r1', content: 'A' });
await first;
assert.equal(browser.preview.relativePath, 'b.txt', 'stale preview success must not replace the latest preview');
assert.equal(browser.previewLoading, false, 'stale preview finally must not clear a newer request state');
assert.equal(browser.error, '');

const staleFailure = coordinator.openPreview(ref('c.txt')).catch(() => null);
const latest = coordinator.openPreview(ref('d.txt'));
calls.get('d.txt').resolve({ relativePath: 'd.txt', workspaceRevision: 'r1', content: 'D' });
await latest;
calls.get('c.txt').reject(new Error('stale C failure'));
await staleFailure;
assert.equal(browser.preview.relativePath, 'd.txt', 'stale preview failure must not replace latest data');
assert.equal(browser.error, '', 'stale preview failure must not publish an error for the latest request');
assert.equal(browser.previewLoading, false);

coordinator.dispose();
console.log('Agent Workspace coordinator stale-response tests passed.');
