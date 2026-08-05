import assert from 'node:assert/strict';
import { CLIENT_METHODS, createWorkbenchClients } from '../modules/ui-system/agent-workbench-clients.js';
import {
    createAgentInteractionClient,
    createAgentProjectionClient,
    createAgentSessionClient,
    createAgentWorkspaceClient,
} from '../modules/ui-system/agent-workbench-clients.js';

const api = { agentSessionRead: (payload) => payload };
assert.equal(typeof createAgentSessionClient(api).agentSessionRead, 'function');
assert.equal(createAgentProjectionClient(api).agentRuntimeGetStatus, null);
assert.equal(createAgentInteractionClient(api).agentRuntimeStartTurn, null);
assert.equal(createAgentWorkspaceClient(api).agentWorkspaceReadPreview, null);
const clients = createWorkbenchClients(api);
assert.deepEqual(clients.session.agentSessionRead({ sessionId: 'session-a' }), { sessionId: 'session-a' });
assert.equal(Object.prototype.hasOwnProperty.call(clients.session, 'agentRuntimeReadSessionDiagnostics'), true,
    'authoritative Session diagnostics must stay inside the Session client boundary');
assert.equal(clients.workspace.agentWorkspaceReadPreview, null);
assert.throws(() => clients.require('agentRuntimeReadTopic'), /outside Workbench client boundary/);
assert.throws(() => clients.require('agentWorkspaceReadPreview'), /unavailable/);
assert.equal(new Set(Object.values(CLIENT_METHODS).flat()).size, Object.values(CLIENT_METHODS).flat().length,
    'a preload method must belong to exactly one Workbench client');
console.log('Agent Workbench client boundary tests passed.');
