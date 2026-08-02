function normalizeWorkspacePath(value = '') {
    return String(value).replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').join('/');
}

function sortWorkspaceEntries(entries = []) {
    return [...entries].sort((left, right) => {
        const rank = (item) => item.kind === 'directory' ? 0 : 1;
        return rank(left) - rank(right)
            || String(left.name || '').localeCompare(String(right.name || ''), undefined, { numeric: true, sensitivity: 'base' });
    });
}

function createWorkspaceTreeModel() {
    const children = new Map();
    const expanded = new Set();
    const loading = new Set();
    let scope = '';

    return {
        reset(nextScope = '') {
            scope = String(nextScope);
            children.clear();
            expanded.clear();
            loading.clear();
        },
        scope: () => scope,
        setLoading(relativePath, value) {
            const key = normalizeWorkspacePath(relativePath);
            if (value) loading.add(key); else loading.delete(key);
        },
        isLoading: (relativePath) => loading.has(normalizeWorkspacePath(relativePath)),
        setChildren(relativePath, entries) {
            children.set(normalizeWorkspacePath(relativePath), sortWorkspaceEntries(entries));
        },
        hasChildren: (relativePath) => children.has(normalizeWorkspacePath(relativePath)),
        setExpanded(relativePath, value) {
            const key = normalizeWorkspacePath(relativePath);
            if (value) expanded.add(key); else expanded.delete(key);
        },
        isExpanded: (relativePath) => expanded.has(normalizeWorkspacePath(relativePath)),
        flatten() {
            const rows = [];
            const stack = [...(children.get('') || [])].reverse().map((entry) => ({ entry, depth: 0 }));
            while (stack.length) {
                const row = stack.pop();
                rows.push(row);
                if (row.entry.kind !== 'directory' || !expanded.has(normalizeWorkspacePath(row.entry.relativePath))) continue;
                const nested = children.get(normalizeWorkspacePath(row.entry.relativePath)) || [];
                for (let index = nested.length - 1; index >= 0; index -= 1) stack.push({ entry: nested[index], depth: row.depth + 1 });
            }
            return rows;
        },
    };
}

function createWorkspacePathRef({ sessionId, workspaceRevision, relativePath, kind = 'file', source = 'tree' }) {
    if (!sessionId || !workspaceRevision || !relativePath) throw new TypeError('WorkspacePathRef requires sessionId, workspaceRevision and relativePath');
    const raw = String(relativePath);
    const normalized = normalizeWorkspacePath(raw);
    if (!normalized || raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)
        || normalized.split('/').includes('..') || /^[a-z]+:\/\//i.test(raw)) {
        throw new TypeError('WorkspacePathRef requires a safe relative path');
    }
    return Object.freeze({ sessionId, workspaceRevision, relativePath: normalized, kind, source });
}

function structuredWorkspacePaths(value, limit = 8) {
    const results = [];
    const seen = new Set();
    const stack = [{ value, depth: 0 }];
    const pathKey = /^(relativePath|path|filePath|targetPath|sourcePath)$/i;
    while (stack.length && results.length < limit) {
        const current = stack.pop();
        if (!current.value || typeof current.value !== 'object' || current.depth > 5) continue;
        for (const [key, item] of Object.entries(current.value)) {
            if (typeof item === 'string' && pathKey.test(key)) {
                const normalized = normalizeWorkspacePath(item);
                const unsafe = !normalized || item.startsWith('/') || item.startsWith('\\')
                    || /^[A-Za-z]:[\\/]/.test(item) || normalized.split('/').includes('..')
                    || /^[a-z]+:\/\//i.test(item);
                if (!unsafe && !seen.has(normalized)) { seen.add(normalized); results.push(normalized); }
            } else if (item && typeof item === 'object') stack.push({ value: item, depth: current.depth + 1 });
        }
    }
    return results;
}

export { createWorkspacePathRef, createWorkspaceTreeModel, normalizeWorkspacePath, sortWorkspaceEntries, structuredWorkspacePaths };
