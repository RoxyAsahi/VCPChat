'use strict';

function reorderReconciledMessages(statements, sessionId, entries) {
    const rows = statements.listMessages.all(sessionId);
    const incomingIds = [...new Set(entries.map((entry) => String(entry.record.itemId)))];
    const incomingSet = new Set(incomingIds);
    const rowsByItem = new Map(rows.map((row) => [String(row.codex_item_id), row]));
    const orderedIncomingRows = incomingIds.map((itemId) => rowsByItem.get(itemId)).filter(Boolean);
    const incomingSlots = rows.map((row, index) => (incomingSet.has(String(row.codex_item_id)) ? index : -1))
        .filter((index) => index >= 0);
    if (incomingSlots.length !== orderedIncomingRows.length) return;
    const orderedRows = [...rows];
    incomingSlots.forEach((slot, index) => { orderedRows[slot] = orderedIncomingRows[index]; });
    orderedRows.forEach((row, index) => statements.setMessageSourceOrder.run({
        message_id: row.message_id,
        source_order: index + 1,
    }));
    statements.setNextSourceOrder.run({
        session_id: sessionId,
        next_source_order: orderedRows.length + 1,
        now: Date.now(),
    });
}

module.exports = { reorderReconciledMessages };
