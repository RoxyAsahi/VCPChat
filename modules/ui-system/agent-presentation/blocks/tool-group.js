import { projectTool } from '../../agent-workbench-projections.js';
import { projectVcpToolPresentation } from '../../agent-workbench-timeline.js';
import { createIcon, createNode } from './dom.js';
import { createToolBlockRenderer, toolStatusLabel } from './tool.js';

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function toolState(tool) {
    return projectTool(tool).state || 'requested';
}

function currentTool(tools) {
    return [...tools].reverse().find((tool) => toolState(tool) === 'requested')
        || [...tools].reverse().find((tool) => !TERMINAL_STATES.has(toolState(tool)))
        || null;
}

function aggregateState(tools) {
    const current = currentTool(tools);
    if (current) return toolState(current);
    if (tools.some((tool) => toolState(tool) === 'failed')) return 'failed';
    if (tools.every((tool) => toolState(tool) === 'cancelled')) return 'cancelled';
    return 'completed';
}

function aggregateDuration(tools) {
    const starts = tools.map((tool) => Number(tool.firstTimestamp || tool.createdAt || 0)).filter(Boolean);
    const ends = tools.map((tool) => Number(tool.lastTimestamp || tool.updatedAt || 0)).filter(Boolean);
    if (starts.length === 0 || ends.length === 0) return '';
    const first = Math.min(...starts);
    const last = Math.max(...ends);
    return last >= first ? `${Math.max(0, (last - first) / 1000).toFixed(1)}s` : '';
}

function terminalSummary(tools) {
    const failed = tools.filter((tool) => toolState(tool) === 'failed').length;
    const cancelled = tools.filter((tool) => toolState(tool) === 'cancelled').length;
    if (failed > 0) return `${tools.length} 个工具调用 · ${failed} 个失败`;
    if (cancelled > 0) return `${tools.length} 个工具调用 · ${cancelled} 个已取消`;
    return `${tools.length} 个工具调用`;
}

function createToolGroupRenderer(options = {}) {
    const document = options.document || globalThis.document;
    const onCancel = options.onCancel;
    const toolRenderer = createToolBlockRenderer(options);

    function toggle(group, expanded) {
        group.classList.toggle('expanded', expanded);
        const toggleButton = group.querySelector('.agent-chat-tool-group-toggle');
        toggleButton?.setAttribute('aria-expanded', String(expanded));
        const body = group.querySelector('.agent-chat-tool-group-body');
        if (body) body.hidden = !expanded;
        if (expanded) {
            const active = body?.querySelector('[data-status="requested"], [data-status="running"]');
            active?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        }
    }

    function reconcileChildren(group, tools) {
        const body = group.querySelector('.agent-chat-tool-group-body');
        const existing = new Map([...body.children].map((row) => [row.dataset.toolCallId, row]));
        const desired = new Set();
        for (const tool of tools) {
            const toolCallId = projectTool(tool).toolCallId;
            if (!toolCallId) continue;
            desired.add(toolCallId);
            let row = existing.get(toolCallId);
            if (!row) {
                row = toolRenderer.create(tool);
                row.classList.add('agent-chat-tool-group-item');
            } else {
                toolRenderer.patch(row, tool);
            }
            body.append(row);
        }
        for (const [toolCallId, row] of existing) {
            if (!desired.has(toolCallId)) row.remove();
        }
    }

    function sync(group, value = {}) {
        const tools = Array.isArray(value.tools) ? value.tools : [];
        group.__agentToolGroupValue = value;
        group.dataset.toolGroupId = tools[0] ? projectTool(tools[0]).toolCallId || '' : '';
        group.dataset.turnId = value.turnId || '';
        const state = aggregateState(tools);
        group.dataset.status = state;

        const active = currentTool(tools);
        const label = group.querySelector('.agent-chat-tool-group-label');
        const subtitle = group.querySelector('.agent-chat-tool-group-subtitle');
        if (active) {
            const presentation = projectVcpToolPresentation(active);
            label.textContent = presentation.label;
            subtitle.textContent = toolStatusLabel(toolState(active));
        } else {
            label.textContent = terminalSummary(tools);
            subtitle.textContent = '';
        }
        const badge = group.querySelector('.agent-chat-tool-status-badge');
        badge.textContent = toolStatusLabel(state);
        badge.dataset.status = state;
        badge.className = `agent-chat-tool-status-badge vcp-tool-call-summary-status status-${state}`;
        group.querySelector('.agent-chat-tool-duration').textContent = aggregateDuration(tools);

        let cancel = group.querySelector('.agent-chat-tool-group-cancel');
        if (active && typeof onCancel === 'function') {
            if (!cancel) {
                cancel = createNode(document, 'button', 'agent-chat-tool-group-cancel');
                cancel.type = 'button';
                cancel.title = '取消当前工具调用';
                cancel.setAttribute('aria-label', '取消当前工具调用');
                cancel.append(...createIcon(document, 'cancel'));
                cancel.addEventListener('click', () => onCancel(currentTool(group.__agentToolGroupValue?.tools || [])));
                group.querySelector('.agent-chat-tool-group-header').append(cancel);
            }
        } else {
            cancel?.remove();
        }
        reconcileChildren(group, tools);
    }

    return {
        create(value) {
            const group = createNode(document, 'section', 'message-item assistant agent-chat-tool-group');
            const header = createNode(document, 'div', 'agent-chat-tool-group-header');
            const toggleButton = createNode(document, 'button', 'agent-chat-tool-group-toggle');
            toggleButton.type = 'button';
            toggleButton.setAttribute('aria-expanded', 'false');
            const title = createNode(document, 'span', 'agent-chat-tool-group-title');
            title.append(
                ...createIcon(document, 'extension'),
                createNode(document, 'span', 'agent-chat-tool-group-label'),
                createNode(document, 'span', 'agent-chat-tool-group-subtitle'),
            );
            const chevron = createNode(document, 'span', 'vcp-result-toggle-icon agent-chat-tool-group-chevron');
            chevron.setAttribute('aria-hidden', 'true');
            toggleButton.append(title, createNode(document, 'span', 'agent-chat-tool-duration'),
                createNode(document, 'span', 'agent-chat-tool-status-badge vcp-tool-call-summary-status'),
                chevron);
            const body = createNode(document, 'div', 'agent-chat-tool-group-body');
            body.hidden = true;
            toggleButton.addEventListener('click', () => toggle(group, !group.classList.contains('expanded')));
            header.append(toggleButton);
            group.append(header, body);
            sync(group, value);
            return group;
        },
        patch(group, value) {
            sync(group, value);
            return group;
        },
    };
}

export { createToolGroupRenderer };
