import {
    createAgentActionDescriptors,
    normalizeAgentPresentationPart,
} from './contract.js';

const ACTION_ICONS = Object.freeze({
    copy: 'fa-copy',
    interrupt: 'fa-stop-circle',
    edit: 'fa-edit',
    retry: 'fa-rotate-right',
    fork: 'fa-code-branch',
    forward: 'fa-share',
});

function copyableText(row, part) {
    const content = row.querySelector('.md-content');
    if (!content) {
        const normalized = normalizeAgentPresentationPart(part);
        return normalized.blocks
            .filter((block) => block.kind === 'text')
            .map((block) => block.text || block.content || '')
            .join('\n\n')
            .trim();
    }
    const clone = content.cloneNode(true);
    clone.querySelectorAll(
        '.vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble, '
        + '.vcp-flowlock-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, '
        + '.message-attachments, style, script, button',
    ).forEach((element) => element.remove());
    return String(clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function createMenuItem(document, descriptor) {
    const item = document.createElement('div');
    item.className = `context-menu-item${descriptor.danger ? ' danger-item' : ''}`;
    item.dataset.agentAction = descriptor.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'menuitem');
    const icon = document.createElement('i');
    icon.className = `fas ${ACTION_ICONS[descriptor.id] || 'fa-circle'}`;
    const label = document.createElement('span');
    label.textContent = descriptor.label;
    item.append(icon, label);
    return item;
}

function bindAgentPresentationContextMenu(options = {}) {
    const container = options.container;
    const document = options.document || container?.ownerDocument || globalThis.document;
    if (!container || !document) throw new TypeError('container and document are required');
    const actions = options.actions || {};
    let menu = null;

    const close = () => {
        menu?.remove();
        menu = null;
    };
    const outside = (event) => {
        if (menu && !menu.contains(event.target)) close();
    };
    const invoke = async (descriptor, row, part) => {
        close();
        if (descriptor.id === 'copy') {
            const text = copyableText(row, part);
            await (actions.copy
                ? actions.copy({ text, row, part })
                : globalThis.navigator?.clipboard?.writeText?.(text));
            return;
        }
        const handler = actions[descriptor.id];
        if (typeof handler === 'function') await handler({ row, part });
    };
    const open = (event) => {
        const row = event.target.closest('.message-item[data-agent-timeline-key], .message-item[data-agent-presentation-key]');
        if (!row || !container.contains(row)) return;
        const key = row.dataset.agentTimelineKey || row.dataset.agentPresentationKey;
        const part = options.getPart?.(key, row);
        if (!part || part.kind !== 'message') return;
        const descriptors = createAgentActionDescriptors(part, {
            copy: true,
            interrupt: typeof actions.interrupt === 'function',
            edit: typeof actions.edit === 'function',
            retry: typeof actions.retry === 'function',
            fork: typeof actions.fork === 'function',
            forward: typeof actions.forward === 'function',
        });
        if (descriptors.length === 0) return;
        event.preventDefault();
        close();
        document.getElementById('chatContextMenu')?.remove();
        menu = document.createElement('div');
        menu.id = 'chatContextMenu';
        menu.className = 'context-menu';
        menu.dataset.owner = 'agent-presentation';
        menu.setAttribute('role', 'menu');
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;
        for (const descriptor of descriptors) {
            const item = createMenuItem(document, descriptor);
            item.addEventListener('click', () => invoke(descriptor, row, part));
            item.addEventListener('keydown', (keyEvent) => {
                if (keyEvent.key === 'Enter' || keyEvent.key === ' ') invoke(descriptor, row, part);
            });
            menu.append(item);
        }
        document.body.append(menu);
    };

    container.addEventListener('contextmenu', open);
    document.addEventListener('pointerdown', outside, true);
    return () => {
        close();
        container.removeEventListener('contextmenu', open);
        document.removeEventListener('pointerdown', outside, true);
    };
}

export { bindAgentPresentationContextMenu, copyableText };
