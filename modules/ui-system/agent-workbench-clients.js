const CLIENT_METHODS = Object.freeze({
    session: Object.freeze([
        'agentSessionCreate', 'agentSessionList', 'agentSessionRead', 'agentSessionReadProjection',
        'agentSessionRename', 'agentSessionArchive', 'agentSessionRestore', 'agentSessionDelete', 'agentSessionFork',
        'agentRuntimeEnsureSessionRuntime', 'agentRuntimeSetSessionPinned', 'agentRuntimeCompactSession',
        'agentRuntimeExportSession', 'agentRuntimeApplyAgentProfile', 'agentRuntimeSelectAttachments',
        'agentRuntimeUpdateSessionConfig', 'agentRuntimeListAgentProfiles', 'agentRuntimeSaveAgentProfile',
        'agentRuntimeSaveAgentAvatar', 'getCachedModels', 'refreshModels', 'onModelsUpdated',
    ]),
    projection: Object.freeze([
        'agentRuntimeGetStatus', 'agentRuntimeSearchTopics', 'agentRuntimeSearchTopicMessages',
        'agentRuntimeGetTopicIndexStatus', 'agentRuntimeRebuildTopicIndex',
        'agentRuntimeGetWorkbenchSettings', 'agentRuntimeUpdateWorkbenchSettings',
        'agentRuntimeListRecoveryOperations', 'agentRuntimeListRecoveryCandidates',
        'agentRuntimeResolveRecoveryOperation',
        'agentRuntimeSetWorkbenchPresence', 'onAgentRuntimeEvent',
        'sendOpenExternalLink', 'desktopLaunchVchatApp', 'openThemesWindow',
        'openImageViewer', 'showImageContextMenu',
    ]),
    interaction: Object.freeze([
        'agentRuntimeStart', 'agentRuntimeStop', 'agentRuntimeStartTurn', 'agentRuntimeSteerTurn',
        'agentRuntimeFollowUpTurn', 'agentRuntimeCancelTurn', 'agentRuntimeRespondApproval',
        'agentRuntimeRespondInteraction', 'agentRuntimeListInteractionQueue',
        'agentRuntimeReplaceInteractionQueue', 'agentRuntimeClearInteractionQueue',
        'agentRuntimeResolvePendingInput', 'agentRuntimeCancelTool',
    ]),
    workspace: Object.freeze([
        'agentWorkspaceListDirectory', 'agentWorkspaceReadPreview', 'agentWorkspaceSearchFiles',
        'agentWorkspaceStatPath', 'agentWorkspacePerformPathAction', 'agentWorkspaceCancel',
    ]),
});

function createClient(runtimeApi, methods) {
    return Object.freeze(Object.fromEntries(methods.map((name) => [name,
        typeof runtimeApi?.[name] === 'function' ? runtimeApi[name].bind(runtimeApi) : null])));
}

function createAgentSessionClient(runtimeApi) {
    return createClient(runtimeApi, CLIENT_METHODS.session);
}

function createAgentProjectionClient(runtimeApi) {
    return createClient(runtimeApi, CLIENT_METHODS.projection);
}

function createAgentInteractionClient(runtimeApi) {
    return createClient(runtimeApi, CLIENT_METHODS.interaction);
}

function createAgentWorkspaceClient(runtimeApi) {
    return createClient(runtimeApi, CLIENT_METHODS.workspace);
}

function createAgentRuntimeEventSubscription({
    subscribe, snapshotBarrier, store, applyCodexRuntimeEvent, applySessionUiEvent,
    projectRuntimeActivity, refreshStatus,
}) {
    let unsubscribe = null;
    return Object.freeze({
        start() {
            if (unsubscribe || typeof subscribe !== 'function') return;
            unsubscribe = subscribe((event) => {
                const barrier = snapshotBarrier();
                if (barrier) { barrier.events.push(event); return; }
                const current = store.getState();
                if (event?.runtime === 'codex' && event?.type === 'projection.updated') {
                    applyCodexRuntimeEvent(event);
                    return;
                }
                applySessionUiEvent(event);
                projectRuntimeActivity(event);
                const selectedSession = current.selectedSessionId;
                const processGlobal = event?.type?.startsWith('runtime.') || event?.type === 'toolbox.ws';
                if (!event?.type?.startsWith('approval.') && !processGlobal && event?.sessionId
                    && selectedSession && event.sessionId !== selectedSession) {
                    void refreshStatus().catch(() => {});
                    return;
                }
                store.dispatch(event);
            });
        },
        dispose() {
            if (typeof unsubscribe === 'function') unsubscribe();
            unsubscribe = null;
        },
    });
}

function createWorkbenchClients(runtimeApi) {
    const clients = {
        session: createAgentSessionClient(runtimeApi),
        projection: createAgentProjectionClient(runtimeApi),
        interaction: createAgentInteractionClient(runtimeApi),
        workspace: createAgentWorkspaceClient(runtimeApi),
    };
    const registry = new Map();
    for (const [group, methods] of Object.entries(CLIENT_METHODS)) {
        for (const name of methods) {
            registry.set(name, clients[group][name]);
        }
    }
    return Object.freeze({
        ...clients,
        require(name) {
            if (!registry.has(name)) throw new Error(`Runtime API is outside Workbench client boundary: ${name}`);
            const method = registry.get(name);
            if (!method) throw new Error(`Runtime API unavailable: ${name}`);
            return method;
        },
        optional(name) {
            if (!registry.has(name)) throw new Error(`Runtime API is outside Workbench client boundary: ${name}`);
            return registry.get(name) || null;
        },
    });
}

export {
    CLIENT_METHODS,
    createAgentInteractionClient,
    createAgentProjectionClient,
    createAgentRuntimeEventSubscription,
    createAgentSessionClient,
    createAgentWorkspaceClient,
    createWorkbenchClients,
};
