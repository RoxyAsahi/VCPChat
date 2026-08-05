import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    PROFILE_SCHEMA_VERSION,
    SESSION_CONFIG_SCHEMA_VERSION,
    normalizeProfile,
    normalizeSessionConfig,
} = require('../modules/codex-runtime/dataContracts.js');
const { AttachmentRegistry } = require('../modules/codex-runtime/attachmentRegistry.js');
const { createAgentEventDeduper } = await import('../modules/ui-system/agent-event-deduper.js');
const { codexSnapshotToProjection } = await import('../modules/ui-system/agent-workbench-snapshot-projection.js');

assert.equal(normalizeProfile({ schemaVersion: 1, name: 'Nova' }, 'Nova').schemaVersion, PROFILE_SCHEMA_VERSION);
assert.equal(normalizeSessionConfig({ schemaVersion: 1, model: 'test' }).schemaVersion, SESSION_CONFIG_SCHEMA_VERSION);
assert.throws(() => normalizeProfile({ schemaVersion: PROFILE_SCHEMA_VERSION + 1 }, 'future'),
    (error) => error.code === 'UNSUPPORTED_AGENT_DATA_VERSION');
assert.throws(() => normalizeSessionConfig({ attachment: { absolutePath: 'C:\\secret.txt' } }),
    (error) => error.code === 'SENSITIVE_AGENT_DATA');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-attachment-'));
const filePath = path.join(root, 'note.txt');
fs.writeFileSync(filePath, 'hello');
let now = 1000;
const registry = new AttachmentRegistry({ ttlMs: 100, maxEntries: 2, clock: () => now });
const descriptor = registry.register('session-a', filePath);
assert.deepEqual(Object.keys(descriptor).sort(), ['attachmentId', 'byteLen', 'displayName', 'kind'].sort());
assert.equal(JSON.stringify(descriptor).includes(root), false, 'Renderer descriptors must not expose absolute paths');
assert.equal(registry.resolve('session-a', descriptor).path, path.resolve(filePath));
assert.throws(() => registry.resolve('session-b', descriptor), (error) => error.code === 'ATTACHMENT_SESSION_MISMATCH');
fs.writeFileSync(filePath, 'changed');
assert.throws(() => registry.resolve('session-a', descriptor), (error) => error.code === 'ATTACHMENT_CHANGED');
const descriptor2 = registry.register('session-a', filePath);
now += 101;
assert.throws(() => registry.resolve('session-a', descriptor2), (error) => error.code === 'ATTACHMENT_EXPIRED');
fs.rmSync(root, { recursive: true, force: true });

const restoredAttachment = codexSnapshotToProjection({
    messages: [{
        messageId: 'image-message', itemId: 'image-item', role: 'assistant', status: 'completed',
        blocks: [{
            blockId: 'image-block', kind: 'attachment', ordinal: 0,
            content: { item: { type: 'imageView', path: 'C:\\private\\capture.png' } },
        }],
    }],
}).messages[0].attachments[0];
assert.equal(restoredAttachment.displayName, 'capture.png');
assert.equal(Object.prototype.hasOwnProperty.call(restoredAttachment, 'path'), false,
    'legacy imageView Blocks must not restore absolute paths into Renderer attachments');
assert.equal(JSON.stringify(restoredAttachment).includes('C:\\private'), false);

const deduper = createAgentEventDeduper({ eventCapacity: 2, bucketCapacity: 2 });
const event = (sessionId, sequence, eventId) => ({ sessionId, sequence, eventId, type: 'assistant.delta' });
assert.equal(deduper.accept(event('a', 1, 'same-id')), true);
assert.equal(deduper.accept(event('a', 1, 'same-id')), false);
assert.equal(deduper.accept(event('b', 1, 'same-id')), true,
    'the same eventId in two Sessions must not collide');
assert.equal(deduper.accept(event('a', 2, 'a-2')), true);
assert.equal(deduper.accept(event('a', 3, 'a-3')), true);
assert.ok(deduper.inspect().every((bucket) => bucket.eventCount <= 2), 'eventId LRU must remain bounded');
assert.equal(deduper.accept(event('a', 2, 'late')), false, 'a stale sequence must not overwrite newer Session state');

console.log('Agent data contract tests passed.');
