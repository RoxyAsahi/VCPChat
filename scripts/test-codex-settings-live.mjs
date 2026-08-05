import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

assert.equal(process.env.VCP_CODEX_LIVE, '1', 'Set VCP_CODEX_LIVE=1 to run the live Session settings test');
const toolboxUrl = String(process.env.VCP_TOOLBOX_URL || '').trim();
const toolboxApiKey = String(process.env.VCP_TOOLBOX_API_KEY || '').trim();
const model = String(process.env.VCP_CODEX_LIVE_MODEL || 'deepseek-v4-flash').trim();
const baseInstructions = String(process.env.VCP_CODEX_LIVE_BASE_INSTRUCTIONS || '{{Nova}}').trim();
const turnTimeoutMs = Math.max(30_000, Number(process.env.VCP_CODEX_LIVE_TURN_TIMEOUT_MS) || 300_000);
assert.ok(toolboxUrl, 'VCP_TOOLBOX_URL is required');
assert.ok(toolboxApiKey, 'VCP_TOOLBOX_API_KEY is required');

const require = createRequire(import.meta.url);
const { CodexRuntimeManager } = require('../modules/codex-runtime/runtimeManager.js');
const { ToolboxResponsesAdapter } = require('../modules/codex-runtime/toolboxResponsesAdapter.js');
const projectRoot = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-settings-live-'));
const workspace = projectRoot;
const upstreamRequests = [];
const manager = new CodexRuntimeManager({
    projectRoot,
    settingsPath: path.join(scratch, 'settings.json'),
    getSettings: () => ({
        vcpServerUrl: toolboxUrl,
        vcpApiKey: toolboxApiKey,
        agentRuntime: { codex: { model } },
    }),
    getModels: () => [{ id: model, reasoning_efforts: ['high'] }],
    responsesAdapterFactory: (options) => new ToolboxResponsesAdapter({
        ...options,
        fetchImpl: async (url, init) => {
            if (String(url).includes('/v1/chat/completions')) {
                const body = JSON.parse(String(init?.body || '{}'));
                upstreamRequests.push({
                    model: body.model,
                    reasoningEffort: body.reasoning_effort || null,
                    stream: body.stream === true,
                    toolChoice: body.tool_choice ?? null,
                    maxTokens: body.max_tokens ?? null,
                    temperature: body.temperature ?? null,
                    messages: Array.isArray(body.messages) ? body.messages.map((message) => ({
                        role: message.role || null,
                        contentBytes: Buffer.byteLength(String(message.content || ''), 'utf8'),
                    })) : [],
                    tools: Array.isArray(body.tools) ? body.tools.map((tool) => ({
                        name: tool.function?.name || tool.name || null,
                        descriptionBytes: Buffer.byteLength(String(tool.function?.description || tool.description || ''), 'utf8'),
                        parameterBytes: Buffer.byteLength(JSON.stringify(tool.function?.parameters || tool.parameters || {}), 'utf8'),
                    })) : [],
                });
            }
            return fetch(url, init);
        },
    }),
});

function waitForTurn(runtime, session, diagnostics, timeoutMs = turnTimeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            runtime.off('event', onEvent);
            diagnostics.adapter = runtime.readSessionDiagnostics({ sessionId: session.sessionId })?.toolbox?.adapter || null;
            reject(new Error(`Timed out waiting for the live settings Turn; diagnostics=${JSON.stringify(diagnostics)}`));
        }, timeoutMs);
        const onEvent = (event) => {
            if (event?.sessionId !== session.sessionId || event?.threadId !== session.threadId) return;
            if (event?.method === 'turn/completed') {
                clearTimeout(timeout);
                runtime.off('event', onEvent);
                if (event.turnStatus === 'completed') resolve(event);
                else reject(new Error(`Live settings Turn ended as ${event.turnStatus}`));
            }
        };
        runtime.on('event', onEvent);
    });
}

try {
    await manager.start();
    const diagnostics = { notifications: [], stderr: [], upstreamRequests, serverRequests: [] };
    manager.on('event', (event) => {
        if (diagnostics.notifications.length >= 80 || !event?.method) return;
        diagnostics.notifications.push({
            method: event.method,
            turnId: event.turnId || null,
            turnStatus: event.turnStatus || null,
            itemId: event.itemId || null,
            error: String(event?.error?.message || event?.params?.error?.message || '').slice(0, 240) || null,
        });
    });
    manager.transport.on('stderr', (line) => {
        if (diagnostics.stderr.length < 20) diagnostics.stderr.push(String(line).slice(0, 500));
    });
    manager.transport.on('server-request', (request) => {
        if (diagnostics.serverRequests.length < 10) diagnostics.serverRequests.push({
            method: request?.method || null,
            tool: request?.params?.tool || request?.params?.name || null,
            hasTurnId: Boolean(request?.params?.turnId),
            hasCallId: Boolean(request?.params?.callId),
        });
    });
    const topic = await manager.createSessionRecord({
        agentId: 'Nova',
        title: 'Codex live Session settings',
        model,
        baseInstructions,
        workspaceRoot: os.tmpdir(),
        permissionMode: 'ask',
    });
    const session = await manager.createSession({ sessionId: topic.sessionId });
    const transportCalls = [];
    const request = manager.transport.request.bind(manager.transport);
    manager.transport.request = async (method, params, options) => {
        if (method === 'thread/settings/update') transportCalls.push({ method, params: { ...params } });
        return request(method, params, options);
    };

    const before = manager.readSessionConfig({ sessionId: session.sessionId });
    await manager.updateSessionConfig({
        sessionId: session.sessionId,
        expectedConfigRevision: before.configRevision,
        patch: {
            model,
            workspaceRoot: workspace,
            permissionMode: 'always-approve',
            reasoningEffort: 'high',
        },
    });

    const sentinel = `vcp-settings-${randomUUID()}`;
    const completion = waitForTurn(manager, session, diagnostics);
    await manager.startTurn({
        sessionId: session.sessionId,
        prompt: `Reply with exactly this sentinel and no other text: ${sentinel}`,
    });
    await completion;

    const settingsUpdate = transportCalls.at(-1);
    assert.deepEqual(settingsUpdate, {
        method: 'thread/settings/update',
        params: {
            threadId: session.threadId,
            cwd: workspace,
            model,
            approvalPolicy: 'never',
            effort: 'high',
            personality: null,
        },
    });
    assert.ok(upstreamRequests.some((entry) => entry.model === model && entry.reasoningEffort === 'high'),
        'the next real ToolBox Chat request must use the saved model and reasoning effort');
    const applied = manager.readSessionConfig({ sessionId: session.sessionId });
    assert.equal(applied.applyState, 'applied');
    assert.equal(applied.appliedRuntimeConfigRevision, applied.configRevision);
    assert.equal(applied.appliedRuntimeConfig.workspaceRoot, workspace);
    assert.equal(applied.appliedRuntimeConfig.permissionMode, 'always-approve');
    const projection = await manager.readSession({ sessionId: session.sessionId, reconcile: false });
    assert.match(JSON.stringify(projection), new RegExp(sentinel));
    console.log(JSON.stringify({
        runtime: 'codex-app-server',
        model,
        cwd: 'project-workspace',
        approvalPolicy: 'never',
        reasoningEffort: 'high',
        providerPayload: 'passed',
        appliedRevision: applied.appliedRuntimeConfigRevision,
    }));
} finally {
    await manager.stop().catch(() => null);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
