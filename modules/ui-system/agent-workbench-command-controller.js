function createWorkbenchCommandController(context) {
    const {
        store, requireApi, runtimeApi, refreshStatus, selectedRuntime, selectedSessionId,
        selectedTurnId, ensureSessionRuntime, previewTopic, hydrateTopic, beginSnapshotBarrier,
        releaseSnapshotBarrier,
    } = context;

    const topicPayload = (payload, agentId) => (
        agentId === undefined || agentId === null || String(agentId).trim() === ''
            ? payload : { ...payload, agentId: String(agentId).trim() }
    );

    async function startRuntime() {
        const result = await requireApi('agentRuntimeStart')();
        await refreshStatus();
        return result;
    }

    async function stopRuntime() {
        const result = await requireApi('agentRuntimeStop')();
        store.setState({ activeTurnId: null });
        await refreshStatus();
        return result;
    }

    async function createSession(options = {}) {
        const barrier = beginSnapshotBarrier();
        const created = await requireApi('agentSessionCreate')(options);
        await refreshStatus();
        if (created.topicId) {
            try { await hydrateTopic(created.topicId, created, barrier, created.agentId); }
            catch { releaseSnapshotBarrier(barrier, null, created); }
        } else {
            releaseSnapshotBarrier(barrier, null, created);
        }
        return created;
    }

    async function createTopic(options = {}) {
        const topic = await requireApi('agentSessionCreate')(options);
        const topicId = String(topic?.topicId || '').trim();
        const agentId = String(topic?.agentId || options.agent || options.agentId || '').trim();
        if (!topicId || !agentId) throw new Error('Codex Runtime 未返回新会话的完整身份');
        await previewTopic(topicId, agentId, {
            title: topic.title || '', model: topic.model || '', workspaceRoot: topic.workspaceRoot || '',
        });
        return { ...topic, topicId, agentId };
    }

    async function forkSession({ sessionId, turnId, title } = {}) {
        const sourceSessionId = sessionId || selectedRuntime()?.sessionId || store.getState().selectedTopic?.topicId;
        if (!sourceSessionId) throw new Error('请先选择要创建分支的会话');
        const fork = await requireApi('agentSessionFork')({ sessionId: sourceSessionId, turnId, title });
        const topicId = fork?.topicId || fork?.sessionId;
        if (!topicId) throw new Error('Codex thread/fork 未返回新会话身份');
        await previewTopic(topicId, fork.agentId, fork);
        return fork;
    }

    async function compactSession(sessionId, instructions) {
        store.setState({ context: { ...store.getState().context, compacting: true, summary: '' } });
        try {
            const result = await requireApi('agentRuntimeCompactSession')({
                sessionId, instructions: instructions || undefined,
            });
            const refreshedTopicId = result?.topicId
                || (result?.snapshot ? (result?.sessionId ? result.sessionId : sessionId) : null);
            if (refreshedTopicId) await hydrateTopic(refreshedTopicId);
            return result;
        } finally {
            store.setState({ context: { ...store.getState().context, compacting: false } });
        }
    }

    const listTopics = (agentId, options = {}) => requireApi('agentSessionList')(topicPayload(options, agentId));
    const searchTopics = (query, agentId, limit = 20) => requireApi('agentRuntimeSearchTopics')(
        topicPayload({ query, limit }, agentId),
    );
    const searchTopicMessages = (query, topicId, agentId, limit = 50) => requireApi(
        'agentRuntimeSearchTopicMessages',
    )(topicPayload({ query, topicId, limit }, agentId));
    const getTopicIndexStatus = () => requireApi('agentRuntimeGetTopicIndexStatus')();
    const rebuildTopicIndex = () => requireApi('agentRuntimeRebuildTopicIndex')();
    const readTopic = (topicId, agentId) => requireApi('agentSessionRead')({
        sessionId: topicId, ...(agentId ? { agentId } : {}),
    });
    const renameTopic = (topicId, title, agentId) => requireApi('agentSessionRename')({
        sessionId: topicId, title, ...(agentId ? { agentId } : {}),
    });
    const deleteTopic = (topicId) => requireApi('agentSessionArchive')({ sessionId: topicId });
    const archiveSession = (sessionId) => requireApi('agentSessionArchive')({ sessionId });
    const restoreSession = (sessionId) => requireApi('agentSessionRestore')({ sessionId });
    const permanentlyDeleteSession = (sessionId) => requireApi('agentSessionDelete')({ sessionId });
    const exportSession = (sessionId, format = 'markdown') => requireApi('agentRuntimeExportSession')({ sessionId, format });
    const listRecoveryOperations = () => requireApi('agentRuntimeListRecoveryOperations')();
    const listRecoveryCandidates = () => requireApi('agentRuntimeListRecoveryCandidates')();
    const resolveRecoveryOperation = (operationId, action, threadId) => requireApi(
        'agentRuntimeResolveRecoveryOperation',
    )({ operationId, action, threadId });
    const setSessionPinned = (sessionId, pinned) => requireApi('agentRuntimeSetSessionPinned')({ sessionId, pinned });

    function requireSelectedSession() {
        const sessionId = selectedSessionId();
        if (!sessionId) throw new Error('请先选择 Agent Session');
        return sessionId;
    }
    const listInteractionQueue = () => requireApi('agentRuntimeListInteractionQueue')({
        sessionId: requireSelectedSession(),
    });
    const replaceInteractionQueue = (interactions) => requireApi('agentRuntimeReplaceInteractionQueue')({
        sessionId: requireSelectedSession(), interactions,
    });
    const clearInteractionQueue = () => requireApi('agentRuntimeClearInteractionQueue')({
        sessionId: requireSelectedSession(),
    });
    const resolvePendingInput = (inputId, action) => requireApi('agentRuntimeResolvePendingInput')({
        sessionId: requireSelectedSession(), inputId, action,
    });
    const getWorkbenchSettings = () => requireApi('agentRuntimeGetWorkbenchSettings')();

    async function updateWorkbenchSettings(settings) {
        const result = settings?.sessionId
            ? await requireApi('agentRuntimeUpdateSessionConfig')({
                sessionId: settings.sessionId,
                expectedConfigRevision: settings.expectedConfigRevision,
                patch: Object.fromEntries(Object.entries(settings).filter(([key]) => ![
                    'sessionId', 'topicId', 'expectedConfigRevision',
                ].includes(key))),
            })
            : await requireApi('agentRuntimeUpdateWorkbenchSettings')(settings);
        const saved = result?.session;
        const current = store.getState();
        if (saved?.sessionId) {
            const configSnapshot = saved.configSnapshot || null;
            const activeRuntimes = new Map(current.activeRuntimes);
            const runtime = activeRuntimes.get(saved.sessionId);
            if (runtime) activeRuntimes.set(saved.sessionId, {
                ...runtime,
                model: configSnapshot?.model || saved.model || runtime.model || '',
                workspaceRoot: saved.workspaceRoot || runtime.workspaceRoot,
                configSnapshot,
                appliedRuntimeConfig: saved.appliedRuntimeConfig || runtime.appliedRuntimeConfig || null,
                configRevision: saved.configRevision || runtime.configRevision,
                appliedRuntimeConfigRevision: saved.appliedRuntimeConfigRevision
                    ?? runtime.appliedRuntimeConfigRevision ?? 0,
                configApplyState: saved.configApplyState || saved.applyState || runtime.configApplyState,
                configApplyError: saved.configApplyError || saved.applyError || null,
            });
            const selected = current.selectedSessionId === saved.sessionId;
            const model = configSnapshot?.model || saved.model || current.selectedTopic?.model || '';
            store.setState({
                activeRuntimes,
                ...(selected ? { selectedTopic: {
                    ...current.selectedTopic,
                    model,
                    workspaceRoot: saved.workspaceRoot || current.selectedTopic?.workspaceRoot || '',
                    workspaceRef: saved.workspaceRoot || current.selectedTopic?.workspaceRef || '',
                    configSnapshot,
                    configRevision: saved.configRevision || current.selectedTopic?.configRevision,
                    appliedRuntimeConfig: saved.appliedRuntimeConfig || current.selectedTopic?.appliedRuntimeConfig || null,
                    appliedRuntimeConfigRevision: saved.appliedRuntimeConfigRevision
                        ?? current.selectedTopic?.appliedRuntimeConfigRevision ?? 0,
                    configApplyState: saved.configApplyState || saved.applyState
                        || current.selectedTopic?.configApplyState || null,
                    configApplyError: saved.configApplyError || saved.applyError || null,
                } } : {}),
            });
        }
        return result;
    }

    async function applyAgentProfile(settings) {
        const result = await requireApi('agentRuntimeApplyAgentProfile')(settings);
        if (result?.session?.sessionId && result.applied) {
            const current = store.getState();
            if (current.selectedTopic?.topicId === result.session.sessionId) {
                store.setState({ selectedTopic: {
                    ...current.selectedTopic,
                    configSnapshot: result.session.configSnapshot,
                    configRevision: result.session.configRevision,
                    workspaceRoot: result.session.workspaceRoot,
                    workspaceRef: result.session.workspaceRoot,
                    model: result.session.configSnapshot?.model || current.selectedTopic.model,
                } });
            }
        }
        return result;
    }

    const selectAttachments = () => requireApi('agentRuntimeSelectAttachments')({
        sessionId: requireSelectedSession(),
    });

    async function startTurn(prompt, attachments = []) {
        let current = store.getState();
        const selected = current.selectedTopic;
        let runtime = selectedRuntime(current);
        if (selected?.topicId && !runtime) {
            if (!selected.agentId) {
                throw new Error('当前会话缺少持久化的助手身份，不能猜测并发送。请重新从会话列表打开它。');
            }
            runtime = await ensureSessionRuntime(selected.topicId, 'send');
            current = store.getState();
        }
        const sessionId = runtime?.sessionId || selectedRuntime(current)?.sessionId || selected?.topicId;
        if (!sessionId) throw new Error('请先选择或新建 Session');
        const accepted = await requireApi('agentRuntimeStartTurn')({ sessionId, prompt, attachments });
        store.addPendingUserMessage({ turnId: accepted?.turnId, prompt, attachments });
        return accepted;
    }

    async function cancelTurn() {
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId) return null;
        return requireApi('agentRuntimeCancelTurn')({ sessionId, turnId: selectedTurnId() || undefined });
    }
    async function cancelTool(toolCallId, turnId) {
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId || !toolCallId) return null;
        const direct = runtimeApi.agentRuntimeCancelTool;
        if (typeof direct === 'function') return direct.call(runtimeApi, { sessionId, toolCallId });
        if (!turnId) throw new Error('该工具事件缺少 Codex turnId，不能猜测并取消其他任务');
        return requireApi('agentRuntimeCancelTurn')({ sessionId, turnId });
    }
    async function steerTurn(prompt) {
        const sessionId = selectedRuntime()?.sessionId;
        const turnId = selectedTurnId();
        if (!sessionId || !turnId) throw new Error('当前没有可插入指令的任务');
        return requireApi('agentRuntimeSteerTurn')({ sessionId, turnId, prompt });
    }
    async function followUpTurn(prompt) {
        const sessionId = selectedRuntime()?.sessionId;
        const turnId = selectedTurnId();
        if (!sessionId || !turnId) throw new Error('当前没有可追加后续指令的任务');
        return requireApi('agentRuntimeFollowUpTurn')({ sessionId, turnId, prompt });
    }

    async function respondApproval(approval, decision) {
        const result = await requireApi('agentRuntimeRespondApproval')({
            approvalId: approval.approvalId,
            decision,
            ...(approval.scope ? { scope: approval.scope } : {}),
            sessionId: approval.sessionId,
            turnId: approval.turnId,
            toolCallId: approval.toolCallId,
            argumentsHash: approval.argumentsHash,
            ...(Number.isFinite(Number(approval.generation)) ? { generation: Number(approval.generation) } : {}),
        });
        const key = `${approval.scope || approval.source || 'codex-native'}:${approval.approvalId}`;
        store.setState({ approvals: store.getState().approvals.filter((item) => (
            `${item.scope || item.source || 'codex-native'}:${item.approvalId}` !== key
        )) });
        return result;
    }
    const respondInteraction = (interaction, response) => requireApi('agentRuntimeRespondInteraction')({
        source: interaction.source,
        requestId: interaction.requestId,
        kind: interaction.kind,
        response,
        ...(Number.isFinite(Number(interaction.generation)) ? { generation: Number(interaction.generation) } : {}),
    });
    function respondToolboxApproval(approvalId, decision, generation) {
        if (!approvalId) throw new Error('ToolBox 后端审批缺少 requestId');
        return requireApi('agentRuntimeRespondApproval')({
            approvalId, decision, scope: 'toolbox',
            ...(Number.isFinite(Number(generation)) ? { generation: Number(generation) } : {}),
        });
    }

    return {
        startRuntime, stopRuntime, createSession, createTopic, forkSession, compactSession,
        listTopics, searchTopics, searchTopicMessages, getTopicIndexStatus, rebuildTopicIndex,
        readTopic, renameTopic, deleteTopic, archiveSession, restoreSession, permanentlyDeleteSession,
        exportSession, listRecoveryOperations, listRecoveryCandidates, resolveRecoveryOperation, setSessionPinned,
        listInteractionQueue, replaceInteractionQueue, clearInteractionQueue, resolvePendingInput,
        getWorkbenchSettings, updateWorkbenchSettings, applyAgentProfile, selectAttachments,
        startTurn, cancelTurn, cancelTool, steerTurn, followUpTurn,
        respondApproval, respondInteraction, respondToolboxApproval,
        workspaceListDirectory: (payload) => requireApi('agentWorkspaceListDirectory')(payload),
        workspaceReadPreview: (payload) => requireApi('agentWorkspaceReadPreview')(payload),
        workspaceSearchFiles: (payload) => requireApi('agentWorkspaceSearchFiles')(payload),
        workspaceStatPath: (payload) => requireApi('agentWorkspaceStatPath')(payload),
        workspacePerformPathAction: (payload) => requireApi('agentWorkspacePerformPathAction')(payload),
        workspaceCancel: (payload) => requireApi('agentWorkspaceCancel')(payload),
    };
}

export { createWorkbenchCommandController };
