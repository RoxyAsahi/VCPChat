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
    try {
        await page.waitForFunction(() => Boolean(window.nextUiApps?.get?.('agent-workbench')), { timeout: timeoutMs });
    } catch (error) {
        const registrationState = await page.evaluate(() => ({
            nextUiApps: Boolean(window.nextUiApps),
            registeredApps: window.nextUiApps?.list?.().map((app) => app.id) || [],
            scripts: [...document.scripts].map((script) => script.src).filter(Boolean),
        }));
        throw new Error(`Agent Workbench registration timed out: ${JSON.stringify(registrationState)}\nRenderer errors:\n${rendererErrors.join('\n')}\n${error.message}`);
    }
    // The repository's current global theme references a missing optional
    // wallpaper before the Workbench is opened. Start a fresh diagnostic
    // window here so this smoke remains strict about Agent UI errors without
    // disguising that unrelated shell-startup asset issue as a Fork failure.
    rendererErrors.length = 0;
    failedRequests.length = 0;
    await page.click('#nextUiAddTabBtn');
    await page.waitForSelector('.next-ui-internal-app-item[title="VCPBuild"]', { visible: true, timeout: timeoutMs });
    assert.equal(await page.evaluate(() => {
        const item = document.querySelector('.next-ui-internal-app-item[title="VCPBuild"]');
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
    const knownThemeAssets = [
        'styles/assets/wallpaper/themes_snow_realm_light.jpg',
        'styles/assets/wallpaper/vcp_editorial_ink_light.jpg',
    ];
    const isKnownThemeAsset = (entry) => knownThemeAssets.some((asset) => entry.includes(asset));
    const unexpectedRendererErrors = rendererErrors.filter((entry) => !isKnownThemeAsset(entry));
    const unexpectedFailedRequests = failedRequests.filter((entry) => !isKnownThemeAsset(entry));
    assert.deepEqual(unexpectedRendererErrors, [], `Electron renderer errors:\n${rendererErrors.join('\n')}\nFailed requests:\n${failedRequests.join('\n')}`);
    assert.deepEqual(unexpectedFailedRequests, [], `Electron failed requests:\n${failedRequests.join('\n')}`);
    assert.equal(await page.evaluate(() => {
        const trigger = document.querySelector('#nextUiInternalAppHost .agent-chat-context-toggle');
        trigger?.click();
        return Boolean(trigger);
    }), true, 'Agent Workbench must expose the Context inspector trigger');
    await page.waitForSelector('#nextUiInternalAppHost .agent-chat-activity-panel.agent-chat-activity-open',
        { visible: true, timeout: timeoutMs });
    const inspector = await page.evaluate(() => {
        const host = document.querySelector('#nextUiInternalAppHost');
        const panel = host?.querySelector('.agent-chat-activity-panel');
        const contextPanel = host?.querySelector('[data-activity-panel="usage"]');
        const bounds = panel?.getBoundingClientRect();
        return {
            tabGroups: host?.querySelectorAll('.agent-chat-activity-tab-group').length || 0,
            visibleTabs: [...(host?.querySelectorAll('.agent-chat-activity-tabs > .agent-chat-activity-tab') || [])]
                .map((tab) => tab.dataset.tab),
            contextVisible: Boolean(contextPanel && !contextPanel.hidden),
            hasProgressRing: Boolean(host?.querySelector('.agent-chat-context-ring-value')),
            panelWidth: bounds?.width || 0,
            viewportWidth: window.innerWidth,
        };
    });
    assert.equal(inspector.tabGroups, 0, 'Agent information panel tabs must share one compact row');
    assert.deepEqual(inspector.visibleTabs, ['usage', 'activity', 'approvals'],
        'the product-facing information panel must expose only Context, notifications, and approvals');
    assert.equal(inspector.contextVisible, true, 'the header context indicator must open the Context inspector');
    assert.equal(inspector.hasProgressRing, true, 'the header must render a stable context progress ring');
    assert.ok(inspector.panelWidth > 0 && inspector.panelWidth <= inspector.viewportWidth,
        `Agent information panel must fit the viewport: ${JSON.stringify(inspector)}`);
    const notificationLayout = await page.evaluate(() => {
        const host = document.querySelector('#nextUiInternalAppHost');
        host?.querySelector('.agent-chat-activity-tab[data-tab="activity"]')?.click();
        const panel = host?.querySelector('[data-activity-panel="activity"]');
        const list = panel?.querySelector('.agent-chat-activity-list');
        if (!panel || !list) return null;
        const fixtures = Array.from({ length: 14 }, (_, index) => {
            const card = document.createElement('section');
            card.className = 'agent-chat-toolbox-ws-card';
            card.dataset.layoutFixture = 'true';
            card.textContent = `VCP notification ${index + 1}: bounded activity layout fixture`;
            list.append(card);
            return card;
        });
        const panelWidth = list.getBoundingClientRect().width;
        const listBounds = list.getBoundingClientRect();
        const activityBounds = host.querySelector('.agent-chat-activity-panel').getBoundingClientRect();
        const panelStyle = getComputedStyle(list);
        const contentWidth = list.clientWidth
            - (Number.parseFloat(panelStyle.paddingLeft) || 0)
            - (Number.parseFloat(panelStyle.paddingRight) || 0);
        const widths = fixtures.map((card) => card.getBoundingClientRect().width);
        const heights = fixtures.map((card) => card.getBoundingClientRect().height);
        const result = {
            panelWidth,
            contentWidth,
            minimumWidth: Math.min(...widths),
            minimumHeight: Math.min(...heights),
            scrolls: list.scrollHeight > list.clientHeight,
            toolbarOutsideScroller: !list.contains(panel.querySelector('.agent-chat-activity-filters')),
            bottomGap: Math.abs(activityBounds.bottom - listBounds.bottom),
        };
        fixtures.forEach((card) => card.remove());
        host?.querySelector('.agent-chat-activity-tab[data-tab="usage"]')?.click();
        return result;
    });
    assert.ok(notificationLayout
        && notificationLayout.minimumWidth >= notificationLayout.contentWidth * 0.95
        && notificationLayout.minimumHeight > 0
        && notificationLayout.scrolls
        && notificationLayout.toolbarOutsideScroller
        && notificationLayout.bottomGap <= 2,
    `VCP notifications must keep full side-panel width and content height, then scroll: ${JSON.stringify(notificationLayout)}`);
    const toolGroupLayout = await page.evaluate(() => {
        const feed = document.querySelector('#nextUiInternalAppHost .agent-chat-messages');
        if (!feed) return null;
        const group = document.createElement('section');
        group.className = 'message-item assistant agent-chat-tool-group expanded';
        const header = document.createElement('div');
        header.className = 'agent-chat-tool-group-header';
        header.textContent = '2 个工具调用';
        const body = document.createElement('div');
        body.className = 'agent-chat-tool-group-body';
        const child = document.createElement('section');
        child.className = 'message-item assistant agent-chat-tool-activity-row agent-chat-tool-activity vcp-tool-call-summary-bubble agent-chat-tool-group-item';
        child.textContent = 'FileOperator';
        body.append(child);
        group.append(header, body);
        feed.append(group);
        const groupBounds = group.getBoundingClientRect();
        const headerBounds = header.getBoundingClientRect();
        const bodyBounds = body.getBoundingClientRect();
        const childBounds = child.getBoundingClientRect();
        const result = {
            bodyBelowHeader: bodyBounds.top >= headerBounds.bottom - 1,
            childAligned: Math.abs(childBounds.left - groupBounds.left) <= 1,
            childWidthRatio: groupBounds.width ? childBounds.width / groupBounds.width : 0,
        };
        group.remove();
        return result;
    });
    assert.ok(toolGroupLayout?.bodyBelowHeader
        && toolGroupLayout.childAligned
        && toolGroupLayout.childWidthRatio >= 0.98,
    `expanded tool groups must stack full-width child cards without nested indentation: ${JSON.stringify(toolGroupLayout)}`);
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
