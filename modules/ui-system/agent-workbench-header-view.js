import { button, iconButton, node } from './agent-workbench-dom.js';

function createContextRing(document, percentage) {
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.classList.add('agent-chat-context-ring');
    ring.setAttribute('viewBox', '0 0 36 36');
    ring.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.classList.add('agent-chat-context-ring-track');
    track.setAttribute('cx', '18');
    track.setAttribute('cy', '18');
    track.setAttribute('r', '15.5');
    const value = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    value.classList.add('agent-chat-context-ring-value');
    value.setAttribute('cx', '18');
    value.setAttribute('cy', '18');
    value.setAttribute('r', '15.5');
    value.setAttribute('pathLength', '100');
    value.setAttribute('stroke-dasharray', `${percentage} 100`);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.classList.add('agent-chat-context-ring-core');
    text.setAttribute('x', '18');
    text.setAttribute('y', '21');
    text.setAttribute('text-anchor', 'middle');
    text.textContent = percentage ? String(Math.round(percentage)) : '';
    ring.append(track, value, text);
    return ring;
}

function createAgentWorkbenchHeaderView({ element, document = globalThis.document, actions = {} }) {
    function update(model = {}) {
        element.replaceChildren();
        const title = node('h3', 'agent-chat-title', model.title || '', document);
        const statusChip = node('span', 'agent-chat-status-chip', model.stateLabel || model.state || '', document);
        statusChip.dataset.state = model.state || 'idle';
        statusChip.setAttribute('role', 'status');
        statusChip.setAttribute('aria-live', 'polite');
        if (model.state === 'error') {
            statusChip.setAttribute('role', 'button');
            statusChip.tabIndex = 0;
            statusChip.title = '点击重新连接';
            const reconnect = () => actions.reconnect?.();
            statusChip.addEventListener('click', reconnect);
            statusChip.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                reconnect();
            });
        } else statusChip.title = '当前运行状态';

        const controls = node('div', 'chat-actions agent-chat-header-actions', undefined, document);
        const activityButton = iconButton(
            'notifications',
            model.activityOpen ? '关闭活动面板' : '打开活动面板',
            'agent-chat-header-activity',
            document,
        );
        activityButton.classList.toggle('is-active', Boolean(model.activityOpen));
        activityButton.setAttribute('aria-expanded', String(Boolean(model.activityOpen)));
        activityButton.setAttribute('aria-controls', 'agentChatActivityPanel');
        if (model.pendingApprovals) {
            activityButton.append(node('span', 'agent-chat-action-badge', String(model.pendingApprovals), document));
        } else if (model.activityUnread) {
            activityButton.append(node('span', 'agent-chat-action-badge', String(Math.min(99, model.activityUnread)), document));
        } else if (model.alert) {
            activityButton.append(node('span', 'agent-chat-action-badge is-warning', '!', document));
        }
        activityButton.addEventListener('click', () => actions.toggleActivity?.());

        let queueButton = null;
        if (!model.codexRuntime) {
            queueButton = iconButton(
                'queue_play_next',
                model.queueLength ? `后续指令（${model.queueLength}）` : '后续指令',
                'agent-chat-queue-toggle',
                document,
            );
            queueButton.setAttribute('aria-expanded', String(Boolean(model.queueOpen)));
            queueButton.addEventListener('click', () => actions.toggleQueue?.());
        }

        const usage = model.usage || {};
        const contextPct = Number.isFinite(Number(usage.percentage))
            ? Math.max(0, Math.min(100, Number(usage.percentage)))
            : 0;
        const usageButton = button('', 'agent-chat-usage-toggle agent-chat-context-toggle', document);
        usageButton.append(createContextRing(document, contextPct));
        usageButton.title = usage.contextWindow
            ? `上下文 ${contextPct}% · ${Number(usage.usedTokens || 0).toLocaleString('zh-CN')} / ${Number(usage.contextWindow).toLocaleString('zh-CN')} tokens`
            : '查看上下文、用量与会话信息';
        usageButton.setAttribute('aria-label', usageButton.title);
        usageButton.classList.toggle('is-active', Boolean(model.contextExpanded));
        usageButton.setAttribute('aria-expanded', String(Boolean(model.contextExpanded)));
        usageButton.addEventListener('click', () => actions.toggleContext?.());

        const compact = iconButton(
            'compress',
            usage.compacting ? '正在安全压缩上下文' : '压缩当前 Agent 上下文',
            'agent-chat-compact',
            document,
        );
        compact.disabled = !model.hasSession || Boolean(usage.compacting);
        compact.addEventListener('click', () => actions.compact?.());
        controls.append(activityButton, ...(queueButton ? [queueButton] : []), usageButton, compact);
        element.append(title, statusChip, controls);
        if (model.queuePanel) element.append(model.queuePanel);
    }

    return { element, update, dispose() { element.replaceChildren(); } };
}

export { createAgentWorkbenchHeaderView };
