import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

if (process.env.VCP_AGENT_LIVE_MUTATE_TOOLBOX_APPROVAL !== '1') {
    throw new Error('This test temporarily changes ToolBox approval config. Set VCP_AGENT_LIVE_MUTATE_TOOLBOX_APPROVAL=1 explicitly.');
}

const require = createRequire(import.meta.url);
const { RustDaemonTransport } = require('../archive/agent-runtime/rustDaemonTransport');
const repo = path.resolve(import.meta.dirname, '..');
const live = await requireLiveRustEnvironment();
const approvalTool = String(process.env.VCP_AGENT_BACKEND_APPROVAL_TOOL || 'PowerShellExecutor');
const expiryMode = process.env.VCP_AGENT_LIVE_BACKEND_APPROVAL_EXPIRY === '1';
const toolboxRoot = path.resolve(String(process.env.VCP_TOOLBOX_ROOT || ''));
if (!process.env.VCP_TOOLBOX_ROOT || !fs.statSync(toolboxRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Set VCP_TOOLBOX_ROOT to the exact running VCPToolBox checkout before this test.');
}
const configPath = path.join(toolboxRoot, 'toolApprovalConfig.json');
if (!fs.statSync(configPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`ToolBox approval config not found: ${configPath}`);
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-agent-backend-approval-'));
const settingsPath = path.join(testRoot, 'settings.json');
const agentsDir = path.join(testRoot, 'Agents');
const seedSentinelPath = path.join(testRoot, 'backend-seed-must-not-execute.txt');
const sentinelPath = path.join(testRoot, 'backend-deny-must-not-execute.txt');
const probeSentinelPath = path.join(testRoot, 'backend-expiry-probe-must-not-execute.txt');
fs.mkdirSync(agentsDir, { recursive: true });
fs.writeFileSync(settingsPath, '{}\n', 'utf8');

const originalConfig = fs.readFileSync(configPath);
const original = JSON.parse(originalConfig.toString('utf8'));
const backupPath = `${configPath}.vcp-agent-test-backup-${process.pid}-${Date.now()}`;
fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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
        reject(new Error(`${label} timed out`));
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

function approvalFrom(message, expectedSentinelPath = sentinelPath) {
    if (message.type !== 'event' || message.event?.type !== 'toolbox.ws') return null;
    if (message.event.payload?.kind !== 'backend-approval-request') return null;
    const value = message.event.payload?.value;
    const data = value?.data && typeof value.data === 'object' ? value.data : value;
    if (!data || data.toolName !== approvalTool) return null;
    const command = String(data.args?.command || '');
    if (!command.includes(path.basename(expectedSentinelPath))) return null;
    return { id: data.requestId, replay: value?._vcpReplay === true };
}

function encodeLegacyToolRequest(toolName, argumentsObject) {
    const fieldStart = '「始」';
    const fieldEnd = '「末」';
    const requestStart = '<<<[TOOL_REQUEST]>>>';
    const requestEnd = '<<<[END_TOOL_REQUEST]>>>';
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(toolName)) {
        throw new Error(`unsafe ToolBox tool name: ${toolName}`);
    }
    const forbidden = [fieldStart, fieldEnd, requestStart, requestEnd];
    const lines = [`tool_name:${fieldStart}${toolName}${fieldEnd}`];
    for (const [key, rawValue] of Object.entries(argumentsObject)) {
        if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)
            || ['tool_name', 'archery', 'ink', 'river', 'vref'].includes(key)) {
            throw new Error(`unsafe ToolBox argument key: ${key}`);
        }
        const value = rawValue === null
            ? ''
            : typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue);
        if (forbidden.some((literal) => value.includes(literal))) {
            throw new Error(`unsafe ToolBox argument value for ${key}`);
        }
        lines.push(`${key}:${fieldStart}${value}${fieldEnd}`);
    }
    return `${requestStart}\n${lines.join('\n')}\n${requestEnd}`;
}

async function invokeLegacyToolRequest(command, signal) {
    const response = await fetch(new URL('/v1/human/tool', `${live.serverUrl}/`), {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${live.apiKey}`,
            'Content-Type': 'text/plain; charset=utf-8',
        },
        body: encodeLegacyToolRequest(approvalTool, { command }),
        signal,
    });
    const text = await response.text();
    return { status: response.status, text };
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
        alwaysApprove: true,
        onMessage,
    };
}

let seedTransport;
let replayTransport;
let verificationTransport;
let seedToolRequestController;
let offlineToolRequestController;
let restored = false;
const observed = [];
const waiters = new Set();
const makeWaiter = (label, timeoutMs) => {
    const waiter = deferred(label, timeoutMs);
    waiters.add(waiter);
    return waiter;
};
try {
    const temporary = {
        ...original,
        enabled: true,
        approveAll: false,
        approvalList: [approvalTool],
        // Three seconds leaves enough room for the online seed/probe while
        // making the offline-expiry branch a bounded live acceptance test.
        ...(expiryMode ? { timeoutMinutes: 0.05 } : {}),
    };
    fs.writeFileSync(configPath, `${JSON.stringify(temporary, null, 2)}\n`, 'utf8');
    // ToolApprovalManager watches this file and reloads it in-process.
    await delay(1_500);

    process.env.VCP_AGENT_TEST_TOOL_CHOICE = 'required';
    process.env.VCP_SERVER_URL = live.serverUrl;
    process.env.VCP_API_KEY = live.apiKey;
    process.env.VCP_AGENT_VCPLOG_DEVICE_NAME = `vcp-agent-replay-${process.pid}-${Date.now()}`;

    // Prove the stable VCPLog device is registered by observing and denying a
    // real VChat DistributedServer request while online. A sleep alone cannot
    // establish that ToolBox created device state for this identity.
    const seedApproval = makeWaiter('online seed ToolBox backend approval request');
    const seedApprovalSent = makeWaiter('online seed ToolBox backend deny acknowledgement');
    seedTransport = new RustDaemonTransport(transportOptions((message) => {
        const approval = approvalFrom(message, seedSentinelPath);
        if (approval && !approval.replay) seedApproval.resolve(approval);
        if (message.type === 'control-event' && message.kind === 'toolbox-approval-sent') {
            seedApprovalSent.resolve(message.payload);
        }
        if (message.type === 'control-error' && message.operation === 'toolbox-approval') {
            seedApprovalSent.reject(new Error(message.payload?.error || 'seed ToolBox approval response failed'));
        }
    }));
    await seedTransport.start();
    const seedSession = await seedTransport.request('create-session');
    await delay(2_000);
    const escapedSeedPath = seedSentinelPath.replaceAll("'", "''");
    seedToolRequestController = new AbortController();
    const seedToolTimeout = setTimeout(() => {
        seedToolRequestController.abort(new Error('online seed ToolBox request timed out'));
    }, 90_000);
    const seedRequest = invokeLegacyToolRequest(
        `Set-Content -LiteralPath '${escapedSeedPath}' -Value 'MUST_NOT_EXECUTE'`,
        seedToolRequestController.signal,
    ).finally(() => clearTimeout(seedToolTimeout));
    const seeded = await seedApproval.promise;
    assert.match(String(seeded.id || ''), /\S/, 'online seed approval must have a backend request ID');
    await seedTransport.request('toolbox-approval', {
        approvalRequestId: seeded.id,
        approved: false,
        reason: 'VCPAgent live replay device registration seed',
    });
    const seedSent = await seedApprovalSent.promise;
    assert.equal(seedSent.approvalRequestId, seeded.id);
    assert.equal(seedSent.approved, false);
    const seedResponse = await seedRequest;
    assert.equal(seedResponse.status, 500,
        `online seed request must be rejected; body=${seedResponse.text.slice(0, 500)}`);
    assert.equal(fs.existsSync(seedSentinelPath), false,
        'the online seed command must never create its sentinel');
    await seedTransport.stop();
    seedTransport = null;
    // ToolBox marks a VCPLog device offline from the server-side close event.
    // Give that close path longer than its 3s reconnect stability window so
    // the next broadcast cannot be recorded as delivered to a stale socket.
    await delay(5_000);

    const escapedPath = sentinelPath.replaceAll("'", "''");
    const command = `Set-Content -LiteralPath '${escapedPath}' -Value 'MUST_NOT_EXECUTE'`;
    offlineToolRequestController = new AbortController();
    const offlineToolTimeout = setTimeout(() => {
        offlineToolRequestController.abort(new Error('offline ToolBox request timed out'));
    }, 90_000);
    const offlineToolRequest = invokeLegacyToolRequest(
        command,
        offlineToolRequestController.signal,
    ).finally(() => clearTimeout(offlineToolTimeout));
    let offlineRequestSettled = false;
    offlineToolRequest.finally(() => { offlineRequestSettled = true; }).catch(() => {});
    await delay(1_500);
    assert.equal(offlineRequestSettled, false,
        'PowerShellExecutor must be waiting for ToolBox backend approval while the Rust observer is offline');

    if (expiryMode) {
        const expiredResponse = await offlineToolRequest;
        assert.equal(expiredResponse.status, 500,
            `expired backend approval must terminate /v1/human/tool; body=${expiredResponse.text.slice(0, 500)}`);
        assert.match(expiredResponse.text, /timed out/i,
            'the offline request must be rejected by the real ToolBox approval timeout');
        assert.equal(fs.existsSync(sentinelPath), false,
            'an expired backend approval must never execute its sentinel command');

        let expiredApprovalReplayed = false;
        const probeApproval = makeWaiter('post-expiry live ToolBox backend approval request');
        const probeSent = makeWaiter('post-expiry ToolBox backend deny acknowledgement');
        replayTransport = new RustDaemonTransport(transportOptions((message) => {
            const expired = approvalFrom(message, sentinelPath);
            if (expired?.replay) expiredApprovalReplayed = true;
            const probe = approvalFrom(message, probeSentinelPath);
            if (probe && !probe.replay) probeApproval.resolve(probe);
            if (message.type === 'control-event' && message.kind === 'toolbox-approval-sent') {
                probeSent.resolve(message.payload);
            }
            if (message.type === 'control-error' && message.operation === 'toolbox-approval') {
                probeSent.reject(new Error(message.payload?.error || 'post-expiry ToolBox approval response failed'));
            }
        }, seedSession.topicId));
        await replayTransport.start();
        await replayTransport.request('create-session');
        // ToolBox itself waits three seconds before emitting any replay.
        await delay(4_500);
        assert.equal(expiredApprovalReplayed, false,
            'an expired ToolBox approval must not be replayed after reconnect');

        const escapedProbePath = probeSentinelPath.replaceAll("'", "''");
        const probeResponse = invokeLegacyToolRequest(
            `Set-Content -LiteralPath '${escapedProbePath}' -Value 'MUST_NOT_EXECUTE'`,
            AbortSignal.timeout(30_000),
        );
        const freshProbe = await probeApproval.promise;
        await replayTransport.request('toolbox-approval', {
            approvalRequestId: freshProbe.id,
            approved: false,
            reason: 'VCPAgent live expired replay probe deny',
        });
        const freshProbeSent = await probeSent.promise;
        assert.equal(freshProbeSent.approvalRequestId, freshProbe.id);
        assert.equal(freshProbeSent.approved, false);
        const completedProbe = await probeResponse;
        assert.equal(completedProbe.status, 500);
        assert.match(completedProbe.text, /approval_rejected|REJECTED by user/i);
        assert.equal(fs.existsSync(probeSentinelPath), false,
            'the post-expiry probe command must never create its sentinel');
        console.log('Live VChat DistributedServer VCPLog expired approval replay rejection passed.');
    } else {

    const replayedApproval = makeWaiter('replayed ToolBox backend approval request');
    const approvalSent = makeWaiter('ToolBox backend deny send acknowledgement');
    replayTransport = new RustDaemonTransport(transportOptions((message) => {
        const approval = approvalFrom(message);
        if (approval?.replay) replayedApproval.resolve(approval);
        if (message.type === 'control-event' && message.kind === 'toolbox-approval-sent') {
            approvalSent.resolve(message.payload);
        }
        if (message.type === 'control-error' && message.operation === 'toolbox-approval') {
            approvalSent.reject(new Error(message.payload?.error || 'ToolBox approval response failed'));
        }
    }, seedSession.topicId));
    await replayTransport.start();
    await replayTransport.request('create-session');
    const replayed = await replayedApproval.promise;
    assert.match(String(replayed.id || ''), /\S/,
        'replayed ToolBox approval must preserve its backend request identity');
    await replayTransport.request('toolbox-approval', {
        approvalRequestId: replayed.id,
        approved: false,
        reason: 'VCPAgent live replay test deny',
    });
    const sent = await approvalSent.promise;
    assert.equal(sent.approvalRequestId, replayed.id);
    assert.equal(sent.approved, false);
    const toolResponse = await offlineToolRequest;
    assert.equal(toolResponse.status, 500,
        `backend rejection must terminate the pending /v1/human/tool request; body=${toolResponse.text.slice(0, 500)}`);
    assert.match(toolResponse.text, /approval_rejected|REJECTED by user/i,
        'the pending ToolBox request must return the real backend rejection');
    assert.equal(fs.existsSync(sentinelPath), false,
        'a ToolBox backend-denied command must never create its sentinel');
    await replayTransport.stop();
    replayTransport = null;

    let replayedAfterResolution = false;
    verificationTransport = new RustDaemonTransport(transportOptions((message) => {
        const approval = approvalFrom(message);
        if (approval?.id === replayed.id) replayedAfterResolution = true;
    }, seedSession.topicId));
    await verificationTransport.start();
    await verificationTransport.request('create-session');
    await delay(2_500);
    assert.equal(replayedAfterResolution, false,
        'ToolBox must remove a resolved approval from its offline replay cache');
    console.log('Live VChat DistributedServer PowerShellExecutor backend deny + offline VCPLog replay passed.');
    }
} finally {
    // Restore the user-owned ToolBox policy before waiting on any daemon
    // shutdown. A stuck WebSocket must never leave the approval policy
    // mutated, and every deferred waiter must have its timer cancelled.
    try {
        fs.writeFileSync(configPath, originalConfig);
        if (!fs.readFileSync(configPath).equals(originalConfig)) {
            throw new Error(`direct config restore did not match ${configPath}`);
        }
        restored = true;
    } catch (error) {
        if (fs.existsSync(backupPath)) {
            fs.copyFileSync(backupPath, configPath);
            restored = fs.readFileSync(configPath).equals(originalConfig);
        }
        if (!restored) console.error(`ToolBox approval config restore failed; backup: ${backupPath}`, error);
    }
    for (const waiter of waiters) waiter.cancel();
    seedToolRequestController?.abort(new Error('backend replay test cleanup'));
    offlineToolRequestController?.abort(new Error('backend replay test cleanup'));
    await Promise.allSettled([
        seedTransport?.stop(),
        replayTransport?.stop(),
        verificationTransport?.stop(),
    ]);
    await delay(1_500);
    if (fs.existsSync(sentinelPath)) fs.rmSync(sentinelPath, { force: true });
    if (fs.existsSync(seedSentinelPath)) fs.rmSync(seedSentinelPath, { force: true });
    if (fs.existsSync(probeSentinelPath)) fs.rmSync(probeSentinelPath, { force: true });
    if (restored && fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (error) {
        console.warn(`backend approval test temp cleanup deferred: ${testRoot}`, error.message);
    }
    assert.equal(restored, true,
        `ToolBox approval config restoration failed; recovery backup remains at ${backupPath}`);
}
