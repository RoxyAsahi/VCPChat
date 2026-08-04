function createAgentSessionOperationsCoordinator({
    state, store, controller, selectedAgentProfile, profileNeedsConfiguration,
    refreshControlPlane, queueRender, renderSidebar, notify, rememberTopic,
    clearRememberedTopic, nextSessionTitle, activeSession,
}) {
    let disposed = false;

    async function refreshRecoveryOperations({ scanThreads = false } = {}) {
        state.recoveryLoading = true;
        state.recoveryError = '';
        renderSidebar();
        try {
            const result = scanThreads
                ? await controller.listRecoveryCandidates()
                : await controller.listRecoveryOperations();
            if (disposed || state.disposed) return;
            state.recoveryOperations = scanThreads
                ? (Array.isArray(result?.operations) ? result.operations : [])
                : (Array.isArray(result) ? result : []);
            state.recoveryThreads = scanThreads && Array.isArray(result?.threads) ? result.threads : [];
        } catch (error) {
            if (!disposed && !state.disposed) state.recoveryError = error?.message || String(error);
        } finally {
            if (!disposed && !state.disposed) {
                state.recoveryLoading = false;
                renderSidebar();
            }
        }
    }

    async function createSession(overrides = {}) {
        const created = await controller.createSessionPreview({
            ...(Object.prototype.hasOwnProperty.call(overrides, 'workspaceRoot') ? { workspaceRoot: overrides.workspaceRoot } : {}),
            ...(Object.prototype.hasOwnProperty.call(overrides, 'model') ? { model: overrides.model } : {}),
            ...(Object.prototype.hasOwnProperty.call(overrides, 'systemPrompt') ? { systemPrompt: overrides.systemPrompt } : {}),
            ...(Object.prototype.hasOwnProperty.call(overrides, 'permissionMode') ? { permissionMode: overrides.permissionMode } : {}),
            agent: overrides.agent ?? (state.selectedAgent || 'Nova'),
            title: overrides.title || nextSessionTitle(),
        });
        if (disposed || state.disposed) return created;
        rememberTopic(created);
        state.tab = 'sessions';
        await refreshControlPlane();
        return created;
    }

    async function createNewTopicDirectly() {
        if (state.topicCreating) return null;
        const profile = selectedAgentProfile();
        if (!profile) {
            state.profileConfigurationNotice = '请先选择一个 Build Agent。';
            state.tab = 'agents';
            renderSidebar();
            return null;
        }
        if (profile.historical) {
            state.profileConfigurationNotice = '历史会话仅用于查看旧记录，不能新建会话。请选择或创建一个正式 Build Agent。';
            state.tab = 'agents';
            renderSidebar();
            return null;
        }
        if (profileNeedsConfiguration(profile)) {
            state.profileConfigurationNotice = `Agent「${profile.name || profile.id}」尚未配置提示词。请先在“设置”中填写提示词，避免用错误身份启动 Codex。`;
            state.tab = 'settings';
            renderSidebar();
            return null;
        }
        state.topicCreating = true;
        state.profileConfigurationNotice = '';
        queueRender({ shell: true, header: true, composer: true });
        try {
            const created = await createSession({ agent: state.selectedAgent, title: nextSessionTitle() });
            if (!disposed && !state.disposed) notify(`已新建会话「${created.title || created.sessionId}」。`, 'success');
            return created;
        } finally {
            if (!disposed && !state.disposed) {
                state.topicCreating = false;
                queueRender({ shell: true, header: true, composer: true });
            }
        }
    }

    async function recoverRuntime() {
        if (state.recovering) return;
        state.recovering = true;
        queueRender({ header: true, composer: true });
        try {
            const previous = activeSession();
            await controller.stopRuntime();
            await controller.startRuntime();
            if (disposed || state.disposed) return;
            if (previous?.sessionId) {
                await controller.previewTopic(previous.sessionId, previous.agentId, previous);
                if (!disposed && !state.disposed) notify('Codex App Server 已重新连接，并显示最近的 SQLite 投影。中断的 Turn 不会重放。', 'success');
            } else {
                await refreshControlPlane();
                if (!disposed && !state.disposed) notify('Codex App Server 已重新连接。请新建一个 Agent 会话。', 'success');
            }
        } finally {
            if (!disposed && !state.disposed) {
                state.recovering = false;
                queueRender({ header: true, composer: true });
            }
        }
    }

    function rememberTopicTitle(topic, title) {
        const sessionId = topic?.sessionId || topic?.id;
        if (!sessionId) return;
        if (state.rememberedTopic?.sessionId === sessionId) state.rememberedTopic = { ...state.rememberedTopic, title };
        rememberTopic({ sessionId, title, agentId: topic.agentId || state.selectedAgent || 'Nova' });
    }

    function forgetTopic(sessionId) {
        if (state.rememberedTopic?.sessionId !== sessionId) return;
        state.rememberedTopic = null;
        clearRememberedTopic();
    }

    return Object.freeze({
        refreshRecoveryOperations, createSession, createNewTopicDirectly, recoverRuntime,
        rememberTopicTitle, forgetTopic, dispose() { disposed = true; },
    });
}

export { createAgentSessionOperationsCoordinator };
