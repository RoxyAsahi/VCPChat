function escapeCssAttributeValue(windowRef, value) {
    const text = String(value);
    if (windowRef.CSS && typeof windowRef.CSS.escape === 'function') return windowRef.CSS.escape(text);
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function createAgentMessageDom(options) {
    const { documentRef, windowRef } = options;

    function cleanupScopedStyles(messageItem, messageId = null) {
        if (!messageItem && !messageId) return;
        const scopeId = messageItem?.id;
        if (scopeId) {
            documentRef.querySelectorAll(
                `style[data-vcp-scope-id="${escapeCssAttributeValue(windowRef, scopeId)}"]`,
            ).forEach((element) => element.remove());
        }
        const chatScopeId = messageItem?.getAttribute?.('data-chat-scope')
            || (messageId ? `vcp-chat-${messageId}` : null);
        if (chatScopeId) {
            documentRef.querySelectorAll(
                `style[data-chat-scope-id="${escapeCssAttributeValue(windowRef, chatScopeId)}"]`,
            ).forEach((element) => element.remove());
        }
    }

    function cleanupResources(messageItem, messageId = null) {
        if (!messageItem) return;
        const content = messageItem.querySelector('.md-content');
        if (content) {
            options.cleanupContent(content);
            options.cleanupAnimation(content);
        }
        cleanupScopedStyles(messageItem, messageId || messageItem.dataset?.messageId || null);
        options.unobserveMessage(messageItem);
    }

    function remove(messageId) {
        const item = options.getRoot()?.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (!item) return;
        cleanupResources(item, messageId);
        windowRef.pretextBridge?.evict?.(messageId);
        item.remove();
    }

    function clear() {
        options.invalidateSession();
        options.clearRenderCache();
        options.clearToolResults();
        const root = options.getRoot();
        if (root) {
            root.querySelectorAll('.message-item').forEach((item) => {
                cleanupResources(item, item.dataset?.messageId || null);
            });
            documentRef.querySelectorAll('style[data-vcp-scope-id], style[data-chat-scope-id]')
                .forEach((element) => element.remove());
            windowRef.pretextBridge?.clearAll?.();
            root.innerHTML = '';
        }
        options.clearStream();
    }

    return { cleanupScopedStyles, cleanupResources, remove, clear };
}

export { createAgentMessageDom };
