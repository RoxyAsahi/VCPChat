import { codexSnapshotToProjection } from './agent-workbench-snapshot-projection.js';

function blockIdentity(sessionId, block = {}) {
    const prefix = `block:${sessionId}:`;
    if (block.schemaVersion === 2 && String(block.blockId || '').startsWith(prefix)) return block.blockId;
    return `${prefix}${block.itemId || block.messageId || 'unknown'}:${Number.isInteger(block.ordinal) ? block.ordinal : 0}`;
}

function normalizeBlock(sessionId, threadId, message, block) {
    const itemType = block?.itemType || block?.content?.item?.type || block?.content?.unknown?.type || null;
    const content = block?.kind === 'reasoning'
        ? {
            summary: block.schemaVersion === 2 && Array.isArray(block.content?.summary)
                ? block.content.summary
                : Array.isArray(block.content?.summary) && block.content.summary.length
                    ? block.content.summary : block.content?.text ? [String(block.content.text)] : [],
            content: Array.isArray(block.content?.content) ? block.content.content : [],
        }
        : (block.content && typeof block.content === 'object' ? block.content : { text: String(block.content || '') });
    return {
        schemaVersion: 2,
        blockId: blockIdentity(sessionId, {
            ...block,
            itemId: block.itemId || message?.itemId,
            messageId: block.messageId || message?.messageId,
        }),
        sessionId,
        threadId: threadId || message?.threadId || null,
        turnId: block.turnId || message?.turnId || null,
        itemId: block.itemId || message?.itemId || null,
        messageId: block.messageId || message?.messageId || null,
        callId: block.callId || (itemType === 'dynamicToolCall' ? (block.itemId || message?.itemId) : undefined),
        kind: block.kind || 'message',
        itemType,
        authority: block.authority || 'codex',
        status: block.status || message?.status || 'inProgress',
        sourceOrder: Number.isFinite(Number(block.sourceOrder ?? message?.sourceOrder)) ? Number(block.sourceOrder ?? message.sourceOrder) : 0,
        ordinal: Number.isInteger(block.ordinal) ? block.ordinal : 0,
        content,
        createdAt: block.createdAt || message?.createdAt || Date.now(),
        updatedAt: block.updatedAt || message?.updatedAt || Date.now(),
    };
}

function projectionToNormalized(snapshot = {}) {
    const sessionId = String(snapshot.session?.sessionId || snapshot.sessionId || '');
    const threadId = snapshot.session?.threadId || snapshot.threadId || null;
    const blocks = [];
    for (const message of Array.isArray(snapshot.messages) ? snapshot.messages : []) {
        for (const block of Array.isArray(message.blocks) ? message.blocks : []) {
            blocks.push(normalizeBlock(sessionId, threadId, message, block));
        }
    }
    if (!blocks.length && Array.isArray(snapshot.history)) {
        for (const [index, entry] of snapshot.history.entries()) {
            const itemId = String(entry.itemId || entry.toolCallId || entry.id || `legacy:${index}`);
            const messageId = String(entry.messageId || entry.id || `msg:${sessionId}:${itemId}`);
            const sourceOrder = Number.isFinite(Number(entry.snapshotOrdinal)) ? Number(entry.snapshotOrdinal) : index;
            if (entry.role === 'tool') {
                blocks.push(normalizeBlock(sessionId, threadId, {
                    messageId, itemId, turnId: entry.turnId || null, status: entry.state || 'completed', sourceOrder,
                    createdAt: entry.createdAt || entry.timestamp || 0,
                }, {
                    blockId: `block:${sessionId}:${itemId}:0`, kind: 'tool', itemType: 'dynamicToolCall', ordinal: 0,
                    authority: 'toolbox', status: entry.state || 'completed', sourceOrder,
                    content: {
                        ...(entry.payload && typeof entry.payload === 'object' ? entry.payload : {}),
                        item: { id: itemId, type: 'dynamicToolCall', tool: entry.toolName || entry.payload?.toolName || 'vcp_invoke' },
                    },
                }));
            } else {
                const text = typeof entry.content === 'string' ? entry.content
                    : Array.isArray(entry.content) ? entry.content.map((part) => part?.text || '').join('') : '';
                blocks.push(normalizeBlock(sessionId, threadId, {
                    messageId, itemId, turnId: entry.turnId || null, status: entry.state || 'completed', sourceOrder,
                    createdAt: entry.createdAt || entry.timestamp || 0,
                }, {
                    blockId: `block:${sessionId}:${itemId}:0`, kind: 'message', ordinal: 0,
                    status: entry.state || 'completed', sourceOrder,
                    content: entry.role === 'user' ? { parts: [{ type: 'text', text }] } : { text },
                }));
            }
        }
    }
    return {
        schemaVersion: 2,
        sessionId,
        threadId,
        projectionRevision: Number(snapshot.projectionRevision || snapshot.projection?.mutationGeneration || 0),
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

function applyProjectionSnapshot(state, snapshot) {
    const normalized = snapshot?.normalized?.blocks ? snapshot.normalized : projectionToNormalized(snapshot);
    const next = ensureNormalizedState(state);
    const blocksById = new Map(next.blocksById);
    for (const [id, block] of blocksById) if (block.sessionId === normalized.sessionId) blocksById.delete(id);
    for (const block of normalized.blocks) blocksById.set(block.blockId, block);
    const sessionsById = new Map(next.sessionsById);
    sessionsById.set(normalized.sessionId, {
        ...(sessionsById.get(normalized.sessionId) || {}),
        ...(snapshot.session || {}),
        sessionId: normalized.sessionId,
        threadId: normalized.threadId,
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
        messages: [...grouped.values()].sort((left, right) => left.sourceOrder - right.sourceOrder),
        projection: session.projection || null,
        storage: session.storage || null,
        projectionRevision: Number(normalized.projectionRevisions.get(id) || 0),
    };
    return { snapshot, projection: codexSnapshotToProjection(snapshot) };
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
    sessionProjectionFromState,
};
