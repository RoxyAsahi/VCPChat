'use strict';

// 声明式 API 的参数描述与校验。
// 参数来自两处：AI 工具调用（VCP 解析后几乎全是字符串）和挂件脚本（原生 JS 值），
// 所以校验前先做宽松转换："12" → 12、"true" → true、JSON 文本 → 对象/数组。
// 只支持下面列出的这一小套规则，够描述桌面与后端接口，又能直接转成 JSON Schema 给模型看。
//
// 参数描述：
//   { type, required?, description, enum?, default?, min?, max?, maxLength?, pattern? }
//   type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'json'
//   json 表示任意 JSON 值，字符串会先尝试 JSON.parse，解析失败保留原文。

const TYPES = Object.freeze(['string', 'number', 'integer', 'boolean', 'object', 'array', 'json']);

class ParamError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'ParamError';
        this.code = 'INVALID_PARAMS';
        this.field = field || null;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonText(text, name) {
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new ParamError(`参数 ${name} 需要合法的 JSON：${error.message}`, name);
    }
}

function coerce(value, spec, name) {
    const { type } = spec;
    if (type === 'string') {
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        throw new ParamError(`参数 ${name} 需要字符串`, name);
    }
    if (type === 'number' || type === 'integer') {
        const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
        if (typeof num !== 'number' || !Number.isFinite(num)) throw new ParamError(`参数 ${name} 需要数字`, name);
        if (type === 'integer' && !Number.isInteger(num)) throw new ParamError(`参数 ${name} 需要整数`, name);
        return num;
    }
    if (type === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const text = value.trim().toLowerCase();
            if (text === 'true' || text === '1') return true;
            if (text === 'false' || text === '0') return false;
        }
        if (value === 1 || value === 0) return value === 1;
        throw new ParamError(`参数 ${name} 需要 true 或 false`, name);
    }
    if (type === 'object') {
        const obj = typeof value === 'string' ? parseJsonText(value.trim(), name) : value;
        if (!isPlainObject(obj)) throw new ParamError(`参数 ${name} 需要 JSON 对象`, name);
        return obj;
    }
    if (type === 'array') {
        const arr = typeof value === 'string' ? parseJsonText(value.trim(), name) : value;
        if (!Array.isArray(arr)) throw new ParamError(`参数 ${name} 需要 JSON 数组`, name);
        return arr;
    }
    // json：字符串能解析就解析，不能就按原文
    if (typeof value === 'string') {
        const text = value.trim();
        if (/^[[{"]/.test(text) || /^(true|false|null|-?\d)/.test(text)) {
            try {
                return JSON.parse(text);
            } catch {
                return value;
            }
        }
    }
    return value;
}

function checkConstraints(value, spec, name) {
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
        throw new ParamError(`参数 ${name} 只能是 ${spec.enum.join(' / ')}`, name);
    }
    if (typeof value === 'number') {
        if (typeof spec.min === 'number' && value < spec.min) throw new ParamError(`参数 ${name} 不能小于 ${spec.min}`, name);
        if (typeof spec.max === 'number' && value > spec.max) throw new ParamError(`参数 ${name} 不能大于 ${spec.max}`, name);
    }
    if (typeof value === 'string') {
        if (typeof spec.maxLength === 'number' && value.length > spec.maxLength) {
            throw new ParamError(`参数 ${name} 超过 ${spec.maxLength} 个字符`, name);
        }
        if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
            throw new ParamError(`参数 ${name} 格式不对（${spec.pattern}）`, name);
        }
    }
}

function isMissing(value) {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * 按参数描述转换并校验，返回只含已声明参数的新对象。未声明的参数直接报错，
 * 这样拼错参数名会立刻暴露，而不是被悄悄忽略。
 * @param {Record<string, object>} specs
 * @param {unknown} raw
 */
function validateParams(specs, raw) {
    const input = raw === undefined || raw === null ? {} : (typeof raw === 'string' ? parseJsonText(raw.trim() || '{}', 'params') : raw);
    if (!isPlainObject(input)) throw new ParamError('params 需要 JSON 对象');
    const declared = specs || {};
    const unknown = Object.keys(input).filter((key) => !Object.prototype.hasOwnProperty.call(declared, key));
    if (unknown.length) {
        const known = Object.keys(declared);
        throw new ParamError(`未知参数 ${unknown.join(', ')}；可用参数：${known.length ? known.join(', ') : '无'}`, unknown[0]);
    }
    const out = {};
    for (const [name, spec] of Object.entries(declared)) {
        const value = input[name];
        if (isMissing(value)) {
            if (spec.required) throw new ParamError(`缺少必填参数 ${name}`, name);
            if (spec.default !== undefined) out[name] = spec.default;
            continue;
        }
        const coerced = coerce(value, spec, name);
        checkConstraints(coerced, spec, name);
        out[name] = coerced;
    }
    return out;
}

/** 检查参数描述本身写得对不对，定义接口时调用。 */
function assertParamSpecs(specs, where) {
    if (specs === undefined) return;
    if (!isPlainObject(specs)) throw new TypeError(`${where}: params 必须是对象`);
    for (const [name, spec] of Object.entries(specs)) {
        if (!isPlainObject(spec)) throw new TypeError(`${where}.${name}: 参数描述必须是对象`);
        if (!TYPES.includes(spec.type)) throw new TypeError(`${where}.${name}: 未知类型 ${spec.type}`);
        if (typeof spec.description !== 'string' || !spec.description.trim()) {
            throw new TypeError(`${where}.${name}: 缺少 description`);
        }
    }
}

/** 转成 JSON Schema，给模型和挂件作者看。 */
function toJsonSchema(specs) {
    const properties = {};
    const required = [];
    for (const [name, spec] of Object.entries(specs || {})) {
        const prop = { description: spec.description };
        if (spec.type !== 'json') prop.type = spec.type;
        for (const key of ['enum', 'default', 'pattern', 'maxLength']) {
            if (spec[key] !== undefined) prop[key] = spec[key];
        }
        if (spec.min !== undefined) prop.minimum = spec.min;
        if (spec.max !== undefined) prop.maximum = spec.max;
        properties[name] = prop;
        if (spec.required) required.push(name);
    }
    const schema = { type: 'object', properties, additionalProperties: false };
    if (required.length) schema.required = required;
    return schema;
}

module.exports = {
    TYPES,
    ParamError,
    validateParams,
    assertParamSpecs,
    toJsonSchema,
    isPlainObject,
};
