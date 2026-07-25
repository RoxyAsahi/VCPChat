const CHANNEL_TYPES = Object.freeze({
    COMMAND: 'command',
    QUERY: 'query',
    STREAM: 'stream',
    LIFECYCLE: 'lifecycle',
});

const CHANNELS = Object.freeze({
    WINDOW_READY: 'window-lifecycle:ready',
    DESKTOP_REMOTE_REQUEST: 'desktop-remote:request',
    DESKTOP_REMOTE_RESPONSE: 'desktop-remote:response',
    FLOWLOCK_REQUEST: 'flowlock:request',
    FLOWLOCK_RESPONSE: 'flowlock:response',
    DESKTOP_LAUNCH: 'desktop-launch-vchat-app',
    AGENT_RUNTIME_GET_STATUS: 'agent-runtime:get-status',
    AGENT_RUNTIME_START: 'agent-runtime:start',
    AGENT_RUNTIME_STOP: 'agent-runtime:stop',
    AGENT_RUNTIME_CREATE_SESSION: 'agent-runtime:create-session',
    AGENT_RUNTIME_LIST_SESSIONS: 'agent-runtime:list-sessions',
    AGENT_RUNTIME_START_TURN: 'agent-runtime:start-turn',
    AGENT_RUNTIME_CANCEL_TURN: 'agent-runtime:cancel-turn',
    AGENT_RUNTIME_RESPOND_APPROVAL: 'agent-runtime:respond-approval',
    AGENT_RUNTIME_SET_WORKBENCH_PRESENCE: 'agent-runtime:set-workbench-presence',
    AGENT_RUNTIME_EVENT: 'agent-runtime:event',
});

const channelRegistry = new Map([
    [CHANNELS.WINDOW_READY, {
        channelName: CHANNELS.WINDOW_READY,
        channelType: CHANNEL_TYPES.LIFECYCLE,
        owner: 'VChat Shell',
        requestSchema: { appId: 'string', payload: 'object?' },
        responseSchema: null,
        supportsConcurrent: true,
    }],
    [CHANNELS.DESKTOP_REMOTE_REQUEST, {
        channelName: CHANNELS.DESKTOP_REMOTE_REQUEST,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VDesktop Platform',
        requestSchema: { requestId: 'string', command: 'string', payload: 'object?' },
        responseSchema: { requestId: 'string', ok: 'boolean', data: 'object?', error: 'string?' },
        supportsConcurrent: true,
    }],
    [CHANNELS.DESKTOP_REMOTE_RESPONSE, {
        channelName: CHANNELS.DESKTOP_REMOTE_RESPONSE,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VDesktop Platform',
        requestSchema: { requestId: 'string', ok: 'boolean', data: 'object?', error: 'string?' },
        responseSchema: null,
        supportsConcurrent: true,
    }],
    [CHANNELS.FLOWLOCK_REQUEST, {
        channelName: CHANNELS.FLOWLOCK_REQUEST,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VChat Shell',
        requestSchema: { requestId: 'string', command: 'string', payload: 'object?' },
        responseSchema: { requestId: 'string', ok: 'boolean', data: 'object?', error: 'string?' },
        supportsConcurrent: true,
    }],
    [CHANNELS.FLOWLOCK_RESPONSE, {
        channelName: CHANNELS.FLOWLOCK_RESPONSE,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VChat Shell',
        requestSchema: { requestId: 'string', ok: 'boolean', data: 'object?', error: 'string?' },
        responseSchema: null,
        supportsConcurrent: true,
    }],
    [CHANNELS.DESKTOP_LAUNCH, {
        channelName: CHANNELS.DESKTOP_LAUNCH,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VChat Shell',
        requestSchema: { appAction: 'string' },
        responseSchema: { success: 'boolean', appId: 'string?' },
        supportsConcurrent: true,
    }],
    [CHANNELS.AGENT_RUNTIME_GET_STATUS, {
        channelName: CHANNELS.AGENT_RUNTIME_GET_STATUS,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'Agent Runtime',
        requestSchema: null,
        responseSchema: { state: 'string', protocolVersion: 'number', worker: 'object?', sessions: 'object[]' },
        supportsConcurrent: true,
    }],
    [CHANNELS.AGENT_RUNTIME_START, {
        channelName: CHANNELS.AGENT_RUNTIME_START,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'Agent Runtime',
        requestSchema: null,
        responseSchema: { state: 'string', protocolVersion: 'number', worker: 'object?' },
        supportsConcurrent: false,
    }],
    [CHANNELS.AGENT_RUNTIME_STOP, {
        channelName: CHANNELS.AGENT_RUNTIME_STOP,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'Agent Runtime',
        requestSchema: null,
        responseSchema: { state: 'string' },
        supportsConcurrent: false,
    }],
    [CHANNELS.AGENT_RUNTIME_CREATE_SESSION, {
        channelName: CHANNELS.AGENT_RUNTIME_CREATE_SESSION,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'Agent Runtime',
        requestSchema: { workspaceRoot: 'string?', model: 'string?', metadata: 'object?' },
        responseSchema: { sessionId: 'string', state: 'string' },
        supportsConcurrent: true,
    }],
    [CHANNELS.AGENT_RUNTIME_LIST_SESSIONS, {
        channelName: CHANNELS.AGENT_RUNTIME_LIST_SESSIONS,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'Agent Runtime',
        requestSchema: null,
        responseSchema: { sessions: 'object[]' },
        supportsConcurrent: true,
    }],
    [CHANNELS.AGENT_RUNTIME_START_TURN, {
        channelName: CHANNELS.AGENT_RUNTIME_START_TURN,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'Agent Runtime',
        requestSchema: { sessionId: 'string', prompt: 'string' },
        responseSchema: { turnId: 'string', state: 'string' },
        supportsConcurrent: true,
    }],
    [CHANNELS.AGENT_RUNTIME_CANCEL_TURN, {
        channelName: CHANNELS.AGENT_RUNTIME_CANCEL_TURN,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'Agent Runtime',
        requestSchema: { sessionId: 'string', turnId: 'string?' },
        responseSchema: { ok: 'boolean' },
        supportsConcurrent: true,
    }],
    [CHANNELS.AGENT_RUNTIME_RESPOND_APPROVAL, {
        channelName: CHANNELS.AGENT_RUNTIME_RESPOND_APPROVAL,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'Agent Runtime',
        requestSchema: { approvalId: 'string', decision: 'string', sessionId: 'string?', turnId: 'string?', toolCallId: 'string?', argumentsHash: 'string?' },
        responseSchema: { approvalId: 'string', decision: 'string' },
        supportsConcurrent: true,
    }],
    [CHANNELS.AGENT_RUNTIME_SET_WORKBENCH_PRESENCE, {
        channelName: CHANNELS.AGENT_RUNTIME_SET_WORKBENCH_PRESENCE,
        channelType: CHANNEL_TYPES.COMMAND,
        owner: 'Agent Runtime',
        requestSchema: { mounted: 'boolean' },
        responseSchema: null,
        supportsConcurrent: true,
    }],
    [CHANNELS.AGENT_RUNTIME_EVENT, {
        channelName: CHANNELS.AGENT_RUNTIME_EVENT,
        channelType: CHANNEL_TYPES.STREAM,
        owner: 'Agent Runtime',
        requestSchema: null,
        responseSchema: null,
        supportsConcurrent: true,
    }],
]);

function getChannelMeta(channelName) {
    return channelRegistry.get(channelName) || null;
}

function listChannels() {
    return Array.from(channelRegistry.values());
}

module.exports = {
    CHANNELS,
    CHANNEL_TYPES,
    getChannelMeta,
    listChannels,
};
