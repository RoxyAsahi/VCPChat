import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../modules/agent-runtime/rustDaemonTransport');
const repo = path.resolve(import.meta.dirname, '..');
await requireLiveRustEnvironment();
process.env.VCP_AGENT_TEST_TOOL_CHOICE = 'required';

let mode = 'read';
let readCompleted = false;
let readDetail = '';
let readToolCallId = '';
let highApproval = null;
let highRan = false;
const observedTypes = [];
let finishTurn;
let failTurn;
const waitTurn = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${mode} tool turn timed out; events=${observedTypes.join(',')}`)), 120_000);
    finishTurn = () => { clearTimeout(timer); resolve(); };
    failTurn = (error) => { clearTimeout(timer); reject(error); };
});
const transport = new RustDaemonTransport({
    projectRoot: repo,
    settingsPath: path.join(repo, 'AppData', 'settings.json'),
    agentsDir: path.join(repo, 'AppData', 'Agents'),
    workspaceRoot: repo,
    model: 'gpt-5.6-terra',
    agent: 'Nova',
    onMessage: (message) => {
        if (message.type === 'ack' && message.result?.snapshot) {
            finishTurn?.();
            return;
        }
        if (message.type !== 'event') return;
        const event = message.event || {};
        observedTypes.push(`${mode}:${event.type}`);
        if (event.type === 'turn.failed') {
            failTurn?.(new Error(`${mode} tool turn failed: ${event.payload?.error || 'unknown error'}`));
            return;
        }
        if (event.type.startsWith('tool.') || event.type.startsWith('approval.')) {
            // A live FileOperator result may contain source files.  The test
            // needs the event kind and ToolBox identity for diagnosis, not raw
            // plugin output (which could also contain credentials).
            console.log(`LIVE_EVENT=${event.type} tool=${event.payload?.toolName || 'unknown'}`);
        }
        if (mode === 'read' && event.type === 'approval.requested') {
            transport.request('approval', {
                approvalId: event.payload.approvalId,
                allowed: true,
                sessionId: event.sessionId,
                turnId: event.turnId,
                toolCallId: event.toolCallId,
                argumentsHash: event.payload.argumentsHash,
            }).catch((error) => console.error(error));
        }
        if (mode === 'read' && event.type === 'tool.completed') {
            readCompleted = true;
            readDetail = event.payload?.detail || '';
            readToolCallId = event.toolCallId || '';
        }
        if (mode === 'deny' && event.type === 'approval.requested') {
            highApproval = event;
            transport.request('approval', {
                approvalId: event.payload.approvalId,
                allowed: false,
                sessionId: event.sessionId,
                turnId: event.turnId,
                toolCallId: event.toolCallId,
                argumentsHash: event.payload.argumentsHash,
            }).catch((error) => console.error(error));
        }
        if (mode === 'deny' && event.type === 'tool.running') highRan = true;
    },
});

try {
    await transport.start();
    const session = await transport.request('create-session');
    let done = waitTurn();
    await transport.request('start-turn', {
        sessionId: session.sessionId,
        turnId: `turn-live-read-${Date.now()}`,
        prompt: '请务必调用 FileOperator 的 ReadFile 读取当前工作区 package.json，只告诉我 name 字段。',
    });
    await done;
    assert.equal(readCompleted, true, 'read-only FileOperator tool should complete');
    assert.match(readToolCallId, /\S/, 'Rust daemon must project the native toolCallId into ToolBox completion events so GUI cards can correlate lifecycle updates');
    assert.match(readDetail, /vcp-chat-desktop/, 'relative tool paths must resolve against the Agent workspace');

    mode = 'deny';
    done = waitTurn();
    await transport.request('start-turn', {
        sessionId: session.sessionId,
        turnId: `turn-live-deny-${Date.now()}`,
        prompt: '请务必调用 PowerShellExecutor 执行 Get-Location，不要用别的方法。',
    });
    await done;
    assert.ok(highApproval, 'high-risk tool must request local approval');
    assert.equal(highRan, false, 'denied high-risk tool must never enter execute phase');
    console.log('Live Rust Agent tool allow/deny paths passed.');
} finally {
    await transport.stop();
}
