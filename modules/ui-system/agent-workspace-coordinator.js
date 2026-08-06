export function createAgentWorkspaceCoordinator({
    browser,
    requests,
    client,
    lifecycle,
    getIdentity,
    clearAttachments,
    refresh,
    notify,
}) {
    let watchId = '';
    let watchSessionId = '';
    let watchScope = '';
    let unsubscribeChanges = null;
    const pendingWatchChanges = [];

    function parentDirectory(relativePath = '') {
        const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const separator = normalized.lastIndexOf('/');
        return separator < 0 ? '' : normalized.slice(0, separator);
    }

    function stopWatching() {
        const currentWatchId = watchId;
        const currentSessionId = watchSessionId;
        watchId = '';
        watchSessionId = '';
        watchScope = '';
        pendingWatchChanges.length = 0;
        lifecycle.clear?.('workspace-watch-refresh');
        if (currentWatchId) void Promise.resolve(client.unwatch?.({
            watchId: currentWatchId, sessionId: currentSessionId,
        })).catch(() => null);
    }

    async function ensureWatching(scope) {
        if (!browser.sessionId || !browser.workspaceRevision || watchScope === scope || watchId) return;
        const result = await client.watch?.({
            sessionId: browser.sessionId,
            workspaceRevision: browser.workspaceRevision,
        });
        if (!result || browser.scope !== scope) {
            if (result?.watchId) void Promise.resolve(client.unwatch?.({
                watchId: result.watchId, sessionId: result.sessionId,
            })).catch(() => null);
            return;
        }
        watchId = result.watchId;
        watchSessionId = result.sessionId;
        watchScope = scope;
        await refreshVisibleWorkspace(true);
    }

    async function flushWatchedWorkspace() {
        const changes = pendingWatchChanges.splice(0);
        if (!changes.length) return;
        const valid = changes.filter((change) => change.sessionId === browser.sessionId
            && change.workspaceRevision === browser.workspaceRevision);
        if (!valid.length) return;
        const watcherError = valid.find((change) => change.eventKind === 'error');
        if (watcherError) {
            browser.error = watcherError.error || '工作区监听失败';
            refresh();
        }
        const selectedChange = valid.find((change) => change.relativePath === browser.selectedPath);
        if (selectedChange && browser.editDirty && !browser.editSaving) {
            browser.editError = '文件已在 VChat 外部发生变化。请复制草稿后重新加载，或先保存到其他位置。';
            refresh();
        }
        for (const change of valid) {
            if (change.eventKind === 'unlink-directory') browser.model.removeBranch(change.relativePath);
        }
        const parents = [...new Set(valid.filter((change) => change.eventKind !== 'error')
            .map((change) => parentDirectory(change.relativePath)))]
            .filter((relativePath) => !relativePath || browser.model.hasChildren(relativePath)
                || browser.model.isExpanded(relativePath));
        await Promise.all(parents.map((relativePath) => loadDirectory(relativePath, undefined, { force: true })));
        if (browser.search.trim()) search(browser.search);
        if (selectedChange?.eventKind === 'unlink' || selectedChange?.eventKind === 'unlink-directory') {
            if (browser.editDirty) {
                browser.editError = '所选文件已被删除；未保存草稿仍保留在编辑器中，请先复制内容。';
            } else {
                browser.selectedPath = '';
                browser.preview = null;
                browser.previewMode = 'preview';
                browser.editDraft = '';
                browser.editBaseRevision = '';
                browser.editError = '所选文件已被删除。';
            }
            refresh();
        } else if (selectedChange && !browser.editDirty && !browser.editSaving) {
            await openPreview({
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision,
                relativePath: browser.selectedPath,
                kind: 'file',
                source: 'tree',
            }).catch(() => null);
        }
    }

    if (typeof client.subscribeChanges === 'function') {
        unsubscribeChanges = client.subscribeChanges((change) => {
            if (!change || change.watchId !== watchId) return;
            pendingWatchChanges.push(change);
            lifecycle.timeout('workspace-watch-refresh', () => {
                void flushWatchedWorkspace().catch((error) => {
                    browser.error = error?.message || String(error);
                    refresh();
                });
            }, 100);
        });
    }

    function syncScope(current) {
        const identity = getIdentity(current);
        const scope = `${identity.sessionId}:${identity.workspaceRoot}`;
        if (browser.scope === scope) return identity;
        if (browser.scope) {
            browser.sessionStates.set(browser.scope, {
                search: browser.search,
                selectedPath: browser.selectedPath,
                splitPercent: browser.splitPercent,
                previewMode: browser.previewMode,
                expandedPaths: browser.model.expandedPaths(),
            });
        }
        stopWatching();
        if (browser.sessionId && browser.sessionId === identity.sessionId) clearAttachments(identity.sessionId);
        requests.cancelAll();
        browser.scope = scope;
        browser.sessionId = identity.sessionId;
        browser.workspaceRevision = '';
        browser.model.reset(scope);
        browser.inflight.clear();
        browser.inflightRequestIds.clear();
        browser.previewRequestId = '';
        browser.searchRequestId = '';
        browser.error = '';
        browser.preview = null;
        browser.previewLoading = false;
        browser.previewMode = 'preview';
        browser.editDraft = '';
        browser.editBaseRevision = '';
        browser.editDirty = false;
        browser.editSaving = false;
        browser.editError = '';
        const restored = browser.sessionStates.get(scope) || {};
        browser.search = restored.search || '';
        browser.searchResults = [];
        browser.selectedPath = restored.selectedPath || '';
        browser.splitPercent = Number(restored.splitPercent) || browser.splitPercent;
        browser.previewMode = restored.previewMode || 'preview';
        browser.pendingExpanded = Array.isArray(restored.expandedPaths) ? restored.expandedPaths : [];
        browser.lastVisibleRefreshAt = 0;
        for (const relativePath of browser.pendingExpanded) browser.model.setExpanded(relativePath, true);
        return identity;
    }

    async function loadDirectory(relativePath = '', current, { force = false } = {}) {
        const identity = syncScope(current);
        if (!identity.sessionId || !identity.workspaceRoot) return;
        const key = String(relativePath || '').replace(/\\/g, '/');
        if (!force && browser.model.hasChildren(key)) return;
        if (!force && browser.inflight.has(key)) return browser.inflight.get(key);
        browser.model.setLoading(key, true);
        browser.error = '';
        refresh();
        const scope = browser.scope;
        const token = requests.begin({
            key: `directory:${key}`,
            operation: 'directory',
            sessionId: identity.sessionId,
            workspaceRevision: browser.workspaceRevision,
            relativePath: key,
        });
        const request = client.listDirectory({
            requestId: token.requestId,
            sessionId: identity.sessionId,
            workspaceRevision: browser.workspaceRevision || undefined,
            relativePath: key,
            limit: 1000,
        }).then((result) => {
            if (browser.scope !== scope || !requests.isCurrent(token, {
                sessionId: browser.sessionId,
                relativePath: key,
            })) return;
            browser.workspaceRevision = result.workspaceRevision;
            browser.model.setChildren(key, result.entries || []);
            if (!key) {
                void ensureWatching(scope).catch((error) => {
                    if (browser.scope === scope) browser.error = error?.message || String(error);
                });
                const pendingExpanded = browser.pendingExpanded;
                browser.pendingExpanded = [];
                for (const expandedPath of pendingExpanded.sort((a, b) => a.split('/').length - b.split('/').length)) {
                    void loadDirectory(expandedPath, current).catch(() => null);
                }
                if (browser.selectedPath && !browser.preview && !browser.editDirty) {
                    void openPreview({
                        sessionId: browser.sessionId,
                        workspaceRevision: browser.workspaceRevision,
                        relativePath: browser.selectedPath,
                        kind: 'file',
                        source: 'tree',
                    }).catch(() => null);
                }
                if (browser.search) search(browser.search);
            }
        }).catch((error) => {
            if (browser.scope === scope && requests.isCurrent(token, {
                sessionId: browser.sessionId,
                relativePath: key,
            })) browser.error = error?.message || String(error);
            throw error;
        }).finally(() => {
            if (browser.scope === scope && requests.finish(token)) {
                browser.model.setLoading(key, false);
                browser.inflight.delete(key);
                browser.inflightRequestIds.delete(key);
                refresh();
            }
        });
        browser.inflight.set(key, request);
        browser.inflightRequestIds.set(key, token.requestId);
        return request;
    }

    async function refreshVisibleWorkspace(force = false) {
        const identity = syncScope();
        if (!identity.sessionId || !identity.workspaceRoot) return;
        const now = Date.now();
        if (!force && browser.lastVisibleRefreshAt && now - browser.lastVisibleRefreshAt < 5_000) return;
        browser.lastVisibleRefreshAt = now;
        const loaded = ['', ...browser.model.expandedPaths()]
            .filter((relativePath, index, values) => values.indexOf(relativePath) === index)
            .filter((relativePath) => !relativePath || browser.model.hasChildren(relativePath));
        if (!browser.workspaceRevision) {
            await loadDirectory('');
            return;
        }
        await Promise.all(loaded.map((relativePath) => loadDirectory(relativePath, undefined, { force: true })));
    }

    async function openPreview(ref) {
        browser.selectedPath = ref.relativePath;
        browser.previewLoading = true;
        browser.error = '';
        refresh();
        const scope = browser.scope;
        const token = requests.begin({
            key: 'preview',
            operation: 'preview',
            sessionId: ref.sessionId,
            workspaceRevision: ref.workspaceRevision,
            relativePath: ref.relativePath,
        });
        browser.previewRequestId = token.requestId;
        try {
            const preview = await client.readPreview({ ...ref, requestId: token.requestId });
            if (browser.scope === scope && requests.isCurrent(token, {
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision,
                relativePath: browser.selectedPath,
            })) {
                browser.preview = preview;
                browser.previewMode = 'preview';
                browser.editDraft = preview.content || '';
                browser.editBaseRevision = preview.contentRevision || '';
                browser.editDirty = false;
                browser.editError = '';
            }
        } catch (error) {
            if (browser.scope === scope && requests.isCurrent(token, {
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision,
                relativePath: browser.selectedPath,
            })) browser.error = error?.message || String(error);
            throw error;
        } finally {
            if (browser.scope === scope && requests.finish(token)) {
                browser.previewRequestId = '';
                browser.previewLoading = false;
                refresh();
            }
        }
    }

    async function performAction(ref, action) {
        const token = requests.begin({
            key: `action:${action}`,
            operation: `action:${action}`,
            sessionId: ref.sessionId,
            workspaceRevision: ref.workspaceRevision,
            relativePath: ref.relativePath,
        });
        try {
            const result = await client.performPathAction({ ...ref, action, requestId: token.requestId });
            if (requests.isCurrent(token, {
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision,
                relativePath: ref.relativePath,
            }) && ['preview', 'open-in-vchat'].includes(action)) browser.preview = result;
            if (action.startsWith('copy-')) notify(
                action === 'copy-relative-path' ? '已复制相对路径。' : '已复制绝对路径。',
            );
            return result;
        } finally {
            requests.finish(token);
        }
    }

    async function saveText(ref) {
        if (!browser.editDirty || browser.editSaving) return browser.preview;
        const scope = browser.scope;
        browser.editSaving = true;
        browser.editError = '';
        refresh();
        const token = requests.begin({
            key: 'save-text',
            operation: 'save-text',
            sessionId: ref.sessionId,
            workspaceRevision: ref.workspaceRevision,
            relativePath: ref.relativePath,
        });
        try {
            const preview = await client.saveText({
                ...ref,
                requestId: token.requestId,
                content: browser.editDraft,
                expectedContentRevision: browser.editBaseRevision,
            });
            if (requests.isCurrent(token, {
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision,
                relativePath: browser.selectedPath,
            })) {
                browser.preview = preview;
                browser.editDraft = preview.content || '';
                browser.editBaseRevision = preview.contentRevision || '';
                browser.editDirty = false;
                browser.editError = '';
                notify('文件已保存。');
            }
            return preview;
        } catch (error) {
            if (browser.scope === scope && requests.isCurrent(token, {
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision,
                relativePath: browser.selectedPath,
            })) browser.editError = error?.message || String(error);
            throw error;
        } finally {
            requests.finish(token);
            if (browser.scope === scope) {
                browser.editSaving = false;
                refresh();
            }
        }
    }

    function search(value) {
        browser.search = value;
        lifecycle.timeout('workspace-search', () => {
            const query = browser.search.trim();
            browser.searchRequestId = '';
            if (!query) {
                browser.searchResults = [];
                browser.searchLoading = false;
                refresh();
                return;
            }
            browser.searchLoading = true;
            refresh();
            const scope = browser.scope;
            const token = requests.begin({
                key: 'search',
                operation: 'search',
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision,
                relativePath: query,
            });
            browser.searchRequestId = token.requestId;
            void client.searchFiles({
                requestId: token.requestId,
                sessionId: browser.sessionId,
                workspaceRevision: browser.workspaceRevision || undefined,
                query,
                limit: 200,
            }).then((result) => {
                if (browser.scope === scope && requests.isCurrent(token, {
                    sessionId: browser.sessionId,
                    relativePath: browser.search.trim(),
                })) {
                    browser.workspaceRevision = result.workspaceRevision;
                    browser.searchResults = result.entries || [];
                }
            }).catch((error) => {
                if (browser.scope === scope && requests.isCurrent(token, {
                    sessionId: browser.sessionId,
                    relativePath: browser.search.trim(),
                })) browser.error = error?.message || String(error);
            }).finally(() => {
                if (browser.scope === scope && requests.finish(token)) {
                    browser.searchRequestId = '';
                    browser.searchLoading = false;
                    refresh();
                }
            });
        }, 180);
    }

    return {
        syncScope, loadDirectory, refreshVisibleWorkspace, openPreview, performAction, saveText, search,
        dispose() {
            stopWatching();
            if (typeof unsubscribeChanges === 'function') unsubscribeChanges();
            requests.dispose();
        },
    };
}
