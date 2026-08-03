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
        if (!await options.waitFrame()) return;
        if (!options.isSessionActive(renderSessionId)) return;
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
                if (element) {
                    fragment.appendChild(element);
                    elements.push(element);
                }
            }
            if (!await options.waitIdle()) return;
            if (!options.isSessionActive(renderSessionId)) return;
            const root = options.root();
            let insertPoint = root.firstChild;
            while (insertPoint?.classList?.contains('topic-timestamp-bubble')) insertPoint = insertPoint.nextSibling;
            if (insertPoint) root.insertBefore(fragment, insertPoint);
            else root.appendChild(fragment);
            elements.forEach((element) => processDeferred(element, renderSessionId, {
                ...renderContext,
                deferHeavy: true,
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
        if (!await options.waitFrame()) return;
        if (!options.isSessionActive(renderSessionId)) return;
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

export { createAgentRendererHistory };
