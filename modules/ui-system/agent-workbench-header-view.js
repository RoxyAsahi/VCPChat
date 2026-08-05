import { button, iconButton, node } from './agent-workbench-dom.js';
import { createWorkbenchLifecycle } from './agent-workbench-lifecycle.js';

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

function createAgentWorkbenchHeaderView({
    element,
    document = globalThis.document,
    actions = {},
    lifecycle: injectedLifecycle,
}) {
    const lifecycle = injectedLifecycle || createWorkbenchLifecycle(globalThis);
    const ownsLifecycle = !injectedLifecycle;
    let lastModel = {};
    let editingSessionId = null;

    function formatElapsed(milliseconds) {
        const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
        return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
    }

    function updateStatusText() {
        const chip = element.querySelector('.agent-chat-status-chip');
        if (!chip || !lastModel.statusStartedAt && !lastModel.statusElapsedMs) return;
        const elapsed = lastModel.statusElapsedMs != null
            ? lastModel.statusElapsedMs
            : Date.now() - lastModel.statusStartedAt;
        const label = chip.querySelector('.agent-chat-status-label');
        const elapsedNode = chip.querySelector('.agent-chat-status-elapsed');
        if (label) label.textContent = lastModel.statusLabel || lastModel.stateLabel || lastModel.state || '';
        if (elapsedNode) elapsedNode.textContent = `${formatElapsed(elapsed)}`;
    }

    function restoreTitle() {
        editingSessionId = null;
        update(lastModel);
    }

    function startTitleEditor(model, title) {
        if (!model.canRename || !model.sessionId || editingSessionId) return;
        editingSessionId = model.sessionId;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'agent-chat-title-input';
        input.value = title;
        input.maxLength = 160;
        input.setAttribute('aria-label', '重命名当前会话');
        input.setAttribute('autocomplete', 'off');

        let settled = false;
        const cancel = () => {
            if (settled) return;
            settled = true;
            restoreTitle();
        };
        const commit = async () => {
            if (settled) return;
            const nextTitle = input.value.trim();
            if (!nextTitle || nextTitle === title) {
                cancel();
                return;
            }
            settled = true;
            input.disabled = true;
            input.setAttribute('aria-busy', 'true');
            try {
                await actions.renameTitle?.({
                    sessionId: model.sessionId,
                    agentId: model.agentId,
                    title: nextTitle,
                });
                // A control-plane refresh may have rendered while the editor
                // was active. Use the durable result as the immediate title.
                lastModel = { ...lastModel, title: nextTitle };
                restoreTitle();
            } catch (error) {
                settled = false;
                input.disabled = false;
                input.removeAttribute('aria-busy');
                input.setAttribute('aria-invalid', 'true');
                input.title = error?.message || '会话重命名失败';
                input.focus();
            }
        };
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void commit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
            }
        });
        input.addEventListener('blur', () => { void commit(); });
        const currentTitle = element.querySelector('.agent-chat-title');
        currentTitle?.replaceWith(input);
        queueMicrotask(() => {
            input.focus();
            input.select();
        });
    }

    function update(model = {}) {
        lastModel = model;
        lifecycle.clear('agent-header-status');
        if (editingSessionId) {
            // A selection change must never save into the newly selected Session.
            if (editingSessionId !== model.sessionId) restoreTitle();
            return;
        }
        element.replaceChildren();
        const title = node('h3', 'agent-chat-title', model.title || '', document);
        if (model.canRename) {
            title.classList.add('is-editable');
            title.tabIndex = 0;
            title.setAttribute('role', 'button');
            title.title = '点击重命名会话';
            const beginRename = () => startTitleEditor(model, model.title || '');
            title.addEventListener('click', beginRename);
            title.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                beginRename();
            });
        }
        const statusChip = node('span', 'agent-chat-status-chip', undefined, document);
        statusChip.append(
            node('span', 'agent-chat-status-label', model.statusLabel || model.stateLabel || model.state || '', document),
            ...(model.statusStartedAt || model.statusElapsedMs != null
                ? [node('span', 'agent-chat-status-elapsed', '', document)] : []),
        );
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
        } else statusChip.title = model.statusElapsedMs != null ? '本次任务耗时' : '当前运行状态';

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
        updateStatusText();
        if (model.statusStartedAt) lifecycle.interval('agent-header-status', updateStatusText, 1000);
    }

    return { element, update, dispose() {
        lifecycle.clear('agent-header-status');
        if (ownsLifecycle) lifecycle.dispose();
        element.replaceChildren();
    } };
}

export { createAgentWorkbenchHeaderView };
