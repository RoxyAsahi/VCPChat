function unavailable(name) {
    return { available: false, name, reason: `${name} is unavailable` };
}

function createAgentWorkbenchHostAdapter({ windowRef = globalThis, documentRef = null, api = null } = {}) {
    const hostWindow = windowRef || {};
    const hostDocument = documentRef || hostWindow.document || null;
    const vcpUi = hostWindow.VCPUI;
    const adapter = {
        dom: {
            createElement: (tag) => hostDocument?.createElement?.(tag) || null,
            createText: (value) => hostDocument?.createTextNode?.(String(value ?? '')) || null,
            createFragment: () => hostDocument?.createDocumentFragment?.() || null,
            createSvg: (tag) => hostDocument?.createElementNS?.('http://www.w3.org/2000/svg', tag) || null,
        },
        viewport: {
            get innerWidth() { return Number(hostWindow.innerWidth) || 0; },
            get innerHeight() { return Number(hostWindow.innerHeight) || 0; },
            get activeElement() { return hostDocument?.activeElement || null; },
        },
        storage: {
            read: (key) => hostWindow.localStorage?.getItem?.(key) ?? null,
            write: (key, value) => hostWindow.localStorage?.setItem?.(key, value),
            remove: (key) => hostWindow.localStorage?.removeItem?.(key),
        },
        theme: {
            read: () => hostWindow.globalSettings?.theme || hostDocument?.documentElement?.dataset?.theme || null,
            toggle: () => hostWindow.toggleTheme?.() ?? unavailable('theme.toggle'),
            subscribe: (listener) => {
                if (!hostWindow.addEventListener) return () => {};
                hostWindow.addEventListener('themechange', listener);
                return () => hostWindow.removeEventListener?.('themechange', listener);
            },
        },
        presentation: {
            read: () => hostWindow.globalSettings?.chatPresentationMode || 'bubble',
            set: (value) => hostWindow.setChatPresentationMode?.(value) ?? unavailable('presentation.set'),
        },
        account: {
            get avatarUrl() { return hostWindow.globalSettings?.userAvatarUrl || ''; },
            get userName() { return hostWindow.globalSettings?.userName || ''; },
        },
        feedback: {
            toast: (message, options) => vcpUi?.feedback?.toast?.(message, options) ?? unavailable('feedback.toast'),
            confirm: async (options) => {
                if (typeof vcpUi?.feedback?.confirm !== 'function') return unavailable('feedback.confirm');
                return vcpUi.feedback.confirm(typeof options === 'string' ? { message: options } : options);
            },
            edit: async (options) => {
                if (typeof vcpUi?.feedback?.prompt !== 'function') return unavailable('feedback.edit');
                return vcpUi.feedback.prompt(typeof options === 'string' ? { message: options } : options);
            },
        },
        clipboard: { writeText: (value) => hostWindow.navigator?.clipboard?.writeText?.(String(value ?? '')) },
        markdown: {
            render: (value) => hostWindow.vcpRenderBridge?.renderContent?.(value)
                || hostWindow.parseAgentMarkdown?.(value)
                || String(value ?? ''),
            postProcess: (node) => hostWindow.vcpRenderBridge?.runPostRender?.(node),
        },
        vcpBridge: {
            autoScrollToBottom: (node) => hostWindow.vcpRenderBridge?.autoScrollToBottom?.(node),
            isNearBottom: (node, threshold) => hostWindow.vcpRenderBridge?.isNearBottom?.(node, threshold),
        },
        api: api || hostWindow.chatAPI || hostWindow.electronAPI || {},
    };
    return Object.freeze(adapter);
}

export { createAgentWorkbenchHostAdapter };
