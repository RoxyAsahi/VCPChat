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

async function launch(appData, launcherPath, statePath, extraEnv = {}) {
    const port = await freePort();
    const stderr = { value: '' };
    const child = spawn(electron, [
        `--user-data-dir=${appData}`,
        `--remote-debugging-port=${port}`,
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
            ...extraEnv,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    child.stderr.on('data', (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-16_000); });
    await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`Electron exited before debugger startup: ${stderr.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            return true;
        } catch {
            return false;
        }
    }, `Electron debugger did not start: ${stderr.value}`);
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = await waitFor(async () => (
        (await browser.pages()).find((candidate) => candidate.url().includes('main.html')) || null
    ), `Electron main renderer did not appear: ${stderr.value}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    return { child, browser, page };
}

async function close(instance) {
    if (!instance) return;
    await instance.browser.close().catch(() => null);
    instance.browser.disconnect();
    if (instance.child.exitCode === null) instance.child.kill();
    await Promise.race([new Promise((resolve) => instance.child.once('exit', resolve)), sleep(5_000)]).catch(() => null);
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-codex-degraded-'));
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

let writer;
let reader;
try {
    writer = await launch(appData, launcherPath, statePath);
    const seeded = await writer.page.evaluate(async () => {
        const api = window.chatAPI || window.electronAPI;
        const topic = await api.agentRuntimeCreateTopic({ agentId: 'Nova', title: 'Degraded readable history', workspaceRoot: '.' });
        return { sessionId: topic.sessionId || topic.topicId };
    });
    await close(writer);
    writer = null;

    reader = await launch(appData, launcherPath, statePath, {
        VCPCHAT_E2E_FORCE_AGENT_PROJECTION_READ_ONLY: '1',
    });
    const degraded = await reader.page.evaluate(async (sessionId) => {
        const api = window.chatAPI || window.electronAPI;
        const [topics, projection, status] = await Promise.all([
            api.agentRuntimeListTopics({}),
            api.agentRuntimeReadProjection({ sessionId }),
            api.agentRuntimeGetStatus(),
        ]);
        const mutationErrors = [];
        for (const operation of [
            () => api.agentRuntimeCreateTopic({ agentId: 'Nova', title: 'must fail', workspaceRoot: '.' }),
            () => api.agentRuntimeStartTurn({ sessionId, prompt: 'must not start' }),
        ]) {
            try { await operation(); } catch (error) { mutationErrors.push(error?.message || String(error)); }
        }
        return {
            topicIds: topics.map((topic) => topic.sessionId),
            projectionSessionId: projection.session.sessionId,
            storage: status.storage,
            runtimeState: status.state,
            worker: status.worker,
            mutationErrors,
        };
    }, seeded.sessionId);
    assert.ok(degraded.topicIds.includes(seeded.sessionId));
    assert.equal(degraded.projectionSessionId, seeded.sessionId);
    assert.equal(degraded.storage.readOnly, true);
    assert.match(degraded.storage.degradedReason, /forced read-only/i);
    assert.equal(degraded.runtimeState, 'stopped');
    assert.equal(degraded.worker, null, 'projection-only degraded reads must not start App Server');
    assert.equal(degraded.mutationErrors.length, 2);
    assert.ok(degraded.mutationErrors.every((message) => /PROJECTION_READ_ONLY|read-only degraded/i.test(message)));
    console.log(JSON.stringify({
        sqliteReadOnlyDegraded: true,
        projectionReadable: true,
        mutationsRejected: degraded.mutationErrors.length,
        appServerStarted: false,
    }));
} finally {
    await close(writer);
    await close(reader);
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
