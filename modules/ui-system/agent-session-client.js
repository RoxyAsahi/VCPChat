const METHODS = Object.freeze([
    'agentSessionCreate', 'agentSessionList', 'agentSessionRead', 'agentSessionReadProjection',
    'agentSessionRename', 'agentSessionArchive', 'agentSessionRestore', 'agentSessionDelete', 'agentSessionFork',
    'agentRuntimeEnsureSessionRuntime', 'agentRuntimeSetSessionPinned', 'agentRuntimeCompactSession',
    'agentRuntimeExportSession', 'agentRuntimeApplyAgentProfile', 'agentRuntimeSelectAttachments',
    'agentRuntimeUpdateSessionConfig',
]);
function createAgentSessionClient(runtimeApi) {
    return Object.freeze(Object.fromEntries(METHODS.map((name) => [name,
        typeof runtimeApi?.[name] === 'function' ? runtimeApi[name].bind(runtimeApi) : null])));
}
export { METHODS, createAgentSessionClient };
