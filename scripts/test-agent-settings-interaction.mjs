import assert from 'node:assert/strict';
import {
    createAgentSettingsState,
    profileSettingsTarget,
    sessionSettingsTarget,
} from '../modules/ui-system/agent-settings-state.js';

const state = createAgentSettingsState({ delayMs: 5 });
const sessionA = sessionSettingsTarget('session-a');
const sessionB = sessionSettingsTarget('session-b');

state.setDraft(sessionA, 'permissionMode', 'always-approve');
assert.equal(state.value(sessionA, 'permissionMode', 'ask'), 'always-approve',
    'an old SQLite snapshot must not overwrite an unsaved YOLO Select draft');
assert.equal(state.value(sessionB, 'permissionMode', 'ask'), 'ask',
    'Session drafts must remain identity-isolated');

let releaseA;
const gateA = new Promise((resolve) => { releaseA = resolve; });
let sessionBCompleted = false;
const savingA = state.enqueue(sessionA, { workspaceRoot: 'C:\\workspace-a' }, async () => {
    await gateA;
    return { sessionId: 'session-a' };
});
const savingB = state.enqueue(sessionB, { workspaceRoot: 'C:\\workspace-b' }, async () => {
    sessionBCompleted = true;
    return { sessionId: 'session-b' };
});
await savingB;
assert.equal(sessionBCompleted, true, 'a pending Session A save must not serialize or cancel Session B');
assert.equal(state.value(sessionA, 'workspaceRoot', 'old-a'), 'C:\\workspace-a');
releaseA();
await savingA;

const conflict = Object.assign(new Error('stale revision'), { code: 'SESSION_CONFIG_CONFLICT' });
await assert.rejects(() => state.enqueue(sessionA, { model: 'new-model' }, async () => { throw conflict; }),
    (error) => error.code === 'SESSION_CONFIG_CONFLICT');
assert.equal(state.value(sessionA, 'model', 'old-model'), 'new-model',
    'CAS conflicts must preserve the user draft for an explicit retry');
assert.equal(state.status(sessionA, ['model']).state, 'conflict');
assert.equal(state.status(sessionA, ['model']).error.code, 'SESSION_CONFIG_CONFLICT',
    'field status must retain a structured error code for diagnostics');

const profile = profileSettingsTarget('Nova');
let scheduled = false;
state.schedule(profile, 'baseInstructions', () => { scheduled = true; });
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(scheduled, true, 'text debounce must be scoped by Profile and field');

state.dispose();
console.log('Agent settings interaction tests passed.');
