import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createSideChatDescriptor,
    createChildTopicForAgent,
    freezeParentHistory
} from '../modules/chat/sideChatSessionService.js';

test('createSideChatDescriptor validates parent and childTopicId and enforces distinct topics', () => {
    assert.throws(() => createSideChatDescriptor({ parent: null, childTopicId: 't2' }), /valid parent/);
    assert.throws(() => createSideChatDescriptor({ parent: { itemId: 'a1' }, childTopicId: 't2' }), /valid parent/);
    assert.throws(() => createSideChatDescriptor({ parent: { itemId: 'a1', topicId: 't1' }, childTopicId: null }), /childTopicId/);
    assert.throws(() => createSideChatDescriptor({ parent: { itemId: 'a1', topicId: 't1' }, childTopicId: 't1' }), /must be different/);

    const desc = createSideChatDescriptor({
        parent: { itemId: 'agent-1', topicId: 'topic-main', name: 'Agent 1' },
        childTopicId: 'topic-side-1',
        title: '测试侧聊'
    });

    assert.equal(desc.parent.itemId, 'agent-1');
    assert.equal(desc.parent.topicId, 'topic-main');
    assert.equal(desc.child.itemId, 'agent-1');
    assert.equal(desc.child.topicId, 'topic-side-1');
    assert.equal(desc.title, '测试侧聊');
    assert.equal(desc.contextMode, 'references-only');
    assert.ok(desc.id.startsWith('sidechat-'));
    assert.equal(Object.isFrozen(desc), true);
});

test('createChildTopicForAgent delegates to electronAPI and returns normalized outcome', async () => {
    // Missing API
    const resNoApi = await createChildTopicForAgent({ electronAPI: null, agentId: 'a1' });
    assert.equal(resNoApi.ok, false);
    assert.equal(resNoApi.code, 'IPC_UNAVAILABLE');

    // Missing agent
    const resNoAgent = await createChildTopicForAgent({ electronAPI: { createNewTopicForAgent: async () => {} }, agentId: '' });
    assert.equal(resNoAgent.ok, false);
    assert.equal(resNoAgent.code, 'INVALID_AGENT');

    // Successful creation
    const mockSuccessApi = {
        async createNewTopicForAgent(agentId, title) {
            assert.equal(agentId, 'agent-xyz');
            return { success: true, topicId: 'topic-12345', topicName: title };
        }
    };
    const resSuccess = await createChildTopicForAgent({ electronAPI: mockSuccessApi, agentId: 'agent-xyz', topicTitle: '专属侧聊' });
    assert.equal(resSuccess.ok, true);
    assert.equal(resSuccess.topicId, 'topic-12345');
    assert.equal(resSuccess.topicName, '专属侧聊');

    // Failed creation
    const mockFailApi = {
        async createNewTopicForAgent() {
            return { success: false, error: 'Agent disk is full' };
        }
    };
    const resFail = await createChildTopicForAgent({ electronAPI: mockFailApi, agentId: 'agent-xyz' });
    assert.equal(resFail.ok, false);
    assert.equal(resFail.code, 'CREATE_FAILED');
    assert.equal(resFail.message, 'Agent disk is full');
});

test('freezeParentHistory filters out transient or streaming messages and clones stable ones', () => {
    const raw = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello', timestamp: 100 },
        { role: 'assistant', content: 'Hi there!', timestamp: 200 },
        { role: 'assistant', content: 'Thinking...', isStreaming: true, transient: true },
        { role: 'assistant', content: '', pending: true },
        { role: 'invalid_role', content: 'skip me' }
    ];

    const frozen = freezeParentHistory(raw);
    assert.equal(frozen.length, 3);
    assert.equal(frozen[0].role, 'system');
    assert.equal(frozen[1].role, 'user');
    assert.equal(frozen[1].content, 'Hello');
    assert.equal(frozen[2].role, 'assistant');
    assert.equal(frozen[2].content, 'Hi there!');
    assert.equal(frozen[2].isInherited, true);

    // Verify deep copy
    raw[1].content = 'Mutated';
    assert.equal(frozen[1].content, 'Hello');
});
