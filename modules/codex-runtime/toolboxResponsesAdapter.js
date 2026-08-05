'use strict';

// VChat-owned compatibility boundary for an unchanged VCPToolBox.  Codex
// speaks OpenAI Responses; ToolBox's stable public model endpoint speaks Chat
// Completions.  This adapter is intentionally loopback-only and handles only
// that protocol conversion.  It does not execute tools, inspect ToolBox
// catalogues, or infer tool identities.

const crypto = require('crypto');
const http = require('http');
const {
    allowsAnyVcpTool,
    responsesToolsToChat,
    vcpInvokeChatTool,
} = require('./toolboxToolPolicyAdapter');

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const CANCELLED_TURN_TTL_MS = 5 * 60 * 1000;
const MAX_DIAGNOSTIC_REQUESTS = 8;
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
        this.clock = options.clock || (() => Date.now());
        this.recentDiagnostics = [];
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

    getDiagnostics({ sessionId = '', threadId = '' } = {}) {
        const expectedSessionId = String(sessionId || '').trim();
        const expectedThreadId = String(threadId || '').trim();
        const requests = this.recentDiagnostics.filter((request) => (
            (!expectedSessionId || request.sessionId === expectedSessionId)
            && (!expectedThreadId || request.threadId === expectedThreadId)
        ));
        return {
            state: this.server ? 'ready' : 'stopped',
            activeRequestCount: [...this.activeRequests.values()].filter((request) => (
                (!expectedSessionId || request.sessionId === expectedSessionId)
                && (!expectedThreadId || request.threadId === expectedThreadId)
            )).length,
            recentRequests: requests.map((request) => ({
                sessionId: request.sessionId,
                threadId: request.threadId,
                turnId: request.turnId,
                model: request.model,
                status: request.status,
                httpStatus: request.httpStatus,
                startedAt: request.startedAt,
                completedAt: request.completedAt,
                durationMs: request.durationMs,
                incomingTools: request.incomingTools.map((tool) => ({ ...tool })),
                forwardedTools: request.forwardedTools.map((tool) => ({ ...tool })),
                error: request.error ? { ...request.error } : null,
            })),
        };
    }

    _startDiagnostic(identity, body, chatRequest) {
        const record = {
            sessionId: identity.sessionId || null,
            threadId: identity.threadId || null,
            turnId: identity.turnId || null,
            model: String(body?.model || chatRequest?.model || '').slice(0, 160) || null,
            status: 'running',
            httpStatus: null,
            startedAt: this.clock(),
            completedAt: null,
            durationMs: null,
            incomingTools: [...identity.tools, ...identity.input.flatMap((item) => item.tools || [])],
            forwardedTools: chatRequestToolSummary(chatRequest),
            error: null,
        };
        this.recentDiagnostics.unshift(record);
        if (this.recentDiagnostics.length > MAX_DIAGNOSTIC_REQUESTS) {
            this.recentDiagnostics.length = MAX_DIAGNOSTIC_REQUESTS;
        }
        return record;
    }

    _finishDiagnostic(record, { status, httpStatus = null, code = null, message = null } = {}) {
        if (!record || record.status !== 'running') return;
        record.status = status || 'failed';
        record.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
        record.completedAt = this.clock();
        record.durationMs = Math.max(0, record.completedAt - record.startedAt);
        record.error = code || message ? {
            code: String(code || 'ADAPTER_ERROR').slice(0, 96),
            message: String(message || 'Adapter request failed').slice(0, 320),
        } : null;
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
        let diagnosticRecord = null;
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
            diagnosticRecord = this._startDiagnostic(identity, body, chatRequest);
            this.onRequest?.({
                ...identity,
                forwardedTools: chatRequestToolSummary(chatRequest),
            });
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
            this._finishDiagnostic(diagnosticRecord, {
                status: clientDetached ? 'interrupted' : 'failed',
                code: clientDetached ? 'REQUEST_INTERRUPTED' : 'TOOLBOX_UNAVAILABLE',
                message: clientDetached ? 'ToolBox request was interrupted' : 'ToolBox model endpoint is unavailable',
            });
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
            this._finishDiagnostic(diagnosticRecord, {
                status: 'failed', httpStatus: upstream.status,
                code: 'TOOLBOX_ERROR', message: `ToolBox model endpoint returned ${upstream.status}`,
            });
            writeJson(response, upstream.status, {
                error: { code: 'toolbox_error', message: `ToolBox model endpoint returned ${upstream.status}`, details },
            });
            cleanupClientDetached();
            return;
        }
        if (chatRequest.stream) {
            try {
                await relayChatStreamAsResponses(upstream, response, body.model || chatRequest.model);
                this._finishDiagnostic(diagnosticRecord, { status: 'completed', httpStatus: upstream.status });
            } catch (error) {
                this._finishDiagnostic(diagnosticRecord, {
                    status: 'failed', httpStatus: upstream.status,
                    code: 'INVALID_TOOLBOX_STREAM', message: error?.message || 'ToolBox stream failed',
                });
                if (!response.destroyed && !response.writableEnded) {
                    writeJson(response, 502, {
                        error: { code: 'invalid_toolbox_stream', message: 'ToolBox returned an invalid stream' },
                    });
                }
            } finally {
                cleanupClientDetached();
            }
            return;
        }
        let chatResponse;
        try {
            chatResponse = await upstream.json();
        } catch (_error) {
            this._finishDiagnostic(diagnosticRecord, {
                status: 'failed', httpStatus: upstream.status,
                code: 'INVALID_TOOLBOX_RESPONSE', message: 'ToolBox returned invalid JSON',
            });
            writeJson(response, 502, { error: { code: 'invalid_toolbox_response', message: 'ToolBox returned invalid JSON' } });
            cleanupClientDetached();
            return;
        }
        writeJson(response, 200, chatResponseToResponses(chatResponse, body.model || chatRequest.model));
        this._finishDiagnostic(diagnosticRecord, { status: 'completed', httpStatus: upstream.status });
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

function appendResponseItem(state, item, options, model) {
    if (item.type === 'additional_tools') {
        state.embeddedTools.push(...item.tools);
        return;
    }
    if (options.stripEmbeddedInstructions && (item.role === 'system' || item.role === 'developer')) return;
    if (item.type === 'reasoning') {
        if (state.pendingToolCalls.length > 0) flushAssistantMessage(state, model);
        state.pendingReasoning += item.content;
        return;
    }
    if (item.type === 'function_call') {
        if (!item.callId || !item.name) throw new Error('function_call requires call_id and name');
        if (state.declaredCallIds.has(item.callId)) throw new Error(`duplicate function_call call_id: ${item.callId}`);
        state.declaredCallIds.add(item.callId);
        state.pendingToolCalls.push({
            id: item.callId, type: 'function', function: { name: item.name, arguments: item.arguments },
        });
        return;
    }
    if (item.type === 'function_call_output') {
        flushAssistantMessage(state, model);
        if (!item.callId) throw new Error('function_call_output requires call_id');
        if (!state.declaredCallIds.has(item.callId)) {
            throw new Error(`function_call_output has no matching function_call: ${item.callId}`);
        }
        if (state.completedCallIds.has(item.callId)) {
            throw new Error(`duplicate function_call_output call_id: ${item.callId}`);
        }
        state.completedCallIds.add(item.callId);
        state.messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
        return;
    }
    if (item.role === 'assistant') {
        if (state.pendingAssistantContent != null || state.pendingToolCalls.length > 0) {
            flushAssistantMessage(state, model);
        }
        state.pendingAssistantContent = item.content;
        return;
    }
    flushAssistantMessage(state, model);
    state.messages.push({ role: item.role, content: item.content });
}

function flushAssistantMessage(state, model) {
    if (state.pendingAssistantContent == null && state.pendingToolCalls.length === 0 && !state.pendingReasoning) return;
    const assistant = {
        role: 'assistant',
        content: state.pendingAssistantContent == null ? null : state.pendingAssistantContent,
    };
    if (state.pendingReasoning
        || (state.pendingToolCalls.length > 0 && requiresReasoningContentForToolHistory(model))) {
        assistant.reasoning_content = state.pendingReasoning;
    }
    if (state.pendingToolCalls.length > 0) assistant.tool_calls = state.pendingToolCalls;
    state.messages.push(assistant);
    state.pendingReasoning = '';
    state.pendingAssistantContent = null;
    state.pendingToolCalls = [];
}

function responseInstructionMessages(body, options) {
    const trusted = options.trustedInstructions && typeof options.trustedInstructions === 'object'
        ? options.trustedInstructions : null;
    const instructions = options.stripEmbeddedInstructions
        ? (trusted?.mode === 'codex-managed'
            ? boundedInstructionText(body.instructions)
            : boundedInstructionText(trusted?.baseInstructions ?? options.trustedBaseInstructions))
        : boundedInstructionText(body.instructions);
    const messages = instructions ? [{ role: 'system', content: instructions }] : [];
    if (options.stripEmbeddedInstructions && trusted?.mode === 'codex-managed'
        && boundedInstructionText(trusted.developerInstructions)) {
        messages.push({ role: 'developer', content: boundedInstructionText(trusted.developerInstructions) });
    }
    return messages;
}

function finalizeChatRequest(chat, body, requestId, options, embeddedTools) {
    const stableRequestId = String(requestId || body.requestId || body.messageId || '').trim();
    if (stableRequestId) chat.requestId = stableRequestId;
    const tools = responsesToolsToChat([
        ...(Array.isArray(body.tools) ? body.tools : []), ...embeddedTools,
    ], options.trustedInstructions?.toolPolicy);
    if (options.stripEmbeddedInstructions && tools.length === 0
        && allowsAnyVcpTool(options.trustedInstructions?.toolPolicy)) tools.push(vcpInvokeChatTool());
    if (tools.length > 0) chat.tools = tools;
    if (body.tool_choice != null) chat.tool_choice = body.tool_choice;
    if (Number.isFinite(body.temperature)) chat.temperature = body.temperature;
    if (Number.isFinite(body.max_output_tokens)) chat.max_tokens = body.max_output_tokens;
    const effort = normalizeText(body.reasoning?.effort || body.reasoning_effort);
    if (effort) chat.reasoning_effort = effort;
    return chat;
}

function responsesRequestToChat(body, requestId = null, options = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Responses request body must be an object');
    const model = String(body.model || '').trim();
    if (!model) throw new Error('Responses request model is required');
    const messages = [];
    messages.push(...responseInstructionMessages(body, options));
    const state = {
        messages, declaredCallIds: new Set(), completedCallIds: new Set(), embeddedTools: [],
        pendingReasoning: '', pendingAssistantContent: null, pendingToolCalls: [],
    };
    for (const item of normalizeResponsesInput(body.input)) {
        appendResponseItem(state, item, options, model);
    }
    flushAssistantMessage(state, model);
    return finalizeChatRequest({ model, messages, stream: body.stream === true },
        body, requestId, options, state.embeddedTools);
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

function chatRequestToolSummary(chatRequest) {
    return (Array.isArray(chatRequest?.tools) ? chatRequest.tools : []).slice(0, 16).map((tool) => ({
        type: typeof tool?.type === 'string' ? tool.type : null,
        name: typeof tool?.function?.name === 'string' ? tool.function.name : null,
    }));
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

function reasoningItem(text, id = `rs_${crypto.randomUUID()}`, status = null) {
    return {
        id,
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: String(text || '') }],
        encrypted_content: null,
        ...(status ? { status } : {}),
    };
}

async function relayChatStreamAsResponses(upstream, response, model) {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const state = new ResponsesStreamState(model);
    state.emit(response, 'response.created', { type: 'response.created', response: state.payload('in_progress') });
    let buffer = '';
    let terminal = false;
    const consumeChunk = (chunk) => {
        buffer += Buffer.from(chunk).toString('utf8');
        let boundary = nextSseFrameBoundary(buffer);
        while (boundary) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.end);
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            if (data === '[DONE]') continue;
            if (data) {
                try { terminal = state.accept(JSON.parse(data), response) || terminal; } catch (_error) { /* malformed upstream chunk is ignored until terminal error */ }
            }
            if (terminal) break;
            boundary = nextSseFrameBoundary(buffer);
        }
    };
    // Electron's fetch exposes a WHATWG ReadableStream. Its async iterator
    // can continue yielding decoded chunks yet fail to resolve the final EOF
    // on some Windows builds. Drive the reader explicitly so a ToolBox [DONE]
    // or closed response always reaches `finish` and therefore closes Codex's
    // active Turn. Keep the iterator fallback for injected test transports.
    const stream = upstream.body;
    if (!stream) throw new Error('ToolBox stream body is missing');
    if (typeof stream.getReader === 'function') {
        const reader = stream.getReader();
        try {
            while (!terminal) {
                const { done, value } = await reader.read();
                if (done) break;
                consumeChunk(value);
            }
        } finally {
            if (terminal) await reader.cancel().catch(() => null);
            reader.releaseLock?.();
        }
    } else {
        for await (const chunk of stream) {
            consumeChunk(chunk);
            if (terminal) break;
        }
    }
    state.finish(response);
    response.end();
}

function nextSseFrameBoundary(buffer) {
    const match = /\r?\n\r?\n/.exec(buffer);
    return match ? { index: match.index, end: match.index + match[0].length } : null;
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
        this.nextSequenceNumber = 1;
    }
    emit(response, event, payload) {
        writeSse(response, event, { ...payload, sequence_number: this.nextSequenceNumber++ });
    }
    payload(status) { return { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: this.model, output: this.output(), output_text: this.text, usage: responsesUsage(this.usage) }; }
    output() {
        const output = [];
        if (this.reasoningItem) output.push({ index: this.reasoningIndex, item: reasoningItem(this.reasoning, this.reasoningItem.id, 'completed') });
        if (this.textItem) output.push({ index: this.textIndex, item: { ...this.textItem, status: 'completed', content: [{ ...this.textItem.content[0], text: this.text }] } });
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
        this.reasoningItem = { ...reasoningItem(''), content: [] };
        this.emit(response, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: this.reasoningIndex,
            item: this.reasoningItem,
        });
    }
    ensureText(response) {
        if (this.textItem) return;
        this.textIndex = this.allocateOutputIndex();
        this.textItem = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] };
        this.emit(response, 'response.output_item.added', { type: 'response.output_item.added', output_index: this.textIndex, item: { ...this.textItem, content: [] } });
        this.emit(response, 'response.content_part.added', { type: 'response.content_part.added', item_id: this.textItem.id, output_index: this.textIndex, content_index: 0, part: { type: 'output_text', text: '' } });
    }
    accept(event, response) {
        const choice = event?.choices?.[0] || {};
        const delta = choice.delta || choice.message || {};
        const reasoningDelta = publicReasoningText(delta);
        if (reasoningDelta) {
            this.ensureReasoning(response);
            this.reasoning += reasoningDelta;
            this.emit(response, 'response.reasoning_text.delta', {
                type: 'response.reasoning_text.delta',
                item_id: this.reasoningItem.id,
                output_index: this.reasoningIndex,
                content_index: 0,
                delta: reasoningDelta,
            });
        }
        if (typeof delta.content === 'string' && delta.content) {
            this.ensureText(response); this.text += delta.content;
            this.emit(response, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: this.textItem.id, output_index: this.textIndex, content_index: 0, delta: delta.content });
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
        // Chat Completions providers are allowed to leave the HTTP stream
        // open after a terminal chunk. The finish reason is authoritative;
        // waiting for transport EOF would leave the Codex Turn running.
        return typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0;
    }
    finish(response) {
        if (this.reasoningItem) {
            this.emit(response, 'response.reasoning_text.done', {
                type: 'response.reasoning_text.done',
                item_id: this.reasoningItem.id,
                output_index: this.reasoningIndex,
                content_index: 0,
                text: this.reasoning,
            });
            this.emit(response, 'response.output_item.done', {
                type: 'response.output_item.done',
                output_index: this.reasoningIndex,
                item: reasoningItem(this.reasoning, this.reasoningItem.id, 'completed'),
            });
        }
        if (this.textItem) {
            const textItem = { ...this.textItem, status: 'completed', content: [{ ...this.textItem.content[0], text: this.text }] };
            this.emit(response, 'response.output_text.done', { type: 'response.output_text.done', item_id: this.textItem.id, output_index: this.textIndex, content_index: 0, text: this.text });
            this.emit(response, 'response.content_part.done', { type: 'response.content_part.done', item_id: this.textItem.id, output_index: this.textIndex, content_index: 0, part: { type: 'output_text', text: this.text } });
            this.emit(response, 'response.output_item.done', { type: 'response.output_item.done', output_index: this.textIndex, item: textItem });
        }
        for (const call of this.calls.values()) if (call.name) {
            const item = call.item();
            this.emit(response, 'response.output_item.added', { type: 'response.output_item.added', output_index: call.index, item });
            this.emit(response, 'response.output_item.done', { type: 'response.output_item.done', output_index: call.index, item });
        }
        this.emit(response, 'response.completed', { type: 'response.completed', response: this.payload('completed') });
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
