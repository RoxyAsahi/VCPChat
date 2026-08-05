const MAX_TEXT_LENGTH = 320;
const MAX_DETAIL_DEPTH = 3;
const SENSITIVE_KEY = /(?:api.?key|authorization|bearer|secret|password|prompt|instruction|content|attachment|absolute.?path)/i;
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\|\/)/i;

const CONFIG_FIELDS = Object.freeze([
    { key: 'instructionMode', label: '指令来源', format: plainValue },
    { key: 'baseInstructions', label: 'VChat 身份提示词', format: instructionValue },
    { key: 'developerInstructions', label: '附加指令', format: instructionValue },
    { key: 'personality', label: 'Personality', format: plainValue },
    { key: 'model', label: '模型', format: plainValue },
    { key: 'reasoningEffort', label: 'Reasoning', format: defaultValue },
    { key: 'workspaceRoot', label: '工作目录', format: workspaceValue },
    { key: 'permissionMode', label: '审批模式', format: plainValue },
]);

function truncate(value, limit = MAX_TEXT_LENGTH) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function plainValue(value) {
    return truncate(value || '未设置', 120);
}

function defaultValue(value) {
    return truncate(value || '模型默认', 120);
}

function instructionValue(value) {
    if (value?.redactedType === 'instruction') {
        return value.configured ? `已配置（${Number(value.length) || 0} 字符）` : '未配置';
    }
    const text = String(value || '');
    return text ? `已配置（${text.length} 字符）` : '未配置';
}

function workspaceValue(value) {
    if (value?.redactedType === 'workspace') return value.configured ? truncate(value.display || '已配置') : '未设置';
    const text = String(value || '').trim();
    if (!text) return '未设置';
    const pieces = text.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return pieces.length ? `…/${truncate(pieces.at(-1), 96)}` : '已配置';
}

function sameValue(left, right) {
    if (left == null && right == null) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
    }
    return String(left ?? '') === String(right ?? '');
}

function sanitizeDetail(value, key = '', depth = 0) {
    if (SENSITIVE_KEY.test(key)) return '[redacted]';
    if (depth > MAX_DETAIL_DEPTH) return '[truncated]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
        if (ABSOLUTE_PATH.test(value.trim())) return workspaceValue(value);
        return truncate(value);
    }
    if (Array.isArray(value)) return value.slice(0, 12).map((entry) => sanitizeDetail(entry, key, depth + 1));
    if (typeof value !== 'object') return truncate(value);
    return Object.fromEntries(Object.entries(value).slice(0, 24)
        .map(([entryKey, entry]) => [truncate(entryKey, 80), sanitizeDetail(entry, entryKey, depth + 1)]));
}

function normalizeDiagnosticError(error, fallbackCode = 'AGENT_DIAGNOSTIC_ERROR') {
    if (!error) return null;
    if (typeof error === 'string') {
        return { code: fallbackCode, message: truncate(error), details: null };
    }
    const source = error.error && typeof error.error === 'object' ? error.error : error;
    return {
        code: truncate(source.code || fallbackCode, 96),
        message: truncate(source.message || source.error || String(source), MAX_TEXT_LENGTH),
        details: source.details ? sanitizeDetail(source.details) : null,
    };
}

function safeEndpoint(value) {
    const text = String(value || '').trim();
    if (!text) return '未配置';
    try {
        const parsed = new URL(text);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return truncate(parsed.toString(), 240);
    } catch {
        return '配置无效';
    }
}

function configDifferences(desired = {}, applied = {}, differenceFields = null) {
    const explicit = Array.isArray(differenceFields) ? new Set(differenceFields) : null;
    return CONFIG_FIELDS.filter(({ key }) => explicit ? explicit.has(key) : !sameValue(desired?.[key], applied?.[key]))
        .map(({ key, label, format }) => ({
            key,
            label,
            desired: format(desired?.[key]),
            applied: format(applied?.[key]),
        }));
}

function firstDefined(values, fallback = null) {
    for (const value of values) if (value !== undefined && value !== null) return value;
    return fallback;
}

function diagnosticIdentity(authoritative = {}, session = {}) {
    return {
        sessionId: String(firstDefined([authoritative.sessionId, session.sessionId], '')).trim(),
        threadId: String(firstDefined([
            authoritative.threadId, session.threadId, session.session?.threadId,
        ], '')).trim(),
    };
}

function diagnosticConfigs(authoritative = {}, session = {}) {
    return {
        desired: firstDefined([authoritative.desiredConfig, session.configSnapshot], {}),
        applied: firstDefined([authoritative.appliedRuntimeConfig, session.appliedRuntimeConfig], {}),
    };
}

function diagnosticRevisions(authoritative = {}, session = {}) {
    const desiredRevision = Number(firstDefined([authoritative.configRevision, session.configRevision], 0));
    const appliedRevision = Number(firstDefined([
        authoritative.appliedRuntimeConfigRevision, session.appliedRuntimeConfigRevision,
    ], 0));
    const applyState = String(firstDefined([
        authoritative.applyState,
        session.configApplyState,
    ], desiredRevision > 0 && desiredRevision === appliedRevision ? 'applied' : 'pending'));
    return { desiredRevision, appliedRevision, applyState };
}

function diagnosticErrors(authoritative = {}, session = {}, runtime = {}, saveStatus = {}) {
    const latestAdapterFailure = authoritative.toolbox?.adapter?.recentRequests
        ?.find((request) => request?.error);
    return {
        applyError: normalizeDiagnosticError(firstDefined([
            authoritative.applyError, session.configApplyError,
        ]), 'SESSION_CONFIG_APPLY_ERROR'),
        runtimeError: normalizeDiagnosticError(runtime.lastError, 'RUNTIME_ERROR'),
        saveError: normalizeDiagnosticError(saveStatus.error, 'SETTINGS_SAVE_ERROR'),
        storageError: normalizeDiagnosticError(runtime.storage?.error || runtime.storage?.degradedReason,
            'PROJECTION_READ_ONLY'),
        projectionError: normalizeDiagnosticError(runtime.projection?.error, 'PROJECTION_RECONCILE_ERROR'),
        adapterError: normalizeDiagnosticError(latestAdapterFailure?.error, 'TOOLBOX_ADAPTER_ERROR'),
    };
}

function runtimeDiagnosticModel(runtime = {}) {
    return {
        runtimeState: String(runtime.state || 'unknown'),
        runtimeGeneration: Number(runtime.generation || runtime.runtimeGeneration || 0),
        runtimeProtocol: String(runtime.protocol || 'codex-app-server-jsonl'),
        threadActivity: String(runtime.thread?.activity || 'idle'),
        observedThreadStatus: runtime.thread?.observedStatus || null,
        threadRecoveryState: String(runtime.thread?.recoveryState || 'confirmed'),
        projectionLastReconciledAt: Number(runtime.projection?.lastReconciledAt || 0) || null,
    };
}

function toolboxDiagnosticModel(toolbox = {}) {
    const adapter = toolbox.adapter || {};
    return {
        endpoint: safeEndpoint(toolbox.endpoint),
        toolboxConfigured: toolbox.configured === true,
        adapterState: String(adapter.state || 'not-started'),
        adapterActiveRequests: Number(adapter.activeRequestCount || 0),
        adapterLastRequest: adapter.recentRequests?.[0] || null,
    };
}

function storageDiagnosticModel(runtime = {}, storageError = null) {
    const storage = runtime.storage || {};
    return {
        storageReadOnly: storage.readOnly === true,
        storageSchemaVersion: Number(storage.schemaVersion || 0),
        storageError,
    };
}

function catalogDiagnosticModel(authoritative = {}, desired = {}) {
    const catalog = authoritative.modelCatalog || {};
    return {
        modelCatalogCount: Number(catalog.cachedCount || 0),
        selectedModel: catalog.selectedModel || desired.model || null,
        selectedModelAvailable: catalog.selectedModelAvailable ?? null,
    };
}

function barrierDiagnosticModel(authoritative = {}) {
    const barrier = authoritative.applyBarrier || {};
    return {
        applyBarrierWaiting: barrier.waiting === true,
        applyBarrierRevision: Number(barrier.revision || 0),
        applyBarrierGeneration: Number(barrier.runtimeGeneration || 0),
        applyBarrierFields: Array.isArray(barrier.fields) ? barrier.fields : [],
    };
}

function configStateModel(identity, revisions, differences) {
    const { sessionId, threadId } = identity;
    const { desiredRevision, appliedRevision, applyState } = revisions;
    return {
        sessionId,
        threadId,
        desiredRevision,
        appliedRevision,
        applyState,
        differences,
        canRefresh: Boolean(sessionId),
        canReapply: Boolean(sessionId && threadId),
        inSync: applyState === 'applied' && desiredRevision === appliedRevision && differences.length === 0,
    };
}

function buildAgentConfigDiagnostics({ runtime = {}, session = {}, authoritative = null, saveStatus = null } = {}) {
    const authoritativeConfig = authoritative || {};
    const runtimeSnapshot = authoritativeConfig.runtime || runtime || {};
    const toolboxSnapshot = authoritativeConfig.toolbox || runtimeSnapshot.toolbox || runtime?.toolbox || {};
    const identity = diagnosticIdentity(authoritativeConfig, session);
    const configs = diagnosticConfigs(authoritativeConfig, session);
    const revisions = diagnosticRevisions(authoritativeConfig, session);
    const errors = diagnosticErrors(authoritativeConfig, session, runtimeSnapshot, saveStatus || {});
    const { desired, applied } = configs;
    const differences = configDifferences(desired, applied, authoritativeConfig.configDifferenceFields);
    return {
        ...configStateModel(identity, revisions, differences),
        ...runtimeDiagnosticModel(runtimeSnapshot),
        ...toolboxDiagnosticModel(toolboxSnapshot),
        ...storageDiagnosticModel(runtimeSnapshot, errors.storageError),
        ...catalogDiagnosticModel(authoritativeConfig, desired),
        ...barrierDiagnosticModel(authoritativeConfig),
        applyError: errors.applyError,
        runtimeError: errors.runtimeError,
        adapterError: errors.adapterError,
        projectionError: errors.projectionError,
        saveError: errors.saveError,
    };
}

function diagnosticSummary(model = {}) {
    const errors = [model.saveError, model.applyError, model.runtimeError, model.adapterError,
        model.projectionError, model.storageError]
        .filter(Boolean);
    const lastRequest = model.adapterLastRequest;
    return [
        'VChat Codex Agent diagnostics',
        `session: ${model.sessionId || '<none>'}`,
        `thread: ${model.threadId || '<unmaterialized>'}`,
        `runtime: ${model.runtimeState || 'unknown'}${model.runtimeGeneration ? ` (generation ${model.runtimeGeneration})` : ''}`,
        threadDiagnosticLine(model),
        `toolbox: ${model.toolboxConfigured ? 'configured' : 'not-configured'} · ${model.endpoint || '未配置'}`,
        `adapter: ${model.adapterState || 'not-started'} · active ${model.adapterActiveRequests || 0}`,
        `models: cached ${model.modelCatalogCount || 0} · selected ${model.selectedModel || '<none>'} · available ${model.selectedModelAvailable == null ? 'unknown' : model.selectedModelAvailable}`,
        `config: desired r${model.desiredRevision || 0} · applied r${model.appliedRevision || 0} · ${model.applyState || 'unknown'}`,
        `barrier: ${model.applyBarrierWaiting ? `waiting r${model.applyBarrierRevision || 0} (${(model.applyBarrierFields || []).join(', ') || 'no fields'})` : 'clear'}`,
        ...(lastRequest ? [`last adapter request: ${lastRequest.status || 'unknown'} · ${lastRequest.model || '<default>'} · ${lastRequest.durationMs ?? '?'}ms · incoming ${(lastRequest.incomingTools || []).length} · forwarded ${(lastRequest.forwardedTools || []).map((tool) => tool.name).filter(Boolean).join(', ') || 'none'}`] : []),
        `differences: ${(model.differences || []).map((item) => item.label).join(', ') || 'none'}`,
        ...errors.map((error) => `error: ${error.code} · ${error.message}`),
    ].join('\n');
}

function threadDiagnosticLine(model = {}) {
    const activity = model.threadActivity || 'unknown';
    const observed = model.observedThreadStatus || 'unknown';
    const recovery = model.threadRecoveryState || 'unknown';
    return `thread: ${activity} · observed ${observed} · recovery ${recovery}`;
}

export {
    buildAgentConfigDiagnostics,
    configDifferences,
    diagnosticSummary,
    normalizeDiagnosticError,
    safeEndpoint,
    sanitizeDetail,
};
