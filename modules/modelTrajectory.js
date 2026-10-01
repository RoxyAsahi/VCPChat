/**
 * modules/modelTrajectory.js
 * 模型调用轨迹的记录器：每一次发给模型的请求（含完整 messages）连同它的流式 / 非流式响应，
 * 整理成一条记录，按话题落盘成 JSONL，供侧栏「调用轨迹」标签查看。
 *
 * 记录结构与取舍参照 ZCode 的 model-io 轨迹
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/services/src/zcode-agent/modelTrajectory.ts）：
 * 一条记录 = 一次模型调用，请求侧是规范化后的消息分段，响应侧是 文本 / 思考过程 / 工具调用 / 结束原因 / token 用量，
 * 读取时只取尾部最近的若干条并标明是否被截断。
 * VCPChat 与 ZCode 不同的地方：
 * - 请求来自渲染进程的 IPC（主聊天）或群聊主进程模块，没有统一的 agent 层，所以由调用方 begin() / chunk() / finish()；
 * - 工具调用写在回答原文里（TOOL_REQUEST 块），不是 OpenAI tool_calls，原文原样记下，由界面解析；
 * - 服务端不一定回报 token 用量，缺失时按字符数粗估并标记 estimated；
 * - 参数递归去除疑似秘密；messages 正文可能含用户主动写入的敏感内容。
 * 文件读写异步、尾部读取有界；解析与编码受预算限制，错误与聊天链路隔离。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { sanitizeParams, readFileTail, fitRecord, atomicWrite, isActiveAtomicTemp } = require('./modelTrajectoryStorage');

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_FIELD_CHARS = 200000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

function truncateText(value, max) {
    const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
    if (text.length <= max) return text;
    return text.slice(0, max);
}

function safeStringify(value, max) {
    try {
        return truncateText(JSON.stringify(sanitizeParams(value)), max);
    } catch (_error) {
        return truncateText(String(value), max);
    }
}

/** 数据 URL 只留类型和大小，不把图片的 base64 写进轨迹。 */
function describeImage(url) {
    const text = typeof url === 'string' ? url : url?.url;
    const match = /^data:([^;,]+)[;,]/i.exec(String(text || ''));
    if (match) return { kind: 'image', mediaType: match[1], bytes: Math.round(String(text).length * 0.75) };
    return { kind: 'image', url: truncateText(text, 500) };
}

/** 一条 OpenAI 风格的消息 → { role, name?, parts: [...] }，和 ZCode 的轨迹消息形状一致。 */
function normalizeMessage(message, maxChars) {
    const role = typeof message?.role === 'string' ? truncateText(message.role, 32) : 'user';
    const parts = [];
    let remaining = maxChars;
    const take = value => { const text = truncateText(value, remaining); remaining -= text.length; return text; };
    const content = message?.content;
    if (typeof content === 'string') {
        if (content) parts.push({ kind: 'text', text: take(content) });
    } else if (Array.isArray(content)) {
        for (const part of content.slice(0, 32)) {
            if (typeof part === 'string') parts.push({ kind: 'text', text: take(part) });
            else if (part?.type === 'text' || typeof part?.text === 'string') parts.push({ kind: 'text', text: take(part.text) });
            else if (part?.type === 'image_url' || part?.image_url) parts.push(describeImage(part.image_url));
            else parts.push({ kind: 'other', raw: take(safeStringify(part, Math.min(2000, remaining))) });
        }
    } else if (content && typeof content === 'object') {
        parts.push({ kind: 'text', text: take(typeof content.text === 'string' ? content.text : safeStringify(content, remaining)) });
    }
    for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls.slice(0, 32) : []) {
        parts.push({
            kind: 'tool-call',
            toolCallId: take(call?.id) || undefined,
            toolName: take(call?.function?.name || call?.name || ''),
            input: take(call?.function?.arguments ?? call?.arguments ?? '')
        });
    }
    if (role === 'tool') {
        const output = parts.filter(part => part.kind === 'text').map(part => part.text).join('\n');
        return { role, parts: [{ kind: 'tool-result', toolCallId: take(message?.tool_call_id) || undefined, toolName: take(message?.name) || undefined, output }] };
    }
    return { role, ...(typeof message?.name === 'string' && message.name ? { name: truncateText(message.name, 500) } : {}), parts };
}

/** 服务端没回报 token 用量时的粗估：中日韩字符按 1 个、其余约 4 个字符 1 个。 */
function estimateTokens(text) {
    const source = String(text || '');
    let cjk = 0;
    for (const char of source) if (/[⺀-鿿豈-﫿＀-￯]/u.test(char)) cjk += 1;
    return Math.ceil(cjk + (source.length - cjk) / 4);
}

function messageText(message) {
    return (message.parts || []).map(part => (part.kind === 'text' ? part.text : part.kind === 'tool-result' ? part.output : part.kind === 'tool-call' ? `${part.toolName}${part.input}` : '')).join('\n');
}

function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const input = Number(raw.prompt_tokens ?? raw.input_tokens);
    const output = Number(raw.completion_tokens ?? raw.output_tokens);
    const total = Number(raw.total_tokens);
    if (![input, output, total].some(Number.isFinite)) return null;
    return {
        inputTokens: Number.isFinite(input) ? input : undefined,
        outputTokens: Number.isFinite(output) ? output : undefined,
        totalTokens: Number.isFinite(total) ? total : (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
    };
}

function legacyFileKey(sessionKey) {
    return String(sessionKey || 'unscoped').replace(/[^\w.\-一-鿿]+/gu, '_').slice(0, 120) || 'unscoped';
}
function sanitizeFileKey(sessionKey) {
    const key = String(sessionKey || 'unscoped');
    return legacyFileKey(key).slice(0, 70) + '--' + crypto.createHash('sha256').update(key).digest('hex');
}

function createModelTrajectoryRecorder({
    rootDir,
    now = () => Date.now(),
    enabled = true,
    retentionDays = 7,
    maxTotalBytes = 64 * 1024 * 1024,
    maxRecords = DEFAULT_MAX_RECORDS,
    maxFieldChars = DEFAULT_MAX_FIELD_CHARS,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES
} = {}) {
    /** @type {Map<string, Map<string, object>>} sessionKey → 进行中的调用 */
    const pending = new Map();
    const listeners = new Set();
    const writeChains = new Map();
    let storageChain = Promise.resolve();
    let counter = 0;
    let queuedBytes = 0;
    let policyGeneration = 0;
    let retentionChain = Promise.resolve();
    const maxAgeMs = Math.max(1, Math.min(30, Number(retentionDays) || 7)) * 86400000;
    maxTotalBytes = Math.max(1024, Math.min(256 * 1024 * 1024, Number(maxTotalBytes) || 64 * 1024 * 1024));
    const errors = new Map();
    const generations = new Map();
    const generationOf = key => generations.get(key) || 0;
    maxFileBytes = Math.min(maxTotalBytes, Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? Math.floor(maxFileBytes) : DEFAULT_MAX_FILE_BYTES);
    maxFieldChars = Math.max(1, Math.min(DEFAULT_MAX_FIELD_CHARS, Math.floor(maxFieldChars) || DEFAULT_MAX_FIELD_CHARS));
    maxRecords = Math.max(1, Math.min(1000, Math.floor(maxRecords) || DEFAULT_MAX_RECORDS));
    const recordBudget = Math.min(maxFileBytes, 1024 * 1024);
    const responseCharBudget = Math.min(maxFieldChars * 2, Math.max(1, Math.floor(recordBudget / 4)));
    const inputCharBudget = Math.min(maxFieldChars, Math.max(1, Math.floor(recordBudget / 8)));

    const fileOf = sessionKey => path.join(rootDir, `${sanitizeFileKey(sessionKey)}.jsonl`);

    function emit(event) {
        for (const listener of [...listeners]) {
            try { listener(event); } catch (_error) { /* 订阅方出错不影响记录 */ }
        }
    }

    function enqueueWrite(sessionKey, task) {
        const file = fileOf(sessionKey);
        const chain = storageChain.then(task).catch(() => {
            errors.set(sessionKey, '轨迹读写失败');
            emit({ sessionKey, id: null, status: 'recording-error' });
        }).finally(() => { if (writeChains.get(file) === chain) writeChains.delete(file); });
        writeChains.set(file, chain);
        storageChain = chain;
        return chain;
    }

    async function readRecordsFromFile(sessionKey) {
        const file = fileOf(sessionKey);
        let tail = await readFileTail(file, maxFileBytes);
        const legacy = !tail.exists;
        if (legacy) tail = await readFileTail(path.join(rootDir, legacyFileKey(sessionKey) + '.jsonl'), maxFileBytes);
        const records = [];let total = 0, droppedRecords = 0, truncated = tail.truncated;
        let batch = 0;
        for (const line of tail.text.split('\n')) {
            if (++batch % 20 === 0) await new Promise(resolve => setImmediate(resolve));
            if (!line.trim()) continue;
            if (Buffer.byteLength(line) > 1024 * 1024) { truncated = true; continue; }
            try {
                const record = JSON.parse(line);
                // 兼容旧文件但按原始 sessionKey 过滤，净化文件名相撞不能串会话。
                if (!record?.id || record.sessionKey !== sessionKey) continue;
                total++;
                const dropped = Number(record.retention?.droppedRecords);
                if (Number.isSafeInteger(dropped) && dropped > 0) droppedRecords = Math.max(droppedRecords, dropped);
                records.push(record);
                if (records.length > maxRecords) records.shift();
            } catch { /* 半行 / 坏行跳过 */ }
        }
        return { records, total: total + droppedRecords, truncated: truncated || droppedRecords > 0 };
    }

    async function persist(sessionKey, record) {
        const recordingGeneration = policyGeneration;
        const generation = generationOf(sessionKey);
        const line = fitRecord(record, recordBudget);
        if (!line) { errors.set(sessionKey, '容量预算不足，无法保留此调用');return; }
        const bytes = Buffer.byteLength(line);
        if (queuedBytes + bytes > 16 * 1024 * 1024) { errors.set(sessionKey, '轨迹写入队列已满');return; }
        queuedBytes += bytes;
        await enqueueWrite(sessionKey, async () => {
            if (!enabled || recordingGeneration !== policyGeneration || generation !== generationOf(sessionKey)) return;
            const file = fileOf(sessionKey);
            await fs.promises.mkdir(rootDir, { recursive: true });
            const stored = await readRecordsFromFile(sessionKey);
            const previous = maxRecords === 1 ? [] : stored.records.slice(-(maxRecords - 1));
            const retained = previous.map(item => fitRecord(item, recordBudget)).filter(Boolean);
            let droppedRecords = stored.total - retained.length;
            let output;
            for (;;) {
                const latest = fitRecord({ ...record, retention: { droppedRecords } }, recordBudget);
                if (!latest) { errors.set(sessionKey,'容量预算不足，无法保留此调用');return; }
                output = [...retained, latest].join('');
                if (Buffer.byteLength(output) <= maxFileBytes) break;
                retained.shift();
                droppedRecords++;
            }
            // 写入前就按字节裁剪，临时文件和最终文件都不会先越界再压缩。
            if (generation !== generationOf(sessionKey)) return;
            await enforceRetention({skipFile: file, reserveBytes: Buffer.byteLength(output)});
            if (!enabled || recordingGeneration !== policyGeneration || generation !== generationOf(sessionKey)) return;
            await atomicWrite(file, output);
            errors.delete(sessionKey);
        }).finally(() => { queuedBytes -= bytes; });
    }

    function snapshotOf(call, status) {
        return {
            id: call.id,
            requestId: call.requestId,
            sessionKey: call.sessionKey,
            startedAt: call.startedAt,
            ...(call.endedAt ? { endedAt: call.endedAt, durationMs: call.endedAt - call.startedAt } : {}),
            status,
            source: call.source,
            model: { modelId: call.modelId, params: call.params },
            request: { messages: call.messages },
            ...(call.truncated ? { truncated: true } : {}),
            response: call.buildResponse(),
            ...(call.error ? { error: call.error } : {})
        };
    }

    function begin({ sessionKey, requestId = null, source = {}, model = '', params = {}, messages = [] } = {}) {
        const noop = { id: null, chunk() {}, finish() {} };
        try {
            if (!enabled) return noop;
            if ([...pending.values()].reduce((sum,calls)=>sum+calls.size,0) >= 128) { errors.set(sessionKey,'正在记录的调用过多'); return noop; }
            let inputLeft = inputCharBudget;
            let inputTruncated = false;
            const sourceMessages = Array.isArray(messages) ? messages : [];
            const selectedMessages = sourceMessages.length > 200 ? [sourceMessages[0], ...sourceMessages.slice(-199)] : sourceMessages;
            const normalized = [];
            for (const message of selectedMessages) {
                if (inputLeft <= 0) break;
                const limit = Math.min(maxFieldChars, inputLeft);
                if ((typeof message?.content === 'string' && message.content.length > limit) || message?.content?.length > 32 && Array.isArray(message.content) || message?.tool_calls?.length > 32) inputTruncated = true;
                const normalizedMessage = normalizeMessage(message, limit);
                for (const part of normalizedMessage.parts) {
                    for (const key of ['text', 'input', 'output', 'raw', 'toolCallId', 'toolName', 'url', 'mediaType']) if (typeof part[key] === 'string') {
                        part[key] = part[key].slice(0, inputLeft);
                        inputLeft -= part[key].length;
                    }
                }
                for (const key of ['role','name']) if (typeof normalizedMessage[key] === 'string') { normalizedMessage[key] = normalizedMessage[key].slice(0,inputLeft); inputLeft -= normalizedMessage[key].length; }
                normalized.push(normalizedMessage);
            }
            counter += 1;
            const call = {
                id: `call_${now().toString(36)}_${counter}`,
                requestId: requestId ? truncateText(requestId, 500) : null,
                sessionKey: sessionKey || 'unscoped',
                startedAt: now(),
                endedAt: 0,
                source: sanitizeParams({ kind: 'main', ...source }),
                modelId: truncateText(model || params?.model || '', 500),
                params: sanitizeParams(params),
                messages: normalized,
                text: '',
                reasoning: '',
                toolCalls: new Map(),
                finishReason: null,
                usage: null,
                responseModel: null,
                error: null,
                done: false,
                retainedChars: 0,
                truncated: inputTruncated || selectedMessages.length !== sourceMessages.length || normalized.length !== selectedMessages.length || inputLeft <= 0
            };
            call.buildResponse = () => {
                const toolCalls = [...call.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => ({
                    kind: 'tool-call', toolCallId: entry.id || undefined, toolName: entry.name, input: entry.args
                }));
                if (!call.text && !call.reasoning && toolCalls.length === 0 && !call.finishReason && !call.usage) return null;
                return {
                    text: truncateText(call.text, maxFieldChars),
                    reasoningText: truncateText(call.reasoning, maxFieldChars),
                    toolCalls,
                    finishReason: call.finishReason || undefined,
                    usage: call.usage || undefined,
                    modelId: call.responseModel || undefined
                };
            };
            if (!pending.has(call.sessionKey)) pending.set(call.sessionKey, new Map());
            pending.get(call.sessionKey).set(call.id, call);
            emit({ sessionKey: call.sessionKey, id: call.id, status: 'running' });

            const retain = (value, previous = '') => {
                if (typeof value !== 'string') return previous;
                const room = Math.max(0, Math.min(maxFieldChars - previous.length, responseCharBudget - call.retainedChars));
                const kept = value.slice(0, room);
                call.retainedChars += kept.length;
                if (kept.length !== value.length) call.truncated = true;
                return previous + kept;
            };
            const addToolDelta = (delta, fallbackIndex) => {
                const index = Number.isInteger(delta?.index) ? delta.index : fallbackIndex;
                if (!call.toolCalls.has(index) && call.toolCalls.size >= 32) { call.truncated = true; return; }
                const entry = call.toolCalls.get(index) || { id: '', name: '', args: '' };
                if (typeof delta?.id === 'string') { call.retainedChars -= entry.id.length; entry.id = retain(delta.id); }
                const fn = delta?.function || {};
                if (typeof fn.name === 'string') entry.name = retain(fn.name, entry.name);
                if (typeof fn.arguments === 'string') entry.args = retain(fn.arguments, entry.args);
                call.toolCalls.set(index, entry);
            };

            const handle = {
                id: call.id,
                /** 一个已解析的 SSE 数据块（OpenAI chat.completion.chunk）。 */
                chunk(parsed) {
                    try {
                        if (call.done || !parsed || typeof parsed !== 'object' || parsed.error === 'json_parse_error') return;
                        if (parsed.choices?.[0]?.delta?.tool_calls?.length > 32) call.truncated = true;
                        if (typeof parsed.model === 'string') call.responseModel = truncateText(parsed.model, 500);
                        const choice = parsed.choices?.[0];
                        const delta = choice?.delta ?? parsed.delta ?? null;
                        if (delta) {
                            if (typeof delta.content === 'string') call.text = retain(delta.content, call.text);
                            const reasoning = delta.reasoning_content ?? delta.reasoning;
                            if (typeof reasoning === 'string') call.reasoning = retain(reasoning, call.reasoning);
                            (Array.isArray(delta.tool_calls) ? delta.tool_calls.slice(0, 32) : []).forEach((toolCall, i) => addToolDelta(toolCall, i));
                        }
                        if (choice?.finish_reason) call.finishReason = truncateText(choice.finish_reason, 100);
                        const usage = normalizeUsage(parsed.usage);
                        if (usage) call.usage = usage;
                    } catch (_error) { /* 记录失败不影响聊天 */ }
                },
                /** 结束一次调用；response 是非流式的完整响应体，error 为 {name, message, stack?}，aborted 表示被用户中止。 */
                finish({ response = null, error = null, aborted = false } = {}) {
                    try {
                        if (call.done) return;
                        call.done = true;
                        call.endedAt = now();
                        if (response && typeof response === 'object') {
                            call.text = ''; call.reasoning = ''; call.toolCalls.clear(); call.retainedChars = 0;
                            const choice = response.choices?.[0];
                            const message = choice?.message ?? {};
                            if (message.content?.length > 32 && Array.isArray(message.content) || message.tool_calls?.length > 32) call.truncated = true;
                            if (typeof response.model === 'string') call.responseModel = truncateText(response.model, 500);
                            if (typeof message.content === 'string') call.text = retain(message.content);
                            else if (Array.isArray(message.content)) for (const part of message.content.slice(0, 32)) call.text = retain(typeof part === 'string' ? part : part?.text || '', call.text);
                            const reasoning = message.reasoning_content ?? message.reasoning;
                            if (typeof reasoning === 'string') call.reasoning = retain(reasoning);
                            (Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 32) : []).forEach((toolCall, i) => addToolDelta(toolCall, i));
                            if (choice?.finish_reason) call.finishReason = choice.finish_reason;
                            const usage = normalizeUsage(response.usage);
                            if (usage) call.usage = usage;
                        }
                        if (error) {
                            call.error = {
                                name: String(error.name || 'Error'),
                                message: truncateText(error.message ?? error, 2000),
                                ...(error.stack ? { stack: truncateText(error.stack, 4000) } : {})
                            };
                        }
                        if (!call.usage && (call.text || call.reasoning || call.toolCalls.size > 0)) {
                            const inputTokens = call.messages.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0);
                            const outputTokens = estimateTokens(call.text + call.reasoning + [...call.toolCalls.values()].map(entry=>entry.name+entry.args).join(''));
                            call.usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
                        }
                        const status = aborted ? 'aborted' : error ? 'error' : 'completed';
                        const record = snapshotOf(call, status);
                        pending.get(call.sessionKey)?.delete(call.id);
                        if (pending.get(call.sessionKey)?.size === 0) pending.delete(call.sessionKey);
                        emit({ sessionKey: call.sessionKey, id: call.id, status });
                        void persist(call.sessionKey, record);
                    } catch (_error) { /* 记录失败不影响聊天 */ }
                }
            };
            return handle;
        } catch (_error) {
            return noop;
        }
    }

    /** 某话题最近的调用（落盘的 + 进行中的），按开始时间从旧到新；truncated 表示还有更早的没返回。 */
    async function list(sessionKey, { limit = DEFAULT_MAX_RECORDS } = {}) {
        const cap = Math.max(1, Math.min(maxRecords, Math.floor(Number(limit)) || maxRecords));
        await (writeChains.get(fileOf(sessionKey)) || Promise.resolve());
        await enforceRetention();
        let stored;
        try { stored = await readRecordsFromFile(sessionKey); } catch { return { records: [], truncated: false, total: 0, error: '轨迹读取失败' }; }
        const running = [...(pending.get(sessionKey)?.values() || [])].map(call => snapshotOf(call, 'running'));
        const all = [...stored.records, ...running].sort((a, b) => a.startedAt - b.startedAt);
        return { records: all.slice(-cap), truncated: stored.truncated || stored.total + running.length > cap, total: stored.total + running.length, ...(errors.has(sessionKey) ? { error: errors.get(sessionKey) } : {}) };
    }

    async function clear(sessionKey) {
        // Invalidate handles and queued snapshots at invocation, before waiting for IO.
        generations.set(sessionKey, generationOf(sessionKey) + 1);
        for (const call of pending.get(sessionKey)?.values() || []) call.done = true;
        pending.delete(sessionKey);
        await enqueueWrite(sessionKey, async () => {
            await fs.promises.mkdir(rootDir, { recursive: true });
            // 空的哈希文件是已清空标记，重启后不能再回退读出旧格式日志。
            await atomicWrite(fileOf(sessionKey), '');
            await purgeOrphanTemps(sessionKey);
            errors.delete(sessionKey);
        });
        if (errors.has(sessionKey)) throw new Error(errors.get(sessionKey));
        emit({ sessionKey, id: null, status: 'cleared' });
    }

    async function purgeOrphanTemps(sessionKey = null) {
        let names;
        try { names = await fs.promises.readdir(rootDir); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        const sessionPrefix = sessionKey === null ? null : path.basename(fileOf(sessionKey)) + '.tmp-';
        for (const name of names) {
            const recordTemp = /^[\w.\-一-鿿]+--[a-f0-9]{64}\.jsonl\.tmp-[a-f0-9]{16}$/u.test(name);
            const policyTemp = /^record-policy\.json\.tmp-[a-f0-9]{16}$/.test(name);
            if (!(recordTemp || policyTemp) || (sessionPrefix && !name.startsWith(sessionPrefix))) continue;
            const file = path.join(rootDir, name);
            if (isActiveAtomicTemp(file)) continue;
            let stat;
            try { stat = await fs.promises.lstat(file); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (stat.isFile() && !stat.isSymbolicLink()) await fs.promises.rm(file, {force:true});
        }
    }

    async function enforceRetention({skipFile = null, reserveBytes = 0} = {}) {
        // Serialize cleanup with other cleanup jobs; only recorder-owned JSONL files are eligible.
        const task = retentionChain.then(async () => {
            await purgeOrphanTemps();
            let names;
            try { names = await fs.promises.readdir(rootDir); } catch (error) { if (error.code === 'ENOENT') return;throw error; }
            const files = [];
            for (const name of names) {
                if (!/^[\w.\-一-鿿]+\.jsonl$/u.test(name)) continue;
                const file = path.join(rootDir, name);
                let stat;try { stat = await fs.promises.lstat(file); } catch (error) { if (error.code === 'ENOENT') continue;throw error; }
                if (!stat.isFile() || stat.isSymbolicLink() || file === skipFile) continue;
                // Empty hashed logs are durable clear markers; expiration must not resurrect legacy records.
                if (stat.size === 0 && /--[a-f0-9]{64}\.jsonl$/.test(name)) continue;
                files.push({ file, size: stat.size, modified: stat.mtimeMs });
            }
            files.sort((a,b) => b.modified - a.modified);
            let bytes = reserveBytes;
            for (const file of files) {
                bytes += file.size;
                if (now() - file.modified > maxAgeMs || bytes > maxTotalBytes) {
                    await fs.promises.rm(file.file, {force:true});bytes -= file.size;
                }
            }
        });
        retentionChain = task.catch(() => {});
        return task;
    }

    function setEnabled(value) {
        enabled = value === true;
        policyGeneration++;
        if (!enabled) {
            for (const calls of pending.values()) for (const call of calls.values()) call.done = true;
            pending.clear();
        }
        emit({sessionKey: null, id: null, status: 'policy-changed'});
    }

    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    return { begin, list, clear, subscribe, setEnabled, enforceRetention, getPolicy: () => ({enabled, retentionDays: maxAgeMs / 86400000, maxTotalBytes}), getDirectory: () => rootDir, fileOf };
}

/** 话题的轨迹键：群聊按 群组 + 话题，单聊按 Agent + 话题；上下文不全时归到 unscoped。 */
function sessionKeyFromContext(context) {
    const owner = context?.groupId || context?.agentId;
    const topic = context?.topicId;
    return owner && topic ? `${owner}__${topic}` : 'unscoped';
}

function sourceFromContext(context, kind) {
    const group = Boolean(context?.isGroupMessage || context?.groupId);
    return {
        kind: kind || (group ? 'group' : 'main'),
        ...(context?.agentId ? { agentId: String(context.agentId) } : {}),
        ...(context?.agentName ? { agentName: String(context.agentName) } : {}),
        ...(context?.groupId ? { groupId: String(context.groupId) } : {}),
        ...(context?.topicId ? { topicId: String(context.topicId) } : {})
    };
}

const NOOP_CALL = Object.freeze({ id: null, chunk() {}, finish() {} });
let sharedRecorder = null;

/** 主进程启动时配置一次；聊天链路上的各处用 beginTrajectoryCall()，没配置（如单元测试）时是空操作。 */
function configureSharedRecorder(options) {
    sharedRecorder = createModelTrajectoryRecorder(options);
    return sharedRecorder;
}

function getSharedRecorder() {
    return sharedRecorder;
}

function beginTrajectoryCall(args) {
    try {
        return sharedRecorder && args ? sharedRecorder.begin(args) : NOOP_CALL;
    } catch (_error) {
        return NOOP_CALL;
    }
}

module.exports = {
    createModelTrajectoryRecorder,
    configureSharedRecorder,
    getSharedRecorder,
    beginTrajectoryCall,
    sessionKeyFromContext,
    sourceFromContext,
    normalizeMessage,
    estimateTokens,
    sanitizeFileKey
};
