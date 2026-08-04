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
        fields: Object.keys(item).slice(0, 32).map((key) => boundedText(key, 128)).sort(),
    };
    for (const key of ['name', 'tool', 'title']) {
        if (typeof item[key] === 'string') safe[key] = boundedText(item[key], 2_048);
    }
    return safe;
}

function boundedJson(value, depth = 0) {
    if (depth > 6) return '[truncated]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return boundedText(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((entry) => boundedJson(entry, depth + 1));
    if (typeof value !== 'object') return boundedText(value, 1_024);
    return Object.fromEntries(Object.entries(value).slice(0, 100)
        .map(([key, entry]) => [boundedText(key, 256), boundedJson(entry, depth + 1)]));
}

function normalizeContent(content, itemType) {
    if (itemType === 'reasoning') {
        return {
            summary: Array.isArray(content?.summary) ? content.summary.map((value) => boundedText(value)) : [],
            content: Array.isArray(content?.content) ? content.content.map((value) => boundedText(value)) : [],
        };
    }
    if (!content || typeof content !== 'object') return { text: boundedText(content) };
    if (content.item && !content.unknown) {
        const known = ['commandExecution', 'fileChange', 'mcpToolCall', 'collabAgentToolCall',
            'dynamicToolCall', 'webSearch', 'imageView'].includes(String(content.item.type || ''));
        return { ...boundedJson(content), item: known ? boundedJson(content.item) : sanitizeUnknownItem(content.item) };
    }
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

function projectionPatchBetween(before, after, { runtimeGeneration = 0 } = {}) {
    const previous = before?.normalized || normalizeProjectionSnapshot(before || {});
    const next = after?.normalized || normalizeProjectionSnapshot(after || {});
    const previousById = new Map(previous.blocks.map((block) => [block.blockId, block]));
    const nextById = new Map(next.blocks.map((block) => [block.blockId, block]));
    const upsertBlocks = [];
    for (const block of next.blocks) {
        const existing = previousById.get(block.blockId);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(block)) upsertBlocks.push(block);
    }
    return {
        schemaVersion: 1,
        sessionId: next.sessionId,
        threadId: next.threadId,
        runtimeGeneration,
        baseProjectionRevision: Number(previous.projectionRevision || 0),
        projectionRevision: Number(next.projectionRevision || 0),
        upsertBlocks,
        deleteBlockIds: [...previousById.keys()].filter((id) => !nextById.has(id)),
    };
}

module.exports = {
    CONTENT_SCHEMA_VERSION,
    normalizeContent,
    stableBlockId,
    sanitizeUnknownItem,
    normalizeTimelineBlock,
    normalizeProjectionSnapshot,
    projectionPatchBetween,
};
