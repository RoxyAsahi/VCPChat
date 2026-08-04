import { codexSnapshotToProjection } from './agent-workbench-snapshot-projection.js';

function blockIdentity(sessionId, block = {}) {
    const prefix = `block:${sessionId}:`;
    if (block.schemaVersion === 2 && String(block.blockId || '').startsWith(prefix)) return block.blockId;
    return `${prefix}${block.itemId || block.messageId || 'unknown'}:${Number.isInteger(block.ordinal) ? block.ordinal : 0}`;
}

function reasoningContent(block = {}) {
    const summary = Array.isArray(block.content?.summary) ? block.content.summary : [];
    const legacySummary = summary.length ? summary
        : block.content?.text ? [String(block.content.text)] : [];
    return {
        summary: block.schemaVersion === 2 ? summary : legacySummary,
        content: Array.isArray(block.content?.content) ? block.content.content : [],
    };
}

function blockContent(block = {}) {
    if (block.kind === 'reasoning') return reasoningContent(block);
    if (block.content && typeof block.content === 'object') return block.content;
    return { text: String(block.content || '') };
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function blockCallId(source, itemType, itemId) {
    if (source.callId) return source.callId;
    return itemType === 'dynamicToolCall' ? itemId : undefined;
}

function normalizeBlock(sessionId, threadId, message, block) {
    const source = block || {};
    const parent = message || {};
    const itemType = source.itemType || source.content?.item?.type || source.content?.unknown?.type || null;
    const itemId = source.itemId || parent.itemId || null;
    const messageId = source.messageId || parent.messageId || null;
    const now = Date.now();
    return {
        schemaVersion: 2,
        blockId: blockIdentity(sessionId, {
            ...source, itemId, messageId,
        }),
        sessionId,
        threadId: threadId || parent.threadId || null,
        turnId: source.turnId || parent.turnId || null,
        itemId,
        messageId,
        callId: blockCallId(source, itemType, itemId),
        kind: source.kind || 'message',
        itemType,
        authority: source.authority || 'codex',
        status: source.status || parent.status || 'inProgress',
        sourceOrder: finiteNumber(source.sourceOrder ?? parent.sourceOrder),
        ordinal: Number.isInteger(source.ordinal) ? source.ordinal : 0,
        content: blockContent(source),
        createdAt: source.createdAt || parent.createdAt || now,
        updatedAt: source.updatedAt || parent.updatedAt || now,
    };
}

function snapshotBlocks(snapshot, sessionId, threadId) {
    const result = [];
    for (const message of Array.isArray(snapshot.messages) ? snapshot.messages : []) {
        for (const block of Array.isArray(message.blocks) ? message.blocks : []) {
            result.push(normalizeBlock(sessionId, threadId, message, block));
        }
    }
    return result;
}

function historyText(entry = {}) {
    if (typeof entry.content === 'string') return entry.content;
    if (!Array.isArray(entry.content)) return '';
    return entry.content.map((part) => part?.text || '').join('');
}

function historyBlock(sessionId, threadId, entry, index) {
    const itemId = String(entry.itemId || entry.toolCallId || entry.id || `legacy:${index}`);
    const messageId = String(entry.messageId || entry.id || `msg:${sessionId}:${itemId}`);
    const sourceOrder = finiteNumber(entry.snapshotOrdinal, index);
    const status = entry.state || 'completed';
    const message = {
        messageId, itemId, turnId: entry.turnId || null, status, sourceOrder,
        createdAt: entry.createdAt || entry.timestamp || 0,
    };
    if (entry.role !== 'tool') {
        const text = historyText(entry);
        const content = entry.role === 'user' ? { parts: [{ type: 'text', text }] } : { text };
        return normalizeBlock(sessionId, threadId, message, {
            kind: 'message', ordinal: 0, status, sourceOrder, content,
        });
    }
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    return normalizeBlock(sessionId, threadId, message, {
        kind: 'tool', itemType: 'dynamicToolCall', ordinal: 0, authority: 'toolbox', status, sourceOrder,
        content: {
            ...payload,
            item: { id: itemId, type: 'dynamicToolCall', tool: entry.toolName || payload.toolName || 'vcp_invoke' },
        },
    });
}

function historyBlocks(snapshot, sessionId, threadId) {
    if (!Array.isArray(snapshot.history)) return [];
    return snapshot.history.map((entry, index) => historyBlock(sessionId, threadId, entry, index));
}

function projectionToNormalized(snapshot = {}) {
    const sessionId = String(snapshot.session?.sessionId || snapshot.sessionId || '');
    const threadId = snapshot.session?.threadId || snapshot.threadId || null;
    const projected = snapshotBlocks(snapshot, sessionId, threadId);
    return {
        schemaVersion: 2,
        sessionId,
        threadId,
        projectionRevision: Number(snapshot.projectionRevision || snapshot.projection?.mutationGeneration || 0),
        blocks: projected.length ? projected : historyBlocks(snapshot, sessionId, threadId),
    };
}

function ensureNormalizedState(state) {
    return {
        sessionsById: state.sessionsById instanceof Map ? state.sessionsById : new Map(),
        blocksById: state.blocksById instanceof Map ? state.blocksById : new Map(),
        projectionRevisions: state.projectionRevisions instanceof Map ? state.projectionRevisions : new Map(),
    };
}

function orderMessagesForTimeline(messages = []) {
    const ordered = [...messages].sort((left, right) => (
        (left.sourceOrder - right.sourceOrder) || (left.createdAt - right.createdAt)
    ));
    const groups = new Map();
    ordered.forEach((message, index) => {
        const key = message.turnId ? `turn:${message.turnId}` : `message:${message.messageId}`;
        const group = groups.get(key) || { key, index, messages: [] };
        group.messages.push(message);
        groups.set(key, group);
    });
    let changed = false;
    const repaired = [...groups.values()].map((group) => {
        const firstUser = group.messages.findIndex((message) => message.role === 'user');
        if (firstUser > 0) changed = true;
        const messagesInTurn = firstUser > 0 ? [
            group.messages[firstUser],
            ...group.messages.slice(0, firstUser),
            ...group.messages.slice(firstUser + 1),
        ] : group.messages;
        return {
            ...group,
            order: firstUser >= 0
                ? Number(group.messages[firstUser].sourceOrder)
                : Math.min(...group.messages.map((message) => Number(message.sourceOrder) || 0)),
            messages: messagesInTurn,
        };
    }).sort((left, right) => (left.order - right.order) || (left.index - right.index));
    const flattened = repaired.flatMap((group) => group.messages);
    return changed ? flattened.map((message, index) => ({ ...message, displayOrder: index + 1 })) : flattened;
}

function applyProjectionSnapshot(state, snapshot) {
    const normalized = snapshot?.normalized?.blocks ? snapshot.normalized : projectionToNormalized(snapshot);
    const next = ensureNormalizedState(state);
    const existingSession = next.sessionsById.get(normalized.sessionId);
    const resolvedThreadId = normalized.threadId || snapshot?.session?.threadId || existingSession?.threadId || null;
    const blocksById = new Map(next.blocksById);
    for (const [id, block] of blocksById) if (block.sessionId === normalized.sessionId) blocksById.delete(id);
    for (const block of normalized.blocks) blocksById.set(block.blockId, block);
    const sessionsById = new Map(next.sessionsById);
    sessionsById.set(normalized.sessionId, {
        ...(sessionsById.get(normalized.sessionId) || {}),
        ...(snapshot.session || {}),
        sessionId: normalized.sessionId,
        threadId: resolvedThreadId,
        projection: snapshot.projection || sessionsById.get(normalized.sessionId)?.projection || null,
        storage: snapshot.storage || sessionsById.get(normalized.sessionId)?.storage || null,
    });
    const projectionRevisions = new Map(next.projectionRevisions);
    projectionRevisions.set(normalized.sessionId, normalized.projectionRevision);
    return { sessionsById, blocksById, projectionRevisions };
}

function sessionProjectionFromState(state, sessionId) {
    const id = String(sessionId || '');
    if (!id) return null;
    const normalized = ensureNormalizedState(state);
    const session = normalized.sessionsById.get(id);
    if (!session) return null;
    const grouped = new Map();
    const blocks = [...normalized.blocksById.values()]
        .filter((block) => block.sessionId === id)
        .sort((left, right) => (left.sourceOrder - right.sourceOrder) || (left.ordinal - right.ordinal));
    for (const block of blocks) {
        const messageId = block.messageId || `msg:${id}:${block.itemId}`;
        const message = grouped.get(messageId) || {
            messageId,
            sessionId: id,
            threadId: block.threadId || session.threadId || null,
            turnId: block.turnId || null,
            itemId: block.itemId,
            role: block.kind === 'message' && block.content?.parts ? 'user' : 'assistant',
            status: block.status,
            sourceOrder: block.sourceOrder,
            createdAt: block.createdAt,
            updatedAt: block.updatedAt,
            blocks: [],
        };
        message.status = block.status || message.status;
        message.updatedAt = Math.max(Number(message.updatedAt) || 0, Number(block.updatedAt) || 0);
        message.blocks.push(block);
        grouped.set(messageId, message);
    }
    const snapshot = {
        session,
        messages: orderMessagesForTimeline([...grouped.values()]),
        projection: session.projection || null,
        storage: session.storage || null,
        projectionRevision: Number(normalized.projectionRevisions.get(id) || 0),
    };
    return { snapshot, projection: codexSnapshotToProjection(snapshot) };
}

function selectedProjectionView(state, sessionId = state?.selectedSessionId) {
    const selected = sessionProjectionFromState(state, sessionId)?.projection || { messages: [], tools: new Map() };
    const ephemeral = state?.ephemeralStateBySession instanceof Map
        ? state.ephemeralStateBySession.get(String(sessionId || '')) : null;
    const pendingMessages = Array.isArray(ephemeral?.pendingMessages) ? ephemeral.pendingMessages : [];
    const confirmedTurns = new Set(selected.messages
        .filter((message) => message.role === 'user' && message.turnId)
        .map((message) => message.turnId));
    return {
        messages: [
            ...selected.messages,
            ...pendingMessages.filter((message) => !confirmedTurns.has(message.turnId)),
        ],
        tools: selected.tools instanceof Map ? selected.tools : new Map(),
    };
}

function applyProjectionPatch(state, patch = {}) {
    const next = ensureNormalizedState(state);
    const sessionId = String(patch.sessionId || '');
    const threadId = String(patch.threadId || '');
    if (patch.schemaVersion !== 1 || !sessionId || !threadId) {
        return { applied: false, reason: 'identity-mismatch', state };
    }
    const session = next.sessionsById.get(sessionId);
    if (session?.threadId && session.threadId !== threadId) {
        return { applied: false, reason: 'identity-mismatch', state };
    }
    const currentRevision = Number(next.projectionRevisions.get(sessionId) || 0);
    const baseRevision = Number(patch.baseProjectionRevision);
    const projectionRevision = Number(patch.projectionRevision);
    if (baseRevision !== currentRevision || !Number.isInteger(projectionRevision)
        || projectionRevision <= baseRevision) {
        return { applied: false, reason: 'revision-gap', state };
    }
    const blocksById = new Map(next.blocksById);
    for (const id of patch.deleteBlockIds || []) {
        const existing = blocksById.get(id);
        if (existing?.sessionId === sessionId) blocksById.delete(id);
    }
    for (const block of patch.upsertBlocks || []) {
        if (block?.schemaVersion !== 2 || block.sessionId !== sessionId || block.threadId !== threadId
            || !String(block.blockId || '').startsWith(`block:${sessionId}:`)) {
            return { applied: false, reason: 'identity-mismatch', state };
        }
        blocksById.set(block.blockId, block);
    }
    const sessionsById = new Map(next.sessionsById);
    sessionsById.set(sessionId, { ...(session || {}), sessionId, threadId });
    const projectionRevisions = new Map(next.projectionRevisions);
    projectionRevisions.set(sessionId, projectionRevision);
    return { applied: true, state: { blocksById, sessionsById, projectionRevisions } };
}

export {
    applyProjectionPatch,
    applyProjectionSnapshot,
    projectionToNormalized,
    normalizeBlock,
    orderMessagesForTimeline,
    selectedProjectionView,
    sessionProjectionFromState,
};
