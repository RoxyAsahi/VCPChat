import { deriveWorkbenchViewState } from './agent-workbench-store.js';
import { projectVcpToolPresentation } from './agent-workbench-timeline.js';

function composerReadiness(current, composerState, pending, activeTurnId = null) {
    const viewState = deriveWorkbenchViewState(current);
    const previewReady = Boolean(current.selectedTopic?.mode === 'preview'
        && ['idle', 'running', 'awaiting-approval'].includes(viewState));
    const archived = Boolean(current.selectedTopic?.archivedAt);
    const hasActiveTurn = Boolean(activeTurnId);
    const starting = Boolean(pending && !hasActiveTurn);
    const ready = Boolean(!archived && (current.selectedSessionId || previewReady)
        && ['idle', 'running', 'awaiting-approval'].includes(viewState));
    const canSend = Boolean(ready && (composerState.draft.trim()
        || (!hasActiveTurn && composerState.attachments.length)));
    return { viewState, previewReady, archived, activeTurnId, hasActiveTurn, starting, ready, canSend, pending };
}

function createAgentComposerCoordinator({
    state, store, controller, composerView, runStatusView, refs, run, notify,
    selectedSessionKey, selectedComposerState, selectedTurnStart, selectedActiveTurnId,
    renderFeed, renderJumpToLatest, queueRender, settleTurnStartIndicator,
    refreshControlPlane, uxMark, openNewSession, isFollowingContainer, scrollFeed,
}) {
    const { input, feed, jumpToLatest, attachButton, sendButton, newButton } = refs;
    const disposers = [];
    const activeTurnCommands = new Map();
    let disposed = false;

    function createSubmissionId() {
        return globalThis.crypto?.randomUUID?.()
            || `submission_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function listen(element, type, handler, options) {
        element.addEventListener(type, handler, options);
        disposers.push(() => element.removeEventListener(type, handler, options));
    }

    function latestRunningTool(current, turnId) {
        const tools = current.tools instanceof Map ? [...current.tools.values()] : [];
        return tools.filter((tool) => (!turnId || !tool.turnId || tool.turnId === turnId)
            && ['requested', 'running'].includes(tool.state))
            .sort((left, right) => Number(right.lastTimestamp || right.firstTimestamp || 0)
                - Number(left.lastTimestamp || left.firstTimestamp || 0))[0] || null;
    }

    function syncRunStatus(current = store.getState()) {
        const pending = selectedTurnStart(current);
        const turnId = selectedActiveTurnId(current) || pending?.turnId || null;
        if (!turnId && !pending) {
            runStatusView.update({ visible: false });
            return;
        }
        const startedAt = turnId
            ? (state.turnStartedAt.get(turnId) || pending?.startedAt || Date.now())
            : (pending?.startedAt || Date.now());
        if (turnId && !state.turnStartedAt.has(turnId)) state.turnStartedAt.set(turnId, startedAt);
        const viewState = deriveWorkbenchViewState(current);
        const runningTool = latestRunningTool(current, turnId);
        runStatusView.update({
            visible: true,
            state: viewState,
            label: viewState === 'awaiting-approval' ? '等待审批'
                : pending?.phase === 'starting' && !selectedActiveTurnId(current) ? '正在启动 Agent' : '正在运行',
            detail: runningTool ? `正在执行 ${projectVcpToolPresentation(runningTool).label}` : 'Agent 正在处理当前任务',
            startedAt,
            canStop: Boolean(selectedActiveTurnId(current)),
        });
    }

    function render() {
        if (disposed || state.disposed) return;
        const current = store.getState();
        const sessionId = selectedSessionKey(current);
        const composerState = selectedComposerState(current);
        const readiness = composerReadiness(current, composerState, selectedTurnStart(current), selectedActiveTurnId(current));
        const { viewState, previewReady, archived, ready, activeTurnId, hasActiveTurn, pending, starting, canSend } = readiness;
        const commandBusy = activeTurnCommands.has(sessionId);
        composerView.update({
            draft: composerState.draft,
            inputDisabled: !ready || starting || commandBusy,
            sendDisabled: !ready || starting || commandBusy || !canSend,
            attachDisabled: !ready || hasActiveTurn || composerState.attachments.length >= 8,
            attachments: composerState.attachments,
            removeAttachment: (index) => {
                const next = composerState.attachments.slice();
                next.splice(index, 1);
                state.composerStateBySession.setAttachments(sessionId, next);
                render();
            },
            sendTitle: hasActiveTurn
                ? (composerState.activeInputMode === 'steer' ? '立即调整当前任务' : '排队到当前任务完成后') : '发送消息',
            sendLabel: hasActiveTurn
                ? (composerState.activeInputMode === 'steer' ? '立即调整当前任务' : '排队后续指令') : '发送消息',
            placeholder: archived ? '该会话已归档；恢复后才能继续发送。'
                : starting ? (pending?.phase === 'thinking' ? '正在思考…' : '正在启动 Agent…')
                    : ['reconnecting', 'error'].includes(viewState) ? '正在重新连接 Codex App Server…'
                        : previewReady ? '输入消息…（发送时启动此会话）'
                            : !current.selectedSessionId ? '请先创建 Agent 会话…'
                                : viewState === 'starting' ? 'Agent Runtime 正在准备…'
                                    : hasActiveTurn ? (composerState.activeInputMode === 'steer'
                                        ? '输入要立即调整的指令…' : '输入任务完成后继续执行的指令…')
                                        : '输入消息…（Shift + Enter 换行）',
            busy: hasActiveTurn,
            ready: canSend,
            inputMode: composerState.activeInputMode,
            permissionLabel: state.permissionMode === 'always-approve' ? '本地审批：YOLO（设置）' : '本地审批：逐次确认（设置）',
            permissionActive: state.permissionMode === 'always-approve',
            newDisabled: state.topicCreating,
        });
        syncRunStatus(current);
    }

    async function selectAttachments() {
        const result = await controller.selectAttachments();
        if (disposed) return;
        const imported = Array.isArray(result?.attachments) ? result.attachments : [];
        const sessionId = selectedSessionKey();
        const current = state.composerStateBySession.get(sessionId);
        const attachments = current.attachments.slice();
        const existing = new Set(attachments.map((item) => item.id));
        for (const attachment of imported) {
            if (!existing.has(attachment.id) && attachments.length < 8) {
                attachments.push(attachment);
                existing.add(attachment.id);
            }
        }
        state.composerStateBySession.setAttachments(sessionId, attachments);
        if (result?.errors?.length) notify(result.errors.join('；'), imported.length ? 'warning' : 'error');
        render();
    }

    async function sendActiveTurn(prompt, composerState, sessionId) {
        if (!prompt) return false;
        const turnId = selectedActiveTurnId(store.getState());
        if (!turnId) throw new Error('当前 Turn 已结束，请重新发送。');
        const existing = activeTurnCommands.get(sessionId);
        if (existing) {
            if (existing.turnId === turnId && existing.prompt === prompt
                && existing.mode === composerState.activeInputMode) return existing.promise;
            throw new Error('当前 Session 正在提交另一条插队指令，请稍候。');
        }
        const submissionId = createSubmissionId();
        const steering = prompt.match(/^\/steer\s+([\s\S]+)$/i);
        const mode = steering || composerState.activeInputMode === 'steer' ? 'steer' : 'follow-up';
        const command = (async () => {
            if (mode === 'steer') {
                await controller.steerTurn(steering ? steering[1].trim() : prompt, submissionId);
            } else {
                await controller.followUpTurn(prompt, submissionId);
            }
            return true;
        })();
        activeTurnCommands.set(sessionId, { turnId, prompt, mode, promise: command });
        try {
            await command;
        } finally {
            if (activeTurnCommands.get(sessionId)?.promise === command) activeTurnCommands.delete(sessionId);
            if (!disposed) render();
        }
        if (disposed) return true;
        notify(mode === 'steer' ? '已插入即时 steering 指令。' : '已加入后续指令队列。', 'success');
        state.composerStateBySession.setDraft(sessionId, '');
        render();
        await refreshControlPlane();
        return true;
    }

    async function send() {
        const current = store.getState();
        const sessionId = selectedSessionKey(current);
        const composerState = state.composerStateBySession.get(sessionId);
        const prompt = composerState.draft.trim();
        const activeTurnId = selectedActiveTurnId(current);
        if (activeTurnId) {
            await sendActiveTurn(prompt, composerState, sessionId);
            return;
        }
        if (!prompt && !composerState.attachments.length) return;
        const pending = {
            sessionId, prompt, attachments: composerState.attachments.map((item) => ({ ...item })),
            phase: 'starting', turnId: null, startedAt: Date.now(), createdAt: Date.now(),
        };
        state.turnStarts.set(sessionId, pending);
        state.uxTimings.set(`turn-start:${sessionId || 'new'}`, window.performance?.now?.() || Date.now());
        renderFeed();
        queueRender({ feed: true, header: true, composer: true });
        try {
            const accepted = await controller.startTurn(prompt, pending.attachments);
            if (disposed) return;
            const currentStart = state.turnStarts.get(sessionId);
            if (currentStart === pending) state.turnStarts.set(sessionId, {
                ...currentStart, phase: accepted?.turnId ? 'thinking' : 'starting', turnId: accepted?.turnId || null,
            });
            if (accepted?.turnId && !state.turnStartedAt.has(accepted.turnId)) {
                state.turnStartedAt.set(accepted.turnId, pending.startedAt);
            }
            uxMark('turn-start-ack', accepted?.turnId, state.uxTimings.get(`turn-start:${sessionId || 'new'}`) || null);
            state.composerStateBySession.clearAfterAcceptedSend(sessionId);
            settleTurnStartIndicator();
            queueRender({ feed: true, header: true, composer: true });
        } catch (error) {
            if (!disposed && (state.turnStarts.get(sessionId) === pending
                || state.turnStarts.get(sessionId)?.turnId === pending.turnId)) state.turnStarts.delete(sessionId);
            if (!disposed) queueRender({ feed: true, header: true, composer: true });
            throw error;
        }
    }

    listen(input, 'input', () => {
        state.composerStateBySession.setDraft(selectedSessionKey(), input.value);
        render();
    });
    listen(feed, 'scroll', () => {
        const following = isFollowingContainer(feed);
        if (following === state.followingFeed && !(following && state.unreadTimelineCount)) return;
        state.followingFeed = following;
        if (following) state.unreadTimelineCount = 0;
        renderJumpToLatest();
    }, { passive: true });
    listen(jumpToLatest, 'click', () => {
        state.followingFeed = true;
        state.unreadTimelineCount = 0;
        renderJumpToLatest();
        scrollFeed(feed, true);
    });
    listen(input, 'keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendButton.click(); }
    });
    listen(attachButton, 'click', () => run(selectAttachments));
    listen(sendButton, 'click', () => run(send));
    listen(newButton, 'click', openNewSession);

    return Object.freeze({ render, syncRunStatus, dispose() {
        disposed = true;
        for (const dispose of disposers.splice(0).reverse()) dispose();
    } });
}

export { createAgentComposerCoordinator };
