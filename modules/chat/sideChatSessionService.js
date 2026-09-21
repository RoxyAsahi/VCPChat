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
    snapshotId = null
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
    
    // Filter out uncompleted/transient/generating messages
    return parentHistory
        .filter(msg => {
            if (!msg || typeof msg !== 'object') return false;
            // Exclude transient/thinking/streaming in progress
            if (msg.transient || msg.isStreaming || msg.pending) return false;
            if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') return false;
            return Boolean(msg.content);
        })
        .map(msg => ({
            id: msg.id || null,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp || null,
            isInherited: true
        }));
}

const api = Object.freeze({
    createSideChatDescriptor,
    createChildTopicForAgent,
    freezeParentHistory
});

if (typeof globalThis !== 'undefined') {
    globalThis.VCPSideChatSessionService = api;
}

export default api;
