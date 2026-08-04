import { codexSnapshotToProjection } from './agent-workbench-snapshot-projection.js';

function invalidSnapshot(message) {
    const error = new Error(message);
    error.code = 'INVALID_AGENT_PROJECTION_SNAPSHOT';
    return error;
}

function projectionToNormalized(snapshot = {}) {
    const normalized = snapshot.normalized;
    if (!normalized || normalized.schemaVersion !== 2 || !Array.isArray(normalized.blocks)) {
        throw invalidSnapshot('Agent projection snapshot requires canonical schema-2 blocks');
    }
    const sessionId = String(normalized.sessionId || '').trim();
    const threadId = String(normalized.threadId || '').trim();
    if (!sessionId || snapshot.session?.sessionId !== sessionId) {
        throw invalidSnapshot('Agent projection snapshot Session identity is invalid');
    }
    const blocks = normalized.blocks.map((block) => {
        const itemId = String(block?.itemId || '').trim();
        const messageId = String(block?.messageId || '').trim();
        const ordinal = Number(block?.ordinal);
        const expectedId = `block:${sessionId}:${itemId}:${ordinal}`;
        if (block?.schemaVersion !== 2 || !threadId || block.sessionId !== sessionId
            || block.threadId !== threadId || !itemId || !messageId
            || !Number.isInteger(ordinal) || ordinal < 0 || block.blockId !== expectedId
            || !block.content || typeof block.content !== 'object' || Array.isArray(block.content)) {
            throw invalidSnapshot(`Agent projection snapshot contains an invalid Block: ${block?.blockId || '<missing>'}`);
        }
        return block;
    });
    return {
        schemaVersion: 2,
        sessionId,
        threadId,
        projectionRevision: Number(normalized.projectionRevision || 0),
        blocks,
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
    const normalized = projectionToNormalized(snapshot);
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
    orderMessagesForTimeline,
    selectedProjectionView,
    sessionProjectionFromState,
};
