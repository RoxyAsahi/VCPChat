'use strict';

const { BLOCK_CONTENT_SCHEMA_VERSION } = require('../dataContracts');
const {
    LIMITS,
    appendBoundedText,
    normalizeReasoningContent,
} = require('./content-policy');

function parseJson(value, fallback) {
    try { return value == null ? fallback : JSON.parse(value); } catch (_error) { return fallback; }
}

function persistBlock(stmt, sessionId, block, content, overrides = {}) {
    const now = Date.now();
    stmt.upsertBlock.run({
        block_id: block.block_id,
        message_id: block.message_id,
        kind: overrides.kind || block.kind,
        status: block.status || 'inProgress',
        ordinal: overrides.ordinal ?? block.ordinal,
        content_json: JSON.stringify(content),
        content_schema_version: BLOCK_CONTENT_SCHEMA_VERSION,
        authority: block.authority || 'codex',
        created_at: block.created_at || now,
        updated_at: now,
    });
    stmt.advanceGeneration.run({ session_id: sessionId, now });
}

function createProjectionStreamContentStore(stmt) {
    return {
        appendBlockText(sessionId, itemId, ordinal, delta, kind = 'message') {
            const message = stmt.getMessageByItem.get(sessionId, itemId);
            if (!message) throw new Error(`Unknown Codex item: ${itemId}`);
            const now = Date.now();
            const block = stmt.getBlock.get(message.message_id, ordinal) || {
                block_id: `block:${sessionId}:${itemId}:${ordinal}`,
                message_id: message.message_id,
                kind,
                status: 'inProgress',
                ordinal,
                content_json: '{}',
                created_at: now,
                updated_at: now,
            };
            const content = parseJson(block.content_json, {});
            const max = kind === 'tool' ? LIMITS.toolText
                : kind === 'observation' ? LIMITS.planText : LIMITS.messageText;
            const appended = appendBoundedText(content.text, delta, max);
            content.text = appended.text;
            if (appended.truncated) content.truncated = true;
            persistBlock(stmt, sessionId, block, content, { kind: block.kind || kind, ordinal });
        },

        ensureReasoningPart(sessionId, itemId, field, index) {
            if (!['summary', 'content'].includes(field)
                || !Number.isInteger(index) || index < 0 || index >= LIMITS.reasoningParts) return false;
            const message = stmt.getMessageByItem.get(sessionId, itemId);
            if (!message) return false;
            const existing = stmt.getBlock.get(message.message_id, 0);
            const block = existing || {
                block_id: `block:${sessionId}:${itemId}:0`, message_id: message.message_id,
                kind: 'reasoning', status: 'inProgress', ordinal: 0, content_json: '{}',
                created_at: Date.now(),
            };
            const content = parseJson(block.content_json, { summary: [], content: [] });
            const values = Array.isArray(content[field]) ? [...content[field]] : [];
            while (values.length <= index) values.push('');
            content[field] = values;
            Object.assign(content, normalizeReasoningContent(content));
            persistBlock(stmt, sessionId, block, content, { kind: 'reasoning', ordinal: 0 });
            return true;
        },

        appendReasoningText(sessionId, itemId, field, index, delta) {
            if (!['summary', 'content'].includes(field)
                || !Number.isInteger(index) || index < 0 || index >= LIMITS.reasoningParts) return false;
            const message = stmt.getMessageByItem.get(sessionId, itemId);
            if (!message) return false;
            const existing = stmt.getBlock.get(message.message_id, 0);
            const block = existing || {
                block_id: `block:${sessionId}:${itemId}:0`, message_id: message.message_id,
                kind: 'reasoning', status: 'inProgress', ordinal: 0, content_json: '{}',
                created_at: Date.now(),
            };
            const content = parseJson(block.content_json, { summary: [], content: [] });
            const values = Array.isArray(content[field]) ? [...content[field]] : [];
            while (values.length <= index) values.push('');
            const appended = appendBoundedText(values[index], delta, LIMITS.reasoningPartText);
            values[index] = appended.text;
            content[field] = values;
            Object.assign(content, normalizeReasoningContent(content));
            if (appended.truncated) content.truncated = true;
            persistBlock(stmt, sessionId, block, content, { kind: 'reasoning', ordinal: 0 });
            return true;
        },
    };
}

module.exports = { createProjectionStreamContentStore };
