import { normalizeAgentPresentationPart } from './contract.js';
import { bindAgentPresentationContextMenu } from './context-menu.js';
import {
    disposeAgentMessageRenderer,
    initializeAgentMessageRenderer,
    renderMessage,
} from './fork/agentMessageRenderer.js';
import { createAgentPresentationCallbacks } from './renderer.js';
import { createAgentBlockPresentation } from './blocks/registry.js';

function createMarkedParser(targetWindow, explicit) {
    if (explicit) return explicit;
    if (targetWindow?.marked && typeof targetWindow.marked.Marked === 'function') {
        return new targetWindow.marked.Marked({
            gfm: true,
            tables: true,
            breaks: true,
            pedantic: false,
            sanitize: false,
            smartLists: true,
            smartypants: false,
        });
    }
    if (targetWindow?.marked?.parse) return targetWindow.marked;
    return { parse: (text) => String(text || '') };
}

function messageFromPart(part, context) {
    const normalized = normalizeAgentPresentationPart(part);
    const source = normalized.source || {};
    const participant = context.participant || {};
    const text = normalized.blocks.find((block) => block.kind === 'text');
    const reasoning = normalized.blocks.find((block) => block.kind === 'reasoning');
    const attachments = normalized.blocks.filter((block) => block.kind === 'attachment');
    const content = text?.text ?? text?.content ?? source.content ?? '';
    const reasoningText = reasoning?.text ?? reasoning?.content ?? source.reasoning ?? '';
    const streaming = normalized.state === 'streaming' || normalized.state === 'running';
    const contentWithReasoning = content;
    return {
        ...source,
        id: normalized.id,
        messageId: normalized.id,
        role: normalized.role,
        content: contentWithReasoning,
        reasoning: reasoningText,
        attachments: attachments.length > 0 ? attachments : source.attachments || [],
        state: normalized.state,
        isStreaming: streaming,
        timestamp: normalized.createdAt || source.timestamp || Date.now(),
        agentId: participant.id || source.agentId || null,
        name: participant.name || source.name || (normalized.role === 'user' ? '你' : 'AI'),
        avatarUrl: participant.avatarUrl || source.avatarUrl || '',
        avatarColor: participant.colors?.avatar || participant.avatarColor || source.avatarColor || null,
    };
}

function syncRootAttributes(target, source) {
    for (const attribute of [...target.attributes]) {
        if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
    }
    for (const attribute of [...source.attributes]) target.setAttribute(attribute.name, attribute.value);
}

function syncDeliveryState(row, message) {
    if (message.role !== 'user') return;
    const labels = {
        sending: '发送中…',
        pending: '等待 Codex 确认…',
        unconfirmed: '尚未确认，请对账后重试',
        failed: message.deliveryDetail || '发送失败',
    };
    const label = labels[message.deliveryState];
    let status = row.querySelector('.agent-chat-message-delivery');
    if (!label) {
        status?.remove();
        row.removeAttribute('data-delivery-state');
        return;
    }
    if (!status) {
        status = row.ownerDocument.createElement('div');
        status.className = 'agent-chat-message-delivery';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        row.querySelector('.details-and-bubble-wrapper')?.append(status);
    }
    row.dataset.deliveryState = message.deliveryState;
    status.textContent = label;
}

function syncEphemeralTurnState(row, message) {
    const ephemeral = message.presentationRole === 'turn-start';
    row.classList.toggle('agent-chat-turn-starting', ephemeral);
    row.classList.toggle('thinking', ephemeral);
    if (!ephemeral) {
        row.removeAttribute('aria-live');
        return;
    }
    row.setAttribute('aria-live', 'polite');
    row.dataset.agentEphemeral = 'turn-starting';
    const content = row.querySelector('.md-content');
    if (!content) return;
    const label = message.presentationPhase === 'starting' ? '正在启动 Agent…' : '思考中';
    content.replaceChildren();
    const indicator = row.ownerDocument.createElement('span');
    indicator.className = 'thinking-indicator';
    indicator.append(row.ownerDocument.createTextNode(label));
    const dots = row.ownerDocument.createElement('span');
    dots.className = 'thinking-indicator-dots';
    dots.textContent = '...';
    indicator.append(dots);
    content.append(indicator);
}

function syncStreamingReasoning(row, message, markedInstance) {
    let wrapper = row.querySelector('.agent-chat-reasoning-block');
    if (!message.reasoning) {
        wrapper?.remove();
        return;
    }
    if (!wrapper) {
        wrapper = row.ownerDocument.createElement('div');
        wrapper.className = 'agent-chat-reasoning-block';
        row.querySelector('.details-and-bubble-wrapper')?.append(wrapper);
    }
    const now = globalThis.performance?.now?.() || Date.now();
    const startedAt = Number(row.dataset.agentReasoningStartedAt || now);
    row.dataset.agentReasoningStartedAt = String(startedAt);
    const seconds = Math.max(0.1, (now - startedAt) / 1000).toFixed(1);
    const expanded = message.isStreaming ? ' expanded' : '';
    const label = message.isStreaming ? '思考中' : '已深度思考';
    wrapper.innerHTML = `<div class="vcp-thought-chain-bubble collapsible${expanded}" data-vcp-block-type="thought-chain"><div class="vcp-thought-chain-header"><span class="vcp-thought-chain-icon">lightbulb</span><span class="vcp-thought-chain-label">${label} <span class="agent-chat-reasoning-time">${seconds}s</span></span><span class="vcp-result-toggle-icon"></span></div><div class="vcp-thought-chain-collapsible-content"><div class="vcp-thought-chain-body">${markedInstance.parse(String(message.reasoning))}</div></div></div>`;
    if (!message.isStreaming) {
        const copy = row.ownerDocument.createElement('button');
        copy.type = 'button';
        copy.className = 'agent-chat-reasoning-copy';
        copy.title = '复制推理过程';
        copy.setAttribute('aria-label', '复制推理过程');
        copy.textContent = '复制';
        copy.addEventListener('click', () => {
            globalThis.navigator?.clipboard?.writeText?.(String(message.reasoning));
        });
        wrapper.append(copy);
    }
}

function activateWhenConnected(targetWindow, row) {
    const activate = () => {
        if (!row.isConnected) return;
        const process = row._vcp_process || row._vcp_activateHeavy;
        if (typeof process === 'function') Promise.resolve(process.call(row)).catch(() => {});
        delete row._vcp_process;
    };
    (targetWindow?.requestAnimationFrame || ((callback) => setTimeout(callback, 0)))(activate);
}

function createAgentMessagePresentation(options = {}) {
    const targetWindow = options.window || globalThis.window;
    const document = options.document || targetWindow?.document || globalThis.document;
    const container = options.container;
    if (!document || !container) throw new TypeError('Agent presentation requires document and container');
    if (typeof options.getSessionContext !== 'function') throw new TypeError('getSessionContext is required');
    const actions = options.actions || {};
    const partByKey = new Map();
    const resolveContext = (subject) => {
        const value = options.getSessionContext(subject) || {};
        return {
            sessionId: value.sessionId || null,
            threadId: value.threadId || null,
            participant: value.participant || {},
            messages: Array.isArray(value.messages) ? value.messages : [],
            settings: { ...(options.settings || {}), ...(value.settings || {}) },
        };
    };
    const markedInstance = createMarkedParser(targetWindow, options.markedInstance);
    const fallback = options.nonMessageCallbacks || createAgentPresentationCallbacks({
        document,
        renderContent: (text) => markedInstance.parse(String(text || '')),
        renderReasoning: (text) => markedInstance.parse(String(text || '')),
    });

    initializeAgentMessageRenderer({
        chatMessagesDiv: container,
        getSessionContext: resolveContext,
        actions,
        markedInstance,
        electronAPI: options.electronAPI || {},
        uiHelper: {
            scrollToBottom: options.scrollToBottom || (() => {}),
            showToastNotification: options.notify || (() => {}),
        },
        globalSettingsRef: { get: () => resolveContext(null).settings },
    });

    const timelineCallbacks = {
        create(part) {
            partByKey.set(`${part.kind}:${part.id}`, part);
            if (part.kind !== 'message') return fallback.create(part);
            const message = messageFromPart(part, resolveContext(part));
            const row = renderMessage(message, true, false);
            syncEphemeralTurnState(row, message);
            syncDeliveryState(row, message);
            syncStreamingReasoning(row, message, markedInstance);
            row.dataset.agentPresentationKey = `${part.kind}:${part.id}`;
            activateWhenConnected(targetWindow, row);
            return row;
        },
        patch(row, part) {
            partByKey.set(`${part.kind}:${part.id}`, part);
            if (part.kind !== 'message') return fallback.patch?.(row, part) || row;
            const message = messageFromPart(part, resolveContext(part));
            if (message.isStreaming) {
                const content = row.querySelector('.md-content');
                if (content && content.dataset.agentSourceText !== message.content) {
                    content.dataset.agentSourceText = message.content;
                    content.textContent = message.content;
                }
                row.classList.add('streaming');
                row.dataset.state = 'streaming';
                syncDeliveryState(row, message);
                syncStreamingReasoning(row, message, markedInstance);
                syncEphemeralTurnState(row, message);
                return row;
            }
            const replacement = renderMessage(message, true, false);
            syncRootAttributes(row, replacement);
            row.replaceChildren(...replacement.childNodes);
            row.classList.remove('streaming', 'thinking');
            row.dataset.agentPresentationKey = `${part.kind}:${part.id}`;
            row.dataset.state = message.state || 'complete';
            row._vcp_process = replacement._vcp_process;
            row._vcp_activateHeavy = replacement._vcp_activateHeavy;
            syncDeliveryState(row, message);
            syncStreamingReasoning(row, message, markedInstance);
            syncEphemeralTurnState(row, message);
            activateWhenConnected(targetWindow, row);
            return row;
        },
    };

    let disposeMenu = null;
    return {
        timelineCallbacks,
        bindInteractions() {
            disposeMenu?.();
            disposeMenu = bindAgentPresentationContextMenu({
                container,
                document,
                getPart: (key) => partByKey.get(key),
                actions,
            });
            return disposeMenu;
        },
        dispose() {
            disposeMenu?.();
            disposeMenu = null;
            partByKey.clear();
            disposeAgentMessageRenderer();
        },
    };
}

export { createAgentBlockPresentation, createAgentMessagePresentation };
