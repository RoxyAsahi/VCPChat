import assert from 'node:assert/strict';
import {
    emptyNavigationMemory,
    forgetAgentSession,
    lastRememberedAgentSession,
    migrateLegacyRememberedSession,
    readNavigationMemory,
    rememberAgentSession,
    rememberedSessionForAgent,
} from '../modules/ui-system/agent-navigation-memory.js';

const values = new Map();
const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
};

assert.deepEqual(readNavigationMemory(storage), emptyNavigationMemory());
assert.equal(rememberAgentSession({ agentId: 'UIka', sessionId: 'u-1' }, storage), true);
assert.equal(rememberAgentSession({ agentId: 'Nova', sessionId: 'n-1' }, storage), true);
assert.equal(rememberedSessionForAgent('UIka', storage), 'u-1');
assert.deepEqual(lastRememberedAgentSession(storage), { agentId: 'Nova', sessionId: 'n-1' });
assert.equal(forgetAgentSession({ agentId: 'Nova', sessionId: 'n-1' }, storage), true);
assert.equal(rememberedSessionForAgent('Nova', storage), null);
assert.equal(migrateLegacyRememberedSession({ agentId: 'UIka', sessionId: 'u-2' }, storage), true);
assert.equal(rememberedSessionForAgent('UIka', storage), 'u-2');
console.log('Agent navigation memory tests passed.');
