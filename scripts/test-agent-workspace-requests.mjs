import assert from 'node:assert/strict';
import { createWorkspaceRequestCoordinator } from '../modules/ui-system/agent-workspace-requests.js';

const cancelled = [];
const coordinator = createWorkspaceRequestCoordinator({ cancel: (token) => cancelled.push(token.requestId) });
const first = coordinator.begin({ key: 'preview', operation: 'preview', sessionId: 'A', workspaceRevision: 'r1', relativePath: 'a.txt' });
const second = coordinator.begin({ key: 'preview', operation: 'preview', sessionId: 'A', workspaceRevision: 'r1', relativePath: 'b.txt' });

assert.deepEqual(cancelled, [first.requestId], 'starting a newer preview must cancel the previous request');
assert.equal(coordinator.isCurrent(first, { sessionId: 'A', relativePath: 'a.txt' }), false);
assert.equal(coordinator.finish(first), false, 'a stale request must not finish the active request slot');
assert.equal(coordinator.isCurrent(second, { sessionId: 'A', workspaceRevision: 'r1', relativePath: 'b.txt' }), true);
assert.equal(coordinator.isCurrent(second, { sessionId: 'B', relativePath: 'b.txt' }), false,
    'a request token must never cross Session identity');
assert.equal(coordinator.finish(second), true);

const search = coordinator.begin({ key: 'search', operation: 'search', sessionId: 'A', relativePath: 'query' });
coordinator.dispose();
assert.ok(cancelled.includes(search.requestId), 'disposing the Workbench must cancel active Workspace requests');
assert.throws(() => coordinator.begin({ key: 'preview', operation: 'preview', sessionId: 'A' }), /disposed/);

console.log('Agent Workspace request coordinator tests passed.');
