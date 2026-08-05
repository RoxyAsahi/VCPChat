import { createWorkspacePathRef } from './agent-workspace-model.js';
import { button, icon, node } from './agent-workbench-dom.js';

const VIEW_STATE_LABELS = {
    disconnected: '未连接', starting: '启动中', idle: '空闲', running: '运行中',
    'awaiting-approval': '待审批', reconnecting: '重连中', error: '错误',
};

function appendUsageIdentity(wrap, { current, usage, selected, snapshot, instructionMode, messages, timestamps, placeholder, document }) {
    const identity = node('dl', 'agent-chat-context-stats', undefined, document);
    const identityStat = (label, value) => {
        const row = node('div', 'agent-chat-context-stat', undefined, document);
        row.append(node('dt', '', label, document), node('dd', '', value || placeholder, document));
        identity.append(row);
    };
    const desiredRevision = Number(selected.configRevision || 0);
    const appliedRevision = Number(selected.appliedRuntimeConfigRevision || 0);
    const applyState = selected.configApplyState || (desiredRevision === appliedRevision ? 'applied' : 'pending');
    const userCount = messages.filter((item) => item.role === 'user').length;
    const assistantCount = messages.filter((item) => item.role === 'assistant').length;
    const formatTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date(value)) : placeholder;
    identityStat('会话', selected.title || selected.sessionId || current.selectedSessionId);
    identityStat('Provider', usage.provider);
    identityStat('模型', usage.model || selected.model || snapshot.model);
    identityStat('指令来源', instructionMode === 'codex-managed' ? 'Codex 0.146 管理' : 'VChat 身份');
    identityStat('Reasoning', snapshot.reasoningEffort || '模型默认');
    identityStat('配置状态', applyState === 'applied' && desiredRevision === appliedRevision
        ? `已应用 r${appliedRevision}` : `已保存 r${desiredRevision} · Runtime r${appliedRevision} · ${applyState}`);
    identityStat('消息', `${messages.length}（用户 ${userCount} / 助手 ${assistantCount}）`);
    identityStat('创建时间', formatTime(timestamps.length ? Math.min(...timestamps) : null));
    identityStat('最后活动', formatTime(timestamps.length ? Math.max(...timestamps) : null));
    wrap.append(identity);
}

function appendUsageDetails(wrap, { usage, messages, current, prompt, instructionMode, snapshot, format, hasUsage, document, buildPlan }) {
    if (usage.compactionState) {
        const text = usage.compactionState === 'started' ? '正在等待 Codex 上下文压缩的终态事件…'
            : usage.compactionState === 'completed' ? (usage.summary || '上下文压缩已完成，已从 Thread 对账恢复。')
                : usage.compactionError || '上下文压缩失败。';
        const status = node('p', `agent-chat-usage-note agent-chat-compaction-${usage.compactionState}`, text, document);
        status.setAttribute('role', 'status');
        wrap.append(status);
    }
    if (usage.contextWindow) {
        const context = node('div', 'agent-chat-usage-context', undefined, document);
        const bar = node('div', 'agent-chat-usage-context-bar', undefined, document);
        const fill = document.createElement('progress');
        fill.className = 'agent-chat-usage-context-fill'; fill.max = 100;
        fill.value = Math.min(100, Math.max(0, usage.percentage || 0));
        fill.setAttribute('aria-label', '上下文使用率'); bar.append(fill);
        context.append(bar, node('span', 'agent-chat-usage-context-label', `${format(usage.usedTokens)} / ${format(usage.contextWindow)} tokens`, document));
        wrap.append(context);
    }
    const stats = node('ul', 'agent-chat-usage-stats', undefined, document);
    for (const [label, value] of [['输入', usage.inputTokens], ['输出', usage.outputTokens], ['推理', usage.reasoningTokens], ['缓存读取', usage.cacheReadTokens], ['缓存写入', usage.cacheWriteTokens]]) {
        const item = node('li', '', undefined, document);
        item.append(node('span', 'agent-chat-usage-label', label, document), node('span', 'agent-chat-usage-value', hasUsage && value != null ? format(value) : '—', document));
        stats.append(item);
    }
    wrap.append(stats);
    const sourceLabel = usage.source === 'real' ? '模型实际返回' : usage.source === 'estimated' ? '估算（ToolBox 未返回真实 usage）' : '未知（未报告 usage）';
    const identityLabel = [usage.model, usage.provider].filter(Boolean).join(' · ');
    wrap.append(node('p', 'agent-chat-usage-note', `${sourceLabel}${identityLabel ? `；${identityLabel}` : ''}。此处是最近一次可靠报告，不伪装为 Session 累计费用。`, document));
    if (usage.inputTokens && messages.length) wrap.append(buildUsageBreakdown({ usage, messages, current, prompt, document }));
    if (instructionMode === 'codex-managed' || prompt) wrap.append(buildUsagePrompt({ instructionMode, prompt, snapshot, document }));
    if (current.plan?.text) wrap.append(buildPlan(current));
}

function buildUsageBreakdown({ usage, messages, current, prompt, document }) {
    const charCount = (value) => typeof value === 'string' ? value.length : JSON.stringify(value || '').length;
    const raw = {
        system: charCount(prompt),
        user: messages.filter((item) => item.role === 'user').reduce((sum, item) => sum + charCount(item.content || item.blocks), 0),
        assistant: messages.filter((item) => item.role === 'assistant').reduce((sum, item) => sum + charCount(item.content || item.blocks), 0),
        tool: [...(current.tools instanceof Map ? current.tools.values() : [])].reduce((sum, tool) => sum + charCount(tool.payload), 0),
    };
    const estimated = Object.fromEntries(Object.entries(raw).map(([key, chars]) => [key, Math.ceil(chars / 4)]));
    const known = Object.values(estimated).reduce((sum, value) => sum + value, 0);
    estimated.other = Math.max(0, Number(usage.inputTokens) - known);
    const denominator = Math.max(1, Object.values(estimated).reduce((sum, value) => sum + value, 0));
    const breakdown = node('section', 'agent-chat-context-breakdown', undefined, document);
    breakdown.append(node('strong', 'agent-chat-context-section-title', '上下文构成（估算）', document));
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    bar.classList.add('agent-chat-context-breakdown-bar'); bar.setAttribute('viewBox', '0 0 100 8'); bar.setAttribute('preserveAspectRatio', 'none');
    const legend = node('div', 'agent-chat-context-breakdown-legend', undefined, document); let offset = 0;
    for (const [key, label] of [['system', '系统'], ['user', '用户'], ['assistant', '助手'], ['tool', '工具'], ['other', '其他']]) {
        const value = estimated[key] || 0; if (!value) continue;
        const percent = Math.round((value / denominator) * 1000) / 10;
        const segment = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        segment.classList.add('agent-chat-context-segment', `is-${key}`); segment.setAttribute('x', String(offset)); segment.setAttribute('y', '0'); segment.setAttribute('width', String(percent)); segment.setAttribute('height', '8'); segment.setAttribute('aria-label', `${label} ${percent}%`); bar.append(segment); offset += percent;
        const item = node('span', `agent-chat-context-legend-item is-${key}`, undefined, document); item.append(node('i', '', undefined, document), document.createTextNode(`${label} ${percent}%`)); legend.append(item);
    }
    breakdown.append(bar, legend, node('p', 'agent-chat-usage-note', '构成仅根据 VChat 可见消息和工具投影估算，不代表模型服务端精确计费。', document));
    return breakdown;
}

function buildUsagePrompt({ instructionMode, prompt, snapshot, document }) {
    const details = node('details', 'agent-chat-context-prompt', undefined, document);
    if (instructionMode === 'codex-managed') {
        const body = node('div', 'agent-chat-context-effective-instructions', undefined, document);
        body.append(node('p', 'agent-chat-usage-note', '基础身份由 Codex App Server 0.146 管理；协议不返回完整内部 prompt，VChat 不伪造展示。', document), node('p', 'agent-chat-usage-note', `Personality：${snapshot.personality || 'none'}`, document));
        if (snapshot.developerInstructions) body.append(node('pre', 'agent-chat-toolbox-ws-output', String(snapshot.developerInstructions).slice(0, 32_768), document));
        details.append(node('summary', 'agent-chat-context-section-title', '有效指令', document), body);
    } else {
        details.append(node('summary', 'agent-chat-context-section-title', '有效指令（VChat 身份）', document), node('pre', 'agent-chat-toolbox-ws-output', String(prompt).slice(0, 32_768), document));
    }
    return details;
}

function createAgentActivityReadonlyView({ document = globalThis.document, actions = {} }) {
    function buildConnection(current, viewState) {
        const wrap = node('div', 'agent-chat-activity-connection', undefined, document);
        const states = {
            idle: { icon: 'check_circle', tone: 'success', title: '连接正常' },
            running: { icon: 'check_circle', tone: 'success', title: '运行中' },
            starting: { icon: 'pending', tone: 'warning', title: '正在启动' },
            'awaiting-approval': { icon: 'pending', tone: 'warning', title: '等待审批' },
            reconnecting: { icon: 'sync', tone: 'warning', title: '正在重新连接' },
            disconnected: { icon: 'cloud_off', tone: 'muted', title: '未连接' },
            error: { icon: 'error', tone: 'danger', title: '连接错误' },
        };
        const info = states[viewState] || states.disconnected;
        const card = node('div', `agent-chat-connection-card agent-chat-connection-${info.tone}`, undefined, document);
        const status = node('div', 'agent-chat-connection-status', undefined, document);
        status.append(...icon(info.icon, undefined, document), node('span', '', info.title, document));
        card.append(status);
        if (viewState === 'error') {
            const rawError = typeof current.runtime?.lastError === 'object'
                ? (current.runtime.lastError?.message || current.runtime.lastError?.error)
                : current.runtime?.lastError;
            card.append(node('p', 'agent-chat-connection-message', String(rawError || 'Codex App Server 已中断').slice(0, 280), document));
            const reconnect = button('重新连接', 'primary agent-chat-connection-reconnect', document);
            reconnect.addEventListener('click', () => actions.run?.(() => actions.reconnect?.()));
            card.append(reconnect);
        } else if (viewState === 'reconnecting') {
            card.append(node('p', 'agent-chat-connection-message', '正在重新连接 Codex App Server，并从 Projection SQLite 对账会话展示…', document));
        } else {
            card.append(node('p', 'agent-chat-connection-message', VIEW_STATE_LABELS[viewState] || viewState, document));
        }
        wrap.append(card);

        const readiness = current.readiness || {};
        const grid = node('section', 'agent-chat-readiness-grid', undefined, document);
        grid.setAttribute('aria-label', 'Codex Agent readiness');
        const readinessStates = {
            ready: { icon: 'check_circle', label: '就绪', tone: 'success' },
            configured: { icon: 'settings', label: '已配置', tone: 'success' },
            checking: { icon: 'pending', label: '检查中', tone: 'warning' },
            unknown: { icon: 'help', label: '未知', tone: 'muted' },
            unavailable: { icon: 'cloud_off', label: '不可用', tone: 'danger' },
            missing: { icon: 'error', label: '缺少配置', tone: 'danger' },
        };
        for (const [key, label] of [
            ['server', 'Codex App Server'], ['profile', 'Projection SQLite / Agent 配置'],
            ['toolbox', 'VCPToolBox Bridge'], ['capability', 'VCPToolBox 动态能力'],
        ]) {
            const item = readiness[key] || { state: 'unknown', detail: '等待 Agent Runtime 状态事件' };
            const state = readinessStates[item.state] || readinessStates.unknown;
            const readinessCard = node('article', `agent-chat-readiness-card agent-chat-readiness-${state.tone}`, undefined, document);
            readinessCard.dataset.readiness = key;
            const heading = node('div', 'agent-chat-readiness-heading', undefined, document);
            heading.append(
                ...icon(state.icon, undefined, document),
                node('span', '', label, document),
                node('span', 'agent-chat-readiness-state', state.label, document),
            );
            readinessCard.append(heading, node('p', 'agent-chat-readiness-detail', String(item.detail || '—'), document));
            grid.append(readinessCard);
        }
        wrap.append(grid);
        return wrap;
    }

    function buildPlan(current) {
        const wrap = node('section', 'agent-chat-activity-usage agent-chat-inspector-plan', undefined, document);
        wrap.append(node('strong', '', '最新计划', document));
        if (!current.plan?.text) {
            wrap.append(node('p', 'agent-chat-muted', '当前会话尚未收到 Codex Plan Item。', document));
            return wrap;
        }
        wrap.append(node('pre', 'agent-chat-toolbox-ws-output', String(current.plan.text).slice(0, 16_384), document));
        return wrap;
    }

    function buildUsage(current) {
        const wrap = node('div', 'agent-chat-activity-usage', undefined, document);
        const usage = current.context || {};
        const format = (value) => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
        const placeholder = '—';
        const hasUsage = usage.usageAvailable === true;
        const messages = current.messages || [];
        const selected = current.selectedTopic || {};
        const snapshot = selected.configSnapshot || {};
        const instructionMode = snapshot.instructionMode === 'codex-managed' ? 'codex-managed' : 'vchat-identity';
        const prompt = instructionMode === 'vchat-identity' ? snapshot.baseInstructions || '' : '';
        const timestamps = messages.map((message) => Number(message.createdAt || message.timestamp)).filter(Number.isFinite);
        const total = hasUsage ? (usage.totalTokens ?? usage.usedTokens) : null;
        const summary = node('div', 'agent-chat-usage-summary', undefined, document);
        const totalChip = node('div', 'agent-chat-usage-metric', undefined, document);
        totalChip.append(
            node('span', 'agent-chat-usage-label', 'Tokens', document),
            node('span', 'agent-chat-usage-value', total != null ? format(total) : placeholder, document),
        );
        if (usage.contextWindow && usage.percentage != null) {
            totalChip.append(node('span', 'agent-chat-usage-pill', `${usage.percentage}%`, document));
        }
        const costChip = node('div', 'agent-chat-usage-metric', undefined, document);
        costChip.append(node('span', 'agent-chat-usage-label', '费用', document), node('span', 'agent-chat-usage-value', '不可用', document));
        summary.append(totalChip, costChip);
        wrap.append(summary);

        appendUsageIdentity(wrap, { current, usage, selected, snapshot, instructionMode, messages, timestamps, placeholder, document });
        appendUsageDetails(wrap, { usage, messages, current, prompt, instructionMode, snapshot, format, hasUsage, document, buildPlan });
        return wrap;
    }

    function buildChanges(current, workspaceIdentity = {}) {
        const wrap = node('section', 'agent-chat-activity-usage agent-chat-inspector-changes', undefined, document);
        const changes = [...(current.tools instanceof Map ? current.tools.values() : [])]
            .flatMap((tool) => Array.isArray(tool?.payload?.changes?.files) ? tool.payload.changes.files : []);
        wrap.append(node('strong', '', 'Codex 文件变化（只读）', document));
        if (!changes.length) {
            wrap.append(node('p', 'agent-chat-muted', '当前会话尚未收到 Codex fileChange Item。', document));
            return wrap;
        }
        for (const change of changes.slice(0, 16)) {
            const item = node('details', 'agent-chat-toolbox-ws-card agent-chat-diff-file', undefined, document);
            item.dataset.activityKey = `diff:${change.path || 'unknown'}:${change.status || 'modified'}`;
            const summary = node('summary', 'agent-chat-toolbox-ws-title', `${change.status || 'modified'} · ${change.path || 'unknown'}`, document);
            summary.append(node('span', 'agent-chat-toolbox-ws-channel', `+${Number(change.additions) || 0} −${Number(change.deletions) || 0}`, document));
            const patch = node('pre', 'agent-chat-toolbox-ws-output', String(change.patch || '').slice(0, 131_072), document);
            if (change.path && workspaceIdentity.sessionId && workspaceIdentity.workspaceRevision) {
                try {
                    const controls = node('div', 'agent-workspace-path-actions', undefined, document);
                    const open = button('预览', 'secondary', document);
                    const reveal = button('定位', 'secondary', document);
                    const ref = createWorkspacePathRef({
                        sessionId: workspaceIdentity.sessionId,
                        workspaceRevision: workspaceIdentity.workspaceRevision,
                        relativePath: change.path,
                        source: 'diff',
                    });
                    open.addEventListener('click', () => actions.run?.(() => actions.openFileTab?.(ref)));
                    reveal.addEventListener('click', () => actions.run?.(() => actions.revealPath?.(ref)));
                    controls.append(open, reveal);
                    item.append(summary, controls, patch);
                } catch { item.append(summary, patch); }
            } else item.append(summary, patch);
            wrap.append(item);
        }
        return wrap;
    }

    return {
        buildConnection,
        buildUsage,
        buildPlan,
        buildChanges,
        dispose() {},
    };
}

export { createAgentActivityReadonlyView };
