import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../modules/agent-runtime/rustDaemonTransport');
const repo = path.resolve(import.meta.dirname, '..');
await requireLiveRustEnvironment();

const timeoutMs = 240_000;
const toolNames = [];
let answer = '';
let finishTurn;
const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Rust multi-tool live task timed out')), timeoutMs);
    finishTurn = () => {
        clearTimeout(timer);
        resolve();
    };
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
            finishTurn();
            return;
        }
        if (message.type !== 'event') return;
        const event = message.event || {};
        if (event.type === 'assistant.delta') answer += event.payload?.text || '';
        if (event.type === 'tool.completed') toolNames.push(event.payload?.toolName || 'unknown');
        if (event.type === 'approval.requested') {
            // This test permits only the local preflight. ToolBox keeps its
            // independent server-side policy and receives no configuration
            // writes from this client.
            transport.request('approval', {
                approvalId: event.payload?.approvalId,
                allowed: true,
                sessionId: event.sessionId,
                turnId: event.turnId,
                toolCallId: event.toolCallId,
                argumentsHash: event.payload?.argumentsHash,
            }).catch(() => {});
        }
    },
});

try {
    await transport.start();
    const session = await transport.request('create-session');
    await transport.request('start-turn', {
        sessionId: session.sessionId,
        prompt: '完成一个多步骤验证：先调用 vcp_invoke，toolName=FileOperator，arguments={"command":"ListAllowedDirectories"} 获取真实工作区；再调用 vcp_invoke，toolName=SciCalculator，arguments={"expression":"6*7"}。必须等待两个真实工具结果都返回，再用中文说明工作区和计算值，并包含标记 LONG_TASK_FILE_AND_42。不得使用其他工具。',
    });
    await completed;
    assert.deepEqual(toolNames, ['FileOperator', 'SciCalculator'],
        `long task must complete the requested ToolBox tools in order, got ${toolNames.join(', ')}`);
    assert.match(answer, /LONG_TASK_FILE_AND_42/, 'final assistant response must prove it observed both tool results');
    assert.match(answer, /42/, 'final assistant response must include the real calculator result');
    console.log('Live Rust multi-tool task passed: FileOperator → SciCalculator → marked answer.');
} finally {
    await transport.stop();
}
