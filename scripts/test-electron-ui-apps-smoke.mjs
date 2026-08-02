// test-electron-ui-apps-smoke — real Electron verification for the R5.0/R5.1
// migration groundwork plus the genuinely reconstructed business pages, without
// needing the Rust agent daemon.
//
// Verifies:
//   - Web Awesome is NOT registered nor its runtime fetched at app boot,
//   - opening the "UI 组件库" internal app lazy-registers wa-* elements,
//   - the global settings modal is enhanced in next mode (controls, save bar,
//     injected search) and its save bar tracks dirty/saving state,
//   - the notemini page is genuinely rebuilt (AppPageShell + VCPUI controls +
//     Web Awesome tooltip) through the app's own embedded flow,
//   - core VCPUI controls (Select/Tabs/Modal) become Web Awesome-backed after
//     the runtime preloads their bundles,
//   - switching to classic tears the next-UI surfaces down.
//
// Usage: node scripts/test-electron-ui-apps-smoke.mjs

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
const timeoutMs = 60_000;
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

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-ui-apps-electron-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    enableDistributedServer: false,
    vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'smoke-test-key',
}), 'utf8');
const port = await freePort();
const stderr = { value: '' };
const rendererErrors = [];
const miniErrors = [];
const webAwesomeRuntimeRequests = [];
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
    page.on('request', (request) => {
        if (/vendor\/webawesome\/dist-cdn/i.test(request.url())) webAwesomeRuntimeRequests.push(request.url());
    });

    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });

    // 1. The Web Awesome RUNTIME (vendored dist-cdn bundles + theme CSS) must
    //    not be fetched at boot. The thin adapter/comparison modules may load;
    //    they register nothing until a page or the showcase opens.
    const bootWaState = await page.evaluate(() => ({
        waButton: typeof customElements !== 'undefined' ? customElements.get('wa-button') : null,
        themeLink: Boolean(document.querySelector('link[data-webawesome-showcase-theme], link[data-webawesome-runtime-theme]')),
    }));
    assert.ok(!bootWaState.waButton, 'wa-button must not be registered at boot');
    assert.equal(bootWaState.themeLink, false, 'Web Awesome theme must not load at boot');
    assert.equal(webAwesomeRuntimeRequests.length, 0, `Web Awesome runtime fetched at boot: ${webAwesomeRuntimeRequests.join(', ')}`);

    // 2. Open the UI 组件库 internal app; WA must register lazily.
    await page.click('#nextUiAddTabBtn');
    await page.waitForFunction(() => window.topTabManager, { timeout: timeoutMs });
    const showcaseHandle = await page.evaluateHandle(() =>
        [...document.querySelectorAll('.next-ui-internal-app-item')].find(item => item.getAttribute('title') === 'UI 组件库')
    );
    if (await showcaseHandle.evaluate(el => !el)) {
        await page.evaluate(() => window.topTabManager.openInternalApp('ui-component-library'));
    } else {
        await showcaseHandle.asElement().click();
    }
    await page.waitForFunction(() => document.querySelector('.vcp-ui-showcase-root'), { timeout: timeoutMs });

    let waDefined = false;
    while (Date.now() < deadline) {
        waDefined = await page.evaluate(() => Boolean(customElements.get('wa-button')));
        if (waDefined) break;
        await sleep(120);
    }
    assert.ok(waDefined, 'wa-button must register after the showcase opens (lazy load)');
    await page.waitForFunction(
        () => document.querySelector('.vcp-ui-wa-comparison')?.dataset.ready === 'true',
        { timeout: timeoutMs }
    );
    assert.ok(webAwesomeRuntimeRequests.some(url => url.includes('vendor/webawesome/dist-cdn/components/button')), 'lazy load fetched the vendored button bundle');

    // 3. Global settings modal is enhanced in next mode.
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await page.waitForFunction(() => {
        const footer = document.getElementById('globalSettingsModal')?.querySelector('.global-settings-footer');
        return footer?.classList.contains('vcp-ui-settings-action-bar');
    }, { timeout: timeoutMs });
    const settingsState = await page.evaluate(() => {
        const form = document.getElementById('globalSettingsForm');
        const footer = form.closest('#globalSettingsModal')?.querySelector('.global-settings-footer');
        const userName = document.getElementById('userName');
        const state = { inputClass: userName?.className || '', footerClass: footer?.className || '', hasSearch: Boolean(document.querySelector('.vcp-ui-settings-search')) };
        userName?.dispatchEvent(new Event('input', { bubbles: true }));
        return new Promise(resolve => {
            setTimeout(() => resolve({ ...state, footerState: footer?.dataset.state || '' }), 50);
        });
    });
    assert.ok(settingsState.inputClass.includes('vcp-ui-native-input'), `global settings input not enhanced: ${settingsState.inputClass}`);
    assert.ok(settingsState.footerClass.includes('vcp-ui-settings-action-bar'), `save bar not enhanced: ${settingsState.footerClass}`);
    assert.ok(settingsState.hasSearch, 'settings search not injected');
    assert.equal(settingsState.footerState, 'dirty', `save bar should be dirty after input: ${settingsState.footerState}`);
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));

    // 4. Genuinely reconstructed business page: notemini rebuilds its shell with
    //    VCPUI components (AppPageShell + Input + WindowControls) and consumes
    //    the Web Awesome adapter for tooltips, opened through the app's own
    //    embedded flow so it receives ?uiMode=next&vcpEmbedded=1.
    await page.evaluate(() => {
        try { window.topTabManager.closeView('app:ui-component-library'); } catch { /* ignore */ }
        window.topTabManager.openEmbeddedApp({
            id: 'open-note-mini-window',
            action: 'open-note-mini-window',
            name: '迷你便签',
        });
    });
    let miniPage = null;
    while (Date.now() < deadline) {
        miniPage = (await browser.pages()).find(candidate => candidate.url().includes('notemini.html')) || null;
        if (miniPage) break;
        await sleep(150);
    }
    assert.ok(miniPage, 'notemini embedded view did not appear');
    miniPage.on('pageerror', (error) => miniErrors.push(error?.stack || String(error)));
    miniPage.on('console', (message) => {
        if (message.type() === 'error') miniErrors.push(`console.error: ${message.text()}`);
    });
    await miniPage.waitForFunction(() => document.getElementById('miniNoteTitle') && document.querySelector('.vcp-ui-page-shell'), { timeout: timeoutMs });
    const miniState = await miniPage.evaluate(() => ({
        hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
        titleIsVcpInput: Boolean(document.querySelector('#miniNoteTitle.vcp-ui-input-wrap, #miniNoteTitle .vcp-ui-input, #miniNoteTitle.vcp-ui-input')),
        scope: document.body.classList.contains('vcp-ui-scope'),
        shellEmbedded: document.querySelector('.vcp-ui-page-shell')?.dataset.embedded,
        controlsHidden: (() => { const c = document.querySelector('.vcp-ui-window-controls'); return !c || getComputedStyle(c).display === 'none'; })(),
    }));
    assert.ok(miniState.hasShell, `notemini AppPageShell missing: ${JSON.stringify(miniState)}`);
    assert.ok(miniState.titleIsVcpInput, `notemini title not a VCPUI input: ${JSON.stringify(miniState)}`);
    assert.ok(miniState.scope, `notemini body not a vcp-ui-scope: ${JSON.stringify(miniState)}`);
    assert.equal(miniState.shellEmbedded, 'true', `notemini shell must detect embedded mode: ${JSON.stringify(miniState)}`);
    assert.ok(miniState.controlsHidden, `notemini window controls must be hidden when embedded: ${JSON.stringify(miniState)}`);
    await page.evaluate(() => window.topTabManager.closeView('app:open-note-mini-window'));

    // 4b. Translator is genuinely rebuilt too: business nodes move into an
    //     AppPageShell, controls are enhanced, and WA tooltips are attached.
    await page.evaluate(() => window.topTabManager.openEmbeddedApp({
        id: 'open-translator-window',
        action: 'open-translator-window',
        name: '翻译',
    }));
    let translatorPage = null;
    while (Date.now() < deadline) {
        translatorPage = (await browser.pages()).find(candidate => candidate.url().includes('translator.html')) || null;
        if (translatorPage) break;
        await sleep(150);
    }
    assert.ok(translatorPage, 'translator embedded view did not appear');
    translatorPage.on('pageerror', (error) => rendererErrors.push(`translator pageerror: ${error?.stack || error}`));
    await translatorPage.waitForFunction(
        () => document.querySelector('.vcp-ui-page-shell') && document.getElementById('modelSelect'),
        { timeout: timeoutMs }
    );
    await translatorPage.waitForFunction(() => Boolean(document.querySelector('wa-tooltip')), { timeout: timeoutMs });
    const translatorState = await translatorPage.evaluate(() => ({
        hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
        modelEnhanced: document.getElementById('modelSelect')?.classList.contains('vcp-ui-native-select'),
        hasWaTooltip: Boolean(document.querySelector('wa-tooltip')),
        oldTitleBarGone: !document.getElementById('custom-title-bar'),
    }));
    assert.ok(translatorState.hasShell, `translator AppPageShell missing: ${JSON.stringify(translatorState)}`);
    assert.ok(translatorState.modelEnhanced, `translator model select not enhanced: ${JSON.stringify(translatorState)}`);
    assert.ok(translatorState.hasWaTooltip, `translator WA tooltip missing: ${JSON.stringify(translatorState)}`);
    assert.ok(translatorState.oldTitleBarGone, `translator legacy title bar should be replaced: ${JSON.stringify(translatorState)}`);
    await page.evaluate(() => window.topTabManager.closeView('app:open-translator-window'));

    // 4c. Log page is genuinely rebuilt: AppPageShell + enhanced inputs + WA
    //     tooltips; the custom confirm/toast DOM is removed in next mode.
    await page.evaluate(() => window.topTabManager.openEmbeddedApp({
        id: 'open-log-window',
        action: 'open-log-window',
        name: '日志',
    }));
    let logPage = null;
    while (Date.now() < deadline) {
        logPage = (await browser.pages()).find(candidate => candidate.url().includes('log.html')) || null;
        if (logPage) break;
        await sleep(150);
    }
    assert.ok(logPage, 'log embedded view did not appear');
    logPage.on('pageerror', (error) => rendererErrors.push(`log pageerror: ${error?.stack || error}`));
    await logPage.waitForFunction(
        () => document.querySelector('.vcp-ui-page-shell') && document.getElementById('line-limit-input'),
        { timeout: timeoutMs }
    );
    await logPage.waitForFunction(() => Boolean(document.querySelector('wa-tooltip')), { timeout: timeoutMs });
    const logState = await logPage.evaluate(() => ({
        hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
        limitEnhanced: document.getElementById('line-limit-input')?.classList.contains('vcp-ui-native-input'),
        hasWaTooltip: Boolean(document.querySelector('wa-tooltip')),
        customModalGone: !document.getElementById('confirm-modal'),
        oldNavGone: !document.getElementById('top-nav-bar'),
    }));
    assert.ok(logState.hasShell, `log AppPageShell missing: ${JSON.stringify(logState)}`);
    assert.ok(logState.limitEnhanced, `log limit input not enhanced: ${JSON.stringify(logState)}`);
    assert.ok(logState.hasWaTooltip, `log WA tooltip missing: ${JSON.stringify(logState)}`);
    assert.ok(logState.customModalGone, `log custom confirm modal should be replaced: ${JSON.stringify(logState)}`);
    assert.ok(logState.oldNavGone, `log legacy nav bar should be replaced: ${JSON.stringify(logState)}`);
    await page.evaluate(() => window.topTabManager.closeView('app:open-log-window'));

    // 5. Core controls are Web Awesome-backed after the runtime preloads their
    //    bundles: VCPUI.create('Select'/'Tabs'/'Modal') builds <wa-*> and keeps
    //    the VCPUI contract (value, open/close, destroy).
    const waCore = await page.evaluate(async () => {
        await window.VCPWebAwesome.loadComponents(['select', 'option', 'tab', 'tab-panel', 'tab-group', 'dialog', 'tooltip']);
        const select = window.VCPUI.create('Select', { options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], value: 'b' });
        const tabs = window.VCPUI.create('Tabs', { items: [{ label: '一', value: 'one' }, { label: '二', value: 'two' }] });
        const modal = window.VCPUI.create('Modal', { title: 'WA 对话框', content: document.createTextNode('内容'), actions: [] });
        const trigger = window.VCPUI.create('IconButton', { icon: 'help', label: '帮助' });
        const tooltip = window.VCPUI.create('Tooltip', { trigger, content: '帮助提示' });
        const scope = document.createElement('div');
        scope.className = 'vcp-ui-scope';
        window.VCPWebAwesome.mountScope(scope);
        scope.append(select.element, tabs.element, modal.element, trigger.element, tooltip.element);
        document.body.append(scope);
        await Promise.all([select.element.updateComplete, tabs.element.updateComplete, modal.element.updateComplete].filter(Boolean));
        const shell = window.VCPUI.create('AppPageShell', {
            title: '独立窗口',
            windowControls: true,
            content: document.createTextNode('内容'),
        });
        document.body.append(shell.element);
        const modalOpen = await new Promise(resolve => {
            let tries = 0;
            const check = () => {
                if (modal.element.open === true || tries++ > 40) resolve(modal.element.open === true);
                else setTimeout(check, 50);
            };
            check();
        });
        const modalClosed = await new Promise(resolve => {
            modal.element.addEventListener('wa-after-hide', () => resolve(true), { once: true });
            modal.close(null);
        });
        await new Promise(resolve => setTimeout(resolve, 160));
        const destroyClean = !document.contains(modal.element);
        return {
            selectIsWa: select.element.tagName.toLowerCase() === 'wa-select',
            tabsIsWa: tabs.element.tagName.toLowerCase() === 'wa-tab-group',
            modalIsWa: modal.element.tagName.toLowerCase() === 'wa-dialog',
            tooltipIsWa: tooltip.element.tagName.toLowerCase() === 'wa-tooltip',
            selectValue: select.element.value,
            modalOpen,
            modalClosed,
            destroyClean,
            standaloneControls: Boolean(shell.element.querySelector('.vcp-ui-window-controls')),
        };
    });
    assert.ok(waCore.selectIsWa, 'Select must be Web Awesome-backed');
    assert.ok(waCore.tabsIsWa, 'Tabs must be Web Awesome-backed');
    assert.ok(waCore.modalIsWa, 'Modal must be Web Awesome-backed');
    assert.ok(waCore.tooltipIsWa, 'Tooltip must be Web Awesome-backed');
    assert.equal(waCore.selectValue, 'b', 'WA select value must be readable via .value');
    assert.equal(waCore.modalOpen, true, 'WA dialog must open');
    assert.equal(waCore.modalClosed, true, 'WA dialog must close via controller.close');
    assert.equal(waCore.destroyClean, true, 'WA dialog must be removed after close');
    assert.ok(waCore.standaloneControls, 'AppPageShell must render WindowControls in standalone mode');

    // 6. Switch to classic and confirm the next-UI surfaces are torn down.
    await page.evaluate(() => window.uiModeManager.apply('classic', { cache: true }));
    await page.waitForFunction(() => {
        const input = document.getElementById('globalSettingsForm')?.querySelector('input[id]');
        return !input || !input.className.includes('vcp-ui-native-input');
    }, { timeout: timeoutMs });

    console.log('Electron UI apps smoke passed (lazy WA, showcase, global settings, notemini rebuild, WA core controls).');
} catch (error) {
    console.error(`Electron UI apps smoke failed:\n${error?.stack || error}`);
    if (miniErrors?.length) {
        console.error('\nnotemini errors:\n' + miniErrors.slice(0, 12).map(line => `- ${line}`).join('\n'));
    }
    if (rendererErrors.length) {
        console.error('\nRenderer errors:\n' + rendererErrors.slice(0, 12).map(line => `- ${line}`).join('\n'));
    }
    process.exitCode = 1;
} finally {
    child.kill();
    browser?.disconnect();
    await new Promise(resolve => setTimeout(resolve, 300));
    child.kill('SIGKILL');
}
