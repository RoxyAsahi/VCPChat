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

// Keep this framed-stdio contract test completely isolated from a user's
// shared VCPChat configuration. It never makes a model request, so a benign
// placeholder connection is sufficient and no real API key belongs in test
// source or a temporary settings file.
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-agentd-smoke-'));
const settingsPath = path.join(testRoot, 'settings.json');
await fs.writeFile(settingsPath, JSON.stringify({
    vcpServerUrl: 'http://127.0.0.1:9',
    vcpApiKey: 'test-only-placeholder',
    agentRuntime: { tui: { defaultModel: 'gpt-5.6-terra', budget: { maxRequestsPerTurn: 8, maxTokensPerTurn: 120000 } } },
}), 'utf8');
// A control daemon may be attached to Nova while the Workbench is browsing a
// different shared Agent. Seed that Agent's durable Rust Topic so the test
// proves `agentId` is routed by Host rather than inherited from spawn args.
await fs.mkdir(path.join(testRoot, 'UserData', '123', 'topics', 'topic-existing-123'), { recursive: true });
await fs.writeFile(path.join(testRoot, 'UserData', '123', 'topics', 'topic-existing-123', 'agent-state.json'), JSON.stringify({
    version: 1,
    title: '123 的既有 Topic',
    model: 'gpt-5.6-terra',
    workspaceRef: repo,
    updatedAt: 1_700_000_000_000,
    history: [{ id: 'seeded-history', role: 'user', content: '历史消息' }],
}), 'utf8');

function waitForMessage(messages, predicate, label, timeoutMs = 5_000) {
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

async function startApprovalFixtureServer() {
    let modelRequests = 0;
    const server = http.createServer((request, response) => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
            response.writeHead(404).end();
            return;
        }
        const firstRequest = modelRequests++ === 0;
        const delta = firstRequest
            ? {
                // Tool-use models commonly stream reasoning before their
                // vcp_invoke call. Keep this in the direct-daemon smoke: a
                // terminal reasoning event used to lose turnId here and make
                // the daemon exit only on tool-capable turns.
                reasoning_content: 'I should request the tool.',
                tool_calls: [{
                    index: 0,
                    id: 'call_presence_deny',
                    function: {
                        name: 'vcp_invoke',
                        arguments: JSON.stringify({
                            toolName: 'PowerShellExecutor',
                            arguments: { command: 'Get-Location' },
                        }),
                    },
                }],
            }
            : { content: '本地审批已拒绝。' };
        const body = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
        response.writeHead(200, {
            'content-type': 'text/event-stream',
            'content-length': Buffer.byteLength(body),
            connection: 'close',
        });
        response.end(body);
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return {
        server,
        url: `http://127.0.0.1:${address.port}`,
    };
}

let exitError = null;
const controlEvents = [];
const daemonEvents = [];
const transport = new RustDaemonTransport({
    projectRoot: repo,
    settingsPath,
    agentsDir: path.join(testRoot, 'Agents'),
    workspaceRoot: repo,
    model: 'gpt-5.6-terra',
    agent: 'Nova',
    onMessage: (message) => {
        if (message?.type === 'control-event') controlEvents.push(message);
        if (message?.type === 'event') daemonEvents.push(message.event);
    },
    onExit: (_code, _signal, error) => { exitError = error; },
});

await transport.start();
assert.equal(transport.readyMessage?.buildRevision, pinnedRevision,
    'the smoke daemon must be compiled from the exact in-repository Rust revision');
assert.equal(transport.readyMessage?.protocolRevision, '1.2', 'daemon must advertise the v1.2 GUI protocol revision');
await transport.request('get-settings', {}, 'smoke-settings-request');
await transport.request('set-workbench-presence', { mounted: false }, 'smoke-presence-request');
const created = await transport.request('create-session');
assert.ok(created.sessionId?.startsWith('session_'));
assert.ok(created.topicId?.startsWith('topic_'), 'create-session must report the durable Topic identity to GUI hosts');
await transport.request('list-topics', { agentId: '123' }, 'smoke-other-agent-topics');
const otherAgentTopicDeadline = Date.now() + 5_000;
while (!controlEvents.some((event) => event.requestId === 'smoke-other-agent-topics') && Date.now() < otherAgentTopicDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
}
const otherAgentTopics = controlEvents.find((event) => event.requestId === 'smoke-other-agent-topics');
assert.equal(otherAgentTopics?.kind, 'topics', 'cross-Agent Topic browsing must resolve through the daemon control plane');
assert.deepEqual(otherAgentTopics?.payload?.map((topic) => ({ id: topic.id, agentId: topic.agentId })), [{
    id: 'topic-existing-123', agentId: '123',
}], 'the daemon must return the selected Agent history without creating a Session');
const readinessDeadline = Date.now() + 7_000;
while (!daemonEvents.some((event) => event?.type === 'runtime.readiness'
    && event?.payload?.toolbox?.state === 'unavailable') && Date.now() < readinessDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
}
assert.equal(daemonEvents.some((event) => event?.type === 'runtime.readiness'
    && event?.payload?.toolbox?.state === 'checking'), true,
    'direct daemon must publish the initial daemon-owned ToolBox readiness state');
assert.equal(daemonEvents.some((event) => event?.type === 'runtime.readiness'
    && event?.payload?.toolbox?.state === 'unavailable'), true,
    'direct daemon must publish the asynchronous unavailable result instead of leaving GUI at checking');
await transport.request('replace-interaction-queue', {
    sessionId: created.sessionId,
    interactions: [{ interactionId: 'smoke-follow-up', kind: 'follow-up', prompt: '完成后总结' }],
}, 'smoke-queue-request');
const deadline = Date.now() + 5_000;
while (!controlEvents.some((event) => event.kind === 'interaction-queue') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
}
assert.deepEqual(controlEvents.find((event) => event.kind === 'interaction-queue')?.payload, [
    { interactionId: 'smoke-follow-up', kind: 'follow-up', prompt: '完成后总结' },
], 'direct daemon must project the Core-validated replacement queue back to GUI hosts');
assert.equal(controlEvents.find((event) => event.kind === 'interaction-queue')?.requestId, 'smoke-queue-request',
    'control responses must retain the exact framed requestId');
const settingsDeadline = Date.now() + 5_000;
while (!controlEvents.some((event) => event.kind === 'settings') && Date.now() < settingsDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
}
assert.deepEqual(controlEvents.find((event) => event.kind === 'settings')?.payload?.budget, {
    maxRequestsPerTurn: 8, maxTokensPerTurn: 120000,
}, 'direct daemon must expose only non-sensitive workbench settings');
assert.equal(controlEvents.find((event) => event.kind === 'settings')?.requestId, 'smoke-settings-request');
const presenceDeadline = Date.now() + 5_000;
while (!controlEvents.some((event) => event.kind === 'workbench-presence') && Date.now() < presenceDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
}
assert.deepEqual(controlEvents.find((event) => event.kind === 'workbench-presence')?.payload, {
    mounted: false,
    deniedApprovals: 0,
}, 'Workbench close must reach Rust Host rather than remain a Main-process flag');
assert.equal(controlEvents.find((event) => event.kind === 'workbench-presence')?.requestId, 'smoke-presence-request');
await transport.request('update-settings', {
    settings: { budget: { maxRequestsPerTurn: 12, maxTokensPerTurn: 240000 } },
});
while (!controlEvents.some((event) => event.kind === 'settings-updated') && Date.now() < settingsDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
}
assert.deepEqual(controlEvents.find((event) => event.kind === 'settings-updated')?.payload?.settings?.budget, {
    maxRequestsPerTurn: 12, maxTokensPerTurn: 240000,
}, 'direct daemon must return the persisted non-sensitive budget snapshot');
const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
assert.deepEqual(persisted.agentRuntime.tui.budget, {
    maxRequestsPerTurn: 12, maxTokensPerTurn: 240000,
}, 'budget update must be persisted by the Rust Host, not renderer storage');
await transport.stop();
await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(transport.child, null);
assert.equal(exitError, null, 'an intentional clean shutdown must not be reported as a daemon crash');

// A GUI reconnect happens immediately after a daemon crash, not 60 seconds
// later. The Topic lease records the daemon PID, so a new daemon must reclaim
// a lock only when Windows can prove that the old owner exited.
let crashExitResolve;
const crashExited = new Promise((resolve) => { crashExitResolve = resolve; });
const crashedTransport = new RustDaemonTransport({
    projectRoot: repo,
    settingsPath,
    agentsDir: path.join(testRoot, 'Agents'),
    workspaceRoot: repo,
    model: 'gpt-5.6-terra',
    agent: 'Nova',
    resume: 'topic-crash-recovery',
    onExit: () => crashExitResolve(),
});
await crashedTransport.start();
const crashedSession = await crashedTransport.request('create-session');
assert.equal(crashedSession.topicId, 'topic-crash-recovery');
crashedTransport.child.kill();
await Promise.race([
    crashExited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('crashed Rust daemon did not exit')), 5_000)),
]);

const recoveredTransport = new RustDaemonTransport({
    projectRoot: repo,
    settingsPath,
    agentsDir: path.join(testRoot, 'Agents'),
    workspaceRoot: repo,
    model: 'gpt-5.6-terra',
    agent: 'Nova',
    resume: 'topic-crash-recovery',
});
await recoveredTransport.start();
const recoveredSession = await recoveredTransport.request('create-session');
assert.equal(recoveredSession.topicId, 'topic-crash-recovery',
    'a new daemon must immediately reclaim a Topic whose crashed PID no longer exists');
await recoveredTransport.stop();

// The close signal must fail-close a *real pending* local approval inside the
// daemon, rather than merely clearing a renderer/Main-process mock.  A tiny
// in-process ToolBox fixture produces one high-risk vcp_invoke, then a normal
// completion after Core receives the denial result.
const approvalFixture = await startApprovalFixtureServer();
const approvalSettingsPath = path.join(testRoot, 'approval-settings.json');
await fs.writeFile(approvalSettingsPath, JSON.stringify({
    vcpServerUrl: approvalFixture.url,
    vcpApiKey: 'test-only-placeholder',
    agentRuntime: { tui: { defaultModel: 'gpt-5.6-terra' } },
}), 'utf8');
const approvalMessages = [];
const approvalTransport = new RustDaemonTransport({
    projectRoot: repo,
    settingsPath: approvalSettingsPath,
    agentsDir: path.join(testRoot, 'Agents'),
    workspaceRoot: repo,
    model: 'gpt-5.6-terra',
    agent: 'Nova',
    resume: 'topic-presence-fail-closed',
    onMessage: (message) => approvalMessages.push(message),
});
try {
    await approvalTransport.start();
    const approvalSession = await approvalTransport.request('create-session');
    const turnId = 'turn-presence-fail-closed';
    await approvalTransport.request('start-turn', {
        sessionId: approvalSession.sessionId,
        turnId,
        prompt: '调用 PowerShellExecutor Get-Location',
    }, 'approval-turn-request');
    const requested = await waitForMessage(
        approvalMessages,
        (message) => message.type === 'event' && message.event?.type === 'approval.requested',
        'a real daemon approval.requested event',
    );
    const approval = requested.event?.payload;
    assert.equal(approval?.toolName, 'PowerShellExecutor');
    assert.equal(requested.event?.turnId, turnId);
    await approvalTransport.request('set-workbench-presence', { mounted: false }, 'approval-presence-close');
    const presence = await waitForMessage(
        approvalMessages,
        (message) => message.type === 'control-event'
            && message.kind === 'workbench-presence'
            && message.requestId === 'approval-presence-close',
        'workbench close acknowledgement',
    );
    assert.equal(presence.payload?.deniedApprovals, 1,
        'closing the Workbench must deny the pending local approval in Rust Host');
    const resolved = await waitForMessage(
        approvalMessages,
        (message) => message.type === 'event'
            && message.event?.type === 'approval.resolved'
            && message.event?.payload?.approvalId === approval?.approvalId,
        'approval.resolved after Workbench close',
    );
    assert.equal(resolved.event?.payload?.decision, 'deny');
    assert.equal(resolved.event?.payload?.reason, 'workbench closed before local approval');
    assert.equal(resolved.event?.sessionId, approvalSession.sessionId);
    assert.equal(resolved.event?.turnId, turnId);
} finally {
    await approvalTransport.stop();
    await new Promise((resolve) => approvalFixture.server.close(resolve));
}
await fs.rm(testRoot, { recursive: true, force: true });
console.log('Rust daemon framed-stdio smoke test passed.');
