function createNode(document, tag, className = '', text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

function createIcon(document, name, label) {
    const icon = createNode(document, 'span', 'vcp-ui-icon', name);
    icon.setAttribute('aria-hidden', 'true');
    if (!label) return [icon];
    return [icon, createNode(document, 'span', 'agent-chat-visually-hidden', label)];
}

function createButton(document, label, className = '') {
    const button = createNode(document, 'button', `agent-chat-button ${className}`.trim(), label);
    button.type = 'button';
    return button;
}

function safeText(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

export { createButton, createIcon, createNode, safeText };
