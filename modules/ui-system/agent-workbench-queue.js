import { visualActionButton } from './agent-workbench-dom.js';

const QUEUE_STATE_LABELS = Object.freeze({
    queued: '等待发送',
    dispatching: '正在发送',
    accepted: '已接收，等待确认',
    uncertain: '发送状态未确认',
    failed: '发送失败',
});

function renderPendingInputQueue({ state, controller, refresh, notify, run, button, node, host, guidePrompt }) {
    if (!state.queue.length) return null;
    const panel = node('section', 'agent-chat-queue-panel');

    const list = node('ol', 'agent-chat-queue-list');
    for (const item of state.queue) {
        const kind = typeof item === 'object' ? item.kind : 'follow-up';
        const prompt = typeof item === 'string' ? item : item.prompt || item.text || JSON.stringify(item);
        const inputId = typeof item === 'object' ? (item.inputId || item.interactionId) : '';
        const queueState = typeof item === 'object' ? (item.state || 'queued') : 'queued';
        const row = node('li', 'agent-chat-queue-item');
        const body = node('div', 'agent-chat-queue-item-body');
        body.append(node('span', 'agent-chat-queue-kind', kind === 'steer' ? '即时指导' : '后续指令'),
            node('span', 'agent-chat-queue-prompt', prompt));
        row.append(body);
        const stateLabel = node('span', 'agent-chat-queue-state', QUEUE_STATE_LABELS[queueState] || queueState);
        body.append(stateLabel);
        if (item?.error) row.append(node('span', 'agent-chat-queue-error', item.error));

        const itemActions = node('div', 'agent-chat-queue-item-actions');
        const requiresDecision = queueState === 'uncertain' || queueState === 'failed';
        const guide = button('引导', 'agent-chat-queue-guide');
        const remove = visualActionButton('delete', requiresDecision ? '丢弃' : '删除', 'agent-chat-queue-remove danger', '', host.document);
        const edit = visualActionButton('more', requiresDecision ? '重新发送' : '编辑消息', 'agent-chat-queue-edit', '', host.document);
        const actionable = Boolean(inputId && (kind === 'steer' || kind === 'follow-up')
            && ['queued', 'uncertain', 'failed'].includes(queueState));
        guide.disabled = !actionable;
        edit.disabled = !actionable;
        remove.disabled = !actionable;
        guide.addEventListener('click', () => {
            if (actionable) guidePrompt?.(prompt);
        });
        edit.addEventListener('click', async () => {
            if (requiresDecision) {
                run(async () => {
                    await controller.resolvePendingInput(inputId, 'resend');
                    await refresh();
                    notify('已按你的确认重新发送后续指令。', 'success');
                });
                return;
            }
            const nextPrompt = await host.feedback.edit({ title: '编辑后续指令', value: prompt, multiline: true });
            if (nextPrompt?.available === false) { notify(nextPrompt.reason, 'error'); return; }
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
        itemActions.append(guide, remove, edit);
        row.append(itemActions);
        list.append(row);
    }
    panel.append(list);
    return panel;
}

export { renderPendingInputQueue };
