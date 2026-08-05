import { node } from './agent-workbench-dom.js';

function detailRows(document, values) {
    const list = node('dl', 'agent-chat-config-diagnostic-grid', undefined, document);
    for (const [label, rawValue] of values) {
        const value = String(rawValue || '—');
        const row = node('div', 'agent-chat-config-diagnostic-row', undefined, document);
        const detail = node('dd', 'agent-chat-config-value', value, document);
        detail.title = value;
        row.append(node('dt', '', label, document), detail);
        list.append(row);
    }
    return list;
}

function identityRows(model) {
    const modelAvailability = model.selectedModelAvailable === false ? '缺失'
        : model.selectedModelAvailable === true ? '可用' : '未验证';
    return [
        ['Session', model.sessionId || '未选择'],
        ['Thread', model.threadId || '尚未创建'],
        ['Runtime', `${model.runtimeState || 'unknown'}${model.runtimeGeneration ? ` · g${model.runtimeGeneration}` : ''}`],
        ['Thread 状态', `${model.threadActivity || 'unknown'} · observed ${model.observedThreadStatus || 'unknown'} · recovery ${model.threadRecoveryState || 'unknown'}`],
        ['ToolBox', `${model.toolboxConfigured ? '已配置' : '未配置'} · ${model.endpoint || '未配置'}`],
        ['Adapter', `${model.adapterState || 'not-started'} · ${model.adapterActiveRequests || 0} 个活动请求`],
        ['模型缓存', `${model.modelCatalogCount || 0} 个 · 当前模型${modelAvailability}`],
        ['Revision', `已保存 r${model.desiredRevision || 0} · Runtime r${model.appliedRevision || 0}`],
        ['配置 Barrier', model.applyBarrierWaiting
            ? `等待 r${model.applyBarrierRevision || 0} · ${(model.applyBarrierFields || []).join(', ') || '无字段'}`
            : '已清除'],
        ['Projection', `schema ${model.storageSchemaVersion || '未知'}${model.storageReadOnly ? ' · 只读降级' : ''}`],
        ['最近对账', model.projectionLastReconciledAt
            ? new Date(model.projectionLastReconciledAt).toLocaleString() : '尚未完成'],
    ];
}

function requestRows(lastRequest) {
    if (!lastRequest) return null;
    return [
        ['状态', `${lastRequest.status || 'unknown'}${lastRequest.httpStatus ? ` · HTTP ${lastRequest.httpStatus}` : ''}`],
        ['模型', lastRequest.model || '模型默认'],
        ['耗时', lastRequest.durationMs == null ? '进行中' : `${lastRequest.durationMs} ms`],
        ['工具过滤', `输入 ${(lastRequest.incomingTools || []).length} 个 · 转发 ${(lastRequest.forwardedTools || []).map((tool) => tool.name).filter(Boolean).join(', ') || '无'}`],
    ];
}

function createDiagnosticDetailsView(document, model = {}) {
    const details = node('details', 'agent-chat-config-diagnostic-details', undefined, document);
    const summary = node('summary', '', undefined, document);
    const summaryCopy = node('span', '', undefined, document);
    summaryCopy.append(
        node('strong', '', '连接与请求详情', document),
        node('small', '', 'Session、Thread、Endpoint 与最近请求', document),
    );
    summary.append(summaryCopy);
    const content = node('div', 'agent-chat-config-diagnostic-details-content', undefined, document);
    content.append(detailRows(document, identityRows(model)));
    const lastRequest = requestRows(model.adapterLastRequest);
    if (lastRequest) {
        const request = node('section', 'agent-chat-config-diagnostic-request', undefined, document);
        request.append(
            node('strong', 'agent-chat-setting-label', '最近一次 Adapter 请求', document),
            detailRows(document, lastRequest),
        );
        content.append(request);
    } else {
        content.append(node('p', 'agent-chat-settings-placeholder', '当前 Session 尚无模型请求记录。', document));
    }
    details.append(summary, content);
    return details;
}

export { createDiagnosticDetailsView, detailRows };
