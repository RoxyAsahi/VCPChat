import assert from 'node:assert/strict';
import { createAgentComposerState } from '../modules/ui-system/agent-workbench-state.js';

const composers = createAgentComposerState();
composers.setDraft('session-a', 'draft A');
composers.setAttachments('session-a', [{ id: 'a1', displayName: 'a.png' }]);
composers.setMode('session-a', 'steer');
composers.setDraft('session-b', 'draft B');
composers.setMode('session-b', 'follow-up');

assert.equal(composers.get('session-a').draft, 'draft A');
assert.equal(composers.get('session-b').draft, 'draft B');
assert.equal(composers.get('session-a').activeInputMode, 'steer');
assert.equal(composers.get('session-b').activeInputMode, 'follow-up');
assert.deepEqual(composers.get('session-b').attachments, []);

const external = [{ id: 'copy-me' }];
composers.setAttachments('session-b', external);
external[0].id = 'mutated';
assert.equal(composers.get('session-b').attachments[0].id, 'copy-me',
    'attachment descriptors must be copied into Session-local renderer state');

composers.clearAfterAcceptedSend('session-a');
assert.equal(composers.get('session-a').draft, '');
assert.deepEqual(composers.get('session-a').attachments, []);
assert.equal(composers.get('session-a').activeInputMode, 'steer',
    'an accepted send clears content without changing the user-selected running mode');
assert.equal(composers.get('session-b').draft, 'draft B');

composers.delete('session-a');
assert.equal(composers.get('session-a').draft, '', 'archived/deleted Sessions must lose temporary composer state');
assert.equal(composers.entries().some(([sessionId]) => sessionId === 'session-b'), true);

console.log('Agent Session composer state tests passed.');
