import { createMessageSkeleton, formatMessageTimestamp } from './agent-renderer-message-skeleton.js';

function createAgentRendererMessageLifecycle(options) {
    function normalizeContent(message) {
        if (typeof message.content === 'string') return message.content;
        if (message.content && typeof message.content.text === 'string') return message.content.text;
        if (message.content === null || message.content === undefined) {
            console.warn('[MessageRenderer] message.content is null or undefined for message ID:', message.id);
            return '';
        }
        console.warn('[MessageRenderer] Unexpected message.content type. Message ID:', message.id, 'Content:', JSON.stringify(message.content));
        return '[消息内容格式异常]';
    }

    function applyMessageTransforms(text, message, messageItem, depth, participant) {
        let transformed = text;
        if (message.role === 'user') {
            transformed = options.prepareUserMessageText(transformed);
        } else if (message.role === 'assistant') {
            let scopeId = messageItem.id;
            if (!scopeId) {
                scopeId = options.generateUniqueId();
                messageItem.id = scopeId;
            }
            transformed = options.processAssistantScopedHtmlContent(transformed, scopeId, messageItem);
        }
        const agentConfig = participant?.config || participant;
        if (Array.isArray(agentConfig?.stripRegexes)) {
            transformed = options.applyFrontendRegexRules(transformed, agentConfig.stripRegexes, message.role, depth);
        }
        return transformed;
    }

    function schedulePretextEstimate(messageId, text, container) {
        const bridge = options.pretextBridge;
        if (!bridge?.isReady?.() || !messageId || !text) return;
        const run = () => {
            try {
                bridge.estimateHeight(messageId, text, 'body', container ? container.clientWidth : 800);
            } catch {
                // Pretext is an optional optimization.
            }
        };
        options.requestIdle(run, { timeout: 300 });
    }

    function renderMessageBody({ message, messageItem, contentDiv, participant, settings,
        history, renderContext, renderSessionId, chatMessagesDiv }) {
        const precomputedDepth = renderContext.depthMap?.get?.(message.id);
        const depth = precomputedDepth !== undefined
            ? precomputedDepth
            : options.calculateDepthByTurns(message.id, history.some((entry) => entry.id === message.id)
                ? [...history] : [...history, message]);
        const text = applyMessageTransforms(normalizeContent(message), message, messageItem, depth, participant);
        const html = options.renderMarkdownToHtml(text, { settings, messageRole: message.role, depth })
            .replace(/viewBox="0 "/g, 'viewBox="0 0 24 24"');
        contentDiv.innerHTML = html;
        schedulePretextEstimate(message.id, text, chatMessagesDiv);
        const postProcess = (postOptions = {}) => {
            if (!options.isRenderSessionActive(renderSessionId) || !messageItem.isConnected || !contentDiv.isConnected) return;
            return options.renderPostProcessedHtml(contentDiv, html, {
                messageId: message.id, message, settings, renderSessionId,
                runHeavy: postOptions.runHeavy !== false, includeAttachments: true,
            });
        };
        messageItem._vcp_activateHeavy = () => {
            if (messageItem.dataset.vcpHeavyActivated === 'true') return;
            return postProcess({ runHeavy: true });
        };
        if (messageItem._vcp_appendToDom) {
            options.requestFrame(() => {
                if (options.isRenderSessionActive(renderSessionId) && messageItem.isConnected) postProcess();
            });
        } else {
            messageItem._vcp_process = postProcess;
            messageItem._vcp_renderSessionId = renderSessionId;
        }
    }

    function renderMessage(message, isInitialLoad = false, appendToDom = true, renderSessionId = options.getActiveRenderSessionId(), renderContext = {}) {
        const context = options.getContext();
        const { chatMessagesDiv, electronAPI, markedInstance } = context;
        if (!chatMessagesDiv || !electronAPI || !markedInstance) {
            console.error('MessageRenderer: Missing critical references for rendering.');
            return null;
        }
        if (!message.id) message.id = `msg_${message.timestamp}_${Math.random().toString(36).substring(2, 9)}`;

        const settings = options.getSettings();
        const participant = options.getParticipant();
        const history = options.getMessages();
        const { messageItem, contentDiv, avatarImg, senderNameDiv } = createMessageSkeleton(message, settings, participant);
        messageItem.dataset.vcpInitialLoad = isInitialLoad ? 'true' : 'false';
        if (message.role === 'assistant') messageItem.id = options.generateUniqueId();
        if (appendToDom) {
            chatMessagesDiv.appendChild(messageItem);
            options.observeMessage(messageItem);
        }

        const activeStream = message.role === 'assistant'
            && (message.state === 'streaming' || message.isStreaming === true || options.getStreamController().has(message.id));
        const empty = message.content == null || (typeof message.content === 'string' && message.content.trim() === '');
        if (message.isThinking || (activeStream && empty)) {
            contentDiv.innerHTML = `<span class="thinking-indicator">${message.content || '思考中'}<span class="thinking-indicator-dots">...</span></span>`;
            messageItem.classList.add(message.isThinking ? 'thinking' : 'streaming');
        } else {
            if (activeStream) messageItem.classList.add('streaming');
            messageItem._vcp_appendToDom = appendToDom;
            renderMessageBody({ message, messageItem, contentDiv, participant, settings,
                history, renderContext, renderSessionId, chatMessagesDiv });
        }

        options.applyAvatar({ message, messageItem, avatarImg, senderNameDiv, settings, participant });
        if (isInitialLoad && message.isThinking && !activeStream) {
            messageItem.remove();
            return null;
        }
        if (appendToDom) context.uiHelper.scrollToBottom();
        return messageItem;
    }

    async function renderFullMessage(messageId, fullContent) {
        const context = options.getContext();
        const history = options.getMessages();
        const participant = options.getParticipant();
        const projected = history.find((message) => message.id === messageId)
            || { id: messageId, role: 'assistant', timestamp: Date.now() };
        const messageItem = context.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        if (!messageItem) return;
        messageItem.classList.remove('thinking', 'streaming');
        const contentDiv = messageItem.querySelector('.md-content');
        if (!contentDiv) return;
        const nameTimeBlock = messageItem.querySelector('.name-time-block');
        if (nameTimeBlock && !nameTimeBlock.querySelector('.message-timestamp')) {
            const timestamp = options.documentRef.createElement('div');
            timestamp.classList.add('message-timestamp');
            timestamp.textContent = formatMessageTimestamp(projected.timestamp || Date.now());
            nameTimeBlock.appendChild(timestamp);
        }
        const depth = history.some((message) => message.id === messageId)
            ? options.calculateDepthByTurns(messageId, history)
            : 0;
        const text = applyMessageTransforms(fullContent, { ...projected, role: projected.role || 'assistant' }, messageItem, depth, participant);
        const settings = options.getSettings();
        const html = options.renderMarkdownToHtml(text, { settings, messageRole: projected.role || 'assistant', depth });
        await options.renderPostProcessedHtml(contentDiv, html, {
            messageId,
            message: { ...projected, content: text },
            settings,
            renderSessionId: null,
            runHeavy: true,
            includeAttachments: history.some((message) => message.id === messageId),
        });
        context.uiHelper.scrollToBottom();
    }

    function updateMessageContent(messageId, newContent) {
        const context = options.getContext();
        const messageItem = context.chatMessagesDiv.querySelector(`.message-item[data-message-id="${messageId}"]`);
        const contentDiv = messageItem?.querySelector('.md-content');
        if (!contentDiv) return;
        const history = options.getMessages();
        const projected = history.find((message) => message.id === messageId)
            || { id: messageId, role: 'assistant' };
        const depth = options.calculateDepthByTurns(messageId, history);
        const raw = typeof newContent === 'string' ? newContent : (newContent?.text || '[内容格式异常]');
        const text = applyMessageTransforms(raw, projected, messageItem, depth, options.getParticipant());
        const settings = options.getSettings(messageId);
        const html = options.renderMarkdownToHtml(text, { settings, messageRole: projected.role || 'assistant', depth });
        options.renderPostProcessedHtml(contentDiv, html, {
            messageId,
            message: history.some((message) => message.id === messageId) ? { ...projected, content: newContent } : null,
            settings,
            renderSessionId: null,
            runHeavy: true,
            includeAttachments: history.some((message) => message.id === messageId),
        });
    }

    return { renderMessage, renderFullMessage, updateMessageContent };
}

export { createAgentRendererMessageLifecycle };
