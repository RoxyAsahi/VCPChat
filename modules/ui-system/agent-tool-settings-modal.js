import { renderAgentToolSettings } from './agent-tool-settings-view.js';

const DEFAULT_POLICY = Object.freeze({
    schemaVersion: 1,
    preset: 'full',
    enabledCodexCapabilities: [],
    enabledVcpTools: [],
});

function policyForScope({ scope, store, activeSession, selectedAgentProfile, settingsState, selectedSessionKey }) {
    const profile = selectedAgentProfile() || {};
    const sessionId = scope === 'session' ? selectedSessionKey() : '';
    const current = store.getState();
    const projection = sessionId ? current.selectedTopic : null;
    const runtime = activeSession();
    const snapshot = projection?.configSnapshot || (runtime?.sessionId === sessionId ? runtime.configSnapshot : null);
    const fallback = sessionId ? snapshot?.toolPolicy : profile.toolPolicy;
    const targetKey = sessionId ? `session:${sessionId}` : `profile:${profile.id || profile.name || 'unselected'}`;
    return {
        sessionId,
        targetKey,
        policy: settingsState.value(targetKey, 'toolPolicy', fallback || DEFAULT_POLICY),
    };
}

function createAgentToolSettingsModal({
    store,
    controller,
    settingsState,
    activeSession,
    selectedSessionKey,
    selectedAgentProfile,
    persistWorkbenchSettings,
    host,
    root,
    document,
    node,
    notify,
}) {
    let activeModal = null;
    let catalogPromise = null;

    function loadCatalog() {
        if (!catalogPromise) catalogPromise = controller.listToolCatalog().catch((error) => {
            catalogPromise = null;
            throw error;
        });
        return catalogPromise;
    }

    async function open() {
        if (activeModal) return;
        let catalog;
        try {
            catalog = await loadCatalog();
        } catch (error) {
            notify(error?.message || '工具列表加载失败。', 'error');
            return;
        }
        let scope = selectedSessionKey() ? 'session' : 'profile';
        const content = node('div', 'agent-tool-modal-content');
        const close = host.ui.create('Button', { label: '完成', variant: 'primary', size: 'sm' });
        if (!close) {
            notify('工具设置弹窗尚未准备好。', 'error');
            return;
        }
        const modal = host.ui.create('Modal', {
            title: 'Agent 工具',
            size: 'lg',
            content,
            actions: [close],
            onClose: () => { activeModal = null; },
        });
        if (!modal) {
            notify('工具设置弹窗尚未准备好。', 'error');
            return;
        }
        modal.element.classList.add('agent-tool-settings-dialog');
        activeModal = modal;
        modal.element.addEventListener('wa-after-hide', () => {
            if (activeModal === modal) activeModal = null;
        }, { once: true });
        const render = () => {
            const authority = policyForScope({
                scope, store, activeSession, selectedAgentProfile, settingsState, selectedSessionKey,
            });
            const shell = node('div', 'agent-tool-modal-shell');
            const scopeTabs = node('div', 'agent-tool-modal-scopes');
            scopeTabs.setAttribute('role', 'tablist');
            for (const option of [
                { id: 'profile', label: 'Agent 默认' },
                { id: 'session', label: '当前会话' },
            ]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `agent-tool-modal-scope${scope === option.id ? ' is-active' : ''}`;
                button.textContent = option.label;
                button.disabled = option.id === 'session' && !selectedSessionKey();
                button.setAttribute('role', 'tab');
                button.setAttribute('aria-selected', String(scope === option.id));
                button.addEventListener('click', () => {
                    scope = option.id;
                    render();
                });
                scopeTabs.append(button);
            }
            const summary = node('p', 'agent-tool-modal-summary', authority.sessionId
                ? '修改只影响当前会话，并从下一轮开始使用。'
                : '作为这个 Agent 新建会话时的默认工具。');
            const saveStatus = settingsState.status(authority.targetKey, ['toolPolicy']);
            const status = node('span', `agent-tool-modal-save-status is-${saveStatus.state}`,
                saveStatus.message || '修改后自动保存');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const meta = node('div', 'agent-tool-modal-meta');
            meta.append(summary, status);
            shell.append(scopeTabs, meta, renderAgentToolSettings({ node, catalog }, authority.policy, (toolPolicy) => {
                settingsState.setDraft(authority.targetKey, 'toolPolicy', toolPolicy);
                render();
                void persistWorkbenchSettings({ toolPolicy }, authority.sessionId,
                    authority.sessionId ? '已更新当前会话工具' : '已更新 Agent 默认工具')
                    .finally(() => {
                        if (activeModal === modal) render();
                    });
            }));
            content.replaceChildren(shell);
        };
        close.element.addEventListener('click', () => modal.close(true), { once: true });
        render();
        root.append(modal.element);
    }

    function dispose() {
        activeModal?.close?.(null);
        activeModal = null;
    }

    return { open, dispose };
}

export { createAgentToolSettingsModal };
