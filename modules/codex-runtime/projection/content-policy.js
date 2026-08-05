'use strict';

const LIMITS = Object.freeze({
    messageText: 256 * 1024,
    planText: 64 * 1024,
    toolText: 128 * 1024,
    jsonText: 16 * 1024,
    jsonDepth: 6,
    jsonEntries: 100,
    name: 512,
    url: 2_048,
    userParts: 64,
    reasoningParts: 64,
    reasoningPartText: 64 * 1024,
    reasoningTotalText: 512 * 1024,
});

const REDACTED_KEY = /(?:authorization|api[-_]?key|cookie|credential|password|secret|token)$/i;
const PATH_KEY = /(?:absolutePath|cwd|directory|filePath|path|root|scriptPath|workspaceRoot)$/i;
const URL_KEY = /(?:uri|url)$/i;
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\(?:[?.]\\)?|\/)/i;
const BASE64_BLOB = /^[a-z0-9+/=_-]+$/i;

function boundedText(value, max = LIMITS.jsonText) {
    const text = String(value == null ? '' : value).replace(/\u0000/g, '');
    if (max <= 0) return '';
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function displayPath(value) {
    const text = boundedText(value, LIMITS.url).trim();
    if (!text) return '';
    if (!ABSOLUTE_PATH.test(text)) return text.replace(/\\/g, '/');
    const pieces = text.split(/[\\/]/).filter(Boolean);
    return boundedText(pieces.at(-1) || 'local resource', LIMITS.name);
}

function safeRemoteUrl(value) {
    const text = boundedText(value, LIMITS.url).trim();
    if (!text || /^(?:data|file|blob):/i.test(text)) return '';
    try {
        const parsed = new URL(text);
        return ['http:', 'https:'].includes(parsed.protocol) ? text : '';
    } catch (_error) {
        return '';
    }
}

function looksLikeBinaryPayload(value) {
    const text = String(value || '');
    return /^data:[^,]+;base64,/i.test(text)
        || (text.length >= 8_192 && !/\s/.test(text) && BASE64_BLOB.test(text));
}

function boundedJson(value, depth = 0, key = '') {
    if (REDACTED_KEY.test(key)) return '[redacted]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
        if (looksLikeBinaryPayload(value)) return '[binary data omitted]';
        if (PATH_KEY.test(key)) return displayPath(value);
        if (URL_KEY.test(key)) return safeRemoteUrl(value) || '[unsupported URL omitted]';
        return boundedText(value);
    }
    if (depth >= LIMITS.jsonDepth) return '[truncated]';
    if (Array.isArray(value)) {
        return value.slice(0, LIMITS.jsonEntries).map((entry) => boundedJson(entry, depth + 1, key));
    }
    if (typeof value !== 'object') return boundedText(value, 1_024);
    return Object.fromEntries(Object.entries(value).slice(0, LIMITS.jsonEntries)
        .map(([entryKey, entry]) => {
            const safeKey = boundedText(entryKey, 256);
            return [safeKey, boundedJson(entry, depth + 1, safeKey)];
        }));
}

function normalizeUserInputPart(part) {
    if (!part || typeof part !== 'object') return null;
    const type = boundedText(part.type || '', 64);
    if (type === 'text') return { type, text: boundedText(part.text, LIMITS.messageText) };
    if (type === 'image' || type === 'audio') {
        const url = safeRemoteUrl(part.url);
        return { type, ...(url ? { url } : {}), ...(type === 'image' && part.detail ? { detail: boundedText(part.detail, 32) } : {}) };
    }
    if (type === 'localImage' || type === 'localAudio') {
        return {
            type,
            name: displayPath(part.path) || (type === 'localImage' ? 'local image' : 'local audio'),
            ...(type === 'localImage' && part.detail ? { detail: boundedText(part.detail, 32) } : {}),
        };
    }
    if (type === 'skill' || type === 'mention') {
        return { type, name: boundedText(part.name || displayPath(part.path) || type, LIMITS.name) };
    }
    return { type: type || 'unknown' };
}

function normalizeUserInputParts(parts) {
    const normalized = [];
    let remainingText = LIMITS.messageText;
    for (const part of Array.isArray(parts) ? parts.slice(0, LIMITS.userParts) : []) {
        const safe = normalizeUserInputPart(part);
        if (!safe) continue;
        if (safe.type === 'text') {
            safe.text = boundedText(safe.text, Math.max(0, remainingText));
            remainingText = Math.max(0, remainingText - safe.text.length);
        }
        normalized.push(safe);
    }
    return normalized;
}

function normalizeReasoningArray(values, budget) {
    const result = [];
    let remaining = budget;
    for (const value of Array.isArray(values) ? values.slice(0, LIMITS.reasoningParts) : []) {
        const text = boundedText(value, Math.min(LIMITS.reasoningPartText, Math.max(0, remaining)));
        result.push(text);
        remaining = Math.max(0, remaining - text.length);
        if (remaining <= 0) break;
    }
    return { values: result, remaining };
}

function normalizeReasoningContent(content = {}) {
    const summary = normalizeReasoningArray(content.summary, LIMITS.reasoningTotalText);
    const detail = normalizeReasoningArray(content.content, summary.remaining);
    const inputCount = (Array.isArray(content.summary) ? content.summary.length : 0)
        + (Array.isArray(content.content) ? content.content.length : 0);
    const outputCount = summary.values.length + detail.values.length;
    const inputChars = [...(content.summary || []), ...(content.content || [])]
        .reduce((total, value) => total + String(value ?? '').length, 0);
    return {
        summary: summary.values,
        content: detail.values,
        ...(inputCount > outputCount || inputChars > LIMITS.reasoningTotalText ? { truncated: true } : {}),
    };
}

function normalizeProjectionContent(content, itemType) {
    if (itemType === 'reasoning') return normalizeReasoningContent(content);
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
        return { text: boundedText(content, LIMITS.messageText) };
    }
    if (Array.isArray(content.parts)) return { ...boundedJson(content), parts: normalizeUserInputParts(content.parts) };
    if (content.item) return { ...boundedJson(content), item: boundedJson(content.item) };
    const normalized = boundedJson(content);
    if (typeof normalized.text === 'string') {
        const max = itemType === 'plan' ? LIMITS.planText : LIMITS.messageText;
        normalized.text = boundedText(normalized.text, max);
    }
    if (typeof normalized.historyText === 'string') normalized.historyText = boundedText(normalized.historyText, LIMITS.messageText);
    return normalized;
}

function appendBoundedText(current, delta, max) {
    const existing = String(current || '');
    if (existing.length >= max) return { text: existing.slice(0, max), truncated: true };
    const addition = String(delta || '').replace(/\u0000/g, '');
    const available = max - existing.length;
    return {
        text: existing + addition.slice(0, available),
        truncated: addition.length > available,
    };
}

module.exports = {
    LIMITS,
    appendBoundedText,
    boundedJson,
    boundedText,
    displayPath,
    normalizeProjectionContent,
    normalizeReasoningContent,
    normalizeUserInputParts,
    safeRemoteUrl,
};
