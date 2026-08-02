import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const fixture = path.join(root, 'scripts', 'fixtures', 'fake-codex-app-server.mjs');
const timeoutMs = 45_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        }).on('error', reject);
    });
}

async function waitFor(predicate, message) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await predicate();
        if (result) return result;
        await sleep(100);
    }
    throw new Error(message);
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-codex-recovery-'));
const statePath = path.join(appData, 'fake-codex-state.json');
const launcherPath = path.join(appData, process.platform === 'win32' ? 'codex-app-server.cmd' : 'codex-app-server');
if (process.platform === 'win32') {
    await fs.writeFile(launcherPath, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, 'utf8');
} else {
    await fs.writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o755 });
}
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    enableDistributedServer: false,
    agentRuntime: { codex: { executable: launcherPath, model: 'fixture-model' } },
}), 'utf8');

const port = await freePort();
const stderr = { value: '' };
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: {
        ...process.env,
        VCPCHAT_APP_DATA_DIR: appData,
        VCPCHAT_E2E_TEST: '1',
        VCP_CODEX_APP_SERVER: launcherPath,
        VCP_FAKE_CODEX_STATE: statePath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
child.stderr.on('data', (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-16_000); });

let browser;
try {
    await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`Electron exited before debugger startup: ${stderr.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            return true;
        } catch {
            return false;
        }
    }, `Electron debugger did not start: ${stderr.value}`);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = await waitFor(async () => (
        (await browser.pages()).find((candidate) => candidate.url().includes('main.html')) || null
    ), `Electron main renderer did not appear: ${stderr.value}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });

    const seeded = await page.evaluate(async () => {
        const api = window.chatAPI || window.electronAPI;
        api.agentRuntimeSetWorkbenchPresence(true);
        const topicA = await api.agentRuntimeCreateTopic({ agentId: 'Nova', title: 'Recovery A', workspaceRoot: '.' });
        const topicB = await api.agentRuntimeCreateTopic({ agentId: 'Nova', title: 'Recovery B', workspaceRoot: '.' });
        const lifecycleTopic = await api.agentRuntimeCreateTopic({ agentId: 'Nova', title: 'Lifecycle', workspaceRoot: '.' });
        const approvalBlockedTopic = await api.agentRuntimeCreateTopic({ agentId: 'Nova', title: 'Approval blocked', workspaceRoot: '.' });
        const sessionA = await api.agentRuntimeCreateSession({ resume: topicA.topicId });
        const sessionB = await api.agentRuntimeCreateSession({ resume: topicB.topicId });
        const lifecycleSession = await api.agentRuntimeCreateSession({ resume: lifecycleTopic.topicId });
        const approvalBlockedSession = await api.agentRuntimeCreateSession({ resume: approvalBlockedTopic.topicId });
        const [turnA, turnB] = await Promise.all([
            api.agentRuntimeStartTurn({ sessionId: sessionA.sessionId, prompt: 'parallel recovery A' }),
            api.agentRuntimeStartTurn({ sessionId: sessionB.sessionId, prompt: 'parallel recovery B' }),
        ]);
        return { sessionA, sessionB, lifecycleSession, approvalBlockedSession, turnA, turnB };
    });
    assert.notEqual(seeded.sessionA.threadId, seeded.sessionB.threadId, 'two Sessions must own distinct Codex Threads');

    const beforeCrash = await waitFor(async () => page.evaluate(async () => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        const running = status.runtimes?.filter((runtime) => runtime.activity === 'running') || [];
        return status.pendingInteractions?.length === 2 && running.length === 2 && status.worker?.pid ? status : null;
    }), 'fixture interaction did not become pending before the crash');
    assert.deepEqual(new Set(beforeCrash.runtimes.filter((runtime) => runtime.activity === 'running')
        .map((runtime) => runtime.sessionId)), new Set([seeded.sessionA.sessionId, seeded.sessionB.sessionId]),
    'two running Sessions must remain independently keyed by Session identity');
    const firstPid = Number(beforeCrash.worker.pid);
    assert.ok(firstPid > 0, 'App Server must expose a child PID');

    const isolatedProjection = await page.evaluate(async ({ sessionA, sessionB }) => {
        const api = window.chatAPI || window.electronAPI;
        const [projectionA, projectionB] = await Promise.all([
            api.agentRuntimeReadTopic({ sessionId: sessionA }),
            api.agentRuntimeReadTopic({ sessionId: sessionB }),
        ]);
        return { projectionA, projectionB };
    }, { sessionA: seeded.sessionA.sessionId, sessionB: seeded.sessionB.sessionId });
    const projectionText = (projection) => JSON.stringify(projection.messages?.map((message) => message.blocks) || []);
    assert.match(projectionText(isolatedProjection.projectionA), /parallel recovery A/);
    assert.doesNotMatch(projectionText(isolatedProjection.projectionA), /parallel recovery B/);
    assert.match(projectionText(isolatedProjection.projectionB), /parallel recovery B/);
    assert.doesNotMatch(projectionText(isolatedProjection.projectionB), /parallel recovery A/);

    const lifecycle = await page.evaluate(async ({ lifecycleSession, approvalBlockedSession }) => {
        const api = window.chatAPI || window.electronAPI;
        await api.agentRuntimeCloseSession({ sessionId: lifecycleSession });
        const archivedOnce = await api.agentRuntimeListTopics({ archived: true });
        await api.agentRuntimeRestoreSession({ sessionId: lifecycleSession });
        const activeAgain = await api.agentRuntimeListTopics({});
        await api.agentRuntimeCloseSession({ sessionId: lifecycleSession });
        const deleted = await api.agentRuntimePermanentlyDeleteSession({ sessionId: lifecycleSession });

        await api.agentRuntimeCloseSession({ sessionId: approvalBlockedSession });
        await api.agentRuntimeReadTopic({ sessionId: approvalBlockedSession });
        return {
            archivedOnce: archivedOnce.some((entry) => entry.sessionId === lifecycleSession),
            activeAgain: activeAgain.some((entry) => entry.sessionId === lifecycleSession),
            deleted: deleted.deleted,
        };
    }, {
        lifecycleSession: seeded.lifecycleSession.sessionId,
        approvalBlockedSession: seeded.approvalBlockedSession.sessionId,
    });
    assert.deepEqual(lifecycle, { archivedOnce: true, activeAgain: true, deleted: true });
    const archivedInteraction = await waitFor(async () => page.evaluate(async (sessionId) => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status.pendingInteractions?.find((interaction) => interaction.sessionId === sessionId) || null;
    }, seeded.approvalBlockedSession.sessionId), 'archived Session interaction was not routed to its Session');
    const blockedDelete = await page.evaluate(async (sessionId) => {
        try {
            await (window.chatAPI || window.electronAPI).agentRuntimePermanentlyDeleteSession({ sessionId });
            return null;
        } catch (error) {
            return { message: error?.message || String(error) };
        }
    }, seeded.approvalBlockedSession.sessionId);
    assert.match(blockedDelete?.message || '', /SESSION_BUSY|interaction|Finish or cancel/i,
        'permanent deletion must fail closed while the archived Session owns a pending interaction');
    await page.evaluate(async (interaction) => (window.chatAPI || window.electronAPI).agentRuntimeRespondInteraction({
        source: interaction.source,
        requestId: interaction.requestId,
        kind: interaction.kind,
        generation: interaction.generation,
        response: { answers: { confirm: { answers: [] } } },
    }), archivedInteraction);
    assert.equal(await page.evaluate(async (sessionId) => (
        (window.chatAPI || window.electronAPI).agentRuntimePermanentlyDeleteSession({ sessionId })
    ).then((result) => result.deleted), seeded.approvalBlockedSession.sessionId), true);

    process.kill(firstPid, 'SIGKILL');
    await waitFor(async () => page.evaluate(async () => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status.state === 'crashed' ? status : null;
    }), 'Runtime did not report the killed App Server as crashed');

    const localAfterCrash = await page.evaluate(async ({ sessionA, sessionB }) => {
        const api = window.chatAPI || window.electronAPI;
        const [projectionA, projectionB, topics, status] = await Promise.all([
            api.agentRuntimeReadProjection({ sessionId: sessionA }),
            api.agentRuntimeReadProjection({ sessionId: sessionB }),
            api.agentRuntimeListTopics({}),
            api.agentRuntimeGetStatus(),
        ]);
        return {
            projectionA: projectionA.session.sessionId,
            projectionB: projectionB.session.sessionId,
            topicIds: topics.map((topic) => topic.sessionId),
            pendingInteractions: status.pendingInteractions.length,
        };
    }, { sessionA: seeded.sessionA.sessionId, sessionB: seeded.sessionB.sessionId });
    assert.equal(localAfterCrash.projectionA, seeded.sessionA.sessionId);
    assert.equal(localAfterCrash.projectionB, seeded.sessionB.sessionId);
    assert.ok(localAfterCrash.topicIds.includes(seeded.sessionA.sessionId));
    assert.ok(localAfterCrash.topicIds.includes(seeded.sessionB.sessionId));
    assert.equal(localAfterCrash.pendingInteractions, 0, 'crash must fail-close and clear old-generation interactions');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    const afterRendererReload = await page.evaluate(async ({ sessionA, sessionB }) => {
        const api = window.chatAPI || window.electronAPI;
        const [projectionA, projectionB, topics, status] = await Promise.all([
            api.agentRuntimeReadProjection({ sessionId: sessionA }),
            api.agentRuntimeReadProjection({ sessionId: sessionB }),
            api.agentRuntimeListTopics({}),
            api.agentRuntimeGetStatus(),
        ]);
        return {
            sessionA: projectionA.session.sessionId,
            sessionB: projectionB.session.sessionId,
            topicIds: topics.map((topic) => topic.sessionId),
            state: status.state,
        };
    }, { sessionA: seeded.sessionA.sessionId, sessionB: seeded.sessionB.sessionId });
    assert.equal(afterRendererReload.sessionA, seeded.sessionA.sessionId);
    assert.equal(afterRendererReload.sessionB, seeded.sessionB.sessionId);
    assert.ok(afterRendererReload.topicIds.includes(seeded.sessionA.sessionId));
    assert.ok(afterRendererReload.topicIds.includes(seeded.sessionB.sessionId));
    assert.equal(afterRendererReload.state, 'crashed', 'Renderer reload must not silently restart App Server');

    const recovered = await page.evaluate(async (sessionId) => {
        const api = window.chatAPI || window.electronAPI;
        const session = await api.agentRuntimeEnsureSessionRuntime({ sessionId, reason: 'recovery-test' });
        const status = await api.agentRuntimeGetStatus();
        return { session, status };
    }, seeded.sessionB.sessionId);
    assert.equal(recovered.session.threadId, seeded.sessionB.threadId, 'demand restart must resume the persisted Thread');
    assert.notEqual(Number(recovered.status.worker.pid), firstPid, 'demand restart must use a replacement App Server process');
    assert.equal(recovered.status.pendingInteractions.length, 0, 'resume must not replay a pre-crash interaction');

    const fixtureState = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(fixtureState.starts, 2, 'the Electron flow must start exactly one replacement App Server');
    assert.equal(fixtureState.turnStarts, 2, 'restart/resume must not replay either accepted Turn');
    assert.ok(fixtureState.resumes >= 1, 'the replacement App Server must receive thread/resume');
    assert.ok(fixtureState.archives >= 3 && fixtureState.unarchives >= 1 && fixtureState.deletes >= 2,
        'the Electron gate must exercise archive, restore and permanent delete against the fake App Server');

    await page.evaluate(async () => (window.chatAPI || window.electronAPI).agentRuntimeStop());
    console.log(JSON.stringify({
        sessions: 4,
        concurrentRunningSessions: 2,
        firstPid,
        recoveredPid: recovered.status.worker.pid,
        sqliteReadableAfterCrash: true,
        rendererReloadPreservedSessions: true,
        lifecycleArchiveRestoreDelete: true,
        demandRestart: true,
        replayedTurns: 0,
        replayedInteractions: 0,
    }));
} finally {
    if (browser) {
        await browser.close().catch(() => null);
        browser.disconnect();
    }
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5_000)]).catch(() => null);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fs.rm(appData, { recursive: true, force: true });
            break;
        } catch (error) {
            if (attempt === 4) throw error;
            await sleep(250);
        }
    }
}
