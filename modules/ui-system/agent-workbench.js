import { register } from './next-ui-apps.js';
import { createWorkbenchController } from './agent-workbench-controller.js';
import { projectMessage, projectSession, projectTool } from './agent-workbench-projections.js';
import { deriveWorkbenchViewState } from './agent-workbench-store.js';

// This is deliberately a view over AgentRuntime, not a second chat/session
// implementation.  Session, message, tool, approval and topic state all come
// from the Rust daemon via the narrow preload API.
const runtimeApi = () => window.chatAPI || window.electronAPI || {};
// This is deliberately only a pointer.  Rust's Topic Store remains the sole
// transcript/checkpoint authority; the renderer remembers which durable Topic
// should be reattached after Ctrl+R or an Electron restart.
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
        return parsed && typeof parsed.topicId === 'string' ? { topicId: parsed.topicId } : null;
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
    menu.append(themeStore, themeToggle);
    // Keep the dock's theme labels in sync with runtime theme switching. The
    // main chat toggles `dark-theme` on <body>; without watching it the account
    // menu would show a stale label/icon until the next full re-render.
    const syncAccountTheme = () => {
        const dark = document.body.classList.contains('dark-theme');
        themeStore.replaceChildren(...icon('palette'), document.createTextNode('主题选择'));
        themeToggle.replaceChildren(...icon(dark ? 'light_mode' : 'dark_mode'), document.createTextNode(dark ? '切换为浅色模式' : '切换为深色模式'));
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
    // action.  A first user prompt will become the durable Rust Topic title.
    const time = new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    return `新会话 ${time}`;
}

function formatTime(value) {
    if (!value) return '';
    try { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); } catch { return ''; }
}

function safeText(value) {
    return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
}

function detailsSummary(tool) {
    const raw = tool?.payload || {};
    return safeText(raw.argumentSummary || raw.argsPreview || raw.outputSummary || raw.note || raw.reason || raw.error || tool.summary);
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
        <div class="vcp-thought-chain-header"><span class="vcp-thought-chain-icon">lightbulb</span><span class="vcp-thought-chain-label">思考中</span><span class="vcp-result-toggle-icon"></span></div>
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
    if (item.content) {
        content.innerHTML = renderMarkdown(item.content);
        postRender(content);
    } else if (item.state === 'streaming') {
        content.innerHTML = '<span class="agent-chat-thinking-placeholder">正在思考…</span>';
    }
    body.append(heading, content);
    if (item.reasoning) {
        const reasoningEl = node('div', 'agent-chat-reasoning-block');
        reasoningEl.innerHTML = renderReasoning(item.reasoning);
        postRender(reasoningEl);
        applyReasoningState(reasoningEl, item);
        body.append(reasoningEl);
    }
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
        if (item.content) {
            content.innerHTML = renderMarkdown(item.content);
            postRender(content);
        } else if (item.state === 'streaming') {
            if (!content.querySelector('.agent-chat-thinking-placeholder')) {
                content.innerHTML = '<span class="agent-chat-thinking-placeholder">正在思考…</span>';
            }
        } else {
            content.innerHTML = '';
        }
    }

    const body = row.querySelector('.details-and-bubble-wrapper');
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

function toolStatusLabel(state) {
    const labels = { requested: '等待中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
    return labels[state] || state;
}

// Cherry-style structured argument table: every tool call shows its inputs as
// a key/value grid instead of a raw text blob, so long parameters stay scannable.
function buildToolArgsTable(args) {
    const wrap = node('div', 'agent-chat-tool-args');
    wrap.append(node('div', 'agent-chat-tool-detail-label', '参数'));
    const table = node('table', 'agent-chat-tool-args-table');
    for (const [key, raw] of Object.entries(args)) {
        const tr = node('tr');
        tr.append(node('th', 'agent-chat-tool-args-key', key));
        const td = node('td', 'agent-chat-tool-args-value');
        const text = typeof raw === 'string' ? raw : safeText(raw);
        td.textContent = text;
        if (text.length > 120) td.classList.add('agent-chat-tool-args-long');
        tr.append(td);
        table.append(tr);
    }
    wrap.append(table);
    return wrap;
}

// Reuse the main-chat render bridge for tool output so Agent results look
// identical to a normal chat message and never diverge into a second renderer.
function renderToolContent(value) {
    const text = typeof value === 'string' ? value : safeText(value);
    if (!text.trim()) return '';
    return renderMarkdown(text);
}

function createToolCard(tool, onCancel) {
    const value = projectTool(tool);
    const status = value.state || 'requested';
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    const card = node('section', 'agent-chat-tool-activity');
    card.dataset.toolCallId = value.toolCallId || '';
    card.dataset.status = status;
    if (tool.expanded && isTerminal) card.classList.add('expanded');

    // Header row (always visible)
    const header = node('div', 'agent-chat-tool-header');

    // Left: icon + name + separator + subtitle
    const titleRow = node('span', 'agent-chat-tool-title');
    const nameText = node('span', 'agent-chat-tool-name-text', value.name);
    titleRow.append(...icon('build_circle'), nameText);
    const sub = value.summary || detailsSummary(tool);
    if (sub) {
        titleRow.append(node('span', 'agent-chat-tool-sep', '·'), node('span', 'agent-chat-tool-sub', sub));
    }

    // Right: status badge + risk + optional chevron
    const badge = node('span', 'agent-chat-tool-status-badge', toolStatusLabel(status));
    badge.dataset.status = status;
    header.append(titleRow, badge);
    if (value.riskLevel && value.riskLevel !== 'unknown') {
        header.append(node('span', 'agent-chat-tool-risk', value.riskLevel));
    }

    // Running tools can be cancelled directly (whole-turn cancel is the
    // closest backend primitive until a per-tool cancel API lands).
    if (!isTerminal && typeof onCancel === 'function') {
        const cancel = node('button', 'agent-chat-tool-cancel');
        cancel.type = 'button';
        cancel.title = '取消该工具调用';
        cancel.setAttribute('aria-label', '取消该工具调用');
        cancel.append(...icon('cancel'));
        cancel.addEventListener('click', () => onCancel(tool));
        header.append(cancel);
    }

    if (isTerminal) {
        const chevron = node('button', 'agent-chat-tool-chevron');
        chevron.type = 'button';
        chevron.setAttribute('aria-label', '展开/折叠工具详情');
        chevron.append(...icon('expand_more'));
        chevron.addEventListener('click', () => {
            tool.expanded = !tool.expanded;
            card.classList.toggle('expanded', !!tool.expanded);
        });
        header.append(chevron);
    }

    // Collapsed detail: structured arguments + result when the daemon supplies
    // them (Cherry-style ArgsTable), otherwise fall back to the summary blob.
    const payload = tool.payload || {};
    const args = payload.arguments ?? payload.args ?? payload.parameters;
    const result = payload.result ?? payload.output ?? payload.response;
    const hasArgs = args && typeof args === 'object' && Object.keys(args).length > 0;
    const hasResult = result != null && String(result).trim() !== '';
    if (hasArgs || hasResult) {
        const detail = node('div', 'agent-chat-tool-detail');
        if (hasArgs) detail.append(buildToolArgsTable(args));
        if (hasResult) {
            detail.append(node('div', 'agent-chat-tool-detail-label', '结果'));
            const resultEl = node('div', 'agent-chat-tool-detail-result');
            resultEl.innerHTML = renderToolContent(result);
            postRender(resultEl);
            const resultText = typeof result === 'string' ? result : safeText(result);
            if (resultText.length > 480) {
                // Long tool output is clamped with a fade; the toggle expands
                // it in place (Cherry Studio shows the same "Show more" affordance).
                resultEl.classList.add('agent-chat-tool-detail-result--truncated');
                const toggle = node('button', 'agent-chat-tool-result-toggle', '展开结果');
                toggle.type = 'button';
                toggle.setAttribute('aria-label', '展开/收起工具结果');
                toggle.addEventListener('click', () => {
                    const expanded = resultEl.classList.toggle('agent-chat-tool-detail-result--expanded');
                    toggle.textContent = expanded ? '收起结果' : '展开结果';
                });
                detail.append(resultEl, toggle);
            } else {
                detail.append(resultEl);
            }
        }
        card.append(header, detail);
    } else {
        const output = node('pre', 'agent-chat-tool-output', detailsSummary(tool));
        card.append(header, output);
    }
    return card;
}

function patchToolCard(card, tool) {
    const value = projectTool(tool);
    const status = value.state || 'requested';
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    card.dataset.status = status;

    const nameText = card.querySelector('.agent-chat-tool-name-text');
    if (nameText) nameText.textContent = value.name;

    let sub = card.querySelector('.agent-chat-tool-sub');
    const summary = value.summary || detailsSummary(tool);
    if (summary) {
        const titleRow = card.querySelector('.agent-chat-tool-title');
        if (!sub && titleRow) {
            titleRow.append(node('span', 'agent-chat-tool-sep', '·'), node('span', 'agent-chat-tool-sub', summary));
            sub = titleRow.querySelector('.agent-chat-tool-sub');
        } else if (sub) {
            sub.textContent = summary;
        }
    }

    const badge = card.querySelector('.agent-chat-tool-status-badge');
    if (badge) { badge.textContent = toolStatusLabel(status); badge.dataset.status = status; }

    const risk = value.riskLevel && value.riskLevel !== 'unknown';
    let riskEl = card.querySelector('.agent-chat-tool-risk');
    if (risk && !riskEl) {
        riskEl = node('span', 'agent-chat-tool-risk', value.riskLevel);
        card.querySelector('.agent-chat-tool-header')?.append(riskEl);
    } else if (!risk && riskEl) {
        riskEl.remove();
    } else if (risk && riskEl) {
        riskEl.textContent = value.riskLevel;
    }

    // Add chevron when card becomes terminal
    if (isTerminal && !card.querySelector('.agent-chat-tool-chevron')) {
        const chevron = node('button', 'agent-chat-tool-chevron');
        chevron.type = 'button';
        chevron.setAttribute('aria-label', '展开/折叠工具详情');
        chevron.append(...icon('expand_more'));
        chevron.addEventListener('click', () => {
            tool.expanded = !tool.expanded;
            card.classList.toggle('expanded', !!tool.expanded);
        });
        card.querySelector('.agent-chat-tool-header')?.append(chevron);
    }

    const output = card.querySelector('.agent-chat-tool-output');
    if (output) output.textContent = detailsSummary(tool);
}

function projectToolboxObservation(observation = {}) {
    const kind = String(observation.kind || 'notification');
    const channel = String(observation.channel || 'ToolBox');
    const labels = {
        log: '运行日志',
        notification: '服务通知',
        // ToolBox does not expose a correlation key between this requestId
        // and the legacy marker call owned by Rust Agent. Keep that boundary
        // visible instead of attaching a misleading backend state to a local
        // tool card.
        'backend-approval-request': '后端审核请求（未关联）',
        'distributed-observation': '分布式节点观察',
    };
    const value = observation.value;
    let summary = '';
    if (kind === 'backend-approval-request' && value && typeof value === 'object') {
        const data = value.data && typeof value.data === 'object' ? value.data : value;
        const requestId = safeText(data.requestId || '未知请求 ID').slice(0, 160);
        const toolName = safeText(data.toolName || '未知工具').slice(0, 160);
        const timeout = Number(data.approvalTtlMs);
        const ttl = Number.isFinite(timeout) && timeout > 0 ? `，最长等待 ${Math.ceil(timeout / 60_000)} 分钟` : '';
        summary = `请求 ${requestId}：${toolName} 正在等待 VCPToolBox 后端审核${ttl}。请在已授权的 VCPLog 客户端或管理面板处理；此卡不能批准、拒绝或关联本地工具调用。`;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        summary = safeText(value.message || value.title || value.type || value.status || value);
    } else {
        summary = safeText(value);
    }
    return {
        channel,
        kind,
        label: labels[kind] || 'ToolBox 观察',
        summary: summary.slice(0, 2_000) || 'ToolBox 已发送一条只读状态事件。',
        detail: safeText(value).slice(0, 16_384),
    };
}

function createToolboxWsCard(observation) {
    const value = projectToolboxObservation(observation);
    const card = node('section', `agent-chat-toolbox-ws-card agent-chat-toolbox-ws-${value.kind}`);
    card.dataset.toolboxChannel = value.channel;
    card.dataset.toolboxKind = value.kind;
    const summary = node('button', 'agent-chat-toolbox-ws-summary');
    summary.type = 'button';
    const title = node('span', 'agent-chat-toolbox-ws-title');
    const iconName = value.kind === 'distributed-observation'
        ? 'hub'
        : value.kind === 'backend-approval-request' ? 'admin_panel_settings' : 'info';
    title.append(...icon(iconName), node('span', '', `VCPToolBox · ${value.label}`));
    summary.append(title, node('span', 'agent-chat-toolbox-ws-channel', value.channel));
    const detail = node('p', 'agent-chat-toolbox-ws-detail', value.summary);
    const output = node('pre', 'agent-chat-toolbox-ws-output', value.detail);
    output.hidden = true;
    summary.addEventListener('click', () => {
        output.hidden = !output.hidden;
        card.classList.toggle('expanded', !output.hidden);
    });
    card.append(summary, detail, output);
    return card;
}

function createApprovalCard(approval, onDecision, registry, ensureTicker) {
    const card = node('section', 'agent-chat-approval-card');
    card.dataset.approvalId = approval.approvalId || '';
    card.append(node('strong', 'agent-chat-approval-title', `需要本地确认：${approval.toolName || 'VCP 工具'}`));
    if (approval.riskLevel || approval.kind) {
        card.append(node('span', 'agent-chat-approval-risk', approval.riskLevel || approval.kind || '风险未分类'));
    }

    // Keep the two actual decisions immediately below the tool name.  The
    // binding can legitimately be long (UUIDs and hashes); placing it before
    // the controls made the only actionable part of an approval easy to miss
    // in the narrow activity panel.
    const actions = node('div', 'agent-chat-approval-actions');
    const deny = button('拒绝', 'danger');
    const allow = button('允许一次', 'secondary');
    const decide = (decision) => {
        if (card.dataset.deciding === 'true') return;
        card.dataset.deciding = 'true';
        deny.disabled = true;
        allow.disabled = true;
        deny.textContent = decision === 'deny' ? '正在拒绝…' : '拒绝';
        allow.textContent = decision === 'allow' ? '正在允许…' : '允许一次';
        registry?.delete(approval.approvalId);
        onDecision(approval, decision);
    };
    deny.addEventListener('click', () => decide('deny'));
    allow.addEventListener('click', () => decide('allow'));
    actions.append(deny, allow);
    card.append(actions);

    // R3: pin every approval to the exact execution context so a deny/allow
    // decision can never be misattributed to the wrong turn or tool call.
    const bindingPairs = [
        ['sessionId', approval.sessionId],
        ['turnId', approval.turnId],
        ['toolCallId', approval.toolCallId],
        ['argumentsHash', approval.argumentsHash],
    ].filter(([, value]) => value != null && value !== '');
    if (bindingPairs.length) {
        const binding = node('dl', 'agent-chat-approval-binding');
        for (const [key, value] of bindingPairs) {
            binding.append(node('dt', 'agent-chat-approval-binding-key', key));
            binding.append(node('dd', 'agent-chat-approval-binding-value', String(value)));
        }
        card.append(binding);
    }

    if (approval.reason) card.append(node('p', 'agent-chat-approval-reason', approval.reason));
    if (approval.argumentSummary || approval.argsPreview) card.append(node('pre', 'agent-chat-approval-args', safeText(approval.argumentSummary || approval.argsPreview)));

    const countdown = node('div', 'agent-chat-approval-countdown', '默认拒绝');
    countdown.setAttribute('aria-hidden', 'true');
    card.append(countdown);
    // Rust Host owns the fail-closed deadline. Renderer only announces and
    // displays it; it never manufactures an approval decision on timeout.
    const approvalLive = node('div', 'agent-chat-visually-hidden agent-chat-approval-live');
    approvalLive.setAttribute('role', 'status');
    approvalLive.setAttribute('aria-live', 'assertive');
    approvalLive.textContent = '等待审批；超时由 Rust Runtime 自动拒绝';
    card.append(approvalLive);

    const deadline = Number(approval.expiresAtMs);
    if (Number.isFinite(deadline) && deadline > 0 && registry && !registry.has(approval.approvalId)) {
        registry.set(approval.approvalId, { deadline, expired: false });
        ensureTicker?.();
    }
    const remaining = Number.isFinite(deadline) && deadline > 0
        ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
        : null;
    countdown.textContent = remaining == null
        ? '默认拒绝 · 等待 Rust Runtime 截止时间'
        : `默认拒绝 · Rust Runtime ${remaining}s 后处理`;
    return card;
}

function mountWorkbench(container) {
    const controller = createWorkbenchController(runtimeApi());
    const { store } = controller;
    const state = {
        tab: 'agents',
        selectedAgent: 'Nova',
        agentCatalog: [],
        agentSearch: '',
        modelCatalog: [],
        topics: [],
        topicSearch: '',
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
        recovering: false,
        activityOpen: false,
        activityTab: 'activity',
        lastViewState: null,
        hadApprovals: false,
        workspace: '',
        model: 'gpt-5.6-terra',
        prompt: '',
        rememberedTopic: loadRememberedTopic(),
        takeoverTopicId: null,
        previewTopic: null,
        // This is deliberately a transient UI flow, not a second Topic
        // store.  Rust remains the source of the Topic metadata/checkpoint;
        // the renderer only keeps the currently-open form and a small
        // read-only snapshot summary while the dialog is visible.
        topicFlow: null,
        disposed: false,
    };
    const pendingRender = { shell: false, header: false, feed: false, composer: false, activity: false };
    let renderFrame = null;
    // Control-plane replies can arrive after a user picked another Agent.
    // Keep the latest selection authoritative; an older Topic list must not
    // replace the newly selected Agent's history.
    let controlPlaneRequest = 0;

    const root = node('section', 'container agent-chat-root vcp-ui-scope');
    const topicFlowLayer = node('div', 'vcp-ui-scope agent-chat-topic-flow-layer');
    const sidebar = node('aside', 'sidebar active vcp-ui-scope agent-chat-sidebar');
    const main = node('main', 'main-content agent-chat-main-content agent-chat-pane');
    const feed = node('div', 'chat-messages-container vcp-ui-scope agent-chat-messages-container');
    const feedItems = node('div', 'chat-messages agent-chat-messages');
    const header = node('header', 'chat-header vcp-ui-scope agent-chat-header');
    const composer = node('footer', 'chat-input-area agent-chat-composer');
    const inputCard = node('div', 'chat-input-card');
    const input = document.createElement('textarea');
    input.className = 'agent-chat-message-input';
    input.rows = 1;
    input.placeholder = '输入消息…（Shift + Enter 换行）';
    input.setAttribute('aria-label', '输入 Agent 消息');
    const composerActions = node('div', 'chat-input-actions');
    const newButton = visualActionButton('add_comment', '新建 Agent 会话', 'agent-chat-composer-new');
    const attachButton = visualActionButton('attach_file', '附件暂不支持；文件操作请由 VCPToolBox 工具完成');
    const emoticonButton = visualActionButton('sentiment_satisfied', '打开表情包');
    const sendButton = visualActionButton('arrow_upward', '发送消息', 'agent-chat-send-button');
    attachButton.disabled = true;
    emoticonButton.addEventListener('click', () => {
        if (window.emoticonManager?.togglePanel) window.emoticonManager.togglePanel(emoticonButton, input);
        else notify('表情包系统尚未准备好。', 'warning');
    });
    composerActions.append(newButton, attachButton, emoticonButton, sendButton);
    inputCard.append(input, composerActions);
    composer.append(inputCard);
    feed.append(feedItems);
    const mainColumn = node('div', 'agent-chat-main-column');
    const activityPanel = node('aside', 'agent-chat-activity-panel agent-chat-activity-collapsed');
    activityPanel.id = 'agentChatActivityPanel';
    activityPanel.setAttribute('role', 'complementary');
    activityPanel.setAttribute('aria-label', 'Agent 活动面板');
    activityPanel.setAttribute('aria-hidden', 'true');
    activityPanel.setAttribute('inert', '');
    mainColumn.append(header, feed, composer);
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
                            if (label) label.textContent = '等待 Rust Runtime 确认超时拒绝';
                            const approvalLive = card.querySelector('.agent-chat-approval-live');
                            if (approvalLive) approvalLive.textContent = '审批截止时间已到，等待 Rust Runtime 最终事件。';
                        }
                    } else if (label) {
                        label.textContent = `默认拒绝 · Rust Runtime ${Math.ceil(remaining / 1000)}s 后处理`;
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

    function sameAgent(left, right) {
        return String(left || '').trim().toLocaleLowerCase()
            === String(right || '').trim().toLocaleLowerCase();
    }

    function selectedAgentProfile() {
        return state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, state.selectedAgent)) || null;
    }

    function selectAgent(agentId) {
        const profile = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, agentId));
        if (!profile) return;
        state.selectedAgent = profile.id || profile.name;
        // This is only the default for a future Topic. Existing Topics retain
        // their persisted model when opened, and no Session is created here.
        if (profile.model) state.model = profile.model;
    }

    async function refreshControlPlane() {
        const request = ++controlPlaneRequest;
        const optional = (fn) => Promise.resolve().then(fn).catch(() => []);
        // Match VCPChat's normal chat path: the shared Main-process Agent
        // catalog is the source of Agent identity/configuration.  Do not start
        // a Rust daemon merely to discover Agents, and do not call ToolBox's
        // `/v1/models` from this page.
        const sharedAgents = await optional(() => runtimeApi().getAgents?.());
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
            normalizedAgents.unshift({ id: 'Nova', name: 'Nova', model: '', systemPrompt: '{{Nova}}', avatarUrl: null });
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
            state.modelCatalog = Array.isArray(models) ? models : models?.models || [];
            if (!state.modelCatalog.some((model) => model.id === state.model)) {
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
        state.topics = receivedTopics.filter((topic) => !topic?.agentId || sameAgent(topic.agentId, selectedAgentId));
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
        }
        // Topics and queue state live in the control plane; leave the active
        // transcript intact while those catalog reads finish.
        queueRender({ shell: true, header: true, composer: true });
    }

    async function createSession(overrides = {}) {
        state.previewTopic = null;
        const runtimeState = store.getState().runtime.state;
        if (runtimeState === 'stopped' || runtimeState === 'unknown') {
            await controller.startRuntime();
        }
        const title = overrides.title || (overrides.resume ? undefined : nextSessionTitle());
        const session = await controller.createSession({
            workspaceRoot: overrides.workspaceRoot ?? (state.workspace.trim() || undefined),
            model: overrides.model ?? (state.model.trim() || undefined),
            agent: overrides.agent ?? (state.selectedAgent || 'Nova'),
            permissionMode: overrides.permissionMode ?? state.permissionMode,
            resume: overrides.resume,
            title,
        });
        rememberTopic(session);
        state.tab = 'sessions';
        await refreshControlPlane();
        return session;
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
        queueRender({ topicFlow: true });
    }

    function closeTopicFlow() {
        state.topicFlow = null;
        queueRender({ topicFlow: true });
    }

    async function openTopicFlow(topic) {
        if (!topic?.id || state.topicFlow?.loading) return;
        // The first frame makes the asynchronous Rust read visible.  This is
        // important for occupied Topics: users must see that they are looking
        // at a durable checkpoint, not a stale JS session cache.
        state.topicFlow = { kind: 'open', topic, loading: true, snapshot: null, error: null };
        queueRender({ topicFlow: true });
        try {
            const snapshot = await controller.readTopic(topic.id, topic.agentId);
            if (state.topicFlow?.kind === 'open' && state.topicFlow.topic?.id === topic.id) {
                state.topicFlow = { ...state.topicFlow, loading: false, snapshot };
            }
        } catch (error) {
            if (state.topicFlow?.kind === 'open' && state.topicFlow.topic?.id === topic.id) {
                state.topicFlow = { ...state.topicFlow, loading: false, error: error?.message || String(error) };
            }
        }
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
                    return;
                }
            }
            if (!state.disposed) throw new Error('等待 Topic 持有者释放超时；其 lease 仍有效，请稍后重试。');
        } finally {
            state.takeoverTopicId = null;
            queueRender({ shell: true, header: true, composer: true });
        }
    }

    function clearPreview() {
        state.previewTopic = null;
        store.setState({ messages: [] });
        render();
    }

    // Open a read-only snapshot of an occupied (in-use) Topic.  This reads the
    // durable checkpoint WITHOUT claiming its session lease, so the other live
    // client keeps ownership until the user explicitly chooses takeover.
    async function previewOccupiedTopic(topic) {
        if (!topic?.id || state.disposed) return;
        state.previewTopic = topic;
        queueRender({ shell: true, header: true, feed: true, composer: true });
        try {
            await controller.previewTopic(topic.id, topic.agentId);
        } catch (error) {
            notify(`无法只读预览此 Topic：${error?.message || error}`, 'error');
            state.previewTopic = null;
        }
        queueRender({ shell: true, header: true, feed: true, composer: true });
    }

    async function recoverDaemon() {
        // Recovery is intentionally user-driven.  A daemon crash must never
        // replay an interrupted model/tool turn.  Reattaching the bounded
        // Topic checkpoint creates a fresh Session and keeps that boundary
        // explicit in both the UI and Rust Host.
        if (state.recovering) return;
        state.recovering = true;
        queueRender({ header: true, composer: true });
        try {
            const previous = activeSession();
            await controller.stopRuntime();
            await controller.startRuntime();
            if (previous?.topicId) {
                await createSession({
                    resume: previous.topicId,
                    title: previous.title,
                    model: previous.model,
                    agent: previous.agentId,
                    workspaceRoot: previous.workspaceRoot,
                });
                notify('Rust Agent 已重新连接，并恢复到最近的安全 Topic checkpoint。中断的 Turn 不会重放。', 'success');
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

    function appendTopicActions(row, topic) {
        const menu = iconButton('more_horiz', `管理 Topic：${topic.title || topic.id}`, 'agent-chat-session-menu');
        const actions = node('div', 'agent-chat-session-actions');
        actions.hidden = true;
        const rename = button('重命名');
        const remove = button('删除', 'danger');
        menu.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            actions.hidden = !actions.hidden;
        });
        rename.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            actions.hidden = true;
            const title = window.prompt?.('重命名 Agent Topic', topic.title || '');
            if (title === null || title === undefined || title.trim() === (topic.title || '').trim()) return;
            run(async () => {
                await controller.renameTopic(topic.id, title, topic.agentId);
                rememberTopicTitle(topic, title.trim());
                await refreshControlPlane();
                notify('Agent Topic 已重命名。', 'success');
            });
        });
        remove.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            actions.hidden = true;
            const confirmed = window.confirm?.(`确定删除「${topic.title || topic.id}」吗？此操作不能恢复。`);
            if (!confirmed) return;
            run(async () => {
                await controller.deleteTopic(topic.id, topic.agentId);
                forgetTopic(topic.id);
                await refreshControlPlane();
                notify('Agent Topic 已删除。', 'success');
            });
        });
        actions.append(rename, remove);
        row.append(menu, actions);
    }

    function renderSidebar() {
        sidebar.replaceChildren();
        const tabs = node('div', 'sidebar-tabs');
        for (const [id, label] of [['agents', '助手'], ['sessions', '会话'], ['settings', '设置']]) {
            const tab = node('button', `sidebar-tab-button${state.tab === id ? ' active' : ''}`, label);
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(state.tab === id));
            tab.addEventListener('click', () => {
                state.tab = id;
                // Topic management is a transient renderer affordance. Never
                // leave selection mode active while the Topic page is hidden.
                if (id !== 'sessions') {
                    state.topicManaging = false;
                    state.topicSelectedIds.clear();
                    state.topicSearchOpen = false;
                    state.topicSearch = '';
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
            const attachment = store.getState().attachment;
            const liveSessions = attachment ? [projectSession(attachment)] : [];
            const activeSessionId = attachment?.sessionId;
            const liveTopicIds = new Set(liveSessions.map((session) => session.topicId).filter(Boolean));
            const persistedTopics = state.topics.filter((topic) => !liveTopicIds.has(topic.id));
            if (!liveSessions.length && !persistedTopics.length) list.append(node('li', 'agent-chat-empty-list', `${state.selectedAgent || '当前 Agent'} 还没有会话。创建一个会话后即可开始。`));
            for (const session of liveSessions) {
                const active = session.sessionId === activeSessionId;
                // Keep this deliberately isomorphic to topicListManager's main
                // chat rows.  The only different bit is the select callback.
                const row = node('li', `topic-item agent-chat-session-row${active ? ' active active-topic-glowing' : ''}`);
                row.tabIndex = 0;
                row.dataset.itemId = session.agentId || state.selectedAgent || 'Nova';
                row.dataset.itemType = 'agent-runtime';
                row.dataset.topicId = session.sessionId;
                row.dataset.topicSearch = `${session.title} ${session.model}`.toLocaleLowerCase();
                const avatar = document.createElement('img');
                avatar.className = 'avatar';
                avatar.loading = 'lazy';
                avatar.decoding = 'async';
                avatar.src = 'assets/default_avatar.png';
                avatar.alt = `${state.selectedAgent || 'Nova'} - ${session.title}`;
                avatar.onerror = () => { avatar.src = 'assets/default_avatar.png'; };
                const title = node('span', 'topic-title-display', session.title);
                const count = node('span', 'message-count', active ? String(store.getState().messages.length) : '');
                row.append(avatar, title, count);
                // The row is a live attachment, not a durable GUI Session.
                // Rebuild only from the Rust Topic snapshot; Main has no
                // message/event ring to select from.
                row.addEventListener('click', () => run(() => controller.hydrateTopic(session.topicId, session, null, session.agentId)));
                list.append(row);
            }
            // Old conversations are Topics, not abandoned in-memory GUI
            // sessions.  Render them with the same main-chat row contract and
            // resume the bounded Rust checkpoint when selected.
            for (const topic of persistedTopics) {
                const selectable = !topic.inUse;
                const selected = state.topicSelectedIds.has(topic.id);
                const row = node('li', `topic-item agent-chat-session-row agent-chat-persisted-topic${state.previewTopic?.id === topic.id ? ' previewing' : ''}${selected ? ' selected' : ''}`);
                row.tabIndex = 0;
                row.dataset.itemId = topic.agentId || state.selectedAgent || 'Nova';
                row.dataset.itemType = 'agent-topic';
                row.dataset.topicId = topic.id;
                row.dataset.topicSearch = `${topic.title || topic.id} ${topic.model || ''}`.toLocaleLowerCase();
                const avatar = document.createElement('img');
                avatar.className = 'avatar';
                avatar.loading = 'lazy';
                avatar.decoding = 'async';
                avatar.src = 'assets/default_avatar.png';
                avatar.alt = `${topic.agentId || 'Nova'} - ${topic.title || topic.id}`;
                avatar.onerror = () => { avatar.src = 'assets/default_avatar.png'; };
                const title = node('span', 'topic-title-display', topic.title || topic.id);
                const status = node('span', 'message-count', topic.inUse ? '使用中' : '');
                row.append(avatar, title, status);
                if (selectable) {
                    const selectIcon = node('span', 'vcp-ui-icon next-ui-topic-select-icon', selected ? 'check_box' : 'check_box_outline_blank');
                    selectIcon.setAttribute('aria-hidden', 'true');
                    row.prepend(selectIcon);
                }
                row.setAttribute('aria-selected', String(selected));
                row.addEventListener('click', (event) => run(async () => {
                    if (event.target.closest('.agent-chat-session-menu, .agent-chat-session-actions')) return;
                    if (state.topicManaging) {
                        if (!selectable) return;
                        if (state.topicSelectedIds.has(topic.id)) state.topicSelectedIds.delete(topic.id);
                        else state.topicSelectedIds.add(topic.id);
                        renderSidebar();
                        return;
                    }
                    await openTopicFlow(topic);
                }));
                if (!state.topicManaging && !topic.inUse) appendTopicActions(row, topic);
                list.append(row);
            }
            const applyTopicFilter = () => {
                const query = search.value.trim().toLocaleLowerCase();
                state.topicSearch = search.value;
                for (const row of list.querySelectorAll('[data-topic-search]')) {
                    row.hidden = Boolean(query) && !row.dataset.topicSearch.includes(query);
                }
            };
            search.addEventListener('input', applyTopicFilter);
            applyTopicFilter();
            const scroll = node('div', 'sidebar-list-scroll');
            scroll.append(list);
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
                    await refreshControlPlane();
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
                avatar.className = 'avatar'; avatar.src = 'assets/default_avatar.png'; avatar.alt = '';
                row.append(avatar, node('span', 'agent-name', agent.name || agentId));
                row.addEventListener('click', () => run(async () => {
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
            settingsPane.append(node('p', 'agent-chat-settings-placeholder', '这些字段只用于下一次新建 Session；真实凭据仍由 VCPChat 共享设置安全保存。'));
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
            settingsForm.append(
                field('工作目录（可留空）', state.workspace, (value) => { state.workspace = value; }),
                field('Agent', state.selectedAgent, (value) => { state.selectedAgent = value; }, state.agentCatalog.map((agent) => ({ value: agent.id || agent.name, label: agent.name || agent.id }))),
                field('模型', state.model, (value) => { state.model = value; }, state.modelCatalog.map((model) => ({ value: model.id, label: model.id }))),
                field('本地工具审批', state.permissionMode, (value) => { state.permissionMode = value === 'always-approve' ? 'always-approve' : 'ask'; }, [
                    { value: 'ask', label: '每次确认（推荐）' },
                    { value: 'always-approve', label: 'YOLO：本地自动允许' },
                ]),
            );
            const permissionHint = node('p', 'agent-chat-settings-placeholder',
                'YOLO 仅跳过本地审批；VCPToolBox 的后端审批不会被关闭或绕过。保存后，对下一次新建或恢复的 Agent Session 生效。');
            const savePermission = button(state.permissionSaving ? '正在保存…' : '保存本地审批策略', 'secondary agent-chat-settings-save');
            savePermission.disabled = state.permissionSaving;
            savePermission.addEventListener('click', () => run(async () => {
                state.permissionSaving = true;
                renderSidebar();
                try {
                    const saved = await controller.updateWorkbenchSettings({ permissionMode: state.permissionMode });
                    state.permissionMode = saved?.settings?.permissionMode === 'always-approve' ? 'always-approve' : 'ask';
                    notify(state.permissionMode === 'always-approve'
                        ? '本地 YOLO 已保存；下一次新建或恢复 Session 后生效。ToolBox 后端审批仍独立。'
                        : '已恢复逐次本地确认；下一次新建或恢复 Session 后生效。', 'success');
                } finally {
                    state.permissionSaving = false;
                    renderSidebar();
                    renderHeader();
                }
            }));
            const save = button('用此配置新建会话', 'primary agent-chat-settings-save');
            save.addEventListener('click', openNewTopicFlow);
            settingsForm.append(permissionHint, savePermission, save);
            settingsPane.append(settingsForm);
            content.append(settingsPane);
        }
        sidebar.append(tabs, content, createAccountDock(state));
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
            const title = node('h2', 'agent-chat-topic-flow-title', '新建 Agent Topic');
            title.id = 'agentChatTopicFlowTitle';
            const description = node('p', 'agent-chat-topic-flow-description',
                '选择 VCPChat 共享的 Agent 与模型；工作目录只会传给 Rust daemon 作为本次 Topic 的 workspace。');
            const context = node('section', 'agent-chat-topic-flow-context');
            context.setAttribute('aria-label', 'Topic 创建配置来源');
            const addContext = (label, value) => {
                const item = node('div', 'agent-chat-topic-flow-context-item');
                item.append(node('span', 'agent-chat-topic-flow-context-label', label), node('strong', 'agent-chat-topic-flow-context-value', value));
                context.append(item);
            };
            addContext('Agent', flow.agent || '尚未选择（共享 VCPChat Agent 目录）');
            addContext('模型', flow.model || '尚未选择（可输入共享模型 ID）');
            addContext('工作目录', flow.workspaceRoot || '未指定（由 Rust daemon 使用当前 workspace）');
            const form = node('form', 'agent-chat-topic-flow-form');
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                run(async () => {
                    if (!state.topicFlow || state.topicFlow.kind !== 'create') return;
                    state.topicFlow = { ...state.topicFlow, saving: true };
                    queueRender({ topicFlow: true });
                    try {
                        const created = await createSession({
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
        } else {
            const topic = flow.topic || {};
            const title = node('h2', 'agent-chat-topic-flow-title', topic.title || topic.id || '打开 Agent Topic');
            title.id = 'agentChatTopicFlowTitle';
            const lease = node('div', `agent-chat-topic-flow-lease ${topic.inUse ? 'is-occupied' : 'is-idle'}`);
            lease.setAttribute('role', 'status');
            lease.append(
                ...icon(topic.inUse ? 'lock' : 'lock_open'),
                node('span', '', topic.inUse ? '占用中：仅可读取 checkpoint 或请求安全接管' : '空闲：可恢复为新的可写 attachment'),
            );
            const status = node('p', `agent-chat-topic-flow-status ${topic.inUse ? 'is-busy' : 'is-ready'}`,
                topic.inUse ? '此 Topic 正由另一客户端写入。可读取最近 checkpoint，但必须明确接管后才能写入。' : '此 Topic 当前空闲，可从 Rust checkpoint 恢复为新的可写 attachment。');
            const details = node('dl', 'agent-chat-topic-flow-details');
            const addDetail = (label, value) => {
                if (value == null || value === '') return;
                details.append(node('dt', '', label), node('dd', '', String(value)));
            };
            addDetail('Topic ID', topic.id);
            addDetail('Agent', topic.agentId || state.selectedAgent || 'Nova');
            addDetail('模型', topic.model || '未知');
            addDetail('工作目录', topic.workspaceRef || '未记录');
            addDetail('最近更新', formatTime(topic.updatedAt));
            dialog.append(title, lease, status, details);
            if (flow.loading) {
                dialog.append(node('p', 'agent-chat-topic-flow-loading', '正在从 Rust Topic Store 读取最近的安全 checkpoint…'));
            } else if (flow.error) {
                dialog.append(node('p', 'agent-chat-topic-flow-error', `无法读取该 Topic：${flow.error}`));
            } else {
                const messageCount = Array.isArray(flow.snapshot?.history) ? flow.snapshot.history.length : 0;
                dialog.append(node('p', 'agent-chat-topic-flow-checkpoint',
                    messageCount ? `已读取 Rust checkpoint：${messageCount} 条可见消息。` : '该 Topic 尚无可见 checkpoint；打开后将保持空白历史。'));
            }
            const actions = node('div', 'agent-chat-topic-flow-actions');
            const close = button('取消', 'secondary');
            close.addEventListener('click', closeTopicFlow);
            actions.append(close);
            if (!flow.loading && !flow.error) {
                if (topic.inUse) {
                    const preview = button('只读查看 checkpoint', 'secondary');
                    preview.addEventListener('click', () => run(async () => {
                        closeTopicFlow();
                        await previewOccupiedTopic(topic);
                    }));
                    const takeover = button('请求安全接管', 'primary');
                    takeover.addEventListener('click', () => run(async () => {
                        closeTopicFlow();
                        await requestTopicTakeover(topic);
                    }));
                    actions.append(preview, takeover);
                } else {
                    const open = button('打开并恢复', 'primary');
                    open.addEventListener('click', () => run(async () => {
                        closeTopicFlow();
                        await createSession({
                            resume: topic.id,
                            title: topic.title,
                            model: topic.model,
                            agent: topic.agentId,
                            workspaceRoot: topic.workspaceRef,
                        });
                    }));
                    actions.append(open);
                }
            }
            dialog.append(actions);
        }
        topicFlowLayer.append(backdrop, dialog);
        // A microtask avoids stealing the click that opened the dialog while
        // still providing predictable keyboard focus for the next action.
        queueMicrotask(() => dialog.focus());
    }

    function renderHeader() {
        header.replaceChildren();
        const session = activeSession() || (state.previewTopic ? { title: state.previewTopic.title || state.previewTopic.id } : null);
        const current = store.getState();
        const viewState = deriveWorkbenchViewState(current);
        const left = node('h3', 'agent-chat-title', session?.title || `与 ${state.selectedAgent || 'Nova'} 聊天中`);
        // R3 fixed lifecycle state chip — single source of truth for the
        // Workbench's connection/execution phase, surfaced in the header.
        const statusChip = node('span', 'agent-chat-status-chip', WORKBENCH_VIEW_STATE_LABELS[viewState] || viewState);
        statusChip.dataset.state = viewState;
        statusChip.setAttribute('role', 'status');
        statusChip.setAttribute('aria-live', 'polite');
        statusChip.dataset.action = 'connection';
        statusChip.title = '查看连接状态';
        statusChip.addEventListener('click', () => setActivityOpen(true, 'connection'));
        const actions = node('div', 'chat-actions agent-chat-header-actions');
        // R3 header action cluster: every button is a uniform ghost-muted icon
        // button (opencode icon-button-v2 / Cherry NavbarIcon spec) so the
        // title | status chip | actions row stays aligned regardless of source.
        const isDark = document.body.classList.contains('dark-theme');
        const assistant = iconButton('assistant', '划词助手开关与呼出', 'agent-chat-header-assistant');
        assistant.addEventListener('click', () => proxyMainButton('toggleAssistantBtn'));
        const pendingApprovals = (store.getState().approvals || []).length;
        const alertState = viewState === 'error' || viewState === 'reconnecting';
        const activityBtn = iconButton('notifications', state.activityOpen ? '关闭活动面板' : '打开活动面板', 'agent-chat-header-activity');
        activityBtn.classList.toggle('is-active', state.activityOpen);
        activityBtn.setAttribute('aria-expanded', String(state.activityOpen));
        activityBtn.setAttribute('aria-controls', 'agentChatActivityPanel');
        if (pendingApprovals) {
            activityBtn.append(node('span', 'agent-chat-action-badge', String(pendingApprovals)));
        } else if (alertState) {
            activityBtn.append(node('span', 'agent-chat-action-badge is-warning', '!'));
        }
        activityBtn.addEventListener('click', () => setActivityOpen(!state.activityOpen));
        const permissionLabel = state.permissionMode === 'always-approve' ? '本地审批：YOLO（设置）' : '本地审批：逐次确认（设置）';
        const permissions = iconButton('policy', permissionLabel, 'agent-chat-header-permissions');
        permissions.classList.toggle('is-active', state.permissionMode === 'always-approve');
        permissions.addEventListener('click', () => {
            state.tab = 'settings';
            queueRender({ shell: true });
        });
        const theme = iconButton(isDark ? 'light_mode' : 'dark_mode', '深色/浅色模式', 'agent-chat-header-theme');
        theme.addEventListener('click', () => proxyMainButton('themeToggleBtn'));
        const queueButton = iconButton('queue_play_next', state.queue.length ? `后续指令（${state.queue.length}）` : '后续指令', 'agent-chat-queue-toggle');
        queueButton.setAttribute('aria-expanded', String(state.queueOpen));
        queueButton.addEventListener('click', () => {
            state.queueOpen = !state.queueOpen;
            renderHeader();
        });
        const usage = store.getState().context;
        const usageLabel = usage.requests ? `用量（${usage.requests} 轮）` : '用量';
        const usageButton = iconButton('data_usage', usageLabel, 'agent-chat-usage-toggle');
        const usageExpanded = state.activityOpen && state.activityTab === 'usage';
        usageButton.setAttribute('aria-expanded', String(usageExpanded));
        usageButton.addEventListener('click', () => {
            if (state.activityOpen && state.activityTab === 'usage') setActivityOpen(false);
            else setActivityOpen(true, 'usage');
        });
        const compact = iconButton('compress', usage.compacting ? '正在安全压缩上下文' : '压缩当前 Agent 上下文', 'agent-chat-compact');
        compact.disabled = !session || Boolean(usage.compacting);
        compact.addEventListener('click', () => run(async () => {
            if (!session) return;
            const result = await controller.compactSession(session.sessionId);
            const before = Number(result?.compaction?.beforeTokens || 0);
            const after = Number(result?.compaction?.afterTokens || 0);
            notify(before && after ? `上下文已完成压缩：${before} -> ${after} tokens。` : '上下文已完成压缩并刷新会话历史。', 'success');
        }));
        const newSession = iconButton('add_comment', '新建 Agent 会话');
        newSession.addEventListener('click', openNewTopicFlow);
        actions.append(assistant, activityBtn, permissions, theme, queueButton, usageButton, compact, newSession);
        header.append(left, statusChip, actions);
        if (state.previewTopic) {
            const banner = node('div', 'agent-chat-readonly-banner');
            banner.append(node('span', '', `此 Topic「${state.previewTopic.title || state.previewTopic.id}」正被另一客户端占用，当前为只读预览。`));
            const takeover = button('接管此 Topic', 'agent-chat-readonly-takeover');
            takeover.addEventListener('click', () => run(async () => {
                const topic = state.previewTopic;
                state.previewTopic = null;
                await requestTopicTakeover(topic);
            }));
            const exit = button('退出预览', 'agent-chat-readonly-exit');
            exit.addEventListener('click', () => run(clearPreview));
            banner.append(takeover, exit);
            header.append(banner);
        }
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
        // Preserve a reader's position during non-delta control updates. A
        // conversation should follow live output only when the reader was
        // already at the bottom; ToolBox status, approvals and Topic refreshes
        // must not pull someone away from an older tool result.
        const follow = isFollowingContainer(feed);
        feedItems.replaceChildren();
        const current = store.getState();
        if (!current.attachment?.sessionId) {
            feedItems.append(node('div', 'agent-chat-empty-conversation', '创建一个真实 Agent 会话，即可开始与 VCPToolBox 协作。'));
            return;
        }

        // Group tool cards by turnId so they interleave with messages correctly:
        // user message → tool cards for same turn → assistant message.
        const toolsByTurn = new Map();
        for (const [, tool] of current.tools) {
            const tid = tool.turnId || '';
            if (!toolsByTurn.has(tid)) toolsByTurn.set(tid, []);
            toolsByTurn.get(tid).push(tool);
        }

        const emittedToolTurns = new Set();
        for (const message of current.messages) {
            feedItems.append(createMessage(message));
            if (message.role === 'user') {
                const tid = message.turnId || '';
                if (!emittedToolTurns.has(tid) && toolsByTurn.has(tid)) {
                    emittedToolTurns.add(tid);
                    for (const tool of toolsByTurn.get(tid)) feedItems.append(createToolCard(tool, (t) => run(() => controller.cancelTool(t.toolCallId, t.turnId))));
                }
            }
        }
        // Orphan tool cards (no matching user message found for this turnId)
        for (const [, tool] of current.tools) {
            if (!emittedToolTurns.has(tool.turnId || '')) feedItems.append(createToolCard(tool, (t) => run(() => controller.cancelTool(t.toolCallId, t.turnId))));
        }

        // R3: approvals and VCPToolBox observer events no longer pollute the
        // main chat. They live in the dedicated activity side panel
        // (renderActivity), which keeps the conversation flow readable while
        // still surfacing actionable approvals behind a badge.
        if (!current.messages.length && !current.tools.size) feedItems.append(node('div', 'agent-chat-empty-conversation', '会话已就绪，发送第一条消息开始。'));
        scrollFeed(feed, follow);
    }

    function setActivityOpen(open, tab) {
        if (open && tab) state.activityTab = tab;
        state.activityOpen = open;
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

    // Surface the activity panel automatically on state transitions the user
    // must notice: a daemon error, or the first pending approval arriving.
    // Rust Host remains responsible for fail-closed expiry even while this
    // panel is collapsed; the renderer ticker only refreshes visible labels.
    function maybeAutoOpenActivity() {
        const current = store.getState();
        const viewState = deriveWorkbenchViewState(current);
        const approvalsCount = (current.approvals || []).length;
        if (viewState === 'error' && state.lastViewState !== 'error') {
            setActivityOpen(true, 'connection');
        } else if (approvalsCount > 0 && !state.hadApprovals && !state.activityOpen) {
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
            const message = String(rawError || 'Rust Agent daemon 已中断').slice(0, 280);
            card.append(node('p', 'agent-chat-connection-message', message));
            const reconnect = button('重新连接', 'primary agent-chat-connection-reconnect');
            reconnect.addEventListener('click', () => run(recoverDaemon));
            card.append(reconnect);
        } else if (viewState === 'reconnecting') {
            card.append(node('p', 'agent-chat-connection-message', 'Agent 正在重新连接并校验最近的安全 checkpoint…'));
        } else {
            card.append(node('p', 'agent-chat-connection-message', WORKBENCH_VIEW_STATE_LABELS[viewState] || viewState));
        }
        wrap.append(card);
        const readiness = current.readiness || {};
        const readinessGrid = node('section', 'agent-chat-readiness-grid');
        readinessGrid.setAttribute('aria-label', 'Rust Agent readiness');
        const readinessEntries = [
            ['server', 'VCP Server / API Key'],
            ['profile', '共享 Agent / 模型'],
            ['toolbox', 'VCPToolBox'],
            ['capability', 'DistributedServer capability node'],
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
            const item = readiness[key] || { state: 'unknown', detail: '等待 Rust daemon 状态事件' };
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
        const hasUsage = usage.usageAvailable;
        const total = hasUsage ? usage.totalTokens : null;
        const totalText = total != null ? format(total) : placeholder;
        const contextPct = usage.contextWindow ? usage.percentage : null;

        const summary = node('div', 'agent-chat-usage-summary');
        const totalChip = node('div', 'agent-chat-usage-metric');
        totalChip.append(node('span', 'agent-chat-usage-label', 'Tokens'), node('span', 'agent-chat-usage-value', totalText));
        if (contextPct != null) totalChip.append(node('span', 'agent-chat-usage-pill', `${contextPct}%`));
        summary.append(totalChip);

        const costChip = node('div', 'agent-chat-usage-metric');
        costChip.append(node('span', 'agent-chat-usage-label', '费用'), node('span', 'agent-chat-usage-value', placeholder));
        summary.append(costChip);
        wrap.append(summary);

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
        wrap.append(stats);

        wrap.append(node('p', 'agent-chat-usage-note', '费用没有可靠价格表，暂显示为占位符。'));

        const budgetForm = node('form', 'agent-chat-usage-budget');
        budgetForm.addEventListener('submit', (event) => {
            event.preventDefault();
            run(async () => {
                const data = new window.FormData(budgetForm);
                state.budgetSaving = true;
                renderActivity();
                try {
                    const saved = await controller.updateWorkbenchSettings({
                        budget: {
                            maxRequestsPerTurn: String(data.get('maxRequestsPerTurn') || '').trim() || null,
                            maxTokensPerTurn: String(data.get('maxTokensPerTurn') || '').trim() || null,
                        },
                    });
                    state.budget = saved?.settings?.budget || state.budget;
                    notify('预算已保存；为避免改变正在运行的限制，新建 Agent Session 后生效。', 'success');
                } finally {
                    state.budgetSaving = false;
                    renderActivity();
                }
            });
        });
        budgetForm.append(node('strong', 'agent-chat-usage-budget-title', '每轮安全预算'));
        const budgetHint = node('p', 'agent-chat-usage-note', '留空表示不设客户端上限。保存后新建会话生效。');
        const budgetFields = node('div', 'agent-chat-usage-budget-fields');
        const budgetField = (label, name, value, placeholder) => {
            const field = node('label', 'agent-chat-usage-budget-field');
            field.append(node('span', '', label));
            const control = document.createElement('input');
            control.type = 'number';
            control.name = name;
            control.min = '1';
            control.max = '100000000';
            control.step = '1';
            control.inputMode = 'numeric';
            control.placeholder = placeholder;
            control.value = value == null ? '' : String(value);
            control.disabled = state.budgetSaving;
            field.append(control);
            return field;
        };
        budgetFields.append(
            budgetField('模型请求', 'maxRequestsPerTurn', state.budget.maxRequestsPerTurn, '不限'),
            budgetField('累计 token', 'maxTokensPerTurn', state.budget.maxTokensPerTurn, '不限'),
        );
        const saveBudget = button(state.budgetSaving ? '保存中…' : '保存预算', 'primary agent-chat-usage-budget-save');
        saveBudget.type = 'submit';
        saveBudget.disabled = state.budgetSaving;
        budgetForm.append(budgetHint, budgetFields, saveBudget);
        wrap.append(budgetForm);

        return wrap;
    }

    function renderActivity() {
        if (state.disposed) return;
        const current = store.getState();
        activityPanel.replaceChildren();
        const inner = node('div', 'agent-chat-activity-inner');

        const panelHeader = node('div', 'agent-chat-activity-header');
        panelHeader.append(node('strong', 'agent-chat-activity-title', '活动'));
        const closeBtn = iconButton('close', '关闭活动面板', 'agent-chat-activity-close');
        closeBtn.addEventListener('click', () => setActivityOpen(false));
        panelHeader.append(closeBtn);

        const pendingApprovals = (current.approvals || []).length;
        const tabDefs = [
            ['activity', '工具活动'],
            ['approvals', pendingApprovals ? `审批 (${pendingApprovals})` : '审批'],
            ['usage', '用量'],
            ['connection', '连接'],
        ];
        const tabs = node('div', 'agent-chat-activity-tabs');
        tabs.setAttribute('role', 'tablist');
        for (const [id, label] of tabDefs) {
            const tab = node('button', `agent-chat-activity-tab${state.activityTab === id ? ' is-active' : ''}`, label);
            tab.type = 'button';
            tab.dataset.tab = id;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(state.activityTab === id));
            tab.addEventListener('click', () => { state.activityTab = id; renderActivity(); });
            tabs.append(tab);
        }

        const content = node('div', 'agent-chat-activity-content');
        content.setAttribute('role', 'tabpanel');
        const viewState = deriveWorkbenchViewState(current);

        if (state.activityTab === 'connection') {
            content.append(buildConnectionPanel(current, viewState));
        } else if (state.activityTab === 'approvals') {
            if (!pendingApprovals) {
                content.append(node('div', 'agent-chat-activity-empty', '没有待确认的本地审批。'));
            } else {
                for (const approval of current.approvals) {
                    content.append(createApprovalCard(approval, (item, decision) => {
                        approvalRegistry.delete(item.approvalId);
                        run(() => controller.respondApproval(item, decision));
                    }, approvalRegistry, ensureApprovalTicker));
                }
            }
        } else if (state.activityTab === 'usage') {
            content.append(buildUsagePanel(current));
        } else {
            const ws = current.toolboxWs || [];
            if (!ws.length) {
                content.append(node('div', 'agent-chat-activity-empty', '暂无 VCPToolBox 观察者事件。'));
            } else {
                for (const observation of ws) content.append(createToolboxWsCard(observation));
            }
        }

        inner.append(panelHeader, tabs, content);
        activityPanel.append(inner);
    }

    function patchStreamingFeed(event) {
        const current = store.getState();
        const messageId = event.messageId;
        if (!messageId) return;
        const message = current.messages.find((item) => {
            const projected = projectMessage(item);
            return projected.id === messageId
                || (projected.turnId === event.turnId && projected.role === 'assistant');
        });
        if (!message) return;
        const follow = isFollowingContainer(feed);
        let row = [...feedItems.querySelectorAll('[data-message-id]')]
            .find((candidate) => candidate.dataset.messageId === messageId);
        if (!row) {
            row = createMessage(message);
            // Assistant messages belong after any tool cards for the same turn,
            // so append at the end of the feed rather than inserting before them.
            feedItems.append(row);
        } else {
            patchMessage(row, message);
        }
        if (follow) scrollFeed(feed, true);
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
        });
    }

    function renderForStoreEvent(event) {
        if (!event?.type) {
            queueRender({ shell: true, header: true, feed: true, composer: true });
            return;
        }
        if (event.type === 'assistant.delta' || event.type === 'reasoning.delta') {
            // Delta events are the hot path.  Preserve focus, scroll anchors,
            // expanded tool cards and pending approval buttons by changing
            // only the matching assistant node.
            patchStreamingFeed(event);
            return;
        }
        if (event.type === 'interaction.consumed') {
            // Rust Core is authoritative for consumption order.  Reload the
            // bounded queue projection rather than guessing which item moved
            // at a tool-safe boundary.
            void refreshControlPlane();
            queueRender({ header: true, composer: true });
            return;
        }
        if (event.type.startsWith('tool.') || event.type.startsWith('approval.')
            || event.type === 'assistant.started' || event.type === 'assistant.completed'
            || event.type === 'user.message' || event.type.startsWith('turn.')) {
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

    function renderComposer() {
        const current = store.getState();
        const viewState = deriveWorkbenchViewState(current);
        // The composer is live only when the fixed R3 lifecycle state machine
        // reports the agent as idle, running, or parked on an actionable
        // approval — never while it is starting, reconnecting, or down.
        const composerReady = Boolean(current.attachment?.sessionId
            && (viewState === 'idle' || viewState === 'running' || viewState === 'awaiting-approval'));
        const canSend = Boolean(composerReady && state.prompt.trim());
        const hasActiveTurn = Boolean(current.activeTurnId);
        const interruptMode = Boolean(hasActiveTurn && !canSend);
        input.value = state.prompt;
        input.disabled = !composerReady;
        sendButton.disabled = !composerReady;
        // Keep the main chat's original SVG / icon hierarchy intact.  Replacing
        // it on every streaming update was the source of the wrong button size.
        sendButton.title = hasActiveTurn
            ? (canSend ? '追加后续指令；使用 /steer <内容> 立即调整当前任务' : '任务运行中；空输入时点击取消')
            : '发送消息';
        sendButton.setAttribute('aria-label', interruptMode ? '取消当前任务' : '发送消息');
        const sendIcon = sendButton.querySelector('.vcp-ui-icon');
        if (sendIcon) sendIcon.textContent = interruptMode ? 'stop' : 'arrow_upward';
        input.placeholder = state.previewTopic
            ? '只读预览中：此 Topic 正被占用，无法发送消息。点击「接管」以获得写入权限。'
            : (viewState === 'reconnecting' || viewState === 'error')
            ? '正在重新连接 Rust Agent…'
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
    }

    function render() {
        if (state.disposed) return;
        renderSidebar();
        renderHeader();
        renderFeed();
        renderActivity();
        renderComposer();
        renderTopicFlow();
    }

    input.addEventListener('input', () => { state.prompt = input.value; renderComposer(); });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendButton.click(); }
    });
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
        if (!prompt) return;
        state.prompt = '';
        renderComposer();
        await controller.startTurn(prompt);
    }));
    newButton.addEventListener('click', openNewTopicFlow);

    const unsubscribe = store.subscribe((_nextState, event) => renderForStoreEvent(event));
    render();
    controller.initialize()
        .then(async () => {
            const runtime = store.getState().runtime;
            if (runtime.state === 'stopped' || runtime.state === 'unknown') await controller.startRuntime();
            await refreshControlPlane();
            // A renderer reload does not own the transcript.  If Main has no
            // live daemon session (for example after the app restarted), use
            // the remembered Topic pointer to reattach to the Rust checkpoint.
            // We only auto-resume a free Topic; another live client must opt
            // into the explicit takeover flow instead.
            if (!store.getState().attachment?.sessionId && state.rememberedTopic?.topicId) {
                const topic = state.topics.find((item) => item.id === state.rememberedTopic.topicId);
                if (topic && !topic.inUse) {
                    await createSession({
                        resume: topic.id,
                        title: topic.title,
                        model: topic.model,
                        agent: topic.agentId,
                        workspaceRoot: topic.workspaceRef,
                    });
                }
            }
        })
        .catch((error) => notify(`Agent Runtime 无法启动：${error?.message || error}`, 'error'));

    return () => {
        state.disposed = true;
        if (renderFrame !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(renderFrame);
        state.accountThemeObserver?.disconnect();
        unsubscribe();
        controller.dispose();
        root.remove();
        topicFlowLayer.remove();
    };
}

register({
    id: 'agent-workbench',
    title: 'VCP Agent',
    icon: 'smart_toy',
    kind: 'internal',
    mount: mountWorkbench,
});
