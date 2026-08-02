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
        const sessionA = await api.agentRuntimeCreateSession({ resume: topicA.topicId });
        const sessionB = await api.agentRuntimeCreateSession({ resume: topicB.topicId });
        const turn = await api.agentRuntimeStartTurn({ sessionId: sessionA.sessionId, prompt: 'recovery fixture turn' });
        return { sessionA, sessionB, turn };
    });
    assert.notEqual(seeded.sessionA.threadId, seeded.sessionB.threadId, 'two Sessions must own distinct Codex Threads');

    const beforeCrash = await waitFor(async () => page.evaluate(async () => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status.pendingInteractions?.length === 1 && status.worker?.pid ? status : null;
    }), 'fixture interaction did not become pending before the crash');
    const firstPid = Number(beforeCrash.worker.pid);
    assert.ok(firstPid > 0, 'App Server must expose a child PID');

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
    assert.equal(fixtureState.turnStarts, 1, 'restart/resume must not replay the accepted Turn');
    assert.ok(fixtureState.resumes >= 1, 'the replacement App Server must receive thread/resume');

    await page.evaluate(async () => (window.chatAPI || window.electronAPI).agentRuntimeStop());
    console.log(JSON.stringify({
        sessions: 2,
        firstPid,
        recoveredPid: recovered.status.worker.pid,
        sqliteReadableAfterCrash: true,
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

