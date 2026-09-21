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

    // Wire fake ipcMain in place of electron's ipcMain by running real initialize
    initialize({ USER_DATA_DIR: tmpDir, ipcMain: fakeIpcMain });

    const saveMetadataHandler = (metadata) => handlers.get('side-chat:save-metadata')({}, metadata);
    const getMetadataHandler = (aId, cTopicId) => handlers.get('side-chat:get-metadata')({}, aId, cTopicId);
    const listMetadataHandler = (aId, pTopicId) => handlers.get('side-chat:list-metadata')({}, aId, pTopicId);
    const createSnapshotHandler = (aId, pTopicId, cTopicId) => handlers.get('side-chat:create-snapshot')({}, aId, pTopicId, cTopicId);
    const deleteMetadataHandler = (aId, cTopicId) => handlers.get('side-chat:delete-metadata')({}, aId, cTopicId);

    // 1. Create snapshot
    const snapRes = await createSnapshotHandler(agentId, parentTopicId, childTopicId);
    assert.equal(snapRes.success, true);
    assert.equal(snapRes.messages.length, 2);
    assert.equal(snapRes.snapshotBoundary.messageCount, 2);

    // Verify snapshot file exists
    const snapFile = JSON.parse(await fs.readFile(path.join(tmpDir, agentId, 'topics', childTopicId, 'parent-snapshot.json'), 'utf8'));
    assert.equal(snapFile.snapshotId, snapRes.snapshotId);

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

    // 6. Adversarial: Path traversal attempts must be rejected
    const maliciousRes = await getMetadataHandler('../../etc', 'passwd');
    assert.equal(maliciousRes.success, false);
    assert.equal(maliciousRes.error, 'INVALID_PATH');

    // 7. Adversarial: Unicode/Chinese agent and topic IDs must be preserved cleanly
    const unicodeAgentId = '智能助手小艾';
    const unicodeParentTopicId = '主对话_2026';
    const unicodeChildTopicId = '侧聊_分支1';
    const unicodeParentDir = path.join(tmpDir, unicodeAgentId, 'topics', unicodeParentTopicId);
    await fs.mkdir(unicodeParentDir, { recursive: true });
    await fs.writeFile(path.join(unicodeParentDir, 'history.json'), JSON.stringify([
        { id: 'u1', role: 'user', content: '请问你能做什么？', timestamp: 5000 },
        { id: 'u2', role: 'assistant', content: '我可以帮你分析代码。', timestamp: 6000 }
    ]), 'utf8');

    const unicodeSnap = await createSnapshotHandler(unicodeAgentId, unicodeParentTopicId, unicodeChildTopicId);
    assert.equal(unicodeSnap.success, true);
    assert.equal(unicodeSnap.messages.length, 2);
    assert.equal(unicodeSnap.messages[0].content, '请问你能做什么？');

    // Verify snapshot written inside unicode path
    const childSnapshotFile = path.join(tmpDir, unicodeAgentId, 'topics', unicodeChildTopicId, 'parent-snapshot.json');
    const childSnapshotData = JSON.parse(await fs.readFile(childSnapshotFile, 'utf8'));
    assert.equal(childSnapshotData.messages.length, 2);
});

