import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
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

async function launch(appData) {
    const port = await freePort();
    const stderr = { value: '' };
    const child = spawn(electron, [
        `--user-data-dir=${appData}`,
        `--remote-debugging-port=${port}`,
        '.',
        '--allow-multiple-instances',
    ], {
        cwd: root,
        env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    child.stderr.on('data', (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-12_000); });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Electron exited before debugger startup: ${stderr.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            break;
        } catch {
            await sleep(150);
        }
    }
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    let page = null;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find((candidate) => candidate.url().includes('main.html')) || null;
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `Electron main renderer did not appear: ${stderr.value}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    return { child, browser, page, stderr };
}

async function closeLaunch({ child, browser, page }) {
    await page.evaluate(async () => {
        const api = window.chatAPI || window.electronAPI;
        await api?.agentRuntimeStop?.();
    }).catch(() => null);
    await browser.close().catch(() => null);
    browser.disconnect();
    if (child.exitCode === null) child.kill();
    await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(10_000),
    ]);
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-codex-process-restart-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    enableDistributedServer: false,
    ChatDataServiceEnabled: false,
}), 'utf8');

let first = null;
let second = null;
try {
    first = await launch(appData);
    const created = await first.page.evaluate(async () => {
        const api = window.chatAPI || window.electronAPI;
        await api.agentRuntimeStart();
        const topic = await api.agentRuntimeCreateTopic({ agentId: 'codex', title: 'Process restart persistence' });
        const session = await api.agentRuntimeCreateSession({ resume: topic.topicId });
        const before = await api.agentRuntimeReadSessionConfig({ sessionId: session.sessionId });
        const desired = await api.agentRuntimeUpdateSessionConfig({
            sessionId: session.sessionId,
            expectedConfigRevision: before.configRevision,
            patch: {
                permissionMode: 'always-approve',
                workspaceRoot: 'C:\\VCP\\vchat-develop\\VCPChat-codex-agent',
                model: 'deepseek-v4-flash',
            },
        });
        return {
            sessionId: session.sessionId,
            configRevision: desired.configRevision,
            permissionMode: desired.desiredConfig?.permissionMode,
            workspaceRoot: desired.desiredConfig?.workspaceRoot,
            model: desired.desiredConfig?.model,
        };
    });
    assert.equal(created.permissionMode, 'always-approve');
    assert.equal(created.workspaceRoot, 'C:\\VCP\\vchat-develop\\VCPChat-codex-agent');
    assert.equal(created.model, 'deepseek-v4-flash');
    await closeLaunch(first);
    first = null;

    second = await launch(appData);
    const restored = await second.page.evaluate(async (sessionId) => {
        const api = window.chatAPI || window.electronAPI;
        const config = await api.agentRuntimeReadSessionConfig({ sessionId });
        const topics = await api.agentRuntimeListTopics({ agentId: 'codex' });
        return {
            configRevision: config.configRevision,
            permissionMode: config.desiredConfig?.permissionMode,
            workspaceRoot: config.desiredConfig?.workspaceRoot,
            model: config.desiredConfig?.model,
            sessionVisible: topics.some((topic) => topic.sessionId === sessionId || topic.topicId === sessionId),
        };
    }, created.sessionId);
    assert.equal(restored.configRevision, created.configRevision);
    assert.equal(restored.permissionMode, 'always-approve');
    assert.equal(restored.workspaceRoot, 'C:\\VCP\\vchat-develop\\VCPChat-codex-agent');
    assert.equal(restored.model, 'deepseek-v4-flash');
    assert.equal(restored.sessionVisible, true);
    console.log(JSON.stringify({ processRestart: 'passed', sessionId: created.sessionId, restored }));
} finally {
    if (first) await closeLaunch(first).catch(() => null);
    if (second) await closeLaunch(second).catch(() => null);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fs.rm(appData, { recursive: true, force: true });
            break;
        } catch (error) {
            if (attempt === 4) throw error;
            await sleep(300);
        }
    }
}
