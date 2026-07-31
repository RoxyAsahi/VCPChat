import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../modules/agent-runtime/rustDaemonTransport');
const root = path.resolve(import.meta.dirname, '..');
const live = await requireLiveRustEnvironment();
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-agent-live-concurrent-'));
const settingsPath = path.join(temporaryRoot, 'settings.json');
const events = [];

function waitFor(predicate, label, timeoutMs = 240_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const poll = () => {
            const match = events.find(predicate);
            if (match) return resolve(match);
            if (Date.now() >= deadline) return reject(new Error(`${label} timed out`));
            setTimeout(poll, 50);
        };
        poll();
    });
}

async function createTopic(transport, title) {
    const requestId = `live-concurrent-topic-${crypto.randomUUID()}`;
    await transport.request('create-topic', {
        agentId: 'Nova', title, model: 'gpt-5.6-terra', workspaceRoot: root,
    }, requestId);
    const created = await waitFor((message) => message.type === 'control-event'
        && message.requestId === requestId && message.kind === 'topic-created', 'Topic creation');
    return created.payload;
}

await fs.writeFile(settingsPath, JSON.stringify({
    vcpServerUrl: live.serverUrl,
    vcpApiKey: live.apiKey,
    agentRuntime: { tui: { defaultModel: 'gpt-5.6-terra', defaultAgentId: 'Nova' } },
}), 'utf8');

const sentinel = `VCP_CONCURRENT_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
const transport = new RustDaemonTransport({
    projectRoot: root,
    settingsPath,
    agentsDir: path.join(root, 'AppData', 'Agents'),
    workspaceRoot: root,
    model: 'gpt-5.6-terra',
    agent: 'Nova',
    controlOnly: true,
    onMessage: (message) => events.push(message),
});

try {
    await transport.start();
    const daemonPid = transport.child?.pid;
    const topicA = await createTopic(transport, 'R3-M 并发取消 A');
    const topicB = await createTopic(transport, 'R3-M 并发完成 B');
    const runtimeA = await transport.request('ensure-topic-runtime', {
        topicId: topicA.topicId, agentId: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: root,
    });
    const runtimeB = await transport.request('ensure-topic-runtime', {
        topicId: topicB.topicId, agentId: 'Nova', model: 'gpt-5.6-terra', workspaceRoot: root,
    });
    assert.notEqual(runtimeA.sessionId, runtimeB.sessionId);
    assert.equal(transport.child?.pid, daemonPid);

    const turnA = `turn-live-concurrent-a-${Date.now()}`;
    const turnB = `turn-live-concurrent-b-${Date.now()}`;
    await transport.request('start-turn', {
        sessionId: runtimeA.sessionId, topicId: runtimeA.topicId, turnId: turnA,
        prompt: '请分章节撰写一篇不少于八千字的中文软件架构长文。不要调用工具，持续详细输出。',
    });
    await transport.request('start-turn', {
        sessionId: runtimeB.sessionId, topicId: runtimeB.topicId, turnId: turnB,
        prompt: `只回复 ${sentinel}，不要调用任何工具或添加其他文字。`,
    });
    await waitFor((message) => message.type === 'event' && message.event?.type === 'assistant.delta'
        && message.event.sessionId === runtimeA.sessionId && message.event.turnId === turnA, 'Topic A first stream delta');
    await transport.request('cancel-turn', { sessionId: runtimeA.sessionId, topicId: runtimeA.topicId, turnId: turnA });
    const [cancelled, completed] = await Promise.all([
        waitFor((message) => message.type === 'event' && message.event?.type === 'turn.cancelled'
            && message.event.sessionId === runtimeA.sessionId && message.event.turnId === turnA, 'Topic A cancellation'),
        waitFor((message) => message.type === 'event' && message.event?.type === 'turn.completed'
            && message.event.sessionId === runtimeB.sessionId && message.event.turnId === turnB, 'Topic B completion'),
    ]);
    assert.equal(cancelled.event?.payload?.replay, false, 'cancelled Topic A may never be replayed');
    const answerB = events.filter((message) => message.type === 'event'
        && message.event?.type === 'assistant.delta' && message.event.sessionId === runtimeB.sessionId)
        .map((message) => message.event?.payload?.text || '').join('');
    assert.match(answerB, new RegExp(sentinel), 'Topic B must complete its own request after Topic A is cancelled');
    const active = await transport.request('list-active-runtimes', {});
    assert.equal(active.runtimes.some((runtime) => runtime.topicId === runtimeB.topicId), true);
    console.log('Live Rust concurrent Topics passed: A cancelled, B completed independently.');
} finally {
    await transport.stop().catch(() => {});
    await fs.rm(temporaryRoot, { recursive: true, force: true });
}
