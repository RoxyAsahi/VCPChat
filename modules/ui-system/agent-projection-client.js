const METHODS = Object.freeze([
    'agentRuntimeGetStatus', 'agentRuntimeSearchTopics', 'agentRuntimeSearchTopicMessages',
    'agentRuntimeGetTopicIndexStatus', 'agentRuntimeRebuildTopicIndex',
    'agentRuntimeGetWorkbenchSettings', 'agentRuntimeUpdateWorkbenchSettings',
    'agentRuntimeListRecoveryOperations', 'agentRuntimeListRecoveryCandidates',
    'agentRuntimeResolveRecoveryOperation',
]);
function createAgentProjectionClient(runtimeApi) {
    return Object.freeze(Object.fromEntries(METHODS.map((name) => [name,
        typeof runtimeApi?.[name] === 'function' ? runtimeApi[name].bind(runtimeApi) : null])));
}
export { METHODS, createAgentProjectionClient };
