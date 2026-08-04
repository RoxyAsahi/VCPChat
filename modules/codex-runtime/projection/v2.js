'use strict';

const crypto = require('crypto');

const CONTENT_SCHEMA_VERSION = 2;

function stableBlockId(sessionId, itemId, ordinal = 0) {
    return `block:${String(sessionId)}:${String(itemId)}:${Number.isInteger(ordinal) ? ordinal : 0}`;
}

function boundedText(value, max = 16_384) {
    return String(value == null ? '' : value).slice(0, max);
}

function sanitizeUnknownItem(item = {}) {
    const safe = {
        type: boundedText(item.type || 'unknown', 128),
        id: boundedText(item.id || '', 256),
        status: boundedText(item.status || '', 64),
    };
    for (const key of ['name', 'tool', 'command', 'title', 'path', 'query']) {
        if (typeof item[key] === 'string') safe[key] = boundedText(item[key], 2_048);
    }
    return safe;
}

function normalizeContent(content, itemType) {
    if (itemType === 'reasoning') {
        return {
            summary: Array.isArray(content?.summary) ? content.summary.map((value) => boundedText(value)) : [],
            content: Array.isArray(content?.content) ? content.content.map((value) => boundedText(value)) : [],
        };
    }
    if (!content || typeof content !== 'object') return { text: boundedText(content) };
    if (content.item && !content.unknown) return { ...content, item: sanitizeUnknownItem(content.item) };
    return content;
}

function normalizeTimelineBlock({ sessionId, threadId, message, block }) {
    const ordinal = Number.isInteger(block?.ordinal) ? block.ordinal : 0;
    const itemType = block?.content?.item?.type || block?.content?.unknown?.type || null;
    return {
        schemaVersion: CONTENT_SCHEMA_VERSION,
        blockId: stableBlockId(sessionId, message.itemId, ordinal),
        sessionId: String(sessionId),
        threadId: String(threadId || message.threadId || ''),
        turnId: message.turnId || null,
        itemId: message.itemId,
        messageId: message.messageId,
        callId: itemType === 'dynamicToolCall' ? message.itemId : undefined,
        kind: block.kind || 'message',
        itemType,
        authority: block.authority || 'codex',
        status: block.status || message.status || 'inProgress',
        sourceOrder: Number.isFinite(Number(message.sourceOrder)) ? Number(message.sourceOrder) : 0,
        ordinal,
        content: normalizeContent(block.content || {}, itemType),
        createdAt: block.createdAt || message.createdAt || Date.now(),
        updatedAt: block.updatedAt || message.updatedAt || Date.now(),
    };
}

function normalizeProjectionSnapshot(snapshot) {
    const sessionId = String(snapshot?.session?.sessionId || '');
    const threadId = String(snapshot?.session?.threadId || '');
    const blocks = [];
    for (const message of Array.isArray(snapshot?.messages) ? snapshot.messages : []) {
        for (const block of Array.isArray(message.blocks) ? message.blocks : []) {
            blocks.push(normalizeTimelineBlock({ sessionId, threadId, message, block }));
        }
    }
    return {
        schemaVersion: CONTENT_SCHEMA_VERSION,
        sessionId,
        threadId,
        projectionRevision: Number(snapshot?.projectionRevision || snapshot?.projection?.mutationGeneration || 0),
        blocks,
    };
}

module.exports = {
    CONTENT_SCHEMA_VERSION,
    stableBlockId,
    sanitizeUnknownItem,
    normalizeTimelineBlock,
    normalizeProjectionSnapshot,
};
