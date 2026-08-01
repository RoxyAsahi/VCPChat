function requireFunction(value, name) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
    return value;
}

function createAgentRenderContext(options = {}) {
    const container = options.container;
    if (!container) throw new TypeError('Agent render container is required');
    const getSessionContext = requireFunction(options.getSessionContext, 'getSessionContext');
    const actions = Object.freeze({ ...(options.actions || {}) });

    return Object.freeze({
        chatMessagesDiv: container,
        markedInstance: options.markedInstance,
        electronAPI: Object.freeze({ ...(options.electronAPI || {}) }),
        uiHelper: Object.freeze({
            scrollToBottom: options.scrollToBottom || (() => {}),
            showToastNotification: options.notify || (() => {}),
        }),
        actions,
        getSessionContext(subject) {
            const value = getSessionContext(subject) || {};
            return {
                sessionId: value.sessionId || null,
                threadId: value.threadId || null,
                participant: Object.freeze({ ...(value.participant || {}) }),
                messages: Object.freeze((value.messages || []).map((message) => Object.freeze({ ...message }))),
                settings: Object.freeze({ ...(value.settings || {}) }),
            };
        },
        globalSettingsRef: Object.freeze({
            get: () => ({ ...(getSessionContext(null)?.settings || {}) }),
        }),
    });
}

export { createAgentRenderContext };
