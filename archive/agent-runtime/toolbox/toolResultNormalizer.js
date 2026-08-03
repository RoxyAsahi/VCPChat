'use strict';

const { LIMITS } = require('../contracts');
const { summarizeValue } = require('../secretRedactor');

function normalizeHumanToolResult(result) {
    if (result && typeof result === 'object') {
        if (result.error) {
            return {
                ok: false,
                output: '',
                error: summarizeValue(result.error, 1000),
                raw: result,
            };
        }
        if (result.status === 'error') {
            return {
                ok: false,
                output: '',
                error: summarizeValue(result.message || result.content || result, 1000),
                raw: result,
            };
        }
        const content = result.content !== undefined
            ? result.content
            : (result.result !== undefined ? result.result : result);
        return {
            ok: true,
            output: truncate(typeof content === 'string' ? content : JSON.stringify(content)),
            raw: result,
        };
    }
    return {
        ok: true,
        output: truncate(String(result)),
        raw: result,
    };
}

function truncate(text) {
    if (text.length > LIMITS.MAX_TOOL_RESULT_BYTES) {
        return `${text.slice(0, LIMITS.MAX_TOOL_RESULT_BYTES)}…[truncated]`;
    }
    return text;
}

module.exports = {
    normalizeHumanToolResult,
    truncate,
};
