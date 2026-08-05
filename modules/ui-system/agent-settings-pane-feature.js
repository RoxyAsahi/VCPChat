import { renderAgentSettingsPane } from './agent-settings-view.js';

function createAgentSettingsPaneFeature(context = {}) {
    const {
        state,
        sidebar,
        settingsState,
        advancedSettingsFeature,
    } = context;

    function render() {
        const diagnostics = advancedSettingsFeature.current();
        return renderAgentSettingsPane({
            ...context,
            advancedSettingsView: advancedSettingsFeature.view,
            diagnostics: diagnostics.model,
            diagnosticsRequest: diagnostics.request,
            refreshSessionDiagnostics: advancedSettingsFeature.load,
            settingValue(targetKey, field, fallback) {
                return settingsState.value(targetKey, field, fallback);
            },
            settingStatus(targetKey, fields) {
                return settingsState.status(targetKey, fields);
            },
            scheduleTextSave(targetKey, field, callback) {
                settingsState.schedule(targetKey, field, callback);
            },
        });
    }

    function refreshStatus() {
        if (state.tab !== 'settings') return;
        const statusNode = sidebar.querySelector('.agent-chat-settings-save-status');
        if (!statusNode) return;
        const status = state.settingsSaveByScope.get(state.settingsScope)
            || { state: 'idle', message: '修改后自动保存' };
        statusNode.className = `agent-chat-settings-save-status is-${status.state}`;
        statusNode.textContent = status.message || '修改后自动保存';
    }

    return Object.freeze({ render, refreshStatus });
}

export { createAgentSettingsPaneFeature };
