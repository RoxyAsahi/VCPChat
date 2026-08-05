function durableSnapshotState(snapshot) {
    return snapshot?.session && typeof snapshot.session === 'object'
        ? snapshot.session : snapshot?.state && typeof snapshot.state === 'object' ? snapshot.state : {};
}

function snapshotAgentId(snapshot, durableState, agentId, active) {
    return typeof snapshot?.session?.agentId === 'string' && snapshot.session.agentId.trim()
        ? snapshot.session.agentId
        : typeof snapshot?.agentId === 'string' && snapshot.agentId.trim()
            ? snapshot.agentId : agentId || active?.agentId || null;
}

function hydratedRuntime(active, sessionId, durableState, durableAgentId) {
    if (!active) return null;
    return {
        ...active, sessionId,
        title: typeof durableState.title === 'string' && durableState.title.trim() ? durableState.title : active.title,
        model: typeof durableState.model === 'string' && durableState.model.trim() ? durableState.model : active.model,
        workspaceRoot: typeof durableState.workspaceRef === 'string' && durableState.workspaceRef.trim()
            ? durableState.workspaceRef : active.workspaceRoot,
        agentId: durableAgentId || active.agentId,
        configSnapshot: durableState.configSnapshot || active.configSnapshot || null,
    };
}

function hydratedTopicProjection(durableState, nextRuntime, durableAgentId, selectedSessionId) {
    return {
        sessionId: selectedSessionId,
        threadId: durableState.threadId || nextRuntime?.threadId || null,
        agentId: durableAgentId,
        title: nextRuntime?.title || durableState.title || '',
        model: nextRuntime?.model || durableState.configSnapshot?.model || '',
        workspaceRoot: nextRuntime?.workspaceRoot || durableState.workspaceRoot || '',
        configSnapshot: durableState.configSnapshot || null,
        configRevision: Number(durableState.configRevision || 1),
        archivedAt: durableState.archivedAt || null,
        mode: nextRuntime ? 'runtime-active' : 'preview',
    };
}

export { durableSnapshotState, hydratedRuntime, hydratedTopicProjection, snapshotAgentId };
