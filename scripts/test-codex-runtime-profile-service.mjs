import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RuntimeProfileService } = require('../modules/codex-runtime/runtime-profile-service.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vchat-profile-'));
const sessions = new Map();
const repository = {
    readOnly: false,
    listSessions: ({ archived = false } = {}) => [...sessions.values()].filter((s) => Boolean(s.archivedAt) === archived),
    getSession: (id) => sessions.get(id) || null,
    updateSessionConfig(id, revision, patch) {
        const current = sessions.get(id);
        if (!current || current.configRevision !== revision) return { updated: false, session: current };
        const next = { ...current, ...patch, configRevision: revision + 1 };
        sessions.set(id, next);
        return { updated: true, session: next };
    },
    saveSession(session) { sessions.set(session.sessionId, { ...session }); return sessions.get(session.sessionId); },
};
const service = new RuntimeProfileService({
    ensureProjectionStore: () => {},
    assertProjectionWritable: () => {},
    repository: () => repository,
    agentsDir: () => root,
    getSettings: () => ({ vcpServerUrl: 'http://localhost:6005', vcpApiKey: '123456' }),
    getModels: () => [{ id: 'deepseek-v4-flash', reasoningEfforts: ['low', 'high'] }],
    createSession: async (options) => ({ sessionId: 'derived-session', ...options }),
});

assert.equal(service.listAgentProfiles().some((profile) => profile.id === 'Nova'), true);
const created = service.saveAgentProfile({ name: 'Researcher', baseInstructions: '{{Nova}}', model: 'deepseek-v4-flash', reasoningEffort: 'high' });
assert.equal(created.success, true);
assert.equal(service.resolveAgentProfile('Researcher').id, 'Researcher');
assert.throws(() => service.saveAgentProfile({ profileId: 'Researcher', name: 'Researcher', expectedProfileRevision: 0, model: 'deepseek-v4-flash' }),
    (error) => error.code === 'PROFILE_CONFIG_CONFLICT');
assert.throws(() => service.validateReasoningEffort('deepseek-v4-flash', 'x'),
    (error) => error.code === 'REASONING_EFFORT_UNSUPPORTED');

sessions.set('session-a', {
    sessionId: 'session-a',
    agentId: 'Researcher',
    agentCatalogId: 'Researcher',
    agentNameSnapshot: 'Researcher',
    configRevision: 1,
    threadId: null,
    workspaceRoot: root,
    configSnapshot: { instructionMode: 'vchat-identity', baseInstructions: '{{Nova}}', profileRevision: 1 },
});
const applied = await service.applyAgentProfileToSession({ sessionId: 'session-a', expectedConfigRevision: 1 });
assert.equal(applied.applied, true);
assert.equal(sessions.get('session-a').configSnapshot.profileId, 'Researcher');
console.log('Codex Runtime profile service tests passed.');
