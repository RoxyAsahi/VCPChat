import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { rustSourceRevision } from './rust-source-revision.mjs';

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../modules/agent-runtime/rustDaemonTransport');

const repo = path.resolve(import.meta.dirname, '..');
const pinnedRevision = rustSourceRevision(repo);
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-agentd-v17-smoke-'));

function waitFor(messages, predicate, label, timeoutMs = 7_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const poll = () => {
            const found = messages.find(predicate);
            if (found) return resolve(found);
            if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${label}`));
            setTimeout(poll, 20);
        };
        poll();
    });
}

async function startModelFixture() {
    const received = [];
    const server = http.createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
            response.writeHead(404).end();
            return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        received.push(text);
        const hold = text.includes('HOLD_TOPIC_A');
        const delta = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
        response.write(delta(hold ? 'A is running' : 'B completed independently'));
        if (hold) {
            // Keep A alive long enough to prove that cancelling it does not
            // stop B or detach B's resident Topic runtime.
            response.once('close', () => {});
            return;
        }
        response.end('data: [DONE]\n\n');
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return { server, received, url: `http://127.0.0.1:${address.port}` };
}

async function createTopic(transport, events, suffix, agentId = 'Nova') {
    const requestId = `create-${suffix}`;
    await transport.request('create-topic', {
        agentId,
        title: `并发 ${suffix}`,
        model: 'gpt-5.6-terra',
        workspaceRoot: repo,
    }, requestId);
    const created = await waitFor(events,
        (message) => message.type === 'control-event' && message.requestId === requestId && message.kind === 'topic-created',
        `Topic ${suffix} creation`);
    return created.payload;
}

const modelFixture = await startModelFixture();
const settingsPath = path.join(testRoot, 'settings.json');
await fs.writeFile(settingsPath, JSON.stringify({
    vcpServerUrl: modelFixture.url,
    vcpApiKey: 'test-only-placeholder',
    agentRuntime: { tui: { defaultModel: 'gpt-5.6-terra', budget: { maxRequestsPerTurn: 8, maxTokensPerTurn: 120000 } } },
}), 'utf8');

const messages = [];
let exitError = null;
const transport = new RustDaemonTransport({
    projectRoot: repo, settingsPath, agentsDir: path.join(testRoot, 'Agents'),
    workspaceRoot: repo, model: 'gpt-5.6-terra', agent: 'Nova', controlOnly: true,
    onMessage: (message) => messages.push(message),
    onExit: (_code, _signal, error) => { exitError = error; },
});

try {
    await transport.start();
    const daemonPid = transport.child?.pid;
    assert.equal(transport.readyMessage?.buildRevision, pinnedRevision,
        'the smoke daemon must be compiled from the checked-out Rust source revision');
    assert.equal(transport.readyMessage?.protocolRevision, '1.7');

    // A control plane can browse a different Agent without creating a Topic
    // runtime. This is intentionally separate from the concurrent hosts.
    await fs.mkdir(path.join(testRoot, 'AgentRuntimeData', '123', 'topics', 'topic-existing-123'), { recursive: true });
    await fs.writeFile(path.join(testRoot, 'AgentRuntimeData', '123', 'topics', 'topic-existing-123', 'agent-state.json'), JSON.stringify({
        version: 1, title: '123 的既有 Topic', model: 'gpt-5.6-terra', workspaceRef: repo,
        updatedAt: 1_700_000_000_000, history: [],
    }), 'utf8');
    await fs.writeFile(path.join(testRoot, 'AgentRuntimeData', '123', 'topics', 'topic-existing-123', 'history.json'), JSON.stringify([]), 'utf8');
    await transport.request('list-topics', { agentId: '123' }, 'other-agent-topics');
    const otherAgentTopics = await waitFor(messages,
        (message) => message.type === 'control-event' && message.requestId === 'other-agent-topics' && message.kind === 'topics',
        'cross-Agent Topic list');
    assert.deepEqual(otherAgentTopics.payload.map((topic) => ({ id: topic.id, agentId: topic.agentId })), [{ id: 'topic-existing-123', agentId: '123' }]);

    const topicA = await createTopic(transport, messages, 'a');
    const topicB = await createTopic(transport, messages, 'b');
    const runtimeA = await transport.request('ensure-topic-runtime', {
        topicId: topicA.topicId, agentId: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: repo, permissionMode: 'ask',
    }, 'ensure-a');
    const runtimeB = await transport.request('ensure-topic-runtime', {
        topicId: topicB.topicId, agentId: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: repo, permissionMode: 'ask',
    }, 'ensure-b');
    assert.notEqual(runtimeA.sessionId, runtimeB.sessionId, 'each Topic Host has an independent session identity');
    assert.equal(transport.child?.pid, daemonPid, 'ensuring another Topic never restarts the daemon');
    await waitFor(messages, (message) => message.type === 'event' && message.event?.type === 'runtime.ready' && message.event.topicId === topicA.topicId, 'Topic A runtime.ready');
    await waitFor(messages, (message) => message.type === 'event' && message.event?.type === 'runtime.ready' && message.event.topicId === topicB.topicId, 'Topic B runtime.ready');

    const active = await transport.request('list-active-runtimes', {}, 'active-before-turns');
    assert.equal(active.capacity, 8);
    assert.deepEqual(new Set(active.runtimes.map((runtime) => runtime.topicId)), new Set([topicA.topicId, topicB.topicId]));

    await transport.request('start-turn', {
        sessionId: runtimeA.sessionId, topicId: topicA.topicId, turnId: 'turn-a', prompt: 'HOLD_TOPIC_A',
    }, 'turn-a-request');
    await transport.request('start-turn', {
        sessionId: runtimeB.sessionId, topicId: topicB.topicId, turnId: 'turn-b', prompt: 'FINISH_TOPIC_B',
    }, 'turn-b-request');
    await waitFor(messages, (message) => message.type === 'event' && message.event?.type === 'assistant.completed' && message.event.topicId === topicB.topicId && message.event.turnId === 'turn-b', 'Topic B completion');
    assert.equal(messages.some((message) => message.type === 'event' && message.event?.topicId === topicA.topicId && message.event?.topicId === topicB.topicId), false);

    await transport.request('cancel-turn', { sessionId: runtimeA.sessionId, topicId: topicA.topicId, turnId: 'turn-a' }, 'cancel-a');
    const afterCancel = await transport.request('list-active-runtimes', {}, 'active-after-cancel');
    assert.equal(afterCancel.runtimes.some((runtime) => runtime.topicId === topicA.topicId), true, 'cancelling A retains its independently recoverable resident runtime');
    assert.equal(afterCancel.runtimes.some((runtime) => runtime.topicId === topicB.topicId), true, 'cancelling A must not detach B');
    assert.equal(modelFixture.received.length >= 2, true, 'both Topics made independent model requests');

    await transport.request('replace-interaction-queue', {
        sessionId: runtimeB.sessionId, topicId: topicB.topicId,
        interactions: [{ interactionId: 'follow-up-b', kind: 'follow-up', prompt: '完成后总结' }],
    }, 'queue-b');
    const queue = await waitFor(messages,
        (message) => message.type === 'control-event' && message.requestId === 'queue-b' && message.kind === 'interaction-queue',
        'Topic B interaction queue');
    assert.equal(queue.payload[0]?.interactionId, 'follow-up-b');
    await transport.request('clear-interaction-queue', {
        sessionId: runtimeB.sessionId, topicId: topicB.topicId,
    }, 'clear-queue-b');
    await waitFor(messages,
        (message) => message.type === 'control-event' && message.requestId === 'clear-queue-b' && message.kind === 'interaction-queue' && message.payload?.length === 0,
        'Topic B queue clear');

    await transport.request('set-workbench-presence', { mounted: false }, 'presence-close');
    const presence = await waitFor(messages,
        (message) => message.type === 'control-event' && message.requestId === 'presence-close' && message.kind === 'workbench-presence',
        'presence close acknowledgement');
    assert.equal(presence.payload?.mounted, false);

    await transport.request('detach-topic', { sessionId: runtimeB.sessionId, topicId: topicB.topicId }, 'detach-b');
    const afterDetach = await transport.request('list-active-runtimes', {}, 'active-after-detach');
    assert.equal(afterDetach.runtimes.some((runtime) => runtime.topicId === topicB.topicId), false, 'detaching B cannot affect A');
    assert.equal(transport.child?.pid, daemonPid);

    // Capacity is a hard supervisor boundary. Fill all eight slots with
    // active Turns, prove an extra Topic is rejected without disturbing any
    // resident Host, then cancel them and prove the same extra Topic can use
    // idle LRU eviction.
    const capacityRuntimes = [runtimeA];
    for (let index = 0; index < 7; index += 1) {
        const topic = await createTopic(transport, messages, `capacity-${index}`);
        capacityRuntimes.push(await transport.request('ensure-topic-runtime', {
            topicId: topic.topicId, agentId: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: repo,
        }, `ensure-capacity-${index}`));
    }
    assert.equal((await transport.request('list-active-runtimes', {}, 'capacity-full')).runtimes.length, 8);
    for (const [index, runtime] of capacityRuntimes.entries()) {
        await transport.request('start-turn', {
            sessionId: runtime.sessionId, topicId: runtime.topicId,
            turnId: `capacity-turn-${index}`, prompt: 'HOLD_TOPIC_A',
        }, `capacity-start-${index}`);
        await waitFor(messages,
            (message) => message.type === 'event' && message.event?.type === 'turn.started'
                && message.event.sessionId === runtime.sessionId && message.event.turnId === `capacity-turn-${index}`,
            `capacity turn ${index} start`);
    }
    const overflowTopic = await createTopic(transport, messages, 'capacity-overflow');
    await assert.rejects(
        transport.request('ensure-topic-runtime', {
            topicId: overflowTopic.topicId, agentId: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: repo,
        }, 'ensure-overflow-busy'),
        /all 8 Topic runtimes are active/,
        'an all-busy supervisor must fail closed instead of evicting a running Topic',
    );
    assert.equal((await transport.request('list-active-runtimes', {}, 'capacity-still-full')).runtimes.length, 8);
    for (const [index, runtime] of capacityRuntimes.entries()) {
        await transport.request('cancel-turn', {
            sessionId: runtime.sessionId, topicId: runtime.topicId, turnId: `capacity-turn-${index}`,
        }, `capacity-cancel-${index}`);
    }
    await waitFor(messages,
        (message) => message.type === 'event' && message.event?.type === 'turn.cancelled'
            && message.event.turnId === 'capacity-turn-0',
        'capacity turn cancellation');
    const overflowRuntime = await transport.request('ensure-topic-runtime', {
        topicId: overflowTopic.topicId, agentId: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: repo,
    }, 'ensure-overflow-idle');
    assert.equal(overflowRuntime.topicId, overflowTopic.topicId, 'an idle LRU Host may be reclaimed for a ninth Topic');
    assert.equal((await transport.request('list-active-runtimes', {}, 'capacity-after-eviction')).runtimes.length, 8);

    await transport.stop();
    assert.equal(exitError, null, 'intentional shutdown is not a daemon crash');

    // A daemon crash leaves a durable interrupted checkpoint. A fresh daemon
    // can resume the same Topic, but it gets a new session identity and never
    // replays the cancelled model request.
    const crashEvents = [];
    let crashExited;
    const crashed = new RustDaemonTransport({
        projectRoot: repo, settingsPath, agentsDir: path.join(testRoot, 'Agents'), workspaceRoot: repo,
        model: 'gpt-5.6-terra', agent: 'Nova', controlOnly: true,
        onMessage: (message) => crashEvents.push(message), onExit: () => { crashExited?.(); },
    });
    await crashed.start();
    const crashRuntime = await crashed.request('ensure-topic-runtime', { topicId: topicA.topicId, agentId: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: repo });
    const exited = new Promise((resolve) => { crashExited = resolve; });
    crashed.child.kill();
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('crashed daemon did not exit')), 5_000))]);
    const recovered = new RustDaemonTransport({
        projectRoot: repo, settingsPath, agentsDir: path.join(testRoot, 'Agents'), workspaceRoot: repo,
        model: 'gpt-5.6-terra', agent: 'Nova', controlOnly: true,
    });
    await recovered.start();
    const recoveredRuntime = await recovered.request('ensure-topic-runtime', { topicId: topicA.topicId, agentId: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: repo });
    assert.equal(recoveredRuntime.topicId, topicA.topicId);
    assert.notEqual(recoveredRuntime.sessionId, crashRuntime.sessionId, 'recovery creates a fresh session identity');
    await recovered.stop();
} finally {
    await transport.stop().catch(() => {});
    await new Promise((resolve) => modelFixture.server.close(resolve));
    await fs.rm(testRoot, { recursive: true, force: true });
}

console.log('Rust daemon v1.7 concurrent framed-stdio smoke test passed.');
