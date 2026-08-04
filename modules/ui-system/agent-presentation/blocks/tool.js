import { projectTool } from '../../agent-workbench-projections.js';
import { projectVcpToolPresentation } from '../../agent-workbench-timeline.js';
import { createIcon, createNode, safeText } from './dom.js';
import { structuredWorkspacePaths } from '../../agent-workspace-model.js';

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function toolStatusLabel(state) {
    return ({ requested: '等待中', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[state] || state;
}

function detailsSummary(tool) {
    const raw = tool?.payload || {};
    const item = raw.item && typeof raw.item === 'object' ? raw.item : {};
    return safeText(raw.argumentSummary || raw.argsPreview || raw.outputSummary || raw.note
        || raw.reason || raw.error || item.outputSummary || item.error || item.message || tool?.summary);
}

function normalizeArguments(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return { value };
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
    } catch {
        return { value };
    }
}

function toolDetailPayload(tool) {
    const payload = tool?.payload || {};
    const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
    const values = toolDetailValues(payload, item);
    const { args, result, error, resources, warnings, task } = values;
    return {
        args,
        result,
        error,
        resources,
        warnings,
        task,
        hasArgs: Boolean(args && typeof args === 'object' && Object.keys(args).length),
        hasResult: result != null && String(result).trim() !== '',
        hasError: error != null && String(error).trim() !== '',
        summary: detailsSummary(tool),
    };
}

function toolDetailValues(payload, item) {
    const args = normalizeArguments(payload.arguments ?? payload.args ?? payload.parameters
        ?? item.arguments ?? item.args ?? item.parameters ?? item.input);
    const result = payload.result ?? payload.output ?? payload.response
        ?? item.result ?? item.output ?? item.response;
    const error = payload.error ?? item.error ?? item.failure?.message
        ?? (item.status === 'failed' ? item.message : null);
    const resources = Array.isArray(payload.resources) ? payload.resources
        : Array.isArray(item.resources) ? item.resources : [];
    const warnings = Array.isArray(payload.warnings) ? payload.warnings
        : Array.isArray(item.warnings) ? item.warnings : [];
    const taskValue = payload.task ?? item.task;
    return {
        args, result, error, resources, warnings,
        task: taskValue && typeof taskValue === 'object' ? taskValue : null,
    };
}

function canExpandTool(tool) {
    const detail = toolDetailPayload(tool);
    return Boolean(detail.hasArgs || detail.hasResult || detail.hasError || detail.resources.length || detail.warnings.length
        || detail.task || detail.summary);
}

function syncWorkspacePathActions({ card, header, tool, document, onWorkspacePath }) {
    card.querySelector('.agent-chat-tool-path-actions')?.remove();
    const paths = structuredWorkspacePaths(tool?.payload || tool);
    if (!paths.length || typeof onWorkspacePath !== 'function') return;
    const pathActions = createNode(document, 'span', 'agent-chat-tool-path-actions');
    for (const relativePath of paths.slice(0, 3)) {
        const open = createNode(document, 'button', 'agent-chat-tool-path-action');
        open.type = 'button';
        open.title = `在工作区预览 ${relativePath}`;
        open.setAttribute('aria-label', `在工作区预览 ${relativePath}`);
        open.dataset.agentWorkspacePath = relativePath;
        open.append(...createIcon(document, 'draft'));
        open.addEventListener('click', (event) => {
            event.stopPropagation(); onWorkspacePath(relativePath, 'preview', tool);
        });
        pathActions.append(open);
    }
    header.append(pathActions);
}

function buildToolArgsTable(document, args) {
    const wrap = createNode(document, 'div', 'agent-chat-tool-args vcp-tool-use-bubble');
    wrap.dataset.vcpBlockType = 'tool-use';
    wrap.append(createNode(document, 'div', 'agent-chat-tool-detail-label', '参数'));
    const table = createNode(document, 'table', 'agent-chat-tool-args-table');
    for (const [key, raw] of Object.entries(args)) {
        const row = createNode(document, 'tr');
        row.append(createNode(document, 'th', 'agent-chat-tool-args-key', key));
        const value = createNode(document, 'td', 'agent-chat-tool-args-value');
        const text = typeof raw === 'string' ? raw : safeText(raw);
        value.textContent = text;
        if (text.length > 120) value.classList.add('agent-chat-tool-args-long');
        row.append(value);
        table.append(row);
    }
    wrap.append(table);
    return wrap;
}

function createToolDetail(document, tool, renderContent, postRender) {
    const detail = toolDetailPayload(tool);
    if (!(detail.hasArgs || detail.hasResult || detail.hasError || detail.resources.length || detail.warnings.length || detail.task)) {
        return detail.summary ? createNode(document, 'pre', 'agent-chat-tool-output', detail.summary) : null;
    }
    const container = createNode(document, 'div', 'agent-chat-tool-detail vcp-tool-result-bubble collapsible expanded');
    container.dataset.vcpBlockType = 'tool-result';
    if (detail.hasArgs) container.append(buildToolArgsTable(document, detail.args));
    if (detail.hasResult) {
        container.append(createNode(document, 'div', 'agent-chat-tool-detail-label', '结果'));
        const output = createNode(document, 'div', 'agent-chat-tool-detail-result');
        const resultText = typeof detail.result === 'string' ? detail.result : safeText(detail.result);
        output.innerHTML = renderContent(resultText);
        postRender?.(output);
        if (resultText.length > 480) {
            output.classList.add('agent-chat-tool-detail-result--truncated');
            const toggle = createNode(document, 'button', 'agent-chat-tool-result-toggle', '展开结果');
            toggle.type = 'button';
            toggle.setAttribute('aria-label', '展开/收起工具结果');
            toggle.addEventListener('click', () => {
                const expanded = output.classList.toggle('agent-chat-tool-detail-result--expanded');
                toggle.textContent = expanded ? '收起结果' : '展开结果';
            });
            container.append(output, toggle);
        } else {
            container.append(output);
        }
    }
    if (detail.hasError) {
        container.append(createNode(document, 'div', 'agent-chat-tool-detail-label', '错误'));
        container.append(createNode(document, 'pre', 'agent-chat-tool-detail-error', safeText(detail.error)));
    }
    for (const [label, className, value] of [
        ['资源', 'agent-chat-tool-resource-list', detail.resources],
        ['警告', 'agent-chat-tool-warning-list', detail.warnings],
        ['异步任务', 'agent-chat-tool-task', detail.task],
    ]) {
        if (!value || (Array.isArray(value) && value.length === 0)) continue;
        container.append(createNode(document, 'div', 'agent-chat-tool-detail-label', label));
        container.append(createNode(document, 'pre', className, safeText(value)));
    }
    return container;
}

function createToolBlockRenderer(options = {}) {
    const document = options.document || globalThis.document;
    const renderContent = options.renderContent || ((text) => safeText(text));
    const postRender = options.postRender || (() => {});
    const onCancel = options.onCancel;
    const onWorkspacePath = options.onWorkspacePath;

    function mountDetail(card) {
        card.querySelector(':scope > .agent-chat-tool-detail, :scope > .agent-chat-tool-output')?.remove();
        const detail = createToolDetail(document, card.__agentToolValue, renderContent, postRender);
        card.dataset.toolDetailMounted = 'true';
        if (detail) card.append(detail);
    }

    function toggleDetail(card) {
        const expanded = !card.classList.contains('expanded');
        card.classList.toggle('expanded', expanded);
        if (expanded) mountDetail(card);
    }

    function syncToolControls(card, tool, value, header, terminal) {
        let cancel = card.querySelector('.agent-chat-tool-cancel');
        if (!terminal && typeof onCancel === 'function' && !cancel) {
            cancel = createNode(document, 'button', 'agent-chat-tool-cancel');
            cancel.type = 'button';
            cancel.title = '取消该工具调用';
            cancel.setAttribute('aria-label', '取消该工具调用');
            cancel.append(...createIcon(document, 'cancel'));
            cancel.addEventListener('click', () => onCancel(card.__agentToolValue));
            header.append(cancel);
        } else if (terminal) cancel?.remove();
        let chevron = card.querySelector('.agent-chat-tool-chevron');
        const expandable = terminal && canExpandTool(tool);
        if (expandable && !chevron) {
            chevron = createNode(document, 'button', 'agent-chat-tool-chevron');
            chevron.type = 'button';
            chevron.setAttribute('aria-label', '展开/折叠工具详情');
            chevron.append(...createIcon(document, 'expand_more'));
            chevron.addEventListener('click', () => toggleDetail(card));
            header.append(chevron);
        } else if (!expandable) {
            chevron?.remove();
            card.classList.remove('expanded');
            card.querySelector(':scope > .agent-chat-tool-detail, :scope > .agent-chat-tool-output')?.remove();
            delete card.dataset.toolDetailMounted;
        } else if (card.classList.contains('expanded')) mountDetail(card);
        return value;
    }

    function syncHeader(card, tool) {
        const value = projectTool(tool);
        const presentation = projectVcpToolPresentation(tool);
        const status = value.state || 'requested';
        const terminal = TERMINAL_STATES.has(status);
        card.__agentToolValue = tool;
        card.dataset.toolCallId = value.toolCallId || '';
        card.dataset.status = status;

        const title = card.querySelector('.agent-chat-tool-title');
        title.dataset.toolPresentation = presentation.kind;
        title.querySelector('.vcp-ui-icon').textContent = presentation.icon;
        title.querySelector('.agent-chat-tool-name-text').textContent = presentation.label;
        const summary = value.summary || detailsSummary(tool);
        let separator = title.querySelector('.agent-chat-tool-sep');
        let subtitle = title.querySelector('.agent-chat-tool-sub');
        if (summary) {
            if (!subtitle) {
                separator = createNode(document, 'span', 'agent-chat-tool-sep', '·');
                subtitle = createNode(document, 'span', 'agent-chat-tool-sub');
                title.append(separator, subtitle);
            }
            subtitle.textContent = summary;
        } else {
            separator?.remove();
            subtitle?.remove();
        }

        const badge = card.querySelector('.agent-chat-tool-status-badge');
        badge.textContent = toolStatusLabel(status);
        badge.dataset.status = status;
        badge.className = `agent-chat-tool-status-badge vcp-tool-call-summary-status status-${status}`;

        const first = Number(tool.firstTimestamp || tool.createdAt || 0);
        const last = Number(tool.lastTimestamp || tool.updatedAt || Date.now());
        const duration = card.querySelector('.agent-chat-tool-duration');
        duration.textContent = first && last >= first ? `${Math.max(0, (last - first) / 1000).toFixed(1)}s` : '';

        const header = card.querySelector('.agent-chat-tool-header');
        syncWorkspacePathActions({ card, header, tool, document, onWorkspacePath });
        let risk = card.querySelector('.agent-chat-tool-risk');
        const riskValue = value.riskLevel && value.riskLevel !== 'unknown' ? value.riskLevel : '';
        if (riskValue && !risk) {
            risk = createNode(document, 'span', 'agent-chat-tool-risk');
            header.append(risk);
        }
        if (riskValue) risk.textContent = riskValue;
        else risk?.remove();

        syncToolControls(card, tool, value, header, terminal);
    }

    return {
        create(tool) {
            const card = createNode(document, 'section', 'message-item assistant agent-chat-tool-activity-row agent-chat-tool-activity vcp-tool-call-summary-bubble');
            card.dataset.vcpBlockType = 'tool-call-summary';
            const header = createNode(document, 'div', 'agent-chat-tool-header vcp-tool-call-summary-header');
            const title = createNode(document, 'span', 'agent-chat-tool-title vcp-tool-call-summary-title');
            title.append(...createIcon(document, 'extension'), createNode(document, 'span', 'agent-chat-tool-name-text'));
            header.append(
                title,
                createNode(document, 'span', 'agent-chat-tool-duration'),
                createNode(document, 'span', 'agent-chat-tool-status-badge vcp-tool-call-summary-status'),
            );
            card.append(header);
            syncHeader(card, tool);
            if (tool.expanded && TERMINAL_STATES.has(projectTool(tool).state) && canExpandTool(tool)) {
                card.classList.add('expanded');
                mountDetail(card);
            }
            return card;
        },
        patch(card, tool) {
            syncHeader(card, tool);
            return card;
        },
    };
}

export { createToolBlockRenderer, toolDetailPayload, toolStatusLabel };
