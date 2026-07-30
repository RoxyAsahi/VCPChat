import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'rust', 'fixtures', 'daemon-v1.json'), 'utf8'));
const require = createRequire(import.meta.url);
const { validateDirectCommand, validateDaemonFrame } = require(path.join(root, 'modules', 'agent-runtime', 'rustDaemonTransport.js'));

assert.equal(fixture.protocolVersion, 1);
assert.equal(fixture.protocolRevision, '1.5');
for (const command of fixture.hostToDaemon) validateDirectCommand(command);
for (const frame of fixture.daemonToHost) validateDaemonFrame(frame);
for (const invalid of fixture.invalidHostToDaemon) assert.throws(() => validateDirectCommand(invalid));
for (const invalid of fixture.invalidDaemonToHost) assert.throws(() => validateDaemonFrame(invalid));

const ready = fixture.daemonToHost.find((message) => message.type === 'ready');
assert.equal(ready.protocolRevision, '1.5');
assert.match(ready.buildRevision, /^[0-9a-f]{7,64}$/i);
const control = fixture.daemonToHost.find((message) => message.type === 'control-event');
assert.equal(control.requestId, 'topics_1');
const event = fixture.daemonToHost.find((message) => message.type === 'event').event;
for (const field of ['eventId', 'sequence', 'timestamp', 'runtime', 'sessionId', 'topicId', 'messageId']) assert.ok(event[field] !== undefined, `v1.5 event requires ${field}`);
console.log('Rust daemon v1.5 shared fixture contract passed.');
