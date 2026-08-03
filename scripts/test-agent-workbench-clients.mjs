import assert from 'node:assert/strict';
import { CLIENT_METHODS, createWorkbenchClients } from '../modules/ui-system/agent-workbench-clients.js';

const api = { agentSessionRead: (payload) => payload };
const clients = createWorkbenchClients(api);
assert.deepEqual(clients.session.agentSessionRead({ sessionId: 'session-a' }), { sessionId: 'session-a' });
assert.equal(clients.workspace.agentWorkspaceReadPreview, null);
assert.throws(() => clients.require('agentRuntimeReadTopic'), /outside Workbench client boundary/);
assert.throws(() => clients.require('agentWorkspaceReadPreview'), /unavailable/);
assert.equal(new Set(Object.values(CLIENT_METHODS).flat()).size, Object.values(CLIENT_METHODS).flat().length,
    'a preload method must belong to exactly one Workbench client');
console.log('Agent Workbench client boundary tests passed.');
