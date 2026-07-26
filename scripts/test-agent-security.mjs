import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CapabilityPolicy } = require('../modules/agent-runtime/security/capabilityPolicy.js');

const now = new Date('2026-07-25T12:00:00.000Z');
const policy = new CapabilityPolicy({
    clock: () => now,
    rules: [
        { id: 'allow-read', effect: 'allow', session: 'sess-1', tool: 'Files:*', action: 'read', path: 'C:/work/**', expiresAt: '2026-07-26T00:00:00Z' },
        { id: 'deny-secret', effect: 'deny', session: 'sess-1', tool: '*', action: '*', path: 'C:/work/secrets/**' },
        { id: 'expired-shell', effect: 'allow', session: 'sess-1', tool: 'Shell:*', action: 'shell', expiresAt: '2026-07-24T00:00:00Z' },
    ],
});
assert.equal(policy.evaluate({ sessionId: 'sess-1', toolId: 'Files:Read', action: 'read', path: 'C:/work/readme.md' }).allowed, true);
assert.equal(policy.evaluate({ sessionId: 'sess-1', toolId: 'Files:Read', action: 'read', path: 'C:/work/secrets/key.txt' }).reason, 'explicit-deny');
assert.equal(policy.evaluate({ sessionId: 'sess-1', toolId: 'Files:Write', action: 'write', path: 'C:/work/a.txt' }).reason, 'sensitive-default-deny');
assert.equal(policy.evaluate({ sessionId: 'sess-1', toolId: 'Shell:Run', action: 'shell' }).allowed, false);
assert.equal(policy.evaluate({ sessionId: 'sess-1', toolId: 'Agent:Spawn', action: 'subagent' }).allowed, false);
const snapshot = policy.snapshot();
assert.match(snapshot.hash, /^[a-f0-9]{64}$/);
assert.equal(snapshot.enforcementBoundary, 'client-constraint-not-server-boundary');
assert.equal(CapabilityPolicy.fromSnapshot(snapshot, { clock: () => now }).snapshot().hash, snapshot.hash);
assert.throws(() => CapabilityPolicy.fromSnapshot({ ...snapshot, hash: '0'.repeat(64) }), /hash mismatch/);
const sessionDefault = CapabilityPolicy.forSession('sess-default');
assert.equal(sessionDefault.evaluate({ sessionId: 'sess-default', toolId: 'vcp_invoke', action: 'read', path: 'README.md' }).allowed, true);
assert.equal(sessionDefault.evaluate({ sessionId: 'sess-default', toolId: 'workspace_apply_patch', action: 'write', path: 'README.md' }).allowed, true);
assert.equal(sessionDefault.evaluate({ sessionId: 'sess-default', toolId: 'unknown_tool', action: 'read' }).allowed, false);
console.log('Agent Runtime security tests passed.');
