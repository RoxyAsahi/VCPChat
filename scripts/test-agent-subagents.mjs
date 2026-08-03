import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SubagentCoordinator } = require('../archive/agent-runtime/orchestration/subagentCoordinator.js');

let childNumber = 0;
const pending = new Map();
const cancelled = [];
const events = [];
const coordinator = new SubagentCoordinator({
    budget: { maxDepth: 2, maxConcurrency: 2, timeMs: 1000, tokens: 100, cost: 2 },
    createChild: async () => ({ sessionId: `child-${++childNumber}` }),
    runChild: ({ childSessionId }) => new Promise((resolve, reject) => pending.set(childSessionId, { resolve, reject })),
    cancelChild: async (request) => { cancelled.push(request.childSessionId); pending.get(request.childSessionId)?.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); },
    onEvent: (event) => events.push(event.type),
});

const one = await coordinator.spawn({ parentSessionId: 'root', task: { prompt: 'one' }, budget: { tokens: 50, cost: 1 } });
const two = await coordinator.spawn({ parentSessionId: one.childSessionId, task: { prompt: 'two' }, budget: { tokens: 30, cost: 0.5 } });
await assert.rejects(() => coordinator.spawn({ parentSessionId: two.childSessionId, task: {}, budget: {} }), /MAX_DEPTH/);
await assert.rejects(() => coordinator.spawn({ parentSessionId: 'root', task: {}, budget: {} }), /CONCURRENCY/);

await coordinator.cancel(one.taskId, 'parent-stop');
const oneFinal = await coordinator.await(one.taskId);
const twoFinal = await coordinator.await(two.taskId);
assert.equal(oneFinal.state, 'cancelled');
assert.equal(twoFinal.state, 'cancelled', 'cancellation must cascade to descendants');
assert.deepEqual(new Set(cancelled), new Set([one.childSessionId, two.childSessionId]));
assert.equal(events.includes('subagent.cancelling'), true);

const budgetCoordinator = new SubagentCoordinator({
    budget: { maxDepth: 1, maxConcurrency: 1, timeMs: 1000, tokens: 5, cost: 1 },
    createChild: async () => ({ sessionId: 'budget-child' }),
    runChild: async () => ({ result: {}, usage: { tokens: 6, cost: 0 } }),
    cancelChild: async () => {},
});
const over = await budgetCoordinator.spawn({ parentSessionId: 'root', task: {}, budget: { tokens: 5 } });
assert.equal((await budgetCoordinator.await(over.taskId)).state, 'failed');
assert.match(budgetCoordinator.get(over.taskId).error.code, /TOKEN_BUDGET/);
console.log('Agent Runtime subagent tests passed.');
