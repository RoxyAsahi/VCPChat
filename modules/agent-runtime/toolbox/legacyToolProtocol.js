'use strict';

const { fail, ERROR_CODES } = require('../errors');
const { assertToolName, assertToolArguments } = require('../contracts');

const MARKERS = Object.freeze({
    START: '<<<[TOOL_REQUEST]>>>',
    END: '<<<[END_TOOL_REQUEST]>>>',
    FIELD_START: '「始」',
    FIELD_END: '「末」',
});

// Marker literals are hard-rejected, never escaped (see ADR 0004 /
// tool-bridge.md). Escaping ambiguous input would let a model smuggle a
// second tool block through a field value.
const FORBIDDEN_LITERALS = [
    MARKERS.START,
    MARKERS.END,
    MARKERS.FIELD_START,
    MARKERS.FIELD_END,
];

const RESERVED_FIELD_KEYS = new Set(['tool_name', 'archery', 'ink', 'river', 'vref']);

function assertSafeFieldValue(value) {
    const text = String(value);
    for (const literal of FORBIDDEN_LITERALS) {
        if (text.includes(literal)) {
            fail(ERROR_CODES.TOOL_PROTOCOL_VIOLATION,
                `Tool argument value contains forbidden protocol literal: ${literal}`);
        }
    }
    return text;
}

function assertSafeFieldKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
        fail(ERROR_CODES.TOOL_PROTOCOL_VIOLATION, `Invalid tool argument key length: ${String(key).slice(0, 32)}`);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
        fail(ERROR_CODES.TOOL_PROTOCOL_VIOLATION, `Unsafe tool argument key: ${key}`);
    }
    if (RESERVED_FIELD_KEYS.has(key)) {
        fail(ERROR_CODES.TOOL_PROTOCOL_VIOLATION, `Reserved tool argument key: ${key}`);
    }
    return key;
}

function flattenValue(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
}

function encodeToolRequestBlock(toolName, args) {
    assertToolName(toolName);
    assertSafeFieldValue(toolName);
    const safeArgs = assertToolArguments(args);
    const lines = [`tool_name:${MARKERS.FIELD_START}${toolName}${MARKERS.FIELD_END}`];
    for (const [key, value] of Object.entries(safeArgs)) {
        assertSafeFieldKey(key);
        lines.push(`${key}:${MARKERS.FIELD_START}${assertSafeFieldValue(flattenValue(value))}${MARKERS.FIELD_END}`);
    }
    return [
        MARKERS.START,
        ...lines,
        MARKERS.END,
    ].join('\n');
}

module.exports = {
    MARKERS,
    encodeToolRequestBlock,
    assertSafeFieldValue,
    assertSafeFieldKey,
};
