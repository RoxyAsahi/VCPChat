import { icon, node } from './agent-workbench-dom.js';

const STATE_LABELS = Object.freeze({
    applied: '已应用', applying: '正在应用', pending: '等待 Runtime',
    error: '应用失败', unmaterialized: '尚未创建 Thread', unknown: '未知',
});

function diagnosticStateLabel(state) {
    return STATE_LABELS[String(state || 'unknown')] || String(state || 'unknown');
}

function diagnosticHealth(model = {}, request = {}) {
    if (!model.sessionId) {
        return {
            tone: 'neutral', icon: 'info', title: '选择一个会话',
            summary: '选择 Session 后读取已保存配置和 Runtime 实际状态。', issueCount: 0,
        };
    }
    const errors = [
        model.saveError, model.applyError, model.runtimeError,
        model.adapterError, model.projectionError, model.storageError, request.error,
    ].filter(Boolean);
    const recoveryUnconfirmed = model.threadRecoveryState === 'unconfirmed';
    const pending = model.applyBarrierWaiting
        || ['applying', 'pending'].includes(String(model.applyState || ''));
    const differenceCount = Array.isArray(model.differences) ? model.differences.length : 0;
    const issueCount = errors.length + differenceCount + (pending ? 1 : 0) + (recoveryUnconfirmed ? 1 : 0);
    if (errors.length || model.storageReadOnly || model.applyState === 'error') {
        return {
            tone: 'error', icon: 'error', title: `${Math.max(1, issueCount)} 个问题需要处理`,
            summary: '先处理下方错误；未确认的配置不会被当作 Runtime 已生效。', issueCount,
        };
    }
    if (recoveryUnconfirmed) {
        return {
            tone: 'warning', icon: 'sync_problem', title: 'Thread 运行状态尚未确认',
            summary: 'Runtime 重连后尚未确认 active Turn；插队、停止和后续队列保持关闭。', issueCount,
        };
    }
    if (pending || differenceCount) {
        return {
            tone: 'warning', icon: 'pending', title: '配置尚未完全生效',
            summary: differenceCount
                ? `${differenceCount} 个字段与 Runtime 当前值不同。`
                : '配置正在等待 Runtime 确认。',
            issueCount,
        };
    }
    if (model.inSync) {
        return {
            tone: 'success', icon: 'check_circle', title: '配置与 Runtime 已同步',
            summary: `已保存 r${model.desiredRevision || 0}，Runtime 已确认相同 revision。`, issueCount: 0,
        };
    }
    return {
        tone: 'neutral', icon: 'info', title: '配置状态仍在确认',
        summary: '重新读取可获取 Main 进程的权威状态。', issueCount,
    };
}

function createDiagnosticHealthView(document, model = {}, request = {}) {
    const health = diagnosticHealth(model, request);
    const section = node('section', `agent-chat-config-health is-${health.tone}`, undefined, document);
    const heading = node('div', 'agent-chat-config-health-heading', undefined, document);
    const title = node('div', 'agent-chat-config-health-title', undefined, document);
    title.append(
        ...icon(health.icon, undefined, document),
        node('strong', '', health.title, document),
    );
    heading.append(
        title,
        node('span', `agent-chat-config-state is-${String(model.applyState || 'unknown')}`,
            diagnosticStateLabel(model.applyState), document),
    );
    section.append(
        node('span', 'agent-chat-setting-label', '配置与 Runtime 诊断', document),
        heading,
        node('p', 'agent-chat-setting-help', health.summary, document),
    );
    section.dataset.issueCount = String(health.issueCount);
    section.dataset.healthTone = health.tone;
    return section;
}

export { createDiagnosticHealthView, diagnosticHealth, diagnosticStateLabel };
