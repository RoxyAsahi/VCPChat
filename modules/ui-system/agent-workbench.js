import { register } from './next-ui-apps.js';
import { createWorkbenchController } from './agent-workbench-controller.js';
import { projectMessage, projectSession } from './agent-workbench-projections.js';
import { deriveWorkbenchViewState } from './agent-workbench-store.js';
import {
    createAgentTimelineParts,
    projectVcpToolPresentation,
    reconcileAgentTimeline,
} from './agent-workbench-timeline.js';
import { createAgentBlockPresentation, createAgentMessagePresentation } from './agent-presentation/index.js';

// Build Agent identities are independent from normal-chat Agents. Keep Nova
// visible synchronously while the authoritative Build catalog loads.
const NOVA_CATALOG_FALLBACK = Object.freeze({
    id: 'Nova', name: 'Nova', model: '', systemPrompt: '{{Nova}}', avatarUrl: null,
});

function seedBuildAgentCatalog() { return [{ ...NOVA_CATALOG_FALLBACK }]; }

// This is deliberately a view over AgentRuntime, not a second chat/session
// implementation. Session, message, tool, approval and runtime state all come
// from Electron Main's Codex runtime and projection services through narrow IPC.
const runtimeApi = () => window.chatAPI || window.electronAPI || {};
// This is deliberately only a pointer. The renderer remembers which durable
// VChat Agent Session to display after Ctrl+R; transcript data stays in SQLite
// and execution context stays in the Codex Thread Store.
const LAST_TOPIC_STORAGE_KEY = 'vcpchat.agentWorkbench.lastTopic.v1';
const TOPIC_TAKEOVER_POLL_INTERVAL_MS = 500;
const TOPIC_TAKEOVER_TIMEOUT_MS = 30_000;

function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
}

// R3 fixed lifecycle state machine — labels shown in the Workbench header.
const WORKBENCH_VIEW_STATE_LABELS = {
    disconnected: '未连接',
    starting: '启动中',
    idle: '空闲',
    running: '运行中',
    'awaiting-approval': '待审批',
    reconnecting: '重连中',
    error: '错误',
};

function loadRememberedTopic() {
    try {
        const value = window.localStorage?.getItem(LAST_TOPIC_STORAGE_KEY);
        const parsed = value ? JSON.parse(value) : null;
        if (!parsed || typeof parsed.topicId !== 'string') return null;
        const pointer = { topicId: parsed.topicId };
        // Normalize legacy values immediately; no async runtime/catalog read
        // may leave transcript, Agent or workspace metadata in localStorage.
        window.localStorage?.setItem(LAST_TOPIC_STORAGE_KEY, JSON.stringify(pointer));
        return pointer;
    } catch {
        return null;
    }
}

function rememberTopic(session) {
    if (!session?.topicId) return;
    try {
        window.localStorage?.setItem(LAST_TOPIC_STORAGE_KEY, JSON.stringify({ topicId: session.topicId }));
    } catch {
        // Local storage is only a convenience pointer; Topic recovery must
        // never fail because a locked-down renderer refuses preferences.
    }
}

function node(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
}

function icon(name, label) {
    const value = node('span', 'vcp-ui-icon', name);
    value.setAttribute('aria-hidden', 'true');
    if (!label) return [value];
    return [value, node('span', 'agent-chat-visually-hidden', label)];
}

function proxyMainButton(id) {
    // The Agent Workbench is a separate product page.  The only shared piece
    // here is the VCPChat Agent/Group configuration flow, which belongs to
    // main chat rather than Rust Topics.  Ask the owning module to open it
    // directly: a synthetic click can silently hit a replaced sidebar button
    // whose original event listener is no longer attached after a UI redraw.
    if (id === 'nextUiCreateItemBtn' && typeof window.topTabManager?.openCreateDialog === 'function') {
        return window.topTabManager.openCreateDialog();
    }
    return document.getElementById(id)?.click();
}

function iconButton(iconName, label, className = '') {
    const value = node('button', `agent-chat-icon-button ${className}`.trim());
    value.type = 'button';
    value.title = label;
    value.setAttribute('aria-label', label);
    value.append(...icon(iconName, label));
    return value;
}

function button(label, className = '') {
    const value = node('button', `agent-chat-button ${className}`.trim(), label);
    value.type = 'button';
    return value;
}

// Agent Workbench owns its DOM and behavior.  It deliberately uses the shared
// sidebar/composer *classes* and design tokens, but never clones a main-chat
// element: copying it also copied incidental IDs/listeners and made this page
// depend on whichever main-chat markup happened to be mounted.
function visualActionButton(iconName, label, className = '', text = '') {
    const value = node('button', className);
    value.type = 'button';
    value.title = label;
    value.setAttribute('aria-label', label);
    value.append(...vectorIcon(iconName, label));
    if (text) value.append(node('span', '', text));
    return value;
}

function vectorIcon(name, label) {
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
        takeover: [['path', { d: 'M7 7h12l-3-3' }], ['path', { d: 'm19 7-3 3' }], ['path', { d: 'M17 17H5l3 3' }], ['path', { d: 'm5 17 3-3' }]],
        delete: [['path', { d: 'M4 7h16' }], ['path', { d: 'M9 7V4h6v3' }], ['path', { d: 'm6 7 1 13h10l1-13' }], ['path', { d: 'M10 11v5' }], ['path', { d: 'M14 11v5' }]],
        close: [['path', { d: 'm7 7 10 10' }], ['path', { d: 'm17 7-10 10' }]],
    };
    const shape = paths[name];
    if (!shape) return icon(name, label);
    const value = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    value.setAttribute('viewBox', '0 0 24 24');
    value.setAttribute('fill', 'none');
    value.setAttribute('stroke', 'currentColor');
    value.setAttribute('stroke-width', '2');
    value.setAttribute('stroke-linecap', 'round');
    value.setAttribute('stroke-linejoin', 'round');
    value.setAttribute('aria-hidden', 'true');
    for (const [tag, attributes] of shape) {
        const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attributes).forEach(([attribute, attributeValue]) => child.setAttribute(attribute, attributeValue));
        value.append(child);
    }
    return [value, ...(label ? [node('span', 'agent-chat-visually-hidden', label)] : [])];
}

function createSidebarSearchPanel(inputId, inputLabel, placeholder, closeClass, closeLabel) {
    const panel = node('div', 'sidebar-subtab-item sidebar-search-subtab');
    const searchContainer = node('div', 'topic-search-container');
    searchContainer.append(...icon('search'));
    const input = document.createElement('input');
    input.type = 'search';
    input.id = inputId;
    input.className = 'topic-search-input';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', inputLabel);
    const close = visualActionButton('close', closeLabel, closeClass);
    searchContainer.append(input, close);
    panel.append(searchContainer);
    return { panel, input, close };
}

function createAccountDock(state) {
    const dock = node('div', 'next-ui-account-dock agent-chat-account-dock');
    const menu = node('div', 'next-ui-account-menu agent-chat-account-menu');
    menu.hidden = true;
    const closeMenu = () => { menu.hidden = true; };
    const themeStore = button('主题选择', 'next-ui-account-menu-item');
    themeStore.prepend(...icon('palette'));
    themeStore.addEventListener('click', () => { closeMenu(); runtimeApi().openThemesWindow?.(); });
    const themeToggle = button(document.body.classList.contains('dark-theme') ? '切换为浅色模式' : '切换为深色模式', 'next-ui-account-menu-item');
    themeToggle.prepend(...icon(document.body.classList.contains('dark-theme') ? 'light_mode' : 'dark_mode'));
    themeToggle.addEventListener('click', () => { closeMenu(); proxyMainButton('themeToggleBtn'); });
    // Chat presentation mode submenu, mirroring the main chat's account-dock
    // switcher: label row expands a submenu of bubble/panel/immersive options.
    const presentationLabels = { bubble: '气泡', panel: '面板', immersive: '沉浸' };
    const getPresentationMode = () => {
        if (document.body.classList.contains('chat-presentation-panel')) return 'panel';
        if (document.body.classList.contains('chat-presentation-immersive')) return 'immersive';
        return window.globalSettings?.chatPresentationMode || 'bubble';
    };
    const presentationItem = node('button', 'agent-chat-button next-ui-account-menu-item');
    presentationItem.type = 'button';
    presentationItem.prepend(...icon('view_agenda'));
    presentationItem.append(
        node('span', 'next-ui-account-menu-label', '聊天显示模式'),
        node('span', 'next-ui-account-menu-value agent-chat-account-presentation-value', presentationLabels[getPresentationMode()] || '气泡'),
        ...icon('chevron_right')
    );
    presentationItem.setAttribute('aria-expanded', 'false');
    const presentationOptions = node('div', 'next-ui-account-submenu agent-chat-account-presentation-options');
    presentationOptions.setAttribute('role', 'group');
    presentationOptions.setAttribute('aria-label', '选择聊天显示模式');
    presentationOptions.hidden = true;
    const presentationOptionSpecs = [
        ['bubble', 'chat_bubble', '气泡模式'],
        ['panel', 'view_day', '面板模式'],
        ['immersive', 'fullscreen', '沉浸模式'],
    ];
    for (const [mode, iconName, label] of presentationOptionSpecs) {
        const option = node('button', 'next-ui-account-submenu-item');
        option.type = 'button';
        option.dataset.presentationMode = mode;
        option.append(...icon(iconName), node('span', '', label), node('span', 'vcp-ui-icon next-ui-account-option-check', 'check'));
        option.addEventListener('click', async () => {
            if (typeof window.applyChatPresentationMode === 'function') {
                await window.applyChatPresentationMode(mode, {
                    persist: true,
                    preserveScroll: true,
                    notify: false,
                    source: 'agent-account-menu'
                });
            }
            closeMenu();
        });
        presentationOptions.append(option);
    }
    presentationItem.addEventListener('click', () => {
        const expanded = presentationOptions.hidden;
        presentationOptions.hidden = !expanded;
        presentationItem.setAttribute('aria-expanded', String(!expanded));
    });
    menu.append(themeStore, themeToggle, presentationItem, presentationOptions);
    // Keep the dock's theme labels and presentation mode in sync with runtime
    // switching. The main chat toggles `dark-theme` and `chat-presentation-*`
    // on <body>; without watching it the account menu would show stale labels
    // until the next full re-render.
    const syncAccountTheme = () => {
        const dark = document.body.classList.contains('dark-theme');
        themeStore.replaceChildren(...icon('palette'), document.createTextNode('主题选择'));
        themeToggle.replaceChildren(...icon(dark ? 'light_mode' : 'dark_mode'), document.createTextNode(dark ? '切换为浅色模式' : '切换为深色模式'));
        const mode = getPresentationMode();
        const value = menu.querySelector('.agent-chat-account-presentation-value');
        if (value) value.textContent = presentationLabels[mode] || '气泡';
        presentationOptions.querySelectorAll('[data-presentation-mode]').forEach(option => {
            const active = option.dataset.presentationMode === mode;
            option.classList.toggle('active', active);
            option.setAttribute('aria-pressed', String(active));
        });
    };
    if (typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(syncAccountTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        state.accountThemeObserver = observer;
    }
    const trigger = node('button', 'next-ui-account-trigger');
    trigger.type = 'button';
    trigger.title = '全局设置';
    const avatar = document.createElement('img');
    avatar.className = 'agent-chat-account-avatar';
    avatar.src = window.globalSettings?.userAvatarUrl || 'assets/default_user_avatar.png';
    avatar.alt = '';
    trigger.append(avatar, node('span', 'agent-chat-account-name', window.globalSettings?.userName?.trim() || '用户'), ...icon('expand_less'));
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        menu.hidden = !menu.hidden;
        trigger.setAttribute('aria-expanded', String(!menu.hidden));
        if (!menu.hidden) presentationOptions.hidden = true;
    });
    const settings = iconButton('settings', '全局设置', 'next-ui-account-settings');
    settings.addEventListener('click', () => { closeMenu(); window.uiHelperFunctions?.openModal?.('globalSettingsModal'); });
    dock.append(menu, trigger, settings);
    return dock;
}

function notify(message, variant = 'info') {
    if (window.VCPUI?.feedback?.toast) window.VCPUI.feedback.toast(message, { variant });
    else window.uiHelperFunctions?.showToastNotification?.(message, variant === 'error' ? 'error' : 'success');
}

function nextSessionTitle() {
    // Keep the same friction-free convention as VCPChat's normal “新话题”
    // action. A first user prompt may become the durable VChat Session title.
    const time = new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    return `新会话 ${time}`;
}

function formatTime(value) {
    if (!value) return '';
    try { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); } catch { return ''; }
}

function deliveryLabel(item) {
    if (item.role !== 'user') return '';
    const labels = {
        sending: '发送中…',
        unconfirmed: '发送状态未确认',
        interrupted: '任务已中断',
        failed: '附件不可用',
    };
    return labels[item.deliveryState] || '';
}

function syncMessageDelivery(row, body, item) {
    if (!row || item.role !== 'user') return;
    const label = deliveryLabel(item);
    row.dataset.deliveryState = item.deliveryState || 'confirmed';
    let status = body?.querySelector('.agent-chat-message-delivery');
    if (!label) {
        status?.remove();
        row.removeAttribute('data-delivery-state');
        return;
    }
    if (!status) {
        status = node('div', 'agent-chat-message-delivery');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        body?.append(status);
    }
    status.textContent = label;
    status.title = item.deliveryDetail || label;
}

function renderMarkdown(text) {
    const bridge = window.vcpRenderBridge;
    if (!text) return '';
    if (bridge) return bridge.renderContent(text);
    if (typeof window.parseAgentMarkdown === 'function') return window.parseAgentMarkdown(text);
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderReasoning(text) {
    if (!text) return '';
    const bridge = window.vcpRenderBridge;
    if (bridge) return bridge.renderReasoningBlock(text);
    // Keep the renderer-only fallback structurally equivalent to the normal
    // VCP thought-chain output.  That lets the Workbench retain the same
    // interaction and visual hierarchy in tests or during a partial renderer
    // bootstrap, instead of dropping to a browser-default <details> control.
    return `<div class="vcp-thought-chain-bubble collapsible expanded" data-vcp-block-type="thought-chain">
        <div class="vcp-thought-chain-header"><span class="vcp-thought-chain-icon vcp-ui-icon" data-vcp-icon="lightbulb">lightbulb</span><span class="vcp-thought-chain-label">思考中</span><span class="vcp-result-toggle-icon"></span></div>
        <div class="vcp-thought-chain-collapsible-content"><div class="vcp-thought-chain-body"><pre>${
            String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        }</pre></div></div>
    </div>`;
}

function postRender(contentDiv) {
    window.vcpRenderBridge?.runPostRender(contentDiv);
}

// Wall-clock reasoning duration, keyed by message id.  Recorded when a
// reasoning block first streams and read back when the message completes so
// the thinking block can auto-collapse with an accurate "思考 Ns" label.
const reasoningStartTimes = new Map();

// Drive the thought-chain (reasoning) block's open/collapsed state and, on
// completion, stamp a thinking duration.  Keeps the live stream expanded and
// auto-collapses it once the assistant message is complete.
function applyReasoningState(reasoningEl, item) {
    if (!reasoningEl) return;
    const bubble = reasoningEl.querySelector('.vcp-thought-chain-bubble');
    const header = reasoningEl.querySelector('.vcp-thought-chain-header');
    const iconEl = reasoningEl.querySelector('.vcp-thought-chain-icon');
    const label = reasoningEl.querySelector('.vcp-thought-chain-label');
    const completed = item.state === 'complete';
    if (iconEl) {
        // Cherry Studio uses a quiet lightbulb affordance rather than a large
        // decorative emoji. Keep the shared VCP renderer markup but turn this
        // Workbench projection into that compact status treatment.
        iconEl.classList.add('vcp-ui-icon');
        iconEl.textContent = 'lightbulb';
        iconEl.dataset.vcpIcon = 'lightbulb';
        window.VCPIcons?.set?.(iconEl, 'lightbulb');
    }
    header?.setAttribute('title', completed ? '展开推理过程' : '查看正在生成的推理过程');
    // The normal renderer binds this through vcpRenderBridge.  Keep the
    // bootstrap/test fallback independently interactive without registering a
    // second listener in the full renderer.
    if (!window.vcpRenderBridge && header && header.dataset.agentWorkbenchToggleBound !== 'true') {
        header.dataset.agentWorkbenchToggleBound = 'true';
        header.tabIndex = 0;
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', String(bubble?.classList.contains('expanded')));
        const toggle = () => {
            bubble?.classList.toggle('expanded');
            header.setAttribute('aria-expanded', String(bubble?.classList.contains('expanded')));
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });
    }
    reasoningEl.dataset.state = completed ? 'complete' : 'streaming';
    if (completed) {
        bubble?.classList.remove('expanded');
        reasoningEl.classList.add('is-complete');
        const start = reasoningStartTimes.get(item.id);
        const secs = Math.max(0.1, (start == null ? 0 : performance.now() - start) / 1000);
        if (label) {
            label.replaceChildren(document.createTextNode('已深度思考 '), node('span', 'agent-chat-reasoning-time', `${secs.toFixed(1)}s`));
        }
        const content = reasoningEl.querySelector('.vcp-thought-chain-collapsible-content');
        if (content && !content.querySelector('.agent-chat-reasoning-copy')) {
            const copy = iconButton('content_copy', '复制推理过程', 'agent-chat-reasoning-copy');
            copy.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const value = String(item.reasoning || '');
                if (!value) return;
                const write = window.navigator?.clipboard?.writeText?.(value);
                if (write && typeof write.catch === 'function') {
                    write.then(() => notify('已复制推理过程。', 'success'))
                        .catch(() => notify('无法访问系统剪贴板。', 'warning'));
                } else {
                    notify('当前环境无法访问系统剪贴板。', 'warning');
                }
            });
            content.append(copy);
        }
        reasoningStartTimes.delete(item.id);
    } else {
        bubble?.classList.add('expanded');
        if (!reasoningStartTimes.has(item.id)) reasoningStartTimes.set(item.id, performance.now());
        const secs = Math.max(0.1, (performance.now() - reasoningStartTimes.get(item.id)) / 1000);
        if (label) {
            label.replaceChildren(document.createTextNode('思考中 '), node('span', 'agent-chat-reasoning-time', `${secs.toFixed(1)}s`));
        }
    }
}

function scrollFeed(container, force) {
    const bridge = window.vcpRenderBridge;
    if (force) {
        const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
        raf(() => { if (container?.isConnected) container.scrollTop = container.scrollHeight; });
        return;
    }
    if (bridge) {
        bridge.autoScrollToBottom(container);
    } else if (container && isFollowingContainer(container)) {
        container.scrollTop = container.scrollHeight;
    }
}

function isFollowingContainer(container) {
    const bridge = window.vcpRenderBridge;
    return bridge ? bridge.isNearBottom(container, 48) : (container.scrollTop + container.clientHeight >= container.scrollHeight - 48);
}

function formatAttachmentSize(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
    if (value >= 1_000) return `${Math.round(value / 1_000)} KB`;
    return `${value} B`;
}

function attachmentKindLabel(attachment) {
    switch (attachment?.kind) {
    case 'audio': return '音频';
    case 'video': return '视频';
    default: return '图片';
    }
}

function attachmentKindIcon(attachment) {
    switch (attachment?.kind) {
    case 'audio': return 'audiotrack';
    case 'video': return 'movie';
    default: return 'image';
    }
}

function attachmentMetadata(attachment) {
    const dimensions = attachment?.kind === 'image'
        ? `${attachment.width || '?'}×${attachment.height || '?'}`
        : attachmentKindLabel(attachment);
    return `${dimensions} · ${formatAttachmentSize(attachment?.byteLen)}`;
}

function createAttachmentChips(attachments, onRemove = null) {
    const list = node('div', 'agent-chat-attachment-list');
    list.setAttribute('aria-label', '媒体附件');
    attachments.forEach((attachment, index) => {
        const chip = node('div', 'agent-chat-attachment-chip');
        const summary = node('div', 'agent-chat-attachment-summary');
        summary.append(
            ...icon(attachmentKindIcon(attachment)),
            node('span', 'agent-chat-attachment-name', attachment.displayName || attachmentKindLabel(attachment)),
            node('span', 'agent-chat-attachment-meta', attachmentMetadata(attachment)),
        );
        chip.append(summary);
        if (onRemove) {
            const remove = visualActionButton('close', `移除 ${attachment.displayName || '附件'}`, 'agent-chat-attachment-remove');
            remove.addEventListener('click', () => onRemove(index));
            chip.append(remove);
        }
        list.append(chip);
    });
    return list;
}

function createMessage(message) {
    const item = projectMessage(message);
    const role = item.role === 'user' ? 'user' : 'assistant';
    const row = node('article', `message-item ${role}`);
    row.dataset.messageId = item.id || `${role}:${item.turnId || ''}`;
    const avatar = document.createElement('img');
    avatar.className = 'chat-avatar';
    avatar.src = role === 'user' ? 'assets/default_user_avatar.png' : 'assets/default_avatar.png';
    avatar.alt = role === 'user' ? '你的头像' : 'Nova 头像';
    avatar.onerror = () => { avatar.classList.add('is-image-unavailable'); };
    const body = node('div', 'details-and-bubble-wrapper');
    const heading = node('div', 'name-time-block');
    heading.append(node('div', 'sender-name', role === 'user' ? '你' : 'Nova'), node('div', 'message-timestamp', formatTime(item.createdAt)));
    const content = node('div', 'md-content');
    if (item.content && item.state === 'streaming') {
        // Streaming text is patched as text until the daemon closes the
        // message.  This avoids reparsing an ever-growing Markdown document
        // on every delta while leaving final rendering to the shared bridge.
        content.textContent = item.content;
        content.dataset.agentStreaming = 'true';
    } else if (item.content) {
        content.innerHTML = renderMarkdown(item.content);
        postRender(content);
    } else if (item.state === 'streaming') {
        content.innerHTML = '<span class="agent-chat-thinking-placeholder">正在思考…</span>';
    }
    body.append(heading, content);
    if (item.attachments?.length) body.append(createAttachmentChips(item.attachments));
    if (item.reasoning) {
        const reasoningEl = node('div', 'agent-chat-reasoning-block');
        reasoningEl.innerHTML = renderReasoning(item.reasoning);
        postRender(reasoningEl);
        applyReasoningState(reasoningEl, item);
        body.append(reasoningEl);
    }
    syncMessageDelivery(row, body, item);
    // Streaming indicator: only show when there is no content yet
    if (item.state === 'streaming' && !item.content) {
        body.append(node('span', 'agent-chat-streaming', '正在生成'));
    }
    row.append(avatar, body);
    return row;
}

function patchMessage(row, message) {
    const item = projectMessage(message);
    const content = row.querySelector('.md-content');
    if (content) {
        if (item.content && item.state === 'streaming') {
            content.textContent = item.content;
            content.dataset.agentStreaming = 'true';
        } else if (item.content) {
            content.innerHTML = renderMarkdown(item.content);
            delete content.dataset.agentStreaming;
            postRender(content);
        } else if (item.state === 'streaming') {
            if (!content.querySelector('.agent-chat-thinking-placeholder')) {
                content.innerHTML = '<span class="agent-chat-thinking-placeholder">正在思考…</span>';
            }
        } else {
            content.innerHTML = '';
            delete content.dataset.agentStreaming;
        }
    }

    const body = row.querySelector('.details-and-bubble-wrapper');
    body?.querySelector('.agent-chat-attachment-list')?.remove();
    if (item.attachments?.length && body) {
        const attachmentList = createAttachmentChips(item.attachments);
        const reasoningBlock = body.querySelector('.agent-chat-reasoning-block');
        if (reasoningBlock) body.insertBefore(attachmentList, reasoningBlock);
        else body.append(attachmentList);
    }
    let reasoningEl = body?.querySelector('.agent-chat-reasoning-block');
    if (item.reasoning) {
        if (!reasoningEl) {
            reasoningEl = node('div', 'agent-chat-reasoning-block');
            body?.append(reasoningEl);
        }
        reasoningEl.innerHTML = renderReasoning(item.reasoning);
        postRender(reasoningEl);
        applyReasoningState(reasoningEl, item);
    } else if (reasoningEl) {
        reasoningEl.remove();
        reasoningStartTimes.delete(item.id);
    }
    syncMessageDelivery(row, body, item);

    // Streaming indicator: only show when there is no content yet
    let streaming = body?.querySelector('.agent-chat-streaming');
    if (item.state === 'streaming' && !item.content) {
        if (!streaming) {
            streaming = node('span', 'agent-chat-streaming', '正在生成');
            body?.append(streaming);
        }
    } else {
        streaming?.remove();
    }
}




function mountWorkbench(container) {
    const controller = createWorkbenchController(runtimeApi());
    const { store } = controller;
    const state = {
        tab: 'agents',
        selectedAgent: 'Nova',
        agentCatalog: seedBuildAgentCatalog(),
        agentSearch: '',
        modelCatalog: [],
        topics: [],
        topicsByAgent: new Map(),
        topicListLoading: false,
        topicSearch: '',
        topicSearchResults: [],
        topicSearchLoading: false,
        topicSearchError: '',
        topicSearchOpen: false,
        topicManaging: false,
        topicSelectedIds: new Set(),
        queue: [],
        queueOpen: false,
        budget: { maxRequestsPerTurn: null, maxTokensPerTurn: null },
        budgetSaving: false,
        // This is deliberately local-client policy only.  It never changes
        // VCPToolBox's independent backend approval policy.
        permissionMode: 'ask',
        permissionSaving: false,
        modelSaving: false,
        avatarSaving: false,
        // Draft model value for the selected Session.  It is intentionally
        // kept separate from the durable configSnapshot until Save succeeds.
        modelDraft: null,
        modelDraftSessionId: null,
        recovering: false,
        activityOpen: false,
        activityTab: 'activity',
        activitySearch: '',
        activitySourceFilter: 'all',
        activityKindFilter: 'all',
        activityTabPanels: new Map(),
        activityTabButtons: new Map(),
        lastViewState: null,
        hadApprovals: false,
        workspace: '',
        model: 'gpt-5.6-terra',
        prompt: '',
        pendingAttachments: [],
        rememberedTopic: loadRememberedTopic(),
        takeoverTopicId: null,
        topicConflict: null,
        // A purely visual reading aid.  It records neither transcript content
        // nor daemon state; it only lets a reader return to the live edge
        // after intentionally browsing older timeline Parts.
        followingFeed: true,
        unreadTimelineCount: 0,
        // Keyed by Rust-owned messageId/toolCallId.  This is a DOM cache only;
        // it never contains a transcript beyond the current renderer view.
        timelineRows: new Map(),
        presentationMode: 'fork',
        // Renderer-only send barrier.  This is not a message/turn identity
        // and is never written to SQLite; it exists so first-send startup is
        // visibly busy while thread/start is still in flight.
        turnStart: null,
        // The session sidebar is a stable DOM shell while its normal Topic
        // list is visible. Rust refreshes patch its rows in place so a
        // background catalog read cannot discard the reader's scroll anchor,
        // search control or selected row.
        sessionSidebar: null,
        // This is deliberately a transient UI flow, not a second Topic
        // store.  Rust remains the source of the Topic metadata/checkpoint;
        // the renderer only keeps the currently-open form and a small
        // read-only snapshot summary while the dialog is visible.
        topicFlow: null,
        // A document-level popover is intentionally transient. It is never
        // used as Topic state: Rust remains the owner of Topic metadata,
        // leases and mutations.
        topicContextMenu: null,
        uxTimings: new Map(),
        turnStartedAt: new Map(),
        disposed: false,
    };
    const pendingRender = { shell: false, header: false, feed: false, composer: false, activity: false, conflict: false };
    let renderFrame = null;
    // Control-plane replies can arrive after a user picked another Agent.
    // Keep the latest selection authoritative; an older Topic list must not
    // replace the newly selected Agent's history.
    let controlPlaneRequest = 0;
    let topicCatalogRequest = 0;
    let topicSearchRequest = 0;
    let topicSearchTimer = null;
    let topicMenuInstance = 0;
    let runStatusTimer = null;

    const root = node('section', 'container agent-chat-root vcp-ui-scope');
    // Read-only diagnostics for Electron smoke/visual QA. The mode still
    // comes exclusively from Main and never becomes persisted Renderer state.
    root.dataset.presentationRenderer = state.presentationMode;
    const topicFlowLayer = node('div', 'vcp-ui-scope agent-chat-topic-flow-layer');
    const topicConflictLayer = node('div', 'vcp-ui-scope agent-chat-topic-conflict-layer');
    topicConflictLayer.hidden = true;
    const sidebar = node('aside', 'sidebar active vcp-ui-scope agent-chat-sidebar');
    const main = node('main', 'main-content agent-chat-main-content agent-chat-pane');
    const feed = node('div', 'chat-messages-container vcp-ui-scope agent-chat-messages-container');
    const feedItems = node('div', 'chat-messages agent-chat-messages');
    const jumpToLatest = button('回到最新', 'agent-chat-jump-to-latest');
    jumpToLatest.hidden = true;
    jumpToLatest.setAttribute('aria-live', 'polite');
    const header = node('header', 'chat-header vcp-ui-scope agent-chat-header');
    const composer = node('footer', 'chat-input-area agent-chat-composer');
    const runStatus = node('div', 'agent-chat-run-status');
    runStatus.hidden = true;
    runStatus.setAttribute('role', 'status');
    runStatus.setAttribute('aria-live', 'polite');
    const runStatusIcon = node('span', 'vcp-ui-icon agent-chat-run-status-icon', 'progress_activity');
    const runStatusLabel = node('strong', 'agent-chat-run-status-label', '正在运行');
    const runStatusDetail = node('span', 'agent-chat-run-status-detail');
    const runStatusElapsed = node('time', 'agent-chat-run-status-elapsed', '0.0s');
    const runStatusStop = visualActionButton('stop', '停止当前任务', 'agent-chat-run-status-stop');
    runStatus.append(runStatusIcon, runStatusLabel, runStatusDetail, runStatusElapsed, runStatusStop);
    const inputCard = node('div', 'chat-input-card');
    const input = document.createElement('textarea');
    input.className = 'agent-chat-message-input';
    input.rows = 1;
    input.placeholder = '输入消息…（Shift + Enter 换行）';
    input.setAttribute('aria-label', '输入 Agent 消息');
    const composerActions = node('div', 'chat-input-actions');
    const newButton = visualActionButton('add_comment', '新建 Agent 会话', 'agent-chat-composer-new');
    const attachButton = visualActionButton('attach_file', '添加图片、音频或视频附件');
    const emoticonButton = visualActionButton('sentiment_satisfied', '打开表情包');
    const permissionsButton = visualActionButton('policy', '本地审批', 'agent-chat-composer-permissions');
    const sendButton = visualActionButton('arrow_upward', '发送消息', 'agent-chat-send-button');
    const attachmentTray = node('div', 'agent-chat-composer-attachments');
    emoticonButton.addEventListener('click', () => {
        if (window.emoticonManager?.togglePanel) window.emoticonManager.togglePanel(emoticonButton, input);
        else notify('表情包系统尚未准备好。', 'warning');
    });
    permissionsButton.addEventListener('click', () => {
        state.tab = 'settings';
        queueRender({ shell: true });
    });
    composerActions.append(newButton, attachButton, emoticonButton, permissionsButton, sendButton);
    inputCard.append(attachmentTray, input, composerActions);
    composer.append(runStatus, inputCard);
    feed.append(feedItems);
    const mainColumn = node('div', 'agent-chat-main-column');
    const activityPanel = node('aside', 'agent-chat-activity-panel agent-chat-activity-collapsed');
    activityPanel.id = 'agentChatActivityPanel';
    activityPanel.setAttribute('role', 'complementary');
    activityPanel.setAttribute('aria-label', 'Agent 活动面板');
    activityPanel.setAttribute('aria-hidden', 'true');
    activityPanel.setAttribute('inert', '');
    const activityInner = node('div', 'agent-chat-activity-inner');
    const activityHeader = node('div', 'agent-chat-activity-header');
    const activityTitle = node('strong', 'agent-chat-activity-title', '会话信息');
    const activityClose = iconButton('close', '关闭会话信息面板', 'agent-chat-activity-close');
    activityClose.addEventListener('click', () => setActivityOpen(false));
    activityHeader.append(activityTitle, activityClose);
    const activityTabs = node('div', 'agent-chat-activity-tabs');
    activityTabs.setAttribute('role', 'tablist');
    const activityContent = node('div', 'agent-chat-activity-content');
    activityContent.setAttribute('role', 'presentation');
    activityInner.append(activityHeader, activityTabs, activityContent);
    activityPanel.append(activityInner);
    // A Topic collision is an in-context decision, not a blocking app-wide
    // modal. Keep the existing transcript and composer visible behind the
    // compact card so opening a busy Topic never feels like the page broke.
    mainColumn.append(header, topicConflictLayer, feed, jumpToLatest, composer);
    main.append(mainColumn, activityPanel);
    root.append(sidebar, main);
    container.classList.add('agent-workbench-root', 'agent-chat-root');
    container.append(root, topicFlowLayer);

    const run = async (work) => {
        try { await work(); } catch (error) {
            // Browser DevTools otherwise renders an Error object as an opaque
            // `JSHandle@error`, which hides a daemon/control-plane failure
            // from both users and Electron smoke diagnostics.
            console.error('[Agent Workbench]', error?.stack || error?.message || String(error));
            notify(error?.message || String(error), 'error');
        }
    };
    runStatusStop.addEventListener('click', () => run(async () => {
        runStatusStop.disabled = true;
        await controller.cancelTurn();
    }));

    const blockPresentation = createAgentBlockPresentation({
        document,
        renderContent: renderMarkdown,
        postRender,
        actions: {
            cancelTool: (tool) => run(() => controller.cancelTool(tool.toolCallId, tool.turnId)),
            respondToolboxApproval: (approvalId, decision) => run(() => controller.respondToolboxApproval(approvalId, decision)),
        },
    });

    const legacyTimelineCallbacks = {
        create(part) {
            if (part.kind === 'message') return createMessage(part.value);
            return blockPresentation.timelineCallbacks.create(part);
        },
        patch(row, part) {
            if (part.kind === 'message') patchMessage(row, part.value);
            else return blockPresentation.timelineCallbacks.patch(row, part);
            return row;
        },
    };

    function presentationSessionContext() {
        const current = store.getState();
        const profile = selectedAgentProfile() || {};
        const selected = current.selectedTopic || current.attachment || {};
        return {
            sessionId: current.attachment?.sessionId || selected.topicId || null,
            threadId: current.attachment?.threadId || selected.threadId || null,
            participant: {
                id: selected.agentId || profile.id || state.selectedAgent,
                name: profile.name || selected.agentName || selected.agentId || state.selectedAgent || 'Nova',
                avatarUrl: profile.avatarUrl || selected.avatarUrl || '',
                colors: profile.colors || profile.config?.colors || {},
                config: profile.config || profile,
            },
            messages: current.messages || [],
            settings: window.globalSettings || {},
        };
    }

    function promptForPart(part) {
        const messages = store.getState().messages || [];
        const index = messages.findIndex((message) => (message.id || message.messageId) === part.id);
        const candidates = index >= 0 ? messages.slice(0, index + 1).reverse() : messages.slice().reverse();
        const user = candidates.find((message) => message.role === 'user' && typeof message.content === 'string');
        return user?.content || (typeof part.value?.content === 'string' ? part.value.content : '');
    }

    async function forkAndSend(part, prompt, title) {
        const context = presentationSessionContext();
        await controller.forkSession({ sessionId: context.sessionId, turnId: part.turnId, title });
        if (prompt?.trim()) await controller.startTurn(prompt.trim(), []);
    }

    const fullPresentation = createAgentMessagePresentation({
        window,
        document,
        container: feedItems,
        getSessionContext: presentationSessionContext,
        nonMessageCallbacks: blockPresentation.timelineCallbacks,
        electronAPI: runtimeApi(),
        scrollToBottom: () => scrollFeed(feed, true),
        notify,
        actions: {
            copy: async ({ text: value }) => {
                await navigator.clipboard.writeText(value);
                notify('已复制渲染后的文本。', 'success');
            },
            interrupt: ({ part }) => run(async () => {
                await controller.cancelTurn();
                notify(`已请求中止 ${part.turnId || '当前 Turn'}。`, 'success');
            }),
            fork: ({ part }) => run(async () => {
                await controller.forkSession({
                    sessionId: presentationSessionContext().sessionId,
                    turnId: part.turnId,
                    title: 'Agent 分支',
                });
                notify('已创建 Codex 会话分支。', 'success');
            }),
            retry: ({ part }) => run(async () => {
                await forkAndSend(part, promptForPart(part), '从消息重试');
                notify('已在新 Codex 分支重试。', 'success');
            }),
            edit: ({ part }) => {
                const original = promptForPart(part);
                const edited = window.prompt?.('编辑并在新 Codex 分支发送', original);
                if (edited === null || edited === undefined || !edited.trim()) return;
                run(async () => {
                    await forkAndSend(part, edited, '编辑消息分支');
                    notify('已在新 Codex 分支发送编辑内容。', 'success');
                });
            },
            forward: ({ part }) => run(async () => {
                const value = typeof part.value?.content === 'string' ? part.value.content : promptForPart(part);
                await navigator.clipboard.writeText(value || '');
                notify('Agent 消息已复制；可粘贴到目标 VChat 会话。', 'success');
            }),
        },
    });
    fullPresentation.bindInteractions();

    // One renderer-only ticker keeps Host-owned deadlines visible. It never
    // resolves an approval; the daemon's approval.resolved event is the sole
    // authoritative terminal transition.
    const approvalRegistry = new Map();
    let approvalTicker = null;
    function ensureApprovalTicker() {
        if (approvalTicker) return;
        approvalTicker = setInterval(() => {
            const now = Date.now();
            for (const [id, entry] of approvalRegistry) {
                const cards = root.querySelectorAll(`[data-approval-id="${cssEscape(id)}"]`);
                if (!cards.length) continue;
                const remaining = entry.deadline - now;
                const expired = remaining <= 0;
                cards.forEach((card) => {
                    const label = card.querySelector('.agent-chat-approval-countdown');
                    if (expired) {
                        if (!entry.expired) {
                            entry.expired = true;
                            card.classList.add('agent-chat-approval-expired');
                            if (label) label.textContent = '等待 Codex App Server 确认超时拒绝';
                            const approvalLive = card.querySelector('.agent-chat-approval-live');
                            if (approvalLive) approvalLive.textContent = '审批截止时间已到，等待 Codex App Server 最终事件。';
                        }
                    } else if (label) {
                        label.textContent = `默认拒绝 · Codex App Server ${Math.ceil(remaining / 1000)}s 后处理`;
                    }
                });
                if (expired) {
                    approvalRegistry.delete(id);
                    continue;
                }
            }
            if (approvalRegistry.size === 0 && approvalTicker) {
                clearInterval(approvalTicker);
                approvalTicker = null;
            }
        }, 500);
    }

    function activeSession() {
        return store.getState().attachment || null;
    }

    function syncPermissionModeFromSelectedSession() {
        const current = store.getState();
        const snapshot = current.selectedTopic?.configSnapshot
            || current.attachment?.configSnapshot
            || null;
        if (!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, 'approvalPolicy')) return;
        // The selected Session snapshot is the same source that Main passes
        // to Codex on the next turn. The page-level value is only a default
        // for creating a new Session and must not overwrite this projection.
        state.permissionMode = snapshot.permissionMode
            || (snapshot.approvalPolicy === 'never' ? 'always-approve' : 'ask');
    }

    function syncModelFromSelectedSession() {
        const current = store.getState();
        const selectedSessionId = current.selectedTopic?.topicId || current.attachment?.sessionId || '';
        if (state.modelDraftSessionId !== selectedSessionId) {
            state.modelDraftSessionId = selectedSessionId;
            state.modelDraft = null;
        }
        const snapshot = current.selectedTopic?.configSnapshot
            || current.attachment?.configSnapshot
            || null;
        const selectedModel = typeof snapshot?.model === 'string' ? snapshot.model.trim() : '';
        if (selectedModel && state.modelDraft === null) state.model = selectedModel;
    }

    function sameAgent(left, right) {
        return String(left || '').trim().toLocaleLowerCase()
            === String(right || '').trim().toLocaleLowerCase();
    }

    function isEmptyTopicCheckpointError(error) {
        // A Topic directory is created before its first safe checkpoint. Rust
        // correctly refuses `read-topic` for that empty history; on a later
        // renderer reload the local convenience pointer must not turn this
        // valid state into a Runtime-start failure notification.
        return /Agent Topic has no checkpoint/i.test(String(error?.message || error || ''));
    }

    function selectedAgentProfile() {
        return state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, state.selectedAgent)) || null;
    }

    function agentAvatarUrl(agentId) {
        return state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, agentId))?.avatarUrl
            || 'assets/default_avatar.png';
    }

    function selectAgent(agentId) {
        const profile = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, agentId));
        if (!profile) return;
        state.selectedAgent = profile.id || profile.name;
        // This is only the default for a future Topic. Existing Topics retain
        // their persisted model when opened, and no Session is created here.
        if (profile.model) state.model = profile.model;
    }

    function agentCacheKey(agentId) {
        return String(agentId || '').trim().toLocaleLowerCase();
    }

    function uxMark(name, identity, startedAt = null) {
        const now = window.performance?.now?.() || Date.now();
        const shortId = String(identity || '').slice(0, 8);
        if (startedAt === null) state.uxTimings.set(name, now);
        const base = startedAt ?? state.uxTimings.get(name) ?? now;
        console.debug('[Agent UX]', { name, id: shortId, durationMs: Math.round((now - base) * 10) / 10 });
        return now;
    }

    async function refreshTopicsForAgent(agentId) {
        const selectedAgentId = String(agentId || state.selectedAgent || 'Nova').trim();
        const key = agentCacheKey(selectedAgentId);
        const cached = state.topicsByAgent.get(key);
        state.topics = Array.isArray(cached) ? cached : [];
        state.topicListLoading = !cached;
        queueRender({ shell: true, header: true, composer: true });
        if (cached) {
            const clickedAt = state.uxTimings.get(`agent-click:${key}`) || null;
            (window.requestAnimationFrame || ((callback) => setTimeout(callback, 0)))(() => {
                uxMark('session-cache-painted', selectedAgentId, clickedAt);
            });
        }
        const request = ++topicCatalogRequest;
        try {
            const topics = await controller.listTopics(selectedAgentId);
            if (state.disposed || request !== topicCatalogRequest || !sameAgent(selectedAgentId, state.selectedAgent)) return;
            const received = Array.isArray(topics) ? topics : topics?.topics || [];
            // Main has already resolved canonical Agent identity. Renderer
            // must not repeat legacy name/folder-id guessing here.
            state.topicsByAgent.set(key, received);
            state.topics = received;
            uxMark('projection-list-returned', selectedAgentId, state.uxTimings.get(`agent-click:${key}`) || null);
            const clickedAt = state.uxTimings.get(`agent-click:${key}`) || null;
            (window.requestAnimationFrame || ((callback) => setTimeout(callback, 0)))(() => {
                uxMark('session-cache-painted', selectedAgentId, clickedAt);
            });
        } finally {
            if (!state.disposed && request === topicCatalogRequest && sameAgent(selectedAgentId, state.selectedAgent)) {
                state.topicListLoading = false;
                queueRender({ shell: true, header: true, composer: true });
            }
        }
    }

    async function refreshControlPlane() {
        const request = ++controlPlaneRequest;
        const optional = (fn) => Promise.resolve().then(fn).catch(() => []);
        // Build profiles are isolated from the normal-chat Agent directory.
        const sharedAgents = await optional(() => runtimeApi().agentRuntimeListAgentProfiles?.());
        const normalizedAgents = Array.isArray(sharedAgents)
            ? sharedAgents.map((agent) => ({
                id: agent.id || agent.name,
                name: agent.name || agent.id,
                model: agent.config?.model || agent.model || '',
                systemPrompt: agent.config?.systemPrompt || agent.systemPrompt || '',
                avatarUrl: agent.avatarUrl || null,
            }))
            : [];
        if (!normalizedAgents.some((agent) => agent.id === 'Nova' || agent.name === 'Nova')) {
            normalizedAgents.unshift({ ...NOVA_CATALOG_FALLBACK });
        }
        state.agentCatalog = normalizedAgents;
        // Preserve a deliberate Agent selection. Nova is a fallback only
        // when the previously selected shared Agent disappeared.
        if (!selectedAgentProfile()) {
            const fallback = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, 'Nova'))
                || state.agentCatalog[0];
            if (fallback) selectAgent(fallback.id || fallback.name);
        }
        const selectedAgentId = state.selectedAgent || 'Nova';
        queueRender({ shell: true, header: true, composer: true });

        // VCPChat Main already owns its background `/v1/models` cache.  Read
        // that cache opportunistically for the optional settings selector;
        // never wait for it before rendering or restoring a Topic.
        void optional(() => runtimeApi().getCachedModels?.()).then((models) => {
            if (state.disposed) return;
            const rawModels = Array.isArray(models) ? models : models?.models || [];
            state.modelCatalog = rawModels.map((model) => typeof model === 'string'
                ? { id: model, name: model }
                : { ...model, id: model?.id || model?.name || '', name: model?.name || model?.id || '' })
                .filter((model) => model.id);
            if (!state.modelDraft && !state.modelCatalog.some((model) => model.id === state.model)) {
                state.model = state.modelCatalog[0]?.id || state.model;
            }
            // Model discovery only changes selectors in the sidebar.  It must
            // not reset a potentially streaming transcript.
            queueRender({ shell: true, header: true, composer: true });
        });

        // Topics and the steering queue are VCPAgent-specific Rust state.
        // Load them after the base VCPChat Agent surface is visible so a
        // transient daemon or ToolBox issue cannot blank the entire page.
        const [topics, queue, workbenchSettings] = await Promise.all([
            optional(() => controller.listTopics(selectedAgentId)),
            optional(() => controller.listInteractionQueue()),
            optional(() => controller.getWorkbenchSettings()),
        ]);
        if (state.disposed || request !== controlPlaneRequest || !sameAgent(selectedAgentId, state.selectedAgent)) return;
        const receivedTopics = Array.isArray(topics) ? topics : topics?.topics || [];
        // Rust returns Agent-scoped Topic metadata. Retain this defensive
        // filter so an old/stale daemon result cannot leak another Agent's
        // history into the current sidebar.
        state.topics = receivedTopics;
        state.topicsByAgent.set(agentCacheKey(selectedAgentId), receivedTopics);
        state.topicListLoading = false;
        state.queue = Array.isArray(queue) ? queue : queue?.items || queue?.queue || [];
        if (workbenchSettings && typeof workbenchSettings === 'object') {
            const budget = workbenchSettings.budget && typeof workbenchSettings.budget === 'object'
                ? workbenchSettings.budget : {};
            state.budget = {
                maxRequestsPerTurn: budget.maxRequestsPerTurn ?? null,
                maxTokensPerTurn: budget.maxTokensPerTurn ?? null,
            };
            state.permissionMode = workbenchSettings.permissionMode === 'always-approve'
                ? 'always-approve' : 'ask';
            if (!store.getState().selectedTopic?.configSnapshot?.model && workbenchSettings.model) {
                state.model = String(workbenchSettings.model);
            }
        }
        syncPermissionModeFromSelectedSession();
        syncModelFromSelectedSession();
        // Topics and queue state live in the control plane; leave the active
        // transcript intact while those catalog reads finish.
        queueRender({ shell: true, header: true, composer: true });
    }

    async function createSession(overrides = {}) {
        state.topicConflict = null;
        state.pendingAttachments = [];
        const runtimeState = store.getState().runtime.state;
        if (runtimeState === 'stopped' || runtimeState === 'unknown') {
            await controller.startRuntime();
        }
        const title = overrides.title || (overrides.resume ? undefined : nextSessionTitle());
        const session = await controller.createSession({
            workspaceRoot: overrides.workspaceRoot ?? (state.workspace.trim() || undefined),
            model: overrides.model ?? (state.model.trim() || undefined),
            agent: overrides.agent ?? (state.selectedAgent || 'Nova'),
            systemPrompt: overrides.systemPrompt ?? selectedAgentProfile()?.systemPrompt ?? '',
            permissionMode: overrides.permissionMode ?? state.permissionMode,
            resume: overrides.resume,
            title,
        });
        rememberTopic(session);
        state.tab = 'sessions';
        await refreshControlPlane();
        return session;
    }

    async function createTopic(overrides = {}) {
        state.topicConflict = null;
        state.pendingAttachments = [];
        const runtimeState = store.getState().runtime.state;
        if (runtimeState === 'stopped' || runtimeState === 'unknown') {
            await controller.startRuntime();
        }
        const created = await controller.createTopic({
            workspaceRoot: overrides.workspaceRoot ?? (state.workspace.trim() || undefined),
            model: overrides.model ?? (state.model.trim() || undefined),
            agent: overrides.agent ?? (state.selectedAgent || 'Nova'),
            systemPrompt: overrides.systemPrompt ?? selectedAgentProfile()?.systemPrompt ?? '',
            title: overrides.title || nextSessionTitle(),
        });
        rememberTopic(created);
        state.tab = 'sessions';
        await refreshControlPlane();
        return created;
    }

    function defaultNewTopicFlow() {
        return {
            kind: 'create',
            title: nextSessionTitle(),
            agent: state.selectedAgent || 'Nova',
            model: state.model || '',
            workspaceRoot: state.workspace || '',
            permissionMode: state.permissionMode,
            saving: false,
        };
    }

    function openNewTopicFlow() {
        state.topicFlow = defaultNewTopicFlow();
        // A modal is a user-initiated foreground action, not a background
        // control-plane refresh. Render it synchronously so a ready/readiness
        // event cannot replace the header between the click and the next RAF
        // and make the create affordance look inert.
        renderTopicFlow();
    }

    function closeTopicFlow() {
        state.topicFlow = null;
        queueRender({ topicFlow: true });
    }

    async function requestTopicTakeover(topic) {
        if (!topic?.id || state.takeoverTopicId) return;
        state.takeoverTopicId = topic.id;
        queueRender({ shell: true, header: true, composer: true });
        try {
            await controller.takeoverTopic(topic.id, topic.agentId);
            notify('已请求当前 Topic 持有者安全释放会话，正在等待 checkpoint…');
            const deadline = Date.now() + TOPIC_TAKEOVER_TIMEOUT_MS;
            while (!state.disposed && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, TOPIC_TAKEOVER_POLL_INTERVAL_MS));
                await refreshControlPlane();
                const released = state.topics.find((item) => item.id === topic.id);
                if (released && !released.inUse) {
                    await createSession({
                        resume: released.id,
                        title: released.title,
                        model: released.model,
                        agent: released.agentId,
                        workspaceRoot: released.workspaceRef,
                    });
                    notify('Topic 已安全接管，并恢复到最近的 checkpoint。', 'success');
                    return true;
                }
            }
            if (!state.disposed) throw new Error('等待 Topic 持有者释放超时；其 lease 仍有效，请稍后重试。');
        } finally {
            state.takeoverTopicId = null;
            queueRender({ shell: true, header: true, composer: true, conflict: true });
        }
    }

    function openTopicConflict(topic) {
        if (!topic?.id || state.takeoverTopicId) return;
        if (store.getState().runtime?.runtime === 'codex-app-server') {
            void run(() => controller.previewTopic(topic.id, topic.agentId, topic));
            return;
        }
        state.topicConflict = { topic, takingOver: false, error: null };
        queueRender({ conflict: true });
    }

    function clearTopicConflictForSelection(topicId) {
        const conflict = state.topicConflict;
        // A conflict is an explicit decision for one Topic only. Browsing a
        // different Rust snapshot must never leave the old dialog floating
        // above unrelated history. An in-flight cooperative takeover remains
        // visible until Rust reaches its safe terminal result.
        if (!conflict || conflict.takingOver || conflict.topic?.id === topicId) return;
        state.topicConflict = null;
        queueRender({ conflict: true });
    }

    function closeTopicConflict() {
        if (state.topicConflict?.takingOver) return;
        state.topicConflict = null;
        queueRender({ conflict: true });
    }

    async function recoverDaemon() {
        // Recovery is intentionally user-driven.  A daemon crash must never
        // replay an interrupted model/tool turn or silently reacquire a
        // writable lease; restore only the durable preview snapshot.
        if (state.recovering) return;
        state.recovering = true;
        queueRender({ header: true, composer: true });
        try {
            const previous = activeSession();
            await controller.stopRuntime();
            await controller.startRuntime();
            if (previous?.topicId) {
                await controller.previewTopic(previous.topicId, previous.agentId, previous);
                notify('Rust Agent 已重新连接，并显示最近的安全 Topic checkpoint。中断的 Turn 不会重放。', 'success');
            } else {
                await refreshControlPlane();
                notify('Rust Agent 已重新连接。请新建一个 Agent 会话。', 'success');
            }
        } finally {
            state.recovering = false;
            queueRender({ header: true, composer: true });
        }
    }

    function rememberTopicTitle(topic, title) {
        if (state.rememberedTopic?.topicId === topic.id) {
            state.rememberedTopic = { ...state.rememberedTopic, title };
        }
        rememberTopic({
            topicId: topic.id,
            title,
            agentId: topic.agentId || state.selectedAgent || 'Nova',
            model: topic.model || state.model,
            workspaceRoot: topic.workspaceRef || state.workspace,
        });
    }

    function forgetTopic(topicId) {
        if (state.rememberedTopic?.topicId !== topicId) return;
        state.rememberedTopic = null;
        try { window.localStorage?.removeItem(LAST_TOPIC_STORAGE_KEY); } catch { /* convenience pointer only */ }
    }

    function closeTopicContextMenu({ returnFocus = false } = {}) {
        const current = state.topicContextMenu;
        if (!current) return;
        state.topicContextMenu = null;
        current.menu.remove();
        current.positionRule?.remove();
        document.removeEventListener('pointerdown', current.onPointerDown, true);
        document.removeEventListener('keydown', current.onKeyDown, true);
        if (returnFocus && current.trigger?.isConnected) current.trigger.focus();
    }

    async function copyTopicId(topicId) {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('clipboard API unavailable');
            await navigator.clipboard.writeText(topicId);
            notify('Topic ID 已复制。', 'success');
        } catch {
            // This copies only a durable identifier supplied by Rust; it is
            // not a transcript or a second renderer-side Topic store.
            const temporary = document.createElement('textarea');
            temporary.value = topicId;
            temporary.className = 'agent-chat-clipboard-proxy';
            temporary.setAttribute('readonly', '');
            document.body.append(temporary);
            temporary.select();
            const copied = document.execCommand?.('copy');
            temporary.remove();
            if (copied) notify('Topic ID 已复制。', 'success');
            else notify(`无法访问系统剪贴板；Topic ID：${topicId}`, 'warning');
        }
    }

    function addTopicContextMenuItem(menu, iconName, label, action, { danger = false } = {}) {
        // Deliberately reuse the main-chat DOM primitives. The callbacks stay
        // Agent-specific and go through Rust, but the visual contract (size,
        // font, icon spacing, theme and hover state) is the exact same shared
        // `.context-menu` / `.context-menu-item` implementation.
        const item = node('div', `context-menu-item agent-chat-topic-context-menu-item${danger ? ' danger-item' : ''}`);
        item.setAttribute('role', 'menuitem');
        item.tabIndex = 0;
        const iconElement = node('i', `fas fa-${iconName}`);
        iconElement.setAttribute('aria-hidden', 'true');
        item.append(iconElement, document.createTextNode(label));
        const invoke = (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeTopicContextMenu();
            run(action);
        };
        item.addEventListener('click', invoke);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') invoke(event);
        });
        menu.append(item);
        return item;
    }

    function positionTopicContextMenu(menu, point) {
        // Mount under document.body so a sidebar scroller cannot clip the
        // menu; then clamp it to the active Electron viewport.
        const gap = 8;
        const width = menu.offsetWidth || 188;
        const height = menu.offsetHeight || 240;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const left = Math.max(gap, Math.min(point.x, viewportWidth - width - gap));
        const top = Math.max(gap, Math.min(point.y, viewportHeight - height - gap));
        const instance = String(++topicMenuInstance);
        menu.dataset.agentMenuInstance = instance;
        // Keep transient pointer coordinates out of element inline styles.
        // The rule contains only clamped numeric viewport coordinates and is
        // removed with the document-level menu; it never holds Topic data.
        const positionRule = document.createElement('style');
        positionRule.textContent = `.agent-chat-topic-context-menu[data-agent-menu-instance="${instance}"] { left: ${left}px; top: ${top}px; visibility: visible; }`;
        document.head.append(positionRule);
        return positionRule;
    }

    function showTopicContextMenu(topic, trigger, point, { live = false } = {}) {
        if (!topic?.id || state.topicManaging) return;
        closeTopicContextMenu();
        const menu = node('div', 'context-menu agent-chat-topic-context-menu');
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', `管理 Topic：${topic.title || topic.id}`);
        menu.hidden = true;

        if (topic.inUse && !live) {
            addTopicContextMenuItem(menu, 'folder-open', '打开会话', async () => openTopicConflict(topic));
        } else if (live) {
            addTopicContextMenuItem(menu, 'folder-open', '打开当前会话', async () => controller.hydrateTopic(topic.id, null, null, topic.agentId));
        } else {
            addTopicContextMenuItem(menu, 'folder-open', '打开会话', async () => {
                await controller.previewTopic(topic.id, topic.agentId, topic);
                rememberTopic({ topicId: topic.id });
            });
            addTopicContextMenuItem(menu, 'edit', '重命名', async () => {
                const title = window.prompt?.('重命名 Agent Topic', topic.title || '');
                if (title === null || title === undefined || title.trim() === (topic.title || '').trim()) return;
                await controller.renameTopic(topic.id, title, topic.agentId);
                rememberTopicTitle(topic, title.trim());
                await refreshControlPlane();
                notify('Agent Topic 已重命名。', 'success');
            });
        }
        if (topic.inUse || live) addTopicContextMenuItem(menu, 'copy', '复制 Topic ID', async () => copyTopicId(topic.id));
        else addTopicContextMenuItem(menu, 'copy', '复制 Topic ID', async () => copyTopicId(topic.id));
        if (!topic.inUse && !live) {
            addTopicContextMenuItem(menu, 'trash-alt', '删除此话题', async () => {
                const confirmed = window.confirm?.(`确定删除「${topic.title || topic.id}」吗？此操作不能恢复。`);
                if (!confirmed) return;
                await controller.deleteTopic(topic.id, topic.agentId);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent Topic 已删除。', 'success');
            }, { danger: true });
        }

        const onPointerDown = (event) => {
            if (!menu.contains(event.target) && event.target !== trigger) closeTopicContextMenu();
        };
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closeTopicContextMenu({ returnFocus: true });
        };
        document.body.append(menu);
        const positionRule = positionTopicContextMenu(menu, point);
        menu.hidden = false;
        state.topicContextMenu = { menu, trigger, onPointerDown, onKeyDown, positionRule };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        queueMicrotask(() => menu.querySelector('[role="menuitem"]')?.focus());
    }

    function appendTopicActions(row, topic, { live = false } = {}) {
        // Use an inline SVG here rather than a Material Symbols glyph. The
        // Agent Workbench can mount before that optional font is ready; its
        // text fallback was the small grey dash seen beside every Topic row.
        const menu = visualActionButton('more', `管理 Topic：${topic.title || topic.id}`, 'agent-chat-session-menu');
        menu.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = menu.getBoundingClientRect();
            showTopicContextMenu(topic, menu, { x: rect.right, y: rect.bottom }, { live });
        });
        row.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            showTopicContextMenu(topic, menu, { x: event.clientX, y: event.clientY }, { live });
        });
        row.append(menu);
    }

    function sessionSidebarEntries() {
        const current = store.getState();
        const attachment = current.attachment;
        // Every daemon-reported runtime is a separate Topic Host. Scope them
        // by Rust-confirmed Agent identity; never reuse the selected Topic's
        // metadata as a fallback, which was the Nova/123 cross-routing bug.
        const liveSessions = (Array.isArray(current.activeRuntimes) ? current.activeRuntimes : [])
            .filter((runtime) => sameAgent(runtime.agentId, state.selectedAgent))
            .map((runtime) => projectSession({
                ...(state.topics.find((topic) => topic.id === runtime.topicId) || {}),
                ...runtime,
            }));
        const liveTopicIds = new Set(liveSessions.map((session) => session.topicId).filter(Boolean));
        return {
            attachment,
            liveSessions,
            persistedTopics: state.topics.filter((topic) => !liveTopicIds.has(topic.id)),
            selectedTopicId: store.getState().selectedTopic?.topicId || attachment?.topicId || null,
        };
    }

    function patchSessionSidebar() {
        const shell = state.sessionSidebar;
        if (!shell || shell.agentId !== state.selectedAgent || state.tab !== 'sessions'
            || state.topicManaging || state.topicSearchOpen || state.topicSearch.trim()) return false;
        const { attachment, liveSessions, persistedTopics, selectedTopicId } = sessionSidebarEntries();
        const desired = [
            ...liveSessions.map((session) => ({ id: session.topicId, live: true, value: session })),
            ...persistedTopics.map((topic) => ({ id: topic.id, live: false, value: topic })),
        ];
        // `children` avoids a JSDOM/Chromium `:scope` edge case and makes the
        // ownership boundary explicit: only direct Topic rows participate in
        // keyed reconciliation, never the empty/search status helpers.
        const rows = [...shell.list.children].filter((row) => row.classList.contains('agent-chat-session-row'));
        if (rows.length !== desired.length || rows.some((row, index) => row.dataset.topicId !== desired[index].id)) {
            return false;
        }

        // A transition to an externally held lease changes the permitted click
        // path. Rebuild that rare row shell so its event handler is updated;
        // normal metadata/status refreshes remain keyed and allocation-free.
        if (desired.some((entry, index) => Boolean(rows[index].dataset.topicInUse === 'true') !== Boolean(entry.value.inUse))) return false;

        for (const [index, entry] of desired.entries()) {
            const row = rows[index];
            const active = entry.id === selectedTopicId;
            row.classList.toggle('active', active);
            row.classList.toggle('active-topic-glowing', active);
            row.dataset.topicSearch = `${entry.value.title || entry.id} ${entry.value.model || ''}`.toLocaleLowerCase();
            row.dataset.topicInUse = String(Boolean(entry.value.inUse));
            const title = row.querySelector('.topic-title-display');
            if (title) title.textContent = entry.value.title || entry.id;
            if (entry.live) {
                const count = row.querySelector('.message-count');
                if (count) count.textContent = active ? String(store.getState().messages.length) : '';
            } else {
                row.title = entry.value.searchHit?.snippet || '';
            }
        }
        return true;
    }

    function renderSidebar() {
        syncModelFromSelectedSession();
        if (patchSessionSidebar()) return;
        // A change of sidebar mode/form is intentionally a shell transition.
        // Ordinary Topic refreshes take the keyed fast path above instead.
        state.sessionSidebar = null;
        // Topic selection is allowed to update the renderer projection, but
        // it must not throw the conversation list back to its top.
        const scrollTop = sidebar.scrollTop;
        sidebar.replaceChildren();
        const tabs = node('div', 'sidebar-tabs');
        for (const [id, label] of [['agents', '助手'], ['sessions', '会话'], ['settings', '设置']]) {
            const tab = node('button', `sidebar-tab-button${state.tab === id ? ' active' : ''}`, label);
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(state.tab === id));
            tab.addEventListener('click', () => {
                closeTopicContextMenu();
                state.tab = id;
                // Topic management is a transient renderer affordance. Never
                // leave selection mode active while the Topic page is hidden.
                if (id !== 'sessions') {
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    state.topicSearchOpen = false;
                    state.topicSearch = '';
                    state.topicSearchResults = [];
                    state.topicSearchLoading = false;
                    state.topicSearchError = '';
                    topicSearchRequest += 1;
                }
                renderSidebar();
                // Topic metadata is owned by Rust and may have changed while
                // this page was hidden. Opening the tab never creates a
                // Session; it simply refreshes the selected Agent's history.
                if (id === 'sessions') run(() => refreshControlPlane());
            });
            tabs.append(tab);
        }
        const content = node('div', 'sidebar-tab-content active agent-chat-sidebar-content');
        if (state.tab === 'sessions') {
            const header = node('div', 'topics-header-container');
            const tools = node('div', 'next-ui-topic-tools');
            // Keep the Topic toolbar structurally identical to the main
            // chat's Topic toolbar. The callbacks deliberately stay local to
            // the Workbench: Agent Topics are Rust-daemon-owned objects.
            const add = visualActionButton('add', '新建会话', 'next-ui-create-topic-trigger', '新建会话');
            add.addEventListener('click', openNewTopicFlow);
            const manage = visualActionButton('checklist', '管理会话', 'next-ui-topic-icon-trigger');
            manage.addEventListener('click', () => {
                closeTopicContextMenu();
                state.topicManaging = !state.topicManaging;
                if (!state.topicManaging) state.topicSelectedIds.clear();
                renderSidebar();
            });
            manage.classList.toggle('active', state.topicManaging);
            manage.setAttribute('aria-pressed', String(state.topicManaging));
            const searchTrigger = visualActionButton('search', '搜索会话', 'next-ui-topic-icon-trigger');
            searchTrigger.setAttribute('aria-expanded', String(state.topicSearchOpen));
            tools.append(add, manage, searchTrigger);

            const { panel: searchPanel, input: search, close: closeSearch } = createSidebarSearchPanel(
                'agentWorkbenchTopicSearchInput', '搜索 Agent 会话', '搜索会话...',
                'next-ui-topic-search-close', '关闭会话搜索',
            );
            search.value = state.topicSearch;
            closeSearch.title = '关闭搜索';
            closeSearch.setAttribute('aria-label', '关闭会话搜索');
            searchTrigger.setAttribute('aria-controls', search.id);
            header.classList.toggle('is-searching', state.topicSearchOpen);
            const setSearchOpen = (open, clear = !open) => {
                state.topicSearchOpen = open;
                searchTrigger.setAttribute('aria-expanded', String(open));
                header.classList.toggle('is-searching', open);
                if (clear) {
                    state.topicSearch = '';
                    state.topicSearchResults = [];
                    state.topicSearchLoading = false;
                    state.topicSearchError = '';
                    topicSearchRequest += 1;
                    search.value = '';
                    applyTopicFilter();
                }
                if (open) queueMicrotask(() => search.focus());
            };
            searchTrigger.addEventListener('click', () => setSearchOpen(true, false));
            closeSearch.addEventListener('click', () => setSearchOpen(false));
            search.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    setSearchOpen(false);
                    searchTrigger.focus();
                }
            });
            header.append(tools, searchPanel);
            content.append(header);
            const list = node('ul', 'topic-list agent-chat-session-list');
            const { liveSessions, persistedTopics: normalPersistedTopics, selectedTopicId } = sessionSidebarEntries();
            const indexedTopics = state.topicSearch.trim()
                ? state.topicSearchResults.map((hit) => ({
                    id: hit.topicId,
                    title: hit.title || hit.topicId,
                    agentId: hit.agentId || state.selectedAgent,
                    inUse: hit.inUse === true,
                    readOnly: hit.readOnly === true,
                    model: hit.model || '',
                    workspaceRef: hit.workspaceRef || '',
                    updatedAt: hit.updatedAt || hit.timestamp || 0,
                    searchHit: hit,
                }))
                : normalPersistedTopics;
            const persistedTopics = indexedTopics.filter((topic) => !liveSessions.some((session) => session.topicId === topic.id));
            if (!state.topicSearch.trim() && !liveSessions.length && !persistedTopics.length) {
                if (state.topicListLoading) {
                    for (let index = 0; index < 4; index += 1) {
                        list.append(node('li', 'topic-item agent-chat-session-row agent-chat-session-skeleton', ''));
                    }
                } else {
                    list.append(node('li', 'agent-chat-empty-list', `${state.selectedAgent || '当前 Agent'} 还没有会话。创建一个会话后即可开始。`));
                }
            }
            for (const session of liveSessions) {
                const active = session.topicId === selectedTopicId;
                // Keep this deliberately isomorphic to topicListManager's main
                // chat rows.  The only different bit is the select callback.
                const row = node('li', `topic-item agent-chat-session-row${active ? ' active active-topic-glowing' : ''}`);
                row.tabIndex = 0;
                row.dataset.itemId = session.agentId || state.selectedAgent || 'Nova';
                row.dataset.itemType = 'agent-runtime';
                row.dataset.topicId = session.topicId;
                row.dataset.topicInUse = 'false';
                row.dataset.runtimeActivity = session.activity || 'idle';
                row.dataset.topicSearch = `${session.title} ${session.model}`.toLocaleLowerCase();
                const avatar = document.createElement('img');
                avatar.className = 'avatar';
                avatar.loading = 'lazy';
                avatar.decoding = 'async';
                avatar.src = agentAvatarUrl(session.agentId || state.selectedAgent);
                avatar.alt = `${state.selectedAgent || 'Nova'} - ${session.title}`;
                avatar.onerror = () => { avatar.src = 'assets/default_avatar.png'; };
                const title = node('span', 'topic-title-display', session.title);
                const count = node('span', 'message-count', active
                    ? String(store.getState().messages.length)
                    : session.activity === 'running' ? '●'
                        : session.activity === 'awaiting-approval' ? '!' : '');
                row.append(avatar, title, count);
                // The row is a live attachment, not a durable GUI Session.
                // Rebuild only from the Rust Topic snapshot; Main has no
                // message/event ring to select from.
                row.addEventListener('click', () => run(() => controller.hydrateTopic(session.topicId, session, null, session.agentId)));
                if (!state.topicManaging && session.topicId) {
                    appendTopicActions(row, {
                        id: session.topicId,
                        title: session.title,
                        agentId: session.agentId,
                        model: session.model,
                        workspaceRef: session.workspaceRoot,
                        inUse: false,
                    }, { live: true });
                }
                list.append(row);
            }
            // Old conversations are Topics, not abandoned in-memory GUI
            // sessions.  Render them with the same main-chat row contract and
            // resume the bounded Rust checkpoint when selected.
            for (const topic of persistedTopics) {
                const selectable = !topic.inUse;
                const selected = state.topicSelectedIds.has(topic.id);
                const active = topic.id === selectedTopicId;
                const row = node('li', `topic-item agent-chat-session-row agent-chat-persisted-topic${selected ? ' selected' : ''}${active ? ' active active-topic-glowing' : ''}`);
                row.tabIndex = 0;
                row.dataset.itemId = topic.agentId || state.selectedAgent || 'Nova';
                row.dataset.itemType = 'agent-topic';
                row.dataset.topicId = topic.id;
                row.dataset.topicInUse = String(Boolean(topic.inUse));
                row.dataset.topicSearch = `${topic.title || topic.id} ${topic.model || ''}`.toLocaleLowerCase();
                const avatar = document.createElement('img');
                avatar.className = 'avatar';
                avatar.loading = 'lazy';
                avatar.decoding = 'async';
                avatar.src = agentAvatarUrl(topic.agentId || state.selectedAgent);
                avatar.alt = `${topic.agentId || 'Nova'} - ${topic.title || topic.id}`;
                avatar.onerror = () => { avatar.src = 'assets/default_avatar.png'; };
                const title = node('span', 'topic-title-display', topic.title || topic.id);
                // A Topic lease is a concurrency guard, not sidebar content.
                // Keep normal rows visually identical to VCPChat history;
                // only a click on a genuinely external lease may surface the
                // explicit conflict/takeover flow.
                const status = topic.searchHit ? node('span', 'message-count', '匹配') : null;
                if (topic.searchHit?.snippet) row.title = topic.searchHit.snippet;
                row.append(avatar, title);
                if (status) row.append(status);
                if (selectable) {
                    const selectIcon = node('span', 'vcp-ui-icon next-ui-topic-select-icon', selected ? 'check_box' : 'check_box_outline_blank');
                    selectIcon.setAttribute('aria-hidden', 'true');
                    row.prepend(selectIcon);
                }
                row.setAttribute('aria-selected', String(selected));
                row.addEventListener('click', (event) => run(async () => {
                    if (event.target.closest('.agent-chat-session-menu')) return;
                    if (state.topicManaging) {
                        if (!selectable) return;
                        if (state.topicSelectedIds.has(topic.id)) state.topicSelectedIds.delete(topic.id);
                        else state.topicSelectedIds.add(topic.id);
                        renderSidebar();
                        return;
                    }
                    if (topic.locallyAttached) return;
                    // Topic selection is a Rust snapshot read, not a Session
                    // resume.  The daemon stays attached to its current
                    // writer until this Topic actually receives a new turn.
                    clearTopicConflictForSelection(topic.id);
                    if (!topic.inUse) {
                        await controller.previewTopic(topic.id, topic.agentId, topic);
                        rememberTopic({ topicId: topic.id });
                    } else {
                        // Never replace the current attachment/transcript with
                        // a read-only preview. A real collision is the only
                        // exceptional UI path and requires explicit takeover.
                        openTopicConflict(topic);
                    }
                }));
                if (!state.topicManaging) appendTopicActions(row, topic);
                list.append(row);
            }
            const applyTopicFilter = () => {
                const query = search.value.trim().toLocaleLowerCase();
                state.topicSearch = search.value;
                for (const row of list.querySelectorAll('[data-topic-search]')) {
                    row.hidden = Boolean(query) && !state.topicSearchResults.length && !row.dataset.topicSearch.includes(query);
                }
            };
            search.addEventListener('input', () => {
                applyTopicFilter();
                clearTimeout(topicSearchTimer);
                const query = search.value.trim();
                const request = ++topicSearchRequest;
                if (!query) {
                    state.topicSearchResults = [];
                    state.topicSearchLoading = false;
                    state.topicSearchError = '';
                    renderSidebar();
                    return;
                }
                state.topicSearchLoading = true;
                state.topicSearchError = '';
                topicSearchTimer = setTimeout(() => run(async () => {
                    try {
                        const hits = await controller.searchTopics(query, state.selectedAgent, 50);
                        if (request !== topicSearchRequest || query !== state.topicSearch.trim()) return;
                        state.topicSearchResults = Array.isArray(hits) ? hits : [];
                    } catch (error) {
                        if (request !== topicSearchRequest) return;
                        state.topicSearchResults = [];
                        state.topicSearchError = error?.message || String(error);
                    } finally {
                        if (request === topicSearchRequest) {
                            state.topicSearchLoading = false;
                            renderSidebar();
                            queueMicrotask(() => {
                                const active = document.getElementById('agentWorkbenchTopicSearchInput');
                                active?.focus();
                                active?.setSelectionRange(active.value.length, active.value.length);
                            });
                        }
                    }
                }), 180);
            });
            applyTopicFilter();
            const scroll = node('div', 'sidebar-list-scroll');
            scroll.append(list);
            if (state.topicSearchLoading) scroll.prepend(node('div', 'agent-chat-empty-list', '正在搜索 Rust Agent 索引…'));
            else if (state.topicSearchError) scroll.prepend(node('div', 'agent-chat-empty-list', `索引搜索不可用：${state.topicSearchError}`));
            else if (state.topicSearch.trim() && !persistedTopics.length) scroll.prepend(node('div', 'agent-chat-empty-list', '没有匹配的 Agent Topic。'));
            content.append(scroll);
            if (state.topicManaging) {
                content.classList.add('is-managing');
                const panel = node('div', 'next-ui-topic-manage-panel agent-chat-topic-manage-panel');
                panel.setAttribute('aria-hidden', 'false');
                const selection = node('div', 'next-ui-topic-manage-selection');
                const selectAll = button('', 'next-ui-topic-manage-button');
                selectAll.title = '全选可删除会话';
                selectAll.setAttribute('aria-label', '全选可删除会话');
                const visibleSelectableIds = [...list.querySelectorAll('.agent-chat-persisted-topic[data-topic-id]')]
                    .filter((row) => !row.hidden && !state.topics.find((topic) => topic.id === row.dataset.topicId)?.inUse)
                    .map((row) => row.dataset.topicId);
                const allSelected = visibleSelectableIds.length > 0
                    && visibleSelectableIds.every((topicId) => state.topicSelectedIds.has(topicId));
                selectAll.append(...icon(allSelected ? 'check_box' : 'check_box_outline_blank'));
                selectAll.addEventListener('click', () => {
                    if (allSelected) visibleSelectableIds.forEach((topicId) => state.topicSelectedIds.delete(topicId));
                    else visibleSelectableIds.forEach((topicId) => state.topicSelectedIds.add(topicId));
                    renderSidebar();
                });
                const selectionCount = node('span', 'agent-chat-topic-selection-count', `已选择 ${state.topicSelectedIds.size} 项`);
                selectionCount.setAttribute('aria-live', 'polite');
                selection.append(selectAll, selectionCount);
                const actions = node('div', 'next-ui-topic-manage-actions');
                const removeSelected = button('', 'next-ui-topic-manage-button danger');
                removeSelected.title = '删除所选会话';
                removeSelected.setAttribute('aria-label', '删除所选会话');
                removeSelected.disabled = state.topicSelectedIds.size === 0;
                removeSelected.append(...icon('delete'));
                removeSelected.addEventListener('click', () => run(async () => {
                    const selectedTopics = persistedTopics.filter((topic) => state.topicSelectedIds.has(topic.id) && !topic.inUse);
                    if (!selectedTopics.length) return;
                    const confirmed = window.confirm?.(`确定删除选中的 ${selectedTopics.length} 个 Agent Topic 吗？此操作不能恢复。`);
                    if (!confirmed) return;
                    for (const topic of selectedTopics) {
                        await controller.deleteTopic(topic.id, topic.agentId);
                        forgetTopic(topic.id);
                    }
                    state.topicSelectedIds.clear();
                    state.topicManaging = false;
                    await refreshTopicsForAgent(agentId);
                    notify(`已删除 ${selectedTopics.length} 个 Agent Topic。`, 'success');
                }));
                const exit = button('', 'next-ui-topic-manage-button');
                exit.title = '退出管理';
                exit.setAttribute('aria-label', '退出会话管理');
                exit.append(...icon('close'));
                exit.addEventListener('click', () => {
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    renderSidebar();
                });
                actions.append(removeSelected, exit);
                panel.append(selection, actions);
                content.append(panel);
            }
            if (!state.topicManaging && !state.topicSearchOpen && !state.topicSearch.trim()) {
                state.sessionSidebar = { tabs, content, header, list, scroll, agentId: state.selectedAgent };
            }
        } else if (state.tab === 'agents') {
            const header = node('div', 'agents-header');
            const tools = node('div', 'next-ui-agent-tools');
            const add = visualActionButton('add', '创建助手或群组', 'next-ui-create-item-trigger', '创建助手或群组');
            // The assistant list is shared VCPChat configuration, not an
            // Agent Topic list. Reuse the main-chat creation dialog instead
            // of silently creating a Rust Topic from the wrong sidebar tab.
            add.addEventListener('click', () => proxyMainButton('nextUiCreateItemBtn'));
            const searchTrigger = visualActionButton('search', '搜索助手或群', 'next-ui-agent-search-trigger');
            searchTrigger.setAttribute('aria-expanded', String(Boolean(state.agentSearch)));
            tools.append(add, searchTrigger);

            const { panel: searchPanel, input: search, close: closeSearch } = createSidebarSearchPanel(
                'agentWorkbenchSearchInput', '搜索助手或群', '搜索助手或群...',
                'next-ui-agent-search-close', '关闭助手搜索',
            );
            search.value = state.agentSearch;
            closeSearch.title = '关闭搜索';
            closeSearch.setAttribute('aria-label', '关闭助手搜索');
            searchTrigger.setAttribute('aria-controls', search.id);
            const setSearchOpen = (open, clear = !open) => {
                header.classList.toggle('is-searching', open);
                searchTrigger.setAttribute('aria-expanded', String(open));
                if (clear) {
                    state.agentSearch = '';
                    search.value = '';
                }
                if (open) queueMicrotask(() => search.focus());
            };
            searchTrigger.addEventListener('click', () => setSearchOpen(true, false));
            closeSearch.addEventListener('click', () => setSearchOpen(false));
            search.addEventListener('input', () => {
                state.agentSearch = search.value;
                for (const row of list.querySelectorAll('[data-agent-search]')) {
                    row.hidden = Boolean(state.agentSearch.trim())
                        && !row.dataset.agentSearch.includes(state.agentSearch.trim().toLocaleLowerCase());
                }
            });
            search.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    setSearchOpen(false);
                    searchTrigger.focus();
                }
            });
            header.append(tools, searchPanel);
            content.append(header);
            const list = node('ul', 'agent-list agent-chat-agent-list');
            for (const agent of state.agentCatalog) {
                const agentId = agent.id || agent.name;
                const row = node('li', `agent-chat-agent-row${sameAgent(agentId, state.selectedAgent) ? ' active' : ''}`);
                row.tabIndex = 0;
                row.dataset.agentSearch = `${agent.name || ''} ${agentId || ''}`.toLocaleLowerCase();
                const avatar = document.createElement('img');
                avatar.className = 'avatar';
                avatar.src = agent.avatarUrl || 'assets/default_avatar.png';
                avatar.alt = `${agent.name || agentId} 头像`;
                avatar.onerror = () => { avatar.src = 'assets/default_avatar.png'; };
                row.append(avatar, node('span', 'agent-name', agent.name || agentId));
                row.addEventListener('click', () => run(async () => {
                    state.uxTimings.set(`agent-click:${agentCacheKey(agentId)}`, uxMark('agent-click', agentId));
                    selectAgent(agentId);
                    // Selecting an Agent is a browse action, not an implicit
                    // create-session action. Go straight to its durable Rust
                    // Topic catalog so prior history is visible immediately.
                    state.tab = 'sessions';
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    state.topicSearchOpen = false;
                    state.topicSearch = '';
                    queueRender({ shell: true, header: true, composer: true });
                    await refreshControlPlane();
                }));
                list.append(row);
            }
            if (!state.agentCatalog.length) list.append(node('li', 'agent-chat-empty-list', '正在读取 Agent 目录…'));
            const scroll = node('div', 'sidebar-list-scroll');
            scroll.append(list);
            content.append(scroll);
        } else {
            const settingsPane = node('div', 'agent-chat-settings-pane');
            const settingsForm = node('div', 'agent-chat-settings-form');
            const selectedSession = store.getState().selectedTopic?.topicId || activeSession()?.sessionId || '';
            const selectedProjection = store.getState().selectedTopic;
            const selectedRuntime = store.getState().attachment;
            const selectedSnapshot = selectedRuntime?.configSnapshot || selectedProjection?.configSnapshot || null;
            const selectedPermissionMode = selectedSnapshot?.permissionMode
                || (selectedSnapshot?.approvalPolicy === 'never' ? 'always-approve'
                    : selectedSnapshot?.approvalPolicy ? 'ask' : state.permissionMode);
            const selectedModel = state.modelDraftSessionId === selectedSession && state.modelDraft !== null
                ? state.modelDraft
                : (selectedSnapshot?.model || state.model);
            if (state.modelDraftSessionId !== selectedSession) {
                state.modelDraftSessionId = selectedSession;
                state.modelDraft = null;
            }
            // A Session snapshot wins over the page default. This also makes
            // a no-op click on Save safe for an older Session.
            state.permissionMode = selectedPermissionMode;
            const agentPrompt = selectedSnapshot?.baseInstructions
                || selectedSnapshot?.developerInstructions
                || selectedAgentProfile()?.systemPrompt
                || '';
            settingsPane.append(node('p', 'agent-chat-settings-placeholder', selectedSession
                ? '保存审批策略会写入当前 Session，并从下一次 Turn 开始生效；正在运行的 Turn 不会被静默改写。真实凭据仍由 VCPChat 共享设置安全保存。'
                : '未选择 Session 时，这些字段只会作为下一次新建 Session 的默认值；真实凭据仍由 VCPChat 共享设置安全保存。'));
            const field = (label, value, onChange, options = null) => {
                const wrap = node('label', 'agent-chat-setting-field');
                wrap.append(node('span', 'agent-chat-setting-label', label));
                const control = options ? document.createElement('select') : document.createElement('input');
                control.className = 'agent-chat-setting-input';
                if (!options) control.value = value;
                if (options) for (const option of options) {
                    const item = document.createElement('option'); item.value = option.value; item.textContent = option.label; item.selected = option.value === value; control.append(item);
                }
                control.addEventListener('change', () => onChange(control.value));
                wrap.append(control);
                return wrap;
            };
            const avatarProfile = selectedAgentProfile();
            const avatarAgentId = avatarProfile?.id || avatarProfile?.name || state.selectedAgent;
            const avatarSection = node('section', 'agent-chat-settings-avatar');
            const avatarPreview = document.createElement('img');
            avatarPreview.className = 'agent-chat-settings-avatar-preview';
            avatarPreview.src = avatarProfile?.avatarUrl || 'assets/default_avatar.png';
            avatarPreview.alt = `${avatarProfile?.name || avatarAgentId || 'Agent'} 头像`;
            avatarPreview.onerror = () => { avatarPreview.src = 'assets/default_avatar.png'; };
            const avatarCopy = node('div', 'agent-chat-settings-avatar-copy');
            avatarCopy.append(
                node('strong', 'agent-chat-setting-label', 'Agent 头像'),
                node('span', 'agent-chat-setting-help', '仅用于 Build Agent，不影响主聊天助手。PNG、JPEG、GIF 或 WebP。'),
            );
            const avatarInput = document.createElement('input');
            avatarInput.type = 'file';
            avatarInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
            avatarInput.hidden = true;
            avatarInput.setAttribute('aria-label', '选择 Agent 头像');
            const chooseAvatar = button(state.avatarSaving ? '正在保存头像…' : '选择头像', 'secondary agent-chat-settings-save');
            chooseAvatar.disabled = state.avatarSaving || !avatarAgentId;
            chooseAvatar.addEventListener('click', () => avatarInput.click());
            avatarInput.addEventListener('change', () => run(async () => {
                const file = avatarInput.files?.[0];
                if (!file || !avatarAgentId) return;
                const targetAgentId = avatarAgentId;
                const previousAvatarUrl = avatarProfile?.avatarUrl || 'assets/default_avatar.png';
                state.avatarSaving = true;
                renderSidebar();
                try {
                    const result = await runtimeApi().agentRuntimeSaveAgentAvatar?.({
                        agentId: targetAgentId,
                        avatarData: { name: file.name, type: file.type, buffer: await file.arrayBuffer() },
                    });
                    if (!result?.success) throw new Error(result?.error || '头像保存失败。');
                    const profile = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, targetAgentId));
                    if (profile) profile.avatarUrl = result.avatarUrl || previousAvatarUrl;
                    await refreshControlPlane();
                    notify(`${profile?.name || targetAgentId} 的头像已更新。`, 'success');
                } catch (error) {
                    notify(error?.message || String(error), 'error');
                } finally {
                    state.avatarSaving = false;
                    if (!state.disposed) renderSidebar();
                }
            }));
            avatarCopy.append(chooseAvatar, avatarInput);
            avatarSection.append(avatarPreview, avatarCopy);
            settingsForm.append(avatarSection);
            settingsForm.append(
                field('工作目录（可留空）', state.workspace, (value) => { state.workspace = value; }),
                field('Agent', state.selectedAgent, (value) => { state.selectedAgent = value; }, state.agentCatalog.map((agent) => ({ value: agent.id || agent.name, label: agent.name || agent.id }))),
                field('模型', selectedModel, (value) => {
                    state.model = value;
                    state.modelDraft = value;
                    state.modelDraftSessionId = selectedSession;
                }, (() => {
                    const options = state.modelCatalog
                        .map((model) => typeof model === 'string'
                            ? { value: model, label: model }
                            : { value: model?.id || model?.name || '', label: model?.name || model?.id || '' })
                        .filter((model) => model.value);
                    if (selectedModel && !options.some((model) => model.value === selectedModel)) {
                        options.unshift({ value: selectedModel, label: selectedModel });
                    }
                    return options;
                })()),
                field('本地工具审批', selectedPermissionMode, (value) => { state.permissionMode = value === 'always-approve' ? 'always-approve' : 'ask'; }, [
                    { value: 'ask', label: '每次确认（推荐）' },
                    { value: 'always-approve', label: 'YOLO：本地自动允许' },
                ]),
            );
            const promptField = node('label', 'agent-chat-setting-field');
            promptField.append(node('span', 'agent-chat-setting-label', selectedSession ? '当前 Session 的 Developer Instructions（冻结快照）' : '当前 Agent 的提示词'));
            const prompt = document.createElement('textarea');
            prompt.className = 'agent-chat-setting-input agent-chat-setting-prompt';
            prompt.readOnly = true;
            prompt.rows = 5;
            prompt.value = agentPrompt || '此 Agent 未配置提示词。';
            prompt.setAttribute('aria-label', '当前 Agent 提示词');
            promptField.append(prompt);
            settingsForm.append(promptField);
            const permissionHint = node('p', 'agent-chat-settings-placeholder',
                'YOLO 仅跳过 Codex 本地审批；VCPToolBox 的后端审批不会被关闭或绕过。');
            const budgetSection = node('section', 'agent-chat-settings-budget');
            budgetSection.append(node('strong', 'agent-chat-setting-label', '新 Session 每轮安全预算'));
            const budgetHint = node('p', 'agent-chat-settings-placeholder', '留空表示不设客户端上限。预算属于运行配置，不属于用量统计。');
            const budgetFields = node('div', 'agent-chat-settings-budget-fields');
            const budgetInput = (label, name, value) => {
                const wrap = node('label', 'agent-chat-setting-field');
                wrap.append(node('span', 'agent-chat-setting-label', label));
                const control = document.createElement('input');
                control.className = 'agent-chat-setting-input';
                control.type = 'number';
                control.name = name;
                control.min = '1';
                control.step = '1';
                control.placeholder = '不限';
                control.value = value == null ? '' : String(value);
                control.disabled = state.budgetSaving;
                wrap.append(control);
                return wrap;
            };
            budgetFields.append(
                budgetInput('模型请求数', 'maxRequestsPerTurn', state.budget.maxRequestsPerTurn),
                budgetInput('累计 token', 'maxTokensPerTurn', state.budget.maxTokensPerTurn),
            );
            const saveBudget = button(state.budgetSaving ? '正在保存预算…' : '保存安全预算', 'secondary agent-chat-settings-save');
            saveBudget.disabled = state.budgetSaving;
            saveBudget.addEventListener('click', () => run(async () => {
                const requestInput = budgetFields.querySelector('[name="maxRequestsPerTurn"]');
                const tokenInput = budgetFields.querySelector('[name="maxTokensPerTurn"]');
                state.budgetSaving = true;
                renderSidebar();
                try {
                    const saved = await controller.updateWorkbenchSettings({
                        budget: {
                            maxRequestsPerTurn: String(requestInput?.value || '').trim() || null,
                            maxTokensPerTurn: String(tokenInput?.value || '').trim() || null,
                        },
                    });
                    state.budget = saved?.settings?.budget || state.budget;
                    notify('安全预算已保存，新建 Agent Session 后生效。', 'success');
                } finally {
                    state.budgetSaving = false;
                    renderSidebar();
                }
            }));
            budgetSection.append(budgetHint, budgetFields, saveBudget);
            const savePermission = button(state.permissionSaving ? '正在保存…' : '保存本地审批策略', 'secondary agent-chat-settings-save');
            savePermission.disabled = state.permissionSaving;
            savePermission.addEventListener('click', () => run(async () => {
                // Rendering the saving state rehydrates the durable snapshot.
                // Capture the user's select value first so that old metadata
                // cannot overwrite the requested update before IPC is sent.
                const requestedPermissionMode = state.permissionMode;
                state.permissionSaving = true;
                renderSidebar();
                try {
                    const saved = await controller.updateWorkbenchSettings({
                        permissionMode: requestedPermissionMode,
                        ...(selectedSession ? { sessionId: selectedSession } : {}),
                    });
                    state.permissionMode = saved?.settings?.permissionMode === 'always-approve' ? 'always-approve' : 'ask';
                    if (selectedSession && saved?.session?.configSnapshot) {
                        const currentProjection = store.getState();
                        store.setState({
                            selectedTopic: currentProjection.selectedTopic?.topicId === selectedSession
                                ? { ...currentProjection.selectedTopic, configSnapshot: saved.session.configSnapshot }
                                : currentProjection.selectedTopic,
                            attachment: currentProjection.attachment?.sessionId === selectedSession
                                ? { ...currentProjection.attachment, configSnapshot: saved.session.configSnapshot }
                                : currentProjection.attachment,
                        });
                    }
                    notify(state.permissionMode === 'always-approve'
                        ? `本地 YOLO 已保存${selectedSession ? '，当前 Session 的下一次 Turn 起生效' : ''}。ToolBox 后端审批仍独立。`
                        : `已恢复逐次本地确认${selectedSession ? '，当前 Session 的下一次 Turn 起生效' : ''}。`, 'success');
                } finally {
                    state.permissionSaving = false;
                    renderSidebar();
                    renderHeader();
                }
            }));
            const saveModel = button(state.modelSaving ? '正在保存模型…' : '保存当前模型', 'secondary agent-chat-settings-save');
            saveModel.disabled = state.modelSaving || !selectedModel;
            saveModel.addEventListener('click', () => run(async () => {
                const requestedModel = String(state.modelDraft ?? selectedModel ?? '').trim();
                if (!requestedModel) return;
                state.modelSaving = true;
                renderSidebar();
                try {
                    const saved = await controller.updateWorkbenchSettings({
                        model: requestedModel,
                        ...(selectedSession ? { sessionId: selectedSession } : {}),
                    });
                    state.model = saved?.settings?.model || saved?.session?.configSnapshot?.model || requestedModel;
                    state.modelDraft = null;
                    notify(selectedSession
                        ? `模型已保存为 ${state.model}，从当前 Session 的下一次 Turn 起生效。`
                        : `默认模型已保存为 ${state.model}，用于新建 Session。`, 'success');
                } finally {
                    state.modelSaving = false;
                    renderSidebar();
                    renderHeader();
                }
            }));
            const save = button('用此配置新建会话', 'primary agent-chat-settings-save');
            save.addEventListener('click', openNewTopicFlow);
            settingsForm.append(permissionHint, savePermission, saveModel, budgetSection, save);
            settingsPane.append(settingsForm);
            content.append(settingsPane);
        }
        sidebar.append(tabs, content, createAccountDock(state));
        if (sidebar.scrollTop !== scrollTop) sidebar.scrollTop = scrollTop;
    }

    function renderTopicFlow() {
        topicFlowLayer.replaceChildren();
        const flow = state.topicFlow;
        topicFlowLayer.hidden = !flow;
        if (!flow) return;

        const backdrop = node('div', 'agent-chat-topic-flow-backdrop');
        const dialog = node('section', 'agent-chat-topic-flow-dialog');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'agentChatTopicFlowTitle');
        dialog.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !flow.saving) closeTopicFlow();
        });
        backdrop.addEventListener('click', () => { if (!flow.saving) closeTopicFlow(); });

        if (flow.kind === 'create') {
            const title = node('h2', 'agent-chat-topic-flow-title', '新建 Agent 会话');
            title.id = 'agentChatTopicFlowTitle';
            const description = node('p', 'agent-chat-topic-flow-description',
                '创建独立的 Codex 会话。其它 Thread 可继续运行；首次发送时才会启动此 Thread。');
            const context = node('section', 'agent-chat-topic-flow-context');
            context.setAttribute('aria-label', 'Topic 创建配置来源');
            const addContext = (label, value) => {
                const item = node('div', 'agent-chat-topic-flow-context-item');
                item.append(node('span', 'agent-chat-topic-flow-context-label', label), node('strong', 'agent-chat-topic-flow-context-value', value));
                context.append(item);
            };
            addContext('Agent', flow.agent || '尚未选择（共享 VCPChat Agent 目录）');
            addContext('模型', flow.model || '尚未选择（可输入共享模型 ID）');
            addContext('工作目录', flow.workspaceRoot || '未指定（由 Codex App Server 使用当前 workspace）');
            const form = node('form', 'agent-chat-topic-flow-form');
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                run(async () => {
                    if (!state.topicFlow || state.topicFlow.kind !== 'create') return;
                    state.topicFlow = { ...state.topicFlow, saving: true };
                    queueRender({ topicFlow: true });
                    try {
                        const created = await createTopic({
                            title: state.topicFlow.title.trim() || nextSessionTitle(),
                            agent: state.topicFlow.agent,
                        model: state.topicFlow.model.trim() || undefined,
                        workspaceRoot: state.topicFlow.workspaceRoot.trim() || undefined,
                        permissionMode: state.topicFlow.permissionMode,
                        });
                        state.topicFlow = null;
                        state.tab = 'sessions';
                        notify(`已新建 Topic「${created.title || created.topicId}」。`, 'success');
                    } finally {
                        if (state.topicFlow?.kind === 'create') state.topicFlow = { ...state.topicFlow, saving: false };
                        queueRender({ shell: true, header: true, feed: true, composer: true, topicFlow: true });
                    }
                });
            });
            const field = (label, control) => {
                const wrap = node('label', 'agent-chat-topic-flow-field');
                wrap.append(node('span', 'agent-chat-topic-flow-label', label), control);
                return wrap;
            };
            const titleInput = document.createElement('input');
            titleInput.className = 'agent-chat-topic-flow-input';
            titleInput.value = flow.title;
            titleInput.maxLength = 120;
            titleInput.setAttribute('aria-label', 'Topic 标题');
            titleInput.addEventListener('input', () => { if (state.topicFlow?.kind === 'create') state.topicFlow.title = titleInput.value; });

            const agentSelect = document.createElement('select');
            agentSelect.className = 'agent-chat-topic-flow-input';
            agentSelect.setAttribute('aria-label', 'Agent');
            const agents = state.agentCatalog.length
                ? state.agentCatalog
                : [{ id: 'Nova', name: 'Nova' }];
            for (const agent of agents) {
                const option = document.createElement('option');
                option.value = agent.id || agent.name;
                option.textContent = agent.name || agent.id;
                option.selected = option.value === flow.agent;
                agentSelect.append(option);
            }
            agentSelect.addEventListener('change', () => { if (state.topicFlow?.kind === 'create') state.topicFlow.agent = agentSelect.value; });

            const modelInput = document.createElement('input');
            modelInput.className = 'agent-chat-topic-flow-input';
            modelInput.value = flow.model;
            modelInput.setAttribute('aria-label', '模型');
            modelInput.setAttribute('list', 'agentChatTopicFlowModels');
            const modelList = document.createElement('datalist');
            modelList.id = 'agentChatTopicFlowModels';
            for (const model of state.modelCatalog) {
                const option = document.createElement('option');
                option.value = model.id || model.name || String(model);
                modelList.append(option);
            }
            modelInput.addEventListener('input', () => { if (state.topicFlow?.kind === 'create') state.topicFlow.model = modelInput.value; });

            const workspaceInput = document.createElement('input');
            workspaceInput.className = 'agent-chat-topic-flow-input';
            workspaceInput.value = flow.workspaceRoot;
            workspaceInput.placeholder = '留空使用 VCPChat 当前工作目录';
            workspaceInput.setAttribute('aria-label', '工作目录');
            workspaceInput.addEventListener('input', () => { if (state.topicFlow?.kind === 'create') state.topicFlow.workspaceRoot = workspaceInput.value; });

            const permissionSelect = document.createElement('select');
            permissionSelect.className = 'agent-chat-topic-flow-input';
            permissionSelect.setAttribute('aria-label', '本地工具审批');
            for (const optionValue of [
                ['ask', '每次确认（推荐）'],
                ['always-approve', 'YOLO：本地自动允许'],
            ]) {
                const option = document.createElement('option');
                option.value = optionValue[0];
                option.textContent = optionValue[1];
                option.selected = option.value === flow.permissionMode;
                permissionSelect.append(option);
            }
            permissionSelect.addEventListener('change', () => {
                if (state.topicFlow?.kind === 'create') state.topicFlow.permissionMode = permissionSelect.value;
            });

            const actions = node('div', 'agent-chat-topic-flow-actions');
            const cancel = button('取消', 'secondary');
            cancel.disabled = flow.saving;
            cancel.addEventListener('click', closeTopicFlow);
            const submit = button(flow.saving ? '正在创建…' : '创建并打开', 'primary');
            submit.type = 'submit';
            submit.disabled = flow.saving || !flow.agent;
            actions.append(cancel, submit);
            form.append(
                field('Topic 标题', titleInput),
                field('共享 Agent', agentSelect),
                field('共享模型', modelInput),
                modelList,
                field('工作目录', workspaceInput),
                field('本地工具审批', permissionSelect),
                node('p', 'agent-chat-topic-flow-description', 'YOLO 只跳过本地确认；VCPToolBox 后端审批仍会独立执行。'),
                actions,
            );
            dialog.append(title, description, context, form);
        }
        topicFlowLayer.append(backdrop, dialog);
        // A microtask avoids stealing the click that opened the dialog while
        // still providing predictable keyboard focus for the next action.
        queueMicrotask(() => dialog.focus());
    }

    function renderTopicConflict() {
        topicConflictLayer.replaceChildren();
        const conflict = state.topicConflict;
        topicConflictLayer.hidden = !conflict;
        if (!conflict) return;

        const { topic } = conflict;
        const dialog = node('section', 'agent-chat-topic-conflict-dialog');
        dialog.setAttribute('role', 'alert');
        dialog.setAttribute('aria-labelledby', 'agentChatTopicConflictTitle');

        const heading = node('div', 'agent-chat-topic-conflict-heading');
        const icon = node('span', 'vcp-ui-icon agent-chat-topic-conflict-icon', 'sync_problem');
        const title = node('h2', 'agent-chat-topic-conflict-title', '会话正在其他位置使用');
        title.id = 'agentChatTopicConflictTitle';
        heading.append(icon, title);
        const description = node('p', 'agent-chat-topic-conflict-description',
            conflict.takingOver
                ? '正在安全接管，等待另一处会话释放。'
                : `“${topic.title || topic.id}”正在另一处运行。`);
        const actions = node('div', 'agent-chat-topic-conflict-actions');
        const cancel = button('暂不接管', 'secondary');
        cancel.disabled = conflict.takingOver;
        cancel.addEventListener('click', closeTopicConflict);
        const takeover = button(conflict.takingOver ? '正在接管…' : '接管并继续', 'primary');
        takeover.disabled = conflict.takingOver;
        takeover.addEventListener('click', () => run(async () => {
            state.topicConflict = { ...conflict, takingOver: true, error: null };
            queueRender({ conflict: true });
            try {
                if (await requestTopicTakeover(topic)) state.topicConflict = null;
            } catch (error) {
                if (state.topicConflict?.topic?.id === topic.id) {
                    state.topicConflict = { ...state.topicConflict, takingOver: false, error: error?.message || String(error) };
                }
                throw error;
            } finally {
                queueRender({ conflict: true });
            }
        }));
        actions.append(cancel, takeover);
        dialog.append(heading, description);
        if (conflict.error) dialog.append(node('p', 'agent-chat-topic-conflict-error', conflict.error));
        dialog.append(actions);
        topicConflictLayer.append(dialog);
    }

    function renderHeader() {
        syncPermissionModeFromSelectedSession();
        header.replaceChildren();
        const session = activeSession();
        const current = store.getState();
        const viewState = deriveWorkbenchViewState(current);
        const isCodexRuntime = current.runtime?.runtime === 'codex-app-server';
        // `attachment` may continue a different Agent's background turn while
        // the user reads a Rust snapshot here. Never let that hidden writer
        // label masquerade as the selected Topic/Agent.
        const selected = current.selectedTopic;
        const selectedIsAttachment = selected?.topicId && selected.topicId === session?.topicId;
        const headingTitle = selected?.title
            || (selectedIsAttachment ? session?.title : '')
            || `与 ${selected?.agentId || state.selectedAgent || 'Nova'} 聊天中`;
        const left = node('h3', 'agent-chat-title', headingTitle);
        // R3 fixed lifecycle state chip — single source of truth for the
        // Workbench's connection/execution phase, surfaced in the header.
        const statusChip = node('span', 'agent-chat-status-chip', WORKBENCH_VIEW_STATE_LABELS[viewState] || viewState);
        statusChip.dataset.state = viewState;
        statusChip.setAttribute('role', 'status');
        statusChip.setAttribute('aria-live', 'polite');
        if (viewState === 'error') {
            statusChip.setAttribute('role', 'button');
            statusChip.tabIndex = 0;
            statusChip.title = '点击重新连接';
            const reconnect = () => run(recoverDaemon);
            statusChip.addEventListener('click', reconnect);
            statusChip.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                reconnect();
            });
        } else {
            statusChip.title = '当前运行状态';
        }
        const actions = node('div', 'chat-actions agent-chat-header-actions');
        // R3 header action cluster: every button is a uniform ghost-muted icon
        // button (opencode icon-button-v2 / Cherry NavbarIcon spec) so the
        // title | status chip | actions row stays aligned regardless of source.
        const pendingApprovals = (store.getState().approvals || []).length;
        const alertState = viewState === 'error' || viewState === 'reconnecting';
        const activityBtn = iconButton('notifications', state.activityOpen ? '关闭活动面板' : '打开活动面板', 'agent-chat-header-activity');
        activityBtn.classList.toggle('is-active', state.activityOpen);
        activityBtn.setAttribute('aria-expanded', String(state.activityOpen));
        activityBtn.setAttribute('aria-controls', 'agentChatActivityPanel');
        if (pendingApprovals) {
            activityBtn.append(node('span', 'agent-chat-action-badge', String(pendingApprovals)));
        } else if (Number(current.activityUnread) > 0) {
            activityBtn.append(node('span', 'agent-chat-action-badge', String(Math.min(99, Number(current.activityUnread)))));
        } else if (alertState) {
            activityBtn.append(node('span', 'agent-chat-action-badge is-warning', '!'));
        }
        activityBtn.addEventListener('click', () => setActivityOpen(!state.activityOpen));
        const queueButton = isCodexRuntime ? null : iconButton('queue_play_next', state.queue.length ? `后续指令（${state.queue.length}）` : '后续指令', 'agent-chat-queue-toggle');
        if (queueButton) {
            queueButton.setAttribute('aria-expanded', String(state.queueOpen));
            queueButton.addEventListener('click', () => {
                state.queueOpen = !state.queueOpen;
                renderHeader();
            });
        }
        const usage = store.getState().context;
        const contextPct = Number.isFinite(Number(usage.percentage)) ? Math.max(0, Math.min(100, Number(usage.percentage))) : 0;
        const usageButton = button('', 'agent-chat-usage-toggle agent-chat-context-toggle');
        const contextRing = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        contextRing.classList.add('agent-chat-context-ring');
        contextRing.setAttribute('viewBox', '0 0 36 36');
        contextRing.setAttribute('aria-hidden', 'true');
        const ringTrack = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ringTrack.classList.add('agent-chat-context-ring-track');
        ringTrack.setAttribute('cx', '18'); ringTrack.setAttribute('cy', '18'); ringTrack.setAttribute('r', '15.5');
        const ringValue = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ringValue.classList.add('agent-chat-context-ring-value');
        ringValue.setAttribute('cx', '18'); ringValue.setAttribute('cy', '18'); ringValue.setAttribute('r', '15.5');
        ringValue.setAttribute('pathLength', '100');
        ringValue.setAttribute('stroke-dasharray', `${contextPct} 100`);
        const ringText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        ringText.classList.add('agent-chat-context-ring-core');
        ringText.setAttribute('x', '18'); ringText.setAttribute('y', '21'); ringText.setAttribute('text-anchor', 'middle');
        ringText.textContent = contextPct ? String(Math.round(contextPct)) : '';
        contextRing.append(ringTrack, ringValue, ringText);
        usageButton.append(contextRing);
        usageButton.title = usage.contextWindow
            ? `上下文 ${contextPct}% · ${Number(usage.usedTokens || 0).toLocaleString('zh-CN')} / ${Number(usage.contextWindow).toLocaleString('zh-CN')} tokens`
            : '查看上下文、用量与会话信息';
        usageButton.setAttribute('aria-label', usageButton.title);
        const usageExpanded = state.activityOpen && state.activityTab === 'usage';
        usageButton.classList.toggle('is-active', usageExpanded);
        usageButton.setAttribute('aria-expanded', String(usageExpanded));
        usageButton.addEventListener('click', () => {
            if (state.activityOpen && state.activityTab === 'usage') setActivityOpen(false);
            else setActivityOpen(true, 'usage');
        });
        const compact = iconButton('compress', usage.compacting ? '正在安全压缩上下文' : '压缩当前 Agent 上下文', 'agent-chat-compact');
        if (compact) {
            compact.disabled = !session || Boolean(usage.compacting);
            compact.addEventListener('click', () => run(async () => {
                if (!session) return;
                const result = await controller.compactSession(session.sessionId);
                const before = Number(result?.compaction?.beforeTokens || 0);
                const after = Number(result?.compaction?.afterTokens || 0);
                notify(before && after ? `上下文已完成压缩：${before} -> ${after} tokens。` : '上下文已完成压缩并刷新会话历史。', 'success');
            }));
        }
        actions.append(activityBtn, ...(queueButton ? [queueButton] : []), usageButton, ...(compact ? [compact] : []));
        header.append(left, statusChip, actions);
        if (!state.queueOpen) return;
        const panel = node('section', 'agent-chat-queue-popover');
        const title = node('div', 'agent-chat-queue-heading');
        title.append(node('strong', '', '后续指令队列'));
        const clear = button('清空', 'agent-chat-queue-clear');
        clear.disabled = !state.queue.length;
        clear.addEventListener('click', () => run(async () => {
            await controller.clearInteractionQueue();
            await refreshControlPlane();
            notify('已清空后续指令队列。', 'success');
        }));
        title.append(clear);
        panel.append(title);
        if (!state.queue.length) {
            panel.append(node('p', 'agent-chat-muted', '没有排队的 steering / follow-up。'));
        } else {
            const list = node('ol', 'agent-chat-queue-list');
            for (const item of state.queue) {
                const kind = typeof item === 'object' ? item.kind : 'follow-up';
                const prompt = typeof item === 'string' ? item : item.prompt || item.text || JSON.stringify(item);
                const interactionId = typeof item === 'object' ? item.interactionId : '';
                const row = node('li', 'agent-chat-queue-item');
                row.append(node('span', 'agent-chat-queue-kind', kind === 'steer' ? '即时指导' : '后续指令'), node('span', 'agent-chat-queue-prompt', prompt));
                const itemActions = node('div', 'agent-chat-queue-item-actions');
                const edit = button('编辑');
                const remove = button('移除', 'danger');
                const canEdit = Boolean(interactionId && (kind === 'steer' || kind === 'follow-up'));
                edit.disabled = !canEdit;
                remove.disabled = !canEdit;
                edit.addEventListener('click', () => {
                    const nextPrompt = window.prompt?.('编辑后续指令', prompt);
                    if (nextPrompt === null || nextPrompt === undefined || nextPrompt.trim() === prompt.trim()) return;
                    run(async () => {
                        const interactions = state.queue.map((candidate) => candidate?.interactionId === interactionId
                            ? { ...candidate, prompt: nextPrompt.trim() }
                            : candidate);
                        await controller.replaceInteractionQueue(interactions);
                        await refreshControlPlane();
                        notify('后续指令已更新。', 'success');
                    });
                });
                remove.addEventListener('click', () => run(async () => {
                    const interactions = state.queue.filter((candidate) => candidate?.interactionId !== interactionId);
                    await controller.replaceInteractionQueue(interactions);
                    await refreshControlPlane();
                    notify('后续指令已移除。', 'success');
                }));
                itemActions.append(edit, remove);
                row.append(itemActions);
                list.append(row);
            }
            panel.append(list);
        }
        header.append(panel);
    }

    function renderFeed() {
        // Preserve a reader's position during control updates.  The daemon is
        // the ordering authority; this renderer only reconciles keyed rows.
        const follow = isFollowingContainer(feed);
        const current = store.getState();
        const clearEmpty = () => {
            state.timelineEmpty?.remove();
            state.timelineEmpty = null;
        };
        const showEmpty = (text) => {
            reconcileAgentTimeline(feedItems, [], {}, state.timelineRows);
            if (!state.timelineEmpty) {
                state.timelineEmpty = node('div', 'agent-chat-empty-conversation');
                feedItems.append(state.timelineEmpty);
            }
            state.timelineEmpty.textContent = text;
        };
        if (!current.attachment?.sessionId && !current.selectedTopic?.topicId) {
            showEmpty('创建一个 Agent 会话，即可开始与 VCPToolBox 协作。');
            return;
        }
        const timeline = createAgentTimelineParts(current);
        if (state.turnStart) {
            const selectedTopicId = current.selectedTopic?.topicId || current.attachment?.topicId || null;
            const alreadyHasAssistant = state.turnStart.turnId && current.messages.some((message) => (
                message.role === 'assistant' && message.turnId === state.turnStart.turnId
            ));
            if (selectedTopicId && state.turnStart.topicId === selectedTopicId && !alreadyHasAssistant) {
                const presentationId = `turn-start:${selectedTopicId}`;
                timeline.push({
                    kind: 'message',
                    id: presentationId,
                    presentationKey: presentationId,
                    turnId: state.turnStart.turnId || null,
                    value: {
                        id: presentationId,
                        role: 'assistant',
                        state: 'streaming',
                        content: state.turnStart.phase === 'starting' ? '正在启动 Agent…' : '思考中',
                        presentationRole: 'turn-start',
                        presentationKey: presentationId,
                        presentationPhase: state.turnStart.phase,
                        createdAt: state.turnStart.createdAt || Date.now(),
                    },
                });
            }
        }
        if (!timeline.length && !state.turnStart) {
            showEmpty('会话已就绪，发送第一条消息开始。');
            return;
        }
        clearEmpty();
        const callbacks = state.presentationMode === 'legacy'
            ? legacyTimelineCallbacks
            : fullPresentation.timelineCallbacks;
        reconcileAgentTimeline(feedItems, timeline, callbacks, state.timelineRows);

        scrollFeed(feed, follow);
    }

    function renderJumpToLatest() {
        const count = Math.min(99, state.unreadTimelineCount || 0);
        const visible = !state.followingFeed && count > 0;
        jumpToLatest.hidden = !visible;
        if (!visible) return;
        const suffix = count > 1 ? `（${count} 条新动态）` : '（有新动态）';
        jumpToLatest.textContent = `回到最新${suffix}`;
        jumpToLatest.setAttribute('aria-label', `回到最新消息${suffix}`);
    }

    function noteTimelineActivity() {
        if (isFollowingContainer(feed)) {
            state.followingFeed = true;
            state.unreadTimelineCount = 0;
        } else {
            state.followingFeed = false;
            state.unreadTimelineCount = Math.min(99, (state.unreadTimelineCount || 0) + 1);
        }
        renderJumpToLatest();
    }

    function setActivityOpen(open, tab) {
        if (open && tab) state.activityTab = tab;
        state.activityOpen = open;
        if (open) clearActivityUnread(state.activityTab);
        if (open) {
            activityPanel.classList.add('agent-chat-activity-open');
            activityPanel.classList.remove('agent-chat-activity-collapsed');
            activityPanel.removeAttribute('inert');
            activityPanel.setAttribute('aria-hidden', 'false');
        } else {
            activityPanel.classList.remove('agent-chat-activity-open');
            activityPanel.classList.add('agent-chat-activity-collapsed');
            activityPanel.setAttribute('inert', '');
            activityPanel.setAttribute('aria-hidden', 'true');
        }
        queueRender({ activity: true, header: true });
    }

    function clearActivityUnread(tab) {
        const current = store.getState();
        const byTab = { ...(current.activityUnreadByTab || {}) };
        if (!byTab[tab]) return;
        byTab[tab] = 0;
        store.setState({
            activityUnreadByTab: byTab,
            activityUnread: Object.values(byTab).reduce((sum, value) => sum + Number(value || 0), 0),
        });
    }

    // Surface the activity panel automatically on state transitions the user
    // must notice: a daemon error, or the first pending approval arriving.
    // Rust Host remains responsible for fail-closed expiry even while this
    // panel is collapsed; the renderer ticker only refreshes visible labels.
    function maybeAutoOpenActivity() {
        const current = store.getState();
        const viewState = deriveWorkbenchViewState(current);
        const approvalsCount = (current.approvals || []).length;
        if (approvalsCount > 0 && !state.hadApprovals && !state.activityOpen) {
            setActivityOpen(true, 'approvals');
        }
        state.lastViewState = viewState;
        state.hadApprovals = approvalsCount > 0;
    }

    function buildConnectionPanel(current, viewState) {
        const wrap = node('div', 'agent-chat-activity-connection');
        const stateMap = {
            idle: { icon: 'check_circle', tone: 'success', title: '连接正常' },
            running: { icon: 'check_circle', tone: 'success', title: '运行中' },
            starting: { icon: 'pending', tone: 'warning', title: '正在启动' },
            'awaiting-approval': { icon: 'pending', tone: 'warning', title: '等待审批' },
            reconnecting: { icon: 'sync', tone: 'warning', title: '正在重新连接' },
            disconnected: { icon: 'cloud_off', tone: 'muted', title: '未连接' },
            error: { icon: 'error', tone: 'danger', title: '连接错误' },
        };
        const stateInfo = stateMap[viewState] || stateMap.disconnected;
        const card = node('div', `agent-chat-connection-card agent-chat-connection-${stateInfo.tone}`);
        const status = node('div', 'agent-chat-connection-status');
        status.append(...icon(stateInfo.icon), node('span', '', stateInfo.title));
        card.append(status);
        if (viewState === 'error') {
            const runtime = current.runtime || {};
            const rawError = typeof runtime.lastError === 'object' ? runtime.lastError?.error : runtime.lastError;
            const message = String(rawError || 'Codex App Server 已中断').slice(0, 280);
            card.append(node('p', 'agent-chat-connection-message', message));
            const reconnect = button('重新连接', 'primary agent-chat-connection-reconnect');
            reconnect.addEventListener('click', () => run(recoverDaemon));
            card.append(reconnect);
        } else if (viewState === 'reconnecting') {
            card.append(node('p', 'agent-chat-connection-message', '正在重新连接 Codex App Server，并从 Projection SQLite 对账会话展示…'));
        } else {
            card.append(node('p', 'agent-chat-connection-message', WORKBENCH_VIEW_STATE_LABELS[viewState] || viewState));
        }
        wrap.append(card);
        const readiness = current.readiness || {};
        const readinessGrid = node('section', 'agent-chat-readiness-grid');
        readinessGrid.setAttribute('aria-label', 'Codex Agent readiness');
        const readinessEntries = [
            ['server', 'Codex App Server'],
            ['profile', 'Projection SQLite / Agent 配置'],
            ['toolbox', 'VCPToolBox Bridge'],
            ['capability', 'VCPToolBox 动态能力'],
        ];
        const readinessState = {
            ready: { icon: 'check_circle', label: '就绪', tone: 'success' },
            configured: { icon: 'settings', label: '已配置', tone: 'success' },
            checking: { icon: 'pending', label: '检查中', tone: 'warning' },
            unknown: { icon: 'help', label: '未知', tone: 'muted' },
            unavailable: { icon: 'cloud_off', label: '不可用', tone: 'danger' },
            missing: { icon: 'error', label: '缺少配置', tone: 'danger' },
        };
        for (const [key, label] of readinessEntries) {
            const item = readiness[key] || { state: 'unknown', detail: '等待 Agent Runtime 状态事件' };
            const info = readinessState[item.state] || readinessState.unknown;
            const readinessCard = node('article', `agent-chat-readiness-card agent-chat-readiness-${info.tone}`);
            readinessCard.dataset.readiness = key;
            const heading = node('div', 'agent-chat-readiness-heading');
            heading.append(...icon(info.icon), node('span', '', label), node('span', 'agent-chat-readiness-state', info.label));
            const detail = node('p', 'agent-chat-readiness-detail', String(item.detail || '—'));
            readinessCard.append(heading, detail);
            readinessGrid.append(readinessCard);
        }
        wrap.append(readinessGrid);
        return wrap;
    }

    function buildUsagePanel(current) {
        const wrap = node('div', 'agent-chat-activity-usage');
        const usage = current.context || {};
        const format = (value) => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
        const placeholder = '—';
        const hasUsage = usage.usageAvailable === true;
        const usageSourceLabel = usage.source === 'real' ? '模型实际返回'
            : usage.source === 'estimated' ? '估算（ToolBox 未返回真实 usage）'
                : '未知（未报告 usage）';
        const messages = current.messages || [];
        const selected = current.selectedTopic || current.attachment || {};
        const snapshot = selected.configSnapshot || current.attachment?.configSnapshot || {};
        const prompt = snapshot.baseInstructions || snapshot.developerInstructions || '';
        const userCount = messages.filter((message) => message.role === 'user').length;
        const assistantCount = messages.filter((message) => message.role === 'assistant').length;
        const timestamps = messages.map((message) => Number(message.createdAt || message.timestamp)).filter(Number.isFinite);
        const formatTimeValue = (value) => value ? new Intl.DateTimeFormat('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }).format(new Date(value)) : placeholder;
        const total = hasUsage ? (usage.totalTokens ?? usage.usedTokens) : null;
        const totalText = total != null ? format(total) : placeholder;
        const contextPct = usage.contextWindow ? usage.percentage : null;

        const summary = node('div', 'agent-chat-usage-summary');
        const totalChip = node('div', 'agent-chat-usage-metric');
        totalChip.append(node('span', 'agent-chat-usage-label', 'Tokens'), node('span', 'agent-chat-usage-value', totalText));
        if (contextPct != null) totalChip.append(node('span', 'agent-chat-usage-pill', `${contextPct}%`));
        summary.append(totalChip);

        const costChip = node('div', 'agent-chat-usage-metric');
        costChip.append(node('span', 'agent-chat-usage-label', '费用'), node('span', 'agent-chat-usage-value', '不可用'));
        summary.append(costChip);
        wrap.append(summary);

        const identity = node('dl', 'agent-chat-context-stats');
        const identityStat = (label, value) => {
            const row = node('div', 'agent-chat-context-stat');
            row.append(node('dt', '', label), node('dd', '', value || placeholder));
            identity.append(row);
        };
        identityStat('会话', selected.title || selected.topicId || current.attachment?.sessionId);
        identityStat('Provider', usage.provider);
        identityStat('模型', usage.model || selected.model || snapshot.model);
        identityStat('消息', `${messages.length}（用户 ${userCount} / 助手 ${assistantCount}）`);
        identityStat('创建时间', formatTimeValue(timestamps.length ? Math.min(...timestamps) : null));
        identityStat('最后活动', formatTimeValue(timestamps.length ? Math.max(...timestamps) : null));
        wrap.append(identity);

        if (usage.compactionState) {
            const text = usage.compactionState === 'started' ? '正在等待 Codex 上下文压缩的终态事件…'
                : usage.compactionState === 'completed' ? (usage.summary || '上下文压缩已完成，已从 Thread 对账恢复。')
                    : usage.compactionError || '上下文压缩失败。';
            const status = node('p', `agent-chat-usage-note agent-chat-compaction-${usage.compactionState}`, text);
            status.setAttribute('role', 'status');
            wrap.append(status);
        }

        if (usage.contextWindow) {
            const context = node('div', 'agent-chat-usage-context');
            const bar = node('div', 'agent-chat-usage-context-bar');
            const fill = document.createElement('progress');
            fill.className = 'agent-chat-usage-context-fill';
            fill.max = 100;
            fill.value = Math.min(100, Math.max(0, usage.percentage || 0));
            fill.setAttribute('aria-label', '上下文使用率');
            bar.append(fill);
            context.append(bar, node('span', 'agent-chat-usage-context-label', `${format(usage.usedTokens)} / ${format(usage.contextWindow)} tokens`));
            wrap.append(context);
        }

        const stats = node('ul', 'agent-chat-usage-stats');
        const stat = (label, value) => {
            const li = node('li');
            li.append(node('span', 'agent-chat-usage-label', label), node('span', 'agent-chat-usage-value', value != null ? format(value) : placeholder));
            stats.append(li);
        };
        stat('输入', hasUsage ? usage.inputTokens : null);
        stat('输出', hasUsage ? usage.outputTokens : null);
        stat('推理', hasUsage ? usage.reasoningTokens : null);
        stat('缓存读取', hasUsage ? usage.cacheReadTokens : null);
        stat('缓存写入', hasUsage ? usage.cacheWriteTokens : null);
        wrap.append(stats);

        const identityLabel = [usage.model, usage.provider].filter(Boolean).join(' · ');
        wrap.append(node('p', 'agent-chat-usage-note', `${usageSourceLabel}${identityLabel ? `；${identityLabel}` : ''}。此处是最近一次可靠报告，不伪装为 Session 累计费用。`));

        if (usage.inputTokens && messages.length) {
            const charCount = (value) => typeof value === 'string' ? value.length : JSON.stringify(value || '').length;
            const raw = {
                system: charCount(prompt),
                user: messages.filter((message) => message.role === 'user').reduce((sum, message) => sum + charCount(message.content || message.blocks), 0),
                assistant: messages.filter((message) => message.role === 'assistant').reduce((sum, message) => sum + charCount(message.content || message.blocks), 0),
                tool: [...(current.tools instanceof Map ? current.tools.values() : [])].reduce((sum, tool) => sum + charCount(tool.payload), 0),
            };
            const estimated = Object.fromEntries(Object.entries(raw).map(([key, chars]) => [key, Math.ceil(chars / 4)]));
            const known = Object.values(estimated).reduce((sum, value) => sum + value, 0);
            estimated.other = Math.max(0, Number(usage.inputTokens) - known);
            const denominator = Math.max(1, Object.values(estimated).reduce((sum, value) => sum + value, 0));
            const breakdown = node('section', 'agent-chat-context-breakdown');
            breakdown.append(node('strong', 'agent-chat-context-section-title', '上下文构成（估算）'));
            const bar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            bar.classList.add('agent-chat-context-breakdown-bar');
            bar.setAttribute('viewBox', '0 0 100 8');
            bar.setAttribute('preserveAspectRatio', 'none');
            const legend = node('div', 'agent-chat-context-breakdown-legend');
            let offset = 0;
            for (const [key, label] of [['system', '系统'], ['user', '用户'], ['assistant', '助手'], ['tool', '工具'], ['other', '其他']]) {
                const value = estimated[key] || 0;
                if (!value) continue;
                const pct = Math.round((value / denominator) * 1000) / 10;
                const segment = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                segment.classList.add('agent-chat-context-segment', `is-${key}`);
                segment.setAttribute('x', String(offset)); segment.setAttribute('y', '0');
                segment.setAttribute('width', String(pct)); segment.setAttribute('height', '8');
                segment.setAttribute('aria-label', `${label} ${pct}%`);
                bar.append(segment);
                offset += pct;
                const item = node('span', `agent-chat-context-legend-item is-${key}`);
                item.append(node('i'), document.createTextNode(`${label} ${pct}%`));
                legend.append(item);
            }
            breakdown.append(bar, legend, node('p', 'agent-chat-usage-note', '构成仅根据 VChat 可见消息和工具投影估算，不代表模型服务端精确计费。'));
            wrap.append(breakdown);
        }

        if (prompt) {
            const promptDetails = node('details', 'agent-chat-context-prompt');
            promptDetails.append(node('summary', 'agent-chat-context-section-title', '实际注入的 Agent 指令'),
                node('pre', 'agent-chat-toolbox-ws-output', String(prompt).slice(0, 32_768)));
            wrap.append(promptDetails);
        }

        return wrap;
    }

    function buildPlanInspector(current) {
        const wrap = node('section', 'agent-chat-activity-usage agent-chat-inspector-plan');
        const plan = current.plan;
        wrap.append(node('strong', '', '最新计划'));
        if (!plan?.text) {
            wrap.append(node('p', 'agent-chat-muted', '当前会话尚未收到 Codex Plan Item。'));
            return wrap;
        }
        const content = node('pre', 'agent-chat-toolbox-ws-output', String(plan.text).slice(0, 16_384));
        content.hidden = false;
        wrap.append(content);
        return wrap;
    }

    function buildChangeInspector(current) {
        const wrap = node('section', 'agent-chat-activity-usage agent-chat-inspector-changes');
        const changes = [...(current.tools instanceof Map ? current.tools.values() : [])]
            .flatMap((tool) => Array.isArray(tool?.payload?.changes?.files) ? tool.payload.changes.files : []);
        wrap.append(node('strong', '', 'Codex 文件变化（只读）'));
        if (!changes.length) {
            wrap.append(node('p', 'agent-chat-muted', '当前会话尚未收到 Codex fileChange Item。'));
            return wrap;
        }
        for (const change of changes.slice(0, 16)) {
            const item = node('details', 'agent-chat-toolbox-ws-card agent-chat-diff-file');
            item.dataset.activityKey = `diff:${change.path || 'unknown'}:${change.status || 'modified'}`;
            const summary = node('summary', 'agent-chat-toolbox-ws-title', `${change.status || 'modified'} · ${change.path || 'unknown'}`);
            summary.append(node('span', 'agent-chat-toolbox-ws-channel', `+${Number(change.additions) || 0} −${Number(change.deletions) || 0}`));
            const patch = node('pre', 'agent-chat-toolbox-ws-output', String(change.patch || '').slice(0, 131_072));
            patch.hidden = false;
            item.append(summary, patch);
            wrap.append(item);
        }
        return wrap;
    }

    function buildInteractionCard(interaction) {
        const payload = interaction.payload || {};
        const card = node('section', 'agent-chat-toolbox-ws-card agent-chat-interaction-card');
        card.dataset.interactionSource = String(interaction.source || 'unknown');
        card.dataset.interactionState = String(interaction.state || 'pending');
        card.dataset.interactionId = String(interaction.requestId || '');
        const labels = {
            'user-input': 'Codex 需要你的输入',
            permission: 'Codex 请求额外权限',
            'mcp-elicitation': 'MCP 请求用户交互',
        };
        card.append(node('strong', 'agent-chat-toolbox-ws-title', labels[interaction.kind] || `受限交互 · ${interaction.kind || 'unknown'}`));
        card.append(node('p', 'agent-chat-toolbox-ws-detail', [payload.header, payload.message, payload.reason]
            .filter(Boolean).join(' · ') || `${interaction.source || 'unknown'} / ${interaction.requestId || 'unknown'}`));
        if (interaction.expiresAtMs) {
            approvalRegistry.set(interaction.requestId, { deadline: interaction.expiresAtMs, expired: false });
            const countdown = node('p', 'agent-chat-approval-countdown', '超时后安全取消');
            card.dataset.approvalId = interaction.requestId;
            card.append(countdown);
            ensureApprovalTicker();
        }

        if (interaction.kind === 'user-input') {
            const form = node('form', 'agent-chat-interaction-form');
            for (const question of (payload.questions || []).slice(0, 16)) {
                const fieldset = node('fieldset', 'agent-chat-interaction-fieldset');
                fieldset.dataset.questionId = String(question.id || '');
                fieldset.append(node('legend', '', question.header || question.question || '需要输入'));
                if (question.question && question.question !== question.header) fieldset.append(node('p', 'agent-chat-muted', question.question));
                const options = Array.isArray(question.options) ? question.options : [];
                for (const [index, option] of options.entries()) {
                    const label = node('label', 'agent-chat-interaction-option');
                    const input = document.createElement('input');
                    input.type = 'radio';
                    input.name = `question:${question.id}`;
                    input.value = String(option.label || '');
                    if (index === 0) input.required = !question.isOther;
                    label.append(input, node('span', '', option.label || '选项'));
                    if (option.description) label.append(node('small', '', option.description));
                    fieldset.append(label);
                }
                if (!options.length || question.isOther) {
                    const input = document.createElement(options.length || question.isSecret ? 'input' : 'textarea');
                    input.name = `other:${question.id}`;
                    if (input.tagName === 'INPUT') input.type = question.isSecret ? 'password' : 'text';
                    if (input.tagName === 'TEXTAREA') input.rows = 3;
                    input.autocomplete = question.isSecret ? 'off' : 'on';
                    input.placeholder = options.length ? '其他答案' : '输入回答';
                    fieldset.append(input);
                }
                form.append(fieldset);
            }
            const actions = node('div', 'agent-chat-approval-actions');
            const cancel = button('取消', 'secondary');
            cancel.type = 'button';
            cancel.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { answers: {} })));
            const submit = button('提交回答', 'primary');
            submit.type = 'submit';
            actions.append(cancel, submit);
            form.append(actions);
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                const answers = {};
                for (const question of (payload.questions || []).slice(0, 16)) {
                    const selected = form.querySelector(`input[name="question:${cssEscape(question.id)}"]:checked`)?.value;
                    const other = form.querySelector(`[name="other:${cssEscape(question.id)}"]`)?.value?.trim();
                    const answer = other || selected;
                    if (answer) answers[question.id] = { answers: [answer] };
                }
                run(() => controller.respondInteraction(interaction, { answers }));
            });
            card.append(form);
            return card;
        }

        if (interaction.kind === 'permission') {
            card.append(node('p', 'agent-chat-approval-binding-value', `工作目录：${payload.cwd || '未知'}`));
            card.append(node('pre', 'agent-chat-approval-args', JSON.stringify(payload.permissions || {}, null, 2).slice(0, 16_384)));
            const scope = document.createElement('select');
            scope.setAttribute('aria-label', '授权范围');
            for (const [value, label] of [['turn', '仅当前 Turn'], ['session', '当前 Session']]) {
                const option = document.createElement('option'); option.value = value; option.textContent = label; scope.append(option);
            }
            const actions = node('div', 'agent-chat-approval-actions');
            const deny = button('拒绝', 'danger');
            const accept = button('按请求授权', 'secondary');
            deny.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { decision: 'decline' })));
            accept.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { decision: 'accept', scope: scope.value })));
            actions.append(scope, deny, accept);
            card.append(actions);
            return card;
        }

        if (interaction.kind === 'mcp-elicitation') {
            const mode = payload.mode || 'form';
            const schema = payload.requestedSchema || {};
            if (mode === 'url') {
                const url = String(payload.url || '');
                card.append(node('p', 'agent-chat-toolbox-ws-detail', url));
                const open = button('在系统浏览器打开', 'secondary');
                open.disabled = !/^https?:\/\//i.test(url);
                open.addEventListener('click', () => runtimeApi().sendOpenExternalLink?.(url));
                card.append(open);
            }
            const form = node('form', 'agent-chat-interaction-form');
            if (mode !== 'url') {
                const properties = Object.entries(schema.properties || {}).slice(0, 64);
                for (const [key, definition] of properties) {
                    const field = node('label', 'agent-chat-interaction-field');
                    field.append(node('span', '', definition.title || key));
                    let input;
                    if (Array.isArray(definition.enum)) {
                        input = document.createElement('select');
                        for (const value of definition.enum) {
                            const option = document.createElement('option'); option.value = value; option.textContent = value; input.append(option);
                        }
                    } else {
                        input = document.createElement('input');
                        input.type = definition.format === 'password' ? 'password'
                            : definition.type === 'boolean' ? 'checkbox'
                                : ['number', 'integer'].includes(definition.type) ? 'number' : 'text';
                    }
                    input.name = key;
                    if ((schema.required || []).includes(key)) input.required = true;
                    field.append(input);
                    form.append(field);
                }
                if (!properties.length) {
                    const rawField = node('label', 'agent-chat-interaction-field');
                    rawField.append(node('span', '', '结构化响应（JSON）'));
                    const raw = document.createElement('textarea');
                    raw.name = '__json';
                    raw.rows = 6;
                    raw.placeholder = '{}';
                    rawField.append(raw);
                    form.append(rawField);
                }
            }
            const actions = node('div', 'agent-chat-approval-actions');
            const cancel = button('取消', 'danger');
            cancel.type = 'button';
            cancel.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { action: 'cancel' })));
            const decline = button('拒绝', 'secondary');
            decline.type = 'button';
            decline.addEventListener('click', () => run(() => controller.respondInteraction(interaction, { action: 'decline' })));
            const accept = button('接受', 'primary');
            accept.type = 'submit';
            actions.append(cancel, decline, accept);
            form.append(actions);
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                const content = {};
                for (const control of form.elements) {
                    if (!control.name) continue;
                    if (control.name === '__json') {
                        try { Object.assign(content, JSON.parse(control.value || '{}')); }
                        catch { notify('MCP 表单 JSON 无效。', 'error'); return; }
                        continue;
                    }
                    content[control.name] = control.type === 'checkbox' ? control.checked
                        : control.type === 'number' ? Number(control.value) : control.value;
                }
                run(() => controller.respondInteraction(interaction, { action: 'accept', content }));
            });
            card.append(form);
            return card;
        }

        card.append(node('p', 'agent-chat-muted', '该交互类型没有可用响应控件，保持 fail-closed。'));
        return card;
    }

    function renderActivity() {
        if (state.disposed) return;
        const current = store.getState();
        const previousContent = state.activityTabPanels.get(state.activityTab);
        const previousScrollTarget = state.activityTab === 'activity'
            ? previousContent?.querySelector('.agent-chat-activity-list')
            : previousContent;
        const scrollTop = previousScrollTarget?.scrollTop || 0;
        const searchFocused = document.activeElement?.matches?.('.agent-chat-activity-filters input[type="search"]');
        const searchSelection = searchFocused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
        const existingInteractions = new Map([...activityPanel.querySelectorAll('.agent-chat-interaction-card[data-interaction-id]')]
            .map((item) => [item.dataset.interactionId, item]));
        const existingActivityCards = new Map([...activityPanel.querySelectorAll('[data-activity-key]')]
            .map((item) => [item.dataset.activityKey, item]));
        const openKeys = new Set([...activityPanel.querySelectorAll('details[open][data-activity-key]')]
            .map((item) => item.dataset.activityKey));

        const localApprovals = current.approvals || [];
        const backendApprovals = (current.toolboxWs || [])
            .filter((item) => item?.kind === 'backend-approval-request');
        const interactionKey = (source, requestId) => `${String(source || 'codex-native')}:${String(requestId || '')}`;
        const actionableKeys = new Set([
            ...localApprovals.map((item) => interactionKey(item.scope || 'codex-native', item.requestId || item.approvalId)),
            ...backendApprovals.map((item) => interactionKey('toolbox', item?.value?.requestId || item?.value?.data?.requestId)),
        ]);
        const passiveInteractions = (current.interactions || []).filter((item) => (
            !actionableKeys.has(interactionKey(item.source, item.requestId))
        ));
        const pendingApprovals = localApprovals.length + backendApprovals.length + passiveInteractions.length;
        const unread = current.activityUnreadByTab || {};
        const tabDefs = [
            { id: 'usage', label: '上下文' },
            { id: 'activity', label: '通知' },
            { id: 'approvals', label: pendingApprovals ? `审批 (${pendingApprovals})` : '审批' },
        ];
        if (!tabDefs.some((tab) => tab.id === state.activityTab)) state.activityTab = 'usage';
        const visibleTabIds = new Set(tabDefs.map(({ id }) => id));
        for (const [id, tab] of state.activityTabButtons) {
            if (visibleTabIds.has(id)) continue;
            tab.remove();
            state.activityTabButtons.delete(id);
        }
        for (const { id, label } of tabDefs) {
            const count = Number(unread[id] || 0);
            let tab = state.activityTabButtons.get(id);
            if (!tab) {
                tab = node('button', 'agent-chat-activity-tab');
                tab.type = 'button';
                tab.dataset.tab = id;
                tab.setAttribute('role', 'tab');
                tab.addEventListener('click', () => { state.activityTab = id; clearActivityUnread(id); renderActivity(); });
                state.activityTabButtons.set(id, tab);
            }
            activityTabs.append(tab);
            tab.textContent = count ? `${label} · ${Math.min(99, count)}` : label;
            tab.classList.toggle('is-active', state.activityTab === id);
            tab.setAttribute('aria-selected', String(state.activityTab === id));
        }
        activityTabs.querySelectorAll('.agent-chat-activity-tab-group').forEach((group) => group.remove());

        for (const [id, panel] of state.activityTabPanels) {
            if (visibleTabIds.has(id)) continue;
            panel.remove();
            state.activityTabPanels.delete(id);
        }

        for (const { id } of tabDefs) {
            let panel = state.activityTabPanels.get(id);
            if (!panel) {
                panel = node('div', 'agent-chat-activity-tabpanel');
                panel.dataset.activityPanel = id;
                panel.setAttribute('role', 'tabpanel');
                state.activityTabPanels.set(id, panel);
                activityContent.append(panel);
            }
            panel.hidden = id !== state.activityTab;
        }
        const content = state.activityTabPanels.get(state.activityTab);
        content.replaceChildren();
        const viewState = deriveWorkbenchViewState(current);

        if (state.activityTab === 'connection') {
            content.append(buildConnectionPanel(current, viewState));
        } else if (state.activityTab === 'approvals') {
            if (!pendingApprovals) {
                content.append(node('div', 'agent-chat-activity-empty', '没有待确认的审批。'));
            } else {
                for (const approval of localApprovals) {
                    content.append(blockPresentation.createApproval(approval, {
                        onDecision: (item, decision) => {
                        approvalRegistry.delete(item.approvalId);
                        run(() => controller.respondApproval(item, decision));
                        },
                        registry: approvalRegistry,
                        ensureTicker: ensureApprovalTicker,
                    }));
                }
                // ToolBox approval IDs have no trustworthy Topic correlation.
                // They live in this global center, never on a Topic card.
                for (const observation of backendApprovals) {
                    content.append(blockPresentation.createToolboxObservation(observation));
                }
                for (const interaction of passiveInteractions) {
                    content.append(existingInteractions.get(String(interaction.requestId)) || buildInteractionCard(interaction));
                }
            }
        } else if (state.activityTab === 'usage') {
            content.append(buildUsagePanel(current));
        } else if (state.activityTab === 'plan') {
            content.append(buildPlanInspector(current));
        } else if (state.activityTab === 'changes') {
            content.append(buildChangeInspector(current));
        } else {
            // This is a daemon-global observation feed, not a Topic feed;
            // backend approval cards may also be reached from Approvals.
            const ws = current.toolboxWs || [];
            const markers = current.markerObservations || [];
            content.append(node('div', 'agent-chat-activity-note', '全局 VCPLog/VCPInfo 仅保留本次运行；会话关联的工具、推理和检查结果会随会话恢复。'));
            const controls = node('div', 'agent-chat-activity-filters');
            const search = document.createElement('input');
            search.type = 'search';
            search.placeholder = '搜索活动';
            search.value = state.activitySearch;
            search.setAttribute('aria-label', '搜索工具活动');
            search.addEventListener('input', () => { state.activitySearch = search.value; renderActivity(); });
            const sourceFilter = document.createElement('select');
            sourceFilter.setAttribute('aria-label', '活动来源');
            for (const value of ['all', ...new Set(ws.map((item) => item.channel).filter(Boolean))]) {
                const option = document.createElement('option'); option.value = value; option.textContent = value === 'all' ? '全部来源' : value; sourceFilter.append(option);
            }
            sourceFilter.value = state.activitySourceFilter;
            sourceFilter.addEventListener('change', () => { state.activitySourceFilter = sourceFilter.value; renderActivity(); });
            const kindFilter = document.createElement('select');
            kindFilter.setAttribute('aria-label', '活动类型');
            for (const value of ['all', ...new Set([...ws.map((item) => item.kind), ...markers.map((item) => item.kind)].filter(Boolean))]) {
                const option = document.createElement('option'); option.value = value; option.textContent = value === 'all' ? '全部类型' : value; kindFilter.append(option);
            }
            kindFilter.value = state.activityKindFilter;
            kindFilter.addEventListener('change', () => { state.activityKindFilter = kindFilter.value; renderActivity(); });
            controls.append(search, sourceFilter, kindFilter);
            content.append(controls);
            const query = state.activitySearch.trim().toLocaleLowerCase();
            const visibleWs = ws.filter((item) => (state.activitySourceFilter === 'all' || item.channel === state.activitySourceFilter)
                && (state.activityKindFilter === 'all' || item.kind === state.activityKindFilter)
                && (!query || JSON.stringify(item).toLocaleLowerCase().includes(query)));
            const visibleMarkers = markers.filter((item) => (state.activitySourceFilter === 'all')
                && (state.activityKindFilter === 'all' || item.kind === state.activityKindFilter)
                && (!query || JSON.stringify(item).toLocaleLowerCase().includes(query)));
            const list = node('div', 'agent-chat-activity-list');
            if (!visibleWs.length && !visibleMarkers.length) {
                list.append(node('div', 'agent-chat-activity-empty', '暂无 VCPToolBox 或 VCP 内容观察事件。'));
            } else {
                for (const observation of visibleWs) {
                    const card = existingActivityCards.get(observation.id) || blockPresentation.createToolboxObservation(observation);
                    card.dataset.activityKey = observation.id;
                    list.append(card);
                }
                for (const observation of visibleMarkers) {
                    const card = existingActivityCards.get(observation.id) || blockPresentation.createMarkerObservation(observation);
                    card.dataset.activityKey = observation.id;
                    list.append(card);
                }
            }
            content.append(list);
        }
        for (const details of content.querySelectorAll('details[data-activity-key]')) {
            if (openKeys.has(details.dataset.activityKey)) details.open = true;
        }
        const scrollTarget = state.activityTab === 'activity'
            ? content.querySelector('.agent-chat-activity-list')
            : content;
        if (scrollTarget) scrollTarget.scrollTop = scrollTop;
        if (searchFocused) {
            const nextSearch = content.querySelector('.agent-chat-activity-filters input[type="search"]');
            nextSearch?.focus();
            if (searchSelection) nextSearch?.setSelectionRange?.(...searchSelection);
        }
    }

    function patchStreamingFeed(event) {
        // Deltas share the same requestAnimationFrame batcher as all other
        // timeline parts.  The keyed reconciler changes only this message row
        // and keeps tool cards, expanded details and the composer intact.
        if (event?.messageId) queueRender({ feed: true });
    }

    function queueRender(parts = {}) {
        if (state.disposed) return;
        Object.assign(pendingRender, parts);
        if (renderFrame !== null) return;
        const schedule = window.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
        renderFrame = schedule(() => {
            renderFrame = null;
            const next = { ...pendingRender };
            Object.keys(pendingRender).forEach((key) => { pendingRender[key] = false; });
            if (next.shell) renderSidebar();
            if (next.header) renderHeader();
            if (next.feed) renderFeed();
            if (next.activity) renderActivity();
            if (next.composer) renderComposer();
            if (next.topicFlow) renderTopicFlow();
            if (next.conflict) renderTopicConflict();
        });
    }

    function patchSidebarTopicSelection() {
        const selectedTopicId = store.getState().selectedTopic?.topicId
            || store.getState().attachment?.topicId
            || null;
        for (const row of sidebar.querySelectorAll('.agent-chat-session-row[data-topic-id]')) {
            const active = Boolean(selectedTopicId && row.dataset.topicId === selectedTopicId);
            row.classList.toggle('active', active);
            row.classList.toggle('active-topic-glowing', active);
            row.setAttribute('aria-current', active ? 'true' : 'false');
        }
    }

    function settleTurnStartIndicator(event) {
        const pending = state.turnStart;
        if (!pending) return;
        const turnId = pending.turnId;
        const eventTurnMatches = !event?.turnId || !turnId || event.turnId === turnId;
        if (eventTurnMatches && event && (
            event.type === 'assistant.started'
            || event.type === 'assistant.delta'
            || event.type === 'reasoning.delta'
            || event.type === 'turn.completed'
            || event.type === 'turn.failed'
            || event.type === 'turn.cancelled'
            || event.type === 'runtime.crashed'
        )) {
            state.turnStart = null;
            return;
        }
        // Codex projection notifications are reduced through store.setState
        // with no synthetic business event.  A real assistant message is the
        // authoritative replacement for the ephemeral thinking row.
        if (!event && turnId && store.getState().messages.some((message) => (
            message.role === 'assistant' && message.turnId === turnId
        ))) {
            uxMark('first-assistant-item', turnId, state.uxTimings.get(`turn-start:${pending.topicId || 'new'}`) || null);
            state.turnStart = null;
        }
    }

    function renderForStoreEvent(event) {
        if (event?.type && state.activityOpen) {
            const eventTab = event.type === 'toolbox.ws' || event.type === 'marker.observed' ? 'activity'
                : event.type.startsWith('approval.') || event.type.startsWith('interaction.') ? 'approvals'
                    : event.type === 'plan.updated' ? 'plan'
                        : event.type === 'context.usage' || event.type.includes('compaction') ? 'usage'
                            : null;
            if (eventTab === state.activityTab) clearActivityUnread(eventTab);
        }
        if (event?.type === 'turn.started' && event.turnId) {
            const rawTimestamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number(event.timestamp);
            const eventTime = Number.isFinite(rawTimestamp) && rawTimestamp >= 1_000_000_000_000
                ? rawTimestamp
                : Number.isFinite(rawTimestamp) && rawTimestamp >= 1_000_000_000
                    ? rawTimestamp * 1000
                    : Date.now();
            if (!state.turnStartedAt.has(event.turnId)) state.turnStartedAt.set(event.turnId, eventTime);
        } else if (event?.turnId && ['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) {
            state.turnStartedAt.delete(event.turnId);
        }
        settleTurnStartIndicator(event);
        if (!event?.type) {
            // A snapshot preview changes only the visible projection.  Do not
            // rebuild the sidebar shell/list (and therefore do not lose its
            // row identity, focus or scroll anchor) merely to mark one Topic
            // active.
            patchSidebarTopicSelection();
            queueRender({ header: true, feed: true, composer: true });
            return;
        }
        if (event.type === 'assistant.delta' || event.type === 'reasoning.delta') {
            const tokenKey = `first-visible-delta:${event.turnId || event.messageId || 'current'}`;
            if (!state.uxTimings.has(tokenKey)) {
                state.uxTimings.set(tokenKey, uxMark('first-visible-delta', event.turnId || event.messageId));
            }
            noteTimelineActivity();
            // Delta events are the hot path.  Preserve focus, scroll anchors,
            // expanded tool cards and pending approval buttons by changing
            // only the matching assistant node.
            patchStreamingFeed(event);
            return;
        }
        if (event.type === 'interaction.consumed') {
            // Codex Thread and Projection Store are authoritative for order. Reload the
            // bounded queue projection rather than guessing which item moved
            // at a tool-safe boundary.
            void refreshControlPlane();
            queueRender({ header: true, composer: true });
            return;
        }
        if (event.type.startsWith('tool.') || event.type.startsWith('approval.')
            || event.type === 'assistant.started' || event.type === 'assistant.completed'
            || event.type === 'user.message' || event.type.startsWith('turn.')
            || event.type === 'ui.user_message.pending') {
            if (event.type !== 'approval.requested' && event.type !== 'approval.resolved' && event.type !== 'approval.expired') {
                noteTimelineActivity();
            }
            // Approvals live in the activity panel now; keep it in sync too.
            maybeAutoOpenActivity();
            queueRender({ feed: true, header: true, activity: true, composer: true });
            return;
        }
        if (event.type === 'toolbox.ws') {
            // Observer events moved out of the chat feed into the activity panel.
            queueRender({ activity: true });
            return;
        }
        if (event.type.startsWith('session.')) {
            queueRender({ shell: true, header: true, feed: true, composer: true });
            return;
        }
        if (event.type.startsWith('runtime.') || event.type.startsWith('context.')) {
            maybeAutoOpenActivity();
            queueRender({ header: true, activity: true, composer: true });
            return;
        }
        queueRender({ feed: true, activity: true, composer: true });
    }

    function formatRunElapsed(milliseconds) {
        const seconds = Math.max(0, milliseconds) / 1000;
        if (seconds < 60) return `${seconds.toFixed(1)}s`;
        const wholeSeconds = Math.floor(seconds);
        const minutes = Math.floor(wholeSeconds / 60);
        const remainder = wholeSeconds % 60;
        if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
    }

    function latestRunningTool(current, turnId) {
        const tools = current.tools instanceof Map ? [...current.tools.values()] : [];
        return tools
            .filter((tool) => (!turnId || !tool.turnId || tool.turnId === turnId)
                && ['requested', 'running'].includes(tool.state))
            .sort((left, right) => Number(right.lastTimestamp || right.firstTimestamp || 0)
                - Number(left.lastTimestamp || left.firstTimestamp || 0))[0] || null;
    }

    function syncRunStatus(current = store.getState()) {
        const turnId = current.activeTurnId || state.turnStart?.turnId || null;
        const visible = Boolean(turnId || state.turnStart);
        runStatus.hidden = !visible;
        if (!visible) {
            if (runStatusTimer !== null) clearInterval(runStatusTimer);
            runStatusTimer = null;
            return;
        }
        const startedAt = turnId
            ? (state.turnStartedAt.get(turnId) || state.turnStart?.startedAt || Date.now())
            : (state.turnStart?.startedAt || Date.now());
        if (turnId && !state.turnStartedAt.has(turnId)) state.turnStartedAt.set(turnId, startedAt);
        const viewState = deriveWorkbenchViewState(current);
        runStatus.dataset.state = viewState;
        runStatusLabel.textContent = viewState === 'awaiting-approval'
            ? '等待审批'
            : state.turnStart?.phase === 'starting' && !current.activeTurnId
                ? '正在启动 Agent'
                : '正在运行';
        const runningTool = latestRunningTool(current, turnId);
        runStatusDetail.textContent = runningTool
            ? `正在执行 ${projectVcpToolPresentation(runningTool).label}`
            : 'Agent 正在处理当前任务';
        const elapsedMs = Date.now() - startedAt;
        runStatusElapsed.textContent = formatRunElapsed(elapsedMs);
        runStatusElapsed.dateTime = `PT${Math.max(0, elapsedMs / 1000).toFixed(1)}S`;
        runStatusStop.hidden = !current.activeTurnId;
        runStatusStop.disabled = !current.activeTurnId;
        if (runStatusTimer === null) {
            runStatusTimer = setInterval(() => {
                if (!state.disposed) syncRunStatus();
            }, 250);
        }
    }

    function renderComposer() {
        const current = store.getState();
        const viewState = deriveWorkbenchViewState(current);
        // The composer is live only when the fixed R3 lifecycle state machine
        // reports the agent as idle, running, or parked on an actionable
        // approval — never while it is starting, reconnecting, or down.
        const previewReady = Boolean(current.selectedTopic?.mode === 'preview'
            && (viewState === 'idle' || viewState === 'running' || viewState === 'awaiting-approval'));
        const composerReady = Boolean((current.attachment?.sessionId || previewReady)
            && (viewState === 'idle' || viewState === 'running' || viewState === 'awaiting-approval'));
        const hasActiveTurn = Boolean(current.activeTurnId);
        // Once the daemon confirms the Turn via turn.started/projection, the
        // normal running composer is usable again (steer/follow-up/cancel).
        // The ephemeral thinking row can remain until the first assistant
        // item arrives.
        const isStartingTurn = Boolean(state.turnStart && !hasActiveTurn);
        const canSend = Boolean(composerReady && (state.prompt.trim() || (!hasActiveTurn && state.pendingAttachments.length)));
        const interruptMode = Boolean(hasActiveTurn && !canSend);
        input.value = state.prompt;
        input.disabled = !composerReady || isStartingTurn;
        sendButton.disabled = !composerReady || isStartingTurn;
        // Attachment import is Host-owned; a preview has not acquired that
        // Topic's attachment store yet, so it may send text but cannot add a
        // file until it is safely switched on the first turn.
        // Attachment selection remains available during the ACK-to-first-event
        // gap; it only becomes unavailable once the daemon confirms a running
        // Turn.  This keeps the draft tray usable without pretending the
        // in-flight Turn can be edited or replayed.
        attachButton.disabled = !composerReady || previewReady || hasActiveTurn || state.pendingAttachments.length >= 8;
        attachmentTray.replaceChildren();
        if (state.pendingAttachments.length) {
            attachmentTray.append(createAttachmentChips(state.pendingAttachments, (index) => {
                state.pendingAttachments.splice(index, 1);
                renderComposer();
            }));
        }
        // Keep the main chat's original SVG / icon hierarchy intact.  Replacing
        // it on every streaming update was the source of the wrong button size.
        sendButton.title = hasActiveTurn
            ? (canSend ? '追加后续指令；使用 /steer <内容> 立即调整当前任务' : '任务运行中；空输入时点击取消')
            : '发送消息';
        sendButton.setAttribute('aria-label', interruptMode ? '取消当前任务' : '发送消息');
        const sendIcon = sendButton.querySelector('.vcp-ui-icon');
        if (sendIcon) sendIcon.textContent = interruptMode ? 'stop' : 'arrow_upward';
        input.placeholder = isStartingTurn
            ? (state.turnStart?.phase === 'thinking' ? '正在思考…' : '正在启动 Agent…')
            : (viewState === 'reconnecting' || viewState === 'error')
            ? '正在重新连接 Rust Agent…'
            : previewReady
            ? '输入消息…（发送时启动此会话）'
            : !current.attachment?.sessionId
            ? '请先创建 Agent 会话…'
            : viewState === 'starting'
            ? 'Agent Runtime 正在准备…'
            : hasActiveTurn
                ? '输入后续指令；/steer <内容> 立即调整当前任务…'
                : '输入消息…（Shift + Enter 换行）';
        inputCard.classList.toggle('is-busy', hasActiveTurn);
        sendButton.classList.toggle('interrupt-mode', interruptMode);
        sendButton.classList.toggle('is-ready', canSend || hasActiveTurn);
        const permissionLabel = state.permissionMode === 'always-approve' ? '本地审批：YOLO（设置）' : '本地审批：逐次确认（设置）';
        permissionsButton.title = permissionLabel;
        permissionsButton.setAttribute('aria-label', permissionLabel);
        permissionsButton.classList.toggle('is-active', state.permissionMode === 'always-approve');
        syncRunStatus(current);
    }

    function render() {
        if (state.disposed) return;
        renderSidebar();
        renderHeader();
        renderFeed();
        renderActivity();
        renderComposer();
        renderTopicFlow();
        renderTopicConflict();
    }

    input.addEventListener('input', () => { state.prompt = input.value; renderComposer(); });
    feed.addEventListener('scroll', () => {
        const following = isFollowingContainer(feed);
        if (following === state.followingFeed && !(following && state.unreadTimelineCount)) return;
        state.followingFeed = following;
        if (following) state.unreadTimelineCount = 0;
        renderJumpToLatest();
    }, { passive: true });
    jumpToLatest.addEventListener('click', () => {
        state.followingFeed = true;
        state.unreadTimelineCount = 0;
        renderJumpToLatest();
        scrollFeed(feed, true);
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendButton.click(); }
    });
    attachButton.addEventListener('click', () => run(async () => {
        const result = await controller.selectAttachments();
        const imported = Array.isArray(result?.attachments) ? result.attachments : [];
        const existing = new Set(state.pendingAttachments.map((item) => item.id));
        for (const attachment of imported) {
            if (!existing.has(attachment.id) && state.pendingAttachments.length < 8) {
                state.pendingAttachments.push(attachment);
                existing.add(attachment.id);
            }
        }
        if (result?.errors?.length) notify(result.errors.join('；'), imported.length ? 'warning' : 'error');
        renderComposer();
    }));
    sendButton.addEventListener('click', () => run(async () => {
        const current = store.getState();
        const prompt = state.prompt.trim();
        if (current.activeTurnId) {
            if (!prompt) { await controller.cancelTurn(); return; }
            state.prompt = '';
            renderComposer();
            const steering = prompt.match(/^\/steer\s+([\s\S]+)$/i);
            if (steering) {
                await controller.steerTurn(steering[1].trim());
                notify('已插入即时 steering 指令。', 'success');
            } else {
                await controller.followUpTurn(prompt);
                notify('已加入后续指令队列。', 'success');
            }
            await refreshControlPlane();
            return;
        }
        if (!prompt && !state.pendingAttachments.length) return;
        const attachments = state.pendingAttachments.map((item) => ({ ...item }));
        const topicId = current.selectedTopic?.topicId || current.attachment?.topicId || null;
        state.turnStart = {
            topicId,
            prompt,
            attachments,
            phase: 'starting',
            turnId: null,
            startedAt: Date.now(),
            createdAt: Date.now(),
        };
        state.uxTimings.set(`turn-start:${topicId || 'new'}`, window.performance?.now?.() || Date.now());
        // Paint before awaiting Topic attachment/thread startup.  This is the
        // same immediate feedback users get in main chat, while remaining a
        // renderer-only placeholder until Codex returns a real Turn ID.
        renderFeed();
        queueRender({ feed: true, header: true, composer: true });
        try {
            const accepted = await controller.startTurn(prompt, attachments);
            state.turnStart = {
                ...state.turnStart,
                phase: accepted?.turnId ? 'thinking' : 'starting',
                turnId: accepted?.turnId || null,
            };
            if (accepted?.turnId && !state.turnStartedAt.has(accepted.turnId)) {
                state.turnStartedAt.set(accepted.turnId, state.turnStart?.startedAt || Date.now());
            }
            uxMark('turn-start-ack', accepted?.turnId, state.uxTimings.get(`turn-start:${topicId || 'new'}`) || null);
            // Preserve the draft if attachment switching or turn acceptance
            // fails.  The daemon is the only place that can confirm a turn.
            state.prompt = '';
            state.pendingAttachments = [];
            settleTurnStartIndicator();
            queueRender({ feed: true, header: true, composer: true });
        } catch (error) {
            state.turnStart = null;
            queueRender({ feed: true, header: true, composer: true });
            throw error;
        }
    }));
    newButton.addEventListener('click', openNewTopicFlow);

    const unsubscribe = store.subscribe((_nextState, event) => renderForStoreEvent(event));
    render();
    controller.initialize()
        .then(async () => {
            void Promise.resolve()
                .then(() => runtimeApi().agentRuntimeGetPresentationMode?.())
                .catch(() => null)
                .then((presentationMode) => {
                if (state.disposed) return;
                const nextPresentationMode = presentationMode?.mode === 'legacy' ? 'legacy' : 'fork';
                root.dataset.presentationRenderer = nextPresentationMode;
                if (nextPresentationMode === state.presentationMode) return;
                state.presentationMode = nextPresentationMode;
                for (const row of state.timelineRows.values()) row.remove();
                state.timelineRows.clear();
                queueRender({ feed: true });
                });
            const runtime = store.getState().runtime;
            if (runtime.state === 'stopped' || runtime.state === 'unknown') await controller.startRuntime();
            // A renderer reload restores a durable Rust snapshot, not a
            // writable attachment.  The first actual send performs the safe
            // in-process attachment switch; this mirrors normal chat's
            // instant view selection without reopening a runtime on click.
            if (!store.getState().attachment?.sessionId && state.rememberedTopic?.topicId) {
                // Do not wait for model/catalog discovery before restoring
                // the visible history.  Rust validates the durable Topic;
                // catalog data enriches the row in the background.
                const topicId = state.rememberedTopic.topicId;
                rememberTopic({ topicId });
                try {
                    await controller.previewTopic(topicId);
                } catch (error) {
                    if (!isEmptyTopicCheckpointError(error)) throw error;
                    // The pointer is not durable history. Forget only it;
                    // Rust retains the empty Topic and will write its first
                    // checkpoint normally after a future attachment/turn.
                    forgetTopic(topicId);
                }
            }
            await refreshControlPlane();
        })
        .catch((error) => notify(`Agent Runtime 无法启动：${error?.message || error}`, 'error'));

    return () => {
        state.disposed = true;
        if (runStatusTimer !== null) clearInterval(runStatusTimer);
        closeTopicContextMenu();
        if (renderFrame !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(renderFrame);
        state.accountThemeObserver?.disconnect();
        fullPresentation.dispose();
        unsubscribe();
        controller.dispose();
        root.remove();
        topicFlowLayer.remove();
        topicConflictLayer.remove();
    };
}

register({
    id: 'agent-workbench',
    title: 'VCPBuild',
    // Rounded-square "code" chip mirroring opencode's tab project-avatar:
    // a small filled tile with an inset ring and a code glyph inside.
    iconSvg: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="currentColor" fill-opacity="0.12"/><rect x="1.5" y="1.5" width="21" height="21" rx="5" stroke="currentColor" stroke-opacity="0.35" stroke-width="1"/><path d="m9.2 9.2-3 3 3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="m14.8 9.2 3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.2 7.5l-2.4 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    kind: 'internal',
    mount: mountWorkbench,
});
