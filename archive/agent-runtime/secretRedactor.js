'use strict';

const SECRET_KEY_PATTERN = /api[-_]?key|apikey|secret|token|password|passwd|authorization|auth[-_]?token|bearer|credential|vcp[-_]?key|private[-_]?key/i;

const INLINE_PATTERNS = [
    /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /sk-[A-Za-z0-9_-]{10,}/g,
    /VCP_Key=[^\s&/]+/gi,
    /(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"']{6,}/gi,
];

const REDACTED = '[REDACTED]';

function redactString(value) {
    let result = value;
    for (const pattern of INLINE_PATTERNS) {
        result = result.replace(pattern, (match) => {
            const eq = match.match(/^([^:=]+[:=]\s*)/);
            if (eq && /key|token|secret|password/i.test(eq[1])) {
                return `${eq[1]}${REDACTED}`;
            }
            return REDACTED;
        });
    }
    return result;
}

function redactValue(value, depth = 0) {
    if (depth > 8) {
        return REDACTED;
    }
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'string') {
        return redactString(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, depth + 1));
    }
    if (typeof value === 'object') {
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            if (SECRET_KEY_PATTERN.test(key)) {
                output[key] = REDACTED;
            } else {
                output[key] = redactValue(item, depth + 1);
            }
        }
        return output;
    }
    return value;
}

function summarizeValue(value, maxLength = 500) {
    const redacted = redactValue(value);
    let text;
    try {
        text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
    } catch (error) {
        text = String(redacted);
    }
    if (text.length > maxLength) {
        return `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`;
    }
    return text;
}

module.exports = {
    redactValue,
    redactString,
    summarizeValue,
    REDACTED,
};
