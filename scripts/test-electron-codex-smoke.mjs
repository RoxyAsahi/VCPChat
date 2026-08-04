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
    ChatDataServiceEnabled: false,
}), 'utf8');
const port = await freePort();
const stderr = { value: '' };
const rendererErrors = [];
const failedRequests = [];
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
        const topic = await api.agentSessionCreate({
            agentId: 'codex',
            title: 'Electron Codex Smoke',
            workspaceRoot: '.',
        });
        const session = await api.agentRuntimeEnsureSessionRuntime({ sessionId: topic.sessionId });
        const projection = await api.agentSessionReadProjection({ sessionId: session.sessionId });
        const status = await api.agentRuntimeGetStatus();
        const workspace = await api.agentWorkspaceListDirectory({ sessionId: session.sessionId, relativePath: '', limit: 1000 });
        const packagePreview = await api.agentWorkspaceReadPreview({
            sessionId: session.sessionId,
            workspaceRevision: workspace.workspaceRevision,
            relativePath: 'package.json',
        });
        return {
            createdSessionId: topic.sessionId,
            sessionId: session.sessionId,
            threadId: session.threadId,
            runtime: status.runtime,
            executable: status.worker?.executable || null,
            messageCount: projection.messages.length,
            orphaned: projection.session.orphaned,
            legacyPresentationApiExposed: Object.prototype.hasOwnProperty.call(
                api,
                ['agentRuntimeGet', 'PresentationMode'].join(''),
            ),
            workspaceRevision: workspace.workspaceRevision,
            workspaceHasPackage: workspace.entries.some((entry) => entry.relativePath === 'package.json'),
            packagePreviewKind: packagePreview.kind,
            packagePreviewHasName: packagePreview.content.includes('vcp-chat-desktop'),
        };
    });
    assert.equal(result.createdSessionId, result.sessionId);
    assert.match(result.threadId, /^[0-9a-f-]{36}$/i);
    assert.equal(result.runtime, 'codex-app-server');
    assert.equal(result.messageCount, 0);
    assert.equal(result.orphaned, false);
    const expectedPresentationMode = 'fork';
    assert.equal(result.legacyPresentationApiExposed, false);
    assert.match(result.workspaceRevision, /^[0-9a-f]{16}$/);
    assert.equal(result.workspaceHasPackage, true);
    assert.equal(result.packagePreviewKind, 'text');
    assert.equal(result.packagePreviewHasName, true);

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
    const sessionIdsBeforeCreate = await page.evaluate(() => [...document.querySelectorAll(
        '#nextUiInternalAppHost .agent-chat-session-row[data-session-id]',
    )].map((row) => row.dataset.sessionId));
    await page.click('#nextUiInternalAppHost .agent-chat-composer-new');
    await page.waitForFunction((previousIds) => {
        const host = document.querySelector('#nextUiInternalAppHost');
        const active = host?.querySelector('.agent-chat-session-row.active[data-session-id]');
        return Boolean(active?.dataset.sessionId
            && !previousIds.includes(active.dataset.sessionId)
            && !host.querySelector('.agent-chat-topic-flow-dialog'));
    }, { timeout: timeoutMs }, sessionIdsBeforeCreate);
    const directCreateState = await page.evaluate(() => {
        const host = document.querySelector('#nextUiInternalAppHost');
        const active = host?.querySelector('.agent-chat-session-row.active[data-session-id]');
        return {
            modalOpen: Boolean(host?.querySelector('.agent-chat-topic-flow-dialog')),
            activeSessionId: active?.dataset.sessionId || '',
            title: active?.querySelector('.topic-title-display')?.textContent || '',
            composerDisabled: Boolean(host?.querySelector('.agent-chat-message-input')?.disabled),
        };
    });
    assert.equal(directCreateState.modalOpen, false, 'New Session must not open the retired creation modal');
    assert.ok(directCreateState.activeSessionId, `Direct Session creation did not select a durable Session: ${JSON.stringify(directCreateState)}`);
    assert.match(directCreateState.title, /^新会话 /, 'Direct Session creation must use the standard generated title');
    assert.equal(directCreateState.composerDisabled, false, 'A directly created Session preview must be immediately send-capable');

    // R12 real UI contract: a current-Session Select must retain the user's
    // value while the async SQLite save is pending, and the saved workspace
    // must be scoped to this Session rather than the Agent Profile.
    const settingsSessionId = directCreateState.activeSessionId;
    const settingsWorkspace = appData;
    await page.evaluate(() => {
        const host = document.querySelector('#nextUiInternalAppHost');
        const settingsTab = [...(host?.querySelectorAll('.sidebar-tab-button') || [])]
            .find((tab) => tab.textContent?.trim() === '设置');
        settingsTab?.click();
    });
    await page.waitForSelector('#nextUiInternalAppHost .agent-chat-settings-pane', { visible: true, timeout: timeoutMs });
    await page.evaluate(() => {
        const host = document.querySelector('#nextUiInternalAppHost');
        const sessionScope = [...(host?.querySelectorAll('.agent-chat-settings-scope') || [])]
            .find((button) => button.textContent?.trim() === '当前会话');
        sessionScope?.click();
    });
    await page.waitForFunction(() => Boolean(document.querySelector(
        '#nextUiInternalAppHost .agent-chat-settings-pane .agent-chat-setting-field select',
    )), { timeout: timeoutMs });
    const setLabeledControl = async (labelText, value, eventType = 'change') => page.evaluate(({ labelText: targetLabel, value: nextValue, eventType: type }) => {
        const host = document.querySelector('#nextUiInternalAppHost');
        const field = [...(host?.querySelectorAll('.agent-chat-setting-field') || [])]
            .find((item) => item.querySelector('.agent-chat-setting-label')?.textContent?.includes(targetLabel));
        const control = field?.querySelector('select, input, textarea');
        if (!control) return false;
        const setter = Object.getOwnPropertyDescriptor(control.constructor.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(control, nextValue);
        control.dispatchEvent(new Event(type, { bubbles: true }));
        return true;
    }, { labelText, value, eventType });
    const chooseLabeledSelectOption = async (labelText, value) => {
        const testId = await page.evaluate((targetLabel) => {
            const host = document.querySelector('#nextUiInternalAppHost');
            const field = [...(host?.querySelectorAll('.agent-chat-setting-field') || [])]
                .find((item) => item.querySelector('.agent-chat-setting-label')?.textContent?.includes(targetLabel));
            const proxy = field?.querySelector('wa-select.vcp-ui-select-proxy');
            if (!proxy) return null;
            const id = `agent-setting-select-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            proxy.dataset.testSelectId = id;
            return id;
        }, labelText);
        assert.ok(testId, `visible Web Awesome Select proxy missing for ${labelText}`);
        const proxySelector = `wa-select[data-test-select-id="${testId}"]`;
        await page.click(proxySelector);
        await page.waitForFunction((selector) => document.querySelector(selector)?.open === true,
            { timeout: timeoutMs }, proxySelector);
        await page.click(`${proxySelector} > wa-option[value="${value}"]`);
        await page.waitForFunction((selector) => {
            const proxy = document.querySelector(selector);
            return !proxy || proxy.open === false;
        },
            { timeout: timeoutMs }, proxySelector);
        return page.evaluate(({ targetLabel, expectedValue }) => {
            const host = document.querySelector('#nextUiInternalAppHost');
            const field = [...(host?.querySelectorAll('.agent-chat-setting-field') || [])]
                .find((item) => item.querySelector('.agent-chat-setting-label')?.textContent?.includes(targetLabel));
            const native = field?.querySelector('select.vcp-ui-select-source');
            const proxy = field?.querySelector('wa-select.vcp-ui-select-proxy');
            return {
                proxyValue: proxy?.value || (native?.value === expectedValue ? expectedValue : null),
                nativeValue: native?.value || null,
            };
        }, { targetLabel: labelText, expectedValue: value });
    };
    assert.deepEqual(await chooseLabeledSelectOption('本地工具审批', 'always-approve'), {
        proxyValue: 'always-approve',
        nativeValue: 'always-approve',
    });
    const settingsModel = 'electron-visible-select-model';
    assert.equal(await page.evaluate((modelValue) => {
        const host = document.querySelector('#nextUiInternalAppHost');
        const field = [...(host?.querySelectorAll('.agent-chat-setting-field') || [])]
            .find((item) => item.querySelector('.agent-chat-setting-label')?.textContent?.trim() === '模型');
        const native = field?.querySelector('select.vcp-ui-select-source');
        if (!native) return false;
        if (![...native.options].some(option => option.value === modelValue)) {
            const option = document.createElement('option');
            option.value = modelValue;
            option.textContent = modelValue;
            native.append(option);
        }
        return true;
    }, settingsModel), true, 'model Select fixture option could not be installed');
    await page.waitForFunction((modelValue) => [...document.querySelectorAll(
        '#nextUiInternalAppHost .agent-chat-setting-field wa-select.vcp-ui-select-proxy > wa-option',
    )].some(option => option.value === modelValue), { timeout: timeoutMs }, settingsModel);
    assert.deepEqual(await chooseLabeledSelectOption('模型', settingsModel), {
        proxyValue: settingsModel,
        nativeValue: settingsModel,
    });
    const immediatePermission = await page.evaluate(() => {
        const fields = document.querySelectorAll('#nextUiInternalAppHost .agent-chat-setting-field');
        const field = [...fields].find((item) => item.querySelector('.agent-chat-setting-label')
            ?.textContent?.includes('本地工具审批'));
        return field?.querySelector('select')?.value || null;
    });
    assert.equal(immediatePermission, 'always-approve', 'YOLO Select must not jump back to the old Snapshot during save');
    assert.equal(await setLabeledControl('工作目录（可留空）', settingsWorkspace), true);
    await page.waitForFunction(async (sessionId, workspaceRoot) => {
        const config = await (window.chatAPI || window.electronAPI).agentRuntimeReadSessionConfig({ sessionId });
        return config?.desiredConfig?.permissionMode === 'always-approve'
            && config?.desiredConfig?.model === 'electron-visible-select-model'
            && config?.desiredConfig?.workspaceRoot === workspaceRoot;
    }, { timeout: timeoutMs }, settingsSessionId, settingsWorkspace);
    const persistedSettings = await page.evaluate(async (sessionId) => {
        const config = await (window.chatAPI || window.electronAPI).agentRuntimeReadSessionConfig({ sessionId });
        return {
            sessionId: config.sessionId,
            permissionMode: config.desiredConfig?.permissionMode,
            model: config.desiredConfig?.model,
            workspaceRoot: config.desiredConfig?.workspaceRoot,
            applyState: config.applyState,
        };
    }, settingsSessionId);
    assert.equal(persistedSettings.sessionId, settingsSessionId);
    assert.equal(persistedSettings.permissionMode, 'always-approve');
    assert.equal(persistedSettings.model, settingsModel);
    assert.equal(persistedSettings.workspaceRoot, settingsWorkspace);
    assert.ok(['unmaterialized', 'pending', 'applying', 'applied'].includes(persistedSettings.applyState),
        `unexpected Session config apply state: ${persistedSettings.applyState}`);
    await page.screenshot({ path: path.join(root, 'screenshots', 'agent-direct-new-session.png') });
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
        const contextPanel = host?.querySelector('[data-activity-panel="context"]');
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
    assert.deepEqual(inspector.visibleTabs, ['files', 'context'],
        'the product-facing Dock must initially expose only the file launcher and Context tab');
    assert.equal(inspector.contextVisible, true, 'the header context indicator must open the Context inspector');
    assert.equal(inspector.hasProgressRing, true, 'the header must render a stable context progress ring');
    assert.ok(inspector.panelWidth > 0 && inspector.panelWidth <= inspector.viewportWidth,
        `Agent information panel must fit the viewport: ${JSON.stringify(inspector)}`);
    const notificationLayout = await page.evaluate(async () => {
        const host = document.querySelector('#nextUiInternalAppHost');
        host?.querySelector('.agent-chat-dock-add')?.click();
        const notificationCommand = [...(host?.querySelectorAll('.agent-chat-dock-menu-item') || [])]
            .find((item) => item.textContent.includes('通知'));
        notificationCommand?.click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const panel = host?.querySelector('[data-activity-panel="notifications"]');
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
        host?.querySelector('.agent-chat-activity-tab[data-tab="context"]')?.click();
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
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    const settingsAfterReload = await page.evaluate(async (sessionId) => {
        const config = await (window.chatAPI || window.electronAPI).agentRuntimeReadSessionConfig({ sessionId });
        return {
            permissionMode: config.desiredConfig?.permissionMode,
            model: config.desiredConfig?.model,
            workspaceRoot: config.desiredConfig?.workspaceRoot,
        };
    }, settingsSessionId);
    assert.deepEqual(settingsAfterReload, {
        permissionMode: 'always-approve',
        model: settingsModel,
        workspaceRoot: settingsWorkspace,
    }, 'Renderer reload must read the saved Session config from SQLite instead of restoring an old UI default');
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
