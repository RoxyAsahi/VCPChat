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
    DESKTOP_API_LIST: 'desktop-api:list',
    DESKTOP_API_DESCRIBE: 'desktop-api:describe',
    DESKTOP_API_CALL: 'desktop-api:call',
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
    [CHANNELS.DESKTOP_API_LIST, {
        channelName: CHANNELS.DESKTOP_API_LIST,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VDesktop Platform',
        requestSchema: { prefix: 'string?', query: 'string?' },
        responseSchema: { ok: 'boolean', data: 'array?', error: 'object?' },
        supportsConcurrent: true,
    }],
    [CHANNELS.DESKTOP_API_DESCRIBE, {
        channelName: CHANNELS.DESKTOP_API_DESCRIBE,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VDesktop Platform',
        requestSchema: { apiId: 'string' },
        responseSchema: { ok: 'boolean', data: 'object?', error: 'object?' },
        supportsConcurrent: true,
    }],
    [CHANNELS.DESKTOP_API_CALL, {
        channelName: CHANNELS.DESKTOP_API_CALL,
        channelType: CHANNEL_TYPES.QUERY,
        owner: 'VDesktop Platform',
        requestSchema: { apiId: 'string', params: 'object?' },
        responseSchema: { ok: 'boolean', id: 'string', data: 'any?', error: 'object?' },
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
