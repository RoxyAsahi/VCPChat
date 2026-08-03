const METHODS = Object.freeze([
    'agentRuntimeStart', 'agentRuntimeStop', 'agentRuntimeStartTurn', 'agentRuntimeSteerTurn',
    'agentRuntimeFollowUpTurn', 'agentRuntimeCancelTurn', 'agentRuntimeRespondApproval',
    'agentRuntimeRespondInteraction', 'agentRuntimeListInteractionQueue',
    'agentRuntimeReplaceInteractionQueue', 'agentRuntimeClearInteractionQueue',
    'agentRuntimeResolvePendingInput',
]);
function createAgentInteractionClient(runtimeApi) {
    return Object.freeze(Object.fromEntries(METHODS.map((name) => [name,
        typeof runtimeApi?.[name] === 'function' ? runtimeApi[name].bind(runtimeApi) : null])));
}
export { METHODS, createAgentInteractionClient };
