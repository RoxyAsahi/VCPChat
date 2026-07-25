import { register } from './next-ui-apps.js';

// Agent Workbench: internal app driving the Agent Runtime through the narrow
// chat preload API. It never touches Node, shells, files, or credentials.

const api = () => window.chatAPI || window.electronAPI || {};

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatTime(iso) {
    try {
        return new Date(iso).toLocaleTimeString();
    } catch (error) {
        return '';
    }
}

function mountWorkbench(container) {
    const runtimeApi = api();
    const disposers = [];
    const state = {
        sessionId: null,
        activeTurnId: null,
        streamingText: '',
        status: null,
    };

    container.classList.add('agent-workbench-root');

    const header = el('div', 'agent-wb-header');
    const title = el('div', 'agent-wb-title', 'Agent Workbench');
    const statusBadge = el('span', 'agent-wb-badge agent-wb-badge-unknown', 'runtime: unknown');
    header.append(title, statusBadge);

    const warning = el('div', 'agent-wb-warning',
        'Legacy ToolBox bridge active: vcp_delegate / vcp_invoke run through the old VCP endpoints. '
        + 'High-risk tools always require explicit approval; ToolBox server-side approval still applies.');

    const controls = el('div', 'agent-wb-controls');
    const startBtn = el('button', 'agent-wb-btn', '启动 Runtime');
    const stopBtn = el('button', 'agent-wb-btn agent-wb-btn-secondary', '停止 Runtime');
    const newSessionBtn = el('button', 'agent-wb-btn agent-wb-btn-secondary', '新建 Session');
    const workspaceInput = el('input', 'agent-wb-input');
    workspaceInput.placeholder = 'Workspace 根目录（可选，绝对路径）';
    const modelInput = el('input', 'agent-wb-input');
    modelInput.placeholder = '模型 ID（Pi Runtime 必填）';
    controls.append(startBtn, stopBtn, newSessionBtn, workspaceInput, modelInput);

    const probeBox = el('pre', 'agent-wb-probe', 'probe: (runtime not started)');

    const composer = el('div', 'agent-wb-composer');
    const promptInput = el('textarea', 'agent-wb-prompt');
    promptInput.placeholder = '输入任务…（提到 "tool" 可触发 mock 工具演示；真实工具需审批）';
    const sendBtn = el('button', 'agent-wb-btn', '发送');
    const cancelBtn = el('button', 'agent-wb-btn agent-wb-btn-secondary', '取消 Turn');
    composer.append(promptInput, sendBtn, cancelBtn);

    const approvalsPanel = el('div', 'agent-wb-approvals');
    const approvalsTitle = el('div', 'agent-wb-section-title', '待审批');
    const approvalsList = el('div', 'agent-wb-approvals-list');
    approvalsPanel.append(approvalsTitle, approvalsList);

    const timeline = el('div', 'agent-wb-timeline');

    container.append(header, warning, controls, probeBox, composer, approvalsPanel, timeline);

    function setBadge(text, level) {
        statusBadge.textContent = `runtime: ${text}`;
        statusBadge.className = `agent-wb-badge agent-wb-badge-${level}`;
    }

    function addTimelineEntry(kind, label, body) {
        const entry = el('div', `agent-wb-entry agent-wb-entry-${kind}`);
        entry.append(el('span', 'agent-wb-entry-label', label));
        if (body) {
            entry.append(el('span', 'agent-wb-entry-body', body));
        }
        timeline.prepend(entry);
        while (timeline.childElementCount > 300) {
            timeline.lastElementChild.remove();
        }
    }

    async function refreshStatus() {
        try {
            const status = await runtimeApi.agentRuntimeGetStatus();
            state.status = status;
            setBadge(status.state, status.state === 'ready' ? 'ok' : status.state === 'degraded' ? 'warn' : 'unknown');
            probeBox.textContent = `probe: ${JSON.stringify(status.worker || status.lastError || {}, null, 2)}`;
            renderApprovals(status.pendingApprovals || []);
        } catch (error) {
            setBadge('error', 'error');
        }
    }

    function renderApprovals(pending) {
        approvalsList.replaceChildren();
        if (!pending || pending.length === 0) {
            approvalsList.append(el('div', 'agent-wb-muted', '（无）'));
            return;
        }
        for (const approval of pending) {
            const card = el('div', 'agent-wb-approval-card');
            card.append(
                el('div', 'agent-wb-approval-title', `${approval.toolName} [${approval.riskLevel}]`),
                el('div', 'agent-wb-approval-reason', approval.reason || ''),
                el('pre', 'agent-wb-approval-args', approval.argumentSummary || ''),
            );
            const allowBtn = el('button', 'agent-wb-btn agent-wb-btn-allow', '允许一次');
            const denyBtn = el('button', 'agent-wb-btn agent-wb-btn-deny', '拒绝');
            allowBtn.addEventListener('click', async () => {
                await runtimeApi.agentRuntimeRespondApproval({
                    approvalId: approval.approvalId,
                    decision: 'allow',
                    sessionId: approval.sessionId,
                    turnId: approval.turnId,
                    toolCallId: approval.toolCallId,
                    argumentsHash: approval.argumentsHash,
                });
                refreshStatus();
            });
            denyBtn.addEventListener('click', async () => {
                await runtimeApi.agentRuntimeRespondApproval({
                    approvalId: approval.approvalId,
                    decision: 'deny',
                    sessionId: approval.sessionId,
                    turnId: approval.turnId,
                    toolCallId: approval.toolCallId,
                    argumentsHash: approval.argumentsHash,
                });
                refreshStatus();
            });
            const btnRow = el('div', 'agent-wb-approval-actions');
            btnRow.append(allowBtn, denyBtn);
            card.append(btnRow);
            approvalsList.append(card);
        }
    }

    function handleRuntimeEvent(event) {
        if (!event || typeof event !== 'object') return;
        if (event.sessionId !== 'runtime' && state.sessionId && event.sessionId !== state.sessionId) {
            return;
        }
        switch (event.type) {
            case 'assistant.delta':
                state.streamingText += (event.payload && event.payload.text) || '';
                addTimelineEntry('delta', 'assistant', (event.payload && event.payload.text) || '');
                break;
            case 'reasoning.delta':
                addTimelineEntry('reasoning', 'reasoning', (event.payload && event.payload.text) || '');
                break;
            case 'tool.requested':
                addTimelineEntry('tool', 'tool.requested',
                    `${event.payload.toolName} :: ${event.payload.argumentSummary || ''}`);
                break;
            case 'tool.awaiting_local_approval':
                addTimelineEntry('approval', 'awaiting approval', event.payload.toolName);
                refreshStatus();
                break;
            case 'tool.completed':
            case 'tool.failed':
            case 'tool.cancelled':
                addTimelineEntry('tool', event.type, (event.payload.outputSummary || event.payload.reason || event.payload.error || ''));
                refreshStatus();
                break;
            case 'approval.resolved':
            case 'approval.expired':
                refreshStatus();
                break;
            case 'turn.completed':
                addTimelineEntry('turn', 'turn.completed', '');
                state.activeTurnId = null;
                break;
            case 'turn.failed':
                addTimelineEntry('error', 'turn.failed', event.payload.error || '');
                state.activeTurnId = null;
                break;
            case 'turn.cancelled':
                addTimelineEntry('turn', 'turn.cancelled', event.payload.reason || '');
                state.activeTurnId = null;
                break;
            case 'runtime.state_changed':
                setBadge((event.payload && event.payload.state) || 'unknown',
                    event.payload && event.payload.state === 'ready' ? 'ok' : 'warn');
                refreshStatus();
                break;
            case 'runtime.crashed':
                addTimelineEntry('error', 'runtime.crashed', `code=${event.payload.code}`);
                break;
            default:
                break;
        }
    }

    startBtn.addEventListener('click', async () => {
        try {
            setBadge('starting', 'warn');
            await runtimeApi.agentRuntimeStart();
            await refreshStatus();
        } catch (error) {
            addTimelineEntry('error', 'start failed', error.message);
            setBadge('degraded', 'error');
        }
    });

    stopBtn.addEventListener('click', async () => {
        try {
            await runtimeApi.agentRuntimeStop();
            state.sessionId = null;
            await refreshStatus();
        } catch (error) {
            addTimelineEntry('error', 'stop failed', error.message);
        }
    });

    newSessionBtn.addEventListener('click', async () => {
        try {
            const workspaceRoot = workspaceInput.value.trim() || undefined;
            const model = modelInput.value.trim() || undefined;
            const session = await runtimeApi.agentRuntimeCreateSession({ workspaceRoot, model });
            state.sessionId = session.sessionId;
            addTimelineEntry('session', 'session.created', session.sessionId);
        } catch (error) {
            addTimelineEntry('error', 'session failed', error.message);
        }
    });

    sendBtn.addEventListener('click', async () => {
        const prompt = promptInput.value.trim();
        if (!prompt) return;
        if (!state.sessionId) {
            addTimelineEntry('error', 'no session', '请先新建 Session');
            return;
        }
        try {
            const result = await runtimeApi.agentRuntimeStartTurn({ sessionId: state.sessionId, prompt });
            state.activeTurnId = result.turnId;
            promptInput.value = '';
        } catch (error) {
            addTimelineEntry('error', 'turn failed', error.message);
        }
    });

    cancelBtn.addEventListener('click', async () => {
        if (!state.sessionId) return;
        try {
            await runtimeApi.agentRuntimeCancelTurn({
                sessionId: state.sessionId,
                turnId: state.activeTurnId || undefined,
            });
        } catch (error) {
            addTimelineEntry('error', 'cancel failed', error.message);
        }
    });

    runtimeApi.agentRuntimeSetWorkbenchPresence?.(true);

    if (typeof runtimeApi.onAgentRuntimeEvent === 'function') {
        const unsubscribe = runtimeApi.onAgentRuntimeEvent(handleRuntimeEvent);
        if (typeof unsubscribe === 'function') {
            disposers.push(unsubscribe);
        }
    }

    refreshStatus();

    return () => {
        runtimeApi.agentRuntimeSetWorkbenchPresence?.(false);
        disposers.splice(0).forEach((dispose) => {
            try { dispose(); } catch (error) { /* best effort */ }
        });
        container.replaceChildren();
        container.classList.remove('agent-workbench-root');
    };
}

register({
    id: 'agent-workbench',
    title: 'Agent Workbench',
    icon: 'smart_toy',
    kind: 'internal',
    mount: mountWorkbench,
});
