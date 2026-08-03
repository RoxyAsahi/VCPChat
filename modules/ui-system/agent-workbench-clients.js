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
    });
}

export { CLIENT_METHODS, createWorkbenchClients };
import { createAgentSessionClient } from './agent-session-client.js';
import { createAgentProjectionClient } from './agent-projection-client.js';
import { createAgentInteractionClient } from './agent-interaction-client.js';
import { createAgentWorkspaceClient } from './agent-workspace-client.js';
