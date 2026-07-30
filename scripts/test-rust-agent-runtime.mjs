import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RustAgentRuntimeManager } = require('../modules/agent-runtime/rustRuntimeManager');
const { MAX_FRAME_BYTES } = require('../modules/agent-runtime/rustDaemonTransport');

class FakeTransport {
    constructor(options) {
        this.options = options; this.requests = []; this.sequence = 0;
        this.child = { pid: 4242 };
    }
    async start() {}
    async stop() { this.stopped = true; this.options.onExit?.(0, null, null); }
    async request(type, payload = {}, requestId) {
        this.requests.push({ type, payload, requestId });
        if (type === 'create-session') return { sessionId: 'session-rust', topicId: 'topic-rust' };
        return { ok: true };
    }
    event(event) {
        this.sequence += 1;
        this.options.onMessage({
            type: 'event', event: {
                sessionId: 'session-rust', topicId: 'topic-rust', sequence: this.sequence,
                eventId: `event-${this.sequence}`, timestamp: Date.now(), runtime: 'rust', ...event,
            },
        });
    }
    control(requestId, kind, payload) { this.options.onMessage({ type: 'control-event', requestId, kind, payload }); }
}

let fake;
const observed = [];
const manager = new RustAgentRuntimeManager({
    projectRoot: process.cwd(),
    getSettings: () => ({ vcpServerUrl: 'http://localhost:6005', vcpApiKey: 'redacted' }),
    sendEvent: (event) => observed.push(event),
    transportFactory: (options) => (fake = new FakeTransport(options)),
});

await manager.start();
const session = await manager.createSession({ workspaceRoot: process.cwd(), model: 'gpt-5.6-terra', agent: 'Nova' });
assert.deepEqual({ sessionId: session.sessionId, topicId: session.topicId }, { sessionId: 'session-rust', topicId: 'topic-rust' });
assert.equal(manager.getStatus().attachment.topicId, 'topic-rust');
assert.equal('pendingApprovals' in manager.getStatus(), false,
    'Main status must not manufacture an approval collection owned by the Renderer/Rust daemon');
assert.equal(manager.getStatus().worker.pid, fake.child.pid,
    'runtime status must identify the attached daemon process for lifecycle diagnostics');
assert.equal(manager.getAttachedTopicId(), 'topic-rust');
const requestCountBeforeIdempotentResume = fake.requests.length;
const sameAttachment = await manager.createSession({ resume: 'topic-rust', agent: 'Nova' });
assert.deepEqual(sameAttachment, session,
    'selecting a Topic already attached in this Main process must reuse the live Rust attachment');
assert.equal(fake.requests.length, requestCountBeforeIdempotentResume,
    'idempotent Topic selection must not stop and respawn the daemon');

// R1: simultaneous control calls correlate by framed requestId, never by the
// arrival order or response kind. Reply in reverse order to prove it.
const topics = manager.listTopics({ agentId: 'Nova' });
const settings = manager.getWorkbenchSettings();
await new Promise((resolve) => setImmediate(resolve));
const [topicsRequest, settingsRequest] = fake.requests.slice(-2);
assert.equal(topicsRequest.type, 'list-topics');
assert.deepEqual(topicsRequest.payload, { agentId: 'Nova' },
    'Topic catalog requests must name the selected Agent instead of inheriting a daemon default');
assert.equal(settingsRequest.type, 'get-settings');
assert.notEqual(topicsRequest.requestId, settingsRequest.requestId);
fake.control(settingsRequest.requestId, 'settings', { budget: { maxRequestsPerTurn: 8 } });
fake.control(topicsRequest.requestId, 'topics', [{ id: 'topic-rust', title: 'Rust Topic' }]);
assert.deepEqual(await topics, [{ id: 'topic-rust', title: 'Rust Topic' }]);
assert.deepEqual(await settings, { budget: { maxRequestsPerTurn: 8 } });

const topicSearch = manager.searchTopics({ query: '数据库', agentId: 'Nova', limit: 25 });
await new Promise((resolve) => setImmediate(resolve));
const topicSearchRequest = fake.requests.at(-1);
assert.equal(topicSearchRequest.type, 'search-topics');
assert.deepEqual(topicSearchRequest.payload, { query: '数据库', limit: 25, agentId: 'Nova' });
fake.control(topicSearchRequest.requestId, 'topic-search-results', [{ topicId: 'topic-rust', messageId: 'msg-1' }]);
assert.deepEqual(await topicSearch, [{ topicId: 'topic-rust', messageId: 'msg-1' }]);

const messageSearch = manager.searchTopicMessages({ query: '同步', topicId: 'topic-rust', agentId: 'Nova' });
await new Promise((resolve) => setImmediate(resolve));
const messageSearchRequest = fake.requests.at(-1);
assert.equal(messageSearchRequest.type, 'search-topic-messages');
fake.control(messageSearchRequest.requestId, 'topic-message-search-results', [{ topicId: 'topic-rust', messageId: 'msg-2' }]);
assert.equal((await messageSearch)[0].messageId, 'msg-2');

const indexStatus = manager.getTopicIndexStatus();
await new Promise((resolve) => setImmediate(resolve));
const indexStatusRequest = fake.requests.at(-1);
assert.equal(indexStatusRequest.type, 'get-index-status');
fake.control(indexStatusRequest.requestId, 'topic-index-status', { available: true, documentCount: 2 });
assert.equal((await indexStatus).documentCount, 2);

// Renderer presence is a Rust control-plane command. Main forwards it but
// never owns pending approvals or an ApprovalBroker.
const presence = manager.setWorkbenchPresence(false);
await new Promise((resolve) => setImmediate(resolve));
const presenceRequest = fake.requests.at(-1);
assert.equal(presenceRequest.type, 'set-workbench-presence');
assert.deepEqual(presenceRequest.payload, { mounted: false });
fake.control(presenceRequest.requestId, 'workbench-presence', { mounted: false, deniedApprovals: 1 });
assert.deepEqual(await presence, { mounted: false, deniedApprovals: 1 });

const mismatch = manager.listTopics();
await new Promise((resolve) => setImmediate(resolve));
const mismatchRequest = fake.requests.at(-1);
fake.control(mismatchRequest.requestId, 'settings', {});
await assert.rejects(mismatch, /control response mismatch/);

const attachmentImport = manager.importAttachment({ sessionId: session.sessionId, path: 'C:\\Temp\\图片.png' });
await new Promise((resolve) => setImmediate(resolve));
const attachmentRequest = fake.requests.at(-1);
assert.equal(attachmentRequest.type, 'import-attachment');
fake.control(attachmentRequest.requestId, 'attachment-imported', {
    attachment: {
        id: `attachment_${'a'.repeat(64)}`, displayName: '图片.png', kind: 'image', mimeType: 'image/png',
        byteLen: 1024, width: 32, height: 32, sha256: 'a'.repeat(64), assetFile: `${'a'.repeat(64)}.png`,
    },
});
const imported = await attachmentImport;
assert.equal(imported.attachment.displayName, '图片.png');
assert.equal('path' in imported.attachment, false, 'Renderer must receive an asset descriptor, not a durable local path');

const turn = await manager.startTurn({ sessionId: session.sessionId, prompt: '介绍一下自己', attachments: [imported.attachment] });
assert.deepEqual(fake.requests.at(-1).payload.attachments, [imported.attachment]);
assert.equal('updatedAt' in manager.getStatus().attachment, false,
    'Main must not mutate attachment business metadata when a turn command is accepted');
fake.event({ type: 'assistant.delta', turnId: turn.turnId, messageId: 'assistant-rust-1', payload: { text: '来自 daemon 的原样事件' } });
assert.equal(observed.at(-1).type, 'assistant.delta');
assert.equal(observed.at(-1).payload.text, '来自 daemon 的原样事件');
assert.equal(observed.at(-1).eventId, 'event-1');
assert.equal(observed.at(-1).sequence, 1);
assert.equal(manager.messages, undefined, 'Main must not retain a second transcript');

await manager.followUpTurn({ sessionId: session.sessionId, turnId: turn.turnId, prompt: '完成后总结' });
assert.equal(fake.requests.at(-1).type, 'follow-up-turn');
await manager.steerTurn({ sessionId: session.sessionId, turnId: turn.turnId, prompt: '先检查风险' });
assert.equal(fake.requests.at(-1).type, 'steer-turn');
await manager.respondApproval({ approvalId: 'approval-1', decision: 'deny', sessionId: session.sessionId, turnId: turn.turnId, toolCallId: 'tool-1', argumentsHash: 'hash-1' });
assert.deepEqual(fake.requests.at(-1).payload, {
    approvalId: 'approval-1', allowed: false, sessionId: session.sessionId,
    turnId: turn.turnId, toolCallId: 'tool-1', argumentsHash: 'hash-1',
});
await manager.respondApproval({ approvalId: 'approve-backend-1', decision: 'allow', scope: 'toolbox' });
assert.deepEqual(fake.requests.at(-1), {
    type: 'toolbox-approval',
    payload: {
        approvalRequestId: 'approve-backend-1', approved: true,
        reason: 'approved by VCPAgent user',
    },
    requestId: undefined,
});

// ACK means accepted only. A stale completed event (sequence <= request
// watermark) cannot complete a new compaction request.
fake.event({ type: 'context.compaction.completed', payload: { beforeTokens: 1, afterTokens: 1 } });
const compact = manager.compactSession({ sessionId: session.sessionId });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(fake.requests.at(-1).type, 'compact');
let settled = false;
compact.then(() => { settled = true; });
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(settled, false, 'compact ACK must not resolve the Workbench action');
fake.event({ type: 'context.compaction.completed', payload: { beforeTokens: 2400, afterTokens: 800, summaryTokens: 180 } });
const compacted = await compact;
assert.deepEqual(compacted.compaction, { beforeTokens: 2400, afterTokens: 800, summaryTokens: 180 });
assert.equal(manager.eventWaiters.size, 0);

const failed = manager.compactSession({ sessionId: session.sessionId });
await new Promise((resolve) => setImmediate(resolve));
fake.event({ type: 'context.compaction.failed', payload: { error: 'summary rejected' } });
await assert.rejects(failed, /summary rejected/);
assert.equal(manager.eventWaiters.size, 0);

fake.options.onExit(null, null, new Error('simulated daemon crash'));
assert.equal(manager.getStatus().state, 'failed');
assert.equal('state' in manager.getStatus().attachment, false,
    'Main must not derive an attachment business state after daemon crash');
assert.equal(manager.transport, null);
assert.ok(observed.some((event) => event.type === 'runtime.crashed'));
const closed = await manager.closeSession({ sessionId: session.sessionId });
assert.equal(closed.sessionId, session.sessionId);
assert.equal(manager.getStatus().attachment, null,
    'an explicit close must clear Main\'s process-local attachment identity');

// Before a user explicitly opens or creates a Topic, catalog/read operations
// must use Rust's lease-free control daemon. The normal attachment is started
// only after the Topic flow is confirmed.
let controlFake;
const controlManager = new RustAgentRuntimeManager({
    projectRoot: process.cwd(),
    getSettings: () => ({ vcpServerUrl: 'http://localhost:6005', vcpApiKey: 'redacted' }),
    transportFactory: (options) => (controlFake = new FakeTransport(options)),
});
const controlTopics = controlManager.listTopics({ agentId: 'Nova' });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(controlFake.options.controlOnly, true,
    'Topic catalog reads without an attachment must spawn the lease-free --control daemon');
assert.equal(controlManager.getStatus().attachment, null,
    'a control daemon must not fabricate a writable Topic attachment in Electron Main');
const controlRequest = controlFake.requests.at(-1);
assert.equal(controlRequest.type, 'list-topics');
controlFake.control(controlRequest.requestId, 'topics', []);
assert.deepEqual(await controlTopics, []);
await controlManager.stop();

assert.equal(MAX_FRAME_BYTES, 256 * 1024);

console.log('Rust Agent daemon-client tests passed.');
