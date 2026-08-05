const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const text = (value) => String(value ?? '').trim();
const nullableText = (value) => text(value) || null;
const permissionMode = (value) => value === 'always-approve' ? 'always-approve' : 'ask';
const instructionMode = (value, context = {}) => {
    if (value === 'codex-managed' || value === 'vchat-identity') return value;
    return text(context.baseInstructions) ? 'vchat-identity' : 'codex-managed';
};
const positiveInteger = (value) => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : Number.NaN;
};
const toolPolicy = (value) => {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const preset = ['full', 'readonly', 'custom'].includes(source.preset) ? source.preset : 'full';
    const strings = (items) => Array.isArray(items)
        ? [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))] : [];
    return {
        schemaVersion: 1,
        preset,
        enabledCodexCapabilities: strings(source.enabledCodexCapabilities),
        enabledVcpTools: strings(source.enabledVcpTools),
    };
};

const AGENT_CONFIG_DESCRIPTORS = Object.freeze({
    model: Object.freeze({
        key: 'model', label: '模型', scopes: ['profile', 'session'], control: 'select',
        defaultValue: '', normalize: text, validate: (value) => typeof value === 'string',
        options: (context = {}) => (context.modelCatalog || []).map((model) => ({
            value: typeof model === 'string' ? model : model?.id || model?.name || '',
            label: typeof model === 'string' ? model : model?.name || model?.id || '',
        })).filter((item) => item.value),
        cas: true, runtimeApply: true, allowEmpty: true,
    }),
    workspaceRoot: Object.freeze({
        key: 'workspaceRoot', label: '工作目录（可留空）', scopes: ['profile', 'session'], control: 'text',
        defaultValue: '', normalize: text, validate: (value) => typeof value === 'string',
        cas: true, runtimeApply: true, allowEmpty: true,
    }),
    permissionMode: Object.freeze({
        key: 'permissionMode', label: '本地工具审批', scopes: ['profile', 'session'], control: 'select',
        defaultValue: 'ask', normalize: permissionMode,
        validate: (value) => ['ask', 'always-approve'].includes(value),
        options: () => [
            { value: 'ask', label: '每次确认（推荐）' },
            { value: 'always-approve', label: 'YOLO：本地自动允许' },
        ],
        cas: true, runtimeApply: true, allowEmpty: false,
    }),
    baseInstructions: Object.freeze({
        key: 'baseInstructions', aliases: ['systemPrompt'], label: 'VChat 身份提示词',
        scopes: ['profile', 'session'], control: 'textarea', defaultValue: '', normalize: text,
        validate: (value, context = {}) => context.instructionMode !== 'vchat-identity' || Boolean(value),
        cas: true, runtimeApply: true, allowEmpty: true, sensitive: true,
    }),
    instructionMode: Object.freeze({
        key: 'instructionMode', label: '指令来源', scopes: ['profile', 'session'], control: 'select',
        defaultValue: 'vchat-identity', normalize: instructionMode,
        validate: (value) => ['vchat-identity', 'codex-managed'].includes(value),
        options: () => [
            { value: 'vchat-identity', label: 'VChat 身份' },
            { value: 'codex-managed', label: 'Codex 0.146 管理' },
        ],
        cas: true, runtimeApply: true, allowEmpty: false,
    }),
    reasoningEffort: Object.freeze({
        key: 'reasoningEffort', label: '推理强度', scopes: ['profile', 'session'], control: 'select',
        defaultValue: null, normalize: nullableText,
        validate: (value, context = {}) => value == null
            || !Array.isArray(context.reasoningEfforts) || context.reasoningEfforts.includes(value),
        options: (context = {}) => [
            { value: '', label: '模型默认' },
            ...(context.reasoningEfforts || []).map((value) => ({ value, label: value })),
        ],
        cas: true, runtimeApply: true, allowEmpty: true,
    }),
    toolPolicy: Object.freeze({
        key: 'toolPolicy', label: '工具', scopes: ['profile', 'session'], control: 'custom',
        defaultValue: null, normalize: toolPolicy,
        validate: (value) => value && value.schemaVersion === 1
            && ['full', 'readonly', 'custom'].includes(value.preset),
        cas: true, runtimeApply: true, allowEmpty: false,
    }),
    'budget.maxRequestsPerTurn': Object.freeze({
        key: 'budget.maxRequestsPerTurn', label: '模型请求数', scopes: ['advanced'], control: 'number',
        defaultValue: null, normalize: positiveInteger,
        validate: (value) => value == null || (Number.isInteger(value) && value > 0),
        cas: false, runtimeApply: true, allowEmpty: true,
    }),
    'budget.maxTokensPerTurn': Object.freeze({
        key: 'budget.maxTokensPerTurn', label: '累计 token', scopes: ['advanced'], control: 'number',
        defaultValue: null, normalize: positiveInteger,
        validate: (value) => value == null || (Number.isInteger(value) && value > 0),
        cas: false, runtimeApply: true, allowEmpty: true,
    }),
});

const AGENT_CONFIG_FIELDS = Object.freeze(Object.keys(AGENT_CONFIG_DESCRIPTORS));
const PROFILE_CONFIG_FIELDS = Object.freeze(AGENT_CONFIG_FIELDS.filter((key) => (
    AGENT_CONFIG_DESCRIPTORS[key].scopes.includes('profile')
)));
const SESSION_CONFIG_FIELDS = Object.freeze(AGENT_CONFIG_FIELDS.filter((key) => (
    AGENT_CONFIG_DESCRIPTORS[key].scopes.includes('session')
)));

function descriptorFor(key) {
    return AGENT_CONFIG_DESCRIPTORS[key] || null;
}

function sourceValue(source, descriptor) {
    if (own(source, descriptor.key)) return source[descriptor.key];
    for (const alias of descriptor.aliases || []) {
        if (own(source, alias)) return source[alias];
    }
    return undefined;
}

function hasConfigField(source, key) {
    const descriptor = descriptorFor(key);
    return Boolean(descriptor && (own(source, descriptor.key)
        || (descriptor.aliases || []).some((alias) => own(source, alias))));
}

function normalizeConfigField(key, value, context = {}) {
    const descriptor = descriptorFor(key);
    if (!descriptor) return { valid: false, value, error: `Unsupported Agent config field: ${key}` };
    const normalized = descriptor.normalize(value, context);
    const valid = descriptor.validate(normalized, context);
    return { valid, value: normalized, error: valid ? '' : `Invalid value for ${key}` };
}

function normalizeAgentConfig(source = {}, { fallback = {}, fields = AGENT_CONFIG_FIELDS, context = {} } = {}) {
    const values = {};
    const present = new Set();
    const errors = [];
    for (const key of fields) {
        const descriptor = descriptorFor(key);
        if (!descriptor || key.startsWith('budget.')) continue;
        const provided = hasConfigField(source, key);
        const raw = provided ? sourceValue(source, descriptor)
            : sourceValue(fallback, descriptor) ?? descriptor.defaultValue;
        const fieldContext = { ...context, ...fallback, ...source, ...values };
        const result = normalizeConfigField(key, raw, fieldContext);
        values[key] = result.value;
        if (provided) present.add(key);
        if (!result.valid) errors.push({ field: key, message: result.error });
    }
    return { values, present, errors };
}

function configOptions(key, context = {}) {
    const options = descriptorFor(key)?.options;
    return typeof options === 'function' ? options(context) : [];
}

export {
    AGENT_CONFIG_DESCRIPTORS,
    AGENT_CONFIG_FIELDS,
    PROFILE_CONFIG_FIELDS,
    SESSION_CONFIG_FIELDS,
    configOptions,
    descriptorFor,
    hasConfigField,
    normalizeAgentConfig,
    normalizeConfigField,
};
