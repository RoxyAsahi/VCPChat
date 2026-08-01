'use strict';

// VChat-owned compatibility boundary for an unchanged VCPToolBox.  Codex
// speaks OpenAI Responses; ToolBox's stable public model endpoint speaks Chat
// Completions.  This adapter is intentionally loopback-only and handles only
// that protocol conversion.  It does not execute tools, inspect ToolBox
// catalogues, or infer tool identities.

const crypto = require('crypto');
const http = require('http');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const VCP_DYNAMIC_TOOL_NAME = 'vcp_invoke';

class ToolboxResponsesAdapter {
    constructor(options = {}) {
        this.toolboxUrl = normalizeToolboxChatUrl(options.toolboxUrl);
        this.toolboxApiKey = String(options.toolboxApiKey || '');
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.server = null;
        this.port = null;
        // This unguessable path capability is process-local and is never the
        // ToolBox API key.  It prevents unrelated local processes from using
        // the adapter merely because it is bound to loopback.
        this.capability = options.capability || crypto.randomBytes(32).toString('hex');
    }

    get baseUrl() {
        if (!this.port) return null;
        return `http://127.0.0.1:${this.port}/v1/${this.capability}`;
    }

    async start() {
        if (this.server) return this.baseUrl;
        if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable for ToolBox Responses adapter');
        this.server = http.createServer((request, response) => {
            void this._handle(request, response);
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.server.off('error', reject);
                this.port = this.server.address().port;
                resolve();
            });
        });
        return this.baseUrl;
    }

    async stop() {
        const server = this.server;
        this.server = null;
        this.port = null;
        if (!server) return;
        await new Promise((resolve) => server.close(() => resolve()));
    }

    // Keep the loopback listener and its unguessable capability stable while
    // Main applies new ToolBox settings.  Codex therefore never needs the
    // upstream URL or key, and an in-flight Workbench does not accidentally
    // retain a second local provider endpoint after settings change.
    reconfigure(options = {}) {
        const nextUrl = normalizeToolboxChatUrl(options.toolboxUrl);
        const nextKey = String(options.toolboxApiKey || '');
        if (!nextKey.trim()) throw new Error('VCPToolBox API key is required');
        this.toolboxUrl = nextUrl;
        this.toolboxApiKey = nextKey;
        return this.baseUrl;
    }

    async _handle(request, response) {
        if (request.method !== 'POST' || request.url !== `/v1/${this.capability}/responses`) {
            response.writeHead(404).end();
            return;
        }
        let body;
        try {
            body = await readJsonBody(request);
        } catch (error) {
            writeJson(response, error.code === 'BODY_TOO_LARGE' ? 413 : 400, {
                error: { code: error.code || 'invalid_request', message: error.message },
            });
            return;
        }
        let chatRequest;
        try {
            chatRequest = responsesRequestToChat(body);
        } catch (error) {
            writeJson(response, 400, { error: { code: 'invalid_request', message: error.message } });
            return;
        }

        let upstream;
        try {
            upstream = await this.fetchImpl(this.toolboxUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.toolboxApiKey}`,
                },
                body: JSON.stringify(chatRequest),
            });
        } catch (_error) {
            writeJson(response, 502, { error: { code: 'toolbox_unavailable', message: 'ToolBox model endpoint is unavailable' } });
            return;
        }
        if (!upstream.ok) {
            const details = await readLimitedText(upstream, MAX_ERROR_BYTES);
            writeJson(response, upstream.status, {
                error: { code: 'toolbox_error', message: `ToolBox model endpoint returned ${upstream.status}`, details },
            });
            return;
        }
        if (chatRequest.stream) {
            await relayChatStreamAsResponses(upstream, response, body.model || chatRequest.model);
            return;
        }
        let chatResponse;
        try {
            chatResponse = await upstream.json();
        } catch (_error) {
            writeJson(response, 502, { error: { code: 'invalid_toolbox_response', message: 'ToolBox returned invalid JSON' } });
            return;
        }
        writeJson(response, 200, chatResponseToResponses(chatResponse, body.model || chatRequest.model));
    }
}

function normalizeToolboxChatUrl(value) {
    const url = new URL(String(value || ''));
    url.pathname = '/v1/chat/completions';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function responsesRequestToChat(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Responses request body must be an object');
    const model = String(body.model || '').trim();
    if (!model) throw new Error('Responses request model is required');
    const messages = [];
    const instructions = normalizeText(body.instructions);
    if (instructions) messages.push({ role: 'system', content: instructions });
    for (const item of normalizeResponsesInput(body.input)) {
        if (item.type === 'function_call') {
            if (!item.callId || !item.name) throw new Error('function_call requires call_id and name');
            messages.push({
                role: 'assistant', content: null,
                tool_calls: [{ id: item.callId, type: 'function', function: { name: item.name, arguments: item.arguments } }],
            });
        } else if (item.type === 'function_call_output') {
            if (!item.callId) throw new Error('function_call_output requires call_id');
            messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
        } else {
            messages.push({ role: item.role, content: item.content });
        }
    }
    const chat = { model, messages, stream: body.stream === true };
    const tools = responsesToolsToChat(body.tools);
    if (tools.length > 0) chat.tools = tools;
    if (body.tool_choice != null) chat.tool_choice = body.tool_choice;
    if (Number.isFinite(body.temperature)) chat.temperature = body.temperature;
    if (Number.isFinite(body.max_output_tokens)) chat.max_tokens = body.max_output_tokens;
    return chat;
}

function normalizeResponsesInput(input) {
    const items = typeof input === 'string'
        ? [{ type: 'message', role: 'user', content: input }]
        : Array.isArray(input) ? input : input ? [input] : [];
    return items.map((item) => {
        if (!item || typeof item !== 'object') throw new Error('Responses input item must be an object');
        if (item.type === 'function_call') return {
            type: 'function_call', callId: String(item.call_id || item.id || ''), name: String(item.name || ''),
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
        };
        if (item.type === 'function_call_output') return {
            type: 'function_call_output', callId: String(item.call_id || item.callId || ''), output: normalizeText(item.output || item.content),
        };
        const role = ['system', 'developer', 'user', 'assistant'].includes(item.role) ? item.role : 'user';
        return { type: 'message', role, content: normalizeChatContent(item.content || item.input || item.output) };
    });
}

function normalizeChatContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return normalizeText(content);
    const parts = [];
    for (const part of content) {
        if (typeof part === 'string') { parts.push({ type: 'text', text: part }); continue; }
        if (!part || typeof part !== 'object') continue;
        const text = normalizeText(part.text || part.input_text || part.output_text);
        if (text) { parts.push({ type: 'text', text }); continue; }
        const imageUrl = part.image_url?.url || part.image_url || part.url;
        if ((part.type === 'input_image' || part.type === 'image_url') && typeof imageUrl === 'string') {
            parts.push({ type: 'image_url', image_url: { url: imageUrl } });
        }
    }
    return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

function normalizeText(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return value == null ? '' : String(value);
    return value.map((part) => typeof part === 'string' ? part : part?.text || part?.input_text || part?.output_text || '').join('');
}

function responsesToolsToChat(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool) => {
        if (!tool || tool.type !== 'function') return [];
        const name = String(tool.name || '').trim();
        // Codex may include its native shell/MCP/utility definitions even
        // when a particular installed App Server does not honor every
        // thread-scoped tool override.  This loopback provider boundary is
        // authoritative for Nova: ToolBox and the model see only vcp_invoke.
        if (name !== VCP_DYNAMIC_TOOL_NAME) return [];
        return [{ type: 'function', function: {
            name,
            ...(tool.description ? { description: String(tool.description) } : {}),
            parameters: tool.parameters || tool.input_schema || { type: 'object', additionalProperties: true },
        } }];
    });
}

function chatResponseToResponses(chatResponse, fallbackModel) {
    const message = chatResponse?.choices?.[0]?.message || {};
    const output = responseOutputItems(message);
    return {
        id: chatResponse?.id || `resp_${crypto.randomUUID()}`,
        object: 'response', created_at: chatResponse?.created || Math.floor(Date.now() / 1000), status: 'completed',
        model: chatResponse?.model || fallbackModel || null, output,
        output_text: normalizeText(message.content), usage: responsesUsage(chatResponse?.usage),
    };
}

function responseOutputItems(message) {
    const output = [];
    const text = normalizeText(message?.content);
    if (text) output.push({ id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
    for (const [index, call] of (Array.isArray(message?.tool_calls) ? message.tool_calls : []).entries()) {
        const name = String(call?.function?.name || '').trim();
        if (!name) continue;
        output.push({
            id: `fc_${call?.id || index}`, type: 'function_call', call_id: String(call?.id || `call_${index}`), name,
            arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call?.function?.arguments || {}),
        });
    }
    return output;
}

function responsesUsage(usage) {
    return {
        input_tokens: Number(usage?.prompt_tokens || 0), output_tokens: Number(usage?.completion_tokens || 0),
        total_tokens: Number(usage?.total_tokens || 0),
    };
}

async function relayChatStreamAsResponses(upstream, response, model) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const state = new ResponsesStreamState(model);
    writeSse(response, 'response.created', { type: 'response.created', response: state.payload('in_progress') });
    let buffer = '';
    for await (const chunk of upstream.body) {
        buffer += Buffer.from(chunk).toString('utf8');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            if (data === '[DONE]') continue;
            if (data) {
                try { state.accept(JSON.parse(data), response); } catch (_error) { /* malformed upstream chunk is ignored until terminal error */ }
            }
            boundary = buffer.indexOf('\n\n');
        }
    }
    state.finish(response);
    response.end();
}

class ResponsesStreamState {
    constructor(model) {
        this.id = `resp_${crypto.randomUUID()}`;
        this.model = model || null;
        this.text = '';
        this.textItem = null;
        this.calls = new Map();
        this.usage = null;
    }
    payload(status) { return { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: this.model, output: this.output(), output_text: this.text, usage: responsesUsage(this.usage) }; }
    output() {
        const output = this.textItem ? [{ ...this.textItem, content: [{ ...this.textItem.content[0], text: this.text }] }] : [];
        for (const call of this.calls.values()) if (call.name) output.push(call.item());
        return output;
    }
    ensureText(response) {
        if (this.textItem) return;
        this.textItem = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] };
        writeSse(response, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...this.textItem, content: [] } });
        writeSse(response, 'response.content_part.added', { type: 'response.content_part.added', item_id: this.textItem.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
    }
    accept(event, response) {
        const choice = event?.choices?.[0] || {};
        const delta = choice.delta || choice.message || {};
        if (typeof delta.content === 'string' && delta.content) {
            this.ensureText(response); this.text += delta.content;
            writeSse(response, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: this.textItem.id, output_index: 0, content_index: 0, delta: delta.content });
        }
        for (const [fallback, callDelta] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
            const key = String(callDelta.index ?? callDelta.id ?? fallback);
            const call = this.calls.get(key) || new PendingCall(String(callDelta.id || `call_${key}`));
            if (callDelta.id) call.id = String(callDelta.id);
            if (typeof callDelta.function?.name === 'string') call.name = callDelta.function.name;
            if (typeof callDelta.function?.arguments === 'string') call.arguments += callDelta.function.arguments;
            this.calls.set(key, call);
        }
        if (event?.usage) this.usage = event.usage;
    }
    finish(response) {
        if (this.textItem) {
            writeSse(response, 'response.output_text.done', { type: 'response.output_text.done', item_id: this.textItem.id, output_index: 0, content_index: 0, text: this.text });
            writeSse(response, 'response.content_part.done', { type: 'response.content_part.done', item_id: this.textItem.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: this.text } });
            writeSse(response, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: this.output()[0] });
        }
        let index = this.textItem ? 1 : 0;
        for (const call of this.calls.values()) if (call.name) {
            const item = call.item();
            writeSse(response, 'response.output_item.added', { type: 'response.output_item.added', output_index: index, item });
            writeSse(response, 'response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
            index += 1;
        }
        writeSse(response, 'response.completed', { type: 'response.completed', response: this.payload('completed') });
    }
}

class PendingCall {
    constructor(id) { this.id = id; this.name = ''; this.arguments = ''; }
    item() { return { id: `fc_${this.id}`, type: 'function_call', call_id: this.id, name: this.name, arguments: this.arguments || '{}' }; }
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let bytes = 0; const chunks = [];
        request.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) { const error = new Error('request body exceeds 2 MiB'); error.code = 'BODY_TOO_LARGE'; reject(error); request.destroy(); return; }
            chunks.push(chunk);
        });
        request.once('error', reject);
        request.once('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_error) { reject(new Error('request body must be JSON')); } });
    });
}

async function readLimitedText(response, limit) {
    const text = await response.text().catch(() => '');
    return String(text).slice(0, limit);
}
function writeJson(response, status, payload) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload)); }
function writeSse(response, event, payload) { response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); }

module.exports = { ToolboxResponsesAdapter, responsesRequestToChat, chatResponseToResponses, normalizeToolboxChatUrl };
