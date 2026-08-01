import { normalizeAgentPresentationPart } from './contract.js';

function textOf(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
    return textOf(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function createFallbackSkeleton(document, message) {
    const messageItem = document.createElement('div');
    messageItem.className = `message-item ${message.role}`;
    messageItem.dataset.messageId = message.id;
    const detailsAndBubbleWrapper = document.createElement('div');
    detailsAndBubbleWrapper.className = 'details-and-bubble-wrapper';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'md-content';
    detailsAndBubbleWrapper.append(contentDiv);
    messageItem.append(detailsAndBubbleWrapper);
    return { messageItem, contentDiv, detailsAndBubbleWrapper };
}

function ensureBlockHost(document, row, contentDiv) {
    let host = row.querySelector(':scope .agent-presentation-blocks');
    if (!host) {
        host = document.createElement('div');
        host.className = 'agent-presentation-blocks';
        contentDiv.insertAdjacentElement('afterend', host);
    }
    return host;
}

function patchTextBlock(contentDiv, block, dependencies, streaming) {
    const text = textOf(block.text ?? block.content);
    if (contentDiv.dataset.agentSourceText === text && contentDiv.dataset.agentStreaming === String(streaming)) return;
    contentDiv.dataset.agentSourceText = text;
    contentDiv.dataset.agentStreaming = String(streaming);
    if (streaming) {
        contentDiv.textContent = text;
    } else {
        contentDiv.innerHTML = dependencies.renderContent(text, { streaming: false });
        dependencies.runPostRender?.(contentDiv);
    }
}

function createBlockNode(document, block) {
    const element = document.createElement('section');
    element.dataset.agentBlockKey = block.key;
    element.dataset.agentBlockKind = block.kind;
    element.className = `agent-presentation-block agent-presentation-${block.kind}`;
    return element;
}

function patchBlockNode(element, block, dependencies, streaming) {
    element.dataset.state = block.state || '';
    if (block.kind === 'reasoning') {
        const text = textOf(block.text ?? block.content);
        if (element.dataset.agentSourceText !== text || element.dataset.agentStreaming !== String(streaming)) {
            element.dataset.agentSourceText = text;
            element.dataset.agentStreaming = String(streaming);
            element.innerHTML = dependencies.renderReasoning(text, { streaming });
            if (!streaming) dependencies.runPostRender?.(element);
        }
        return;
    }
    if (block.kind === 'attachment') {
        element.classList.add('message-attachment-item');
        const label = block.name || block.fileName || block.uri || block.mimeType || '附件';
        element.textContent = label;
        if (block.uri) element.title = block.uri;
        return;
    }
    if (block.kind === 'tool') {
        element.classList.add('vcp-tool-call-summary-bubble');
        let title = element.querySelector('.agent-presentation-tool-title');
        let summary = element.querySelector('.agent-presentation-tool-summary');
        if (!title) {
            title = element.ownerDocument.createElement('div');
            title.className = 'agent-presentation-tool-title';
            summary = element.ownerDocument.createElement('pre');
            summary.className = 'agent-presentation-tool-summary';
            element.append(title, summary);
        }
        title.textContent = `${block.name || 'tool'} · ${block.state || 'requested'}`;
        summary.textContent = textOf(block.summary || block.payload || '');
        return;
    }
    element.textContent = textOf(block.text ?? block.summary ?? block.content ?? block.message);
}

function reconcileBlocks(document, host, blocks, dependencies, streaming) {
    const existing = new Map([...host.children].map((node) => [node.dataset.agentBlockKey, node]));
    const desired = new Set();
    for (const block of blocks) {
        desired.add(block.key);
        let element = existing.get(block.key);
        if (!element) element = createBlockNode(document, block);
        patchBlockNode(element, block, dependencies, streaming);
        host.append(element);
    }
    for (const [key, element] of existing) {
        if (!desired.has(key)) element.remove();
    }
}

function createMessageRow(part, dependencies) {
    const normalized = normalizeAgentPresentationPart(part);
    const message = {
        id: normalized.id,
        role: normalized.role,
        timestamp: normalized.createdAt,
        name: normalized.name,
        avatarUrl: normalized.avatarUrl,
    };
    const skeleton = dependencies.createMessageSkeleton
        ? dependencies.createMessageSkeleton(message, dependencies.globalSettings || {}, dependencies.selectedAgent || {})
        : createFallbackSkeleton(dependencies.document, message);
    const row = skeleton.messageItem;
    row.dataset.agentPresentationKey = normalized.key;
    row.__agentPresentation = skeleton;
    patchMessageRow(row, part, dependencies);
    return row;
}

function patchMessageRow(row, part, dependencies) {
    const normalized = normalizeAgentPresentationPart(part);
    const skeleton = row.__agentPresentation || {
        contentDiv: row.querySelector('.md-content'),
    };
    const contentDiv = skeleton.contentDiv;
    if (!contentDiv) throw new Error('Agent presentation message row has no .md-content');
    const streaming = normalized.state === 'streaming' || normalized.state === 'running';
    row.dataset.state = normalized.state;
    row.classList.toggle('streaming', streaming);
    const textBlock = normalized.blocks.find((block) => block.kind === 'text');
    if (textBlock) patchTextBlock(contentDiv, textBlock, dependencies, streaming);
    else contentDiv.replaceChildren();
    const host = ensureBlockHost(dependencies.document, row, contentDiv);
    reconcileBlocks(
        dependencies.document,
        host,
        normalized.blocks.filter((block) => block.kind !== 'text'),
        dependencies,
        streaming,
    );
    return row;
}

function createStandaloneBlockRow(part, dependencies) {
    const normalized = normalizeAgentPresentationPart(part);
    const row = dependencies.document.createElement('div');
    row.className = `message-item system-message-layout agent-presentation-${normalized.kind}-row`;
    row.dataset.agentPresentationKey = normalized.key;
    patchStandaloneBlockRow(row, part, dependencies);
    return row;
}

function patchStandaloneBlockRow(row, part, dependencies) {
    const normalized = normalizeAgentPresentationPart(part);
    row.dataset.state = normalized.state;
    reconcileBlocks(dependencies.document, row, normalized.blocks, dependencies, false);
    return row;
}

function createAgentPresentationCallbacks(options = {}) {
    const document = options.document || globalThis.document;
    if (!document) throw new TypeError('document is required');
    const dependencies = {
        document,
        createMessageSkeleton: options.createMessageSkeleton,
        globalSettings: options.globalSettings || {},
        selectedAgent: options.selectedAgent || {},
        renderContent: options.renderContent || escapeHtml,
        renderReasoning: options.renderReasoning || escapeHtml,
        runPostRender: options.runPostRender,
    };
    return {
        create(part) {
            return part.kind === 'message'
                ? createMessageRow(part, dependencies)
                : createStandaloneBlockRow(part, dependencies);
        },
        patch(row, part) {
            return part.kind === 'message'
                ? patchMessageRow(row, part, dependencies)
                : patchStandaloneBlockRow(row, part, dependencies);
        },
    };
}

export { createAgentPresentationCallbacks };
