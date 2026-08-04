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

function resolveAvatarStyle(message, settings, participant) {
    if (message.role === 'user') return userAvatarStyle(settings);
    if (message.role !== 'assistant') return null;
    if (message.isGroupMessage) return groupAvatarStyle(message, participant);
    return assistantAvatarStyle(message, participant);
}

function userAvatarStyle(settings) {
    const theme = settings.userUseThemeColorsInChat === true;
    return {
        color: settings.userAvatarCalculatedColor, url: settings.userAvatarUrl,
        border: theme ? null : settings.userAvatarBorderColor,
        name: theme ? null : settings.userNameTextColor, colorName: true, theme,
    };
}

function groupAvatarStyle(message, participant) {
    const config = message.agentId
        ? participant?.config?.agents?.find((agent) => agent.id === message.agentId) : null;
    const theme = config?.useThemeColorsInChat === true;
    return {
        color: message.avatarColor, url: message.avatarUrl,
        border: theme ? null : config?.avatarBorderColor,
        name: theme ? null : config?.nameTextColor, colorName: false, theme,
    };
}

function assistantAvatarStyle(message, participant) {
    const config = participant?.config || participant;
    const theme = config?.useThemeColorsInChat === true;
    return {
        color: participant?.config?.avatarCalculatedColor || participant?.avatarCalculatedColor
            || participant?.config?.avatarColor || participant?.avatarColor || message.avatarColor,
        url: message.avatarUrl || participant?.avatarUrl,
        border: theme ? null : config?.avatarBorderColor,
        name: theme ? null : config?.nameTextColor,
        colorName: false,
        theme,
    };
}

function applyChatCss({ document, message, messageItem, participant }) {
    if (message.role !== 'assistant') return;
    const config = message.isGroupMessage && message.agentId
        ? participant?.config?.agents?.find((agent) => agent.id === message.agentId)
        : participant?.config || participant;
    const chatCss = String(config?.chatCss || '').trim();
    if (!chatCss) return;
    const scopeId = `vcp-chat-${message.id}`;
    messageItem.dataset.chatScope = scopeId;
    document.head.querySelector(`style[data-chat-scope-id="${scopeId}"]`)?.remove();
    const style = document.createElement('style');
    style.type = 'text/css';
    style.dataset.chatScopeId = scopeId;
    style.textContent = `[data-chat-scope="${scopeId}"] ${chatCss}`;
    document.head.append(style);
}

function createAgentRendererAvatarStyle({ document, getDominantColor }) {
    function apply({ message, messageItem, avatarImg, senderNameDiv, settings, participant }) {
        if (!avatarImg || !senderNameDiv) return;
        const style = resolveAvatarStyle(message, settings, participant);
        if (!style) return;
        const applyColor = (color) => {
            if (!color) {
                messageItem.style.removeProperty('--dynamic-avatar-color');
                return;
            }
            messageItem.style.setProperty('--dynamic-avatar-color', color);
            Object.assign(avatarImg.style, { borderColor: color, borderWidth: '2px', borderStyle: 'solid' });
            if (style.colorName) senderNameDiv.style.color = color;
        };
        if (style.theme) {
            messageItem.style.removeProperty('--dynamic-avatar-color');
            avatarImg.style.removeProperty('border-color');
            senderNameDiv.style.removeProperty('color');
        } else if (style.border) {
            Object.assign(avatarImg.style, { borderColor: style.border, borderWidth: '2px', borderStyle: 'solid' });
        } else if (style.color) {
            applyColor(style.color);
        } else if (style.url && !style.url.includes('default_')) {
            avatarImg.style.borderColor = 'var(--border-color)';
            getDominantColor(style.url).then((color) => {
                if (!color || !messageItem.isConnected) return;
                if (!style.border) applyColor(color);
                else if (style.colorName) senderNameDiv.style.color = color;
            }).catch((error) => console.warn(`[Color] Failed to extract dominant color for ${style.url}:`, error));
        } else {
            messageItem.style.removeProperty('--dynamic-avatar-color');
        }
        if (style.name) senderNameDiv.style.color = style.name;
        applyChatCss({ document, message, messageItem, participant });
    }
    return { apply };
}

function createAgentRendererHistory(options) {
    function shouldRunHeavy(messageItem, renderContext = {}) {
        if (renderContext.forceHeavy === true) return true;
        if (renderContext.deferHeavy === true) return options.isMessageInHotZone(messageItem);
        return true;
    }
    function processDeferred(element, renderSessionId, renderContext = {}) {
        if (!options.isSessionActive(renderSessionId) || !element.isConnected) {
            delete element._vcp_process;
            delete element._vcp_renderSessionId;
            return;
        }
        options.observeMessage(element);
        if (typeof element._vcp_process === 'function') {
            element._vcp_process({ runHeavy: shouldRunHeavy(element, renderContext) });
            delete element._vcp_process;
        }
        delete element._vcp_renderSessionId;
    }
    async function renderBatch(messages, scrollToBottom = false,
        renderSessionId = options.activeSessionId(), renderContext = {}) {
        if (!options.isSessionActive(renderSessionId)) return;
        const fragment = options.document.createDocumentFragment();
        const elements = [];
        const results = await Promise.allSettled(messages.map((message) => (
            options.renderMessage(message, true, false, renderSessionId, renderContext)
        )));
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) elements.push(result.value);
            else if (result.status === 'rejected') options.onError(messages[index], result.reason);
        });
        if (!options.isSessionActive(renderSessionId)) return;
        elements.forEach((element) => fragment.appendChild(element));
        if (!await options.waitFrame() || !options.isSessionActive(renderSessionId)) return;
        options.root().appendChild(fragment);
        elements.forEach((element) => processDeferred(element, renderSessionId, renderContext));
        if (scrollToBottom && options.isSessionActive(renderSessionId)) options.scrollToBottom();
    }
    async function renderOlder(messages, batchSize, batchDelay,
        renderSessionId = options.activeSessionId(), renderContext = {}) {
        const totalBatches = Math.ceil(messages.length / batchSize);
        for (let index = totalBatches - 1; index >= 0; index -= 1) {
            if (!options.isSessionActive(renderSessionId)) return;
            const start = index * batchSize;
            const batch = messages.slice(start, Math.min(start + batchSize, messages.length));
            const fragment = options.document.createDocumentFragment();
            const elements = [];
            for (const message of batch) {
                if (!options.isSessionActive(renderSessionId)) return;
                const element = await options.renderMessage(message, true, false, renderSessionId, renderContext);
                if (element) { fragment.appendChild(element); elements.push(element); }
            }
            if (!await options.waitIdle() || !options.isSessionActive(renderSessionId)) return;
            const root = options.root();
            let insertPoint = root.firstChild;
            while (insertPoint?.classList?.contains('topic-timestamp-bubble')) insertPoint = insertPoint.nextSibling;
            if (insertPoint) root.insertBefore(fragment, insertPoint); else root.appendChild(fragment);
            elements.forEach((element) => processDeferred(element, renderSessionId, {
                ...renderContext, deferHeavy: true,
            }));
            if (!options.isSessionActive(renderSessionId)) return;
            if (index > 0 && batchDelay > 0) {
                const delay = batch.length < batchSize / 2 ? batchDelay / 2 : batchDelay;
                if (!await options.delay(delay)) return;
            }
        }
    }
    async function renderLegacy(history, renderSessionId = options.activeSessionId(), renderContext = {}) {
        if (!options.isSessionActive(renderSessionId)) return;
        const fragment = options.document.createDocumentFragment();
        const elements = [];
        for (const message of history) {
            if (!options.isSessionActive(renderSessionId)) return;
            const element = await options.renderMessage(message, true, false, renderSessionId, renderContext);
            if (element) elements.push(element);
        }
        if (!options.isSessionActive(renderSessionId)) return;
        elements.forEach((element) => fragment.appendChild(element));
        if (!await options.waitFrame() || !options.isSessionActive(renderSessionId)) return;
        options.root().appendChild(fragment);
        elements.forEach((element) => processDeferred(element, renderSessionId, renderContext));
        if (options.isSessionActive(renderSessionId)) options.scrollToBottom();
    }
    async function render(history, settings = {}) {
        const renderSessionId = options.invalidateSession();
        const { initialBatch = 5, batchSize = 10, batchDelay = 100 } = settings;
        await options.initializeDependencies();
        if (!history?.length) return;
        const renderContext = { depthMap: options.buildDepthMap(history) };
        if (history.length <= initialBatch) return renderLegacy(history, renderSessionId, renderContext);
        const latest = history.slice(-initialBatch);
        const older = history.slice(0, -initialBatch);
        await renderBatch(latest, true, renderSessionId, renderContext);
        if (!options.isSessionActive(renderSessionId)) return;
        if (older.length) await renderOlder(older, batchSize, batchDelay, renderSessionId, renderContext);
        if (options.isSessionActive(renderSessionId)) options.scrollToBottom();
    }
    return { render, renderBatch, renderLegacy };
}

export { createAgentMessageDom, createAgentRendererAvatarStyle, createAgentRendererHistory, resolveAvatarStyle };
