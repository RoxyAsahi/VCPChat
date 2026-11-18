'use strict';

// 声明式 API 目录：每个接口登记一次（id、说明、参数、访问级别、谁能调用、怎么执行），
// AI 工具、桌面挂件、以后的后端插件都从这一张表发现和调用，不再各写一套转发。
//
// 发现分两步，避免一次把全部说明塞给模型：
//   list()      目录：id、标题、一句话说明、访问级别、参数名
//   describe()  单个接口的完整说明与参数 JSON Schema
//   call()      校验参数 → 检查调用方 → 执行 → { ok, data } 或 { ok: false, error: { code, message } }
//
// 接口定义：
//   {
//     id: 'desktop.widgets.list',          // 领域.对象.动作，小写点分
//     title: '列出桌面挂件',
//     description: '完整说明，第一句作为目录摘要',
//     access: 'read' | 'write' | 'danger',  // danger 目前不对任何调用方开放，留给需要用户确认的接口
//     callers: ['model', 'widget'],         // model = AI 工具调用；widget = 桌面挂件脚本
//     params: { name: { type, required, description, ... } },
//     returns: '返回值说明',
//     timeoutMs: 8000,
//     // 二选一：
//     handler: async (params, ctx) => data,
//     ipc: { channel: 'desktop-list-widgets', args: (params) => [...], map: (data, params) => data },
//   }
// ipc 型接口复用现有 ipcMain.handle：args 把参数排成通道的位置参数，map 裁剪返回值
// （例如去掉缩略图 data URL，免得把几百 KB 的 base64 塞进模型上下文）。

const { ParamError, validateParams, assertParamSpecs, toJsonSchema, isPlainObject } = require('./schema');

const ACCESS_LEVELS = Object.freeze(['read', 'write', 'danger']);
const CALLERS = Object.freeze(['model', 'widget']);
const ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,3}$/;
const DEFAULT_TIMEOUT_MS = 10000;

const ERROR_CODES = Object.freeze({
    NOT_FOUND: 'API_NOT_FOUND',
    FORBIDDEN: 'API_FORBIDDEN',
    INVALID_PARAMS: 'INVALID_PARAMS',
    FAILED: 'API_FAILED',
    TIMEOUT: 'API_TIMEOUT',
    UNAVAILABLE: 'API_UNAVAILABLE',
});

class DesktopApiError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DesktopApiError';
        this.code = code;
    }
}

function firstSentence(text) {
    const match = String(text || '').match(/^[^。.!！?？\n]*[。.!！?？]?/);
    return (match ? match[0] : String(text || '')).trim();
}

function assertOperation(op) {
    const where = `[DesktopApi] ${op?.id || '(无 id)'}`;
    if (!isPlainObject(op)) throw new TypeError('[DesktopApi] 接口定义必须是对象');
    if (typeof op.id !== 'string' || !ID_PATTERN.test(op.id)) {
        throw new TypeError(`${where}: id 需要是 领域.对象.动作 形式的小写点分名称`);
    }
    for (const key of ['title', 'description']) {
        if (typeof op[key] !== 'string' || !op[key].trim()) throw new TypeError(`${where}: 缺少 ${key}`);
    }
    if (!ACCESS_LEVELS.includes(op.access)) throw new TypeError(`${where}: access 只能是 ${ACCESS_LEVELS.join(' / ')}`);
    if (!Array.isArray(op.callers) || !op.callers.length || op.callers.some((c) => !CALLERS.includes(c))) {
        throw new TypeError(`${where}: callers 只能取 ${CALLERS.join(' / ')}，且不能为空`);
    }
    const hasHandler = typeof op.handler === 'function';
    const hasIpc = isPlainObject(op.ipc) && typeof op.ipc.channel === 'string' && op.ipc.channel;
    if (hasHandler === Boolean(hasIpc)) throw new TypeError(`${where}: handler 与 ipc 必须且只能提供一个`);
    for (const key of ['args', 'map']) {
        if (op.ipc?.[key] !== undefined && typeof op.ipc[key] !== 'function') throw new TypeError(`${where}: ipc.${key} 必须是函数`);
    }
    if (op.timeoutMs !== undefined && !(Number.isFinite(op.timeoutMs) && op.timeoutMs > 0)) {
        throw new TypeError(`${where}: timeoutMs 必须是正数`);
    }
    assertParamSpecs(op.params, where);
}

function withTimeout(promise, ms, id) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DesktopApiError(ERROR_CODES.TIMEOUT, `${id} 超过 ${ms}ms 没有返回`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 现有 IPC handler 多数返回 { success, data, error }；声明式接口统一成直接返回 data、失败抛错
function unwrapEnvelope(result) {
    if (isPlainObject(result) && typeof result.success === 'boolean') {
        if (!result.success) throw new DesktopApiError(ERROR_CODES.FAILED, result.error || '调用失败');
        const { success, ...rest } = result;
        return Object.prototype.hasOwnProperty.call(rest, 'data') && Object.keys(rest).length === 1 ? rest.data : rest;
    }
    return result;
}

/**
 * @param {object} [deps]
 * @param {(channel: string, args: any[]) => Promise<any>} [deps.invokeIpc] 执行已注册的 ipcMain.handle
 * @param {object} [deps.context] 传给 handler 的共享依赖（窗口、桥接函数等）
 * @param {Console} [deps.logger]
 */
function createDesktopApiRegistry({ invokeIpc = null, context = {}, logger = console } = {}) {
    const operations = new Map();

    function define(op) {
        assertOperation(op);
        if (operations.has(op.id)) throw new Error(`[DesktopApi] 接口重复登记：${op.id}`);
        const frozen = Object.freeze({ ...op, params: Object.freeze({ ...(op.params || {}) }) });
        operations.set(op.id, frozen);
        return frozen;
    }

    function defineAll(list) {
        for (const op of list) define(op);
    }

    function canCall(op, caller) {
        return op.access !== 'danger' && op.callers.includes(caller);
    }

    function summarize(op) {
        return {
            id: op.id,
            title: op.title,
            summary: firstSentence(op.description),
            access: op.access,
            params: Object.entries(op.params).map(([name, spec]) => (spec.required ? name : `${name}?`)),
        };
    }

    /**
     * @param {{ caller?: string, prefix?: string, query?: string }} [filter]
     */
    function list({ caller = null, prefix = '', query = '' } = {}) {
        const needle = String(query || '').trim().toLowerCase();
        return [...operations.values()]
            .filter((op) => (caller ? canCall(op, caller) : true))
            .filter((op) => !prefix || op.id === prefix || op.id.startsWith(`${prefix}.`))
            .filter((op) => !needle || `${op.id} ${op.title} ${op.description}`.toLowerCase().includes(needle))
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(summarize);
    }

    function getVisible(id, caller) {
        const op = operations.get(id);
        if (!op || (caller && !canCall(op, caller))) {
            const hint = op ? '当前调用方不能使用这个接口' : '先用目录查询可用接口';
            throw new DesktopApiError(op ? ERROR_CODES.FORBIDDEN : ERROR_CODES.NOT_FOUND, `没有可用的接口 ${id}（${hint}）`);
        }
        return op;
    }

    function describe(id, { caller = null } = {}) {
        const op = getVisible(id, caller);
        return {
            ...summarize(op),
            description: op.description,
            callers: [...op.callers],
            paramsSchema: toJsonSchema(op.params),
            returns: op.returns || null,
            ...(op.example ? { example: op.example } : {}),
        };
    }

    async function run(op, params, meta) {
        if (op.handler) return op.handler(params, { ...context, caller: meta.caller });
        if (typeof invokeIpc !== 'function') throw new DesktopApiError(ERROR_CODES.UNAVAILABLE, 'IPC 调用通道未就绪');
        const args = op.ipc.args ? op.ipc.args(params) : [];
        const data = unwrapEnvelope(await invokeIpc(op.ipc.channel, Array.isArray(args) ? args : [args]));
        return op.ipc.map ? op.ipc.map(data, params) : data;
    }

    /**
     * 不抛错，结果统一成信封，方便跨进程原样传回。
     * @returns {Promise<{ ok: true, id: string, data: any } | { ok: false, id: string, error: { code: string, message: string, field?: string } }>}
     */
    async function call(id, rawParams, { caller } = {}) {
        try {
            if (!CALLERS.includes(caller)) throw new DesktopApiError(ERROR_CODES.FORBIDDEN, `未知调用方 ${caller}`);
            const op = getVisible(String(id || ''), caller);
            const params = validateParams(op.params, rawParams);
            const data = await withTimeout(Promise.resolve().then(() => run(op, params, { caller })), op.timeoutMs || DEFAULT_TIMEOUT_MS, op.id);
            return { ok: true, id: op.id, data: data === undefined ? null : data };
        } catch (error) {
            // handler 可以抛带 code 的普通 Error（取 ERROR_CODES 里的值），其余一律算执行失败
            const known = Object.values(ERROR_CODES);
            const code = error instanceof ParamError ? ERROR_CODES.INVALID_PARAMS
                : (known.includes(error?.code) ? error.code : ERROR_CODES.FAILED);
            if (code === ERROR_CODES.FAILED) logger?.warn?.(`[DesktopApi] ${id} 执行失败:`, error?.message || error);
            const out = { code, message: error?.message || String(error) };
            if (error?.field) out.field = error.field;
            return { ok: false, id: String(id || ''), error: out };
        }
    }

    function has(id) {
        return operations.has(id);
    }

    return Object.freeze({ define, defineAll, list, describe, call, has, size: () => operations.size });
}

module.exports = {
    createDesktopApiRegistry,
    DesktopApiError,
    ERROR_CODES,
    ACCESS_LEVELS,
    CALLERS,
    unwrapEnvelope,
};
