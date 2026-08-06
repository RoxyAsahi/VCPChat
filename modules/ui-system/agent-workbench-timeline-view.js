import { createAgentTimelineParts, reconcileAgentTimeline } from './agent-workbench-timeline.js';
import { node } from './agent-workbench-dom.js';
import { selectedSessionIdentity } from './agent-selected-session.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function svgNode(document, tag, attributes = {}, text = '') {
    const element = document.createElementNS(SVG_NAMESPACE, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    if (text) element.textContent = text;
    return element;
}

function createBuildEmptyState(document) {
    const element = node('section', 'agent-chat-empty-conversation agent-chat-build-empty-state', undefined, document);
    const content = node('div', 'next-ui-empty-state-content agent-chat-build-empty-content', undefined, document);
    const brand = node('div', 'next-ui-empty-brand', undefined, document);
    brand.setAttribute('role', 'img');
    brand.setAttribute('aria-label', 'VCPBUILD');
    const svg = svgNode(document, 'svg', {
        class: 'next-ui-empty-brand-svg', viewBox: '0 0 900 190', 'aria-hidden': 'true',
    });
    const defs = svgNode(document, 'defs');
    const gradient = svgNode(document, 'linearGradient', {
        id: 'agentBuildEmptyStaticStroke', x1: '0%', y1: '0%', x2: '100%', y2: '0%',
    });
    gradient.append(
        svgNode(document, 'stop', { offset: '0%', 'stop-color': 'var(--next-empty-flow-primary)' }),
        svgNode(document, 'stop', { offset: '50%', 'stop-color': 'var(--next-empty-flow-primary)' }),
        svgNode(document, 'stop', { offset: '50%', 'stop-color': 'var(--next-empty-flow-secondary)' }),
        svgNode(document, 'stop', { offset: '100%', 'stop-color': 'var(--next-empty-flow-secondary)' }),
    );
    const filter = svgNode(document, 'filter', {
        id: 'agentBuildEmptyLogoGlow', x: '-20%', y: '-40%', width: '140%', height: '180%',
    });
    filter.append(
        svgNode(document, 'feGaussianBlur', { stdDeviation: '4', result: 'blur' }),
        svgNode(document, 'feComposite', { in: 'SourceGraphic', in2: 'blur', operator: 'over' }),
    );
    defs.append(gradient, filter);
    const textAttributes = {
        x: '50%', y: '52%', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
    };
    svg.append(
        defs,
        svgNode(document, 'text', {
            ...textAttributes, class: 'next-ui-empty-brand-text next-ui-empty-brand-base',
        }, 'VCPBUILD'),
        svgNode(document, 'text', {
            ...textAttributes,
            class: 'next-ui-empty-brand-text next-ui-empty-brand-flow next-ui-empty-brand-cyan',
            filter: 'url(#agentBuildEmptyLogoGlow)',
        }, 'VCPBUILD'),
        svgNode(document, 'text', {
            ...textAttributes,
            class: 'next-ui-empty-brand-text next-ui-empty-brand-flow next-ui-empty-brand-pink',
            filter: 'url(#agentBuildEmptyLogoGlow)',
        }, 'VCPBUILD'),
    );
    const tagline = node('p', 'next-ui-empty-tagline agent-chat-build-empty-tagline', '', document);
    brand.append(svg);
    content.append(brand, tagline);
    element.append(content);
    return { element, tagline };
}

export function createAgentWorkbenchTimelineView({ refs, rows, callbacks, actions }) {
    const { feed, feedItems, jumpToLatest } = refs;
    let empty = null;
    let emptyTagline = null;

    function showEmpty(text) {
        reconcileAgentTimeline(feedItems, [], {}, rows);
        if (!empty) {
            const visual = createBuildEmptyState(feedItems.ownerDocument);
            empty = visual.element;
            emptyTagline = visual.tagline;
            feedItems.append(empty);
        }
        emptyTagline.textContent = text;
    }

    function clearEmpty() {
        empty?.remove();
        empty = null;
        emptyTagline = null;
    }

    function render(model) {
        const follow = actions.isFollowing(feed);
        const current = model.projection;
        if (!selectedSessionIdentity(current)) {
            showEmpty('创建一个 Agent 会话，即可开始与 VCPToolBox 协作。');
            return;
        }
        const timeline = createAgentTimelineParts(current);
        const pending = model.pendingTurnStart;
        if (pending) {
            const alreadyHasAssistant = pending.turnId && current.messages.some((message) => {
                const content = typeof message.content === 'string' ? message.content.trim() : '';
                const reasoning = typeof message.reasoning === 'string' ? message.reasoning.trim() : '';
                return message.role === 'assistant' && message.turnId === pending.turnId
                    && Boolean(content || reasoning || message.attachments?.length);
            });
            if (model.selectedSessionId && pending.sessionId === model.selectedSessionId && !alreadyHasAssistant) {
                const id = `turn-start:${model.selectedSessionId}`;
                const terminal = ['failed', 'interrupted', 'empty'].includes(pending.phase);
                const labels = {
                    starting: '正在启动 Agent…',
                    thinking: '回复中…',
                    failed: pending.detail || '任务执行失败。',
                    interrupted: pending.detail || '任务已停止。',
                    empty: pending.detail || '任务已结束，但没有返回可显示内容。',
                };
                timeline.push({
                    kind: 'message',
                    id,
                    presentationKey: id,
                    turnId: pending.turnId || null,
                    value: {
                        id,
                        role: 'assistant',
                        state: terminal ? 'complete' : 'streaming',
                        content: labels[pending.phase] || labels.thinking,
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
