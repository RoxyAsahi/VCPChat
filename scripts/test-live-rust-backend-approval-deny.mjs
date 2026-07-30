import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../modules/agent-runtime/rustDaemonTransport');
const repo = path.resolve(import.meta.dirname, '..');
const live = await requireLiveRustEnvironment();
const approvalTool = String(process.env.VCP_AGENT_BACKEND_APPROVAL_TOOL || 'PowerShellExecutor');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-backend-deny-'));
const settingsPath = path.join(testRoot, 'settings.json');
const agentsDir = path.join(testRoot, 'Agents');
const sentinelPath = path.join(testRoot, 'backend-deny-must-not-execute.txt');
fs.mkdirSync(agentsDir, { recursive: true });
fs.writeFileSync(settingsPath, '{}\n', 'utf8');

function deferred(label, timeoutMs = 90_000) {
    let resolve;
    let reject;
    let settled = false;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`${label} timed out; confirm the running ToolBox requires backend approval for ${approvalTool}`));
    }, timeoutMs);
    return {
        promise,
        resolve(value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        },
        reject(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        },
        cancel() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
        },
    };
}

function approvalFrom(message) {
    if (message.type !== 'event' || message.event?.type !== 'toolbox.ws') return null;
    if (message.event.payload?.kind !== 'backend-approval-request') return null;
    const value = message.event.payload?.value;
    const data = value?.data && typeof value.data === 'object' ? value.data : value;
    if (!data || data.toolName !== approvalTool) return null;
    const command = String(data.args?.command || '');
    if (!command.includes(path.basename(sentinelPath))) return null;
    return { id: data.requestId };
}

let transport;
const approval = deferred('ToolBox backend approval request');
const sent = deferred('ToolBox backend deny WebSocket write');
const observed = [];
const diagnostic = (event) => String(
    event.payload?.error
    || event.payload?.detail
    || event.payload?.message
    || event.payload?.reason
    || '',
).replaceAll(live.apiKey, '[REDACTED]').slice(0, 400);
try {
    process.env.VCP_AGENT_TEST_TOOL_CHOICE = 'required';
    process.env.VCP_SERVER_URL = live.serverUrl;
    process.env.VCP_API_KEY = live.apiKey;
    transport = new RustDaemonTransport({
        projectRoot: repo,
        settingsPath,
        agentsDir,
        workspaceRoot: repo,
        model: 'gpt-5.6-terra',
        agent: 'Nova',
        alwaysApprove: true,
        onMessage(message) {
            const request = approvalFrom(message);
            if (request) approval.resolve(request);
            if (message.type === 'event') {
                const event = message.event || {};
                if (event.type?.startsWith('tool.') || event.type?.startsWith('turn.')) {
                    observed.push(`${event.type}:${event.payload?.toolName || ''}:${diagnostic(event)}`);
                }
                if (event.type === 'turn.failed') {
                    approval.reject(new Error(`turn failed before backend approval: ${event.payload?.error || 'unknown'}; events=${observed.join(',')}`));
                }
                if (event.type === 'turn.completed' && !request) {
                    approval.reject(new Error(`turn completed without backend approval; events=${observed.join(',')}`));
                }
            }
            if (message.type === 'control-event' && message.kind === 'toolbox-approval-sent') {
                sent.resolve(message.payload);
            }
            if (message.type === 'control-error' && message.operation === 'toolbox-approval') {
                sent.reject(new Error(message.payload?.error || 'ToolBox backend deny failed'));
            }
        },
    });
    await transport.start();
    const session = await transport.request('create-session');
    const escapedPath = sentinelPath.replaceAll("'", "''");
    await transport.request('start-turn', {
        sessionId: session.sessionId,
        turnId: `turn-live-backend-deny-${Date.now()}`,
        prompt: `只调用一次 vcp_invoke：toolName=${approvalTool}，arguments={"command":"Set-Content -LiteralPath '${escapedPath}' -Value 'MUST_NOT_EXECUTE'"}。不要改用其他工具。`,
    });
    const request = await approval.promise;
    assert.match(String(request.id || ''), /\S/, 'ToolBox approval must have its own request ID');
    await transport.request('toolbox-approval', {
        approvalRequestId: request.id,
        approved: false,
        reason: 'VCPAgent live backend deny test',
    });
    const result = await sent.promise;
    assert.equal(result.approvalRequestId, request.id);
    assert.equal(result.approved, false);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(fs.existsSync(sentinelPath), false, 'backend-denied PowerShell must not execute');
    console.log('Live ToolBox backend approval deny passed with a confirmed VCPLog WebSocket write.');
} finally {
    approval.cancel();
    sent.cancel();
    await transport?.stop().catch(() => {});
    if (fs.existsSync(sentinelPath)) fs.rmSync(sentinelPath, { force: true });
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (error) {
        console.warn(`backend deny test temp cleanup deferred: ${testRoot}`, error.message);
    }
}
