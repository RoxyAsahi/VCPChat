const QUEUE_STATE_LABELS = Object.freeze({
    queued: '等待发送',
    dispatching: '正在发送',
    accepted: '已接收，等待确认',
    uncertain: '发送状态未确认',
    failed: '发送失败',
});

function renderPendingInputQueue({ state, controller, refresh, notify, run, button, node }) {
    if (!state.queueOpen) return null;
    const panel = node('section', 'agent-chat-queue-popover');
    const title = node('div', 'agent-chat-queue-heading');
    title.append(node('strong', '', '后续指令队列'));
    const clear = button('清空', 'agent-chat-queue-clear');
    clear.disabled = !state.queue.some((item) => ['queued', 'failed'].includes(item?.state || 'queued'));
    clear.addEventListener('click', () => run(async () => {
        await controller.clearInteractionQueue();
        await refresh();
        notify('已清空后续指令队列。', 'success');
    }));
    title.append(clear);
    panel.append(title);
    if (!state.queue.length) {
        panel.append(node('p', 'agent-chat-muted', '没有排队的 steering / follow-up。'));
        return panel;
    }

    const list = node('ol', 'agent-chat-queue-list');
    for (const item of state.queue) {
        const kind = typeof item === 'object' ? item.kind : 'follow-up';
        const prompt = typeof item === 'string' ? item : item.prompt || item.text || JSON.stringify(item);
        const inputId = typeof item === 'object' ? (item.inputId || item.interactionId) : '';
        const queueState = typeof item === 'object' ? (item.state || 'queued') : 'queued';
        const row = node('li', 'agent-chat-queue-item');
        row.append(
            node('span', 'agent-chat-queue-kind', kind === 'steer' ? '即时指导' : '后续指令'),
            node('span', 'agent-chat-queue-state', QUEUE_STATE_LABELS[queueState] || queueState),
            node('span', 'agent-chat-queue-prompt', prompt),
        );
        if (item?.error) row.append(node('span', 'agent-chat-queue-error', item.error));

        const itemActions = node('div', 'agent-chat-queue-item-actions');
        const requiresDecision = queueState === 'uncertain' || queueState === 'failed';
        const edit = button(requiresDecision ? '重新发送' : '编辑');
        const remove = button(requiresDecision ? '丢弃' : '移除', 'danger');
        const actionable = Boolean(inputId && (kind === 'steer' || kind === 'follow-up')
            && ['queued', 'uncertain', 'failed'].includes(queueState));
        edit.disabled = !actionable;
        remove.disabled = !actionable;
        edit.addEventListener('click', () => {
            if (requiresDecision) {
                run(async () => {
                    await controller.resolvePendingInput(inputId, 'resend');
                    await refresh();
                    notify('已按你的确认重新发送后续指令。', 'success');
                });
                return;
            }
            const nextPrompt = window.prompt?.('编辑后续指令', prompt);
            if (nextPrompt === null || nextPrompt === undefined || nextPrompt.trim() === prompt.trim()) return;
            run(async () => {
                const interactions = state.queue.map((candidate) => (
                    (candidate?.inputId || candidate?.interactionId) === inputId
                        ? { ...candidate, prompt: nextPrompt.trim() }
                        : candidate
                ));
                await controller.replaceInteractionQueue(interactions);
                await refresh();
                notify('后续指令已更新。', 'success');
            });
        });
        remove.addEventListener('click', () => run(async () => {
            if (requiresDecision) {
                await controller.resolvePendingInput(inputId, 'discard');
                await refresh();
                notify('已丢弃未确认的后续指令。', 'success');
                return;
            }
            const interactions = state.queue.filter((candidate) => (
                (candidate?.inputId || candidate?.interactionId) !== inputId
            ));
            await controller.replaceInteractionQueue(interactions);
            await refresh();
            notify('后续指令已移除。', 'success');
        }));
        itemActions.append(edit, remove);
        row.append(itemActions);
        list.append(row);
    }
    panel.append(list);
    return panel;
}

export { renderPendingInputQueue };
