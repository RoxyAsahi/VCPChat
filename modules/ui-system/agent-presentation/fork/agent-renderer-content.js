function createAgentRendererContent(options) {
    async function renderPostProcessedHtml(contentDiv, rawHtml, renderOptions = {}) {
        if (!contentDiv) return;
        const {
            messageId = null,
            message = null,
            settings = options.getSettings(),
            renderSessionId = options.getActiveRenderSessionId(),
            runHeavy = true,
            includeAttachments = true,
            deferHighlights = true,
        } = renderOptions;
        const messageItem = contentDiv.closest?.('.message-item');
        const isStillValid = () => {
            if (renderSessionId !== null && !options.isRenderSessionActive(renderSessionId)) return false;
            if (!contentDiv.isConnected) return false;
            if (messageItem && !messageItem.isConnected) return false;
            return true;
        };
        if (typeof rawHtml === 'string') {
            options.cleanupPreviews(contentDiv);
            options.cleanupAnimation(contentDiv);
            options.setImageContent(contentDiv, rawHtml, messageId);
        }
        if (!isStillValid()) return;
        if (includeAttachments && message) {
            contentDiv.querySelector('.message-attachments')?.remove();
            await options.renderAttachments(message, contentDiv);
        }
        if (!isStillValid()) return;
        if (!runHeavy) {
            if (messageItem) messageItem.dataset.vcpHeavyPending = 'true';
            contentDiv.dataset.vcpHeavyPending = 'true';
            return;
        }
        options.processRenderedContent(contentDiv, settings);
        await options.renderMermaid(contentDiv);
        if (!isStillValid()) return;
        if (deferHighlights) {
            setTimeout(() => {
                if (isStillValid()) options.highlight(contentDiv);
            }, 0);
        } else {
            options.highlight(contentDiv);
        }
        options.processAnimation(contentDiv);
        if (messageItem) {
            messageItem.dataset.vcpHeavyActivated = 'true';
            delete messageItem.dataset.vcpHeavyPending;
        }
        contentDiv.dataset.vcpHeavyActivated = 'true';
        delete contentDiv.dataset.vcpHeavyPending;
    }

    return { renderPostProcessedHtml };
}

export { createAgentRendererContent };
