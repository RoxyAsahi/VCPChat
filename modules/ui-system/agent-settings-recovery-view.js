import { button, node } from './agent-workbench-dom.js';

function recoveryOperationCard(document, operation, threads, actions) {
    const card = node('div', 'agent-chat-setting-field agent-chat-recovery-operation', undefined, document);
    card.append(node('span', 'agent-chat-setting-label', `${operation.kind} · ${operation.state}`, document));
    if (operation.lastError) card.append(node('span', 'agent-chat-setting-help', operation.lastError, document));
    const recoverable = ['uncertain', 'remote-applied'].includes(operation.state)
        && ['thread-start', 'thread-fork'].includes(operation.kind);
    if (!recoverable || !threads?.length) return card;
    const select = document.createElement('select');
    select.className = 'agent-chat-setting-input';
    for (const thread of threads) {
        const option = document.createElement('option');
        option.value = thread.threadId;
        option.textContent = thread.title || thread.threadId;
        select.append(option);
    }
    const bind = button('绑定到 VChat Session', 'primary agent-chat-settings-save', document);
    bind.addEventListener('click', () => actions.resolve?.(operation, 'bind', select.value));
    const remove = button('删除未绑定 Thread', 'secondary agent-chat-settings-save', document);
    remove.addEventListener('click', () => actions.resolve?.(operation, 'delete', select.value));
    const controls = node('div', 'agent-chat-recovery-actions', undefined, document);
    controls.append(bind, remove);
    card.append(select, controls);
    return card;
}

function createAgentSettingsRecoveryView({ document = globalThis.document, actions = {} } = {}) {
    const element = node('section', 'agent-chat-settings-budget agent-chat-recovery-section', undefined, document);

    function update(state = {}) {
        const header = node('div', 'agent-chat-settings-section-heading', undefined, document);
        const copy = node('div', '', undefined, document);
        copy.append(
            node('strong', 'agent-chat-setting-label', '一致性恢复', document),
            node('span', 'agent-chat-setting-help',
                '只处理未完成的跨存储操作；不会自动重放 Turn 或猜测 Thread 归属。', document),
        );
        const scan = button(state.recoveryLoading ? '正在检查…' : '扫描未绑定 Thread',
            'secondary agent-chat-settings-save', document);
        scan.disabled = state.recoveryLoading;
        scan.addEventListener('click', () => actions.scan?.());
        header.append(copy, scan);
        const content = node('div', 'agent-chat-recovery-content', undefined, document);
        if (state.recoveryError) {
            content.append(node('p', 'agent-chat-settings-save-status is-error', state.recoveryError, document));
        } else if (!state.recoveryOperations?.length) {
            content.append(node('p', 'agent-chat-settings-placeholder', state.recoveryLoading
                ? '正在读取 Saga 日志…' : '没有需要人工处理的操作。', document));
        } else {
            for (const operation of state.recoveryOperations) {
                content.append(recoveryOperationCard(document, operation, state.recoveryThreads, actions));
            }
        }
        element.replaceChildren(header, content);
        return element;
    }

    return { element, update, dispose() { element.replaceChildren(); } };
}

export { createAgentSettingsRecoveryView };
