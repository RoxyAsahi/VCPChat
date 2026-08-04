import assert from 'node:assert/strict';
import { createAgentWorkbenchHostAdapter } from '../modules/ui-system/agent-workbench-host-adapter.js';

const listeners = new Map();
const storage = new Map();
const windowRef = {
    innerWidth: 1280,
    innerHeight: 720,
    localStorage: {
        getItem: (key) => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    VCPUI: { feedback: { async confirm() { return true; }, async prompt() { return 'edited'; } } },
};
const documentRef = {
    documentElement: { dataset: { theme: 'light' } },
    activeElement: { id: 'active' },
};
const adapter = createAgentWorkbenchHostAdapter({ windowRef, documentRef, api: { agentSessionList() {} } });
assert.equal(adapter.viewport.innerWidth, 1280);
assert.equal(adapter.theme.read(), 'light');
adapter.storage.write('agent', 'session-a');
assert.equal(adapter.storage.read('agent'), 'session-a');
assert.equal(await adapter.feedback.confirm('确认'), true);
assert.equal(await adapter.feedback.edit('编辑'), 'edited');
const unsubscribe = adapter.theme.subscribe(() => {});
assert.equal(listeners.has('themechange'), true);
unsubscribe();
assert.equal(listeners.has('themechange'), false);
console.log('Agent Workbench Host Adapter tests passed.');
