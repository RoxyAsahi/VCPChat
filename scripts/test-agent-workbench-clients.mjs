import assert from 'node:assert/strict';
import { CLIENT_METHODS, createWorkbenchClients } from '../modules/ui-system/agent-workbench-clients.js';
import { createAgentSessionClient } from '../modules/ui-system/agent-session-client.js';
import { createAgentProjectionClient } from '../modules/ui-system/agent-projection-client.js';
import { createAgentInteractionClient } from '../modules/ui-system/agent-interaction-client.js';
import { createAgentWorkspaceClient } from '../modules/ui-system/agent-workspace-client.js';

const api = { agentSessionRead: (payload) => payload };
assert.equal(typeof createAgentSessionClient(api).agentSessionRead, 'function');
assert.equal(createAgentProjectionClient(api).agentRuntimeGetStatus, null);
assert.equal(createAgentInteractionClient(api).agentRuntimeStartTurn, null);
assert.equal(createAgentWorkspaceClient(api).agentWorkspaceReadPreview, null);
const clients = createWorkbenchClients(api);
assert.deepEqual(clients.session.agentSessionRead({ sessionId: 'session-a' }), { sessionId: 'session-a' });
assert.equal(clients.workspace.agentWorkspaceReadPreview, null);
assert.throws(() => clients.require('agentRuntimeReadTopic'), /outside Workbench client boundary/);
assert.throws(() => clients.require('agentWorkspaceReadPreview'), /unavailable/);
assert.equal(new Set(Object.values(CLIENT_METHODS).flat()).size, Object.values(CLIENT_METHODS).flat().length,
    'a preload method must belong to exactly one Workbench client');
console.log('Agent Workbench client boundary tests passed.');
