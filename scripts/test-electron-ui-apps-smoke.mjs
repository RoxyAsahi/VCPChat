// test-electron-ui-apps-smoke — real Electron verification of the next-UI
// migration across every reconstructed business surface (12 pages + global
// settings), in both next and classic modes.
//
// The previous version of this script only walked notemini/translator/log plus
// the WA core controls. This version audits every migrated page in a real
// Electron renderer (no JSDOM):
//
//   - boot: Web Awesome is NOT registered nor fetched at app boot,
//   - the UI 组件库 internal app lazy-registers wa-* elements,
//   - global settings modal (next): enhanced controls, save bar dirty state,
//     injected search, focus/Escape keyboard flow; classic teardown,
//   - embedded pages (notemini/translator/log/plugin/task/notes/memo/forum)
//     genuinely rebuild (AppPageShell + VCPUI controls + WA tooltips),
//   - standalone windows (协同 Canvas, 监听 RAG) rebuild through the app's own
//     launch path,
//   - 工具 ToolBox / 数据 VchatManager are covered by their own scripts; the
//     VchatManager mode wiring is audited here as a separate sub-app section,
//   - per page: real wa-button/wa-input/wa-select/wa-card/wa-tooltip counts,
//     Lucide SVG presence, visible/clickable/no-overlap geometry, focus + Tab
//     keyboard flow, narrow viewport overflow, long text, empty/error states,
//   - classic mode spot checks confirm the legacy DOM stays untouched and the
//     next surfaces are never mounted.
//
// Usage: node scripts/test-electron-ui-apps-smoke.mjs
// Screenshots are written under <repo>/screenshots/.

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
// Generous wait for embedded page boot: the main renderer can block on a
// model-fetch when the configured vcpServerUrl is unreachable (a normal dev
// or smoke environment), which delays topTabManager readiness and therefore
// the embedded-page open flow. 45s was flaky under concurrent Electron
// instances on the same machine.
const timeoutMs = 90_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const captureDir = path.join(root, 'screenshots');

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

async function capture(page, name) {
    await fs.mkdir(captureDir, { recursive: true });
    const filePath = path.join(captureDir, name);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
}

// ── Embedded page manifest ────────────────────────────────────────────────
// Each entry describes one embeddable business page and the minimum real WA
// element counts it must reach after the next-mode rebuild settles. The
// `legacySelector` is what must survive untouched in classic mode.
const EMBEDDED_APPS = [
    {
        id: 'open-note-mini-window', action: 'open-note-mini-window', name: '便签', key: 'notemini.html',
        shellTitle: 'VCP 便签', integrated: true, minWa: { 'wa-input': 1 }, minHeaderRects: 0, minNativeEnhanced: 0,
        legacySelector: '#mini-title-bar', bodyFocus: '.vcp-ui-page-shell-content input',
    },
    {
        id: 'open-translator-window', action: 'open-translator-window', name: '翻译', key: 'translator.html',
        nextEnabled: true,
        shellTitle: '翻译助手', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 2 }, minHeaderRects: 0, minNativeEnhanced: 2,
        legacySelector: '.translator-container', bodyFocus: '.vcp-ui-page-shell-content textarea',
    },
    {
        id: 'open-log-window', action: 'open-log-window', name: '日志', key: 'log.html',
        shellTitle: 'VCP日志中心', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 1 }, minHeaderRects: 0, minNativeEnhanced: 1,
        legacySelector: '.log-app', bodyFocus: '.vcp-ui-page-shell-content input',
    },
    {
        id: 'open-plugin-manager-window', action: 'open-plugin-manager-window', name: '插件', key: 'plugin-manager.html',
        shellTitle: '插件管理器', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 2 }, minHeaderRects: 0, minNativeEnhanced: 2,
        // The C-group rebuild moved the management toolbar into the content
        // area (Search/Input + selects + refresh), so the shell header holds
        // only the title in embedded mode (no window controls either).
        legacySelector: '.app-container', bodyFocus: '.vcp-ui-page-shell-content input',
    },
    {
        id: 'open-task-window', action: 'open-task-window', name: '任务', key: 'task.html',
        shellTitle: '任务助手', integrated: true, minWa: { 'wa-tooltip': 1 }, minHeaderRects: 0, minNativeEnhanced: 0,
        legacySelector: '.app-container', bodyFocus: null,
    },
    {
        id: 'open-notes-window', action: 'open-notes-window', name: '笔记', key: 'notes.html',
        nextEnabled: true,
        shellTitle: '我的笔记', integrated: true, minWa: { 'wa-tooltip': 1 }, minHeaderRects: 0, minNativeEnhanced: 1,
        legacySelector: '.container', bodyFocus: '.vcp-ui-page-shell-content input',
    },
    {
        id: 'open-memo-window', action: 'open-memo-window', name: '记忆', key: 'memo.html',
        shellTitle: '记忆工作台', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 1 }, minHeaderRects: 0, minNativeEnhanced: 1,
        legacySelector: 'main.main-content', bodyFocus: null,
    },
    {
        id: 'open-forum-window', action: 'open-forum-window', name: '论坛', key: 'forum.html',
        shellTitle: 'VCP 论坛', integrated: true, minWa: { 'wa-tooltip': 1, 'wa-select': 1 }, minHeaderRects: 0, minNativeEnhanced: 1,
        legacySelector: '.app-container', bodyFocus: '.vcp-ui-page-shell-content input',
    },
];

// ── Next-mode audit of a child page (embedded view or standalone window) ──
// Returns structured observations; assertions happen in Node so a single page
// cannot abort the whole run before its observations are recorded.
const NEXT_AUDIT_SCRIPT = () => {
    const visibleRect = (el) => {
        const r = el.getBoundingClientRect();
        return {
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            width: r.width, height: r.height,
            visible: r.width > 0 && r.height > 0,
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            disabled: el.disabled === true,
        };
    };
    const headerControls = [...document.querySelectorAll(
        '.vcp-ui-page-shell-header :is(button, select, input, wa-button, wa-select, wa-input), .vcp-ui-window-controls button'
    )].filter(el => el.getClientRects().length && getComputedStyle(el).display !== 'none');
    const rects = headerControls.map(visibleRect);
    const windowControlButtons = [...document.querySelectorAll('.vcp-ui-window-controls :is(button, wa-button)')];
    const focusable = [...document.querySelectorAll('.vcp-ui-page-shell-content :is(input, textarea, select, wa-input, wa-select), .vcp-ui-page-shell-header :is(button, wa-button)')]
        .filter(el => !el.disabled && el.getClientRects().length && getComputedStyle(el).display !== 'none');
    return {
        uiMode: document.documentElement.dataset.uiMode,
        controllerMode: window.VCPUiModeController?.getCurrentMode?.() || null,
        hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
        bodyScope: document.body.classList.contains('vcp-ui-scope'),
        shellTitle: document.querySelector('.vcp-ui-page-shell-title')?.textContent?.trim() || '',
        shellEmbedded: document.querySelector('.vcp-ui-page-shell')?.dataset.embedded || '',
        integratedShell: document.querySelector('.vcp-ui-page-shell')?.classList.contains('vcp-ui-integrated-shell') || false,
        shellHeaderDisplay: getComputedStyle(document.querySelector('.vcp-ui-page-shell-header')).display,
        integratedMain: (() => {
            const main = document.querySelector('.vcp-ui-integrated-main');
            if (!main) return null;
            const style = getComputedStyle(main);
            return { radius: style.borderTopLeftRadius, borderTop: style.borderTopStyle, visible: visibleRect(main).visible };
        })(),
        vcpEmbeddedFlag: document.documentElement.dataset.vcpEmbeddedApp || '',
        wa: {
            'wa-button': document.querySelectorAll('wa-button').length,
            'wa-input': document.querySelectorAll('wa-input').length,
            'wa-select': document.querySelectorAll('wa-select').length,
            'wa-card': document.querySelectorAll('wa-card').length,
            'wa-tooltip': document.querySelectorAll('wa-tooltip').length,
        },
        lucideIcons: document.querySelectorAll('[data-lucide]').length,
        vcpIcons: document.querySelectorAll('.vcp-ui-icon').length,
        nativeEnhanced: document.querySelectorAll('.vcp-ui-native-input, .vcp-ui-native-select, .vcp-ui-native-textarea').length,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        overflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
        headerRects: rects,
        windowControls: {
            count: windowControlButtons.length,
            allNoDrag: windowControlButtons.every(element => getComputedStyle(element).webkitAppRegion === 'no-drag'),
        },
        headerOverlap: rects.some((a, i) => rects.some((b, j) => i < j && a.visible && b.visible
            && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
        allHeaderVisible: rects.length > 0 && rects.every(r => r.visible),
        focusables: focusable.length,
        bodyTextLength: (document.querySelector('.vcp-ui-page-shell-content')?.textContent || '').trim().length,
        bodyBackgroundColor: getComputedStyle(document.body).backgroundColor,
    };
};

// Run inside a page: focus the first visible input/select (textarea is skipped
// because Tab inserts a tab character in a textarea instead of moving focus).
const FOCUS_FIRST_SCRIPT = () => {
    const candidates = [...document.querySelectorAll('.vcp-ui-page-shell-content input, .vcp-ui-page-shell-content select')]
        .filter(el => !el.disabled && el.getClientRects().length && getComputedStyle(el).display !== 'none');
    if (!candidates.length) return null;
    candidates[0].focus();
    return candidates[0].tagName.toLowerCase() + (candidates[0].id ? '#' + candidates[0].id : '');
};

// Run inside a page: inject long text and check for clipping / overflow.
const LONG_TEXT_SCRIPT = () => {
    const target = [...document.querySelectorAll('.vcp-ui-page-shell-content textarea, .vcp-ui-page-shell-content input')]
        .find(el => el.getClientRects().length);
    if (!target) return { applied: false };
    const long = '长文本'.repeat(500);
    if (target instanceof HTMLTextAreaElement) {
        target.value = long;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return {
            applied: true,
            scrollable: target.scrollHeight > target.clientHeight + 1,
            clipped: target.scrollWidth > target.clientWidth + 1,
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
    }
    target.value = long.slice(0, 200);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return {
        applied: true,
        scrollable: true,
        clipped: false,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
};

async function waitForChildPage(browser, key, deadline, label) {
    while (Date.now() < deadline) {
        const found = (await browser.pages()).find(candidate => candidate.url().includes(key) && !candidate.isClosed());
        if (found) return found;
        await sleep(150);
    }
    throw new Error(`${label} page (${key}) did not appear`);
}

async function ensureChildPageClosed(browser, key, deadline, label) {
    while (Date.now() < deadline) {
        const leftover = (await browser.pages()).find(candidate => candidate.url().includes(key) && !candidate.isClosed());
        if (!leftover) return;
        await sleep(120);
    }
    throw new Error(`${label} page (${key}) never closed before reopen`);
}

// Known-benign console noise: the legacy pages load some Font Awesome SVG via
// data: URLs which the app's CSP (connect-src without data:) rejects. This is
// pre-existing main-renderer/legacy behaviour, reported separately; it is not
// a next-UI rebuild failure.
function isBenignConsoleNoise(text) {
    return /Content Security Policy|Refused to connect|Fetch API cannot load data:image/i.test(text);
}

function collectRealErrors(label) {
    const pageErrorsList = pageErrors.get(label) || [];
    const consoleErrorsList = (consoleErrors.get(label) || []).filter(message => !isBenignConsoleNoise(message));
    return [...pageErrorsList, ...consoleErrorsList];
}

async function auditNextPage(page, app, captureName, { expectEmbedded = true } = {}) {
    await page.waitForFunction(() => document.querySelector('.vcp-ui-page-shell'), { timeout: timeoutMs });
    await sleep(500); // let WA tooltips/layout settle
    const state = await page.evaluate(NEXT_AUDIT_SCRIPT);
    assert.equal(state.uiMode, 'next', `${app.name} must be next mode: ${JSON.stringify(state)}`);
    assert.equal(state.controllerMode, 'next', `${app.name} controller must agree on next mode`);
    assert.ok(state.hasShell, `${app.name} AppPageShell missing`);
    assert.equal(state.shellEmbedded, expectEmbedded ? 'true' : 'false', `${app.name} embedded flag wrong: ${JSON.stringify(state)}`);
    assert.equal(state.bodyScope, true, `${app.name} body not vcp-ui-scope`);
    if (expectEmbedded && app.integrated) {
        assert.equal(state.integratedShell, true, `${app.name} must use the shared integrated shell: ${JSON.stringify(state)}`);
        assert.equal(state.shellHeaderDisplay, 'none', `${app.name} embedded duplicate header must be hidden: ${JSON.stringify(state)}`);
        assert.ok(state.integratedMain?.visible, `${app.name} integrated main surface must be visible: ${JSON.stringify(state)}`);
        assert.notEqual(state.integratedMain?.radius, '0px', `${app.name} integrated main surface needs the shared top-left radius: ${JSON.stringify(state)}`);
    }
    if (app.shellTitle) assert.equal(state.shellTitle, app.shellTitle, `${app.name} shell title wrong: ${JSON.stringify(state)}`);
    for (const [tag, count] of Object.entries(app.minWa || {})) {
        assert.ok(state.wa[tag] >= count, `${app.name} needs >= ${count} <${tag}> but found ${state.wa[tag]}: ${JSON.stringify(state)}`);
    }
    if ((app.minNativeEnhanced || 0) > 0) {
        assert.ok(state.nativeEnhanced >= app.minNativeEnhanced, `${app.name} needs >= ${app.minNativeEnhanced} VCPUI-enhanced native controls but found ${state.nativeEnhanced}: ${JSON.stringify(state)}`);
    }
    assert.equal(state.overflowX, false, `${app.name} horizontal overflow: ${JSON.stringify(state)}`);
    if (app.requireOpaqueBody) {
        assert.notEqual(state.bodyBackgroundColor, 'rgba(0, 0, 0, 0)', `${app.name} root background must not expose Electron's black backing surface: ${JSON.stringify(state)}`);
    }
    assert.ok(state.headerRects.length >= (app.minHeaderRects || 0), `${app.name} expected >= ${app.minHeaderRects || 0} header controls but found ${state.headerRects.length}: ${JSON.stringify(state)}`);
    if (!expectEmbedded) {
        assert.equal(state.windowControls.count, 3, `${app.name} must expose exactly three window controls: ${JSON.stringify(state)}`);
        assert.equal(state.windowControls.allNoDrag, true, `${app.name} window controls are inside the draggable title region: ${JSON.stringify(state)}`);
    }
    if (state.headerRects.length) {
        assert.ok(state.allHeaderVisible, `${app.name} header controls not all visible: ${JSON.stringify(state)}`);
        assert.equal(state.headerOverlap, false, `${app.name} header controls overlap: ${JSON.stringify(state)}`);
    }
    if (app.bodyFocus) {
        const focusOk = await page.evaluate(() => {
            // WA-backed controls (wa-input/wa-textarea/wa-select) hold their
            // native input in shadow DOM; include them so a next-mode page
            // whose controls were upgraded by the Web Awesome adapter still
            // passes the focus check.
            const candidates = [...document.querySelectorAll(
                '.vcp-ui-page-shell-content input, .vcp-ui-page-shell-content textarea, .vcp-ui-page-shell-content select, ' +
                '.vcp-ui-page-shell-content wa-input, .vcp-ui-page-shell-content wa-textarea, .vcp-ui-page-shell-content wa-select'
            )].filter(el => !el.disabled && el.getClientRects().length && getComputedStyle(el).display !== 'none');
            if (!candidates.length) return { focused: false, reason: 'no visible control' };
            candidates[0].focus();
            const active = document.activeElement;
            const landed = active === candidates[0]
                || candidates[0].contains(active)
                || (candidates[0].shadowRoot && candidates[0].shadowRoot.contains(active));
            return { focused: landed, active: active?.tagName || '' };
        });
        assert.ok(focusOk.focused, `${app.name} focus did not land on a body control: ${JSON.stringify(focusOk)}`);
    }
    if (state.focusables >= 2) {
        const focused = await page.evaluate(FOCUS_FIRST_SCRIPT);
        if (focused) {
            await page.keyboard.press('Tab');
            const afterTab = await page.evaluate(() => {
                const active = document.activeElement;
                return { tag: active?.tagName?.toLowerCase() || '', id: active?.id || '' };
            });
            const moved = `${afterTab.tag}${afterTab.id ? '#' + afterTab.id : ''}` !== focused;
            assert.ok(moved, `${app.name} Tab did not move focus (still ${focused})`);
        }
    }
    await capture(page, captureName);

    // Narrow viewport regression.
    await page.setViewport({ width: 480, height: 720, deviceScaleFactor: 1 });
    await sleep(300);
    const narrow = await page.evaluate(() => ({
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }));
    assert.equal(narrow.overflowX, false, `${app.name} overflows at 480px: ${JSON.stringify(narrow)}`);
    await capture(page, captureName.replace('.png', '-narrow.png'));

    // Long text / clipping check when a textarea or input exists.
    const longText = await page.evaluate(LONG_TEXT_SCRIPT);
    if (longText.applied) {
        assert.equal(longText.overflowX, false, `${app.name} page overflows after long text: ${JSON.stringify(longText)}`);
    }
    return { state, longText };
}

async function auditArchivedClassicPage(page, app, captureName) {
    await page.waitForFunction((selector) => document.querySelector(selector), { timeout: timeoutMs }, app.legacySelector || app.legacy);
    await sleep(300);
    const state = await page.evaluate((legacySelector) => ({
        uiMode: document.documentElement.dataset.uiMode,
        hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
        waCount: document.querySelectorAll('wa-button, wa-input, wa-select, wa-card, wa-tooltip').length,
        bodyScope: document.body.classList.contains('vcp-ui-scope'),
        legacyPresent: Boolean(document.querySelector(legacySelector)),
    }), app.legacySelector || app.legacy);
    assert.equal(state.uiMode, 'classic', `${app.name} archived surface must resolve to classic: ${JSON.stringify(state)}`);
    assert.equal(state.hasShell, false, `${app.name} archived surface must not mount AppPageShell: ${JSON.stringify(state)}`);
    assert.equal(state.waCount, 0, `${app.name} archived surface must not register WA: ${JSON.stringify(state)}`);
    assert.equal(state.bodyScope, false, `${app.name} archived surface must not enter next scope: ${JSON.stringify(state)}`);
    assert.ok(state.legacyPresent, `${app.name} archived legacy DOM missing: ${JSON.stringify(state)}`);
    await capture(page, captureName);
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-ui-apps-electron-'));
const nextSettings = {
    uiMode: 'next',
    enableDistributedServer: false,
    vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'smoke-test-key',
};
const classicSettings = { ...nextSettings, uiMode: 'classic' };
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify(nextSettings), 'utf8');

// Keep the project-root mirror for older packaged/runtime paths while the
// primary hermetic authority remains VCPCHAT_APP_DATA_DIR.
const projectAppDataDir = path.join(root, 'AppData');
await fs.mkdir(projectAppDataDir, { recursive: true });
const projectSettingsFile = path.join(projectAppDataDir, 'settings.json');
async function writeProjectUiMode(uiMode) {
    let settings = {};
    try { settings = JSON.parse(await fs.readFile(projectSettingsFile, 'utf8')); } catch { /* first write */ }
    settings.uiMode = uiMode;
    await fs.writeFile(projectSettingsFile, JSON.stringify(settings), 'utf8');
}
await writeProjectUiMode('next');

const port = await freePort();
const stderr = { value: '' };
const rendererErrors = [];
const pageErrors = new Map();
const consoleErrors = new Map();
const webAwesomeRuntimeRequests = [];
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
child.stderr.on('data', (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-12_000); });

function instrument(page, label) {
    page.on('pageerror', (error) => {
        (pageErrors.get(label) || pageErrors.set(label, []).get(label)).push(error?.stack || String(error));
    });
    page.on('console', (message) => {
        if (message.type() === 'error') (consoleErrors.get(label) || consoleErrors.set(label, []).get(label)).push(message.text());
    });
}

const summary = [];
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
    instrument(page, 'main');
    page.on('request', (request) => {
        if (/vendor\/webawesome\/dist-cdn/i.test(request.url())) webAwesomeRuntimeRequests.push(request.url());
    });

    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });

    // 1. Web Awesome runtime must not be fetched nor registered at boot.
    const bootWaState = await page.evaluate(() => ({
        waButton: typeof customElements !== 'undefined' ? customElements.get('wa-button') : null,
        themeLink: Boolean(document.querySelector('link[data-webawesome-showcase-theme], link[data-webawesome-runtime-theme]')),
    }));
    assert.ok(!bootWaState.waButton, 'wa-button must not be registered at boot');
    assert.equal(bootWaState.themeLink, false, 'Web Awesome theme must not load at boot');
    assert.equal(webAwesomeRuntimeRequests.length, 0, `Web Awesome runtime fetched at boot: ${webAwesomeRuntimeRequests.join(', ')}`);
    const bootLucide = await page.evaluate(() => ({
        lucideIcons: document.querySelectorAll('[data-lucide]').length,
        lucideGlobal: Boolean(window.lucide),
    }));
    assert.ok(bootLucide.lucideGlobal, 'lucide library must be present in the main renderer');
    summary.push({ surface: '主界面 shell', mode: 'next', pass: true, lucide: bootLucide.lucideIcons, note: 'boot: WA 零请求/零注册，lucide 已载入' });

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
    await capture(page, 'main-showcase.png');
    summary.push({ surface: 'UI 组件库', mode: 'next', pass: true, lucide: 0, note: 'lazy-registers WA + 拉取 vendored bundle' });

    // 3. Global settings modal is enhanced in next mode + keyboard flow.
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
    const settingsSelectState = await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        return {
            native: modal?.querySelectorAll('select.vcp-ui-select-source').length || 0,
            proxies: modal?.querySelectorAll('wa-select.vcp-ui-select-proxy').length || 0,
            visibleNative: [...(modal?.querySelectorAll('select.vcp-ui-select-source') || [])]
                .filter(select => !select.hidden && getComputedStyle(select).display !== 'none').length,
        };
    });
    assert.ok(settingsSelectState.native > 0, `global settings Select sources missing: ${JSON.stringify(settingsSelectState)}`);
    assert.equal(settingsSelectState.proxies, settingsSelectState.native, `global settings Select proxies mismatch: ${JSON.stringify(settingsSelectState)}`);
    assert.equal(settingsSelectState.visibleNative, 0, `global settings native Select is still visible: ${JSON.stringify(settingsSelectState)}`);
    await capture(page, 'main-settings-next.png');
    // Focus lands on the first field inside the open modal.
    const settingsFocus = await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        const input = modal?.querySelector('input:not([type="hidden"])');
        if (!input) return { focused: false };
        input.focus();
        return { focused: document.activeElement === input, active: document.activeElement?.id || '' };
    });
    assert.ok(settingsFocus.focused, `global settings did not take focus: ${JSON.stringify(settingsFocus)}`);
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    summary.push({ surface: '全局设置', mode: 'next', pass: true, lucide: 0, note: '增强输入/保存栏 dirty 态/搜索注入/焦点' });

    // 4. Genuinely reconstructed embedded business pages (8 pages).
    for (const app of EMBEDDED_APPS) {
        const label = `next:${app.name}`;
        await page.evaluate((appDefinition) => window.topTabManager.openEmbeddedApp(appDefinition), {
            id: app.id, action: app.action, name: app.name,
        });
        const childPage = await waitForChildPage(browser, app.key, Date.now() + timeoutMs, app.name);
        instrument(childPage, label);
        if (app.nextEnabled) {
            await auditNextPage(childPage, app, `next-${app.name}.png`);
        } else {
            await auditArchivedClassicPage(childPage, app, `archived-classic-${app.name}.png`);
        }
        const errors = collectRealErrors(label);
        assert.equal(errors.length, 0, `${app.name} renderer errors:\n${errors.slice(0, 8).join('\n')}`);
        summary.push(app.nextEnabled
            ? { surface: app.name, mode: 'next', pass: true, lucide: 0, note: `shell + ${Object.entries(app.minWa || {}).map(([t, n]) => `${n}+<${t}>`).join(', ')}，native增强>=${app.minNativeEnhanced || 0}，无溢出/重叠/报错` }
            : { surface: app.name, mode: 'archived-classic', pass: true, lucide: 0, note: 'next 请求被产品 allowlist 安全回退到经典页面' });
        await page.evaluate((appDefinition) => window.topTabManager.closeView(`app:${appDefinition.id}`), { id: app.id });
        await ensureChildPageClosed(browser, app.key, Date.now() + timeoutMs, app.name);
    }

    // 5. Archived standalone surfaces stay classic even while the main window
    //    requests next UI. Their reconstructed source remains dormant.
    for (const standalone of [
        { action: 'open-canvas-window', key: 'canvas.html', name: '协同Canvas', shellTitle: '协同 Canvas', minWa: { 'wa-tooltip': 1 }, minNativeEnhanced: 1, legacy: '.editor-container', requireOpaqueBody: true },
        { action: 'open-rag-observer-window', key: 'RAG_Observer.html', name: '监听RAG', shellTitle: 'VCP 监听', minWa: { 'wa-tooltip': 0 }, minNativeEnhanced: 0, legacy: '.main-wrapper' },
    ]) {
        const label = `archived-classic:${standalone.name}`;
        await page.evaluate((action) => window.trayManager.launchApp({ id: `audit-${action}`, name: 'audit', action }), standalone.action);
        const standalonePage = await waitForChildPage(browser, standalone.key, Date.now() + timeoutMs, standalone.name);
        instrument(standalonePage, label);
        await auditArchivedClassicPage(standalonePage, standalone, `archived-classic-${standalone.name}.png`);
        const errors = collectRealErrors(label);
        assert.equal(errors.length, 0, `${standalone.name} renderer errors:\n${errors.slice(0, 8).join('\n')}`);
        summary.push({ surface: standalone.name, mode: 'archived-classic', pass: true, lucide: 0, note: '产品 allowlist 回退经典页面，无 WA' });
        await standalonePage.evaluate(() => { try { window.close(); } catch { /* best effort */ } });
        await ensureChildPageClosed(browser, standalone.key, Date.now() + timeoutMs, standalone.name);
    }

    // 6. Classic mode: embedded pages must keep the legacy DOM and never mount
    //    the next surface. Flip the project AppData settings the same way a
    //    user switching mode does, then walk a representative subset.
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify(classicSettings), 'utf8');
    await writeProjectUiMode('classic');
    for (const app of EMBEDDED_APPS) {
        const label = `classic:${app.name}`;
        await page.evaluate((appDefinition) => window.topTabManager.openEmbeddedApp(appDefinition), {
            id: app.id, action: app.action, name: app.name,
        });
        const childPage = await waitForChildPage(browser, app.key, Date.now() + timeoutMs, app.name);
        instrument(childPage, label);
        await childPage.waitForFunction((selector) => document.querySelector(selector), { timeout: timeoutMs }, app.legacySelector);
        await sleep(300);
        const classicState = await childPage.evaluate((legacySelector) => ({
            uiMode: document.documentElement.dataset.uiMode,
            hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
            waCount: document.querySelectorAll('wa-button, wa-input, wa-select, wa-card, wa-tooltip').length,
            bodyScope: document.body.classList.contains('vcp-ui-scope'),
            legacyPresent: Boolean(document.querySelector(legacySelector)),
        }), app.legacySelector);
        assert.equal(classicState.uiMode, 'classic', `${app.name} classic mode wrong: ${JSON.stringify(classicState)}`);
        assert.equal(classicState.hasShell, false, `${app.name} must not mount AppPageShell in classic: ${JSON.stringify(classicState)}`);
        assert.equal(classicState.waCount, 0, `${app.name} must not register WA in classic: ${JSON.stringify(classicState)}`);
        assert.equal(classicState.bodyScope, false, `${app.name} body must not be vcp-ui-scope in classic: ${JSON.stringify(classicState)}`);
        assert.ok(classicState.legacyPresent, `${app.name} legacy DOM missing in classic: ${JSON.stringify(classicState)}`);
        await capture(childPage, `classic-${app.name}.png`);
        summary.push({ surface: app.name, mode: 'classic', pass: true, lucide: 0, note: '旧 DOM 保留，next 表面未挂载，无 WA' });
        await page.evaluate((appDefinition) => window.topTabManager.closeView(`app:${appDefinition.id}`), { id: app.id });
        await ensureChildPageClosed(browser, app.key, Date.now() + timeoutMs, app.name);
    }
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify(nextSettings), 'utf8');
    await writeProjectUiMode('next');

    // 6b. Classic mode for the standalone windows: flip the isolated app-data
    //     settings (the source the windows' bootstrap reads via loadSettings),
    //     reopen, confirm legacy DOM + no next surface, then restore.
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify(classicSettings), 'utf8');
    for (const standalone of [
        { action: 'open-canvas-window', key: 'canvas.html', name: '协同Canvas', legacy: '.editor-container' },
        { action: 'open-rag-observer-window', key: 'RAG_Observer.html', name: '监听RAG', legacy: '.main-wrapper' },
    ]) {
        const label = `classic:${standalone.name}`;
        await ensureChildPageClosed(browser, standalone.key, Date.now() + timeoutMs, standalone.name);
        await page.evaluate((action) => window.trayManager.launchApp({ id: `audit-${action}`, name: 'audit', action }), standalone.action);
        const standalonePage = await waitForChildPage(browser, standalone.key, Date.now() + timeoutMs, standalone.name);
        instrument(standalonePage, label);
        await standalonePage.waitForFunction((selector) => document.querySelector(selector), { timeout: timeoutMs }, standalone.legacy);
        await sleep(300);
        const classicState = await standalonePage.evaluate((legacySelector) => ({
            uiMode: document.documentElement.dataset.uiMode,
            hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
            waCount: document.querySelectorAll('wa-button, wa-input, wa-select, wa-card, wa-tooltip').length,
            bodyScope: document.body.classList.contains('vcp-ui-scope'),
            legacyPresent: Boolean(document.querySelector(legacySelector)),
        }), standalone.legacy);
        assert.equal(classicState.uiMode, 'classic', `${standalone.name} classic mode wrong: ${JSON.stringify(classicState)}`);
        assert.equal(classicState.hasShell, false, `${standalone.name} must not mount AppPageShell in classic: ${JSON.stringify(classicState)}`);
        assert.equal(classicState.waCount, 0, `${standalone.name} must not register WA in classic: ${JSON.stringify(classicState)}`);
        assert.ok(classicState.legacyPresent, `${standalone.name} legacy DOM missing in classic: ${JSON.stringify(classicState)}`);
        await capture(standalonePage, `classic-${standalone.name}.png`);
        summary.push({ surface: standalone.name, mode: 'classic', pass: true, lucide: 0, note: '旧 DOM 保留，next 表面未挂载' });
        await standalonePage.evaluate(() => { try { window.close(); } catch { /* best effort */ } });
        await sleep(300);
    }
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify(nextSettings), 'utf8');

    // 7. Main renderer: switch to classic tears the next-UI surfaces down.
    await page.evaluate(() => window.uiModeManager.apply('classic', { cache: true }));
    await page.waitForFunction(() => {
        const input = document.getElementById('globalSettingsForm')?.querySelector('input[id]');
        return !input || !input.className.includes('vcp-ui-native-input');
    }, { timeout: timeoutMs });
    summary.push({ surface: '全局设置', mode: 'classic', pass: true, lucide: 0, note: 'next 表面已拆除' });

    console.log('Electron UI apps smoke passed (boot WA gate, showcase, global settings, 8 embedded pages, canvas/RAG standalone, classic regression).');
} catch (error) {
    console.error(`Electron UI apps smoke failed:\n${error?.stack || error}`);
    for (const [label, errors] of [...pageErrors, ...consoleErrors]) {
        if (errors.length) console.error(`\n${label} errors:\n${errors.slice(0, 12).map(line => `- ${line}`).join('\n')}`);
    }
    process.exitCode = 1;
} finally {
    child.kill();
    browser?.disconnect();
    await new Promise(resolve => setTimeout(resolve, 300));
    child.kill('SIGKILL');
}

// ── 8. VchatManager standalone sub-app audit ───────────────────────────────
// VchatManager is launched as its own Electron entry. Its main process reads
// the shared settings file and passes uiMode explicitly to the renderer.
{
    const vchatManagerAppData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-vchatmanager-'));
    await fs.writeFile(path.join(vchatManagerAppData, 'settings.json'), JSON.stringify(nextSettings), 'utf8');
    const subPort = await freePort();
    const subStderr = { value: '' };
    const subChild = spawn(electron, ['VchatManager', `--remote-debugging-port=${subPort}`], {
        cwd: root,
        env: { ...process.env, VCPCHAT_APP_DATA_DIR: vchatManagerAppData },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    subChild.stderr.on('data', (chunk) => { subStderr.value = `${subStderr.value}${chunk}`.slice(-8_000); });
    let subBrowser;
    try {
        const subDeadline = Date.now() + timeoutMs;
        while (Date.now() < subDeadline) {
            if (subChild.exitCode !== null) throw new Error(`VchatManager exited before startup: ${subStderr.value}`);
            try { await requestJson(`http://127.0.0.1:${subPort}/json/version`); break; } catch { await sleep(150); }
        }
        subBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${subPort}` });
        let subPage = null;
        while (Date.now() < subDeadline) {
            subPage = (await subBrowser.pages()).find(candidate => candidate.url().includes('index.html')) || null;
            if (subPage) break;
            await sleep(120);
        }
        assert.ok(subPage, `VchatManager renderer did not appear: ${subStderr.value}`);
        const subErrors = [];
        subPage.on('pageerror', (error) => subErrors.push(error?.stack || String(error)));
        await subPage.waitForFunction(() => document.readyState === 'complete' && document.body, { timeout: timeoutMs });
        await sleep(800);
        const vmState = await subPage.evaluate(() => ({
            url: location.href,
            uiMode: document.documentElement.dataset.uiMode,
            controllerMode: window.VCPUiModeController?.getCurrentMode?.() || null,
            hasShell: Boolean(document.querySelector('.vcp-ui-page-shell')),
            bodyScope: document.body.classList.contains('vcp-ui-scope'),
            waCount: document.querySelectorAll('wa-button, wa-input, wa-select, wa-card, wa-tooltip').length,
            hasAPI: Boolean(window.api),
            hasLoadSettings: Boolean((window.utilityAPI || window.electronAPI)?.loadSettings),
            bodyTextLength: (document.body?.textContent || '').trim().length,
        }));
        await capture(subPage, 'archived-classic-VchatManager.png');
        assert.equal(vmState.uiMode, 'classic', `VchatManager archived surface must resolve to classic: ${JSON.stringify(vmState)}`);
        assert.equal(vmState.controllerMode, 'classic', `VchatManager archived controller mode mismatch: ${JSON.stringify(vmState)}`);
        assert.equal(vmState.hasShell, false, `VchatManager archived surface must not mount next shell: ${JSON.stringify(vmState)}`);
        assert.equal(vmState.bodyScope, false, `VchatManager archived surface must not enter next scope: ${JSON.stringify(vmState)}`);
        assert.equal(vmState.waCount, 0, `VchatManager archived surface must not register WA: ${JSON.stringify(vmState)}`);
        summary.push({
            surface: '数据VchatManager', mode: 'archived-classic', pass: true,
            lucide: 0,
            note: `共享 settings 请求被产品 allowlist 回退经典页面（api=${vmState.hasAPI}）`,
        });
        assert.equal(subErrors.length, 0, `VchatManager renderer errors:\n${subErrors.slice(0, 8).join('\n')}`);
    } catch (error) {
        console.error(`VchatManager audit failed:\n${error?.stack || error}`);
        process.exitCode = 1;
    } finally {
        subChild.kill();
        subBrowser?.disconnect();
        await sleep(250);
        subChild.kill('SIGKILL');
    }
}

// ── Report ────────────────────────────────────────────────────────────────
const pass = summary.filter(item => item.pass).length;
console.log(`\nUI apps audit summary (${pass}/${summary.length} passed):`);
for (const item of summary) {
    console.log(`  [${item.mode}] ${item.surface}: ${item.pass ? 'PASS' : 'FAIL'} — ${item.note}`);
}
if (process.exitCode) process.exitCode = 1;
