import './avatar-picker.js';
import { selectedSessionId } from './agent-selected-session.js';
import { configOptions } from '../agent-config-descriptors.js';

const SETTINGS_SCOPES = Object.freeze([
    { id: 'profile', label: 'Agent 默认' },
    { id: 'session', label: '当前会话' },
    { id: 'advanced', label: '高级' },
]);

function approvalPermission(snapshot, fallback) {
    if (snapshot?.approvalPolicy === 'never') return 'always-approve';
    return snapshot?.approvalPolicy ? 'ask' : fallback;
}

function resolveSettingsAuthority(context) {
    const { state, store, activeSession, sessionConfigRevisions, selectedAgentProfile } = context;
    const current = store.getState();
    const selected = selectedSessionId(current) || '';
    const sessionId = state.settingsScope === 'session' ? selected : '';
    const projection = sessionId ? current.selectedTopic : null;
    const runtime = activeSession();
    const snapshot = projection?.configSnapshot || (sessionId ? runtime?.configSnapshot : null) || null;
    if (sessionId && projection?.configRevision) sessionConfigRevisions.set(sessionId, Number(projection.configRevision));
    const profile = selectedAgentProfile() || {};
    const targetKey = sessionId ? `session:${sessionId}` : `profile:${profile.id || profile.name || 'unselected'}`;
    const runtimeWorkspace = runtime?.sessionId === sessionId ? runtime.workspaceRoot : '';
    const workspaceFallback = projection?.workspaceRef || projection?.workspaceRoot
        || runtimeWorkspace || profile.workspaceRoot || state.workspace;
    return { current, sessionId, projection, runtime, snapshot, profile, targetKey, workspaceFallback };
}

function resolveSettingsPaneModel(context) {
    const { state, settingValue } = context;
    const authority = resolveSettingsAuthority(context);
    const { sessionId, projection, runtime, snapshot, profile, targetKey, workspaceFallback } = authority;
    const instructionValue = settingValue(
        targetKey, 'instructionMode', snapshot?.instructionMode || profile.instructionMode,
    );
    return {
        ...authority,
        materialized: Boolean(sessionId && (runtime?.threadId || projection?.threadId || projection?.session?.threadId)),
        workspace: settingValue(targetKey, 'workspaceRoot', workspaceFallback),
        permissionMode: settingValue(targetKey, 'permissionMode',
            snapshot?.permissionMode || approvalPermission(snapshot, state.permissionMode)),
        model: settingValue(targetKey, 'model', snapshot?.model || profile.model || state.model),
        instructionMode: instructionValue === 'codex-managed' ? 'codex-managed' : 'vchat-identity',
        baseInstructions: settingValue(targetKey, 'baseInstructions',
            snapshot?.baseInstructions ?? profile.baseInstructions ?? profile.systemPrompt ?? ''),
        developerInstructions: settingValue(targetKey, 'developerInstructions',
            snapshot?.developerInstructions ?? profile.developerInstructions ?? ''),
        personality: settingValue(targetKey, 'personality', snapshot?.personality || profile.personality || 'none'),
        reasoningEffort: settingValue(targetKey, 'reasoningEffort',
            snapshot?.reasoningEffort ?? profile.reasoningEffort ?? ''),
    };
}

function appendConfigurationWarning(context, pane) {
    if (context.state.settingsScope !== 'profile' || !context.profileNeedsConfiguration()) return;
    const warning = context.node('section', 'agent-chat-profile-configuration-warning is-settings');
    warning.setAttribute('role', 'alert');
    warning.append(context.node('strong', '', '此 Agent 还不能创建会话'), context.node('span', '',
        context.state.profileConfigurationNotice || '请填写下方 Agent 提示词。保存完成后即可直接新建会话。'));
    pane.append(warning);
}

function appendSettingsStatus(context, model, form) {
    const status = context.settingStatus(model.targetKey)
        || context.state.settingsSaveByScope.get(context.state.settingsScope)
        || { state: 'idle', message: '' };
    const statusNode = context.node('p', `agent-chat-settings-save-status is-${status.state}`,
        status.message || '修改后自动保存');
    statusNode.setAttribute('role', 'status');
    form.append(statusNode);
}

export function renderAgentSettingsPane(context) {
    const {
        state, store, activeSession, sessionConfigRevisions, selectedAgentProfile,
        profileNeedsConfiguration, persistWorkbenchSettings, renderSidebar,
        run, refreshControlPlane, refreshModelCatalog, notify, controller, refreshRecoveryOperations,
        refreshTopicsForAgent, node, button, sameAgent, scheduleTextSave,
        settingValue, settingStatus, host, advancedSettingsView, diagnostics,
        diagnosticsRequest, refreshSessionDiagnostics,
    } = context;
    const pane = node('div', 'agent-chat-settings-pane');
    const form = node('div', 'agent-chat-settings-form');
    const hasSelectedSession = Boolean(selectedSessionId(store.getState()));
    if (state.settingsScope === 'session' && !hasSelectedSession) state.settingsScope = 'profile';
    const scopes = node('div', 'agent-chat-settings-scopes');
    scopes.setAttribute('role', 'tablist');
    for (const scope of SETTINGS_SCOPES) {
        const scopeButton = button(scope.label, `agent-chat-settings-scope${state.settingsScope === scope.id ? ' is-active' : ''}`);
        scopeButton.setAttribute('role', 'tab');
        scopeButton.setAttribute('aria-selected', String(state.settingsScope === scope.id));
        scopeButton.disabled = scope.id === 'session' && !hasSelectedSession;
        scopeButton.addEventListener('click', () => {
            if (state.settingsScope === scope.id) return;
            state.settingsScope = scope.id;
            renderSidebar();
            if (scope.id === 'advanced') {
                void refreshRecoveryOperations();
                void refreshSessionDiagnostics?.().catch(() => {});
            }
        });
        scopes.append(scopeButton);
    }
    pane.append(scopes);
    if (state.settingsScope === 'advanced') {
        form.append(advancedSettingsView.update({ state, diagnostics, diagnosticsRequest }));
        appendSettingsStatus(context, { targetKey: 'advanced:global' }, form);
        pane.append(form);
        return pane;
    }
    const {
        sessionId, projection, snapshot, profile, targetKey, materialized, workspace,
        permissionMode, model, instructionMode, baseInstructions, developerInstructions,
        personality, reasoningEffort,
    } = resolveSettingsPaneModel(context);
    state.permissionMode = permissionMode;

    appendConfigurationWarning(context, pane);

    const field = (label, value, onChange, options = null, controlOptions = {}) => {
        const wrap = node('label', 'agent-chat-setting-field');
        wrap.append(node('span', 'agent-chat-setting-label', label));
        const control = options ? document.createElement('select') : document.createElement('input');
        control.className = 'agent-chat-setting-input';
        control.disabled = controlOptions.disabled === true;
        if (controlOptions.title) control.title = controlOptions.title;
        if (!options) {
            control.value = value || '';
            if (controlOptions.placeholder) control.placeholder = controlOptions.placeholder;
        }
        for (const option of options || []) {
            const item = document.createElement('option');
            item.value = option.value;
            item.textContent = option.label;
            item.selected = option.value === value;
            control.append(item);
        }
        control.addEventListener('change', () => onChange(control.value));
        wrap.append(control);
        return wrap;
    };

    const workspaceField = () => {
        const wrap = node('label', 'agent-chat-setting-field');
        wrap.append(node('span', 'agent-chat-setting-label', '工作目录（可留空）'));
        const controlRow = node('div', 'agent-chat-workspace-control');
        const control = document.createElement('input');
        control.className = 'agent-chat-setting-input';
        control.value = workspace || '';
        control.placeholder = '留空使用 VCPChat 当前工作目录';
        control.title = materialized ? 'Codex 0.146 会从下一 Turn 使用新的工作目录。' : '';
        control.setAttribute('aria-label', '工作目录（可留空）');
        const persist = (value) => {
            if (!sessionId) state.workspace = value;
            return persistWorkbenchSettings({ workspaceRoot: value }, sessionId,
                sessionId ? '已自动保存当前 Session 工作目录' : '已自动保存 Agent 默认工作目录');
        };
        control.addEventListener('change', () => void persist(control.value.trim()));
        const select = button('', 'agent-chat-workspace-select');
        select.type = 'button';
        select.title = '选择文件夹';
        select.setAttribute('aria-label', '选择工作目录文件夹');
        select.append(node('span', 'vcp-ui-icon', 'folder_open'));
        select.addEventListener('click', () => run(async () => {
            select.disabled = true;
            try {
                const result = await controller.workspaceSelectRoot({ currentPath: control.value.trim() });
                if (result?.cancelled || !result?.workspaceRoot) return;
                control.value = result.workspaceRoot;
                await persist(result.workspaceRoot);
            } finally {
                select.disabled = false;
            }
        }));
        controlRow.append(control, select);
        wrap.append(controlRow);
        return wrap;
    };

    const settingsGroup = (label, children, summaryText = '', open = false, options = {}) => {
        const sectionKey = label === '基础信息' ? 'identity'
            : label === '系统提示词' || label === '提示词' ? 'prompt'
                : label === '模型设置' ? 'model' : 'agent';
        const expanded = open || state.expandedSettingsSections?.has(sectionKey);
        const group = node('div', `agent-settings-collapsible-container agent-settings-section${expanded ? '' : ' collapsed'}`);
        group.dataset.sectionKey = sectionKey;
        const header = node('div', 'agent-settings-section-header');
        const title = node('span', 'agent-settings-section-title', label);
        const summary = node('div', 'agent-settings-section-summary');
        if (options.identitySummary) {
            summary.id = 'agent-build-identity-summary';
            summary.classList.add('summary-with-avatar');
            const avatar = document.createElement('img');
            avatar.className = 'agent-settings-summary-avatar';
            avatar.src = options.identitySummary.avatarUrl || 'assets/default_avatar.png';
            avatar.alt = '';
            avatar.width = 30;
            avatar.height = 30;
            summary.append(avatar, node('span', 'agent-settings-summary-label', options.identitySummary.name || '未命名 Agent'));
        } else {
            summary.textContent = summaryText || '未设置';
        }
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'agent-settings-toggle-btn';
        toggle.setAttribute('aria-label', `展开或收起${label}`);
        toggle.innerHTML = '<svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>';
        header.append(title, summary, toggle);
        const content = node('div', 'agent-settings-section-content');
        const shell = options.identity ? node('div', 'agent-identity-container') : node('div', 'agent-settings-card-shell');
        shell.append(...children.filter(Boolean));
        content.append(shell);
        group.append(header, content);
        const setCollapsed = (collapsed) => {
            group.classList.toggle('collapsed', collapsed);
            toggle.setAttribute('aria-expanded', String(!collapsed));
            if (collapsed) state.expandedSettingsSections?.delete(sectionKey);
            else state.expandedSettingsSections?.add(sectionKey);
        };
        setCollapsed(!expanded);
        header.addEventListener('click', (event) => {
            if (event.target.closest('input, select, textarea, button')) {
                if (event.target.closest('button')) setCollapsed(!group.classList.contains('collapsed'));
                return;
            }
            setCollapsed(!group.classList.contains('collapsed'));
        });
        return group;
    };

    const textarea = ({ label, value, placeholder, payloadKey, message, readOnly = false }) => {
        const wrap = node('label', 'agent-chat-setting-field');
        wrap.append(node('span', 'agent-chat-setting-label', label));
        const control = document.createElement('textarea');
        control.className = 'agent-chat-setting-input agent-chat-setting-prompt';
        control.readOnly = readOnly;
        control.rows = 5;
        control.value = value || '';
        control.placeholder = placeholder;
        control.setAttribute('aria-label', label);
        if (readOnly) {
            control.title = '此字段属于已创建 Codex Thread 的身份；修改 Agent 默认后可创建派生会话。';
        } else {
            control.addEventListener('input', () => {
                state.settingsSaveState = 'dirty';
                state.settingsSaveMessage = '有修改尚未保存';
                state.settingsSaveByScope.set(sessionId ? 'session' : 'profile', { state: 'dirty', message: '有修改尚未保存' });
                const nextValue = control.value.trim();
                scheduleTextSave(targetKey, payloadKey,
                    () => persistWorkbenchSettings({ [payloadKey]: nextValue }, sessionId, message));
            });
        }
        wrap.append(control);
        return wrap;
    };

    {
        if (!sessionId) {
            const identityNameField = field('Agent 名称', profile.name || profile.id || '', (value) => {
                void persistWorkbenchSettings({ name: String(value || '').trim() }, '', '已自动保存 Agent 名称');
            });
            identityNameField.classList.add('agent-name-wrapper');
            const identityMain = node('div', 'agent-identity-main');
            identityMain.append(renderAvatar({ state, profile, controller, run, refreshControlPlane, notify, node, sameAgent }), identityNameField);
            form.append(settingsGroup('基础信息', [identityMain], '', false, {
                identity: true,
                identitySummary: { name: profile.name || profile.id, avatarUrl: profile.avatarUrl },
            }));
        }
        const modelOptions = configOptions('model', { modelCatalog: state.modelCatalog });
        const configuredModelOptions = model && !modelOptions.some((item) => item.value === model)
            ? [...modelOptions, { value: model, label: model }] : modelOptions;
        const modelControl = field('模型', model, (value) => {
            state.model = value;
            void persistWorkbenchSettings({ model: String(value || '').trim(), reasoningEffort: null }, sessionId,
                sessionId ? `已自动保存模型：${value}` : `已自动保存默认模型：${value}`);
        }, state.modelCatalog.length ? configuredModelOptions : null, {
            placeholder: '输入模型名称',
        });
        const refreshModelButton = button(state.modelCatalogLoading ? '正在刷新模型…' : '刷新模型列表',
            'secondary agent-chat-settings-save agent-chat-model-refresh');
        refreshModelButton.disabled = state.modelCatalogLoading;
        refreshModelButton.addEventListener('click', () => run(() => refreshModelCatalog()));
        const modelStatus = node('p', 'agent-chat-setting-hint agent-chat-model-status',
            state.modelCatalogError || (state.modelCatalog.length
                ? `已载入 ${state.modelCatalog.length} 个模型` : '可直接填写模型名称。'));
        modelStatus.setAttribute('role', 'status');
        const modelActions = node('div', 'agent-chat-model-actions');
        modelActions.append(refreshModelButton, modelStatus);
        const modelFields = [workspaceField(),
        modelControl, modelActions, field('本地工具审批', permissionMode, (value) => {
            const next = value === 'always-approve' ? 'always-approve' : 'ask';
            state.permissionMode = next;
            void persistWorkbenchSettings({ permissionMode: next }, sessionId,
                next === 'always-approve' ? '已自动保存本地 YOLO' : '已自动保存逐次确认');
        }, configOptions('permissionMode'))];
        const metadata = state.modelCatalog.find((item) => item.id === model);
        const efforts = Array.isArray(metadata?.reasoningEfforts) ? metadata.reasoningEfforts : [];
        modelFields.push(field('推理强度', reasoningEffort || '', (value) => {
            void persistWorkbenchSettings({ reasoningEffort: value || null }, sessionId,
                value ? `已自动保存推理强度：${value}` : '已恢复模型默认推理强度');
        }, configOptions('reasoningEffort', { reasoningEfforts: efforts }), {
            disabled: efforts.length === 0,
            title: efforts.length ? '' : '该模型没有提供 reasoning effort capability，只能使用模型默认值。',
        }));
        modelFields.push(field('指令来源', instructionMode, async (value) => {
            const createDerivedSession = Boolean(sessionId && materialized
                && instructionMode === 'vchat-identity' && value === 'codex-managed');
            if (createDerivedSession && !(await host.feedback.confirm({
                title: '创建派生会话',
                message: 'Codex 0.146 无法可靠清除这个 Thread 已保存的 VChat 身份指令。将保留原会话，并创建一个继承当前配置的新会话。是否继续？',
            }))) return;
            void persistWorkbenchSettings({ instructionMode: value, ...(createDerivedSession ? { createDerivedSession: true } : {}) }, sessionId,
                value === 'codex-managed' ? '已切换为 Codex 管理指令' : '已切换为 VChat 身份指令');
        }, configOptions('instructionMode')));
        form.append(settingsGroup('模型设置', modelFields, model || '未选择模型'));

        if (instructionMode === 'vchat-identity') {
            form.append(settingsGroup('系统提示词', [textarea({
                label: materialized ? 'VChat 身份提示词（下一轮应用）' : 'VChat 身份提示词',
                value: baseInstructions, placeholder: '例如：{{Nova}}', payloadKey: 'baseInstructions',
                message: sessionId ? '已自动保存当前 Session 身份提示词' : '已自动保存 Agent 身份提示词',
                readOnly: false,
            }), node('p', 'agent-chat-setting-help', 'ToolBox 占位符会在请求边界展开。')],
                baseInstructions || '未设置'));
        } else {
            form.append(field('Personality', personality, (value) => {
                void persistWorkbenchSettings({ personality: value }, sessionId, '已自动保存 Codex personality');
            }, [{ value: 'none', label: '不指定' }, { value: 'friendly', label: 'Friendly' }, { value: 'pragmatic', label: 'Pragmatic' }]));
            form.append(settingsGroup('系统提示词', [textarea({
                label: materialized ? '附加 Developer Instructions（冻结快照）' : '附加 Developer Instructions',
                value: developerInstructions, placeholder: '可选；追加到 Codex 0.146 管理的身份',
                payloadKey: 'developerInstructions',
                message: sessionId ? '已自动保存当前 Session 附加指令' : '已自动保存 Agent 附加指令',
                readOnly: false,
            })], developerInstructions || '未设置'));
        }
        if (sessionId && snapshot?.profileId) form.append(renderSessionProfileAction({
            sessionId, snapshot, projection, workspace, controller, run, notify, renderSidebar, node, button, host,
        }));
    }

    appendSettingsStatus(context, { targetKey }, form);
    pane.append(form);
    return pane;
}

function modelOptions(catalog, selected) {
    const options = (catalog || []).map((model) => ({
        value: typeof model === 'string' ? model : model?.id || model?.name || '',
        label: typeof model === 'string' ? model : model?.name || model?.id || '',
    })).filter((model) => model.value);
    if (selected && !options.some((item) => item.value === selected)) options.unshift({ value: selected, label: selected });
    return options;
}

function renderAvatar({ state, profile, controller, run, refreshControlPlane, notify, node, sameAgent }) {
    const agentId = profile.id || profile.name || state.selectedAgent;
    const section = node('section', 'agent-chat-settings-avatar');
    const picker = window.VCPAvatarPicker?.create({
        src: profile.avatarUrl,
        alt: `${profile.name || agentId || 'Agent'} 头像`,
        disabled: state.avatarSaving || !agentId,
        onBusyChange: (busy) => { state.avatarSaving = busy; },
        onError: (error) => notify(error?.message || '头像保存失败。', 'error'),
        onCommit: async (file) => run(async () => {
            const result = await controller.saveAgentAvatar({
                agentId,
                expectedProfileRevision: Number(profile.profileRevision || profile.revision || 1),
                avatarData: { name: file.name, type: file.type, buffer: await file.arrayBuffer() },
            });
            if (!result?.success) throw new Error(result?.error || '头像保存失败。');
            const target = state.agentCatalog.find((agent) => sameAgent(agent.id || agent.name, agentId));
            if (target) target.avatarUrl = result.avatarUrl || profile.avatarUrl;
            await refreshControlPlane();
            notify(`${target?.name || agentId} 的头像已更新。`, 'success');
        }),
    });
    return picker?.element || section;
}

function renderSessionProfileAction({ sessionId, snapshot, projection, workspace, controller, run, notify, renderSidebar, node, button, host }) {
    const fragment = document.createDocumentFragment();
    const summary = node('section', 'agent-chat-settings-summary');
    summary.append(node('strong', 'agent-chat-setting-label', '当前会话配置'));
    const apply = button('应用 Profile 最新配置', 'secondary agent-chat-settings-save');
    apply.addEventListener('click', () => run(async () => {
        const expectedConfigRevision = Number(projection?.configRevision || 1);
        const preview = await controller.applyAgentProfile({ sessionId, expectedConfigRevision, previewOnly: true });
        if (!preview?.differences?.length) { notify('当前 Session 已使用 Profile 最新配置。', 'success'); return; }
        const detail = preview.differences.map((item) => `${item.field}: ${item.current ?? '空'} → ${item.next ?? '空'}`).join('\n');
        const action = preview.requiresNewSession ? '身份字段发生变化，将创建派生 Session。' : '模型、推理和权限将从下一 Turn 生效。';
        if (!(await host.feedback.confirm({ title: action, message: detail, danger: preview.requiresNewSession }))) return;
        const result = await controller.applyAgentProfile({ sessionId, expectedConfigRevision, createNewSession: preview.requiresNewSession });
        if (result?.createdNewSession && result.session?.sessionId) {
            await controller.previewTopic(result.session.sessionId, result.session.agentId, result.session);
            notify('已按 Profile 最新身份创建派生 Session。', 'success');
        } else notify('已应用 Profile 最新配置。', 'success');
        renderSidebar();
    }));
    fragment.append(summary, apply); return fragment;
}
