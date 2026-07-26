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
globalThis.Node = dom.window.Node;
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;

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
    agentRuntimeListSessions: async () => ({ sessions: [{ sessionId: 'sess_saved', title: 'Saved session', metadata: { model: 'm1' } }] }),
    agentRuntimeGetSession: async ({ sessionId }) => ({ sessionId, title: 'Saved session', metadata: { model: 'm1' } }),
    agentRuntimeGetMessages: async ({ sessionId }) => ({
        messages: [{ messageId: 'msg_saved', sessionId, turnId: 'turn_saved', role: 'assistant', content: 'restored answer' }],
    }),
    agentRuntimeGetEvents: async ({ sessionId, sinceSequence }) => ({
        events: [{ type: 'reasoning.delta', sessionId, turnId: 'turn_saved', sequence: sinceSequence + 1, payload: { text: 'restored thought' } }],
    }),
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
await import(`${pathToFileURL(path.join(root, 'modules/ui-system/vcp-ui.js')).href}?test=${Date.now()}`);
// next-ui-apps overwrites the stub; capture registrations via its real registry.
await import(`${pathToFileURL(path.join(root, 'modules/ui-system/agent-workbench.js')).href}?test=${Date.now()}`);
registered = window.nextUiApps.get('agent-workbench');
assert.ok(registered, 'Agent Workbench must register as an internal app');
assert.equal(registered.kind, 'internal');

const host = document.getElementById('host');
const dispose = registered.mount(host, {});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(host.querySelector('.agent-chat-shell'));
assert.ok(host.querySelector('.agent-wb-sessions.sidebar'), 'Agent sessions must reuse the main sidebar shell');
assert.ok(host.querySelector('.agent-wb-conversation.main-content'), 'Agent conversation must reuse the main chat content shell');
assert.ok(host.querySelector('.agent-wb-conversation .chat-header'), 'Agent conversation must reuse the main chat header');
assert.ok(host.querySelector('.agent-wb-feed-container.chat-messages-container'), 'Agent feed must reuse the main message scroller');
assert.ok(host.querySelector('.agent-wb-composer.chat-input-area'), 'Agent composer must reuse the main chat input area');
assert.ok(host.querySelector('.agent-wb-composer-card.chat-input-card'), 'Agent composer must reuse the main chat input card');
assert.ok(host.querySelector('.agent-wb-tabs.vcp-ui-tabs'), 'Agent navigation must use the VCP UI Tabs component');
assert.ok(host.querySelector('.agent-wb-actions .vcp-ui-button'), 'Agent actions must use VCP UI Button components');
assert.ok(host.querySelector('.agent-wb-actions.vcp-ui-toolbar'), 'Session actions must use the VCP UI Toolbar component');
assert.ok(host.querySelector('.agent-wb-context .vcp-ui-card'), 'Task panels must use VCP UI Card components');
assert.ok(host.querySelector('.agent-wb-composer.chat-input-area'), 'Agent must reuse the main chat input shell');
assert.ok(host.querySelector('.agent-wb-composer-card.chat-input-card'), 'Agent must reuse the main chat input card');
assert.ok(host.querySelector('.agent-wb-prompt.chat-message-input'), 'Agent prompt must use the shared main-chat textarea styling contract');
assert.ok(host.querySelector('.agent-wb-composer .chat-input-actions'), 'Agent must reuse the main chat action row');
assert.ok(host.querySelector('.agent-wb-composer .chat-send-button'), 'Agent must reuse the main chat send button');
assert.equal(host.querySelector('.agent-wb-composer').textContent.includes('停止'), false, 'The composer must not expose a separate stop action');
assert.ok(host.querySelector('.agent-wb-session.vcp-ui-list-item'));
assert.ok(host.querySelector('.agent-wb-message-content').textContent.includes('restored answer'));
assert.ok(host.querySelector('.agent-wb-reasoning').textContent.includes('restored thought'));
assert.equal(typeof eventCallback, 'function');
assert.deepEqual(presenceCalls, [true]);

runtimeStatus = 'ready';
eventCallback({
    sessionId: 'runtime', type: 'runtime.state_changed', payload: { state: 'ready' },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(host.querySelector('.agent-wb-runtime-dock'), null, 'Runtime lifecycle controls must stay out of the Agent UI');

dispose();
assert.equal(unsubscribeCalls, 1, 'Workbench unmount must release runtime event subscription');
assert.deepEqual(presenceCalls, [true, false]);
assert.equal(host.childElementCount, 0);

console.log('Agent Workbench mount, event rendering, and unmount cleanup tests passed.');
