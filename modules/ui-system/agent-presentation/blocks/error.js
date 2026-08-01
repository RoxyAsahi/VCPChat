import { createNode, safeText } from './dom.js';

function createErrorCard(document, error = {}) {
    const card = createNode(document, 'section', 'agent-presentation-block agent-presentation-error agent-chat-error-card');
    card.setAttribute('role', 'alert');
    card.dataset.errorCode = safeText(error.code || error.kind || 'unknown').slice(0, 160);
    card.append(
        createNode(document, 'strong', 'agent-chat-error-title', error.title || 'Agent 展示错误'),
        createNode(document, 'p', 'agent-chat-error-message', safeText(error.message || error.summary || error).slice(0, 4_000)),
    );
    return card;
}

function createUnknownBlockCard(document, part = {}) {
    return createErrorCard(document, {
        code: 'unsupported-block',
        title: '暂不支持的 Agent Block',
        message: `${part.kind || 'unknown'}：该内容已安全保留，但当前版本无法结构化展示。`,
    });
}

export { createErrorCard, createUnknownBlockCard };
