import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../modules/agent-runtime/rustDaemonTransport');

const repo = path.resolve(import.meta.dirname, '..');
const configuredApiKey = process.env.VCP_API_KEY || null;
await requireLiveRustEnvironment();

let answer = '';
let terminalCompleted = false;
const sentinel = `VCP_AGENT_NOVA_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
let completed;
const completion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('live Rust Agent turn timed out')), 180_000);
    completed = () => { clearTimeout(timer); resolve(); };
});
const transport = new RustDaemonTransport({
    projectRoot: repo,
    settingsPath: path.join(repo, 'AppData', 'settings.json'),
    agentsDir: path.join(repo, 'AppData', 'Agents'),
    workspaceRoot: repo,
    model: 'gpt-5.6-terra',
    agent: 'Nova',
    onMessage: (message) => {
        if (message.type !== 'event') return;
        if (message.event?.type === 'assistant.delta') answer += message.event.payload?.text || '';
        if (message.event?.type === 'turn.completed') { terminalCompleted = true; completed(); }
        if (message.event?.type === 'runtime.warning') console.warn(message.event.payload?.message || 'runtime warning');
    },
});

try {
    await transport.start();
    const session = await transport.request('create-session');
    await transport.request('start-turn', {
        sessionId: session.sessionId,
        turnId: `turn-live-chat-${Date.now()}`,
        prompt: `只回复 ${sentinel}，不要调用工具，也不要添加其他文字。`,
    });
    await completion;
    assert.equal(terminalCompleted, true, 'the Nova turn must reach a terminal completed event');
    assert.match(answer, new RegExp(sentinel), 'Nova must return the requested live sentinel, not merely a non-empty response');
    if (configuredApiKey) {
        assert.ok(!answer.includes(configuredApiKey), 'assistant stream must redact the running API key');
    }
    console.log(`LIVE_RESPONSE=${answer.replace(/\s+/g, ' ').slice(0, 500)}`);
    console.log('Live Rust Agent Nova turn passed.');
} finally {
    await transport.stop();
}
