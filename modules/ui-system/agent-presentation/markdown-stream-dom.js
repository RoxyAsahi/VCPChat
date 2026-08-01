import { projectMarkdownStream } from './markdown-stream.js';

function createMarkdownStreamNode(document, block) {
    const node = document.createElement(block.mode === 'code' ? 'pre' : 'div');
    node.className = `agent-presentation-markdown-block agent-presentation-markdown-${block.mode}`;
    node.dataset.agentMarkdownKey = block.key;
    return node;
}

// Stable blocks are keyed inside a single message row. This is intentionally
// narrower than the main renderer: it receives only one Agent Message's text.
function patchAgentStreamingMarkdown(content, text, markedInstance) {
    const previous = content.__agentMarkdownProjection;
    const projection = projectMarkdownStream(previous, text, true);
    let host = content.querySelector(':scope > .agent-presentation-markdown-stream');
    if (!host) {
        host = content.ownerDocument.createElement('div');
        host.className = 'agent-presentation-markdown-stream';
        content.replaceChildren(host);
    }
    const existing = new Map([...host.children].map((node) => [node.dataset.agentMarkdownKey, node]));
    const desired = new Set();
    for (const block of projection.blocks) {
        desired.add(block.key);
        let node = existing.get(block.key);
        if (!node) node = createMarkdownStreamNode(content.ownerDocument, block);
        const sourceKey = `${block.mode}:${block.src}:${block.complete ? 'complete' : 'live'}`;
        if (node.dataset.agentMarkdownSource !== sourceKey) {
            node.dataset.agentMarkdownSource = sourceKey;
            if (block.mode === 'live' || block.mode === 'code') node.textContent = block.src;
            else node.innerHTML = markedInstance.parse(String(block.src || ''));
        }
        host.append(node);
    }
    for (const [key, node] of existing) {
        if (!desired.has(key)) node.remove();
    }
    content.__agentMarkdownProjection = projection;
    return projection;
}

export { patchAgentStreamingMarkdown };
