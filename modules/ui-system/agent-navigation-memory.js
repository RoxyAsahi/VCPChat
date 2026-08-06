const NAVIGATION_STORAGE_KEY = 'vcpchat.agentWorkbench.navigation.v2';
const LEGACY_TOPIC_STORAGE_KEY = 'vcpchat.agentWorkbench.lastTopic.v1';

function cleanId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function emptyNavigationMemory() {
    return { schemaVersion: 2, sessionsByAgent: {} };
}

function readNavigationMemory(storage = window.localStorage) {
    try {
        const parsed = JSON.parse(storage?.getItem(NAVIGATION_STORAGE_KEY) || 'null');
        if (parsed?.schemaVersion !== 2 || !parsed.sessionsByAgent
            || typeof parsed.sessionsByAgent !== 'object' || Array.isArray(parsed.sessionsByAgent)) {
            return emptyNavigationMemory();
        }
        const sessionsByAgent = {};
        for (const [agentId, sessionId] of Object.entries(parsed.sessionsByAgent)) {
            const agent = cleanId(agentId);
            const session = cleanId(sessionId);
            if (agent && session) sessionsByAgent[agent] = session;
        }
        return { schemaVersion: 2, sessionsByAgent };
    } catch {
        return emptyNavigationMemory();
    }
}

function writeNavigationMemory(memory, storage = window.localStorage) {
    try {
        storage?.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(memory));
        return true;
    } catch {
        return false;
    }
}

function rememberedSessionForAgent(agentId, storage = window.localStorage) {
    const agent = cleanId(agentId);
    return agent ? cleanId(readNavigationMemory(storage).sessionsByAgent[agent]) || null : null;
}

function lastRememberedAgentSession(storage = window.localStorage) {
    const entries = Object.entries(readNavigationMemory(storage).sessionsByAgent);
    const [agentId, sessionId] = entries.at(-1) || [];
    return agentId && sessionId ? { agentId, sessionId } : null;
}

function rememberAgentSession({ agentId, sessionId } = {}, storage = window.localStorage) {
    const agent = cleanId(agentId);
    const session = cleanId(sessionId);
    if (!agent || !session) return false;
    const memory = readNavigationMemory(storage);
    delete memory.sessionsByAgent[agent];
    memory.sessionsByAgent[agent] = session;
    return writeNavigationMemory(memory, storage);
}

function forgetAgentSession({ agentId, sessionId } = {}, storage = window.localStorage) {
    const agent = cleanId(agentId);
    const session = cleanId(sessionId);
    const memory = readNavigationMemory(storage);
    let changed = false;
    for (const [owner, rememberedSessionId] of Object.entries(memory.sessionsByAgent)) {
        if ((agent && owner !== agent) || (session && rememberedSessionId !== session)) continue;
        delete memory.sessionsByAgent[owner];
        changed = true;
    }
    return !changed || writeNavigationMemory(memory, storage);
}

function loadLegacyRememberedSession(storage = window.localStorage) {
    try {
        const parsed = JSON.parse(storage?.getItem(LEGACY_TOPIC_STORAGE_KEY) || 'null');
        const sessionId = cleanId(parsed?.sessionId);
        const agentId = cleanId(parsed?.agentId);
        return sessionId ? { sessionId, ...(agentId ? { agentId } : {}) } : null;
    } catch {
        return null;
    }
}

function clearLegacyRememberedSession(storage = window.localStorage) {
    try { storage?.removeItem(LEGACY_TOPIC_STORAGE_KEY); } catch {}
}

function migrateLegacyRememberedSession(session, storage = window.localStorage) {
    const migrated = rememberAgentSession(session, storage);
    if (migrated) clearLegacyRememberedSession(storage);
    return migrated;
}

function createNavigationIdentityObserver({ store, state, rememberTopic }) {
    let previous = '';
    return store.subscribe((current) => {
        const sessionId = String(current.selectedTopic?.sessionId ?? '').trim();
        const agentId = String(current.selectedTopic?.agentId ?? '').trim();
        if (!sessionId || !agentId || current.selectedTopic?.archivedAt) return;
        state.selectedAgent = agentId;
        const identity = `${agentId}\u0000${sessionId}`;
        if (identity === previous) return;
        previous = identity;
        rememberTopic({ sessionId, agentId });
    });
}

async function restoreRememberedSession({ state, store, controller, remembered,
    rememberTopic, migrateLegacy, clearLegacy } = {}) {
    const sessionId = cleanId(remembered?.sessionId);
    if (!sessionId) return null;
    await controller.previewTopic(sessionId, remembered.agentId);
    const restored = store.getState().selectedTopic;
    const agentId = cleanId(restored?.agentId || remembered.agentId);
    if (!agentId) {
        controller.clearSelection?.();
        clearLegacy?.();
        return null;
    }
    state.selectedAgent = agentId;
    if (remembered.legacy) migrateLegacy({ sessionId, agentId });
    else rememberTopic({ sessionId, agentId });
    return { sessionId, agentId };
}

async function restoreRememberedSessionSafely(options = {}) {
    try {
        return await restoreRememberedSession(options);
    } catch (error) {
        if (!/(?:Session was not found|NOT_FOUND)/i.test(String(error?.message || error || ''))) throw error;
        options.onMissing?.(options.remembered?.sessionId);
        return null;
    }
}

export {
    LEGACY_TOPIC_STORAGE_KEY,
    NAVIGATION_STORAGE_KEY,
    clearLegacyRememberedSession,
    createNavigationIdentityObserver,
    emptyNavigationMemory,
    forgetAgentSession,
    lastRememberedAgentSession,
    loadLegacyRememberedSession,
    migrateLegacyRememberedSession,
    readNavigationMemory,
    rememberAgentSession,
    rememberedSessionForAgent,
    restoreRememberedSession,
    restoreRememberedSessionSafely,
};
