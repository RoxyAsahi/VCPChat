'use strict';

const { projectionMessagesInLogicalOrder } = require('./timeline-order');

function storedMessages(statements, sessionId, mapBlock) {
    return statements.listMessages.all(sessionId).map((row) => ({
        messageId: row.message_id,
        sessionId: row.session_id,
        threadId: row.codex_thread_id,
        turnId: row.codex_turn_id,
        itemId: row.codex_item_id,
        role: row.role,
        status: row.status,
        sourceOrder: row.source_order,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        blocks: statements.listBlocks.all(row.message_id).map(mapBlock),
    }));
}

function persistTimelineOrder(statements, sessionId, stored, ordered) {
    const changed = ordered.some((message, index) => (
        message.messageId !== stored[index]?.messageId
        || Number(message.sourceOrder) !== index + 1
    ));
    if (!changed) return false;
    ordered.forEach((message, index) => statements.setMessageSourceOrder.run({
        message_id: message.messageId,
        source_order: index + 1,
    }));
    statements.setNextSourceOrder.run({
        session_id: sessionId,
        next_source_order: ordered.length + 1,
        now: Date.now(),
    });
    statements.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
    return true;
}

function repairPersistedSessionTimelineOrder(db, statements, sessionId, mapBlock) {
    return db.transaction(() => {
        const stored = storedMessages(statements, sessionId, mapBlock);
        const ordered = projectionMessagesInLogicalOrder(stored);
        persistTimelineOrder(statements, sessionId, stored, ordered);
        return ordered;
    })();
}

function readPersistedTimelineOrder(db, statements, sessionId, mapBlock, { readOnly = false } = {}) {
    if (readOnly) return projectionMessagesInLogicalOrder(storedMessages(statements, sessionId, mapBlock));
    return repairPersistedSessionTimelineOrder(db, statements, sessionId, mapBlock);
}

function repairPersistedTimelineOrder(db, statements, mapBlock) {
    for (const row of db.prepare('SELECT session_id FROM agent_sessions ORDER BY session_id').all()) {
        repairPersistedSessionTimelineOrder(db, statements, row.session_id, mapBlock);
    }
}

module.exports = { readPersistedTimelineOrder, repairPersistedTimelineOrder };
