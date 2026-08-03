function resolveAvatarStyle(message, settings, participant) {
    if (message.role === 'user') {
        const theme = settings.userUseThemeColorsInChat === true;
        return {
            color: settings.userAvatarCalculatedColor,
            url: settings.userAvatarUrl,
            border: theme ? null : settings.userAvatarBorderColor,
            name: theme ? null : settings.userNameTextColor,
            colorName: true,
            theme,
        };
    }
    if (message.role !== 'assistant') return null;
    if (message.isGroupMessage) {
        const config = message.agentId
            ? participant?.config?.agents?.find((agent) => agent.id === message.agentId) : null;
        const theme = config?.useThemeColorsInChat === true;
        return {
            color: message.avatarColor,
            url: message.avatarUrl,
            border: theme ? null : config?.avatarBorderColor,
            name: theme ? null : config?.nameTextColor,
            colorName: false,
            theme,
        };
    }
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

export function createAgentRendererAvatarStyle({ document, getDominantColor }) {
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
