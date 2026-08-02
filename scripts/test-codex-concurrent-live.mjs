import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

// This is intentionally a live, explicit opt-in gate.  It proves that a
// single App Server process can keep two independent Nova Threads alive while
// one is interrupted.  It must never be made part of the default CI suite.
if (process.env.VCP_CODEX_LIVE !== '1') {
    throw new Error('Refusing concurrent live Nova test. Set VCP_CODEX_LIVE=1 explicitly.');
}

const toolboxUrl = String(process.env.VCP_TOOLBOX_URL || '').trim();
const toolboxApiKey = String(process.env.VCP_TOOLBOX_API_KEY || '').trim();
const model = String(process.env.VCP_CODEX_LIVE_MODEL || 'gpt-5.6-luna').trim();
const baseInstructions = String(process.env.VCP_CODEX_LIVE_BASE_INSTRUCTIONS || '{{Nova}}').trim();
const turnTimeoutMs = Math.max(30_000, Number(process.env.VCP_CODEX_LIVE_TURN_TIMEOUT_MS) || 300_000);
if (!toolboxUrl || !toolboxApiKey) {
    throw new Error('Concurrent live Nova test requires VCP_TOOLBOX_URL and VCP_TOOLBOX_API_KEY. Credentials are never logged.');
}

const require = createRequire(import.meta.url);
const { CodexRuntimeManager } = require('../modules/codex-runtime/runtimeManager.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-codex-concurrent-live-'));
const sentinelB = `vcp-codex-concurrent-b-${randomUUID()}`;
const manager = new CodexRuntimeManager({
    projectRoot: path.resolve(import.meta.dirname, '..'),
    settingsPath: path.join(root, 'settings.json'),
    getSettings: () => ({
        vcpServerUrl: toolboxUrl,
        vcpApiKey: toolboxApiKey,
        agentRuntime: { codex: { model } },
    }),
});
const responseIdentities = [];
manager.on('diagnostic', (line) => {
    const json = /^\[agent-ux\]\s+(.*)$/.exec(String(line || ''))?.[1];
    const event = json ? JSON.parse(json) : null;
    if (event?.name === 'toolbox-response-request') responseIdentities.push({
        responseId: event.responseId || null,
        previousResponseId: event.previousResponseId || null,
        threadId: event.threadId || null,
        turnId: event.turnId || null,
        sessionId: event.sessionId || null,
        metadataKeys: event.metadataKeys || [],
        input: event.input || [],
    });
    if (event?.name === 'toolbox-response-request') {
        console.log(JSON.stringify({ stage: 'toolbox-response-observed', identity: responseIdentities.at(-1) }));
    }
});

function transcript(snapshot) {
    return (snapshot.messages || [])
        .flatMap((message) => message.blocks || [])
        .map((block) => String(block?.content?.text || ''))
        .join('\n');
}

function assistantTranscript(snapshot) {
    return (snapshot.messages || [])
        .filter((message) => message?.role === 'assistant')
        .flatMap((message) => message.blocks || [])
        .map((block) => String(block?.content?.text || ''))
        .join('\n');
}

function terminalWaiter(runtime, sessionId, threadId, expectedStatus) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            runtime.off('event', onEvent);
            reject(new Error(`Timed out waiting for ${expectedStatus} Turn on ${threadId}`));
        }, turnTimeoutMs);
        const onEvent = (event) => {
            if (event?.type === 'runtime.crashed') {
                clearTimeout(timeout);
                runtime.off('event', onEvent);
                reject(new Error(`Codex App Server crashed: ${event.error?.message || 'unknown error'}`));
                return;
            }
            if (event?.sessionId !== sessionId || event?.threadId !== threadId || event?.method !== 'turn/completed') return;
            clearTimeout(timeout);
            runtime.off('event', onEvent);
            assert.equal(event.turnStatus, expectedStatus,
                `Thread ${threadId} must terminally be ${expectedStatus}, not ${event.turnStatus || 'unknown'}`);
            resolve(event);
        };
        runtime.on('event', onEvent);
    });
}

function startedWaiter(runtime, sessionId, threadId) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            runtime.off('event', onEvent);
            reject(new Error(`Timed out waiting for live turn/started on ${threadId}`));
        }, Math.min(turnTimeoutMs, 60_000));
        const onEvent = (event) => {
            if (event?.type === 'runtime.crashed') {
                clearTimeout(timeout);
                runtime.off('event', onEvent);
                reject(new Error(`Codex App Server crashed: ${event.error?.message || 'unknown error'}`));
                return;
            }
            if (event?.sessionId !== sessionId || event?.threadId !== threadId || event?.method !== 'turn/started') return;
            clearTimeout(timeout);
            runtime.off('event', onEvent);
            resolve(event);
        };
        runtime.on('event', onEvent);
    });
}

try {
    console.log(JSON.stringify({ stage: 'start', runtime: 'codex-app-server', model }));
    await manager.start();
    const processPid = manager.getStatus().worker?.pid;
    assert.ok(processPid, 'the long-lived App Server must expose a PID');
    // The production callback logs a privacy-safe shortened identity. The
    // explicit live gate additionally retains the exact in-memory IDs solely
    // to prove A/B routing; it never records prompt content or credentials.
    const adapterOnRequest = manager.responsesAdapter?.onRequest;
    if (manager.responsesAdapter) {
        manager.responsesAdapter.onRequest = (identity) => {
            adapterOnRequest?.(identity);
            responseIdentities.push({
                responseId: identity.responseId || null,
                previousResponseId: identity.previousResponseId || null,
                threadId: identity.threadId || null,
                turnId: identity.turnId || null,
                sessionId: identity.sessionId || null,
                metadataKeys: identity.metadataKeys || [],
                input: identity.input || [],
            });
            console.log(JSON.stringify({
                stage: 'toolbox-response-route',
                threadId: identity.threadId || null,
                turnId: identity.turnId || null,
                sessionId: identity.sessionId || null,
            }));
        };
    }

    const [topicA, topicB] = await Promise.all([
        manager.createTopic({
            agentId: 'Nova', title: 'Concurrent live A', model, baseInstructions,
            workspaceRoot: path.resolve(import.meta.dirname, '..'),
        }),
        manager.createTopic({
            agentId: 'Nova', title: 'Concurrent live B', model, baseInstructions,
            workspaceRoot: path.resolve(import.meta.dirname, '..'),
        }),
    ]);
    const [sessionA, sessionB] = await Promise.all([
        manager.createSession({ resume: topicA.topicId }),
        manager.createSession({ resume: topicB.topicId }),
    ]);
    assert.notEqual(sessionA.sessionId, sessionB.sessionId);
    assert.notEqual(sessionA.threadId, sessionB.threadId);

    const startedA = startedWaiter(manager, sessionA.sessionId, sessionA.threadId);
    const startedB = startedWaiter(manager, sessionB.sessionId, sessionB.threadId);
    const interruptedA = terminalWaiter(manager, sessionA.sessionId, sessionA.threadId, 'interrupted');
    const completedB = terminalWaiter(manager, sessionB.sessionId, sessionB.threadId, 'completed');

    // Both Threads receive long-form work. A is interrupted only after both
    // real Turns are active; B must still finish its independent long response
    // and include a random sentinel that exposes any projection leakage.
    const [turnA, turnB] = await Promise.all([
        manager.startTurn({
            sessionId: sessionA.sessionId,
            prompt: 'Write a detailed 30-paragraph Chinese explanation of the current workspace architecture. Do not call tools.',
        }),
        manager.startTurn({
            sessionId: sessionB.sessionId,
            prompt: [
                'Write a detailed Chinese reliability review in at least 12 numbered sections.',
                'Cover Session identity, runtime generation, durable input recovery, SQLite reconciliation, Saga recovery, workspace cancellation, and renderer isolation.',
                'Do not call tools. Finish the final section with this exact sentinel:',
                sentinelB,
            ].join('\n'),
        }),
    ]);
    assert.notEqual(turnA.turnId, turnB.turnId);
    await Promise.all([startedA, startedB]);
    console.log(JSON.stringify({ stage: 'both-turns-live', threadA: sessionA.threadId, threadB: sessionB.threadId }));

    await manager.cancelTurn({ sessionId: sessionA.sessionId, turnId: turnA.turnId });
    await Promise.all([interruptedA, completedB]);

    assert.equal(manager.getStatus().worker?.pid, processPid,
        'two live Threads and one interrupt must not restart the App Server process');
    const [projectionA, projectionB] = await Promise.all([
        manager.readTopic({ sessionId: sessionA.sessionId }),
        manager.readTopic({ sessionId: sessionB.sessionId }),
    ]);
    assert.equal(projectionA.session.threadId, sessionA.threadId);
    assert.equal(projectionB.session.threadId, sessionB.threadId);
    const completedLongResponse = assistantTranscript(projectionB);
    assert.doesNotMatch(transcript(projectionA), new RegExp(sentinelB),
        'B output must never be projected into interrupted Thread A');
    assert.match(completedLongResponse, new RegExp(sentinelB),
        'Thread B must complete with its own sentinel after Thread A is interrupted');
    assert.ok(completedLongResponse.length >= 1_200,
        `Thread B must complete a substantive long response, received ${completedLongResponse.length} characters`);
    console.log(JSON.stringify({
        runtime: 'codex-app-server', model, pid: processPid,
        threadA: sessionA.threadId, threadB: sessionB.threadId,
        concurrentStreaming: 'passed', cancelIsolation: 'passed', projectionIsolation: 'passed',
        completedLongResponseChars: completedLongResponse.length,
        responseIdentityShapes: responseIdentities,
    }));
} finally {
    await manager.stop().catch(() => null);
    fs.rmSync(root, { recursive: true, force: true });
}
