'use strict';

function turnKey(value) {
    return String(value || '');
}

function mergeTurnRows(incomingRows, retainedRows, rowsBefore, incomingSet) {
    if (!retainedRows.length) return incomingRows;
    const incomingById = new Map(incomingRows.map((row) => [String(row.codex_item_id), row]));
    const retainedById = new Map(retainedRows.map((row) => [String(row.codex_item_id), row]));
    const before = rowsBefore.filter((row) => (
        incomingById.has(String(row.codex_item_id)) || retainedById.has(String(row.codex_item_id))
    ));
    const beforeIncoming = before.filter((row) => incomingSet.has(String(row.codex_item_id)));

    // When live projection already observed Codex Items around a local ToolBox
    // Item, those Items are stable anchors and preserve its exact position.
    if (beforeIncoming.length) {
        const result = [...incomingRows];
        for (const row of retainedRows) {
            const position = before.findIndex((candidate) => candidate.message_id === row.message_id);
            const previous = [...before.slice(0, position)].reverse()
                .find((candidate) => incomingSet.has(String(candidate.codex_item_id)));
            const next = before.slice(position + 1)
                .find((candidate) => incomingSet.has(String(candidate.codex_item_id)));
            if (previous) {
                let index = result.findIndex((candidate) => candidate.message_id === previous.message_id) + 1;
                while (index < result.length && retainedById.has(String(result[index].codex_item_id))) index += 1;
                result.splice(index, 0, row);
            } else if (next) {
                const index = result.findIndex((candidate) => candidate.message_id === next.message_id);
                result.splice(Math.max(0, index), 0, row);
            } else {
                result.push(row);
            }
        }
        return result;
    }

    // App Server 0.146 may omit client-executed dynamicToolCall Items from a
    // later thread/read. If the Codex Items were not projected live, the only
    // durable rows before reconciliation are those tools. Re-anchor them after
    // the Turn's user Item instead of leaving every tool at the global top.
    const firstUser = incomingRows.findIndex((row) => row.role === 'user');
    const insertAt = firstUser >= 0 ? firstUser + 1 : Math.min(1, incomingRows.length);
    return [
        ...incomingRows.slice(0, insertAt),
        ...retainedRows,
        ...incomingRows.slice(insertAt),
    ];
}

function reorderReconciledMessages(statements, sessionId, entries, rowsBefore = []) {
    const rows = statements.listMessages.all(sessionId);
    const incomingIds = [...new Set(entries.map((entry) => String(entry.record.itemId)))];
    const incomingSet = new Set(incomingIds);
    const rowsByItem = new Map(rows.map((row) => [String(row.codex_item_id), row]));
    const turnOrder = [];
    const incomingByTurn = new Map();
    for (const entry of entries) {
        const key = turnKey(entry.record.turnId);
        if (!incomingByTurn.has(key)) {
            incomingByTurn.set(key, []);
            turnOrder.push(key);
        }
        const row = rowsByItem.get(String(entry.record.itemId));
        if (row) incomingByTurn.get(key).push(row);
    }
    if (incomingIds.some((itemId) => !rowsByItem.has(itemId))) return;

    const knownTurns = new Set(turnOrder);
    const retainedByTurn = new Map(turnOrder.map((key) => [key, []]));
    for (const row of rows) {
        const key = turnKey(row.codex_turn_id);
        if (knownTurns.has(key) && !incomingSet.has(String(row.codex_item_id))) {
            retainedByTurn.get(key).push(row);
        }
    }
    const beforeByTurn = new Map(turnOrder.map((key) => [
        key, rowsBefore.filter((row) => turnKey(row.codex_turn_id) === key),
    ]));
    const reconciledRows = turnOrder.flatMap((key) => mergeTurnRows(
        incomingByTurn.get(key), retainedByTurn.get(key), beforeByTurn.get(key), incomingSet,
    ));

    const firstIncomingIndex = rows.findIndex((row) => incomingSet.has(String(row.codex_item_id)));
    const insertionIndex = firstIncomingIndex < 0 ? rows.length : rows.slice(0, firstIncomingIndex)
        .filter((row) => !knownTurns.has(turnKey(row.codex_turn_id))).length;
    const outsideRows = rows.filter((row) => !knownTurns.has(turnKey(row.codex_turn_id)));
    const orderedRows = [
        ...outsideRows.slice(0, insertionIndex),
        ...reconciledRows,
        ...outsideRows.slice(insertionIndex),
    ];
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
