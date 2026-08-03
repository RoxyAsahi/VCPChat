import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexRuntimeManager } = require('../modules/codex-runtime/runtimeManager.js');

const manager = new CodexRuntimeManager({ projectRoot: process.cwd() });
const order = [];
let repositoryClosed = false;
let compactionRejected = null;
manager.state = 'ready';
manager.repository = {
    close() { order.push('repository'); repositoryClosed = true; },
    listSessions() { return []; },
    updateActivity() {},
};
manager.transport = { stop: async () => { order.push('transport'); }, respond() {}, respondError() {} };
manager.bridge = { stop: async () => { order.push('bridge'); } };
manager.responsesAdapter = { stop: async () => { order.push('responses'); } };
manager.compactionWaiters.set('thread-1', {
    timeout: setTimeout(() => {}, 60_000),
    sessionId: 'session-1',
    reject(error) { compactionRejected = error; },
});
manager.configApplyPromises.set('session-1', Promise.resolve());
manager.interactionTimers.set('request-1', setTimeout(() => {}, 60_000));
manager.knownOperationRecoveryPromise = Promise.resolve({ recovered: 0 });
const generation = manager._captureGeneration();
const invalidateGeneration = manager.hostService.context.invalidateGeneration;
manager.hostService.context.invalidateGeneration = (reason) => { order.push('generation'); invalidateGeneration(reason); };
manager.interactionService.failClosedNativeApprovals = async () => { order.push('native-approvals'); };
manager.interactionService.failClosedToolboxApprovals = async () => { order.push('toolbox-approvals'); };
manager.configService.clearScheduledApplies = () => { order.push('config-waiters'); manager.configApplyPromises.clear(); };
manager.hostService.rejectCompactionWaiters = (error) => {
    order.push('compaction-waiters');
    manager.compactionWaiters.clear();
    compactionRejected = error;
};
manager.toolboxService.interruptDynamicCalls = async () => { order.push('dynamic-calls'); };
manager.interactionService.clearTimers = () => { order.push('timers'); manager.interactionTimers.clear(); };

await manager.stop();
assert.equal(repositoryClosed, true);
assert.equal(manager.compactionWaiters.size, 0);
assert.equal(manager.configApplyPromises.size, 0);
assert.equal(manager.interactionTimers.size, 0);
assert.equal(manager.knownOperationRecoveryPromise, null);
assert.equal(compactionRejected?.code, 'RUNTIME_STOPPED');
assert.deepEqual(order, [
    'generation', 'native-approvals', 'toolbox-approvals', 'config-waiters',
    'compaction-waiters', 'dynamic-calls', 'timers', 'transport', 'bridge',
    'responses', 'repository', 'timers',
], 'stop must close authority, fail approvals, reject waiters, cancel work, stop processes, then close storage');
assert.throws(() => manager._assertGeneration(generation), /expired generation|stopped/i,
    'operations from a stopped generation must fail before touching a new Runtime');

console.log('Codex Runtime lifecycle tests passed.');
