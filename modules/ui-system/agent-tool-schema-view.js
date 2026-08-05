function icon(context, name) {
    return context.node('span', 'vcp-ui-icon', name);
}

function formatTime(value) {
    const timestamp = Number(value || 0);
    if (!timestamp) return '';
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).format(new Date(timestamp));
    } catch {
        return '';
    }
}

function schemaFields(parameters) {
    const properties = parameters?.properties && typeof parameters.properties === 'object'
        ? parameters.properties : {};
    const required = new Set(Array.isArray(parameters?.required) ? parameters.required : []);
    return Object.entries(properties).map(([name, schema]) => ({
        name,
        type: Array.isArray(schema?.type) ? schema.type.join(' | ') : schema?.type || 'any',
        required: required.has(name),
    }));
}

function emptyState(context, title, detail) {
    const root = context.node('div', 'agent-tool-schema-empty');
    root.append(icon(context, 'data_object'));
    const copy = context.node('div', '');
    copy.append(context.node('strong', '', title), context.node('span', '', detail));
    root.append(copy);
    return root;
}

function renderSchemaCard(context, schema) {
    const details = context.document.createElement('details');
    details.className = 'agent-tool-schema-card';
    const summary = context.document.createElement('summary');
    const title = context.node('div', 'agent-tool-schema-title');
    title.append(icon(context, 'functions'));
    const labels = context.node('div', '');
    labels.append(context.node('strong', '', schema.name || '未命名工具'));
    if (schema.description) labels.append(context.node('span', '', schema.description));
    title.append(labels);
    const fields = schemaFields(schema.parameters);
    summary.append(title, context.node('span', 'agent-tool-schema-count', `${fields.length} 个字段`));
    details.append(summary);

    const body = context.node('div', 'agent-tool-schema-body');
    if (fields.length) {
        const fieldList = context.node('div', 'agent-tool-schema-fields');
        for (const field of fields) {
            const row = context.node('div', 'agent-tool-schema-field');
            row.append(
                context.node('code', '', field.name),
                context.node('span', '', field.type),
                context.node('small', field.required ? 'is-required' : '', field.required ? '必填' : '可选'),
            );
            fieldList.append(row);
        }
        body.append(fieldList);
    }
    const raw = context.document.createElement('pre');
    raw.className = 'agent-tool-schema-json';
    raw.textContent = JSON.stringify(schema, null, 2);
    body.append(raw);
    details.append(body);
    return details;
}

export function renderAgentToolSchema(context, state = {}) {
    const root = context.node('div', 'agent-tool-schema');
    if (!state.sessionId) {
        root.append(emptyState(context, '需要当前会话', '实际 Schema 来自某次真实模型请求，Agent 默认配置没有请求记录。'));
        return root;
    }
    if (state.loading) {
        root.append(emptyState(context, '正在读取实际 Schema', '正在查询当前会话最近一次转发给模型的工具定义。'));
        return root;
    }
    if (state.error) {
        root.append(emptyState(context, 'Schema 读取失败', state.error));
        return root;
    }
    const requests = state.diagnostics?.toolbox?.adapter?.recentRequests || [];
    const request = requests.find((entry) => Array.isArray(entry.forwardedToolSchemas));
    if (!request) {
        root.append(emptyState(context, '还没有真实请求', '发送一轮消息后，这里会显示该轮实际提供给模型的工具 Schema。'));
        return root;
    }

    const schemas = request.forwardedToolSchemas || [];
    const header = context.node('div', 'agent-tool-schema-header');
    const meta = context.node('div', 'agent-tool-schema-request-meta');
    meta.append(
        context.node('strong', '', request.model || '模型默认'),
        context.node('span', '', `${schemas.length} 个工具${formatTime(request.startedAt) ? ` · ${formatTime(request.startedAt)}` : ''}`),
    );
    const badge = context.node('span', `agent-tool-schema-status is-${request.status || 'unknown'}`,
        request.status === 'completed' ? '已完成' : request.status === 'running' ? '请求中' : request.status || '未知');
    header.append(meta, badge);
    root.append(header);

    if (!schemas.length) {
        root.append(emptyState(context, '本轮没有开放工具', '最后一次请求实际转发的 tools 数组为空。'));
        return root;
    }
    const list = context.node('div', 'agent-tool-schema-list');
    for (const schema of schemas) list.append(renderSchemaCard(context, schema));
    root.append(list);
    return root;
}
