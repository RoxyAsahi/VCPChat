import { button, icon, node } from './agent-workbench-dom.js';
import { diagnosticSummary } from './agent-config-diagnostics.js';
import { createDiagnosticDetailsView } from './agent-settings-diagnostics-details-view.js';
import { createDiagnosticErrorsView } from './agent-settings-diagnostics-errors-view.js';
import {
    createDiagnosticHealthView,
    diagnosticStateLabel,
} from './agent-settings-diagnostics-health-view.js';

function actionButton(document, label, iconName, className = 'secondary agent-chat-settings-save') {
    const control = button('', className, document);
    control.append(...icon(iconName, undefined, document), node('span', '', label, document));
    return control;
}

function diagnosticDifferences(document, model, state) {
    const config = node('section', 'agent-chat-config-diagnostic-differences', undefined, document);
    config.append(node('strong', 'agent-chat-setting-label', '配置同步', document));
    if (!model.sessionId) {
        config.append(node('p', 'agent-chat-settings-placeholder', '选择一个 Session 后读取权威配置。', document));
        return config;
    }
    if (model.inSync) {
        config.append(node('p', 'agent-chat-config-in-sync', '已保存配置与 Runtime 当前配置一致。', document));
        return config;
    }
    if (!model.differences?.length) {
        config.append(node('p', 'agent-chat-settings-placeholder',
            `配置内容一致，状态仍为 ${diagnosticStateLabel(state)}。`, document));
        return config;
    }
    const list = node('div', 'agent-chat-config-difference-list', undefined, document);
    for (const difference of model.differences) {
        const row = node('div', 'agent-chat-config-difference', undefined, document);
        const desired = node('span', '', `已保存：${difference.desired}`, document);
        const applied = node('span', '', `Runtime：${difference.applied}`, document);
        desired.title = desired.textContent;
        applied.title = applied.textContent;
        row.append(node('strong', '', difference.label, document), desired, applied);
        list.append(row);
    }
    config.append(list);
    return config;
}

function diagnosticActions(document, model, request, actions) {
    const controls = node('div', 'agent-chat-config-diagnostic-actions', undefined, document);
    const refresh = actionButton(document, request.loading ? '正在读取' : '重新读取', 'refresh');
    refresh.disabled = request.loading || !model.canRefresh;
    refresh.addEventListener('click', () => actions.refresh?.());
    const reapply = actionButton(document, request.applying ? '正在应用' : '重新应用', 'sync');
    reapply.disabled = request.loading || request.applying || !model.canReapply;
    reapply.addEventListener('click', () => actions.reapply?.());
    const copy = actionButton(document, '复制脱敏诊断', 'content_copy',
        'secondary agent-chat-settings-save agent-chat-config-copy');
    copy.addEventListener('click', () => actions.copy?.(diagnosticSummary(model)));
    controls.append(refresh, reapply, copy);
    return controls;
}

function createAgentSettingsDiagnosticsView({ document = globalThis.document, actions = {} } = {}) {
    const element = node('section', 'agent-chat-config-diagnostics', undefined, document);

    function update(model = {}, request = {}) {
        element.replaceChildren(
            createDiagnosticHealthView(document, model, request),
            diagnosticDifferences(document, model, model.applyState),
            createDiagnosticErrorsView(document, model, request),
            diagnosticActions(document, model, request, actions),
            createDiagnosticDetailsView(document, model),
        );
        return element;
    }

    return {
        element,
        update,
        dispose() { element.replaceChildren(); },
    };
}

export { createAgentSettingsDiagnosticsView };
