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
    previewMode: 'preview',
    editDraft: '',
    editBaseRevision: '',
    editDirty: false,
    editSaving: false,
    editError: '',
    sessionStates: new Map(),
    pendingExpanded: [],
    splitPercent: 50,
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

const savePending = deferred();
const sessionBrowser = {
    ...browser,
    scope: 'session-a:workspace-a',
    sessionId: 'session-a',
    workspaceRevision: 'r1',
    selectedPath: 'draft.txt',
    preview: { relativePath: 'draft.txt', content: 'old', contentRevision: 'old-revision' },
    editDraft: 'new',
    editBaseRevision: 'old-revision',
    editDirty: true,
    editSaving: false,
    editError: '',
    model: createWorkspaceTreeModel(),
    sessionStates: new Map(),
};
let activeIdentity = { sessionId: 'session-a', workspaceRoot: 'workspace-a' };
const sessionRequests = createWorkspaceRequestCoordinator({ cancel() {} });
const sessionCoordinator = createAgentWorkspaceCoordinator({
    browser: sessionBrowser,
    requests: sessionRequests,
    lifecycle,
    getIdentity: () => activeIdentity,
    clearAttachments() {},
    refresh() {},
    notify() {},
    client: {
        saveText: () => savePending.promise,
        listDirectory: async () => ({ workspaceRevision: 'r2', entries: [] }),
        readPreview: async () => null,
        performPathAction: async () => ({}),
        searchFiles: async () => ({ workspaceRevision: 'r2', entries: [] }),
    },
});
const saving = sessionCoordinator.saveText({
    sessionId: 'session-a', workspaceRevision: 'r1', relativePath: 'draft.txt',
}).catch(() => null);
assert.equal(sessionBrowser.editSaving, true);
activeIdentity = { sessionId: 'session-b', workspaceRoot: 'workspace-b' };
sessionCoordinator.syncScope();
assert.equal(sessionBrowser.editSaving, false);
savePending.reject(new Error('late save failure'));
await saving;
assert.equal(sessionBrowser.sessionId, 'session-b');
assert.equal(sessionBrowser.editError, '', 'a stale save failure must not leak into the newly selected Session');
assert.equal(sessionBrowser.editSaving, false, 'a stale save completion must not change the new Session saving state');
sessionCoordinator.dispose();

let watchListener = null;
let scheduledWatchRefresh = null;
const watchedBrowser = {
    ...browser,
    scope: 'session-a:workspace-a',
    sessionId: 'session-a',
    workspaceRevision: 'r1',
    selectedPath: 'src/selected.txt',
    preview: { relativePath: 'src/selected.txt', workspaceRevision: 'r1', content: 'old' },
    editDraft: 'old',
    editBaseRevision: 'old-revision',
    editDirty: false,
    editSaving: false,
    editError: '',
    model: createWorkspaceTreeModel(),
    sessionStates: new Map(),
    lastVisibleRefreshAt: 0,
};
watchedBrowser.model.setChildren('', [{ name: 'src', relativePath: 'src', kind: 'directory' }]);
watchedBrowser.model.setExpanded('src', true);
watchedBrowser.model.setChildren('src', [{ name: 'selected.txt', relativePath: 'src/selected.txt', kind: 'file' }]);
const directoryCalls = [];
const previewCalls = [];
const watchedCoordinator = createAgentWorkspaceCoordinator({
    browser: watchedBrowser,
    requests: createWorkspaceRequestCoordinator({ cancel() {} }),
    lifecycle: {
        timeout(_key, callback) { scheduledWatchRefresh = callback; return 1; },
        clear() { scheduledWatchRefresh = null; },
    },
    getIdentity: () => ({ sessionId: 'session-a', workspaceRoot: 'workspace-a' }),
    clearAttachments() {},
    refresh() {},
    notify() {},
    client: {
        watch: async () => ({ watchId: 'watch-incremental', sessionId: 'session-a', workspaceRevision: 'r1' }),
        unwatch: async () => ({}),
        subscribeChanges(listener) { watchListener = listener; return () => { watchListener = null; }; },
        listDirectory: async ({ relativePath }) => {
            directoryCalls.push(relativePath);
            return { workspaceRevision: 'r1', entries: relativePath === 'src'
                ? [{ name: 'selected.txt', relativePath: 'src/selected.txt', kind: 'file' },
                    { name: 'new.txt', relativePath: 'src/new.txt', kind: 'file' }]
                : [{ name: 'src', relativePath: 'src', kind: 'directory' }] };
        },
        readPreview: async (request) => {
            previewCalls.push(request.relativePath);
            return { ...request, content: 'updated', contentRevision: 'new-revision' };
        },
        performPathAction: async () => ({}),
        searchFiles: async () => ({ workspaceRevision: 'r1', entries: [] }),
    },
});
await watchedCoordinator.refreshVisibleWorkspace(true);
directoryCalls.length = 0;
watchListener({
    watchId: 'watch-incremental', sessionId: 'session-a', workspaceRevision: 'r1',
    eventKind: 'add', relativePath: 'src/new.txt',
});
watchListener({
    watchId: 'watch-incremental', sessionId: 'session-a', workspaceRevision: 'r1',
    eventKind: 'change', relativePath: 'src/other.txt',
});
scheduledWatchRefresh();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(directoryCalls, ['src'],
    'a watcher burst must reload the affected visible parent once without invalidating the root tree');
assert.deepEqual(previewCalls, [], 'unrelated file changes must not reload the selected preview');

watchListener({
    watchId: 'watch-incremental', sessionId: 'session-a', workspaceRevision: 'r1',
    eventKind: 'change', relativePath: 'src/selected.txt',
});
scheduledWatchRefresh();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(previewCalls, ['src/selected.txt'], 'the selected preview must reload only when that exact file changes');

watchListener({
    watchId: 'watch-incremental', sessionId: 'session-a', workspaceRevision: 'r1',
    eventKind: 'unlink', relativePath: 'src/selected.txt',
});
scheduledWatchRefresh();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(watchedBrowser.selectedPath, '');
assert.equal(watchedBrowser.preview, null);
assert.match(watchedBrowser.editError, /已被删除/);

watchedBrowser.selectedPath = 'src/draft.txt';
watchedBrowser.preview = { relativePath: 'src/draft.txt', workspaceRevision: 'r1', content: 'old' };
watchedBrowser.previewMode = 'edit';
watchedBrowser.editDraft = 'unsaved draft';
watchedBrowser.editDirty = true;
watchListener({
    watchId: 'watch-incremental', sessionId: 'session-a', workspaceRevision: 'r1',
    eventKind: 'unlink', relativePath: 'src/draft.txt',
});
scheduledWatchRefresh();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(watchedBrowser.selectedPath, 'src/draft.txt');
assert.equal(watchedBrowser.editDraft, 'unsaved draft');
assert.equal(watchedBrowser.editDirty, true);
assert.match(watchedBrowser.editError, /草稿仍保留/,
    'deleting a dirty selected file must preserve the in-memory draft for recovery');
watchedCoordinator.dispose();
console.log('Agent Workspace coordinator stale-response tests passed.');
