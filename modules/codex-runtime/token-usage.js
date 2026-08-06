'use strict';

function nonnegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeBreakdown(value = {}) {
    return {
        inputTokens: nonnegativeInteger(value.inputTokens),
        outputTokens: nonnegativeInteger(value.outputTokens),
        reasoningTokens: nonnegativeInteger(value.reasoningOutputTokens),
        cacheReadTokens: nonnegativeInteger(value.cachedInputTokens),
        cacheWriteTokens: nonnegativeInteger(value.cacheWriteInputTokens),
        totalTokens: nonnegativeInteger(value.totalTokens),
    };
}

function normalizeThreadTokenUsage(params = {}) {
    const tokenUsage = params.tokenUsage;
    if (!tokenUsage || typeof tokenUsage !== 'object') return null;
    const last = normalizeBreakdown(tokenUsage.last);
    const cumulative = normalizeBreakdown(tokenUsage.total);
    const contextWindow = nonnegativeInteger(tokenUsage.modelContextWindow);
    const contextTokens = last.totalTokens;
    return {
        schemaVersion: 1,
        source: 'real',
        provenance: 'codex-thread',
        turnId: typeof params.turnId === 'string' ? params.turnId.slice(0, 256) : null,
        inputTokens: last.inputTokens,
        outputTokens: last.outputTokens,
        reasoningTokens: last.reasoningTokens,
        cacheReadTokens: last.cacheReadTokens,
        cacheWriteTokens: last.cacheWriteTokens,
        totalTokens: last.totalTokens,
        usedTokens: contextTokens,
        contextTokens,
        contextWindow,
        sessionInputTokens: cumulative.inputTokens,
        sessionOutputTokens: cumulative.outputTokens,
        sessionReasoningTokens: cumulative.reasoningTokens,
        sessionCacheReadTokens: cumulative.cacheReadTokens,
        sessionCacheWriteTokens: cumulative.cacheWriteTokens,
        sessionTotalTokens: cumulative.totalTokens,
        percentage: contextWindow ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : null,
    };
}

function normalizeUsagePayload(payload = {}) {
    const allowed = [
        'schemaVersion', 'source', 'provenance', 'turnId', 'model', 'provider',
        'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens',
        'totalTokens', 'usedTokens', 'contextTokens', 'contextWindow', 'sessionInputTokens',
        'sessionOutputTokens', 'sessionReasoningTokens', 'sessionCacheReadTokens',
        'sessionCacheWriteTokens', 'sessionTotalTokens', 'percentage',
    ];
    const output = {};
    for (const key of allowed) {
        const value = payload[key];
        if (['source', 'provenance', 'turnId', 'model', 'provider'].includes(key)) {
            if (typeof value === 'string') output[key] = value.slice(0, 256);
        } else if (value === null && key === 'percentage') output[key] = null;
        else if (Number.isFinite(Number(value)) && Number(value) >= 0) output[key] = Math.floor(Number(value));
    }
    output.schemaVersion = 1;
    output.source = ['real', 'estimated', 'unknown'].includes(output.source) ? output.source : 'unknown';
    return output;
}

module.exports = { normalizeThreadTokenUsage, normalizeUsagePayload };
