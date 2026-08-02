const STORAGE_KEY = 'vcpchat.agentWorkbench.sessionDock.v1';
const FIXED_TABS = Object.freeze([
    Object.freeze({ id: 'files', kind: 'files', title: '打开文件', icon: 'draft', closeable: false }),
    Object.freeze({ id: 'context', kind: 'context', title: '上下文', icon: 'data_usage', closeable: true }),
]);
const OPTIONAL_KINDS = new Set(['changes', 'notifications', 'approvals']);
const DEFAULT_OPTIONAL_TABS = Object.freeze([]);

function cleanText(value, max = 512) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function cleanRelativePath(value) {
    const normalized = cleanText(value, 2048).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').some((part) => part === '..')) return '';
    return normalized.split('/').filter((part) => part && part !== '.').join('/');
}

function fileTabId(sessionId, workspaceRevision, relativePath) {
    return `file:${encodeURIComponent(sessionId)}:${encodeURIComponent(workspaceRevision)}:${encodeURIComponent(relativePath)}`;
}

function makeOptionalTab(kind) {
    const definitions = {
        changes: { title: '变更', icon: 'difference' },
        notifications: { title: '通知', icon: 'notifications' },
        approvals: { title: '审批', icon: 'approval' },
    };
    return { id: kind, kind, ...definitions[kind], closeable: true };
}

export function createSessionDockModel(storage = globalThis.sessionStorage) {
    const sessions = new Map();
    let currentSessionId = '';

    const ensure = (sessionId = currentSessionId) => {
        const key = cleanText(sessionId, 256);
        if (!sessions.has(key)) sessions.set(key, {
            activeId: 'context',
            tabs: [...FIXED_TABS.map((tab) => ({ ...tab })), ...DEFAULT_OPTIONAL_TABS.map(makeOptionalTab)],
        });
        return sessions.get(key);
    };

    const persist = () => {
        if (!storage?.setItem) return;
        const payload = { sessions: {} };
        for (const [sessionId, entry] of sessions) {
            if (!sessionId) continue;
            payload.sessions[sessionId] = {
                activeId: entry.activeId,
                tabs: entry.tabs.filter((tab) => tab.closeable).map((tab) => ({
                    kind: tab.kind,
                    workspaceRevision: tab.kind === 'file' ? tab.workspaceRevision : undefined,
                    relativePath: tab.kind === 'file' ? tab.relativePath : undefined,
                })),
            };
        }
        try { storage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch { /* layout restoration is optional */ }
    };

    const restore = () => {
        let parsed;
        try { parsed = JSON.parse(storage?.getItem?.(STORAGE_KEY) || 'null'); } catch { return; }
        if (!parsed?.sessions || typeof parsed.sessions !== 'object') return;
        for (const [rawSessionId, saved] of Object.entries(parsed.sessions)) {
            const sessionId = cleanText(rawSessionId, 256);
            if (!sessionId || !Array.isArray(saved?.tabs)) continue;
            const entry = ensure(sessionId);
            for (const tab of saved.tabs.slice(0, 24)) {
                if (tab?.kind === 'file') {
                    const relativePath = cleanRelativePath(tab.relativePath);
                    const workspaceRevision = cleanText(tab.workspaceRevision, 256);
                    if (!relativePath || !workspaceRevision) continue;
                    entry.tabs.push({
                        id: fileTabId(sessionId, workspaceRevision, relativePath), kind: 'file', sessionId,
                        workspaceRevision, relativePath, title: relativePath.split('/').pop(), icon: 'draft', closeable: true,
                    });
                } else if (OPTIONAL_KINDS.has(tab?.kind) && !entry.tabs.some((item) => item.id === tab.kind)) {
                    entry.tabs.push(makeOptionalTab(tab.kind));
                }
            }
            const requested = cleanText(saved.activeId, 4096);
            entry.activeId = entry.tabs.some((tab) => tab.id === requested) ? requested : 'context';
        }
    };

    restore();

    return {
        setSession(sessionId) {
            currentSessionId = cleanText(sessionId, 256);
            return this.snapshot();
        },
        snapshot() {
            const entry = ensure();
            return { sessionId: currentSessionId, activeId: entry.activeId, tabs: entry.tabs.map((tab) => ({ ...tab })) };
        },
        activate(id) {
            const entry = ensure();
            if (entry.tabs.some((tab) => tab.id === id)) entry.activeId = id;
            persist();
            return this.snapshot();
        },
        openKind(kind) {
            const entry = ensure();
            if (!entry.tabs.some((tab) => tab.id === kind)) {
                const systemTab = FIXED_TABS.find((tab) => tab.kind === kind);
                if (systemTab) entry.tabs.push({ ...systemTab });
                else if (OPTIONAL_KINDS.has(kind)) entry.tabs.push(makeOptionalTab(kind));
            }
            entry.activeId = kind === 'files' ? 'files' : kind === 'context' ? 'context' : kind;
            persist();
            return this.snapshot();
        },
        ensureKind(kind) {
            const entry = ensure();
            if (!entry.tabs.some((tab) => tab.id === kind)) {
                const systemTab = FIXED_TABS.find((tab) => tab.kind === kind);
                if (systemTab) entry.tabs.push({ ...systemTab });
                else if (OPTIONAL_KINDS.has(kind)) entry.tabs.push(makeOptionalTab(kind));
                persist();
            }
            return this.snapshot();
        },
        openFile({ sessionId = currentSessionId, workspaceRevision, relativePath }) {
            const safeSessionId = cleanText(sessionId, 256);
            const safeRevision = cleanText(workspaceRevision, 256);
            const safePath = cleanRelativePath(relativePath);
            if (!safeSessionId || safeSessionId !== currentSessionId || !safeRevision || !safePath) return null;
            const entry = ensure();
            const id = fileTabId(safeSessionId, safeRevision, safePath);
            if (!entry.tabs.some((tab) => tab.id === id)) entry.tabs.push({
                id, kind: 'file', sessionId: safeSessionId, workspaceRevision: safeRevision,
                relativePath: safePath, title: safePath.split('/').pop(), icon: 'draft', closeable: true,
            });
            entry.activeId = id;
            persist();
            return this.snapshot();
        },
        close(id) {
            const entry = ensure();
            const index = entry.tabs.findIndex((tab) => tab.id === id && tab.closeable);
            if (index < 0) return this.snapshot();
            const wasActive = entry.activeId === id;
            entry.tabs.splice(index, 1);
            if (wasActive) entry.activeId = entry.tabs[Math.max(0, index - 1)]?.id || entry.tabs[0]?.id || 'files';
            persist();
            return this.snapshot();
        },
        setBadge(kind, badge) {
            const entry = ensure();
            const tab = entry.tabs.find((item) => item.kind === kind);
            if (tab) tab.badge = Math.max(0, Number(badge || 0));
            return this.snapshot();
        },
        invalidateWorkspace(workspaceRevision) {
            const entry = ensure();
            const revision = cleanText(workspaceRevision, 256);
            const removedActive = entry.tabs.some((tab) => tab.id === entry.activeId && tab.kind === 'file' && tab.workspaceRevision !== revision);
            entry.tabs = entry.tabs.filter((tab) => tab.kind !== 'file' || tab.workspaceRevision === revision);
            if (removedActive) entry.activeId = 'files';
            persist();
            return this.snapshot();
        },
    };
}

export const SESSION_DOCK_STORAGE_KEY = STORAGE_KEY;
