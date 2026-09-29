// modules/ipc/sideChatHandlers.js
/**
 * Main-process IPC handlers for Workspace Side Chat metadata and parent context snapshots.
 */
'use strict';

let electronModule = null;
try {
    electronModule = require('electron');
} catch {}
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

function filterStableHistory(history = []) {
    if (!Array.isArray(history)) return [];

    const stable = [];
    for (const msg of history) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.transient || msg.isStreaming || msg.pending || msg.isThinking || msg.isPendingStream) continue;
        if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system' && (msg.role !== 'tool' || !msg.tool_call_id)) continue;
        const text = msg.content !== undefined ? msg.content : msg.text;
        const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
        if ((text === undefined || text === null || text === '') && !hasToolCalls) continue;

        const clonedContent = typeof text === 'object' && text !== null ? JSON.parse(JSON.stringify(text)) : (text ?? null);

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

function validateSegment(value) {
    if (typeof value !== 'string' || !value ||
        /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
        value === '.' || value === '..' || /[. ]$/.test(value) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
        return null;
    }
    return value;
}

/**
 * Initializes Side Chat IPC handlers.
 * @param {Object} paths
 * @param {string} paths.USER_DATA_DIR
 * @param {string} [paths.AGENT_DIR]
 * @param {Object} [paths.historyMutationQueue]
 * @param {Object} [paths.ipcMain]
 */
function initialize(paths) {
    const { USER_DATA_DIR, historyMutationQueue, ipcMain: injectedIpcMain } = paths || {};
    const ipc = injectedIpcMain || (electronModule && typeof electronModule === 'object' ? electronModule.ipcMain : null);
    if (!ipc || typeof ipc.handle !== 'function') {
        console.error('[SideChatHandlers] ipcMain is missing or invalid; handlers cannot be registered.');
        return;
    }

    function getTopicDir(agentId, topicId) {
        const safeAgentId = validateSegment(String(agentId || ''));
        const safeTopicId = validateSegment(String(topicId || ''));
        if (!safeAgentId || !safeTopicId) return null;
        return path.join(USER_DATA_DIR, safeAgentId, 'topics', safeTopicId);
    }

    ipc.handle('side-chat:save-metadata', async (event, metadata) => {
        try {
            if (!metadata || typeof metadata !== 'object') {
                return { success: false, error: 'INVALID_METADATA' };
            }
            const agentId = metadata.child?.itemId || metadata.parent?.itemId;
            const childTopicId = metadata.child?.topicId;
            if (!agentId || !childTopicId) {
                return { success: false, error: 'MISSING_AGENT_OR_TOPIC' };
            }

            const topicDir = getTopicDir(agentId, childTopicId);
            if (!topicDir) {
                return { success: false, error: 'INVALID_PATH' };
            }

            await fs.ensureDir(topicDir);
            const metadataPath = path.join(topicDir, 'sidechat-metadata.json');

            const snapshotPath = path.join(topicDir, 'parent-snapshot.json');
            let snapshotBoundary = metadata.snapshotBoundary || null;
            if (!snapshotBoundary && await fs.pathExists(snapshotPath)) {
                try {
                    const snap = await fs.readJson(snapshotPath);
                    snapshotBoundary = snap.snapshotBoundary || null;
                } catch {}
            }

            const payload = {
                schemaVersion: 1,
                id: metadata.id || `sidechat-${Date.now()}`,
                parent: {
                    itemType: 'agent',
                    itemId: String(metadata.parent?.itemId || agentId),
                    topicId: String(metadata.parent?.topicId || ''),
                    name: metadata.parent?.name || null,
                    avatar: metadata.parent?.avatar || null
                },
                child: {
                    itemType: 'agent',
                    itemId: String(agentId),
                    topicId: String(childTopicId)
                },
                title: metadata.title || '侧聊',
                contextMode: metadata.contextMode === 'parent-snapshot' ? 'parent-snapshot' : 'references-only',
                snapshotId: metadata.snapshotId || null,
                snapshotBoundary,
                model: metadata.model || null,
                open: metadata.open !== undefined ? Boolean(metadata.open) : (metadata.status !== 'closed'),
                draft: typeof metadata.draft === 'string' ? metadata.draft : '',
                references: Array.isArray(metadata.references) ? metadata.references : [],
                status: metadata.status || (metadata.open === false ? 'closed' : 'ready'),
                createdAt: metadata.createdAt || Date.now(),
                updatedAt: Date.now()
            };

            await fs.writeJson(metadataPath, payload, { spaces: 2 });
            return { success: true, metadata: payload };
        } catch (error) {
            console.error('[SideChatHandlers] save-metadata error:', error);
            return { success: false, error: error.message };
        }
    });

    ipc.handle('side-chat:get-metadata', async (event, agentId, childTopicId) => {
        try {
            const topicDir = getTopicDir(agentId, childTopicId);
            if (!topicDir) return { success: false, error: 'INVALID_PATH' };

            const metadataPath = path.join(topicDir, 'sidechat-metadata.json');
            if (!await fs.pathExists(metadataPath)) {
                return { success: false, error: 'NOT_FOUND' };
            }

            const metadata = await fs.readJson(metadataPath);
            const snapshotPath = path.join(topicDir, 'parent-snapshot.json');
            if (await fs.pathExists(snapshotPath)) {
                try {
                    const snap = await fs.readJson(snapshotPath);
                    metadata.parentSnapshot = snap.messages || [];
                    if (snap.snapshotBoundary) {
                        metadata.snapshotBoundary = snap.snapshotBoundary;
                    }
                } catch {}
            }
            return { success: true, metadata };
        } catch (error) {
            console.error('[SideChatHandlers] get-metadata error:', error);
            return { success: false, error: error.message };
        }
    });

    ipc.handle('side-chat:list-metadata', async (event, agentId, parentTopicId = null) => {
        try {
            if (!agentId) return { success: false, error: 'MISSING_AGENT_ID' };
            const safeAgentId = validateSegment(String(agentId || ''));
            if (!safeAgentId) return { success: false, error: 'INVALID_AGENT_ID' };
            const topicsDir = path.join(USER_DATA_DIR, safeAgentId, 'topics');

            if (!await fs.pathExists(topicsDir)) {
                return { success: true, items: [] };
            }

            const entries = await fs.readdir(topicsDir, { withFileTypes: true });
            const items = [];

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const entryDir = path.join(topicsDir, entry.name);
                const metadataPath = path.join(entryDir, 'sidechat-metadata.json');
                try {
                    if (await fs.pathExists(metadataPath)) {
                        const meta = await fs.readJson(metadataPath);
                        if (meta && meta.schemaVersion === 1) {
                            if (!parentTopicId || meta.parent?.topicId === parentTopicId) {
                                const snapshotPath = path.join(entryDir, 'parent-snapshot.json');
                                if (await fs.pathExists(snapshotPath)) {
                                    try {
                                        const snap = await fs.readJson(snapshotPath);
                                        meta.parentSnapshot = snap.messages || [];
                                        const boundary = snap.snapshotBoundary || snap.boundary;
                                        if (boundary) {
                                            meta.snapshotBoundary = boundary;
                                        }
                                    } catch {}
                                }
                                items.push(meta);
                            }
                        }
                    }
                } catch {
                    // Ignore corrupted individual metadata files
                }
            }

            // Sort chronologically
            items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
            return { success: true, items };
        } catch (error) {
            console.error('[SideChatHandlers] list-metadata error:', error);
            return { success: false, error: error.message };
        }
    });

    ipc.handle('side-chat:delete-metadata', async (event, agentId, childTopicId) => {
        try {
            const topicDir = getTopicDir(agentId, childTopicId);
            if (!topicDir) return { success: false, error: 'INVALID_PATH' };

            const metadataPath = path.join(topicDir, 'sidechat-metadata.json');

            if (await fs.pathExists(metadataPath)) {
                await fs.remove(metadataPath);
            }

            return { success: true };
        } catch (error) {
            console.error('[SideChatHandlers] delete-metadata error:', error);
            return { success: false, error: error.message };
        }
    });

    ipc.handle('side-chat:create-snapshot', async (event, agentId, parentTopicId, childTopicId = null) => {
        try {
            const parentDir = getTopicDir(agentId, parentTopicId);
            if (!parentDir) return { success: false, error: 'INVALID_PARENT_PATH' };

            let rawHistory = [];
            if (historyMutationQueue && typeof historyMutationQueue.read === 'function') {
                try {
                    rawHistory = await historyMutationQueue.read({ itemId: agentId, itemType: 'agent', topicId: parentTopicId });
                } catch (readErr) {
                    console.error('[SideChatHandlers] create-snapshot history read error:', readErr);
                    return { success: false, error: readErr.message || 'HISTORY_READ_FAILED' };
                }
            } else {
                const parentHistoryPath = path.join(parentDir, 'history.json');
                if (await fs.pathExists(parentHistoryPath)) {
                    rawHistory = await fs.readJson(parentHistoryPath);
                }
            }

            const stableHistory = filterStableHistory(rawHistory);
            const now = Date.now();
            const snapshotId = `snapshot_${now}_${crypto.randomBytes(4).toString('hex')}`;
            const lastMsg = stableHistory[stableHistory.length - 1];
            const snapshotBoundary = {
                lastMessageId: lastMsg?.id || null,
                capturedAt: now,
                messageCount: stableHistory.length
            };

            // If childTopicId is provided, write snapshot into child topic dir
            if (childTopicId) {
                const childDir = getTopicDir(agentId, childTopicId);
                if (childDir) {
                    await fs.ensureDir(childDir);
                    await fs.writeJson(path.join(childDir, 'parent-snapshot.json'), {
                        snapshotId,
                        parentTopicId,
                        boundary: snapshotBoundary,
                        snapshotBoundary,
                        messages: stableHistory
                    }, { spaces: 2 });
                }
            }

            return {
                success: true,
                snapshotId,
                snapshotBoundary,
                messages: stableHistory
            };
        } catch (error) {
            console.error('[SideChatHandlers] create-snapshot error:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initialize,
    filterStableHistory
};
