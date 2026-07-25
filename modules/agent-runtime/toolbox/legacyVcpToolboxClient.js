'use strict';

const { fail, ERROR_CODES, AgentRuntimeError } = require('../errors');
const { LIMITS, newId } = require('../contracts');
const { encodeToolRequestBlock } = require('./legacyToolProtocol');
const { normalizeHumanToolResult, truncate } = require('./toolResultNormalizer');
const { summarizeValue } = require('../secretRedactor');

class LegacyVcpToolboxClient {
    constructor(options = {}) {
        this.baseUrl = normalizeVcpBaseUrl(options.baseUrl || '');
        this.apiKey = options.apiKey || '';
        this.fetchImpl = options.fetchImpl || globalThis.fetch;
        this.defaultTimeoutMs = options.defaultTimeoutMs || LIMITS.TOOL_DEFAULT_TIMEOUT_MS;
    }

    static fromSettings(settings) {
        if (!settings || !settings.vcpServerUrl || !settings.vcpApiKey) {
            fail(ERROR_CODES.RUNTIME_NOT_READY, 'VCP server URL or API key not configured');
        }
        return new LegacyVcpToolboxClient({
            baseUrl: settings.vcpServerUrl,
            apiKey: settings.vcpApiKey,
        });
    }

    maskedInfo() {
        return {
            baseUrl: this.baseUrl,
            hasApiKey: Boolean(this.apiKey),
        };
    }

    _headers(extra = {}) {
        return {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...extra,
        };
    }

    _withTimeout(signal, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('toolbox request timeout')), timeoutMs || this.defaultTimeoutMs);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        const onAbort = () => controller.abort(signal.reason || new Error('aborted'));
        if (signal) {
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }
        return {
            signal: controller.signal,
            cancel: () => controller.abort(new Error('cancelled')),
            done: () => {
                clearTimeout(timer);
                if (signal) {
                    signal.removeEventListener('abort', onAbort);
                }
            },
        };
    }

    async _postJson(path, body, options = {}) {
        const timeout = this._withTimeout(options.signal, options.timeoutMs);
        let response;
        try {
            response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: this._headers(options.headers),
                body: typeof body === 'string' ? body : JSON.stringify(body),
                signal: timeout.signal,
            });
        } catch (error) {
            timeout.done();
            if (timeout.signal.aborted) {
                throw new AgentRuntimeError(ERROR_CODES.TOOLBOX_REQUEST_FAILED,
                    `VCPToolBox request aborted: ${error.message}`, { path });
            }
            throw new AgentRuntimeError(ERROR_CODES.TOOLBOX_REQUEST_FAILED,
                `VCPToolBox request failed: ${error.message}`, { path });
        }
        return { response, timeout };
    }

    async invokeTool(options) {
        const block = encodeToolRequestBlock(options.toolName, options.args || {});
        const { response, timeout } = await this._postJson('/v1/human/tool', block, {
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
        try {
            const text = await response.text();
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (error) {
                parsed = { raw: text };
            }
            if (!response.ok) {
                return {
                    ok: false,
                    output: '',
                    error: summarizeValue(parsed && parsed.error ? parsed.error : parsed, 1000),
                    audit: { endpoint: 'human/tool', status: response.status },
                };
            }
            const normalized = normalizeHumanToolResult(parsed);
            return {
                ok: normalized.ok,
                output: normalized.output,
                error: normalized.error,
                audit: { endpoint: 'human/tool', status: response.status },
            };
        } finally {
            timeout.done();
        }
    }

    async delegate(options) {
        const requestId = options.requestId || newId('vcpreq');
        const content = options.context
            ? `${options.task}\n\n[context]\n${options.context}`
            : options.task;
        const body = {
            messages: [{ role: 'user', content }],
            stream: true,
            requestId,
        };
        if (options.model) {
            body.model = options.model;
        }
        const { response, timeout } = await this._postJson('/v1/chatvcp/completions', body, {
            signal: options.signal,
            timeoutMs: options.timeoutMs,
        });
        try {
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                return {
                    ok: false,
                    output: '',
                    error: `chatvcp HTTP ${response.status}: ${truncate(text.slice(0, 1000))}`,
                    audit: { endpoint: 'chatvcp', status: response.status, requestId },
                    requestId,
                };
            }
            const aggregated = await this._consumeSse(response, options.onDelta);
            return {
                ok: true,
                output: truncate(aggregated),
                audit: { endpoint: 'chatvcp', status: response.status, requestId },
                requestId,
            };
        } finally {
            timeout.done();
        }
    }

    async _consumeSse(response, onDelta) {
        let aggregated = '';
        let buffer = '';
        const decoder = new TextDecoder('utf-8');
        const processLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) {
                return;
            }
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') {
                return;
            }
            let parsed;
            try {
                parsed = JSON.parse(data);
            } catch (error) {
                return;
            }
            const delta = parsed.choices
                && parsed.choices[0]
                && parsed.choices[0].delta
                && parsed.choices[0].delta.content;
            if (typeof delta === 'string' && delta.length > 0) {
                aggregated += delta;
                if (aggregated.length > LIMITS.MAX_TOOL_RESULT_BYTES) {
                    aggregated = aggregated.slice(0, LIMITS.MAX_TOOL_RESULT_BYTES);
                }
                if (onDelta) {
                    onDelta(delta);
                }
            }
        };
        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                processLine(line);
            }
        }
        if (buffer.length > 0) {
            processLine(buffer);
        }
        return aggregated;
    }

    async interrupt(requestId) {
        try {
            const { response, timeout } = await this._postJson('/v1/interrupt', { requestId }, {
                timeoutMs: 15000,
            });
            try {
                return { ok: response.ok, status: response.status };
            } finally {
                timeout.done();
            }
        } catch (error) {
            return { ok: false, error: error.message };
        }
    }
}

function normalizeVcpBaseUrl(value) {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
}

module.exports = {
    LegacyVcpToolboxClient,
    normalizeVcpBaseUrl,
};
