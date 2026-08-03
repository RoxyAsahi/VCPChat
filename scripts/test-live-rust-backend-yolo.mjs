import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../archive/agent-runtime/rustDaemonTransport');
const repo = path.resolve(import.meta.dirname, '..');
await requireLiveRustEnvironment();

let localApproval = null;
let toolStarted = false;
let toolCompleted = false;
const observed = [];
const redactDiagnostic = (value) => String(value || '')
    .replaceAll(process.env.VCP_API_KEY || '__no-key__', '[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .slice(0, 360);
let finishTurn;
const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('backend YOLO PowerShell smoke timed out')), 120_000);
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
        if (event.type.startsWith('tool.') || event.type.startsWith('approval.')) {
            observed.push({
                type: event.type,
                toolName: event.payload?.toolName || null,
                diagnostic: redactDiagnostic(
                    event.payload?.error
                    || event.payload?.detail
                    || event.payload?.message
                    || event.payload?.reason,
                ) || null,
            });
        }
        if (event.type === 'approval.requested') {
            localApproval = event;
            transport.request('approval', {
                approvalId: event.payload?.approvalId,
                allowed: true,
                sessionId: event.sessionId,
                turnId: event.turnId,
                toolCallId: event.toolCallId,
                argumentsHash: event.payload?.argumentsHash,
            }).catch(() => {});
        }
        if (event.type === 'tool.running') toolStarted = true;
        if (event.type === 'tool.completed') toolCompleted = true;
    },
});

try {
    await transport.start();
    const session = await transport.request('create-session');
    await transport.request('start-turn', {
        sessionId: session.sessionId,
        turnId: `turn-live-backend-yolo-${Date.now()}`,
        // Read-only process state: this is intentionally the smallest real
        // high-risk classification probe. It changes neither the workspace
        // nor VCPToolBox configuration.
        // VCPChat's enabled distributed server registers this exact manifest
        // name. Without that node ToolBox only sees its server-side plugin
        // inventory, which is a different capability set.
        prompt: '只调用一次 vcp_invoke：toolName=PowerShellExecutor，arguments={"command":"Get-Location"}。等待工具结果后，简短回复完成。',
    });
    await completed;
    assert.ok(localApproval, 'PowerShellExecutor must still reach the Rust local approval boundary');
    assert.equal(toolStarted, true, `after local allow, ToolBox backend YOLO must execute the command; events=${JSON.stringify(observed)}`);
    assert.equal(toolCompleted, true, `backend YOLO path must return a completed tool result; events=${JSON.stringify(observed)}`);
    console.log('Live backend-YOLO smoke passed: local approval → PowerShellExecutor(Get-Location) → completed.');
} finally {
    await transport.stop();
}
