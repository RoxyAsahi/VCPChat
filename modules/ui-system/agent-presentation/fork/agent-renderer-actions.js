function createAgentRendererActions(options) {
    function onClick(event) {
        const toolHeader = event.target.closest('.vcp-tool-result-header');
        if (toolHeader) {
            toolHeader.closest('.vcp-tool-result-bubble.collapsible')?.classList.toggle('expanded');
            return;
        }
        const thoughtHeader = event.target.closest('.vcp-thought-chain-header');
        if (thoughtHeader) {
            thoughtHeader.closest('.vcp-thought-chain-bubble.collapsible')?.classList.toggle('expanded');
            return;
        }
        const notice = event.target.closest('.vcp-tool-result-truncated-notice');
        if (notice) {
            const contentId = Number.parseInt(notice.dataset.contentId, 10);
            const fullData = options.getToolResult(contentId);
            const container = notice.previousElementSibling;
            if (fullData && container?.classList.contains('vcp-tool-result-markdown-content')) {
                options.renderToolResult(container, fullData);
                notice.remove();
                options.releaseToolResult(contentId);
            }
            return;
        }
        const avatar = event.target.closest('.message-avatar');
        if (avatar?.closest('.message-item')?.dataset.role === 'assistant') options.stopSpeech();
    }

    return { onClick, dispose() {} };
}

export { createAgentRendererActions };
