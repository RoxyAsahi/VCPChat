// modules/ipc/sideChatHandlers.js
/**
 * Main-process IPC handlers for Workspace Side Chat metadata and parent context snapshots.
 */
'use strict';

const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

function filterStableHistory(history = []) {
    if (!Array.isArray(history)) return [];

    const stable = [];
    for (const msg of history) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.transient || msg.isStreaming || msg.pending) continue;
        if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') continue;
        if (!msg.content) continue;

        stable.push({
            id: msg.id || null,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp || null,
            isInherited: true
        });
    }

    return stable;
}

/**
 * Initializes Side Chat IPC handlers.
 * @param {Object} paths
 * @param {string} paths.USER_DATA_DIR
 * @param {string} [paths.AGENT_DIR]
 */
function initialize(paths) {
    const { USER_DATA_DIR } = paths || {};
    if (!USER_DATA_DIR) {
        console.error('[SideChatHandlers] USER_DATA_DIR is missing; handlers cannot be registered.');
        return;
    }

    function getTopicDir(agentId, topicId) {
        if (!agentId || !topicId) return null;
        // Sanitize path components to prevent directory traversal
        const safeAgentId = String(agentId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeTopicId = String(topicId).replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(USER_DATA_DIR, safeAgentId, 'topics', safeTopicId);
    }

    ipcMain.handle('side-chat:save-metadata', async (event, metadata) => {
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
                snapshotBoundary: metadata.snapshotBoundary || null,
                status: metadata.status || 'ready',
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

    ipcMain.handle('side-chat:get-metadata', async (event, agentId, childTopicId) => {
        try {
            const topicDir = getTopicDir(agentId, childTopicId);
            if (!topicDir) return { success: false, error: 'INVALID_PATH' };

            const metadataPath = path.join(topicDir, 'sidechat-metadata.json');
            if (!await fs.pathExists(metadataPath)) {
                return { success: false, error: 'NOT_FOUND' };
            }

            const metadata = await fs.readJson(metadataPath);
            return { success: true, metadata };
        } catch (error) {
            console.error('[SideChatHandlers] get-metadata error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('side-chat:list-metadata', async (event, agentId, parentTopicId = null) => {
        try {
            if (!agentId) return { success: false, error: 'MISSING_AGENT_ID' };
            const safeAgentId = String(agentId).replace(/[^a-zA-Z0-9_-]/g, '_');
            const topicsDir = path.join(USER_DATA_DIR, safeAgentId, 'topics');

            if (!await fs.pathExists(topicsDir)) {
                return { success: true, items: [] };
            }

            const entries = await fs.readdir(topicsDir, { withFileTypes: true });
            const items = [];

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const metadataPath = path.join(topicsDir, entry.name, 'sidechat-metadata.json');
                try {
                    if (await fs.pathExists(metadataPath)) {
                        const meta = await fs.readJson(metadataPath);
                        if (meta && meta.schemaVersion === 1) {
                            if (!parentTopicId || meta.parent?.topicId === parentTopicId) {
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

    ipcMain.handle('side-chat:delete-metadata', async (event, agentId, childTopicId) => {
        try {
            const topicDir = getTopicDir(agentId, childTopicId);
            if (!topicDir) return { success: false, error: 'INVALID_PATH' };

            const metadataPath = path.join(topicDir, 'sidechat-metadata.json');
            const snapshotPath = path.join(topicDir, 'parent-snapshot.json');

            if (await fs.pathExists(metadataPath)) {
                await fs.remove(metadataPath);
            }
            if (await fs.pathExists(snapshotPath)) {
                await fs.remove(snapshotPath);
            }

            return { success: true };
        } catch (error) {
            console.error('[SideChatHandlers] delete-metadata error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('side-chat:create-snapshot', async (event, agentId, parentTopicId, childTopicId = null) => {
        try {
            const parentDir = getTopicDir(agentId, parentTopicId);
            if (!parentDir) return { success: false, error: 'INVALID_PARENT_PATH' };

            const parentHistoryPath = path.join(parentDir, 'history.json');
            let rawHistory = [];
            if (await fs.pathExists(parentHistoryPath)) {
                rawHistory = await fs.readJson(parentHistoryPath);
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
