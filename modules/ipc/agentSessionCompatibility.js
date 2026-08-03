'use strict';

let warned = false;

function warnDeprecated(channel) {
    if (warned) return;
    warned = true;
    console.warn(`[AgentSessionCompat] Deprecated Topic IPC invoked (${channel}); migrate to agent-session:*`);
}

function sessionPayload(payload = {}) {
    const sessionId = String(payload.sessionId || '').trim();
    const topicId = String(payload.topicId || '').trim();
    if (sessionId && topicId && sessionId !== topicId) {
        const error = new Error('sessionId and topicId refer to different Agent Sessions');
        error.code = 'SESSION_IDENTITY_MISMATCH';
        throw error;
    }
    return { ...payload, sessionId: sessionId || topicId || undefined };
}

function registerAgentSessionCompatibility({ ipcMain, channels, projectionGuard, runtimeGuard, toolboxGuard, manager }) {
    const handle = (channel, guard, action) => ipcMain.handle(channel, (event, payload) => {
        warnDeprecated(channel);
        return guard(event, () => action(sessionPayload(payload || {})));
    });
    handle(channels.CREATE_TOPIC, projectionGuard, (payload) => manager.createSessionRecord({
        ...payload, agentId: payload.agentId || payload.agent,
    }));
    handle(channels.CREATE_SESSION, toolboxGuard, (payload) => manager.ensureSessionRuntime({
        ...payload, sessionId: payload.sessionId || payload.resume,
    }));
    handle(channels.LIST_TOPICS, projectionGuard, (payload) => manager.listSessions(payload));
    handle(channels.READ_TOPIC, runtimeGuard, (payload) => manager.readSession(payload));
    handle(channels.READ_PROJECTION, projectionGuard, (payload) => manager.readSession({ ...payload, reconcile: false }));
    handle(channels.RENAME_TOPIC, projectionGuard, (payload) => manager.renameSession(payload));
    handle(channels.DELETE_TOPIC, runtimeGuard, (payload) => manager.archiveSession(payload));
    handle(channels.FORK_SESSION, runtimeGuard, (payload) => manager.forkSession(payload));
    handle(channels.CLOSE_SESSION, runtimeGuard, (payload) => manager.archiveSession(payload));
    handle(channels.RESTORE_SESSION, runtimeGuard, (payload) => manager.restoreSession(payload));
    handle(channels.PERMANENTLY_DELETE_SESSION, runtimeGuard, (payload) => manager.permanentlyDeleteSession(payload));
}

module.exports = { registerAgentSessionCompatibility, sessionPayload };
