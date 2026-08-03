import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let Database;
try {
    Database = require('better-sqlite3');
    new Database(':memory:').close();
} catch (error) {
    if (error.code === 'ERR_DLOPEN_FAILED') {
        console.log('Agent Runtime persistence test skipped: better-sqlite3 binary targets Electron, not this Node ABI.');
        process.exit(0);
    }
    throw error;
}
const { AgentRuntimeRepository } = require('../archive/agent-runtime/persistence/repository.js');
const { SessionRecord } = require('../archive/agent-runtime/sessionRegistry.js');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-store-'));
const databasePath = path.join(directory, 'agent-runtime.sqlite');
let store = new AgentRuntimeRepository({ Database, databasePath });
assert.equal(store.db.pragma('journal_mode', { simple: true }), 'wal');
assert.equal(store.schemaVersion, 1);

const session = new SessionRecord('sess_persist', 'mock', { metadata: { model: 'mock', apiKey: 'must-not-persist' } });
store.saveSession(session);
const turnId = session.startTurn('secret token=abcdefghijk');
session.transitionTurn(turnId, 'running');
store.saveTurn(session.sessionId, session.getTurn(turnId), 1);
store.saveMessage({ sessionId: session.sessionId, turnId, role: 'user', content: 'hello' });
store.saveToolCall({ toolCallId: 'tool_1', sessionId: session.sessionId, turnId, toolName: 'vcp_invoke', state: 'running' });
store.saveApproval({
    approvalId: 'approval_1', sessionId: session.sessionId, turnId, toolCallId: 'tool_1',
    toolName: 'vcp_invoke', argumentsHash: 'hash', riskLevel: 'high', state: 'pending', createdAt: Date.now(),
});
const artifactId = store.saveArtifact({ sessionId: session.sessionId, turnId, kind: 'diff', path: 'README.md', metadata: { apiKey: 'must-not-persist' } });
store.saveRuntimeState({ sessionId: session.sessionId, driverId: 'pi', stateVersion: '1', state: { transcriptId: 'opaque' } });
const event = session.emit('turn.started', { apiKey: 'must-not-persist' }, { turnId });
store.saveEvent(event);
assert.throws(() => store.saveEvent(event), /UNIQUE/);
store.close();

store = new AgentRuntimeRepository({ Database, databasePath });
const restored = store.restore();
assert.equal(restored.length, 1);
assert.equal(restored[0].state, 'failed');
assert.equal(restored[0].turns[0].state, 'failed');
assert.equal(restored[0].events[0].payload.apiKey, '[REDACTED]');
assert.equal(store.getToolCalls(session.sessionId)[0].state, 'cancelled');
assert.equal(store.getApprovals(session.sessionId)[0].state, 'cancelled');
assert.equal(store.getArtifacts(session.sessionId)[0].artifactId, artifactId);
assert.equal(store.getArtifacts(session.sessionId)[0].metadata.apiKey, '[REDACTED]');
assert.equal(store.getRuntimeState(session.sessionId).state.transcriptId, 'opaque');
assert.equal(JSON.stringify(restored).includes('must-not-persist'), false);
store.close();
fs.rmSync(directory, { recursive: true, force: true });

console.log('Agent Runtime SQLite migration, WAL, uniqueness, redaction, and restore tests passed.');
