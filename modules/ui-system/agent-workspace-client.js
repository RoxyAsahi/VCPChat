const METHODS = Object.freeze([
    'agentWorkspaceListDirectory', 'agentWorkspaceReadPreview', 'agentWorkspaceSearchFiles',
    'agentWorkspaceStatPath', 'agentWorkspacePerformPathAction', 'agentWorkspaceCancel',
]);
function createAgentWorkspaceClient(runtimeApi) {
    return Object.freeze(Object.fromEntries(METHODS.map((name) => [name,
        typeof runtimeApi?.[name] === 'function' ? runtimeApi[name].bind(runtimeApi) : null])));
}
export { METHODS, createAgentWorkspaceClient };
