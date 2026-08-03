import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    legacySessionProjection,
    registerAgentSessionCompatibility,
    sessionPayload,
} = require('../modules/ipc/agentSessionCompatibility.js');

assert.deepEqual(sessionPayload({ topicId: 'session-a' }), { sessionId: 'session-a' });
assert.deepEqual(sessionPayload({ sessionId: 'session-a', topicId: 'session-a' }), { sessionId: 'session-a' });
assert.deepEqual(legacySessionProjection({ sessionId: 'session-a', session: { sessionId: 'session-a' } }), {
    sessionId: 'session-a', topicId: 'session-a', session: { sessionId: 'session-a', topicId: 'session-a' },
});
assert.throws(
    () => sessionPayload({ sessionId: 'session-a', topicId: 'session-b' }),
    (error) => error?.code === 'SESSION_IDENTITY_MISMATCH',
);

const handlers = new Map();
const calls = [];
const ipcMain = { handle(channel, handler) { handlers.set(channel, handler); } };
const guard = (_event, action) => action();
const channels = {
    CREATE_TOPIC: 'legacy:create-topic', CREATE_SESSION: 'legacy:create-session',
    LIST_TOPICS: 'legacy:list-topics', READ_TOPIC: 'legacy:read-topic',
    READ_PROJECTION: 'legacy:read-projection', RENAME_TOPIC: 'legacy:rename-topic',
    DELETE_TOPIC: 'legacy:delete-topic', FORK_SESSION: 'legacy:fork-session',
    CLOSE_SESSION: 'legacy:close-session', RESTORE_SESSION: 'legacy:restore-session',
    PERMANENTLY_DELETE_SESSION: 'legacy:delete-session',
};
const manager = new Proxy({}, {
    get(_target, name) {
        return (payload) => {
            calls.push([name, payload]);
            return { name, payload };
        };
    },
});

registerAgentSessionCompatibility({
    ipcMain, channels, manager,
    projectionGuard: guard, runtimeGuard: guard, toolboxGuard: guard,
});

assert.equal(handlers.size, Object.keys(channels).length);
await handlers.get(channels.READ_TOPIC)({}, { topicId: 'session-read' });
await handlers.get(channels.READ_PROJECTION)({}, { topicId: 'session-projection' });
await handlers.get(channels.CLOSE_SESSION)({}, { topicId: 'session-archive' });
await handlers.get(channels.PERMANENTLY_DELETE_SESSION)({}, { topicId: 'session-delete' });
assert.deepEqual(calls, [
    ['readSession', { sessionId: 'session-read' }],
    ['readSession', { sessionId: 'session-projection', reconcile: false }],
    ['archiveSession', { sessionId: 'session-archive' }],
    ['permanentlyDeleteSession', { sessionId: 'session-delete' }],
]);
await assert.rejects(
    handlers.get(channels.READ_TOPIC)({}, { sessionId: 'session-a', topicId: 'session-b' }),
    (error) => error?.code === 'SESSION_IDENTITY_MISMATCH',
);

console.log('Agent Session compatibility adapter tests passed.');
