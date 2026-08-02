import { createIcon, createNode, safeText } from './dom.js';

const OBSERVATION_LABELS = Object.freeze({
    log: '运行日志',
    notification: '服务通知',
    rag: 'RAG 召回',
    memory: '记忆召回',
    'agent-preview': 'Agent 私聊预览',
    diary: '日记',
    dream: '梦境状态',
    'backend-approval-request': '后端审核请求（未关联）',
    'distributed-observation': '分布式节点观察',
});

function structuredObservationSummary(kind, value) {
    const payload = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value;
    const text = (...keys) => {
        for (const key of keys) {
            const candidate = payload[key];
            if (typeof candidate === 'string' && candidate.trim()) return safeText(candidate.trim()).slice(0, 360);
        }
        return '';
    };
    const labels = (candidate) => {
        const values = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
        const output = values.filter((item) => typeof item === 'string' && item.trim()).slice(0, 3)
            .map((item) => safeText(item.trim()).slice(0, 80));
        return output.join('、');
    };
    const count = (...keys) => {
        for (const key of keys) {
            const candidate = payload[key];
            if (Array.isArray(candidate)) return candidate.length;
            const number = Number(candidate);
            if (Number.isFinite(number) && number >= 0) return Math.floor(number);
        }
        return null;
    };
    const query = text('query', 'searchQuery', 'prompt');
    if (kind === 'rag') {
        const source = text('dbName', 'database') || labels(payload.diaryNames) || '知识库';
        const hits = count('results', 'matchedCount', 'k');
        return `RAG · ${source}${hits === null ? '' : ` · ${hits} 条命中`}${query ? `\n查询：${query}` : ''}`;
    }
    if (kind === 'memory') {
        const sources = labels(payload.dbNames) || text('dbName') || '记忆库';
        const files = count('fileCount', 'files', 'diaryCount');
        const result = text('extractedMemories', 'summary', 'error');
        return `记忆 · ${sources}${files === null ? '' : ` · ${files} 个来源`}${query ? `\n查询：${query}` : ''}${result ? `\n${result}` : ''}`;
    }
    if (kind === 'agent-preview') {
        const agent = text('agentName', 'agentId') || 'Agent';
        const response = text('response', 'preview', 'message');
        return `${agent} 的私聊预览${query ? `\n请求：${query}` : ''}${response ? `\n回复：${response}` : ''}`;
    }
    if (kind === 'diary') {
        const title = text('title', 'name', 'message', 'status') || '日记状态已更新';
        const notebook = text('dbName', 'diaryName', 'folder');
        return `${title}${notebook ? ` · ${notebook}` : ''}`;
    }
    if (kind === 'dream') {
        const state = text('status', 'phase', 'message', 'title') || '梦境任务状态已更新';
        const agent = text('agentName', 'agentId');
        return `${state}${agent ? ` · ${agent}` : ''}`;
    }
    return '';
}

function projectToolboxObservation(observation = {}) {
    const kind = String(observation.kind || 'notification');
    const channel = String(observation.channel || 'ToolBox');
    const value = observation.value;
    let summary = '';
    if (kind === 'backend-approval-request' && value && typeof value === 'object') {
        const data = value.data && typeof value.data === 'object' ? value.data : value;
        const requestId = safeText(data.requestId || '未知请求 ID').slice(0, 160);
        const toolName = safeText(data.toolName || '未知工具').slice(0, 160);
        const timeout = Number(data.approvalTtlMs);
        const ttl = Number.isFinite(timeout) && timeout > 0 ? `，最长等待 ${Math.ceil(timeout / 60_000)} 分钟` : '';
        summary = `请求 ${requestId}：${toolName} 正在等待 VCPToolBox 后端审核${ttl}。该 requestId 仅属于 ToolBox 审批，不会关联或替代 Agent toolCallId。`;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        summary = structuredObservationSummary(kind, value);
    }
    if (!summary && value && typeof value === 'object' && !Array.isArray(value)) {
        summary = safeText(value.message || value.title || value.type || value.status || value);
    } else if (!summary) {
        summary = safeText(value);
    }
    return {
        channel,
        kind,
        label: OBSERVATION_LABELS[kind] || 'ToolBox 观察',
        summary: summary.slice(0, 2_000) || 'ToolBox 已发送一条只读状态事件。',
        detail: safeText(value).slice(0, 16_384),
    };
}

function createExpandableObservationCard(document, options) {
    const card = createNode(document, 'section', options.className);
    const summary = createNode(document, 'button', 'agent-chat-toolbox-ws-summary');
    summary.type = 'button';
    const title = createNode(document, 'span', 'agent-chat-toolbox-ws-title');
    title.append(...createIcon(document, options.icon), createNode(document, 'span', '', options.title));
    summary.append(title, createNode(document, 'span', 'agent-chat-toolbox-ws-channel', options.channel));
    const detail = createNode(document, 'p', 'agent-chat-toolbox-ws-detail', options.summary);
    const output = createNode(document, 'pre', 'agent-chat-toolbox-ws-output', options.detail);
    output.hidden = true;
    summary.addEventListener('click', () => {
        output.hidden = !output.hidden;
        card.classList.toggle('expanded', !output.hidden);
    });
    card.append(summary, detail, output);
    return card;
}

function createToolboxObservationCard(document, observation) {
    const value = projectToolboxObservation(observation);
    const icon = value.kind === 'distributed-observation' ? 'hub'
        : value.kind === 'backend-approval-request' ? 'admin_panel_settings' : 'info';
    const card = createExpandableObservationCard(document, {
        className: `agent-chat-toolbox-ws-card agent-chat-toolbox-ws-${value.kind}`,
        icon,
        title: `VCPToolBox · ${value.label}`,
        channel: value.channel,
        summary: value.summary,
        detail: value.detail,
    });
    card.dataset.toolboxChannel = value.channel;
    card.dataset.toolboxKind = value.kind;
    // VCPLog observations are display-only and do not carry the authority
    // generation required to answer an approval. The global approval center
    // renders the authoritative `approval.requested` event instead.
    return card;
}

function createMarkerObservationCard(document, observation = {}) {
    const labels = { 'dynamic-fold': '动态上下文', vcpinfo: 'VCP 通知' };
    const kind = String(observation.kind || 'unknown');
    const card = createExpandableObservationCard(document, {
        className: `agent-chat-toolbox-ws-card agent-chat-marker-card agent-chat-marker-${kind}`,
        icon: kind === 'dynamic-fold' ? 'unfold_more' : 'info',
        title: `VCP 内容 · ${labels[kind] || '受限标记'}`,
        channel: 'display only',
        summary: safeText(observation.summary).slice(0, 2_000) || 'VCP 内容标记已被安全投影。',
        detail: safeText(observation.detail).slice(0, 16_384),
    });
    card.dataset.markerKind = kind;
    return card;
}

export {
    createMarkerObservationCard,
    createToolboxObservationCard,
    projectToolboxObservation,
    structuredObservationSummary,
};
