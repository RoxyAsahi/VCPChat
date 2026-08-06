import { selectedSessionId } from './agent-selected-session.js';

function deriveReplyTurnStart({ stored, runtime, sessionId, startedAt = null }) {
    if (stored) return stored;
    const turnId = String(runtime?.activeTurnId || '').trim();
    if (!sessionId || !turnId) return null;
    const timestamp = Number(startedAt) || Date.now();
    return {
        sessionId, turnId, phase: 'thinking', seenRunning: true,
        startedAt: timestamp, createdAt: timestamp, derived: true,
    };
}

export function createAgentSessionViewContext({ state, store, document, sameAgent }) {
    function activeSession() {
        const current = store.getState();
        const sessionId = selectedSessionId(current);
        return sessionId && current.activeRuntimes instanceof Map
            ? current.activeRuntimes.get(sessionId) || null : null;
    }

    function selectedSessionKey(current = store.getState()) {
        return selectedSessionId(current);
    }

    function selectedComposerState(current = store.getState()) {
        return state.composerStateBySession.get(selectedSessionKey(current));
    }

    function selectedTurnStart(current = store.getState()) {
        const sessionId = selectedSessionKey(current);
        const runtime = sessionId && current.activeRuntimes instanceof Map
            ? current.activeRuntimes.get(sessionId) : null;
        return deriveReplyTurnStart({
            stored: sessionId ? state.turnStarts.get(sessionId) || null : null,
            runtime,
            sessionId,
            startedAt: runtime?.activeTurnId ? state.turnStartedAt.get(runtime.activeTurnId) : null,
        });
    }

    function selectedActiveTurnId(current = store.getState()) {
        const sessionId = selectedSessionKey(current);
        const runtime = sessionId && current.activeRuntimes instanceof Map
            ? current.activeRuntimes.get(sessionId) : null;
        // `activeTurnId` is a legacy selected-view cache. It is not a Session
        // identity and can lag behind a sidebar/session switch. The Composer
        // must only ever expose steer/follow-up controls for its own runtime.
        return runtime?.activeTurnId || null;
    }

    function syncPermissionMode() {
        const snapshot = store.getState().selectedTopic?.configSnapshot || null;
        if (!snapshot || (!Object.prototype.hasOwnProperty.call(snapshot, 'permissionMode')
            && !Object.prototype.hasOwnProperty.call(snapshot, 'approvalPolicy'))) return;
        state.permissionMode = snapshot.permissionMode
            || (snapshot.approvalPolicy === 'never' ? 'always-approve' : 'ask');
    }

    function syncModel() {
        const current = store.getState();
        const sessionId = selectedSessionId(current) || '';
        if (state.modelDraftSessionId !== sessionId) {
            state.modelDraftSessionId = sessionId;
            state.modelDraft = null;
        }
        const selectedModel = String(current.selectedTopic?.configSnapshot?.model || '').trim();
        if (selectedModel && state.modelDraft === null) state.model = selectedModel;
    }

    function avatarUrl(agentId) {
        return state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, agentId))?.avatarUrl
            || 'assets/default_avatar.png';
    }

    function sessionActivity(sessionId, fallback = 'idle') {
        const current = store.getState();
        const runtime = sessionId && current.activeRuntimes instanceof Map
            ? current.activeRuntimes.get(sessionId) : null;
        if (runtime?.recoveryState === 'unconfirmed') return 'reconnecting';
        if (runtime?.activity) return runtime.activity;
        if (runtime?.activeTurnId) return 'running';
        if (sessionId && state.turnStarts.has(sessionId)) return 'starting';
        return fallback || 'idle';
    }

    function createSessionAvatar(sessionId, agentId, label, activity = 'idle') {
        const wrap = document.createElement('span');
        wrap.className = 'agent-chat-session-avatar';
        const resolved = sessionActivity(sessionId, activity);
        wrap.dataset.activity = resolved;
        wrap.classList.toggle('is-running', ['starting', 'running'].includes(resolved));
        wrap.classList.toggle('is-awaiting-approval', resolved === 'awaiting-approval');
        const avatar = document.createElement('img');
        avatar.className = 'avatar';
        avatar.loading = 'lazy';
        avatar.decoding = 'async';
        avatar.src = avatarUrl(agentId);
        avatar.alt = label;
        avatar.onerror = () => { avatar.src = 'assets/default_avatar.png'; };
        wrap.append(avatar);
        return wrap;
    }

    return {
        activeSession, selectedSessionKey, selectedComposerState, selectedTurnStart,
        selectedActiveTurnId, syncPermissionMode, syncModel, sessionActivity, createSessionAvatar,
    };
}

export { deriveReplyTurnStart };
