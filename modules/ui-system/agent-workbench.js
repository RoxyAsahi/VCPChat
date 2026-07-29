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

// R3: an Agent approval is fail-closed.  If the user does not act within this
// window the Workbench auto-denies instead of leaving a tool call hanging.
const APPROVAL_TIMEOUT_MS = 30_000;

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

function cloneMainButton(selector, label, onClick, className = '') {
    const source = document.querySelector(selector);
    const value = source?.cloneNode(true) || iconButton('more_horiz', label);
    value.removeAttribute('id');
    value.removeAttribute('style');
    value.disabled = false;
    value.title = label;
    value.setAttribute('aria-label', label);
    if (className) value.classList.add(className);
    value.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    value.addEventListener('click', (event) => {
        event.preventDefault();
        onClick?.(event, value);
    });
    return value;
}

function proxyMainButton(id) {
    document.getElementById(id)?.click();
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

function createAccountDock() {
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
    // Fallback: plain collapsible details
    return `<details class="agent-chat-reasoning"><summary>推理过程</summary><pre>${
        String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    }</pre></details>`;
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
    const completed = item.state === 'complete';
    if (completed) {
        bubble?.classList.remove('expanded');
        reasoningEl.classList.add('is-complete');
        const start = reasoningStartTimes.get(item.id);
        if (start != null) {
            const secs = Math.max(0, (performance.now() - start) / 1000);
            const label = reasoningEl.querySelector('.vcp-thought-chain-label');
            if (label && !label.dataset.timed) {
                label.insertAdjacentHTML('beforeend', ` <span class="agent-chat-reasoning-time">· 思考 ${secs.toFixed(1)}s</span>`);
                label.dataset.timed = '1';
            }
            reasoningStartTimes.delete(item.id);
        }
    } else {
        bubble?.classList.add('expanded');
        if (!reasoningStartTimes.has(item.id)) reasoningStartTimes.set(item.id, performance.now());
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
    card.append(countdown);

    const actions = node('div', 'agent-chat-approval-actions');
    const deny = button('拒绝', 'danger');
    const allow = button('允许一次', 'secondary');
    const decide = (decision) => {
        registry?.delete(approval.approvalId);
        onDecision(approval, decision);
    };
    deny.addEventListener('click', () => decide('deny'));
    allow.addEventListener('click', () => decide('allow'));
    actions.append(deny, allow);
    card.append(actions);

    // Fail-closed countdown: register so the global ticker can auto-deny at the
    // deadline and keep the label fresh across feed re-renders.
    if (!approval._deadline) approval._deadline = Date.now() + APPROVAL_TIMEOUT_MS;
    if (registry && !registry.has(approval.approvalId)) {
        registry.set(approval.approvalId, { approval, onDecision, deadline: approval._deadline, expired: false });
        ensureTicker?.();
    }
    const remaining = Math.max(0, Math.ceil((approval._deadline - Date.now()) / 1000));
    countdown.textContent = `默认拒绝 · ${remaining}s 后自动生效`;
    return card;
}

function mountWorkbench(container) {
    const controller = createWorkbenchController(runtimeApi());
    const { store } = controller;
    const state = {
        tab: 'agents',
        selectedAgent: 'Nova',
        agentCatalog: [],
        modelCatalog: [],
        topics: [],
        topicSearch: '',
        queue: [],
        queueOpen: false,
        budget: { maxRequestsPerTurn: null, maxTokensPerTurn: null },
        budgetSaving: false,
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
        disposed: false,
    };
    const pendingRender = { shell: false, header: false, feed: false, composer: false, activity: false };
    let renderFrame = null;

    const root = node('section', 'container agent-chat-root vcp-ui-scope');
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
    const newButton = cloneMainButton('#quickNewTopicBtn', '新建 Agent 会话');
    const attachButton = cloneMainButton('#attachFileBtn', '附件暂不支持；文件操作请由 VCPToolBox 工具完成');
    const emoticonButton = cloneMainButton('#emoticonTriggerBtn', '打开表情包');
    const sendButton = cloneMainButton('#sendMessageBtn', '发送消息', null, 'agent-chat-send-button');
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
    container.append(root);

    const run = async (work) => {
        try { await work(); } catch (error) {
            // Browser DevTools otherwise renders an Error object as an opaque
            // `JSHandle@error`, which hides a daemon/control-plane failure
            // from both users and Electron smoke diagnostics.
            console.error('[Agent Workbench]', error?.stack || error?.message || String(error));
            notify(error?.message || String(error), 'error');
        }
    };

    // R3 approval lifecycle: one ticker drives every visible approval card's
    // fail-closed countdown and survives feed re-renders because each card is
    // keyed by approvalId in the DOM and re-found by the ticker each tick.
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
                            if (label) label.textContent = '已自动拒绝（超时）';
                            entry.onDecision(entry.approval, 'deny');
                        }
                    } else if (label) {
                        label.textContent = `默认拒绝 · ${Math.ceil(remaining / 1000)}s 后自动生效`;
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

    async function refreshControlPlane() {
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
        const nova = state.agentCatalog.find((agent) => agent.id === 'Nova' || agent.name === 'Nova');
        if (nova) {
            state.selectedAgent = nova.id || nova.name;
            state.model = nova.model || state.model;
        }
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
            optional(() => controller.listTopics()),
            optional(() => controller.listInteractionQueue()),
            optional(() => controller.getWorkbenchSettings()),
        ]);
        if (state.disposed) return;
        state.topics = Array.isArray(topics) ? topics : topics?.topics || [];
        state.queue = Array.isArray(queue) ? queue : queue?.items || queue?.queue || [];
        if (workbenchSettings && typeof workbenchSettings === 'object') {
            const budget = workbenchSettings.budget && typeof workbenchSettings.budget === 'object'
                ? workbenchSettings.budget : {};
            state.budget = {
                maxRequestsPerTurn: budget.maxRequestsPerTurn ?? null,
                maxTokensPerTurn: budget.maxTokensPerTurn ?? null,
            };
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
            resume: overrides.resume,
            title,
        });
        rememberTopic(session);
        state.tab = 'sessions';
        await refreshControlPlane();
        return session;
    }

    async function requestTopicTakeover(topic) {
        if (!topic?.id || state.takeoverTopicId) return;
        state.takeoverTopicId = topic.id;
        queueRender({ shell: true, header: true, composer: true });
        try {
            await controller.takeoverTopic(topic.id);
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
            await controller.previewTopic(topic.id);
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
                await controller.renameTopic(topic.id, title);
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
                await controller.deleteTopic(topic.id);
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
            tab.addEventListener('click', () => { state.tab = id; renderSidebar(); });
            tabs.append(tab);
        }
        const content = node('div', 'sidebar-tab-content active agent-chat-pane');
        if (state.tab === 'sessions') {
            const header = node('div', 'topics-header-container');
            const tools = node('div', 'next-ui-topic-tools');
            const add = node('button', 'next-ui-create-topic-trigger');
            add.type = 'button';
            add.append(...icon('add'), node('span', '', '新建会话'));
            add.addEventListener('click', () => run(() => createSession()));
            tools.append(add); header.append(tools); content.append(header);
            const list = node('ul', 'topic-list agent-chat-session-list');
            const search = document.createElement('input');
            search.type = 'search';
            search.className = 'agent-chat-search-input';
            search.placeholder = '搜索 Agent Topics';
            search.value = state.topicSearch;
            search.setAttribute('aria-label', '搜索 Agent Topics');
            content.append(search);
            const attachment = store.getState().attachment;
            const liveSessions = attachment ? [projectSession(attachment)] : [];
            const activeSessionId = attachment?.sessionId;
            const liveTopicIds = new Set(liveSessions.map((session) => session.topicId).filter(Boolean));
            const persistedTopics = state.topics.filter((topic) => !liveTopicIds.has(topic.id));
            if (!liveSessions.length && !persistedTopics.length) list.append(node('li', 'agent-chat-empty-list', '还没有 Agent 会话。创建一个会话后即可开始。'));
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
                row.addEventListener('click', () => run(() => controller.hydrateTopic(session.topicId, session)));
                list.append(row);
            }
            // Old conversations are Topics, not abandoned in-memory GUI
            // sessions.  Render them with the same main-chat row contract and
            // resume the bounded Rust checkpoint when selected.
            for (const topic of persistedTopics) {
                const row = node('li', `topic-item agent-chat-session-row agent-chat-persisted-topic${state.previewTopic?.id === topic.id ? ' previewing' : ''}`);
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
                row.addEventListener('click', (event) => run(async () => {
                    if (event.target.closest('.agent-chat-session-menu, .agent-chat-session-actions')) return;
                    if (topic.inUse) {
                        // Occupied Topic: open a read-only preview first; the
                        // user must explicitly choose takeover from the banner.
                        await previewOccupiedTopic(topic);
                        return;
                    }
                    await createSession({
                        resume: topic.id,
                        title: topic.title,
                        model: topic.model,
                        agent: topic.agentId,
                        workspaceRoot: topic.workspaceRef,
                    });
                }));
                if (!topic.inUse) appendTopicActions(row, topic);
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
        } else if (state.tab === 'agents') {
            const header = node('div', 'agents-header');
            const tools = node('div', 'next-ui-agent-tools');
            const add = node('button', 'next-ui-create-item-trigger');
            add.type = 'button';
            add.append(...icon('add'), node('span', '', '新建会话'));
            add.addEventListener('click', () => run(() => createSession()));
            tools.append(add);
            header.append(tools);
            content.append(header);
            const list = node('ul', 'agent-list agent-chat-agent-list');
            for (const agent of state.agentCatalog) {
                const agentId = agent.id || agent.name;
                const row = node('li', `agent-chat-agent-row${agentId === state.selectedAgent ? ' active' : ''}`);
                row.tabIndex = 0;
                const avatar = document.createElement('img');
                avatar.className = 'avatar'; avatar.src = 'assets/default_avatar.png'; avatar.alt = '';
                row.append(avatar, node('span', 'agent-name', agent.name || agentId));
                row.addEventListener('click', () => {
                    state.selectedAgent = agentId;
                    queueRender({ shell: true, header: true, composer: true });
                });
                list.append(row);
            }
            if (!state.agentCatalog.length) list.append(node('li', 'agent-chat-empty-list', '正在读取 Agent 目录…'));
            const scroll = node('div', 'sidebar-list-scroll');
            scroll.append(list);
            content.append(scroll);
        } else {
            content.append(node('p', 'agent-chat-settings-placeholder', '这些字段只用于下一次新建 Session；真实凭据仍由 VCPChat 共享设置安全保存。'));
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
            content.append(
                field('工作目录（可留空）', state.workspace, (value) => { state.workspace = value; }),
                field('Agent', state.selectedAgent, (value) => { state.selectedAgent = value; }, state.agentCatalog.map((agent) => ({ value: agent.id || agent.name, label: agent.name || agent.id }))),
                field('模型', state.model, (value) => { state.model = value; }, state.modelCatalog.map((model) => ({ value: model.id, label: model.id }))),
            );
            const save = button('用此配置新建会话', 'primary agent-chat-settings-save');
            save.addEventListener('click', () => run(() => createSession()));
            content.append(save);
        }
        sidebar.append(tabs, content, createAccountDock());
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
        statusChip.style.cursor = 'pointer';
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
        newSession.addEventListener('click', () => run(() => createSession()));
        actions.append(assistant, activityBtn, theme, queueButton, usageButton, compact, newSession);
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
    // Fail-closed approvals still auto-deny via the ticker even while the panel
    // is collapsed, because their cards stay in the DOM (just clipped).
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
            const fill = node('div', 'agent-chat-usage-context-fill');
            fill.style.width = `${Math.min(100, Math.max(0, usage.percentage || 0))}%`;
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
        input.value = state.prompt;
        input.disabled = !composerReady;
        sendButton.disabled = !composerReady;
        // Keep the main chat's original SVG / icon hierarchy intact.  Replacing
        // it on every streaming update was the source of the wrong button size.
        sendButton.title = hasActiveTurn
            ? (canSend ? '追加后续指令；使用 /steer <内容> 立即调整当前任务' : '任务运行中；空输入时点击取消')
            : '发送消息';
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
        sendButton.classList.toggle('is-ready', canSend || hasActiveTurn);
    }

    function render() {
        if (state.disposed) return;
        renderSidebar();
        renderHeader();
        renderFeed();
        renderActivity();
        renderComposer();
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
    newButton.addEventListener('click', () => run(() => createSession()));

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
        unsubscribe();
        controller.dispose();
        root.remove();
    };
}

register({
    id: 'agent-workbench',
    title: 'VCP Agent',
    icon: 'smart_toy',
    kind: 'internal',
    mount: mountWorkbench,
});
