import { createAgentMessagePresentation } from './agent-presentation/index.js';
import { createAgentWorkbenchTimelineView } from './agent-workbench-timeline-view.js';
import { selectedSessionId } from './agent-selected-session.js';

export function createAgentTimelineCoordinator({
    state, store, controller, lifecycle, window, document, root, refs, rendererHost,
    blockPresentation, approvalRegistry, cssEscape, selectedAgentProfile, activeSession,
    selectedSessionKey, selectedTurnStart, run, notify, scrollFeed, isFollowingContainer,
}) {
    let approvalTicker = null;

    function sessionContext() {
        const current = store.getState();
        const profile = selectedAgentProfile() || {};
        const selected = current.selectedTopic || {};
        const runtime = activeSession();
        const snapshot = runtime?.configSnapshot || selected.configSnapshot || {};
        return {
            sessionId: selectedSessionId(current),
            threadId: runtime?.threadId || selected.threadId || null,
            participant: {
                id: selected.agentId || profile.id || state.selectedAgent,
                name: snapshot.agentName || selected.agentName || profile.name
                    || selected.agentId || state.selectedAgent || 'Nova',
                avatarUrl: snapshot.agentAvatar || selected.avatarUrl || profile.avatarUrl || '',
                colors: profile.colors || profile.config?.colors || {},
                config: profile.config || profile,
            },
            messages: current.messages || [],
            settings: window.globalSettings || {},
        };
    }

    function promptForPart(part) {
        const messages = store.getState().messages || [];
        const index = messages.findIndex((message) => (message.id || message.messageId) === part.id);
        const candidates = index >= 0 ? messages.slice(0, index + 1).reverse() : messages.slice().reverse();
        const user = candidates.find((message) => message.role === 'user' && typeof message.content === 'string');
        return user?.content || (typeof part.value?.content === 'string' ? part.value.content : '');
    }

    async function forkAndSend(part, prompt, title) {
        await controller.forkSession({ sessionId: sessionContext().sessionId, turnId: part.turnId, title });
        if (prompt?.trim()) await controller.startTurn(prompt.trim(), []);
    }

    const presentation = createAgentMessagePresentation({
        window,
        document,
        container: refs.feedItems,
        getSessionContext: sessionContext,
        nonMessageCallbacks: blockPresentation.timelineCallbacks,
        electronAPI: rendererHost,
        scrollToBottom: () => scrollFeed(refs.feed, true),
        notify,
        actions: {
            copy: async ({ text }) => {
                await navigator.clipboard.writeText(text);
                notify('已复制渲染后的文本。', 'success');
            },
            interrupt: ({ part }) => run(async () => {
                await controller.cancelTurn();
                notify(`已请求中止 ${part.turnId || '当前 Turn'}。`, 'success');
            }),
            fork: ({ part }) => run(async () => {
                await controller.forkSession({
                    sessionId: sessionContext().sessionId, turnId: part.turnId, title: 'Agent 分支',
                });
                notify('已创建 Codex 会话分支。', 'success');
            }),
            retry: ({ part }) => run(async () => {
                await forkAndSend(part, promptForPart(part), '从消息重试');
                notify('已在新 Codex 分支重试。', 'success');
            }),
            edit: ({ part }) => {
                const edited = window.prompt?.('编辑并在新 Codex 分支发送', promptForPart(part));
                if (edited === null || edited === undefined || !edited.trim()) return;
                run(async () => {
                    await forkAndSend(part, edited, '编辑消息分支');
                    notify('已在新 Codex 分支发送编辑内容。', 'success');
                });
            },
            forward: ({ part }) => run(async () => {
                const value = typeof part.value?.content === 'string' ? part.value.content : promptForPart(part);
                await navigator.clipboard.writeText(value || '');
                notify('Agent 消息已复制；可粘贴到目标 VChat 会话。', 'success');
            }),
        },
    });
    presentation.bindInteractions();
    const view = createAgentWorkbenchTimelineView({
        refs,
        rows: state.timelineRows,
        callbacks: presentation.timelineCallbacks,
        actions: { isFollowing: isFollowingContainer, scroll: scrollFeed },
    });

    function ensureApprovalTicker() {
        if (approvalTicker) return;
        approvalTicker = lifecycle.interval('approval-ticker', () => {
            const now = Date.now();
            for (const [id, entry] of approvalRegistry) {
                const cards = root.querySelectorAll(`[data-approval-id="${cssEscape(id)}"]`);
                if (!cards.length) continue;
                const remaining = entry.deadline - now;
                const expired = remaining <= 0;
                cards.forEach((card) => {
                    const label = card.querySelector('.agent-chat-approval-countdown');
                    if (expired) {
                        if (!entry.expired) {
                            entry.expired = true;
                            card.classList.add('agent-chat-approval-expired');
                            if (label) label.textContent = '等待 Codex App Server 确认超时拒绝';
                            const live = card.querySelector('.agent-chat-approval-live');
                            if (live) live.textContent = '审批截止时间已到，等待 Codex App Server 最终事件。';
                        }
                    } else if (label) {
                        label.textContent = `默认拒绝 · Codex App Server ${Math.ceil(remaining / 1000)}s 后处理`;
                    }
                });
                if (expired) approvalRegistry.delete(id);
            }
            if (approvalRegistry.size === 0) {
                lifecycle.clear('approval-ticker');
                approvalTicker = null;
            }
        }, 500);
    }

    return {
        ensureApprovalTicker,
        render() {
            const current = store.getState();
            view.update({
                projection: current,
                pendingTurnStart: selectedTurnStart(current),
                selectedSessionId: selectedSessionKey(current),
            });
        },
        renderJumpToLatest() {
            view.updateJump({ following: state.followingFeed, unreadCount: state.unreadTimelineCount });
        },
        dispose() {
            lifecycle.clear('approval-ticker');
            approvalTicker = null;
            view.dispose();
            presentation.dispose?.();
        },
    };
}
