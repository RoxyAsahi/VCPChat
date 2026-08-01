import { createButton, createNode, safeText } from './dom.js';

function createApprovalCard(document, approval, options = {}) {
    const card = createNode(document, 'section', 'agent-chat-approval-card');
    card.dataset.approvalId = approval.approvalId || '';
    card.append(createNode(document, 'strong', 'agent-chat-approval-title', `需要本地确认：${approval.toolName || 'VCP 工具'}`));
    if (approval.riskLevel || approval.kind) {
        card.append(createNode(document, 'span', 'agent-chat-approval-risk', approval.riskLevel || approval.kind || '风险未分类'));
    }

    const actions = createNode(document, 'div', 'agent-chat-approval-actions');
    const deny = createButton(document, '拒绝', 'danger');
    const allow = createButton(document, '允许一次', 'secondary');
    const decide = (decision) => {
        if (card.dataset.deciding === 'true') return;
        card.dataset.deciding = 'true';
        deny.disabled = true;
        allow.disabled = true;
        deny.textContent = decision === 'deny' ? '正在拒绝…' : '拒绝';
        allow.textContent = decision === 'allow' ? '正在允许…' : '允许一次';
        options.registry?.delete(approval.approvalId);
        options.onDecision?.(approval, decision);
    };
    deny.addEventListener('click', () => decide('deny'));
    allow.addEventListener('click', () => decide('allow'));
    actions.append(deny, allow);
    card.append(actions);

    const bindings = [
        ['sessionId', approval.sessionId],
        ['turnId', approval.turnId],
        ['toolCallId', approval.toolCallId],
        ['argumentsHash', approval.argumentsHash],
    ].filter(([, value]) => value != null && value !== '');
    if (bindings.length) {
        const binding = createNode(document, 'dl', 'agent-chat-approval-binding');
        for (const [key, value] of bindings) {
            binding.append(createNode(document, 'dt', 'agent-chat-approval-binding-key', key));
            binding.append(createNode(document, 'dd', 'agent-chat-approval-binding-value', String(value)));
        }
        card.append(binding);
    }
    if (approval.reason) card.append(createNode(document, 'p', 'agent-chat-approval-reason', approval.reason));
    if (approval.argumentSummary || approval.argsPreview) {
        card.append(createNode(document, 'pre', 'agent-chat-approval-args', safeText(approval.argumentSummary || approval.argsPreview)));
    }

    const countdown = createNode(document, 'div', 'agent-chat-approval-countdown', '默认拒绝');
    countdown.setAttribute('aria-hidden', 'true');
    card.append(countdown);
    const live = createNode(document, 'div', 'agent-chat-visually-hidden agent-chat-approval-live');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'assertive');
    live.textContent = '等待审批；超时由 Codex App Server 自动拒绝';
    card.append(live);

    const deadline = Number(approval.expiresAtMs);
    if (Number.isFinite(deadline) && deadline > 0 && options.registry && !options.registry.has(approval.approvalId)) {
        options.registry.set(approval.approvalId, { deadline, expired: false });
        options.ensureTicker?.();
    }
    const remaining = Number.isFinite(deadline) && deadline > 0
        ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
    countdown.textContent = remaining == null
        ? '默认拒绝 · 等待 Codex App Server 截止时间'
        : `默认拒绝 · Codex App Server ${remaining}s 后处理`;
    return card;
}

export { createApprovalCard };
