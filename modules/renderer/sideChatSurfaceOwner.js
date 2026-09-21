/* sideChatSurfaceOwner.js
 * Surface owner for Workspace Side Chat, supporting independent conversation,
 * concurrent streaming, cancellation, selection references, and lifecycle disposal.
 */
'use strict';

import { createChatSurface } from '../chat/chatSurface.js';
import { createChatOperations } from '../chat/chatOperation.js';
import { validateReferenceList } from '../ui-system/side-pane/selection-reference.js';

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

    // Resolve agent config from descriptor or capability or fallback
    const agentConfig = descriptor.child?.config
        || descriptor.parent?.config
        || (typeof chatCapabilities?.resolveAgentConfig === 'function'
            ? await chatCapabilities.resolveAgentConfig(descriptor.child?.itemId)
            : null)
        || {
            model: descriptor.model || descriptor.parent?.model || 'gpt-4o',
            systemPrompt: descriptor.systemPrompt || descriptor.parent?.systemPrompt || '你是辅助聊天助手。',
            streamOutput: true
        };

    const selectedItem = {
        id: descriptor.child.itemId,
        type: 'agent',
        name: descriptor.parent.name,
        avatarUrl: descriptor.parent.avatar,
        config: agentConfig,
        model: agentConfig?.model,
        systemPrompt: agentConfig?.systemPrompt,
        streamOutput: agentConfig?.streamOutput
    };

    const modelName = agentConfig?.model || descriptor.model || 'gpt-4o';
    const isSnapshot = descriptor.contextMode === 'parent-snapshot' || (Array.isArray(descriptor.parentSnapshot) && descriptor.parentSnapshot.length > 0);
    const contextModeLabel = isSnapshot ? '父快照' : '仅引用';
    const contextModeTitle = isSnapshot ? '已继承来源话题的历史快照' : '不继承父历史，仅附带选区引用';

    const hasSnapshot = Array.isArray(descriptor.parentSnapshot) && descriptor.parentSnapshot.length > 0;

    // Shell template (aligned with ZCode: single unified tab header, clean message area, rich composer toolbar)
    container.innerHTML = `
      <div class="side-chat-surface" aria-label="侧边聊天">
        <span class="side-chat-topic-title sr-only" title="${escapeHtml(descriptor.title)}">${escapeHtml(descriptor.title)}</span>
        ${hasSnapshot ? `
        <div class="side-chat-snapshot-drawer" aria-label="继承上下文列表">
          <div class="side-chat-snapshot-drawer-header">
            <span>继承父会话上下文历史 (${descriptor.parentSnapshot.length})</span>
          </div>
          ${descriptor.parentSnapshot.map(m => `
            <div class="side-chat-snapshot-item">
              <span class="side-chat-snapshot-role">${escapeHtml(m.role === 'user' ? '用户' : '助手')}:</span>
              <span class="side-chat-snapshot-text">${escapeHtml(typeof m.content === 'string' ? (m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content) : '[复杂内容]')}</span>
            </div>
          `).join('')}
        </div>` : ''}
        <div class="side-chat-messages-container" tabindex="-1" aria-label="侧聊消息">
          <div class="side-chat-empty-state" aria-hidden="true">
            <div class="side-chat-empty-title">侧边辅助聊天</div>
            <div class="side-chat-empty-desc">
              ${isSnapshot
                ? '已继承来源话题的历史快照。在下方输入提问，或在主聊中划选文字追问。'
                : '当前为仅引用模式。选区引用会作为上下文随问题一同发送。'}
            </div>
          </div>
        </div>
        <form class="side-chat-composer">
          <div class="chat-input-card side-chat-input-card">
            <div class="side-chat-reference-list" style="display:none;" aria-label="选区引用"></div>
            <textarea class="chat-message-input side-chat-textarea" placeholder="提出修改要求或疑问... (Enter 发送, Shift+Enter 换行)" rows="1" aria-label="侧聊输入框" disabled></textarea>
            <div class="chat-input-actions side-chat-input-actions">
              <div class="side-chat-toolbar-left">
                <div class="side-chat-model-picker-wrapper" style="position:relative; display:inline-flex;">
                  <button type="button" class="side-chat-toolbar-badge side-chat-model-badge side-chat-model-picker-btn" title="点击切换模型 (当前: ${escapeHtml(modelName)})" aria-haspopup="listbox">
                    <span class="vcp-ui-icon" style="font-size:12px;">smart_toy</span>
                    <span class="side-chat-model-name">${escapeHtml(modelName)}</span>
                    <span class="vcp-ui-icon" style="font-size:11px; margin-left:1px; opacity:0.7;">arrow_drop_down</span>
                  </button>
                  <div class="side-chat-model-popover" style="display:none;" role="listbox">
                    <div class="side-chat-model-item${modelName === 'gpt-4o' ? ' active' : ''}" data-model="gpt-4o">gpt-4o</div>
                    <div class="side-chat-model-item${modelName === 'gpt-4o-mini' ? ' active' : ''}" data-model="gpt-4o-mini">gpt-4o-mini</div>
                    <div class="side-chat-model-item${modelName === 'claude-3-5-sonnet' ? ' active' : ''}" data-model="claude-3-5-sonnet">claude-3-5-sonnet</div>
                    <div class="side-chat-model-item${modelName === 'gemini-1.5-pro' ? ' active' : ''}" data-model="gemini-1.5-pro">gemini-1.5-pro</div>
                    <div class="side-chat-model-item${modelName === 'deepseek-chat' ? ' active' : ''}" data-model="deepseek-chat">deepseek-chat</div>
                  </div>
                </div>
                <button type="button" class="side-chat-toolbar-btn side-chat-attach-btn" title="手动添加文本或代码引用">
                  <span class="vcp-ui-icon" style="font-size:12px;">attach_file</span>
                  <span>引用</span>
                </button>
                <span class="side-chat-toolbar-badge side-chat-mode-badge" title="${contextModeTitle}">
                  ${contextModeLabel}
                </span>
                <span class="side-chat-toolbar-badge side-chat-parent-wrapper" title="定位父话题">
                  <span class="side-chat-meta-label">来源:</span>
                  <button type="button" class="side-chat-parent-link" title="定位父话题">${escapeHtml(descriptor.parent?.name || descriptor.parent?.topicTitle || descriptor.parent?.topicId || '父会话')}</button>
                </span>
                ${hasSnapshot ? `<button type="button" class="side-chat-toolbar-btn side-chat-context-toggle-btn" title="查看模型继承的上下文历史"><span class="vcp-ui-icon" style="font-size:11px;">history</span> 上下文(${descriptor.parentSnapshot.length})</button>` : ''}
              </div>
              <div class="side-chat-toolbar-right">
                <div class="side-chat-status-bar" role="status" aria-live="polite">
                  <span class="side-chat-persistence-badge side-chat-status-unsaved" style="display:none;">未保存</span>
                  <span class="side-chat-status-text">就绪</span>
                </div>
                <button type="submit" class="chat-send-button side-chat-send-btn" title="发送 (Enter)" aria-label="发送" disabled>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m5 12 7-7 7 7"></path>
                    <path d="M12 19V5"></path>
                  </svg>
                </button>
                <button type="button" class="chat-send-button side-chat-stop-btn interrupt-mode" style="display:none;" title="停止生成" aria-label="停止生成">
                  <span class="vcp-ui-icon" style="font-size:16px;">stop</span>
                </button>
              </div>
            </div>
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
    const modelPickerBtn = container.querySelector('.side-chat-model-picker-btn');
    const modelPopover = container.querySelector('.side-chat-model-popover');
    const modelNameSpan = container.querySelector('.side-chat-model-name');
    const attachBtn = container.querySelector('.side-chat-attach-btn');

    if (modelPickerBtn && modelPopover) {
        modelPickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = modelPopover.style.display !== 'none';
            modelPopover.style.display = isOpen ? 'none' : 'flex';
        });

        modelPopover.addEventListener('click', (e) => {
            const item = e.target.closest('.side-chat-model-item');
            if (!item) return;
            const newModel = item.getAttribute('data-model');
            if (newModel) {
                selectedItem.model = newModel;
                if (selectedItem.config) selectedItem.config.model = newModel;
                descriptor.model = newModel;
                if (modelNameSpan) modelNameSpan.textContent = newModel;
                modelPickerBtn.title = `点击切换模型 (当前: ${newModel})`;
                modelPopover.querySelectorAll('.side-chat-model-item').forEach(el => {
                    el.classList.toggle('active', el.getAttribute('data-model') === newModel);
                });
                chatCapabilities?.uiHelper?.showToastNotification?.(`已切换模型至: ${newModel}`, 'success');
            }
            modelPopover.style.display = 'none';
        });

        doc.addEventListener('click', (e) => {
            if (!modelPickerBtn.contains?.(e.target) && !modelPopover.contains?.(e.target)) {
                modelPopover.style.display = 'none';
            }
        });
    }

    if (attachBtn) {
        attachBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const snippet = doc.defaultView?.prompt?.('请输入要引用的文本片段或上下文：');
            if (snippet && snippet.trim()) {
                handle.addReference({
                    id: `ref-manual-${Date.now()}`,
                    text: snippet.trim(),
                    sourceMessageId: null,
                    capturedAt: Date.now()
                });
            }
        });
    }

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
    let hasUnsavedChanges = false;
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
                const inputTopic = mainInput.getAttribute('data-current-topic')
                    || (typeof chatCapabilities?.getCurrentTopic === 'function' ? chatCapabilities.getCurrentTopic() : null);
                const parentTopic = descriptor.parent?.topicId;
                if (inputTopic && parentTopic && inputTopic !== parentTopic) {
                    chatCapabilities?.uiHelper?.showToastNotification?.(`主聊天当前不在来源话题（${parentTopic}），已阻止填入`, 'warning');
                    return;
                }
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
        updateEmptyState();
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

    function updateEmptyState() {
        if (!root) return;
        const emptyState = root.querySelector('.side-chat-empty-state');
        if (!emptyState) return;
        const messageItems = root.querySelectorAll('.message-item');
        emptyState.style.display = messageItems.length > 0 ? 'none' : 'flex';
    }

    function updateComposerState() {
        if (isDisposed) return;
        const hasText = Boolean(textarea.value.trim());
        const hasRefs = references.length > 0;
        sendBtn.disabled = !isHistoryLoaded || (!hasText && !hasRefs);
        if (!hasText && hasRefs && descriptor.contextMode !== 'parent-snapshot') {
            textarea.placeholder = '输入针对引用的问题... (直接回车可发送引用)';
        } else {
            textarea.placeholder = '输入消息... (Enter 发送, Shift+Enter 换行)';
        }
    }

    // Mount owned isolated internal renderer
    const rendererOwner = createRenderer({
        root,
        mode: 'interactive',
        conversation: {
            selectedItem,
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
            const operation = activeOperation;
            if (operation && typeof operation.cancel === 'function') {
                return await operation.cancel('side-chat-user-cancel');
            }
            return false;
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
        updateComposerState();
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

        const submittedText = rawText;
        const submittedReferenceIds = new Set(references.map(r => r.id));
        const submittedReferences = [...references];

        // Compose payload with references if present
        let payload = rawText;
        if (references.length > 0) {
            const refContent = references
                .map((r, i) => `> [引用 ${i + 1}]:\n> ${r.text.replace(/\n/g, '\n> ')}`)
                .join('\n\n');
            payload = rawText ? `${refContent}\n\n${rawText}` : refContent;
        }

        // Clear composer draft and remove submitted references from composer view
        textarea.value = '';
        textarea.style.height = 'auto';
        for (let i = references.length - 1; i >= 0; i--) {
            if (submittedReferenceIds.has(references[i].id)) {
                references.splice(i, 1);
            }
        }
        renderReferences();

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

            const terminalType = result?.terminal?.event?.type;
            if (terminalType === 'cancelled' || terminalType === 'discarded') {
                if (!textarea.value && submittedText) textarea.value = submittedText;
                for (const ref of submittedReferences) {
                    if (!references.some(r => r.id === ref.id)) {
                        references.unshift(ref);
                    }
                }
                renderReferences();
                updateStatus('已取消');
            } else if (terminalType === 'failed') {
                const transportErr = result.terminal.event.outcome?.transport?.error;
                const persistenceErr = result.terminal.event.outcome?.persistence?.error;
                const err = transportErr || persistenceErr || '连接中断';
                if (!persistenceErr) {
                    if (!textarea.value && submittedText) {
                        textarea.value = submittedText;
                    }
                    for (const ref of submittedReferences) {
                        if (!references.some(r => r.id === ref.id)) {
                            references.unshift(ref);
                        }
                    }
                    renderReferences();
                    updateStatus(`发送失败：${err?.message || err}`, 'error');
                } else {
                    hasUnsavedChanges = true;
                    persistenceBadge.style.display = 'inline-block';
                    updateStatus('已生成但保存失败', 'error');
                }
            } else {
                hasUnsavedChanges = false;
                persistenceBadge.style.display = 'none';
                updateStatus('就绪');
            }
        } catch (error) {
            if (!textarea.value && submittedText) textarea.value = submittedText;
            for (const ref of submittedReferences) {
                if (!references.some(r => r.id === ref.id)) {
                    references.unshift(ref);
                }
            }
            renderReferences();
            updateStatus(`发送失败：${error.message}`, 'error');
        } finally {
            if (!isDisposed) {
                form.removeAttribute('aria-busy');
                textarea.disabled = false;
                sendBtn.style.display = 'inline-flex';
                stopBtn.style.display = 'none';
                updateComposerState();
                updateEmptyState();
            }
        }
    };

    submitInteractiveContent = (text) => {
        if (isDisposed) return;
        textarea.value = String(text || '');
        form.requestSubmit();
    };

    const onStop = async () => {
        updateStatus('正在停止...');
        await surface.cancelMessage();
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
        updateComposerState();
        updateEmptyState();
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
            const validation = validateReferenceList(references, ref);
            if (!validation.ok) {
                chatCapabilities?.uiHelper?.showToastNotification?.(validation.message, 'warning');
                return;
            }
            references.push(ref);
            renderReferences();
            updateComposerState();
        },
        removeReference(refId) {
            const index = references.findIndex(r => r.id === refId);
            if (index !== -1) {
                references.splice(index, 1);
                renderReferences();
                updateComposerState();
            }
        },
        getReferences() {
            return [...references];
        },
        setModel(model) {
            if (!model || isDisposed) return;
            selectedItem.model = model;
            if (selectedItem.config) selectedItem.config.model = model;
            descriptor.model = model;
            if (modelNameSpan) modelNameSpan.textContent = model;
            if (modelPickerBtn) modelPickerBtn.title = `点击切换模型 (当前: ${model})`;
        },
        getModel() {
            return selectedItem.model || descriptor.model || 'gpt-4o';
        },
        async requestClose() {
            if (hasUnsavedChanges) {
                return { closed: false, reason: 'UNSAVED_CHANGES' };
            }
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
