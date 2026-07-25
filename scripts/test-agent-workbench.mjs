import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;

let registered = null;
let unsubscribeCalls = 0;
let eventCallback = null;
let runtimeStatus = 'stopped';
const presenceCalls = [];
window.nextUiApps = {
    register(definition) { registered = definition; return definition; },
    get() { return null; },
    list() { return []; },
};
window.chatAPI = {
    agentRuntimeGetStatus: async () => ({ state: runtimeStatus, worker: null, pendingApprovals: [] }),
    agentRuntimeStart: async () => ({ state: 'ready' }),
    agentRuntimeStop: async () => ({ state: 'stopped' }),
    agentRuntimeCreateSession: async () => ({ sessionId: 'sess_test', state: 'created' }),
    agentRuntimeListSessions: async () => ({ sessions: [] }),
    agentRuntimeStartTurn: async () => ({ turnId: 'turn_test', state: 'running' }),
    agentRuntimeCancelTurn: async () => ({ ok: true }),
    agentRuntimeRespondApproval: async () => ({ approvalId: 'appr', decision: 'allow' }),
    agentRuntimeSetWorkbenchPresence: (mounted) => { presenceCalls.push(mounted); },
    onAgentRuntimeEvent(callback) {
        eventCallback = callback;
        return () => { unsubscribeCalls += 1; };
    },
};

await import(`${pathToFileURL(path.join(root, 'modules/ui-system/next-ui-apps.js')).href}?test=${Date.now()}`);
// next-ui-apps overwrites the stub; capture registrations via its real registry.
await import(`${pathToFileURL(path.join(root, 'modules/ui-system/agent-workbench.js')).href}?test=${Date.now()}`);
registered = window.nextUiApps.get('agent-workbench');
assert.ok(registered, 'Agent Workbench must register as an internal app');
assert.equal(registered.kind, 'internal');

const host = document.getElementById('host');
const dispose = registered.mount(host, {});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(host.querySelector('.agent-wb-header'));
assert.ok(host.querySelector('.agent-wb-warning').textContent.includes('Legacy ToolBox bridge'));
assert.equal(typeof eventCallback, 'function');
assert.deepEqual(presenceCalls, [true]);

runtimeStatus = 'ready';
eventCallback({
    sessionId: 'runtime', type: 'runtime.state_changed', payload: { state: 'ready' },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(host.querySelector('.agent-wb-badge').textContent.includes('ready'));

dispose();
assert.equal(unsubscribeCalls, 1, 'Workbench unmount must release runtime event subscription');
assert.deepEqual(presenceCalls, [true, false]);
assert.equal(host.childElementCount, 0);

console.log('Agent Workbench mount, event rendering, and unmount cleanup tests passed.');
