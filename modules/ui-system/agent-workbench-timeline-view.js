import { createAgentTimelineParts, reconcileAgentTimeline } from './agent-workbench-timeline.js';
import { node } from './agent-workbench-dom.js';

export function createAgentWorkbenchTimelineView({ refs, rows, callbacks, actions }) {
    const { feed, feedItems, jumpToLatest } = refs;
    let empty = null;

    function showEmpty(text) {
        reconcileAgentTimeline(feedItems, [], {}, rows);
        if (!empty) {
            empty = node('div', 'agent-chat-empty-conversation');
            feedItems.append(empty);
        }
        empty.textContent = text;
    }

    function clearEmpty() {
        empty?.remove();
        empty = null;
    }

    function render(model) {
        const follow = actions.isFollowing(feed);
        const current = model.projection;
        if (!current.selectedSessionId && !current.selectedTopic?.sessionId) {
            showEmpty('创建一个 Agent 会话，即可开始与 VCPToolBox 协作。');
            return;
        }
        const timeline = createAgentTimelineParts(current);
        const pending = model.pendingTurnStart;
        if (pending) {
            const alreadyHasAssistant = pending.turnId && current.messages.some((message) => (
                message.role === 'assistant' && message.turnId === pending.turnId
            ));
            if (model.selectedSessionId && pending.sessionId === model.selectedSessionId && !alreadyHasAssistant) {
                const id = `turn-start:${model.selectedSessionId}`;
                timeline.push({
                    kind: 'message',
                    id,
                    presentationKey: id,
                    turnId: pending.turnId || null,
                    value: {
                        id,
                        role: 'assistant',
                        state: 'streaming',
                        content: pending.phase === 'starting' ? '正在启动 Agent…' : '思考中',
                        presentationRole: 'turn-start',
                        presentationKey: id,
                        presentationPhase: pending.phase,
                        createdAt: pending.createdAt || Date.now(),
                    },
                });
            }
        }
        if (!timeline.length && !pending) {
            showEmpty('会话已就绪，发送第一条消息开始。');
            return;
        }
        clearEmpty();
        reconcileAgentTimeline(feedItems, timeline, callbacks, rows);
        actions.scroll(feed, follow);
    }

    function updateJump({ following, unreadCount }) {
        const count = Math.min(99, unreadCount || 0);
        const visible = !following && count > 0;
        jumpToLatest.hidden = !visible;
        if (!visible) return;
        const suffix = count > 1 ? `（${count} 条新动态）` : '（有新动态）';
        jumpToLatest.textContent = `回到最新${suffix}`;
        jumpToLatest.setAttribute('aria-label', `回到最新消息${suffix}`);
    }

    return {
        element: feed,
        update: render,
        updateJump,
        dispose() {
            clearEmpty();
            reconcileAgentTimeline(feedItems, [], {}, rows);
        },
    };
}
