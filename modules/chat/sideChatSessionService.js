/* sideChatSessionService.js
 * Service for managing Side Chat sessions, child topic descriptors, and persistence boundaries.
 */
'use strict';

/**
 * Creates a normalized SideChatDescriptor.
 * @param {Object} options
 * @param {Object} options.parent - Parent conversation reference { itemId, topicId, name, avatar }
 * @param {string} options.childTopicId - Child topic ID
 * @param {string} [options.title] - Human-readable title
 * @param {'references-only'|'parent-snapshot'} [options.contextMode='references-only']
 * @returns {Object} SideChatDescriptor
 */
export function createSideChatDescriptor({
    parent,
    childTopicId,
    title = null,
    contextMode = 'references-only',
    snapshotId = null,
    parentSnapshot = []
}) {
    if (!parent || !parent.itemId || !parent.topicId) {
        throw new TypeError('SideChatDescriptor requires a valid parent reference with itemId and topicId');
    }
    if (!childTopicId) {
        throw new TypeError('SideChatDescriptor requires a childTopicId');
    }

    const itemId = String(parent.itemId);
    const parentTopicId = String(parent.topicId);
    const childId = String(childTopicId);

    if (parentTopicId === childId) {
        throw new Error('Side chat child topicId must be different from parent topicId');
    }

    const now = Date.now();
    const timeStr = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const resolvedTitle = title || `侧聊 ${timeStr}`;
    const id = `sidechat-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    return Object.freeze({
        schemaVersion: 1,
        id,
        parent: Object.freeze({
            itemType: 'agent',
            itemId,
            topicId: parentTopicId,
            name: parent.name || null,
            avatar: parent.avatar || null,
        }),
        child: Object.freeze({
            itemType: 'agent',
            itemId,
            topicId: childId,
        }),
        title: resolvedTitle,
        createdAt: now,
        contextMode: contextMode === 'parent-snapshot' ? 'parent-snapshot' : 'references-only',
        snapshotId: snapshotId || null,
        parentSnapshot: Array.isArray(parentSnapshot) ? Object.freeze([...parentSnapshot]) : Object.freeze([]),
    });
}

/**
 * Creates a new child topic for an agent using Electron IPC without mutating main chat state.
 * @param {Object} options
 * @param {Object} options.electronAPI
 * @param {string} options.agentId
 * @param {string} [options.topicTitle]
 * @returns {Promise<{ ok: true, topicId: string, topicName: string } | { ok: false, code: string, message: string }>}
 */
export async function createChildTopicForAgent({
    electronAPI,
    agentId,
    topicTitle = null
}) {
    if (!electronAPI || typeof electronAPI.createNewTopicForAgent !== 'function') {
        return {
            ok: false,
            code: 'IPC_UNAVAILABLE',
            message: 'electronAPI.createNewTopicForAgent is unavailable'
        };
    }
    if (!agentId) {
        return {
            ok: false,
            code: 'INVALID_AGENT',
            message: 'agentId is required to create a child topic'
        };
    }

    const title = topicTitle || `侧聊 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    try {
        const result = await electronAPI.createNewTopicForAgent(agentId, title);
        if (result && result.success === true && result.topicId) {
            return {
                ok: true,
                topicId: result.topicId,
                topicName: result.topicName || title
            };
        }
        return {
            ok: false,
            code: 'CREATE_FAILED',
            message: result?.error || 'Failed to create child topic'
        };
    } catch (error) {
        return {
            ok: false,
            code: 'CREATE_ERROR',
            message: error?.message || String(error)
        };
    }
}

/**
 * Freezes stable parent context for P1 snapshot inheritance.
 * @param {Object} options
 * @param {Array} options.parentHistory - Array of messages from parent conversation
 * @returns {Array} Deep-cloned stable message array excluding transient/uncompleted messages
 */
export function freezeParentHistory(parentHistory = []) {
    if (!Array.isArray(parentHistory)) return [];
    
    const stable = [];
    for (const msg of parentHistory) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.transient || msg.isStreaming || msg.pending || msg.isThinking || msg.isPendingStream) continue;
        if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system' && (msg.role !== 'tool' || !msg.tool_call_id)) continue;
        const text = msg.content !== undefined ? msg.content : msg.text;
        if (text === undefined || text === null || text === '') continue;

        const clonedContent = typeof text === 'object' ? JSON.parse(JSON.stringify(text)) : text;

        const entry = {
            id: msg.id || null,
            sourceMessageId: msg.id || null,
            role: msg.role,
            content: clonedContent,
            timestamp: msg.timestamp || null,
            isInherited: true
        };

        if (msg.tool_calls) {
            entry.tool_calls = JSON.parse(JSON.stringify(msg.tool_calls));
        }
        if (msg.tool_call_id) {
            entry.tool_call_id = msg.tool_call_id;
        }
        if (msg.attachments) {
            entry.attachments = JSON.parse(JSON.stringify(msg.attachments));
        }

        stable.push(entry);
    }

    return stable;
}

/**
 * Saves side chat metadata via IPC with fallback.
 */
export async function saveSideChatMetadata({ electronAPI, metadata }) {
    if (!metadata || !metadata.child?.itemId || !metadata.child?.topicId) {
        return { ok: false, code: 'INVALID_METADATA', message: 'Invalid metadata structure' };
    }
    try {
        if (typeof electronAPI?.saveSideChatMetadata === 'function') {
            const res = await electronAPI.saveSideChatMetadata(metadata);
            return res?.success ? { ok: true, metadata: res.metadata } : { ok: false, code: 'SAVE_FAILED', message: res?.error || 'Save failed' };
        }
        if (typeof electronAPI?.invoke === 'function') {
            const res = await electronAPI.invoke('side-chat:save-metadata', metadata);
            return res?.success ? { ok: true, metadata: res.metadata } : { ok: false, code: 'SAVE_FAILED', message: res?.error || 'Save failed' };
        }
        return { ok: false, code: 'UNSUPPORTED', message: 'IPC unavailable' };
    } catch (err) {
        return { ok: false, code: 'SAVE_ERROR', message: err.message || String(err) };
    }
}

/**
 * Gets side chat metadata for child topic.
 */
export async function getSideChatMetadata({ electronAPI, agentId, childTopicId }) {
    if (!agentId || !childTopicId) {
        return { ok: false, code: 'INVALID_PARAMS', message: 'agentId and childTopicId are required' };
    }
    try {
        if (typeof electronAPI?.getSideChatMetadata === 'function') {
            const res = await electronAPI.getSideChatMetadata(agentId, childTopicId);
            return res?.success ? { ok: true, metadata: res.metadata } : { ok: false, code: res?.error || 'NOT_FOUND', message: 'Metadata not found' };
        }
        if (typeof electronAPI?.invoke === 'function') {
            const res = await electronAPI.invoke('side-chat:get-metadata', agentId, childTopicId);
            return res?.success ? { ok: true, metadata: res.metadata } : { ok: false, code: res?.error || 'NOT_FOUND', message: 'Metadata not found' };
        }
        return { ok: false, code: 'UNSUPPORTED', message: 'IPC unavailable' };
    } catch (err) {
        return { ok: false, code: 'GET_ERROR', message: err.message || String(err) };
    }
}

/**
 * Lists side chats belonging to parent.
 */
export async function listSideChatsForParent({ electronAPI, agentId, parentTopicId = null }) {
    if (!agentId) {
        return { ok: false, code: 'INVALID_AGENT', message: 'agentId is required' };
    }
    try {
        if (typeof electronAPI?.listSideChatMetadata === 'function') {
            const res = await electronAPI.listSideChatMetadata(agentId, parentTopicId);
            return res?.success ? { ok: true, items: res.items || [] } : { ok: false, code: 'LIST_FAILED', message: res?.error || 'Failed to list' };
        }
        if (typeof electronAPI?.invoke === 'function') {
            const res = await electronAPI.invoke('side-chat:list-metadata', agentId, parentTopicId);
            return res?.success ? { ok: true, items: res.items || [] } : { ok: false, code: 'LIST_FAILED', message: res?.error || 'Failed to list' };
        }
        return { ok: true, items: [] };
    } catch (err) {
        return { ok: false, code: 'LIST_ERROR', message: err.message || String(err) };
    }
}

/**
 * Deletes side chat metadata for child topic.
 */
export async function deleteSideChatMetadata({ electronAPI, agentId, childTopicId }) {
    if (!agentId || !childTopicId) {
        return { ok: false, code: 'INVALID_PARAMS', message: 'agentId and childTopicId are required' };
    }
    try {
        if (typeof electronAPI?.deleteSideChatMetadata === 'function') {
            const res = await electronAPI.deleteSideChatMetadata(agentId, childTopicId);
            return res?.success ? { ok: true } : { ok: false, code: 'DELETE_FAILED', message: res?.error || 'Failed to delete' };
        }
        if (typeof electronAPI?.invoke === 'function') {
            const res = await electronAPI.invoke('side-chat:delete-metadata', agentId, childTopicId);
            return res?.success ? { ok: true } : { ok: false, code: 'DELETE_FAILED', message: res?.error || 'Failed to delete' };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, code: 'DELETE_ERROR', message: err.message || String(err) };
    }
}

/**
 * Creates parent snapshot on backend or falls back to local freeze.
 */
export async function createParentSnapshot({
    electronAPI,
    agentId,
    parentTopicId,
    childTopicId = null,
    fallbackHistory = []
}) {
    try {
        if (typeof electronAPI?.createSideChatSnapshot === 'function') {
            const res = await electronAPI.createSideChatSnapshot(agentId, parentTopicId, childTopicId);
            if (res?.success) {
                return {
                    ok: true,
                    snapshotId: res.snapshotId,
                    snapshotBoundary: res.snapshotBoundary,
                    messages: res.messages || []
                };
            }
            if (res && res.success === false) {
                return { ok: false, code: 'SNAPSHOT_FAILED', error: res.error || 'Snapshot failed' };
            }
        }
        if (typeof electronAPI?.invoke === 'function') {
            const res = await electronAPI.invoke('side-chat:create-snapshot', agentId, parentTopicId, childTopicId);
            if (res?.success) {
                return {
                    ok: true,
                    snapshotId: res.snapshotId,
                    snapshotBoundary: res.snapshotBoundary,
                    messages: res.messages || []
                };
            }
            if (res && res.success === false) {
                return { ok: false, code: 'SNAPSHOT_FAILED', error: res.error || 'Snapshot failed' };
            }
        }
    } catch (err) {
        return { ok: false, code: 'SNAPSHOT_ERROR', error: err.message || String(err) };
    }

    const messages = freezeParentHistory(fallbackHistory);
    const now = Date.now();
    const lastMsg = messages[messages.length - 1];
    return {
        ok: true,
        snapshotId: `local-snapshot-${now}`,
        snapshotBoundary: {
            lastMessageId: lastMsg?.id || null,
            capturedAt: now,
            messageCount: messages.length
        },
        messages
    };
}

const api = Object.freeze({
    createSideChatDescriptor,
    createChildTopicForAgent,
    freezeParentHistory,
    saveSideChatMetadata,
    getSideChatMetadata,
    listSideChatsForParent,
    deleteSideChatMetadata,
    createParentSnapshot
});

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSideChatSessionService = api;
}

export default api;
