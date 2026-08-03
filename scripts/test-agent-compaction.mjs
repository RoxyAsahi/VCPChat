import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentRuntimeManager, buildTranscriptSummary, normalizeContextUsage } = require('../archive/agent-runtime/runtimeManager.js');

const summary = buildTranscriptSummary([
    { role: 'user', content: 'Investigate the failure.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Found the cause.' }] },
], 'Keep decisions');
assert.match(summary, /Keep decisions/);
assert.match(summary, /Found the cause/);
const usage = normalizeContextUsage({ prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, 1000);
assert.deepEqual({ ...usage, updatedAt: 0 }, {
    input: 80, output: 20, totalTokens: 100, contextWindow: 1000, ratio: 0.1, updatedAt: 0,
});
assert.equal(Number.isInteger(usage.updatedAt), true);

const saved = { checkpoints: [], sessions: [], events: [] };
const store = {
    getMessages: () => [
        { messageId: 'msg_1', role: 'user', content: 'First task' },
        { messageId: 'msg_2', role: 'assistant', content: 'First result' },
    ],
    markMessagesCompacted: (sessionId, retained) => { saved.retained = [sessionId, retained]; },
    saveCheckpoint: (record) => saved.checkpoints.push(record),
    saveSession: (record) => saved.sessions.push(record.summary()),
    saveEvent: (record) => saved.events.push(record),
};
const manager = new AgentRuntimeManager({ driver: 'mock', store });
manager.registry.create('mock', { sessionId: 'sess_compact' });
const result = manager.compactSession({ sessionId: 'sess_compact' });
assert.equal(result.facade, 'transcript');
assert.deepEqual(saved.retained, ['sess_compact', 'msg_2']);
assert.equal(saved.checkpoints[0].metadata.facade, 'transcript');
assert.equal(saved.events.at(-1).type, 'context.compaction_completed');

console.log('Agent Runtime transcript compaction facade and context usage tests passed.');
