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
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const CANCELLED_TURN_TTL_MS = 5 * 60 * 1000;
const VCP_DYNAMIC_TOOL_NAME = 'vcp_invoke';

class ToolboxResponsesAdapter {
    constructor(options = {}) {
        this.toolboxUrl = normalizeToolboxChatUrl(options.toolboxUrl);
        this.toolboxApiKey = String(options.toolboxApiKey || '');
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        // Diagnostics are metadata-only: never expose prompt text, ToolBox
        // credentials, tool arguments, or attachment paths to the caller.
        this.onRequest = typeof options.onRequest === 'function' ? options.onRequest : null;
        // ToolBox-only Threads must not trust instruction-shaped text emitted
        // by Codex itself. Resolve the frozen VChat Agent identity from Main's
        // Thread projection and inject only that value upstream.
        this.resolveInstructions = typeof options.resolveInstructions === 'function'
            ? options.resolveInstructions
            : (typeof options.resolveBaseInstructions === 'function'
                ? (identity) => ({ mode: 'vchat-identity', baseInstructions: options.resolveBaseInstructions(identity) })
                : null);
        this.server = null;
        this.port = null;
        // VChat-only, process-memory correlation. The Codex-provided turn
        // metadata header makes this exact; it is never persisted or exposed
        // to the Renderer.
        this.activeRequests = new Map();
        this.cancelledTurnIds = new Map();
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
            // ToolBox owns the active-request table used by `/v1/interrupt`
            // and transport-disconnect cleanup.  A Responses request has no
            // compatible VCP request id, so create one at this boundary for
            // every HTTP request.  Never leave this blank: otherwise two
            // simultaneous Codex Threads collapse onto ToolBox's undefined
            // active-request key and an interrupt for A can affect B.
            const requestId = `vcp_codex_${crypto.randomUUID()}`;
            const identity = responseRequestIdentity(body, requestId, request.headers);
            const trustedInstructions = this.resolveInstructions
                ? this.resolveInstructions(identity) : undefined;
            chatRequest = responsesRequestToChat(body, requestId, {
                stripEmbeddedInstructions: Boolean(this.resolveInstructions),
                trustedInstructions,
            });
            this.onRequest?.(identity);
        } catch (error) {
            writeJson(response, 400, { error: { code: 'invalid_request', message: error.message } });
            return;
        }

        // `turn/interrupt` is delivered by Codex by closing its loopback
        // Responses stream.  Propagate that cancellation to ToolBox with the
        // exact body requestId we registered above; merely aborting fetch is
        // insufficient because ToolBox otherwise keeps the upstream model
        // request alive and can starve independent Threads.
        const upstreamAbort = new AbortController();
        const requestIdentity = responseRequestIdentity(body, chatRequest.requestId, request.headers);
        const activeRequest = {
            ...requestIdentity,
            abortController: upstreamAbort,
            interrupted: false,
        };
        this.activeRequests.set(chatRequest.requestId, activeRequest);
        let clientDetached = false;
        const onClientDetached = () => {
            if (clientDetached || response.writableEnded) return;
            clientDetached = true;
            void this._interruptActiveRequest(activeRequest);
        };
        request.once('aborted', onClientDetached);
        response.once('close', onClientDetached);
        const cleanupClientDetached = () => {
            request.off('aborted', onClientDetached);
            response.off('close', onClientDetached);
            this.activeRequests.delete(chatRequest.requestId);
        };

        // A Codex turn can be interrupted after `turn/started` but before its
        // provider request reaches this loopback server. Retain a bounded,
        // process-only tombstone so that late request cannot revive a
        // cancelled turn and monopolize ToolBox ahead of another Thread.
        if (this._isTurnCancelled(activeRequest.turnId)) {
            void this._interruptActiveRequest(activeRequest);
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
                signal: upstreamAbort.signal,
            });
        } catch (_error) {
            if (!response.destroyed && !response.writableEnded) {
                writeJson(response, clientDetached
                    ? 499
                    : 502, { error: { code: clientDetached ? 'request_interrupted' : 'toolbox_unavailable', message: clientDetached ? 'ToolBox request was interrupted' : 'ToolBox model endpoint is unavailable' } });
            }
            cleanupClientDetached();
            return;
        }
        if (!upstream.ok) {
            const details = await readLimitedText(upstream, MAX_ERROR_BYTES);
            writeJson(response, upstream.status, {
                error: { code: 'toolbox_error', message: `ToolBox model endpoint returned ${upstream.status}`, details },
            });
            cleanupClientDetached();
            return;
        }
        if (chatRequest.stream) {
            try {
                await relayChatStreamAsResponses(upstream, response, body.model || chatRequest.model);
            } finally {
                cleanupClientDetached();
            }
            return;
        }
        let chatResponse;
        try {
            chatResponse = await upstream.json();
        } catch (_error) {
            writeJson(response, 502, { error: { code: 'invalid_toolbox_response', message: 'ToolBox returned invalid JSON' } });
            cleanupClientDetached();
            return;
        }
        writeJson(response, 200, chatResponseToResponses(chatResponse, body.model || chatRequest.model));
        cleanupClientDetached();
    }

    async _interruptToolboxRequest(requestId) {
        const id = String(requestId || '').trim();
        if (!id || !this.toolboxApiKey) return false;
        try {
            const endpoint = new URL('/v1/interrupt', this.toolboxUrl).toString();
            const response = await this.fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.toolboxApiKey}`,
                },
                body: JSON.stringify({ requestId: id }),
            });
            // `not found` is safe: the model request may have completed in
            // the close/finish race. All other failures remain best-effort
            // diagnostics rather than changing a closed client response.
            return response.ok || response.status === 404;
        } catch (_error) {
            return false;
        }
    }

    async interruptForTurn({ threadId, turnId } = {}) {
        const expectedThreadId = String(threadId || '').trim();
        const expectedTurnId = String(turnId || '').trim();
        // App Server emits the globally-unique turn_id but
        // not thread_id on its HTTP Responses metadata header. A turn id is
        // therefore the mandatory correlation key; a thread id is an extra
        // guard whenever a future server supplies it.
        if (!expectedTurnId) return 0;
        const matches = [...this.activeRequests.values()]
            .filter((request) => request.turnId === expectedTurnId
                && (!expectedThreadId || !request.threadId || request.threadId === expectedThreadId));
        await Promise.all(matches.map((request) => this._interruptActiveRequest(request)));
        return matches.length;
    }

    async cancelTurn({ threadId, turnId } = {}) {
        const expectedTurnId = String(turnId || '').trim();
        if (!expectedTurnId) return 0;
        this._pruneCancelledTurns();
        this.cancelledTurnIds.set(expectedTurnId, Date.now() + CANCELLED_TURN_TTL_MS);
        return this.interruptForTurn({ threadId, turnId: expectedTurnId });
    }

    async _interruptActiveRequest(request) {
        if (!request || request.interrupted) return false;
        request.interrupted = true;
        request.abortController?.abort();
        return this._interruptToolboxRequest(request.requestId);
    }

    _isTurnCancelled(turnId) {
        this._pruneCancelledTurns();
        return Boolean(turnId && this.cancelledTurnIds.has(turnId));
    }

    _pruneCancelledTurns() {
        const now = Date.now();
        for (const [turnId, expiresAt] of this.cancelledTurnIds) {
            if (expiresAt <= now) this.cancelledTurnIds.delete(turnId);
        }
    }
}

function normalizeToolboxChatUrl(value) {
    const url = new URL(String(value || ''));
    url.pathname = '/v1/chat/completions';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function responsesRequestToChat(body, requestId = null, options = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Responses request body must be an object');
    const model = String(body.model || '').trim();
    if (!model) throw new Error('Responses request model is required');
    const messages = [];
    const trusted = options.trustedInstructions && typeof options.trustedInstructions === 'object'
        ? options.trustedInstructions : null;
    const instructions = options.stripEmbeddedInstructions
        ? (trusted?.mode === 'codex-managed'
            ? boundedInstructionText(body.instructions)
            : boundedInstructionText(trusted?.baseInstructions ?? options.trustedBaseInstructions))
        : boundedInstructionText(body.instructions);
    if (instructions) messages.push({ role: 'system', content: instructions });
    if (options.stripEmbeddedInstructions && trusted?.mode === 'codex-managed'
        && boundedInstructionText(trusted.developerInstructions)) {
        messages.push({ role: 'developer', content: boundedInstructionText(trusted.developerInstructions) });
    }
    const declaredCallIds = new Set();
    const completedCallIds = new Set();
    const embeddedTools = [];
    let pendingReasoning = '';
    let pendingAssistantContent = null;
    let pendingToolCalls = [];
    const flushAssistant = () => {
        if (pendingAssistantContent == null && pendingToolCalls.length === 0 && !pendingReasoning) return;
        const assistant = {
            role: 'assistant',
            content: pendingAssistantContent == null ? null : pendingAssistantContent,
        };
        // Reasoning-capable Chat providers commonly require the public
        // reasoning_content from the tool-calling response to be replayed on
        // the assistant history message. DeepSeek/Console Go rejects the tool
        // continuation with invalid_request_error when the field is absent.
        if (pendingReasoning || (pendingToolCalls.length > 0 && requiresReasoningContentForToolHistory(model))) {
            assistant.reasoning_content = pendingReasoning;
        }
        if (pendingToolCalls.length > 0) assistant.tool_calls = pendingToolCalls;
        messages.push(assistant);
        pendingReasoning = '';
        pendingAssistantContent = null;
        pendingToolCalls = [];
    };
    for (const item of normalizeResponsesInput(body.input)) {
        if (item.type === 'additional_tools') {
            embeddedTools.push(...item.tools);
            continue;
        }
        if (options.stripEmbeddedInstructions && (item.role === 'system' || item.role === 'developer')) continue;
        if (item.type === 'reasoning') {
            if (pendingToolCalls.length > 0) flushAssistant();
            pendingReasoning += item.content;
        } else if (item.type === 'function_call') {
            if (!item.callId || !item.name) throw new Error('function_call requires call_id and name');
            if (declaredCallIds.has(item.callId)) throw new Error(`duplicate function_call call_id: ${item.callId}`);
            declaredCallIds.add(item.callId);
            // Responses represents parallel calls as adjacent output Items.
            // Chat Completions requires those calls on one assistant message;
            // emitting one assistant message per call makes the following tool
            // results invalid for strict providers such as Console Go.
            pendingToolCalls.push({
                id: item.callId,
                type: 'function',
                function: { name: item.name, arguments: item.arguments },
            });
        } else if (item.type === 'function_call_output') {
            flushAssistant();
            if (!item.callId) throw new Error('function_call_output requires call_id');
            if (!declaredCallIds.has(item.callId)) throw new Error(`function_call_output has no matching function_call: ${item.callId}`);
            if (completedCallIds.has(item.callId)) throw new Error(`duplicate function_call_output call_id: ${item.callId}`);
            completedCallIds.add(item.callId);
            messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
        } else if (item.role === 'assistant') {
            if (pendingAssistantContent != null || pendingToolCalls.length > 0) flushAssistant();
            pendingAssistantContent = item.content;
        } else {
            flushAssistant();
            messages.push({ role: item.role, content: item.content });
        }
    }
    flushAssistant();
    const chat = { model, messages, stream: body.stream === true };
    const stableRequestId = String(requestId || body.requestId || body.messageId || '').trim();
    if (stableRequestId) chat.requestId = stableRequestId;
    const tools = responsesToolsToChat([
        ...(Array.isArray(body.tools) ? body.tools : []),
        ...embeddedTools,
    ]);
    if (options.stripEmbeddedInstructions && tools.length === 0) tools.push(vcpInvokeChatTool());
    if (tools.length > 0) chat.tools = tools;
    if (body.tool_choice != null) chat.tool_choice = body.tool_choice;
    if (Number.isFinite(body.temperature)) chat.temperature = body.temperature;
    if (Number.isFinite(body.max_output_tokens)) chat.max_tokens = body.max_output_tokens;
    const effort = normalizeText(body.reasoning?.effort || body.reasoning_effort);
    if (effort) chat.reasoning_effort = effort;
    return chat;
}

function responseRequestIdentity(body, requestId, headers = {}) {
    const input = typeof body?.input === 'string' ? [] : Array.isArray(body?.input) ? body.input : body?.input ? [body.input] : [];
    const turnMetadata = parseTurnMetadata(headers['x-codex-turn-metadata']);
    return {
        requestId: String(requestId || ''),
        responseId: typeof body?.id === 'string' ? body.id : null,
        previousResponseId: typeof body?.previous_response_id === 'string' ? body.previous_response_id : null,
        threadId: turnMetadata.threadId,
        turnId: turnMetadata.turnId,
        sessionId: turnMetadata.sessionId,
        metadataKeys: body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? Object.keys(body.metadata).sort() : [],
        tools: Array.isArray(body?.tools) ? body.tools.slice(0, 16).map((tool) => ({
            type: typeof tool?.type === 'string' ? tool.type : null,
            name: typeof tool?.name === 'string' ? tool.name : null,
            namespace: typeof tool?.namespace === 'string' ? tool.namespace : null,
        })) : [],
        input: input.slice(0, 8).map((item) => ({
            type: typeof item?.type === 'string' ? item.type : null,
            id: typeof item?.id === 'string' ? item.id : null,
            role: typeof item?.role === 'string' ? item.role : null,
            tools: item?.type === 'additional_tools' && Array.isArray(item.tools)
                ? item.tools.slice(0, 16).map((tool) => ({
                    type: typeof tool?.type === 'string' ? tool.type : null,
                    name: typeof tool?.name === 'string' ? tool.name : null,
                    namespace: typeof tool?.namespace === 'string' ? tool.namespace : null,
                })) : undefined,
        })),
    };
}

function parseTurnMetadata(value) {
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text !== 'string' || text.length > 16 * 1024) return { threadId: null, turnId: null, sessionId: null };
    try {
        const metadata = JSON.parse(text);
        return {
            // HTTP Responses metadata names the public App Server
            // Thread identity `session_id`; newer transports may additionally
            // expose `thread_id`. They identify the same VChat routing scope.
            threadId: typeof metadata?.thread_id === 'string' ? metadata.thread_id
                : typeof metadata?.session_id === 'string' ? metadata.session_id : null,
            turnId: typeof metadata?.turn_id === 'string' ? metadata.turn_id : null,
            sessionId: typeof metadata?.session_id === 'string' ? metadata.session_id : null,
        };
    } catch (_error) {
        return { threadId: null, turnId: null, sessionId: null };
    }
}

function normalizeResponsesInput(input) {
    const items = typeof input === 'string'
        ? [{ type: 'message', role: 'user', content: input }]
        : Array.isArray(input) ? input : input ? [input] : [];
    return items.map((item) => {
        if (!item || typeof item !== 'object') throw new Error('Responses input item must be an object');
        if (item.type === 'additional_tools') return {
            type: 'additional_tools',
            tools: Array.isArray(item.tools) ? item.tools : [],
        };
        if (item.type === 'reasoning') return {
            type: 'reasoning',
            content: normalizeText(item.content || item.summary),
        };
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

function requiresReasoningContentForToolHistory(model) {
    return String(model || '').toLowerCase().includes('deepseek');
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

function boundedInstructionText(value) {
    const text = normalizeText(value);
    if (Buffer.byteLength(text, 'utf8') > MAX_INSTRUCTION_BYTES) {
        throw new Error('App Server instructions exceed the 64 KiB safety limit');
    }
    return text;
}

function responsesToolsToChat(tools) {
    if (!Array.isArray(tools)) return [];
    let emittedVcpInvoke = false;
    return tools.flatMap((tool) => {
        if (!tool || tool.type !== 'function') return [];
        const name = String(tool.name || '').trim();
        // Codex may include its native shell/MCP/utility definitions even
        // when a particular installed App Server does not honor every
        // thread-scoped tool override.  This loopback provider boundary is
        // authoritative for Nova: ToolBox and the model see only vcp_invoke.
        if (name !== VCP_DYNAMIC_TOOL_NAME || emittedVcpInvoke) return [];
        emittedVcpInvoke = true;
        return [{ type: 'function', function: {
            ...vcpInvokeChatTool().function,
            ...(tool.description ? { description: String(tool.description) } : {}),
            parameters: tool.parameters || tool.input_schema || vcpInvokeChatTool().function.parameters,
        } }];
    });
}

function vcpInvokeChatTool() {
    return { type: 'function', function: {
        name: VCP_DYNAMIC_TOOL_NAME,
        description: 'Invoke one named VCPToolBox capability through the VCP bridge.',
        parameters: {
            type: 'object',
            properties: {
                tool: { type: 'string' },
                arguments: { type: 'object', additionalProperties: true },
            },
            required: ['tool', 'arguments'],
            additionalProperties: false,
        },
    } };
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
    const reasoning = publicReasoningText(message);
    if (reasoning) output.push(reasoningItem(reasoning));
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
    const reasoningTokens = Number(
        usage?.completion_tokens_details?.reasoning_tokens
        ?? usage?.output_tokens_details?.reasoning_tokens
        ?? usage?.reasoning_tokens
        ?? 0,
    );
    return {
        input_tokens: Number(usage?.prompt_tokens || 0), output_tokens: Number(usage?.completion_tokens || 0),
        total_tokens: Number(usage?.total_tokens || 0),
        output_tokens_details: { reasoning_tokens: Number.isFinite(reasoningTokens) ? reasoningTokens : 0 },
    };
}

function publicReasoningText(message) {
    if (!message || typeof message !== 'object') return '';
    if (typeof message.reasoning_content === 'string') return message.reasoning_content;
    if (typeof message.reasoning === 'string') return message.reasoning;
    return '';
}

function reasoningItem(text, id = `rs_${crypto.randomUUID()}`) {
    return {
        id,
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: String(text || '') }],
        encrypted_content: null,
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
        this.textIndex = null;
        this.reasoning = '';
        this.reasoningItem = null;
        this.reasoningIndex = null;
        this.calls = new Map();
        this.usage = null;
        this.nextOutputIndex = 0;
    }
    payload(status) { return { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: this.model, output: this.output(), output_text: this.text, usage: responsesUsage(this.usage) }; }
    output() {
        const output = [];
        if (this.reasoningItem) output.push({ index: this.reasoningIndex, item: reasoningItem(this.reasoning, this.reasoningItem.id) });
        if (this.textItem) output.push({ index: this.textIndex, item: { ...this.textItem, content: [{ ...this.textItem.content[0], text: this.text }] } });
        for (const call of this.calls.values()) if (call.name) output.push({ index: call.index, item: call.item() });
        return output.sort((left, right) => left.index - right.index).map((entry) => entry.item);
    }
    allocateOutputIndex() {
        const index = this.nextOutputIndex;
        this.nextOutputIndex += 1;
        return index;
    }
    ensureReasoning(response) {
        if (this.reasoningItem) return;
        this.reasoningIndex = this.allocateOutputIndex();
        this.reasoningItem = reasoningItem('');
        writeSse(response, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: this.reasoningIndex,
            item: this.reasoningItem,
        });
    }
    ensureText(response) {
        if (this.textItem) return;
        this.textIndex = this.allocateOutputIndex();
        this.textItem = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] };
        writeSse(response, 'response.output_item.added', { type: 'response.output_item.added', output_index: this.textIndex, item: { ...this.textItem, content: [] } });
        writeSse(response, 'response.content_part.added', { type: 'response.content_part.added', item_id: this.textItem.id, output_index: this.textIndex, content_index: 0, part: { type: 'output_text', text: '' } });
    }
    accept(event, response) {
        const choice = event?.choices?.[0] || {};
        const delta = choice.delta || choice.message || {};
        const reasoningDelta = publicReasoningText(delta);
        if (reasoningDelta) {
            this.ensureReasoning(response);
            this.reasoning += reasoningDelta;
            writeSse(response, 'response.reasoning_text.delta', {
                type: 'response.reasoning_text.delta',
                item_id: this.reasoningItem.id,
                output_index: this.reasoningIndex,
                content_index: 0,
                delta: reasoningDelta,
            });
        }
        if (typeof delta.content === 'string' && delta.content) {
            this.ensureText(response); this.text += delta.content;
            writeSse(response, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: this.textItem.id, output_index: this.textIndex, content_index: 0, delta: delta.content });
        }
        for (const [fallback, callDelta] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
            const key = String(callDelta.index ?? callDelta.id ?? fallback);
            const call = this.calls.get(key) || new PendingCall(String(callDelta.id || `call_${key}`), this.allocateOutputIndex());
            if (callDelta.id) call.id = String(callDelta.id);
            if (typeof callDelta.function?.name === 'string') call.name = callDelta.function.name;
            if (typeof callDelta.function?.arguments === 'string') call.arguments += callDelta.function.arguments;
            this.calls.set(key, call);
        }
        if (event?.usage) this.usage = event.usage;
    }
    finish(response) {
        if (this.reasoningItem) {
            writeSse(response, 'response.output_item.done', {
                type: 'response.output_item.done',
                output_index: this.reasoningIndex,
                item: reasoningItem(this.reasoning, this.reasoningItem.id),
            });
        }
        if (this.textItem) {
            const textItem = { ...this.textItem, content: [{ ...this.textItem.content[0], text: this.text }] };
            writeSse(response, 'response.output_text.done', { type: 'response.output_text.done', item_id: this.textItem.id, output_index: this.textIndex, content_index: 0, text: this.text });
            writeSse(response, 'response.content_part.done', { type: 'response.content_part.done', item_id: this.textItem.id, output_index: this.textIndex, content_index: 0, part: { type: 'output_text', text: this.text } });
            writeSse(response, 'response.output_item.done', { type: 'response.output_item.done', output_index: this.textIndex, item: textItem });
        }
        for (const call of this.calls.values()) if (call.name) {
            const item = call.item();
            writeSse(response, 'response.output_item.added', { type: 'response.output_item.added', output_index: call.index, item });
            writeSse(response, 'response.output_item.done', { type: 'response.output_item.done', output_index: call.index, item });
        }
        writeSse(response, 'response.completed', { type: 'response.completed', response: this.payload('completed') });
    }
}

class PendingCall {
    constructor(id, index) { this.id = id; this.index = index; this.name = ''; this.arguments = ''; }
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
