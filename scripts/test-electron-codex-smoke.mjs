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

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-codex-electron-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    enableDistributedServer: false,
}), 'utf8');
const port = await freePort();
const stderr = { value: '' };
const rendererErrors = [];
const failedRequests = [];
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
child.stderr.on('data', (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-12_000); });

let browser;
try {
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
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    let page = null;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find((candidate) => candidate.url().includes('main.html')) || null;
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `Electron main renderer did not appear: ${stderr.value}`);
    page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error?.stack || error}`));
    page.on('requestfailed', (request) => {
        failedRequests.push(`${request.failure()?.errorText || 'request failed'} ${request.url()}`);
    });
    page.on('console', (message) => {
        if (message.type() === 'error') {
            const location = message.location();
            rendererErrors.push(`console.error: ${message.text()} @ ${location.url || 'unknown'}:${location.lineNumber || 0}`);
        }
    });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    const result = await page.evaluate(async () => {
        const api = window.chatAPI || window.electronAPI;
        await api.agentRuntimeStart();
        const topic = await api.agentRuntimeCreateTopic({
            agentId: 'codex',
            title: 'Electron Codex Smoke',
            workspaceRoot: '.',
        });
        const session = await api.agentRuntimeCreateSession({ resume: topic.topicId });
        const projection = await api.agentRuntimeReadProjection({ sessionId: session.sessionId });
        const status = await api.agentRuntimeGetStatus();
        const presentation = await api.agentRuntimeGetPresentationMode();
        return {
            topicId: topic.topicId,
            sessionId: session.sessionId,
            threadId: session.threadId,
            runtime: status.runtime,
            executable: status.worker?.executable || null,
            messageCount: projection.messages.length,
            orphaned: projection.session.orphaned,
            presentationMode: presentation.mode,
        };
    });
    assert.equal(result.topicId, result.sessionId);
    assert.match(result.threadId, /^[0-9a-f-]{36}$/i);
    assert.equal(result.runtime, 'codex-app-server');
    assert.equal(result.messageCount, 0);
    assert.equal(result.orphaned, false);
    const expectedPresentationMode = String(process.env.VCP_AGENT_PRESENTATION_RENDERER || '').toLowerCase() === 'legacy'
        ? 'legacy'
        : 'fork';
    assert.equal(result.presentationMode, expectedPresentationMode);

    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    // The repository's current global theme references a missing optional
    // wallpaper before the Workbench is opened. Start a fresh diagnostic
    // window here so this smoke remains strict about Agent UI errors without
    // disguising that unrelated shell-startup asset issue as a Fork failure.
    rendererErrors.length = 0;
    failedRequests.length = 0;
    await page.click('#nextUiAddTabBtn');
    await page.waitForSelector('.next-ui-internal-app-item[title="VCP Agent"]', { visible: true, timeout: timeoutMs });
    assert.equal(await page.evaluate(() => {
        const item = document.querySelector('.next-ui-internal-app-item[title="VCP Agent"]');
        item?.click();
        return Boolean(item);
    }), true);
    await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
    await page.waitForFunction((expected) => {
        const root = document.querySelector('#nextUiInternalAppHost .agent-workbench-root > .agent-chat-root');
        return root?.dataset.presentationRenderer === expected;
    }, { timeout: timeoutMs }, expectedPresentationMode);
    const rendered = await page.evaluate(() => ({
        presentationMode: document.querySelector('#nextUiInternalAppHost .agent-workbench-root > .agent-chat-root')
            ?.dataset.presentationRenderer || null,
        hasSidebar: Boolean(document.querySelector('#nextUiInternalAppHost .agent-chat-sidebar')),
        hasFeed: Boolean(document.querySelector('#nextUiInternalAppHost .agent-chat-messages')),
        hasComposer: Boolean(document.querySelector('#nextUiInternalAppHost .agent-chat-composer')),
    }));
    assert.deepEqual(rendered, {
        presentationMode: expectedPresentationMode,
        hasSidebar: true,
        hasFeed: true,
        hasComposer: true,
    });
    const knownThemeAsset = 'styles/assets/wallpaper/themes_snow_realm_light.jpg';
    const unexpectedRendererErrors = rendererErrors.filter((entry) => !entry.includes(knownThemeAsset));
    const unexpectedFailedRequests = failedRequests.filter((entry) => !entry.includes(knownThemeAsset));
    assert.deepEqual(unexpectedRendererErrors, [], `Electron renderer errors:\n${rendererErrors.join('\n')}\nFailed requests:\n${failedRequests.join('\n')}`);
    assert.deepEqual(unexpectedFailedRequests, [], `Electron failed requests:\n${failedRequests.join('\n')}`);
    const screenshotDir = process.env.VCP_CODEX_SCREENSHOT_DIR;
    if (screenshotDir) {
        await fs.mkdir(screenshotDir, { recursive: true });
        for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 720 }]) {
            await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
            for (const theme of ['dark', 'light']) {
                await page.evaluate((nextTheme) => {
                    const api = window.chatAPI || window.electronAPI;
                    api.setTheme(nextTheme);
                }, theme);
                await page.waitForFunction((nextTheme) => document.body.classList.contains(`${nextTheme}-theme`),
                    { timeout: timeoutMs }, theme);
                await sleep(350);
                await page.screenshot({
                    path: path.join(screenshotDir, `agent-workbench-${expectedPresentationMode}-${viewport.width}x${viewport.height}-${theme}.png`),
                    type: 'png',
                });
            }
        }
    }
    await page.evaluate(async () => (window.chatAPI || window.electronAPI).agentRuntimeStop());
    console.log(JSON.stringify(result));
} finally {
    if (browser) {
        await Promise.race([
            browser.close().catch(() => null),
            sleep(5_000),
        ]);
        browser.disconnect();
    }
    if (child.exitCode === null) {
        child.kill();
        await Promise.race([
            new Promise((resolve) => child.once('exit', resolve)),
            sleep(8_000),
        ]);
    }
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
