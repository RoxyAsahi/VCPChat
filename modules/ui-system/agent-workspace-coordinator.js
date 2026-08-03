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
    function syncScope(current) {
        const identity = getIdentity(current);
        const scope = `${identity.sessionId}:${identity.workspaceRoot}`;
        if (browser.scope === scope) return identity;
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
        browser.search = '';
        browser.searchResults = [];
        browser.selectedPath = '';
        return identity;
    }

    async function loadDirectory(relativePath = '', current) {
        const identity = syncScope(current);
        if (!identity.sessionId || !identity.workspaceRoot) return;
        const key = String(relativePath || '').replace(/\\/g, '/');
        if (browser.model.hasChildren(key)) return;
        if (browser.inflight.has(key)) return browser.inflight.get(key);
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
            })) browser.preview = preview;
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

    return { syncScope, loadDirectory, openPreview, performAction, search, dispose: () => requests.dispose() };
}
