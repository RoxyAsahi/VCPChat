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
const startupTimeoutMs = 90_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function withTimeout(promise, label, milliseconds = timeoutMs) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                const error = new Error(`${label} timed out after ${milliseconds}ms`);
                error.code = 'TEST_POLL_TIMEOUT';
                reject(error);
            }, milliseconds);
        }),
    ]).finally(() => clearTimeout(timer));
}

function reportPhase(phase) {
    console.log(`[electron-codex-recovery] ${phase}`);
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.setTimeout(5_000, () => request.destroy(new Error(`HTTP request timed out: ${url}`)));
        request.on('error', reject);
    });
}

async function waitFor(predicate, message, milliseconds = timeoutMs) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        let result;
        try {
            result = await withTimeout(predicate(), message, Math.min(5_000, remaining));
        } catch (error) {
            if (error?.code !== 'TEST_POLL_TIMEOUT') throw error;
            continue;
        }
        if (result) return result;
        await sleep(100);
    }
    throw new Error(message);
}

async function openAgentWorkbench(page) {
    await page.waitForFunction(() => Boolean(window.nextUiApps?.get?.('agent-workbench')), { timeout: timeoutMs });
    if (await page.$('#nextUiInternalAppHost .agent-workbench-root')) return;
    await page.waitForSelector('#nextUiAddTabBtn', { visible: true, timeout: timeoutMs });
    await page.click('#nextUiAddTabBtn');
    await page.waitForSelector('.next-ui-internal-app-item[title="VCPBuild"]', { visible: true, timeout: timeoutMs });
    await page.evaluate(() => document.querySelector('.next-ui-internal-app-item[title="VCPBuild"]')?.click());
    await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
}

async function selectNovaAgent(page) {
    await page.waitForFunction(() => [...document.querySelectorAll(
        '#nextUiInternalAppHost .sidebar-tab-button',
    )].some((tab) => tab.textContent?.trim() === '助手'), { timeout: timeoutMs });
    await page.evaluate(() => [...document.querySelectorAll(
        '#nextUiInternalAppHost .sidebar-tab-button',
    )].find((tab) => tab.textContent?.trim() === '助手')?.click());
    await page.waitForFunction(() => [...document.querySelectorAll(
        '#nextUiInternalAppHost .agent-chat-agent-row',
    )].some((row) => row.querySelector('.agent-name')?.textContent?.trim() === 'Nova'), { timeout: timeoutMs });
    await page.evaluate(() => [...document.querySelectorAll(
        '#nextUiInternalAppHost .agent-chat-agent-row',
    )].find((row) => row.querySelector('.agent-name')?.textContent?.trim() === 'Nova')?.click());
}

async function selectSessionProjection(page, sessionId, expectedText) {
    await page.waitForFunction((id) => [...document.querySelectorAll(
        '#nextUiInternalAppHost .agent-chat-session-row[data-session-id]',
    )].some((row) => row.dataset.sessionId === id), { timeout: timeoutMs }, sessionId);
    await page.evaluate((id) => [...document.querySelectorAll(
        '#nextUiInternalAppHost .agent-chat-session-row[data-session-id]',
    )].find((row) => row.dataset.sessionId === id)?.click(), sessionId);
    await page.waitForFunction(({ id, marker }) => {
        const active = document.querySelector('#nextUiInternalAppHost .agent-chat-session-row.active[data-session-id]');
        const feed = document.querySelector('#nextUiInternalAppHost .agent-chat-messages');
        return active?.dataset.sessionId === id && feed?.textContent?.includes(marker);
    }, { timeout: timeoutMs }, { id: sessionId, marker: expectedText });
    return page.evaluate(() => {
        const feed = document.querySelector('#nextUiInternalAppHost .agent-chat-messages');
        return {
            text: feed?.textContent || '',
            messageIds: [...(feed?.querySelectorAll('[data-message-id]') || [])]
                .map((row) => row.dataset.messageId).filter(Boolean),
            reasoningCards: feed?.querySelectorAll('.agent-chat-reasoning-block').length || 0,
            toolCards: feed?.querySelectorAll('.agent-chat-tool-activity').length || 0,
            toolText: [...(feed?.querySelectorAll('.agent-chat-tool-activity') || [])]
                .map((card) => card.textContent || '').join('\n'),
        };
    });
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
    ChatDataServiceEnabled: false,
    agentRuntime: { codex: { executable: launcherPath, model: 'fixture-model' } },
}), 'utf8');

const port = await freePort();
const startupOutput = { value: '' };
const child = spawn(electron, [
    `--user-data-dir=${appData}`,
    `--remote-debugging-port=${port}`,
    '--enable-logging=stderr',
    '.',
    '--allow-multiple-instances',
], {
    cwd: root,
    env: {
        ...process.env,
        VCPCHAT_APP_DATA_DIR: appData,
        VCPCHAT_E2E_TEST: '1',
        VCP_CODEX_APP_SERVER: launcherPath,
        VCP_FAKE_CODEX_STATE: statePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
});
const captureStartupOutput = (chunk) => {
    startupOutput.value = `${startupOutput.value}${chunk}`.slice(-24_000);
};
child.stdout.on('data', captureStartupOutput);
child.stderr.on('data', captureStartupOutput);

let browser;
try {
    reportPhase('waiting for debugger');
    await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`Electron exited before debugger startup: ${startupOutput.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            return true;
        } catch {
            return false;
        }
    }, `Electron debugger did not start: ${startupOutput.value}`);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = await waitFor(async () => (
        (await browser.pages()).find((candidate) => candidate.url().includes('main.html')) || null
    ), `Electron main renderer did not appear: ${startupOutput.value}`);
    await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`Electron exited before renderer readiness: ${startupOutput.value}`);
        return page.evaluate(() => document.documentElement.dataset.vcpRendererReady === 'true');
    }, `Electron renderer did not become ready: ${startupOutput.value}`, startupTimeoutMs);
    reportPhase('renderer ready');

    const seeded = await withTimeout(page.evaluate(async () => {
        const api = window.chatAPI || window.electronAPI;
        api.agentRuntimeSetWorkbenchPresence(true);
        const topicA = await api.agentSessionCreate({ agentId: 'Nova', title: 'Recovery A', workspaceRoot: '.' });
        const topicB = await api.agentSessionCreate({ agentId: 'Nova', title: 'Recovery B', workspaceRoot: '.' });
        const lifecycleTopic = await api.agentSessionCreate({ agentId: 'Nova', title: 'Lifecycle', workspaceRoot: '.' });
        const approvalBlockedTopic = await api.agentSessionCreate({ agentId: 'Nova', title: 'Approval blocked', workspaceRoot: '.' });
        const sessionA = await api.agentRuntimeEnsureSessionRuntime({ sessionId: topicA.sessionId });
        const sessionB = await api.agentRuntimeEnsureSessionRuntime({ sessionId: topicB.sessionId });
        const lifecycleSession = await api.agentRuntimeEnsureSessionRuntime({ sessionId: lifecycleTopic.sessionId });
        const approvalBlockedSession = await api.agentRuntimeEnsureSessionRuntime({ sessionId: approvalBlockedTopic.sessionId });
        const [turnA, turnB] = await Promise.all([
            api.agentRuntimeStartTurn({ sessionId: sessionA.sessionId, prompt: 'parallel recovery A' }),
            api.agentRuntimeStartTurn({ sessionId: sessionB.sessionId, prompt: 'parallel recovery B' }),
        ]);
        return { sessionA, sessionB, lifecycleSession, approvalBlockedSession, turnA, turnB };
    }), 'seed sessions and turns');
    reportPhase('sessions and turns seeded');
    assert.notEqual(seeded.sessionA.threadId, seeded.sessionB.threadId, 'two Sessions must own distinct Codex Threads');

    const beforeCrash = await waitFor(async () => page.evaluate(async () => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        const running = status.runtimes?.filter((runtime) => runtime.activity === 'running') || [];
        return status.pendingInteractions?.length === 2 && running.length === 2 && status.worker?.pid ? status : null;
    }), 'fixture interaction did not become pending before the crash');
    reportPhase('parallel interactions pending');
    assert.deepEqual(new Set(beforeCrash.runtimes.filter((runtime) => runtime.activity === 'running')
        .map((runtime) => runtime.sessionId)), new Set([seeded.sessionA.sessionId, seeded.sessionB.sessionId]),
    'two running Sessions must remain independently keyed by Session identity');
    const firstPid = Number(beforeCrash.worker.pid);
    assert.ok(firstPid > 0, 'App Server must expose a child PID');

    const isolatedProjection = await withTimeout(page.evaluate(async ({ sessionA, sessionB }) => {
        const api = window.chatAPI || window.electronAPI;
        const [projectionA, projectionB] = await Promise.all([
            api.agentSessionRead({ sessionId: sessionA }),
            api.agentSessionRead({ sessionId: sessionB }),
        ]);
        return { projectionA, projectionB };
    }, { sessionA: seeded.sessionA.sessionId, sessionB: seeded.sessionB.sessionId }), 'read isolated projections');
    reportPhase('projection isolation verified');
    const projectionText = (projection) => JSON.stringify(projection.messages?.map((message) => message.blocks) || []);
    assert.match(projectionText(isolatedProjection.projectionA), /parallel recovery A/);
    assert.doesNotMatch(projectionText(isolatedProjection.projectionA), /parallel recovery B/);
    assert.match(projectionText(isolatedProjection.projectionB), /parallel recovery B/);
    assert.doesNotMatch(projectionText(isolatedProjection.projectionB), /parallel recovery A/);

    await openAgentWorkbench(page);
    await selectNovaAgent(page);
    const visibleA = await selectSessionProjection(page, seeded.sessionA.sessionId, 'assistant-result:parallel recovery A');
    assert.ok(visibleA.reasoningCards >= 1, 'running Session A must render its persisted reasoning card');
    assert.ok(visibleA.toolCards >= 1, 'running Session A must render its persisted ToolBox card');
    assert.match(visibleA.toolText, /FileOperator/);
    assert.doesNotMatch(visibleA.text, /parallel recovery B/,
        'selecting Session A must not render Session B blocks');
    const visibleB = await selectSessionProjection(page, seeded.sessionB.sessionId, 'assistant-result:parallel recovery B');
    assert.ok(visibleB.reasoningCards >= 1, 'running Session B must render its persisted reasoning card');
    assert.ok(visibleB.toolCards >= 1, 'running Session B must render its persisted ToolBox card');
    assert.match(visibleB.toolText, /FileOperator/);
    assert.doesNotMatch(visibleB.text, /parallel recovery A/,
        'selecting Session B must not render Session A blocks');
    const returnedA = await selectSessionProjection(page, seeded.sessionA.sessionId, 'assistant-result:parallel recovery A');
    assert.deepEqual(returnedA.messageIds, visibleA.messageIds,
        'A to B to A must restore the same normalized SQLite-backed Block identities');
    assert.equal(returnedA.reasoningCards, visibleA.reasoningCards);
    assert.equal(returnedA.toolCards, visibleA.toolCards);
    reportPhase('interactive A-to-B-to-A projection restoration verified');

    const lifecycle = await withTimeout(page.evaluate(async ({ lifecycleSession, approvalBlockedSession }) => {
        const api = window.chatAPI || window.electronAPI;
        await api.agentSessionArchive({ sessionId: lifecycleSession });
        const archivedOnce = await api.agentSessionList({ archived: true });
        await api.agentSessionRestore({ sessionId: lifecycleSession });
        const activeAgain = await api.agentSessionList({});
        await api.agentSessionArchive({ sessionId: lifecycleSession });
        const deleted = await api.agentSessionDelete({ sessionId: lifecycleSession });

        await api.agentSessionArchive({ sessionId: approvalBlockedSession });
        await api.agentSessionRead({ sessionId: approvalBlockedSession });
        return {
            archivedOnce: archivedOnce.some((entry) => entry.sessionId === lifecycleSession),
            activeAgain: activeAgain.some((entry) => entry.sessionId === lifecycleSession),
            deleted: deleted.deleted,
        };
    }, {
        lifecycleSession: seeded.lifecycleSession.sessionId,
        approvalBlockedSession: seeded.approvalBlockedSession.sessionId,
    }), 'archive restore and delete lifecycle');
    reportPhase('archive restore and delete lifecycle verified');
    assert.deepEqual(lifecycle, { archivedOnce: true, activeAgain: true, deleted: true });
    const archivedInteraction = await waitFor(async () => page.evaluate(async (sessionId) => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status.pendingInteractions?.find((interaction) => interaction.sessionId === sessionId) || null;
    }, seeded.approvalBlockedSession.sessionId), 'archived Session interaction was not routed to its Session');
    const blockedDelete = await page.evaluate(async (sessionId) => {
        try {
            await (window.chatAPI || window.electronAPI).agentSessionDelete({ sessionId });
            return null;
        } catch (error) {
            return { message: error?.message || String(error) };
        }
    }, seeded.approvalBlockedSession.sessionId);
    assert.match(blockedDelete?.message || '', /SESSION_BUSY|interaction|Finish or cancel/i,
        'permanent deletion must fail closed while the archived Session owns a pending interaction');
    await withTimeout(page.evaluate(async (interaction) => (window.chatAPI || window.electronAPI).agentRuntimeRespondInteraction({
        source: interaction.source,
        requestId: interaction.requestId,
        kind: interaction.kind,
        generation: interaction.generation,
        response: { answers: { confirm: { answers: [] } } },
    }), archivedInteraction), 'respond to archived session interaction');
    assert.equal(await withTimeout(page.evaluate(async (sessionId) => (
        (window.chatAPI || window.electronAPI).agentSessionDelete({ sessionId })
    ).then((result) => result.deleted), seeded.approvalBlockedSession.sessionId), 'delete archived session after interaction'), true);
    reportPhase('busy deletion safety verified');

    process.kill(firstPid, 'SIGKILL');
    await waitFor(async () => page.evaluate(async () => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status.state === 'crashed' ? status : null;
    }), 'Runtime did not report the killed App Server as crashed');
    reportPhase('runtime crash observed');

    const localAfterCrash = await withTimeout(page.evaluate(async ({ sessionA, sessionB }) => {
        const api = window.chatAPI || window.electronAPI;
        const [projectionA, projectionB, topics, status] = await Promise.all([
            api.agentSessionReadProjection({ sessionId: sessionA }),
            api.agentSessionReadProjection({ sessionId: sessionB }),
            api.agentSessionList({}),
            api.agentRuntimeGetStatus(),
        ]);
        return {
            projectionA: projectionA.session.sessionId,
            projectionB: projectionB.session.sessionId,
            topicIds: topics.map((topic) => topic.sessionId),
            pendingInteractions: status.pendingInteractions.length,
        };
    }, { sessionA: seeded.sessionA.sessionId, sessionB: seeded.sessionB.sessionId }), 'read local projections after crash');
    reportPhase('local projections readable after crash');
    assert.equal(localAfterCrash.projectionA, seeded.sessionA.sessionId);
    assert.equal(localAfterCrash.projectionB, seeded.sessionB.sessionId);
    assert.ok(localAfterCrash.topicIds.includes(seeded.sessionA.sessionId));
    assert.ok(localAfterCrash.topicIds.includes(seeded.sessionB.sessionId));
    assert.equal(localAfterCrash.pendingInteractions, 0, 'crash must fail-close and clear old-generation interactions');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    reportPhase('renderer reloaded');
    const afterRendererReload = await withTimeout(page.evaluate(async ({ sessionA, sessionB }) => {
        const api = window.chatAPI || window.electronAPI;
        const [projectionA, projectionB, topics, status] = await Promise.all([
            api.agentSessionReadProjection({ sessionId: sessionA }),
            api.agentSessionReadProjection({ sessionId: sessionB }),
            api.agentSessionList({}),
            api.agentRuntimeGetStatus(),
        ]);
        return {
            sessionA: projectionA.session.sessionId,
            sessionB: projectionB.session.sessionId,
            topicIds: topics.map((topic) => topic.sessionId),
            state: status.state,
        };
    }, { sessionA: seeded.sessionA.sessionId, sessionB: seeded.sessionB.sessionId }), 'read projections after renderer reload');
    assert.equal(afterRendererReload.sessionA, seeded.sessionA.sessionId);
    assert.equal(afterRendererReload.sessionB, seeded.sessionB.sessionId);
    assert.ok(afterRendererReload.topicIds.includes(seeded.sessionA.sessionId));
    assert.ok(afterRendererReload.topicIds.includes(seeded.sessionB.sessionId));
    assert.equal(afterRendererReload.state, 'crashed', 'Renderer reload must not silently restart App Server');
    await openAgentWorkbench(page);
    await selectNovaAgent(page);
    const reloadedA = await selectSessionProjection(page, seeded.sessionA.sessionId, 'assistant-result:parallel recovery A');
    assert.ok(reloadedA.reasoningCards >= 1 && reloadedA.toolCards >= 1,
        'Renderer reload must restore Session A reasoning and ToolBox cards from SQLite');
    assert.deepEqual(reloadedA.messageIds, visibleA.messageIds,
        'Renderer reload must preserve normalized Block ordering and message identity');
    assert.doesNotMatch(reloadedA.text, /parallel recovery B/);
    reportPhase('renderer reload projection cards verified');

    const recovered = await withTimeout(page.evaluate(async (sessionId) => {
        const api = window.chatAPI || window.electronAPI;
        const session = await api.agentRuntimeEnsureSessionRuntime({ sessionId, reason: 'recovery-test' });
        const status = await api.agentRuntimeGetStatus();
        return { session, status };
    }, seeded.sessionB.sessionId), 'restart and resume runtime on demand');
    reportPhase('runtime restarted on demand');
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
        interactiveSessionSwitch: true,
        reasoningAndToolCardsRestored: true,
        lifecycleArchiveRestoreDelete: true,
        demandRestart: true,
        replayedTurns: 0,
        replayedInteractions: 0,
    }));
} finally {
    if (browser) {
        await withTimeout(browser.close(), 'close Electron browser', 5_000).catch(() => null);
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
