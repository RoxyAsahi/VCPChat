function createWorkspaceRequestCoordinator({ cancel }) {
    const active = new Map();
    let sequence = 0;
    let disposed = false;

    function begin({ key, operation, sessionId, workspaceRevision = '', relativePath = '' }) {
        if (disposed) throw new Error('Workspace request coordinator is disposed');
        const slot = String(key || operation || 'request');
        const previous = active.get(slot);
        if (previous) cancel?.(previous);
        sequence += 1;
        const token = Object.freeze({
            key: slot,
            operation: String(operation || slot),
            requestId: `workspace:${operation || slot}:${Date.now()}:${sequence}`,
            sessionId: String(sessionId || ''),
            workspaceRevision: String(workspaceRevision || ''),
            relativePath: String(relativePath || '').replace(/\\/g, '/'),
        });
        active.set(slot, token);
        return token;
    }

    function isCurrent(token, identity = {}) {
        if (disposed || !token || active.get(token.key) !== token) return false;
        if (identity.sessionId !== undefined && String(identity.sessionId || '') !== token.sessionId) return false;
        if (identity.relativePath !== undefined
            && String(identity.relativePath || '').replace(/\\/g, '/') !== token.relativePath) return false;
        if (identity.workspaceRevision !== undefined && token.workspaceRevision
            && String(identity.workspaceRevision || '') !== token.workspaceRevision) return false;
        return true;
    }

    function finish(token) {
        if (!isCurrent(token)) return false;
        active.delete(token.key);
        return true;
    }

    function cancelToken(token) {
        if (!token || active.get(token.key) !== token) return false;
        active.delete(token.key);
        cancel?.(token);
        return true;
    }

    function cancelAll() {
        for (const token of active.values()) cancel?.(token);
        active.clear();
    }

    function dispose() {
        if (disposed) return;
        cancelAll();
        disposed = true;
    }

    return { begin, isCurrent, finish, cancel: cancelToken, cancelAll, dispose };
}

export { createWorkspaceRequestCoordinator };
