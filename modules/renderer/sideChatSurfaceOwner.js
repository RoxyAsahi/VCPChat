/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

import { createChatSurface } from '../chat/chatSurface.js';
import { createChatOperations } from '../chat/chatOperation.js';

/**
 * Mounts a full interactive side-chat surface into container.
 * @param {HTMLElement} container
 * @param {Object} options
 * @param {Object} options.descriptor - SideChatDescriptor
 * @param {Object} options.chatCapabilities - Shared chat capabilities
 * @param {Object} [options.scope] - LifecycleScope
 * @param {Function} [options.onStatusChange]
 * @returns {Promise<Object>} TabHandle
 */
export async function mountSideChatSurface(container, {
    descriptor,
    chatCapabilities,
    scope = null,
    onStatusChange = null
} = {}) {
    if (!container || !container.ownerDocument) {
        throw new TypeError('mountSideChatSurface requires a valid container element');
    }
    if (!descriptor) {
        throw new TypeError('mountSideChatSurface requires a descriptor');
    }

    const doc = container.ownerDocument;
    const repository = chatCapabilities?.repository;
    const createRenderer = chatCapabilities?.createRenderer;
    const chatManager = chatCapabilities?.manager;
    const childScope = scope?.child?.(`side-chat-${descriptor.id}`) || null;

    const hasSnapshot = Array.isArray(descriptor.parentSnapshot) && descriptor.parentSnapshot.length > 0;

    // Shell template
    container.innerHTML = `
      <div class="side-chat-surface" aria-label="侧边聊天">
        <div class="side-chat-header">
          <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;">
            <span class="side-chat-topic-title" title="${escapeHtml(descriptor.title)}">${escapeHtml(descriptor.title)}</span>
            <div class="side-chat-parent-bar">
              <span>来源:</span>
              <button type="button" class="side-chat-parent-link" title="定位父话题">${escapeHtml(descriptor.parent?.name || descriptor.parent?.topicId || '父会话')}</button>
              ${hasSnapshot ? `<button type="button" class="side-chat-context-toggle-btn" title="查看模型继承的上下文历史"><span class="vcp-ui-icon" style="font-size:12px;">history</span> 上下文(${descriptor.parentSnapshot.length})</button>` : ''}
            </div>
          </div>
          <div class="side-chat-status-bar" role="status" aria-live="polite">
            <span class="side-chat-persistence-badge side-chat-status-unsaved" style="display:none;">未保存</span>
            <span class="side-chat-status-text">加载中...</span>
          </div>
        </div>
        ${hasSnapshot ? `
        <div class="side-chat-snapshot-drawer" aria-label="继承上下文列表">
          ${descriptor.parentSnapshot.map(m => `
            <div class="side-chat-snapshot-item">
              <span class="side-chat-snapshot-role">${escapeHtml(m.role === 'user' ? '用户' : '助手')}:</span>
              <span class="side-chat-snapshot-text">${escapeHtml(typeof m.content === 'string' ? (m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content) : '[复杂内容]')}</span>
            </div>
          `).join('')}
        </div>` : ''}
        <div class="side-chat-messages-container" tabindex="-1" aria-label="侧聊消息"></div>
        <form class="side-chat-composer">
          <div class="side-chat-reference-list" style="display:none;" aria-label="选区引用"></div>
          <div class="side-chat-textarea-shell">
            <textarea class="side-chat-textarea" placeholder="输入消息... (Enter 发送, Shift+Enter 换行)" rows="1" aria-label="侧聊输入框" disabled></textarea>
            <button type="submit" class="side-chat-send-btn" title="发送 (Enter)" aria-label="发送" disabled>
              <span class="vcp-ui-icon" style="font-size:16px;">arrow_upward</span>
            </button>
            <button type="button" class="side-chat-stop-btn" style="display:none;" title="停止生成" aria-label="停止生成">
              <span class="vcp-ui-icon" style="font-size:16px;">stop</span>
            </button>
          </div>
        </form>
      </div>
    `;

    const root = container.querySelector('.side-chat-messages-container');
    const form = container.querySelector('.side-chat-composer');
    const textarea = form.querySelector('.side-chat-textarea');
    const sendBtn = form.querySelector('.side-chat-send-btn');
    const stopBtn = form.querySelector('.side-chat-stop-btn');
    const statusText = container.querySelector('.side-chat-status-text');
    const persistenceBadge = container.querySelector('.side-chat-persistence-badge');
    const referenceList = container.querySelector('.side-chat-reference-list');
    const contextToggleBtn = container.querySelector('.side-chat-context-toggle-btn');
    const snapshotDrawer = container.querySelector('.side-chat-snapshot-drawer');
    const parentLink = container.querySelector('.side-chat-parent-link');

    if (contextToggleBtn && snapshotDrawer) {
        contextToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            snapshotDrawer.classList.toggle('open');
        });
    }

    if (parentLink) {
        parentLink.addEventListener('click', (e) => {
            e.stopPropagation();
            const mainInput = doc.querySelector('#messageInput') || doc.querySelector('#chatInput') || doc.querySelector('textarea#messageInput');
            mainInput?.focus?.();
            chatCapabilities?.uiHelper?.showToastNotification?.(`当前侧聊关联父话题: ${descriptor.parent?.name || descriptor.parent?.topicId}`, 'info');
        });
    }

    let isDisposed = false;
    let isHistoryLoaded = false;
    let isComposing = false;
    let activeOperation = null;
    let operationReady = Promise.resolve(null);
    let publishOperation = null;
    let submitInteractiveContent = null;
    const references = []; // { id, text, sourceMessageId }

    function extractTextFromContentDiv(contentDiv) {
        if (!contentDiv) return '';
        const clone = contentDiv.cloneNode(true);
        clone.querySelectorAll?.(
            '.vcp-tool-use-bubble, .vcp-tool-result-bubble, .vcp-tool-call-summary-bubble, .vcp-flowlock-bubble, .vcp-role-divider, .vcp-thought-chain-bubble, .message-attachments, .message-attachment-remove-btn, .side-chat-message-actions, style, script'
        )?.forEach?.(el => el.remove());
        return (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    function attachMessageActions(messageItem) {
        if (!messageItem || messageItem.hasAttribute?.('data-has-side-action')) return;
        if (messageItem.classList?.contains('user')) return;
        messageItem.setAttribute('data-has-side-action', 'true');

        const actionsDiv = doc.createElement('div');
        actionsDiv.className = 'side-chat-message-actions';

        const sendToMainBtn = doc.createElement('button');
        sendToMainBtn.type = 'button';
        sendToMainBtn.className = 'side-chat-send-to-main-btn';
        sendToMainBtn.title = '将此回答填入主聊天输入框';
        sendToMainBtn.innerHTML = '<span class="vcp-ui-icon" style="font-size:12px;">reply</span> 填入主聊';

        sendToMainBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const contentDiv = messageItem.querySelector('.md-content');
            const cleanText = extractTextFromContentDiv(contentDiv);
            if (!cleanText) {
                chatCapabilities?.uiHelper?.showToastNotification?.('无可填入的文本内容', 'warning');
                return;
            }

            const mainInput = doc.querySelector('#messageInput') || doc.querySelector('#chatInput') || doc.querySelector('textarea#messageInput');
            if (mainInput) {
                const currentVal = mainInput.value ? mainInput.value.trim() : '';
                mainInput.value = currentVal ? `${currentVal}\n\n${cleanText}` : cleanText;
                chatCapabilities?.uiHelper?.autoResizeTextarea?.(mainInput);
                const EventClass = doc.defaultView?.Event || globalThis.Event;
                mainInput.dispatchEvent(new EventClass('input', { bubbles: true }));
                mainInput.focus();
                chatCapabilities?.uiHelper?.showToastNotification?.('已填入主聊天输入框', 'success');
            } else {
                chatCapabilities?.uiHelper?.showToastNotification?.('未找到主聊天输入框', 'error');
            }
        });

        actionsDiv.appendChild(sendToMainBtn);
        messageItem.appendChild(actionsDiv);
    }

    const MutationObserverClass = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
    let messageObserver = null;
    function syncMessageActions() {
        if (isDisposed || !root) return;
        const items = root.querySelectorAll('.message-item:not([data-has-side-action])');
        items.forEach(item => {
            if (!item.classList?.contains('streaming')) {
                attachMessageActions(item);
            }
        });
    }

    if (MutationObserverClass && root) {
        messageObserver = new MutationObserverClass(() => {
            syncMessageActions();
        });
        messageObserver.observe(root, { childList: true, subtree: true });
    }

    function updateStatus(text, type = 'normal') {
        if (isDisposed) return;
        statusText.textContent = text;
        statusText.className = 'side-chat-status-text' + (type === 'error' ? ' side-chat-status-error' : '');
        onStatusChange?.({ text, type });
    }

    function renderReferences() {
        if (references.length === 0) {
            referenceList.style.display = 'none';
            referenceList.innerHTML = '';
            return;
        }

        referenceList.style.display = 'flex';
        referenceList.style.flexDirection = 'column';
        referenceList.style.gap = '4px';
        referenceList.innerHTML = '';

        references.forEach((ref, idx) => {
            const card = doc.createElement('div');
            card.className = 'side-chat-reference-box';

            const preview = doc.createElement('span');
            preview.className = 'side-chat-ref-text';
            const shortText = ref.text.length > 80 ? ref.text.slice(0, 80) + '...' : ref.text;
            preview.textContent = `[引用 ${idx + 1}]: "${shortText}"`;

            const removeBtn = doc.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'side-pane-tab-close';
            removeBtn.title = '移除引用';
            removeBtn.innerHTML = '<span class="vcp-ui-icon" style="font-size:12px;">close</span>';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handle.removeReference(ref.id);
            });

            card.append(preview, removeBtn);
            referenceList.appendChild(card);
        });
    }

    if (!repository || typeof createRenderer !== 'function' || !chatManager) {
        updateStatus('聊天能力尚未就绪', 'error');
        return {
            descriptor,
            setVisible() {},
            focus() {},
            async requestClose() { return { closed: true }; },
            async dispose() {
                childScope?.dispose?.('side-chat-unavailable');
                container.replaceChildren();
            },
            addReference() {},
            removeReference() {},
        };
    }

    // Mount owned isolated internal renderer
    const rendererOwner = createRenderer({
        root,
        mode: 'interactive',
        conversation: {
            selectedItem: {
                id: descriptor.child.itemId,
                type: 'agent',
                name: descriptor.parent.name,
                avatarUrl: descriptor.parent.avatar
            },
            topicId: descriptor.child.topicId,
        },
        handleSendMessage: (text) => submitInteractiveContent?.(text),
    });

    const renderer = rendererOwner.renderer;

    // Supply frozen parent snapshot context if present (P1 context inheritance)
    const frozenContext = Array.isArray(descriptor.parentSnapshot)
        ? [...descriptor.parentSnapshot]
        : [];

    const enhancedConversation = Object.freeze({
        ...rendererOwner.conversation,
        getContextHistory: () => frozenContext
    });

    const operations = createChatOperations({
        send: async (request) => {
            operationReady = new Promise((resolve) => { publishOperation = resolve; });
            try {
                return await chatManager.sendMessage({
                    ...request,
                    conversation: enhancedConversation,
                    awaitTerminal: true,
                    onOperation(operation) {
                        activeOperation = operation;
                        publishOperation?.(operation);
                        publishOperation = null;
                    },
                });
            } finally {
                publishOperation?.(null);
                publishOperation = null;
                activeOperation = null;
            }
        },
        cancel: async () => {
            const operation = activeOperation || await operationReady;
            return operation?.cancel?.('side-chat-user-cancel') || false;
        }
    });

    const surface = createChatSurface({
        root,
        renderer,
        repository,
        focusTarget: textarea,
        mode: 'interactive',
        operations,
        disposeRenderer: () => rendererOwner.dispose(),
        conversation: enhancedConversation
    });

    // Composer event handling
    textarea.addEventListener('compositionstart', () => { isComposing = true; });
    textarea.addEventListener('compositionend', () => { isComposing = false; });

    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    });

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !isComposing && e.keyCode !== 229) {
            e.preventDefault();
            form.requestSubmit();
        }
    });

    const onSubmit = async (event) => {
        event?.preventDefault?.();
        if (isDisposed || !isHistoryLoaded) return;

        const rawText = textarea.value.trim();
        if (!rawText && references.length === 0) return;

        // Compose payload with references if present
        let payload = rawText;
        if (references.length > 0) {
            const refContent = references
                .map((r, i) => `> [引用 ${i + 1}]:\n> ${r.text.replace(/\n/g, '\n> ')}`)
                .join('\n\n');
            payload = rawText ? `${refContent}\n\n${rawText}` : refContent;
        }

        form.setAttribute('aria-busy', 'true');
        textarea.disabled = true;
        sendBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        updateStatus('生成中...');

        try {
            const result = await surface.sendMessage({
                content: payload,
                attachments: [],
                input: textarea,
                domRenderer: surface.renderer,
                propagateError: true
            });

            textarea.value = '';
            textarea.style.height = 'auto';
            references.length = 0;
            renderReferences();

            const terminalType = result?.terminal?.event?.type;
            if (terminalType === 'cancelled' || terminalType === 'discarded') {
                if (!textarea.value && rawText) textarea.value = rawText;
                updateStatus('已取消');
            } else if (terminalType === 'failed') {
                const transportErr = result.terminal.event.outcome?.transport?.error;
                const persistenceErr = result.terminal.event.outcome?.persistence?.error;
                const err = transportErr || persistenceErr || '连接中断';
                if (!persistenceErr && !textarea.value && rawText) {
                    textarea.value = rawText;
                }
                if (persistenceErr) {
                    persistenceBadge.style.display = 'inline-block';
                    updateStatus('已生成但保存失败', 'error');
                } else {
                    updateStatus(`发送失败：${err?.message || err}`, 'error');
                }
            } else {
                persistenceBadge.style.display = 'none';
                updateStatus('就绪');
            }
        } catch (error) {
            if (!textarea.value && rawText) textarea.value = rawText;
            updateStatus(`发送失败：${error.message}`, 'error');
        } finally {
            if (!isDisposed) {
                form.removeAttribute('aria-busy');
                textarea.disabled = false;
                sendBtn.style.display = 'inline-flex';
                stopBtn.style.display = 'none';
                textarea.focus();
            }
        }
    };

    submitInteractiveContent = (text) => {
        if (isDisposed) return;
        textarea.value = String(text || '');
        form.requestSubmit();
    };

    const onStop = async () => {
        const cancelled = await surface.cancelMessage();
        if (cancelled) updateStatus('已取消');
    };

    form.addEventListener('submit', onSubmit);
    stopBtn.addEventListener('click', onStop);

    // Initial History Load
    const loadPromise = surface.loadHistory(
        descriptor.child.itemId,
        'agent',
        descriptor.child.topicId,
        { initialBatch: 5, batchSize: 10, batchDelay: 80 }
    ).then((res) => {
        if (isDisposed) return;
        isHistoryLoaded = true;
        textarea.disabled = false;
        sendBtn.disabled = false;
        updateStatus('就绪');
        return res;
    }).catch((err) => {
        if (isDisposed) return;
        updateStatus(`加载历史失败：${err.message}`, 'error');
    });

    const handle = Object.freeze({
        descriptor,
        surface,
        setVisible(visible) {
            if (visible && !isDisposed && isHistoryLoaded) {
                textarea.focus();
            }
        },
        focus() {
            if (!isDisposed && isHistoryLoaded) {
                textarea.focus();
            }
        },
        addReference(ref) {
            if (!ref || !ref.text || isDisposed) return;
            // Prevent duplicate text references
            if (references.some(r => r.text === ref.text)) return;
            references.push(ref);
            renderReferences();
        },
        removeReference(refId) {
            const index = references.findIndex(r => r.id === refId);
            if (index !== -1) {
                references.splice(index, 1);
                renderReferences();
            }
        },
        getReferences() {
            return [...references];
        },
        async requestClose() {
            // Cancel active operation and wait for settlement
            if (activeOperation) {
                await surface.cancelMessage();
            }
            return { closed: true };
        },
        async dispose() {
            if (isDisposed) return;
            isDisposed = true;
            messageObserver?.disconnect?.();
            submitInteractiveContent = null;
            form.removeEventListener('submit', onSubmit);
            stopBtn.removeEventListener('click', onStop);
            await surface.dispose();
            childScope?.dispose?.('side-chat-unmounted');
            container.replaceChildren();
        }
    });

    return handle;
}

/**
 * Creates a SideChatSurfaceOwner provider for SidePaneController.
 * @param {Object} options
 * @param {Object} options.chatCapabilities
 * @param {Object} [options.scope]
 * @returns {Object} { mountTab(descriptor, container) }
 */
export function createSideChatSurfaceOwner({
    chatCapabilities,
    scope = null
}) {
    return Object.freeze({
        async mountTab(descriptor, container) {
            return await mountSideChatSurface(container, {
                descriptor,
                chatCapabilities,
                scope
            });
        }
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

const api = Object.freeze({
    mountSideChatSurface,
    createSideChatSurfaceOwner
});

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSideChatSurfaceOwner = api;
}

export default api;
