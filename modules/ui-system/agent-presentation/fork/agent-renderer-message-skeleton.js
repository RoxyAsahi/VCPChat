function pad(value) {
    return String(value).padStart(2, '0');
}

function formatMessageTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function applyUserMessageLayoutState(messageItem, settings = {}) {
    if (!messageItem?.classList?.contains('user')) return;
    messageItem.classList.remove('user-bubble-ui-enabled', 'user-bubble-ui-disabled', 'user-bubble-meta-hidden');
    if (settings.enableUserChatBubbleUi === false) {
        messageItem.classList.add('user-bubble-ui-disabled');
        return;
    }
    messageItem.classList.add('user-bubble-ui-enabled');
    if (settings.showUserMetaInChatBubbleUi === false) messageItem.classList.add('user-bubble-meta-hidden');
}

function createMessageSkeleton(message, settings = {}, participant = {}) {
    const documentRef = globalThis.document;
    if (!documentRef) throw new Error('Agent message rendering requires a document');
    const messageItem = documentRef.createElement('div');
    messageItem.classList.add('message-item', message.role);
    messageItem.dataset.role = message.role;
    messageItem.dataset.timestamp = String(message.timestamp || '');
    messageItem.dataset.messageId = String(message.id || '');
    if (message.agentId) messageItem.dataset.agentId = String(message.agentId);
    if (message.isGroupMessage) messageItem.classList.add('group-message-item');
    applyUserMessageLayoutState(messageItem, settings);

    const contentDiv = documentRef.createElement('div');
    contentDiv.className = 'md-content';
    if (!['user', 'assistant'].includes(message.role)) {
        messageItem.classList.add('system-message-layout');
        messageItem.append(contentDiv);
        return {
            messageItem, contentDiv, avatarImg: null, senderNameDiv: null,
            nameTimeDiv: null, detailsAndBubbleWrapper: null,
        };
    }

    const assistant = message.role === 'assistant';
    const participantConfig = participant?.config || participant;
    const avatar = assistant
        ? message.avatarUrl || participant.avatarUrl || participantConfig.avatarUrl || 'assets/default_avatar.png'
        : settings.userAvatarUrl || 'assets/default_user_avatar.png';
    const sender = assistant
        ? message.name || participant.name || participantConfig.name || 'AI'
        : message.name || settings.userName || '\u4f60';

    const avatarImg = documentRef.createElement('img');
    avatarImg.className = 'chat-avatar';
    avatarImg.src = avatar;
    avatarImg.alt = `${sender} \u5934\u50cf`;
    avatarImg.onerror = () => {
        avatarImg.onerror = null;
        avatarImg.src = assistant ? 'assets/default_avatar.png' : 'assets/default_user_avatar.png';
    };

    const nameTimeDiv = documentRef.createElement('div');
    nameTimeDiv.className = 'name-time-block';
    const senderNameDiv = documentRef.createElement('div');
    senderNameDiv.className = 'sender-name';
    senderNameDiv.textContent = sender;
    nameTimeDiv.append(senderNameDiv);
    if (message.timestamp && !message.isThinking) {
        const timestamp = documentRef.createElement('div');
        timestamp.className = 'message-timestamp';
        timestamp.textContent = formatMessageTimestamp(message.timestamp);
        nameTimeDiv.append(timestamp);
    }

    const detailsAndBubbleWrapper = documentRef.createElement('div');
    detailsAndBubbleWrapper.className = 'details-and-bubble-wrapper';
    detailsAndBubbleWrapper.append(nameTimeDiv, contentDiv);
    messageItem.append(avatarImg, detailsAndBubbleWrapper);
    return { messageItem, contentDiv, avatarImg, senderNameDiv, nameTimeDiv, detailsAndBubbleWrapper };
}

export { applyUserMessageLayoutState, createMessageSkeleton, formatMessageTimestamp };
