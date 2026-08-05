import { createAgentSettingsAdvancedView } from './agent-settings-advanced-view.js';
import { createAgentSettingsDiagnosticsCoordinator } from './agent-settings-diagnostics-coordinator.js';
import { createAgentSettingsDiagnosticsView } from './agent-settings-diagnostics-view.js';

function createAgentSettingsAdvancedFeature({
    state,
    store,
    settingsState,
    controller,
    document,
    lifecycle,
    host,
    run,
    notify,
    refreshControlPlane,
    renderSidebar,
    persistWorkbenchSettings,
    refreshRecoveryOperations,
    refreshTopicsForAgent,
} = {}) {
    const coordinator = createAgentSettingsDiagnosticsCoordinator({
        state,
        store,
        settingsState,
        controller,
        refreshControlPlane,
        refresh: renderSidebar,
    });
    const load = (options) => coordinator.load(options);
    const diagnosticsView = createAgentSettingsDiagnosticsView({
        document,
        actions: {
            refresh: () => run(() => load()),
            reapply: () => run(() => load({ reapply: true })),
            copy: (summary) => run(async () => {
                if (typeof host?.clipboard?.writeText !== 'function') {
                    throw new Error('当前环境无法访问系统剪贴板。');
                }
                await host.clipboard.writeText(summary);
                notify('已复制脱敏诊断摘要。', 'success');
            }),
        },
    });
    const view = createAgentSettingsAdvancedView({
        document,
        diagnosticsView,
        actions: {
            saveBudget: (budget) => lifecycle.timeout('budget-autosave', () => {
                void persistWorkbenchSettings({ budget }, '', '已自动保存新 Session 安全预算');
            }, 500),
            scanRecovery: () => void refreshRecoveryOperations({ scanThreads: true }),
            resolveRecovery: (operation, action, threadId) => run(async () => {
                const deleting = action === 'delete';
                const accepted = await host.feedback.confirm({
                    title: deleting ? '删除未绑定 Thread' : '确认 Thread 归属',
                    message: deleting
                        ? '永久删除选中的未绑定 Codex Thread 吗？'
                        : '确认该 Codex Thread 属于这次未完成操作吗？',
                    danger: deleting,
                });
                if (accepted !== true) return;
                const result = await controller.resolveRecoveryOperation(operation.operationId, action, threadId);
                if (!deleting && result?.session?.sessionId) {
                    await controller.previewTopic(result.session.sessionId, result.session.agentId, result.session);
                }
                await Promise.all([
                    refreshRecoveryOperations({ scanThreads: deleting }),
                    refreshTopicsForAgent(state.selectedAgent, false),
                ]);
                notify(deleting ? '未绑定 Thread 已删除。' : '未绑定 Thread 已显式绑定。', 'success');
            }),
        },
    });

    return Object.freeze({
        view,
        current: () => coordinator.current(),
        load,
        subscribe: (...args) => coordinator.subscribe(...args),
        dispose() {
            coordinator.dispose();
            view.dispose();
        },
    });
}

export { createAgentSettingsAdvancedFeature };
