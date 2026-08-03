import './avatar-picker.js';

export function renderAgentSettingsPane(context) {
    const {
        state, store, activeSession, sessionConfigRevisions, selectedAgentProfile,
        profileNeedsConfiguration, persistWorkbenchSettings, renderSidebar,
        run, refreshControlPlane, notify, controller, refreshRecoveryOperations,
        refreshTopicsForAgent, node, button, sameAgent, scheduleTextSave, scheduleBudgetSave,
        settingValue, settingStatus,
    } = context;
    const pane = node('div', 'agent-chat-settings-pane');
    const form = node('div', 'agent-chat-settings-form');
    const current = store.getState();
    const rawSessionId = current.selectedSessionId || current.selectedTopic?.sessionId || '';
    const sessionId = state.settingsScope === 'session' ? rawSessionId : '';
    const projection = sessionId ? current.selectedTopic : null;
    const runtime = activeSession();
    const snapshot = projection?.configSnapshot || (sessionId ? runtime?.configSnapshot : null) || null;
    if (sessionId && projection?.configRevision) {
        sessionConfigRevisions.set(sessionId, Number(projection.configRevision));
    }
    const threadId = runtime?.threadId || projection?.threadId || projection?.session?.threadId || null;
    const materialized = Boolean(sessionId && threadId);
    const profile = selectedAgentProfile() || {};
    const targetKey = sessionId ? `session:${sessionId}` : `profile:${profile.id || profile.name || 'unselected'}`;
    const workspaceFallback = projection?.workspaceRef || projection?.workspaceRoot
        || (runtime?.sessionId === sessionId ? runtime.workspaceRoot : '')
        || profile.workspaceRoot || state.workspace;
    const permissionFallback = snapshot?.permissionMode
        || (snapshot?.approvalPolicy === 'never' ? 'always-approve'
            : snapshot?.approvalPolicy ? 'ask' : state.permissionMode);
    const workspace = settingValue(targetKey, 'workspaceRoot', workspaceFallback);
    const permissionMode = settingValue(targetKey, 'permissionMode', permissionFallback);
    const model = settingValue(targetKey, 'model', snapshot?.model || profile.model || state.model);
    state.permissionMode = permissionMode;
    const instructionMode = settingValue(targetKey, 'instructionMode', snapshot?.instructionMode || profile.instructionMode) === 'codex-managed'
        ? 'codex-managed' : 'vchat-identity';
    const baseInstructions = settingValue(targetKey, 'baseInstructions', snapshot?.baseInstructions ?? profile.baseInstructions ?? profile.systemPrompt ?? '');
    const developerInstructions = settingValue(targetKey, 'developerInstructions', snapshot?.developerInstructions ?? profile.developerInstructions ?? '');
    const personality = settingValue(targetKey, 'personality', snapshot?.personality || profile.personality || 'none');
    const reasoningEffort = settingValue(targetKey, 'reasoningEffort', snapshot?.reasoningEffort ?? profile.reasoningEffort ?? '');

    const scopes = node('div', 'agent-chat-settings-scopes');
    for (const [scope, label] of [['profile', 'Agent 默认'], ['session', '当前会话'], ['advanced', '高级']]) {
        const control = button(label, `agent-chat-settings-scope${state.settingsScope === scope ? ' is-active' : ''}`);
        control.setAttribute('aria-pressed', String(state.settingsScope === scope));
        control.disabled = scope === 'session' && !rawSessionId;
        control.addEventListener('click', () => { state.settingsScope = scope; renderSidebar(); });
        scopes.append(control);
    }
    pane.append(scopes, node('p', 'agent-chat-settings-placeholder', state.settingsScope === 'advanced'
        ? '运行预算、版本、恢复和导出入口。这里不改变 Agent 身份。'
        : sessionId
        ? '模型、推理和审批从下一 Turn 生效；身份字段修改需要创建派生会话。'
        : '这里是新会话的 Agent Profile 模板；新建会话会一键继承全部默认值。'));

    if (state.settingsScope === 'profile' && profileNeedsConfiguration()) {
        const warning = node('section', 'agent-chat-profile-configuration-warning is-settings');
        warning.setAttribute('role', 'alert');
        warning.append(node('strong', '', '此 Agent 还不能创建会话'), node('span', '',
            state.profileConfigurationNotice || '请填写下方 Agent 提示词。保存完成后即可直接新建会话。'));
        pane.append(warning);
    }

    const field = (label, value, onChange, options = null, controlOptions = {}) => {
        const wrap = node('label', 'agent-chat-setting-field');
        wrap.append(node('span', 'agent-chat-setting-label', label));
        const control = options ? document.createElement('select') : document.createElement('input');
        control.className = 'agent-chat-setting-input';
        control.disabled = controlOptions.disabled === true;
        if (controlOptions.title) control.title = controlOptions.title;
        if (!options) control.value = value || '';
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

    if (state.settingsScope !== 'advanced') {
        if (!sessionId) form.append(renderAvatar({ state, profile, controller, run, refreshControlPlane, notify, node, sameAgent }));
        const fields = [];
        if (!sessionId) fields.push(field('名称', profile.name || profile.id || '', (value) => {
            void persistWorkbenchSettings({ name: String(value || '').trim() }, '', '已自动保存 Agent 名称');
        }));
        fields.push(field('工作目录（可留空）', workspace, (value) => {
            if (!sessionId) state.workspace = value;
            void persistWorkbenchSettings({ workspaceRoot: value }, sessionId,
                sessionId ? '已自动保存当前 Session 工作目录' : '已自动保存 Agent 默认工作目录');
        }, null, { title: materialized ? 'Codex 0.146 会从下一 Turn 使用新的工作目录。' : '' }));
        fields.push(field('模型', model, (value) => {
            state.model = value;
            void persistWorkbenchSettings({ model: String(value || '').trim(), reasoningEffort: null }, sessionId,
                sessionId ? `已自动保存模型：${value}` : `已自动保存默认模型：${value}`);
        }, modelOptions(state.modelCatalog, model)));
        fields.push(field('本地工具审批', permissionMode, (value) => {
            const next = value === 'always-approve' ? 'always-approve' : 'ask';
            state.permissionMode = next;
            void persistWorkbenchSettings({ permissionMode: next }, sessionId,
                next === 'always-approve' ? '已自动保存本地 YOLO' : '已自动保存逐次确认');
        }, [{ value: 'ask', label: '每次确认（推荐）' }, { value: 'always-approve', label: 'YOLO：本地自动允许' }]));
        const metadata = state.modelCatalog.find((item) => item.id === model);
        const efforts = Array.isArray(metadata?.reasoningEfforts) ? metadata.reasoningEfforts : [];
        fields.push(field('推理强度', reasoningEffort || '', (value) => {
            void persistWorkbenchSettings({ reasoningEffort: value || null }, sessionId,
                value ? `已自动保存推理强度：${value}` : '已恢复模型默认推理强度');
        }, [{ value: '', label: '模型默认' }, ...efforts.map((value) => ({ value, label: value }))], {
            disabled: efforts.length === 0,
            title: efforts.length ? '' : '该模型没有提供 reasoning effort capability，只能使用模型默认值。',
        }));
        fields.push(field('指令来源', instructionMode, (value) => {
            const createDerivedSession = Boolean(sessionId && materialized
                && instructionMode === 'vchat-identity' && value === 'codex-managed');
            if (createDerivedSession && !window.confirm(
                'Codex 0.146 无法可靠清除这个 Thread 已保存的 VChat 身份指令。将保留原会话，并创建一个继承当前配置的新会话。是否继续？',
            )) return;
            void persistWorkbenchSettings({ instructionMode: value, ...(createDerivedSession ? { createDerivedSession: true } : {}) }, sessionId,
                value === 'codex-managed' ? '已切换为 Codex 管理指令' : '已切换为 VChat 身份指令');
        }, [{ value: 'vchat-identity', label: 'VChat 身份' }, { value: 'codex-managed', label: 'Codex 0.146 管理' }]));
        form.append(...fields);

        if (instructionMode === 'vchat-identity') {
            form.append(textarea({
                label: materialized ? 'VChat 身份提示词（下一轮应用）' : 'VChat 身份提示词',
                value: baseInstructions, placeholder: '例如：{{Nova}}', payloadKey: 'baseInstructions',
                message: sessionId ? '已自动保存当前 Session 身份提示词' : '已自动保存 Agent 身份提示词',
                readOnly: false,
            }), node('p', 'agent-chat-setting-help', 'ToolBox 占位符会原样保存并在 ToolBox 请求边界展开；Codex 内置身份不会同时发送。'));
        } else {
            form.append(field('Personality', personality, (value) => {
                void persistWorkbenchSettings({ personality: value }, sessionId, '已自动保存 Codex personality');
            }, [{ value: 'none', label: '不指定' }, { value: 'friendly', label: 'Friendly' }, { value: 'pragmatic', label: 'Pragmatic' }]));
            form.append(textarea({
                label: materialized ? '附加 Developer Instructions（冻结快照）' : '附加 Developer Instructions',
                value: developerInstructions, placeholder: '可选；追加到 Codex 0.146 管理的身份',
                payloadKey: 'developerInstructions',
                message: sessionId ? '已自动保存当前 Session 附加指令' : '已自动保存 Agent 附加指令',
                readOnly: false,
            }), node('p', 'agent-chat-setting-help', 'Codex 完整内部 prompt 不由协议返回，因此这里只显示可配置来源，不伪造隐藏内容。'));
        }
        if (sessionId && snapshot?.profileId) form.append(renderSessionProfileAction({
            sessionId, snapshot, projection, workspace, controller, run, notify, renderSidebar, node, button,
        }));
        form.append(node('p', 'agent-chat-settings-placeholder', 'YOLO 仅跳过 Codex 本地审批；VCPToolBox 的后端审批不会被关闭或绕过。'));
    } else {
        form.append(renderAdvanced({
            state, store, persistWorkbenchSettings, scheduleBudgetSave, refreshRecoveryOperations,
            controller, run, notify, refreshTopicsForAgent, renderSidebar, node, button,
        }));
    }

    const status = settingStatus(targetKey) || state.settingsSaveByScope.get(state.settingsScope)
        || { state: 'idle', message: '' };
    const statusNode = node('p', `agent-chat-settings-save-status is-${status.state}`, status.message || '修改后自动保存');
    statusNode.setAttribute('role', 'status');
    form.append(statusNode);
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
    const copy = node('div', 'agent-chat-settings-avatar-copy');
    copy.append(node('strong', 'agent-chat-setting-label', 'Agent 头像'),
        node('span', 'agent-chat-setting-help', state.avatarSaving ? '正在保存头像…' : '点击头像选择并裁剪；仅用于 Build Agent，不影响主聊天助手。'));
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
    if (picker) section.append(picker.element, copy);
    return section;
}

function renderSessionProfileAction({ sessionId, snapshot, projection, workspace, controller, run, notify, renderSidebar, node, button }) {
    const fragment = document.createDocumentFragment();
    const summary = node('section', 'agent-chat-settings-summary');
    summary.append(node('strong', 'agent-chat-setting-label', '会话冻结快照'),
        node('span', 'agent-chat-setting-help', `Profile ${snapshot.profileId} · revision ${snapshot.profileRevision || 1} · Session config ${projection?.configRevision || 1}`),
        node('span', 'agent-chat-setting-help', `Workspace：${workspace || '未设置'}`));
    const apply = button('应用 Profile 最新配置', 'secondary agent-chat-settings-save');
    apply.addEventListener('click', () => run(async () => {
        const expectedConfigRevision = Number(projection?.configRevision || 1);
        const preview = await controller.applyAgentProfile({ sessionId, expectedConfigRevision, previewOnly: true });
        if (!preview?.differences?.length) { notify('当前 Session 已使用 Profile 最新配置。', 'success'); return; }
        const detail = preview.differences.map((item) => `${item.field}: ${item.current ?? '空'} → ${item.next ?? '空'}`).join('\n');
        const action = preview.requiresNewSession ? '身份字段发生变化，将创建派生 Session。' : '模型、推理和权限将从下一 Turn 生效。';
        if (!window.confirm?.(`${action}\n\n${detail}`)) return;
        const result = await controller.applyAgentProfile({ sessionId, expectedConfigRevision, createNewSession: preview.requiresNewSession });
        if (result?.createdNewSession && result.session?.sessionId) {
            await controller.previewTopic(result.session.sessionId, result.session.agentId, result.session);
            notify('已按 Profile 最新身份创建派生 Session。', 'success');
        } else notify('已应用 Profile 最新配置。', 'success');
        renderSidebar();
    }));
    fragment.append(summary, apply); return fragment;
}

function renderAdvanced({ state, store, persistWorkbenchSettings, scheduleBudgetSave, refreshRecoveryOperations, controller, run, notify, refreshTopicsForAgent, node, button }) {
    const fragment = document.createDocumentFragment();
    const runtime = node('section', 'agent-chat-settings-budget agent-chat-settings-runtime-info');
    runtime.append(node('strong', 'agent-chat-setting-label', 'Runtime 与协议'),
        node('span', 'agent-chat-setting-help', 'Codex App Server 0.146 · schema pinned · execution profile toolbox-only'),
        node('span', 'agent-chat-setting-help', `Runtime：${store.getState().runtime?.state || 'unknown'} · Projection：SQLite`));
    const budget = node('section', 'agent-chat-settings-budget');
    budget.append(node('strong', 'agent-chat-setting-label', '新 Session 每轮安全预算'),
        node('p', 'agent-chat-settings-placeholder', '留空表示不设客户端上限。预算属于运行配置，不属于用量统计。'));
    const budgetFields = node('div', 'agent-chat-settings-budget-fields');
    for (const [label, name] of [['模型请求数', 'maxRequestsPerTurn'], ['累计 token', 'maxTokensPerTurn']]) {
        const wrap = node('label', 'agent-chat-setting-field');
        wrap.append(node('span', 'agent-chat-setting-label', label));
        const input = document.createElement('input');
        input.className = 'agent-chat-setting-input'; input.type = 'number'; input.name = name; input.min = '1'; input.step = '1'; input.placeholder = '不限';
        input.value = state.budget[name] == null ? '' : String(state.budget[name]);
        input.addEventListener('input', () => {
            state.budget = { ...state.budget, [name]: String(input.value || '').trim() || null };
            scheduleBudgetSave(() => persistWorkbenchSettings({ budget: { ...state.budget } }, '', '已自动保存新 Session 安全预算'));
        });
        wrap.append(input); budgetFields.append(wrap);
    }
    budget.append(budgetFields);
    const recovery = node('section', 'agent-chat-settings-budget agent-chat-recovery-section');
    const header = node('div', 'agent-chat-settings-avatar-copy');
    header.append(node('strong', 'agent-chat-setting-label', '一致性恢复'),
        node('span', 'agent-chat-setting-help', '仅显示未完成的跨存储操作；VChat 不自动重放 Turn 或猜测 Thread 归属。'));
    const scan = button(state.recoveryLoading ? '正在检查…' : '扫描未绑定 Thread', 'secondary agent-chat-settings-save');
    scan.disabled = state.recoveryLoading;
    scan.addEventListener('click', () => void refreshRecoveryOperations({ scanThreads: true }));
    header.append(scan); recovery.append(header);
    if (state.recoveryError) recovery.append(node('p', 'agent-chat-settings-save-status is-error', state.recoveryError));
    else if (!state.recoveryOperations.length) recovery.append(node('p', 'agent-chat-settings-placeholder', state.recoveryLoading ? '正在读取 Saga 日志…' : '没有需要人工处理的操作。'));
    else for (const operation of state.recoveryOperations) {
        const card = node('div', 'agent-chat-setting-field agent-chat-recovery-operation');
        card.append(node('span', 'agent-chat-setting-label', `${operation.kind} · ${operation.state}`));
        if (operation.lastError) card.append(node('span', 'agent-chat-setting-help', operation.lastError));
        const recoverable = ['uncertain', 'remote-applied'].includes(operation.state)
            && ['thread-start', 'thread-fork'].includes(operation.kind);
        if (recoverable && state.recoveryThreads.length) {
            const select = document.createElement('select'); select.className = 'agent-chat-setting-input';
            for (const thread of state.recoveryThreads) {
                const option = document.createElement('option'); option.value = thread.threadId; option.textContent = thread.title || thread.threadId; select.append(option);
            }
            const bind = button('绑定到 VChat Session', 'primary agent-chat-settings-save');
            bind.addEventListener('click', () => run(async () => {
                if (!window.confirm?.('确认该 Codex Thread 属于这次未完成操作吗？')) return;
                const result = await controller.resolveRecoveryOperation(operation.operationId, 'bind', select.value);
                if (result?.session?.sessionId) await controller.previewTopic(result.session.sessionId, result.session.agentId, result.session);
                await Promise.all([refreshRecoveryOperations(), refreshTopicsForAgent(state.selectedAgent, false)]);
                notify('未绑定 Thread 已显式绑定。', 'success');
            }));
            const remove = button('删除未绑定 Thread', 'secondary agent-chat-settings-save');
            remove.addEventListener('click', () => run(async () => {
                if (!window.confirm?.('永久删除选中的未绑定 Codex Thread 吗？')) return;
                await controller.resolveRecoveryOperation(operation.operationId, 'delete', select.value);
                await refreshRecoveryOperations({ scanThreads: true });
                notify('未绑定 Thread 已删除。', 'success');
            }));
            const actions = node('div', 'agent-chat-settings-budget-fields'); actions.append(bind, remove); card.append(select, actions);
        }
        recovery.append(card);
    }
    fragment.append(runtime, budget, recovery); return fragment;
}
