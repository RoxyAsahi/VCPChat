import assert from 'node:assert/strict';
import { createSessionDockModel, SESSION_DOCK_STORAGE_KEY } from '../modules/ui-system/agent-session-dock.js';

const values = new Map();
const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
const dock = createSessionDockModel(storage);

dock.setSession('session-a');
assert.deepEqual(dock.snapshot().tabs.map((tab) => tab.kind), ['files', 'context']);
dock.openKind('approvals');
dock.close('context');
assert.equal(dock.snapshot().tabs.some((tab) => tab.kind === 'context'), false);
dock.openKind('context');
assert.equal(dock.snapshot().tabs.some((tab) => tab.kind === 'context'), true);
dock.openFile({ sessionId: 'session-a', workspaceRevision: 'rev-a', relativePath: 'src/index.js' });
assert.equal(dock.snapshot().activeId.includes('src%2Findex.js'), true);
assert.equal(dock.openFile({ sessionId: 'session-b', workspaceRevision: 'rev-b', relativePath: 'secret.txt' }), null);

dock.setSession('session-b');
assert.deepEqual(dock.snapshot().tabs.map((tab) => tab.kind), ['files', 'context']);
dock.openFile({ sessionId: 'session-b', workspaceRevision: 'rev-b', relativePath: 'README.md' });
dock.setSession('session-a');
assert.equal(dock.snapshot().tabs.some((tab) => tab.relativePath === 'README.md'), false);

const saved = JSON.parse(values.get(SESSION_DOCK_STORAGE_KEY));
assert.equal(JSON.stringify(saved).includes('secret.txt'), false);
assert.equal(JSON.stringify(saved).includes('content'), false);

const restored = createSessionDockModel(storage);
restored.setSession('session-a');
assert.equal(restored.snapshot().tabs.some((tab) => tab.relativePath === 'src/index.js'), true);
restored.invalidateWorkspace('rev-new');
assert.equal(restored.snapshot().tabs.some((tab) => tab.kind === 'file'), false);

values.set(SESSION_DOCK_STORAGE_KEY, JSON.stringify({ sessions: { evil: { activeId: 'x', tabs: [
    { kind: 'file', workspaceRevision: 'rev', relativePath: '../outside.txt' },
    { kind: 'file', workspaceRevision: 'rev', relativePath: 'C:/outside.txt' },
] } } }));
const hostile = createSessionDockModel(storage);
hostile.setSession('evil');
assert.deepEqual(hostile.snapshot().tabs.map((tab) => tab.kind), ['files', 'context']);

console.log('Agent Session Dock model tests passed.');
