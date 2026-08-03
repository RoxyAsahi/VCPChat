const CLIENT_METHODS = Object.freeze({
    session: Object.freeze([
        'agentSessionCreate', 'agentSessionList', 'agentSessionRead', 'agentSessionReadProjection',
        'agentSessionRename', 'agentSessionArchive', 'agentSessionRestore', 'agentSessionDelete', 'agentSessionFork',
        'agentRuntimeEnsureSessionRuntime', 'agentRuntimeSetSessionPinned', 'agentRuntimeCompactSession',
        'agentRuntimeExportSession', 'agentRuntimeApplyAgentProfile', 'agentRuntimeSelectAttachments',
        'agentRuntimeUpdateSessionConfig',
    ]),
    projection: Object.freeze([
        'agentRuntimeGetStatus', 'agentRuntimeSearchTopics', 'agentRuntimeSearchTopicMessages',
        'agentRuntimeGetTopicIndexStatus', 'agentRuntimeRebuildTopicIndex',
        'agentRuntimeGetWorkbenchSettings', 'agentRuntimeUpdateWorkbenchSettings',
        'agentRuntimeListRecoveryOperations', 'agentRuntimeListRecoveryCandidates',
        'agentRuntimeResolveRecoveryOperation',
    ]),
    interaction: Object.freeze([
        'agentRuntimeStart', 'agentRuntimeStop', 'agentRuntimeStartTurn', 'agentRuntimeSteerTurn',
        'agentRuntimeFollowUpTurn', 'agentRuntimeCancelTurn', 'agentRuntimeRespondApproval',
        'agentRuntimeRespondInteraction', 'agentRuntimeListInteractionQueue',
        'agentRuntimeReplaceInteractionQueue', 'agentRuntimeClearInteractionQueue',
        'agentRuntimeResolvePendingInput',
    ]),
    workspace: Object.freeze([
        'agentWorkspaceListDirectory', 'agentWorkspaceReadPreview', 'agentWorkspaceSearchFiles',
        'agentWorkspaceStatPath', 'agentWorkspacePerformPathAction', 'agentWorkspaceCancel',
    ]),
});

function createWorkbenchClients(runtimeApi) {
    const clients = {};
    const registry = new Map();
    for (const [group, methods] of Object.entries(CLIENT_METHODS)) {
        clients[group] = {};
        for (const name of methods) {
            const method = typeof runtimeApi?.[name] === 'function' ? runtimeApi[name].bind(runtimeApi) : null;
            clients[group][name] = method;
            registry.set(name, method);
        }
        Object.freeze(clients[group]);
    }
    return Object.freeze({
        ...clients,
        require(name) {
            if (!registry.has(name)) throw new Error(`Runtime API is outside Workbench client boundary: ${name}`);
            const method = registry.get(name);
            if (!method) throw new Error(`Runtime API unavailable: ${name}`);
            return method;
        },
    });
}

export { CLIENT_METHODS, createWorkbenchClients };
