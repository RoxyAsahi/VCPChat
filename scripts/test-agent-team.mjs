import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TeamCoordinator } = require('../archive/agent-runtime/orchestration/teamCoordinator.js');

const saved = new Map();
let running = 0;
let maxRunning = 0;
const coordinator = new TeamCoordinator({
    persistence: {
        saveRun: async (run) => saved.set(run.id, run),
        loadRun: async (id) => saved.get(id),
    },
    executeMember: async ({ member }) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 15));
        running -= 1;
        return { result: { memberId: member.id }, usage: { tokens: 2, cost: 0.1 } };
    },
});
const run = coordinator.createRun({
    id: 'team-1',
    members: [
        { id: 'planner', role: { id: 'planner', instructions: 'plan' }, task: { kind: 'plan' } },
        { id: 'coder-a', role: 'coder', task: { kind: 'code' } },
        { id: 'coder-b', role: 'coder', task: { kind: 'code' } },
    ],
    waves: [
        { id: 'plan', strategy: 'sequential', memberIds: ['planner'] },
        { id: 'build', strategy: 'parallel', memberIds: ['coder-a', 'coder-b'] },
    ],
    budget: { tokens: 20, cost: 2, concurrency: 2, timeMs: 5000 },
    ownership: [{ memberId: 'coder-a', path: 'C:/workspace/src/a' }],
});
assert.equal(run.state, 'created');
assert.throws(() => coordinator.claimOwnership('team-1', { memberId: 'coder-b', path: 'C:/workspace/src/a/nested' }), /OWNERSHIP_CONFLICT/);
coordinator.claimOwnership('team-1', { memberId: 'coder-b', path: 'C:/workspace/src/b' });
assert.throws(() => coordinator.putBlackboard('team-1', { kind: 'note', key: 'bad', value: 'raw text' }), /structured/);
coordinator.putBlackboard('team-1', { kind: 'decision', key: 'api', value: { choice: 'v1' }, artifactRefs: [{ id: 'spec', uri: 'artifact://spec', hash: 'abc' }] });
coordinator.addHandoff('team-1', { fromMemberId: 'planner', toMemberId: 'coder-a', summary: { next: 'implement' }, artifactRefs: [{ id: 'spec', uri: 'artifact://spec' }] });
const completed = await coordinator.run('team-1');
assert.equal(completed.state, 'completed');
assert.equal(maxRunning, 2, 'parallel wave must honor concurrency and run in parallel');
assert.equal(completed.usage.tokens, 6);
assert.equal(saved.has('team-1'), true);
assert.equal(completed.ownership.some((claim) => claim.path === path.resolve('C:/workspace/src/b').toLowerCase()), true);

const restoredCoordinator = new TeamCoordinator({ persistence: coordinator.persistence, executeMember: async () => ({}) });
assert.equal((await restoredCoordinator.restore('team-1')).blackboard[0].artifactRefs[0].id, 'spec');

let release;
const cancelledMembers = [];
const cancelCoordinator = new TeamCoordinator({
    executeMember: async () => new Promise((resolve) => { release = resolve; }),
    cancelMember: async ({ memberId }) => { cancelledMembers.push(memberId); release?.({}); },
});
cancelCoordinator.createRun({ id: 'cancel-run', members: [{ id: 'slow', role: 'worker' }], waves: [{ strategy: 'adaptive', memberIds: ['slow'] }] });
const runningPromise = cancelCoordinator.run('cancel-run');
await new Promise((resolve) => setTimeout(resolve, 10));
await cancelCoordinator.cancel('cancel-run', 'test');
assert.equal((await runningPromise).state, 'cancelled');
assert.deepEqual(cancelledMembers, ['slow']);

const budgetCoordinator = new TeamCoordinator({ executeMember: async () => ({ usage: { tokens: 10, cost: 0 } }) });
budgetCoordinator.createRun({ id: 'budget-run', members: [{ id: 'over', role: 'worker' }], budget: { tokens: 1, cost: 1 } });
const failed = await budgetCoordinator.run('budget-run');
assert.equal(failed.state, 'failed');
assert.equal(failed.members[0].error.code, 'TEAM_TOKEN_BUDGET_EXCEEDED');
console.log('Agent Runtime team tests passed.');
