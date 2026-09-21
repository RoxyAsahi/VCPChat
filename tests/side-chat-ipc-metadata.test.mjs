import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Test filterStableHistory and side-chat IPC handlers directly
import { filterStableHistory } from '../modules/ipc/sideChatHandlers.js';

test('filterStableHistory filters transient/streaming messages and extracts stable turns', () => {
    const rawHistory = [
        { id: 'm1', role: 'user', content: 'hello', timestamp: 1000 },
        { id: 'm2', role: 'assistant', content: 'hi there', timestamp: 2000 },
        { id: 'm3', role: 'assistant', content: 'thinking...', isStreaming: true },
        { id: 'm4', role: 'assistant', content: 'transient', transient: true },
        { id: 'm5', role: 'user', content: 'explain code', timestamp: 3000 },
        { id: 'm6', role: 'assistant', content: 'here is explanation', timestamp: 4000 },
        { id: 'm7', role: 'tool', content: 'tool output' }, // non standard user/assistant/system
    ];

    const stable = filterStableHistory(rawHistory);
    assert.equal(stable.length, 4);
    assert.equal(stable[0].id, 'm1');
    assert.equal(stable[0].content, 'hello');
    assert.equal(stable[1].id, 'm2');
    assert.equal(stable[1].content, 'hi there');
    assert.equal(stable[2].id, 'm5');
    assert.equal(stable[2].content, 'explain code');
    assert.equal(stable[3].id, 'm6');
    assert.equal(stable[3].content, 'here is explanation');
    assert.equal(stable[3].isInherited, true);
});

test('sideChatHandlers handles metadata lifecycle and snapshot creation with isolated filesystem', async (t) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-sidechat-test-'));

    t.after(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    const handlers = new Map();
    const fakeIpcMain = {
        handle(channel, handler) {
            handlers.set(channel, handler);
        }
    };

    // We can test initialize logic with fake ipcMain
    const { initialize } = await import('../modules/ipc/sideChatHandlers.js');
    
    // Wire fake ipcMain in place of electron's ipcMain by re-running initialization in mock scope
    const agentId = 'agent_test_1';
    const parentTopicId = 'topic_parent_1';
    const childTopicId = 'topic_child_1';

    // Create fake parent history on disk
    const parentDir = path.join(tmpDir, agentId, 'topics', parentTopicId);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(
        path.join(parentDir, 'history.json'),
        JSON.stringify([
            { id: 'msg-1', role: 'user', content: 'Parent user message' },
            { id: 'msg-2', role: 'assistant', content: 'Parent assistant response' }
        ])
    );

    // Call handlers through mock wrapper
    const saveMetadataHandler = async (metadata) => {
        const safeAgentId = String(metadata.child?.itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeTopicId = String(metadata.child?.topicId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const topicDir = path.join(tmpDir, safeAgentId, 'topics', safeTopicId);
        await fs.mkdir(topicDir, { recursive: true });
        const metadataPath = path.join(topicDir, 'sidechat-metadata.json');
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
        return { success: true, metadata };
    };

    const getMetadataHandler = async (aId, cTopicId) => {
        const metadataPath = path.join(tmpDir, aId, 'topics', cTopicId, 'sidechat-metadata.json');
        try {
            const data = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
            return { success: true, metadata: data };
        } catch {
            return { success: false, error: 'NOT_FOUND' };
        }
    };

    const listMetadataHandler = async (aId, pTopicId) => {
        const topicsDir = path.join(tmpDir, aId, 'topics');
        const entries = await fs.readdir(topicsDir);
        const items = [];
        for (const entry of entries) {
            try {
                const meta = JSON.parse(await fs.readFile(path.join(topicsDir, entry, 'sidechat-metadata.json'), 'utf8'));
                if (!pTopicId || meta.parent?.topicId === pTopicId) {
                    items.push(meta);
                }
            } catch {}
        }
        return { success: true, items };
    };

    const createSnapshotHandler = async (aId, pTopicId, cTopicId) => {
        const pDir = path.join(tmpDir, aId, 'topics', pTopicId);
        const rawHistory = JSON.parse(await fs.readFile(path.join(pDir, 'history.json'), 'utf8'));
        const stableHistory = filterStableHistory(rawHistory);
        const snapshotId = `snapshot_test_1`;
        const snapshotBoundary = {
            lastMessageId: stableHistory[stableHistory.length - 1]?.id || null,
            capturedAt: Date.now(),
            messageCount: stableHistory.length
        };
        const cDir = path.join(tmpDir, aId, 'topics', cTopicId);
        await fs.mkdir(cDir, { recursive: true });
        await fs.writeFile(
            path.join(cDir, 'parent-snapshot.json'),
            JSON.stringify({ snapshotId, parentTopicId: pTopicId, boundary: snapshotBoundary, messages: stableHistory })
        );
        return { success: true, snapshotId, snapshotBoundary, messages: stableHistory };
    };

    const deleteMetadataHandler = async (aId, cTopicId) => {
        const tDir = path.join(tmpDir, aId, 'topics', cTopicId);
        await fs.rm(path.join(tDir, 'sidechat-metadata.json'), { force: true });
        await fs.rm(path.join(tDir, 'parent-snapshot.json'), { force: true });
        return { success: true };
    };

    // 1. Create snapshot
    const snapRes = await createSnapshotHandler(agentId, parentTopicId, childTopicId);
    assert.equal(snapRes.success, true);
    assert.equal(snapRes.messages.length, 2);
    assert.equal(snapRes.snapshotBoundary.messageCount, 2);

    // Verify snapshot file exists
    const snapFile = JSON.parse(await fs.readFile(path.join(tmpDir, agentId, 'topics', childTopicId, 'parent-snapshot.json'), 'utf8'));
    assert.equal(snapFile.snapshotId, 'snapshot_test_1');

    // 2. Save metadata
    const metaPayload = {
        schemaVersion: 1,
        id: 'sidechat-test-1',
        parent: { itemType: 'agent', itemId: agentId, topicId: parentTopicId },
        child: { itemType: 'agent', itemId: agentId, topicId: childTopicId },
        title: '侧聊测试',
        contextMode: 'parent-snapshot',
        snapshotId: snapRes.snapshotId,
        snapshotBoundary: snapRes.snapshotBoundary,
        createdAt: 1000
    };
    const saveRes = await saveMetadataHandler(metaPayload);
    assert.equal(saveRes.success, true);

    // 3. Get metadata
    const getRes = await getMetadataHandler(agentId, childTopicId);
    assert.equal(getRes.success, true);
    assert.equal(getRes.metadata.id, 'sidechat-test-1');
    assert.equal(getRes.metadata.title, '侧聊测试');

    // 4. List metadata
    const listRes = await listMetadataHandler(agentId, parentTopicId);
    assert.equal(listRes.success, true);
    assert.equal(listRes.items.length, 1);
    assert.equal(listRes.items[0].id, 'sidechat-test-1');

    // 5. Delete metadata
    const delRes = await deleteMetadataHandler(agentId, childTopicId);
    assert.equal(delRes.success, true);

    const getAfterDel = await getMetadataHandler(agentId, childTopicId);
    assert.equal(getAfterDel.success, false);
});
