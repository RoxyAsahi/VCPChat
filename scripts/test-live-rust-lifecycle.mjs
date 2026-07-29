import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../modules/agent-runtime/rustDaemonTransport');
const repo = path.resolve(import.meta.dirname, '..');
const liveEnvironment = await requireLiveRustEnvironment();
process.env.VCP_SERVER_URL = liveEnvironment.serverUrl;
process.env.VCP_API_KEY = liveEnvironment.apiKey;
const configuredApiKey = liveEnvironment.apiKey;

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-rust-live-'));
const settingsPath = path.join(temporaryRoot, 'settings.json');
const agentsDir = path.join(temporaryRoot, 'Agents');
fs.writeFileSync(settingsPath, '{}\n', 'utf8');

function deferred(label, timeoutMs = 180_000) {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    const timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs);
    return {
        promise,
        resolve(value) {
            clearTimeout(timer);
            resolve(value);
        },
    };
}

function transportOptions(onMessage, resume) {
    return {
        projectRoot: repo,
        settingsPath,
        agentsDir,
        workspaceRoot: repo,
        model: 'gpt-5.6-terra',
        agent: 'Nova',
        resume,
        onMessage,
    };
}

async function verifyCancelAndResume() {
    const cancelled = deferred('cancel event');
    const checkpointed = deferred('cancel checkpoint');
    let transport = new RustDaemonTransport(transportOptions((message) => {
        if (message.type === 'event' && message.event?.type === 'turn.cancelled') {
            cancelled.resolve(message.event);
        }
        if (message.type === 'ack' && message.result?.interrupted === true) {
            checkpointed.resolve(message.result);
        }
    }));
    await transport.start();
    const session = await transport.request('create-session');
    await transport.request('start-turn', {
        sessionId: session.sessionId,
        turnId: `turn-live-cancel-${Date.now()}`,
        prompt: '请写一篇很长的文章，逐条介绍二十种软件测试方法。',
    });
    await transport.request('cancel-turn', { sessionId: session.sessionId });
    const [cancelEvent, checkpoint] = await Promise.all([
        cancelled.promise,
        checkpointed.promise,
    ]);
    assert.equal(cancelEvent.payload?.replay, false);
    assert.equal(checkpoint.snapshot?.version, 1);
    assert.match(
        JSON.stringify(checkpoint.snapshot),
        /恢复后不会自动重放/,
        'cancel checkpoint must make the interrupted state visible',
    );
    await transport.stop();

    let resumedAnswer = '';
    const resumed = deferred('resumed turn');
    transport = new RustDaemonTransport(transportOptions((message) => {
        if (message.type === 'event' && message.event?.type === 'assistant.delta') {
            resumedAnswer += message.event.payload?.text || '';
        }
        if (message.type === 'ack' && message.result?.snapshot) resumed.resolve(message.result);
    }, 'latest'));
    await transport.start();
    const resumedSession = await transport.request('create-session');
    await transport.request('start-turn', {
        sessionId: resumedSession.sessionId,
        turnId: `turn-live-resume-${Date.now()}`,
        prompt: '只回答“恢复成功”，不要调用工具。',
    });
    await resumed.promise;
    assert.match(resumedAnswer, /恢复成功/);
    if (configuredApiKey) assert.ok(!resumedAnswer.includes(configuredApiKey));
    await transport.stop();
}

async function verifyRealCompaction() {
    const topicId = 'seed-compact';
    const topicDirectory = path.join(
        temporaryRoot,
        'UserData',
        'nova',
        'topics',
        topicId,
    );
    fs.mkdirSync(topicDirectory, { recursive: true });
    const messages = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{
            type: 'text',
            text: '历史记录 ' + index + '：' + '这是用于真实压缩验收的中文上下文。'.repeat(120),
        }],
    }));
    fs.writeFileSync(path.join(topicDirectory, 'agent-state.json'), JSON.stringify({
        version: 1,
        title: '真实压缩测试',
        snapshot: { version: 1, messages },
        usage: null,
        workspaceRef: repo,
        model: 'gpt-5.6-terra',
        updatedAt: Date.now(),
    }, null, 2));
    fs.writeFileSync(path.join(topicDirectory, 'history.json'), '[]\n');

    const started = deferred('compaction start');
    const completed = deferred('compaction completion');
    const checkpointed = deferred('compaction checkpoint');
    const transport = new RustDaemonTransport(transportOptions((message) => {
        if (message.type === 'event' && message.event?.type === 'context.compaction.started') {
            started.resolve(message.event);
        }
        if (message.type === 'event' && message.event?.type === 'context.compaction.completed') {
            completed.resolve(message.event);
        }
        if (message.type === 'ack' && message.result?.snapshot) {
            checkpointed.resolve(message.result);
        }
    }, topicId));
    await transport.start();
    const session = await transport.request('create-session');
    await transport.request('compact', { sessionId: session.sessionId });
    await Promise.all([started.promise, completed.promise, checkpointed.promise]);
    await transport.stop();

    const state = JSON.parse(fs.readFileSync(
        path.join(topicDirectory, 'agent-state.json'),
        'utf8',
    ));
    const serialized = JSON.stringify(state.snapshot);
    assert.match(serialized, /VCP CHECKPOINT/);
    if (configuredApiKey) assert.ok(!serialized.includes(configuredApiKey));
}

try {
    await verifyCancelAndResume();
    await verifyRealCompaction();
    console.log('Live Rust cancel, checkpoint resume, and real compaction passed.');
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
