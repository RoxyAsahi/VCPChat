function node(tag, className, text, documentRef = globalThis.document) {
    const value = documentRef.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
}

function icon(name, label, documentRef = globalThis.document) {
    const value = node('span', 'vcp-ui-icon', name, documentRef);
    value.setAttribute('aria-hidden', 'true');
    if (!label) return [value];
    return [value, node('span', 'agent-chat-visually-hidden', label, documentRef)];
}

function iconButton(iconName, label, className = '', documentRef = globalThis.document) {
    const value = node('button', `agent-chat-icon-button ${className}`.trim(), undefined, documentRef);
    value.type = 'button';
    value.title = label;
    value.setAttribute('aria-label', label);
    value.append(...icon(iconName, label, documentRef));
    return value;
}

function button(label, className = '', documentRef = globalThis.document) {
    const value = node('button', `agent-chat-button ${className}`.trim(), label, documentRef);
    value.type = 'button';
    return value;
}

function vectorIcon(name, label, documentRef = globalThis.document) {
    const paths = {
        add: [['path', { d: 'M12 5v14' }], ['path', { d: 'M5 12h14' }]],
        search: [['circle', { cx: '11', cy: '11', r: '7' }], ['path', { d: 'm20 20-3.5-3.5' }]],
        checklist: [
            ['path', { d: 'm3 6 2 2 4-4' }], ['path', { d: 'M11 6h10' }],
            ['path', { d: 'm3 12 2 2 4-4' }], ['path', { d: 'M11 12h10' }],
            ['path', { d: 'm3 18 2 2 4-4' }], ['path', { d: 'M11 18h10' }],
        ],
        more: [['circle', { cx: '5', cy: '12', r: '1' }], ['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '19', cy: '12', r: '1' }]],
        open: [['path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }], ['path', { d: 'M3 10h18' }]],
        edit: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z' }]],
        copy: [['rect', { x: '9', y: '9', width: '11', height: '11', rx: '1' }], ['path', { d: 'M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4' }]],
        view: [['path', { d: 'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6' }], ['circle', { cx: '12', cy: '12', r: '2.5' }]],
        delete: [['path', { d: 'M4 7h16' }], ['path', { d: 'M9 7V4h6v3' }], ['path', { d: 'm6 7 1 13h10l1-13' }], ['path', { d: 'M10 11v5' }], ['path', { d: 'M14 11v5' }]],
        close: [['path', { d: 'm7 7 10 10' }], ['path', { d: 'm17 7-10 10' }]],
    };
    const shape = paths[name];
    if (!shape) return icon(name, label, documentRef);
    const value = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
    value.setAttribute('viewBox', '0 0 24 24');
    value.setAttribute('fill', 'none');
    value.setAttribute('stroke', 'currentColor');
    value.setAttribute('stroke-width', '2');
    value.setAttribute('stroke-linecap', 'round');
    value.setAttribute('stroke-linejoin', 'round');
    value.setAttribute('aria-hidden', 'true');
    for (const [tag, attributes] of shape) {
        const child = documentRef.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attributes).forEach(([attribute, attributeValue]) => child.setAttribute(attribute, attributeValue));
        value.append(child);
    }
    return [value, ...(label ? [node('span', 'agent-chat-visually-hidden', label, documentRef)] : [])];
}

function visualActionButton(iconName, label, className = '', text = '', documentRef = globalThis.document) {
    const value = node('button', className, undefined, documentRef);
    value.type = 'button';
    value.title = label;
    value.setAttribute('aria-label', label);
    value.append(...vectorIcon(iconName, label, documentRef));
    if (text) value.append(node('span', '', text, documentRef));
    return value;
}

function createSidebarSearchPanel(inputId, inputLabel, placeholder, closeClass, closeLabel, documentRef = globalThis.document) {
    const panel = node('div', 'sidebar-subtab-item sidebar-search-subtab', undefined, documentRef);
    const searchContainer = node('div', 'topic-search-container', undefined, documentRef);
    searchContainer.append(...icon('search', undefined, documentRef));
    const input = documentRef.createElement('input');
    input.type = 'search';
    input.id = inputId;
    input.className = 'topic-search-input';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', inputLabel);
    const close = visualActionButton('close', closeLabel, closeClass, '', documentRef);
    searchContainer.append(input, close);
    panel.append(searchContainer);
    return { panel, input, close };
}

function cssEscape(value, windowRef = globalThis.window) {
    if (windowRef?.CSS && typeof windowRef.CSS.escape === 'function') return windowRef.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
}

export {
    button,
    createSidebarSearchPanel,
    cssEscape,
    icon,
    iconButton,
    node,
    vectorIcon,
    visualActionButton,
};
