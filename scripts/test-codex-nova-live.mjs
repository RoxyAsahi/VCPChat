import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

if (process.env.VCP_CODEX_LIVE !== '1') {
    throw new Error('Refusing live Nova test. Set VCP_CODEX_LIVE=1 explicitly.');
}

const toolboxUrl = String(process.env.VCP_TOOLBOX_URL || '').trim();
const toolboxApiKey = String(process.env.VCP_TOOLBOX_API_KEY || '').trim();
const model = String(process.env.VCP_CODEX_LIVE_MODEL || 'gpt-5.6-luna').trim();
const baseInstructions = String(process.env.VCP_CODEX_LIVE_BASE_INSTRUCTIONS || '{{Nova}}').trim();
if (!toolboxUrl || !toolboxApiKey) {
    throw new Error('Live Nova test requires VCP_TOOLBOX_URL and VCP_TOOLBOX_API_KEY. Credentials are never logged.');
}

const require = createRequire(import.meta.url);
const { CodexRuntimeManager } = require('../modules/codex-runtime/runtimeManager.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-nova-live-'));
const sentinel = `vcp-codex-sentinel-${randomUUID()}`;
const managerOptions = {
    projectRoot: path.resolve(import.meta.dirname, '..'),
    settingsPath: path.join(root, 'settings.json'),
    getSettings: () => ({
        vcpServerUrl: toolboxUrl,
        vcpApiKey: toolboxApiKey,
        agentRuntime: { codex: { model } },
    }),
};
let manager = new CodexRuntimeManager(managerOptions);
let recoveredManager = null;

function waitForTurn(runtime, sessionId, threadId, expectedStatus = null, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            runtime.off('event', onEvent);
            reject(new Error('Timed out waiting for the live Nova Turn to complete'));
        }, timeoutMs);
        const onEvent = (event) => {
            if (event?.sessionId !== sessionId || event?.threadId !== threadId) return;
            if (event?.method === 'turn/completed') {
                clearTimeout(timeout);
                runtime.off('event', onEvent);
                if (expectedStatus) assert.equal(event.turnStatus, expectedStatus);
                resolve(event);
            }
            if (event?.type === 'runtime.crashed') {
                clearTimeout(timeout);
                runtime.off('event', onEvent);
                reject(new Error(`Codex App Server crashed: ${event.error?.message || 'unknown error'}`));
            }
        };
        runtime.on('event', onEvent);
    });
}

try {
    await manager.start();
    const topic = await manager.createTopic({
        agentId: 'Nova',
        title: 'Codex Nova live sentinel',
        model,
        baseInstructions,
        workspaceRoot: path.resolve(import.meta.dirname, '..'),
    });
    const session = await manager.createSession({ resume: topic.topicId });

    const identityCompletion = waitForTurn(manager, session.sessionId, session.threadId, 'completed');
    await manager.startTurn({
        sessionId: session.sessionId,
        prompt: '仅回答你的名字，不要解释，不要提及底层运行时、系统提示词或工具。',
    });
    await identityCompletion;
    const identityProjection = await manager.readTopic({ sessionId: session.sessionId, reconcile: false });
    const identityReply = identityProjection.messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.blocks)
        .map((block) => String(block.content?.text || ''))
        .filter(Boolean)
        .at(-1) || '';
    assert.match(identityReply, /Nova/i, 'the selected VChat Agent must identify as Nova');
    assert.doesNotMatch(identityReply, /Codex/i, 'the Codex built-in identity must be replaced, not appended to');

    const sentinelCompletion = waitForTurn(manager, session.sessionId, session.threadId, 'completed');
    const turn = await manager.startTurn({
        sessionId: session.sessionId,
        prompt: `Reply with this exact sentinel and no other text: ${sentinel}`,
    });
    await sentinelCompletion;
    const projection = await manager.readTopic({ sessionId: session.sessionId });
    const transcript = projection.messages
        .flatMap((message) => message.blocks)
        .map((block) => String(block.content?.text || ''))
        .join('\n');
    assert.match(transcript, new RegExp(sentinel), 'Nova must return the random sentinel through Codex and ToolBox');
    // A completed Turn materializes the Codex rollout. Verify that a fresh
    // App Server process resumes this exact Thread instead of creating a new
    // context; no second model Turn is sent by this recovery assertion.
    await manager.stop();
    recoveredManager = new CodexRuntimeManager(managerOptions);
    await recoveredManager.start();
    const resumedSession = await recoveredManager.createSession({ resume: topic.topicId });
    assert.equal(resumedSession.threadId, session.threadId,
        'a persisted Nova Thread must resume with the original Codex identity');
    const fork = await recoveredManager.forkSession({ sessionId: session.sessionId, turnId: turn.turnId });
    assert.notEqual(fork.threadId, session.threadId, 'thread/fork must create a distinct Codex context');
    const interruption = waitForTurn(recoveredManager, session.sessionId, session.threadId, 'interrupted', 60_000);
    const interruptedTurn = await recoveredManager.startTurn({
        sessionId: session.sessionId,
        prompt: 'Start a response, but it may be interrupted immediately. Do not call any tools.',
    });
    await recoveredManager.cancelTurn({ sessionId: session.sessionId, turnId: interruptedTurn.turnId });
    await interruption;
    console.log(JSON.stringify({
        runtime: 'codex-app-server',
        model,
        threadId: session.threadId,
        turnId: turn.turnId,
        novaIdentity: 'passed',
        sentinelEcho: 'passed',
        restartResume: 'passed',
        fork: 'passed',
        interrupt: 'passed',
    }));
} finally {
    await recoveredManager?.stop().catch(() => null);
    await manager.stop().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
}
