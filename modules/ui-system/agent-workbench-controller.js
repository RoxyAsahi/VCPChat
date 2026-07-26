import { createWorkbenchStore } from './agent-workbench-store.js';

function createWorkbenchController(runtimeApi) {
    const store = createWorkbenchStore();
    let unsubscribeRuntime = null;
    let selectionVersion = 0;

    function requireApi(name) {
        if (typeof runtimeApi[name] !== 'function') throw new Error(`Runtime API unavailable: ${name}`);
        return runtimeApi[name].bind(runtimeApi);
    }

    async function callOptional(name, payload) {
        if (typeof runtimeApi[name] !== 'function') return null;
        try {
            return await runtimeApi[name](payload);
        } catch (error) {
            return null;
        }
    }

    async function refreshStatus() {
        const status = await requireApi('agentRuntimeGetStatus')();
        store.setState({
            runtime: {
                state: status?.state || 'unknown',
                worker: status?.worker || null,
                lastError: status?.lastError || null,
            },
            approvals: status?.pendingApprovals || store.getState().approvals,
        });
        return status;
    }

    async function loadSessions() {
        if (typeof runtimeApi.agentRuntimeListSessions !== 'function') return [];
        const result = await runtimeApi.agentRuntimeListSessions();
        const sessions = result?.sessions || [];
        const activeSessionId = store.getState().activeSessionId;
        store.setState({ sessions });
        if (activeSessionId && !sessions.some((session) => session.sessionId === activeSessionId)) {
            store.setState({ activeSessionId: null });
        }
        return sessions;
    }

    async function selectSession(sessionId) {
        const version = ++selectionVersion;
        store.resetSession(sessionId);
        if (!sessionId) return store.getState();

        const [session, messages, events, artifacts] = await Promise.all([
            callOptional('agentRuntimeGetSession', { sessionId }),
            callOptional('agentRuntimeGetMessages', { sessionId }),
            callOptional('agentRuntimeGetEvents', { sessionId, sinceSequence: 0 }),
            callOptional('agentRuntimeGetArtifacts', { sessionId }),
        ]);
        if (version !== selectionVersion || store.getState().activeSessionId !== sessionId) return store.getState();

        if (session) {
            const sessions = store.getState().sessions;
            const index = sessions.findIndex((item) => item.sessionId === sessionId);
            if (index >= 0) {
                const updated = [...sessions];
                updated[index] = { ...updated[index], ...session };
                store.setState({ sessions: updated, activeTurnId: session.activeTurnId || null });
            }
        }
        if (messages?.messages) store.setState({ messages: messages.messages });
        if (artifacts?.artifacts || Array.isArray(artifacts)) {
            store.setState({ artifacts: artifacts?.artifacts || artifacts });
        }
        for (const event of events?.events || []) store.dispatch(event);
        return store.getState();
    }

    async function startRuntime() {
        const result = await requireApi('agentRuntimeStart')();
        await refreshStatus();
        return result;
    }

    async function stopRuntime() {
        const result = await requireApi('agentRuntimeStop')();
        store.setState({ activeTurnId: null });
        await refreshStatus();
        return result;
    }

    async function createSession(options) {
        const session = await requireApi('agentRuntimeCreateSession')(options);
        await loadSessions();
        await selectSession(session.sessionId);
        return session;
    }

    async function renameSession(sessionId, title) {
        const result = await requireApi('agentRuntimeRenameSession')({ sessionId, title });
        await loadSessions();
        return result;
    }

    async function deleteSession(sessionId) {
        const result = await requireApi('agentRuntimeDeleteSession')({ sessionId });
        const remaining = await loadSessions();
        const next = remaining.find((session) => session.sessionId !== sessionId);
        await selectSession(next?.sessionId || null);
        return result;
    }

    async function forkSession(sessionId, title) {
        const fork = await requireApi('agentRuntimeForkSession')({ sessionId, title: title || undefined });
        await loadSessions();
        await selectSession(fork.sessionId);
        return fork;
    }

    async function compactSession(sessionId, instructions) {
        const result = await requireApi('agentRuntimeCompactSession')({ sessionId, instructions: instructions || undefined });
        store.setState({ context: { ...store.getState().context, compacting: false, summary: result?.summary || '' } });
        return result;
    }

    async function startTurn(prompt) {
        const sessionId = store.getState().activeSessionId;
        if (!sessionId) throw new Error('请先选择或新建 Session');
        const result = await requireApi('agentRuntimeStartTurn')({ sessionId, prompt });
        store.setState({ activeTurnId: result.turnId });
        return result;
    }

    async function cancelTurn() {
        const { activeSessionId: sessionId, activeTurnId: turnId } = store.getState();
        if (!sessionId) return null;
        return requireApi('agentRuntimeCancelTurn')({ sessionId, turnId: turnId || undefined });
    }

    async function respondApproval(approval, decision) {
        const result = await requireApi('agentRuntimeRespondApproval')({
            approvalId: approval.approvalId,
            decision,
            sessionId: approval.sessionId,
            turnId: approval.turnId,
            toolCallId: approval.toolCallId,
            argumentsHash: approval.argumentsHash,
        });
        store.setState({ approvals: store.getState().approvals.filter((item) => item.approvalId !== approval.approvalId) });
        return result;
    }

    async function initialize() {
        runtimeApi.agentRuntimeSetWorkbenchPresence?.(true);
        if (typeof runtimeApi.onAgentRuntimeEvent === 'function') {
            unsubscribeRuntime = runtimeApi.onAgentRuntimeEvent((event) => store.dispatch(event));
        }
        await Promise.all([refreshStatus().catch(() => null), loadSessions()]);
        const sessions = store.getState().sessions;
        const active = store.getState().activeSessionId || sessions[0]?.sessionId;
        if (active) await selectSession(active);
        return store.getState();
    }

    function dispose() {
        selectionVersion += 1;
        runtimeApi.agentRuntimeSetWorkbenchPresence?.(false);
        if (typeof unsubscribeRuntime === 'function') unsubscribeRuntime();
        unsubscribeRuntime = null;
    }

    return {
        store,
        initialize,
        dispose,
        refreshStatus,
        loadSessions,
        selectSession,
        startRuntime,
        stopRuntime,
        createSession,
        renameSession,
        deleteSession,
        forkSession,
        compactSession,
        startTurn,
        cancelTurn,
        respondApproval,
    };
}

export { createWorkbenchController };
