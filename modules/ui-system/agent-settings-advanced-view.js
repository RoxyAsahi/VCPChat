import { node } from './agent-workbench-dom.js';
import { createAgentSettingsBudgetView } from './agent-settings-budget-view.js';
import { createAgentSettingsRecoveryView } from './agent-settings-recovery-view.js';

function createAgentSettingsAdvancedView({ document = globalThis.document, diagnosticsView, actions = {} } = {}) {
    const element = node('div', 'agent-chat-settings-advanced', undefined, document);
    const budgetView = createAgentSettingsBudgetView({
        document,
        actions: { save: actions.saveBudget },
    });
    const recoveryView = createAgentSettingsRecoveryView({
        document,
        actions: { scan: actions.scanRecovery, resolve: actions.resolveRecovery },
    });

    function update({ state, diagnostics, diagnosticsRequest } = {}) {
        element.replaceChildren(
            diagnosticsView.update(diagnostics, diagnosticsRequest),
            budgetView.update(state?.budget || {}),
            recoveryView.update(state || {}),
        );
        return element;
    }

    return {
        element,
        update,
        dispose() {
            diagnosticsView?.dispose?.();
            budgetView.dispose();
            recoveryView.dispose();
            element.replaceChildren();
        },
    };
}

export { createAgentSettingsAdvancedView };
