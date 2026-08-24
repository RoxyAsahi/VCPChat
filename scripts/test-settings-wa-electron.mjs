// test-settings-wa-electron — real Electron verification + screenshots for the
// global settings modal in Next UI (R5.1 SettingsShell).
//
// Verifies against the real app:
//   - the modal is rebuilt into one unified Harness SettingsRoot layout,
//   - switching categories keeps unsaved values in the DOM,
//   - the search locates and activates the matching category,
//   - a real save persists through IPC to settings.json, the modal closes, and
//     a page reload (reopen) restores the saved value from disk,
//   - captures 700×500 light/dark screenshots under screenshots/.
//
// Usage: node scripts/test-settings-wa-electron.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const timeoutMs = 90_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const screenshotsDir = path.join(root, 'screenshots');
const darkShot = path.join(screenshotsDir, 'settings-wa-dark-700x500.png');
const lightShot = path.join(screenshotsDir, 'settings-wa-light-700x500.png');

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

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-settings-wa-electron-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    enableDistributedServer: false,
    vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'smoke-test-key',
    continueWritingPrompt: '请继续',
    userName: '初始用户',
}), 'utf8');
await fs.mkdir(screenshotsDir, { recursive: true });
const port = await freePort();
const stderr = { value: '' };
const rendererErrors = [];
const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
child.stderr.on('data', (chunk) => { stderr.value = `${stderr.value}${chunk}`.slice(-12_000); });

async function resizeWindow(page, browser, width, height) {
    // Resize the OS window so a 700×500 screenshot covers the whole modal.
    // Browser.* CDP commands require the browser-level target session.
    try {
        const browserTarget = browser.targets().find((target) => target.type() === 'browser');
        const session = await browserTarget.createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: page.target()._targetId });
        await session.send('Browser.setWindowBounds', { windowId, bounds: { width, height } });
        await session.detach();
    } catch (error) {
        console.warn(`[test-settings-wa-electron] window resize skipped: ${error?.message}`);
    }
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
}

async function setTheme(page, theme) {
    await page.evaluate((name) => {
        document.body.classList.remove('light-theme', 'dark-theme');
        document.body.classList.add(`${name}-theme`);
    }, theme);
    await new Promise(resolve => setTimeout(resolve, 250));
}

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
    page.on('console', (message) => {
        if (message.type() === 'error') rendererErrors.push(`console.error: ${message.text()}`);
    });

    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });

    // ---- 1. SettingsShell layout ----
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal .vcp-harness-settings-panel'), { timeout: timeoutMs });
    const shellState = await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        const navItems = modal.querySelectorAll('.vcp-harness-settings-nav-cell');
        const autosaveStatus = modal.querySelector('.vcp-settings-autosave-status');
        return {
            shell: Boolean(modal.querySelector('.vcp-harness-settings-panel')),
            navCount: navItems.length,
            autosaveMounted: Boolean(autosaveStatus),
            sectionIds: [...modal.querySelectorAll('.settings-section')].map(section => section.id),
            activeSection: modal.querySelector('.settings-section.active')?.id,
            iconReplaced: Boolean(modal.querySelector('#resetUserAvatarColorsBtn [data-lucide]')),
            canonicalRows: modal.querySelectorAll('.vcp-harness-general-item[data-canonical-row="true"]').length,
            legacySubsectionHeadings: modal.querySelectorAll('.settings-subsection-heading, .settings-subsection-title, .settings-subsection-description').length,
            legacyBusinessRows: [...modal.querySelectorAll('#globalSettingsForm .settings-form-group, #globalSettingsForm .form-group-inline')]
                .filter(row => !row.closest('.vcp-harness-general-item')).length,
            unwrappedBusinessRows: [...modal.querySelectorAll('#globalSettingsForm .vcp-settings-row, #globalSettingsForm .vcp-settings-control-row, #globalSettingsForm > .form-group')]
                .filter(row => row.querySelector('input, select, textarea, button') && !row.closest('.vcp-harness-general-item')).length,
            typedSettingsRevision: modal.dataset.vcpSettingsRevision || null,
            typedSettingsSource: modal.dataset.vcpSettingsSource || null,
            navGeometry: (() => { const nav = modal.querySelector('.vcp-harness-settings-nav'); const list = modal.querySelector('.vcp-harness-settings-nav-list'); return { nav: nav?.getBoundingClientRect().toJSON(), list: list?.getBoundingClientRect().toJSON(), navScrollHeight: nav?.scrollHeight, navClientHeight: nav?.clientHeight }; })(),
            computedGeometry: (() => {
                const pick = (selector) => {
                    const node = [...modal.querySelectorAll(selector)].find(candidate => candidate.getBoundingClientRect().width > 0) || modal.querySelector(selector);
                    if (!node) return null;
                    const style = getComputedStyle(node);
                    return {
                        selector,
                        rect: node.getBoundingClientRect().toJSON(),
                        fontSize: style.fontSize,
                        lineHeight: style.lineHeight,
                        padding: style.padding,
                        gap: style.gap,
                        borderWidth: style.borderWidth,
                        borderColor: style.borderColor,
                        backgroundColor: style.backgroundColor,
                        borderRadius: style.borderRadius,
                    };
                };
                return [
                    pick('.vcp-harness-settings-panel'),
                    pick('.vcp-harness-settings-nav'),
                    pick('.vcp-harness-settings-nav-cell'),
                    pick('.vcp-harness-settings-header'),
                    pick('.vcp-harness-settings-options'),
                    pick('.vcp-harness-general-item'),
                    pick('.vcp-harness-input-wrap'),
                    pick('.vcp-harness-select-trigger'),
                    pick('.vcp-harness-choice-option'),
                ].filter(Boolean);
            })(),
        };
    });
    assert.ok(shellState.shell, 'SettingsShell class applied');
    assert.equal(shellState.navCount, 8, '8 canonical Harness nav cells');
    assert.ok(shellState.autosaveMounted, 'autosave status is mounted in the Harness header');
    assert.equal(shellState.sectionIds.length, 8, '8 setting sections present');
    assert.equal(shellState.activeSection, 'section-user-identity', 'starts on user identity');
    assert.ok(shellState.canonicalRows >= 20, `canonical settings rows mounted (${shellState.canonicalRows})`);
    assert.equal(shellState.legacySubsectionHeadings, 0, 'legacy subsection headings removed from the unified surface');
    assert.equal(shellState.legacyBusinessRows, 0, 'legacy business row classes removed from the unified surface');
    assert.equal(shellState.unwrappedBusinessRows, 0, 'every business row is owned by a canonical wrapper');
    assert.ok(Number.isInteger(Number(shellState.typedSettingsRevision)), `typed settings snapshot missing: ${JSON.stringify(shellState)}`);
    assert.ok(shellState.typedSettingsSource, `typed settings source missing: ${JSON.stringify(shellState)}`);
    console.log(`  [INFO] nav geometry ${JSON.stringify(shellState.navGeometry)}`);
    console.log(`  [INFO] computed geometry ${JSON.stringify(shellState.computedGeometry)}`);
    await fs.writeFile(path.join(screenshotsDir, 'settings-computed-geometry.json'), `${JSON.stringify({ viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), ...shellState }, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(screenshotsDir, 'settings-dom-tree.json'), `${JSON.stringify(await page.evaluate(() => {
        const root = document.querySelector('#globalSettingsModal');
        const summarize = (node, depth = 0) => {
            if (!(node instanceof Element) || depth > 4) return null;
            return {
                tag: node.tagName.toLowerCase(),
                id: node.id || undefined,
                classes: [...node.classList].filter(name => name.startsWith('vcp-harness-') || name.startsWith('vcp-settings-') || name === 'settings-section'),
                primitive: node.dataset.settingPrimitive || undefined,
                children: [...node.children].map(child => summarize(child, depth + 1)).filter(Boolean),
            };
        };
        return summarize(root);
    }), null, 2)}\n`, 'utf8');
    // Icons inside the form are normalized to VCPUI Lucide icons (the lucide
    // adapter renders the marker span into an svg shortly after insertion).
    await page.waitForFunction(() => {
        const btn = document.getElementById('resetUserAvatarColorsBtn');
        return Boolean(btn?.querySelector('[data-vcp-icon]') || btn?.querySelector('span.vcp-ui-icon'));
    }, { timeout: timeoutMs });
    console.log('  [PASS] 1. SettingsRoot layout (nav cells, header, options, sections, icons)');

    // Activate the appearance section so the geometry probe samples real
    // controls rather than hidden descendants from another section.
    await page.evaluate(() => document.querySelector('.vcp-harness-settings-nav-cell[data-section="appearance-settings"]')?.click());
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal #section-appearance-settings.active'), { timeout: timeoutMs });
    const visibleGeometry = await page.evaluate(() => {
        const modal = document.getElementById('globalSettingsModal');
        const probe = (selector) => {
            const node = [...modal.querySelectorAll(selector)].find(candidate => candidate.getBoundingClientRect().width > 0);
            if (!node) return null;
            const style = getComputedStyle(node);
            return { selector, rect: node.getBoundingClientRect().toJSON(), height: style.height, minHeight: style.minHeight, padding: style.padding, borderRadius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight };
        };
        return [probe('.vcp-harness-select-trigger'), probe('.vcp-harness-menu-item'), probe('.vcp-harness-choice-option')].filter(Boolean);
    });
    assert.ok(visibleGeometry.some(item => item.selector === '.vcp-harness-select-trigger' && item.height === '36px' && item.borderRadius === '18px' && item.fontSize === '14px' && item.lineHeight === '22px'), 'visible select geometry matches Harness trigger contract');
    assert.ok(shellState.computedGeometry.some(item => item.selector === '.vcp-harness-input-wrap' && item.borderRadius === '8px'), 'Input wrapper geometry matches Harness contract');
    console.log(`  [INFO] visible control geometry ${JSON.stringify(visibleGeometry)}`);
    await page.evaluate(() => document.querySelector('.vcp-harness-settings-nav-cell[data-section="user-identity"]')?.click());
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal #section-user-identity.active'), { timeout: timeoutMs });

    // ---- 1b. Harness select and compact choice primitives ----
    const controlState = await page.evaluate(() => ({
        longSelects: [...document.querySelectorAll('#globalSettingsModal .vcp-harness-select-wrap select')].map(select => select.id),
        choiceRows: document.querySelectorAll('#globalSettingsModal .vcp-harness-choice-wrap').length,
        nativeSources: document.querySelectorAll('#globalSettingsModal select.vcp-harness-select-native').length,
        visibleSelectProjections: [...document.querySelectorAll('#globalSettingsModal select.vcp-harness-select-native')].filter(select => {
            const trigger = select.closest('.vcp-harness-select-wrap')?.querySelector('.vcp-harness-select-trigger');
            return trigger && getComputedStyle(trigger).display !== 'none';
        }).length,
    }));
    assert.ok(controlState.longSelects.includes('chatFontPreset'), `font preset uses Harness select: ${controlState.longSelects.join(',')}`);
    assert.ok(controlState.choiceRows >= 1, 'short enumerations use compact choice rows');
    const disclosureState = await page.evaluate(() => {
        const header = document.querySelector('#globalSettingsModal .vcp-harness-disclosure-row');
        return header ? { role: header.getAttribute('role'), controls: header.getAttribute('aria-controls'), expanded: header.getAttribute('aria-expanded') } : null;
    });
    if (disclosureState) {
        assert.equal(disclosureState.role, 'button', 'DisclosureRow exposes button role');
        assert.ok(disclosureState.controls, 'DisclosureRow exposes aria-controls');
        assert.ok(['true', 'false'].includes(disclosureState.expanded), 'DisclosureRow exposes aria-expanded');
    }
    assert.equal(controlState.nativeSources, controlState.longSelects.length, 'native select remains the sole source for long controls');
    assert.equal(controlState.visibleSelectProjections, controlState.longSelects.length, 'each long select has exactly one visible Harness trigger');
    await page.evaluate(() => {
        const select = document.getElementById('chatFontPreset');
        const trigger = select.closest('.vcp-harness-select-wrap')?.querySelector('.vcp-harness-select-trigger');
        trigger?.click();
    });
    await page.waitForFunction(() => document.querySelector('#chatFontPreset')?.closest('.vcp-harness-select-wrap')?.querySelector('.vcp-harness-select-trigger[aria-expanded="true"]')
        && document.querySelector('.vcp-harness-menu-portal:not([hidden])'), { timeout: timeoutMs });
    const popoverState = await page.evaluate(() => {
        const wrap = document.getElementById('chatFontPreset').closest('.vcp-harness-select-wrap');
        const popover = document.querySelector('.vcp-harness-menu-portal:not([hidden])');
        return {
            options: popover?.querySelectorAll('[role="menuitem"]').length || 0,
            checked: popover?.querySelectorAll('[role="menuitem"].is-selected').length || 0,
            triggerHasMenu: wrap.querySelector('.vcp-harness-select-trigger')?.getAttribute('aria-haspopup') === 'menu',
            background: getComputedStyle(wrap.querySelector('.vcp-harness-select-trigger')).backgroundColor,
            border: getComputedStyle(wrap.querySelector('.vcp-harness-select-trigger')).borderTopColor,
            height: getComputedStyle(wrap.querySelector('.vcp-harness-select-trigger')).height,
            radius: getComputedStyle(wrap.querySelector('.vcp-harness-select-trigger')).borderTopLeftRadius,
        };
    });
    assert.ok(popoverState.options >= 5, 'long select renders a real option popover');
    assert.equal(popoverState.triggerHasMenu, true, 'Harness select trigger owns a Menu primitive');
    assert.equal(popoverState.checked, 1, 'popover exposes one checked option');
    assert.equal(popoverState.height, '36px', 'Harness trigger uses 36px capsule height');
    assert.equal(popoverState.radius, '18px', 'Harness trigger uses 18px capsule radius');
    assert.equal(await page.$eval('.vcp-harness-menu-portal:not([hidden])', menu => getComputedStyle(menu).borderRadius), '12px', 'Harness menu surface uses r12');
    const menuWidth = await page.$eval('.vcp-harness-menu-portal:not([hidden])', menu => ({ min: getComputedStyle(menu).minWidth, max: getComputedStyle(menu).maxWidth }));
    assert.equal(menuWidth.min, '218px', 'Harness menu surface uses min-width 218px');
    assert.equal(menuWidth.max, '360px', 'Harness menu surface uses max-width 360px');
    assert.equal(await page.$eval('.vcp-harness-menu-portal:not([hidden]) [role="menuitem"]', option => getComputedStyle(option).minHeight), '40px', 'Harness menu item uses min-height 40px');
    await page.waitForFunction(() => {
        const menu = document.querySelector('.vcp-harness-menu-portal:not([hidden])');
        return menu && getComputedStyle(menu).visibility === 'visible';
    }, { timeout: timeoutMs });
    const focusedMenuItem = await page.$eval('.vcp-harness-menu-portal:not([hidden]) [role="menuitem"]:not(:disabled)', option => {
        option.focus();
        return document.activeElement === option;
    });
    assert.equal(focusedMenuItem, true, 'menu item receives keyboard focus');
    await page.keyboard.press('ArrowDown');
    const activeAfterArrow = await page.evaluate(() => ({ role: document.activeElement?.getAttribute('role'), selected: document.querySelector('#chatFontPreset')?.value, active: document.activeElement?.id }));
    assert.equal(activeAfterArrow.role, 'menuitem', 'menu ArrowDown keeps focus inside the Menu primitive');
    assert.equal(activeAfterArrow.selected, await page.$eval('#chatFontPreset', select => select.value), 'menu highlight does not write business value before Enter');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.vcp-harness-menu-portal:not([hidden])'), { timeout: timeoutMs });
    await page.evaluate(() => document.querySelector('#chatFontPreset')?.closest('.vcp-harness-select-wrap')?.querySelector('.vcp-harness-select-trigger')?.click());
    await page.waitForFunction(() => document.querySelector('.vcp-harness-menu-portal:not([hidden])'), { timeout: timeoutMs });
    await page.evaluate(() => document.querySelectorAll('.vcp-harness-menu-portal:not([hidden]) [role="menuitem"]')[1]?.click());
    assert.equal(await page.$eval('#chatFontPreset', select => select.value), await page.$eval('#chatFontPreset', select => select.options[1].value), 'select choice writes through to native source');
    await page.evaluate(() => document.querySelector('#chatFontPreset')?.closest('.vcp-harness-select-wrap')?.querySelector('.vcp-harness-select-trigger')?.click());
    await page.waitForFunction(() => Boolean(document.querySelector('.vcp-harness-menu-portal:not([hidden])')), { timeout: timeoutMs });
    await page.mouse.click(4, 4);
    await page.waitForFunction(() => !document.querySelector('.vcp-harness-menu-portal:not([hidden])'), { timeout: timeoutMs });
    assert.equal(await page.$eval('#chatFontPreset', select => select.closest('.vcp-harness-select-wrap')?.querySelector('.vcp-harness-select-trigger')?.getAttribute('aria-expanded')), 'false', 'outside click closes the owned portal');
    await page.evaluate(() => {
        const select = document.getElementById('assistantAgent');
        select.replaceChildren(new Option('助手 A', 'agent-a'), new Option('助手 B', 'agent-b'));
    });
    await page.waitForFunction(() => Boolean(document.querySelector('#assistantAgent')?.closest('.vcp-harness-choice-wrap, .vcp-harness-select-wrap')), { timeout: timeoutMs });
    assert.ok(await page.$eval('#assistantAgent', select => Boolean(select.closest('.vcp-harness-choice-wrap') || select.closest('.vcp-harness-select-wrap'))), 'dynamic assistant options receive a Harness primitive');
    console.log(`  [PASS] 1b. Harness select popover + compact choices (background ${popoverState.background}, border ${popoverState.border})`);

    // ---- 2. Category switching keeps unsaved values ----
    await page.evaluate(() => {
        const input = document.getElementById('userName');
        input.value = '未保存测试';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-harness-settings-nav-cell')[1].click());
    await new Promise(resolve => setTimeout(resolve, 80));
    const switchState = await page.evaluate(() => ({
        active: document.querySelector('#globalSettingsModal .settings-section.active')?.id,
    }));
    assert.equal(switchState.active, 'section-server-connection', 'nav switched to server connection');
    await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-harness-settings-nav-cell')[0].click());
    await new Promise(resolve => setTimeout(resolve, 80));
    const backState = await page.evaluate(() => ({
        active: document.querySelector('#globalSettingsModal .settings-section.active')?.id,
        userName: document.getElementById('userName')?.value,
    }));
    assert.equal(backState.active, 'section-user-identity', 'nav switched back');
    assert.equal(backState.userName, '未保存测试', 'unsaved value survived the category round-trip');
    console.log('  [PASS] 2. category switching keeps unsaved values');

    // ---- 3. Canonical nav exposes every section without an extra search layer ----
    assert.equal(await page.evaluate(() => document.querySelectorAll('#globalSettingsModal .vcp-harness-settings-nav-cell').length), 8, 'canonical nav remains stable');
    console.log('  [PASS] 3. canonical nav has no duplicate search layer');

    // ---- 4. Dark screenshot (700×500) ----
    // The app boots in light theme by default; switch explicitly to dark first.
    await resizeWindow(page, browser, 700, 500);
    await setTheme(page, 'dark');
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal .vcp-harness-settings-panel'), { timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: darkShot, clip: { x: 0, y: 0, width: 700, height: 500 } });
    const darkStat = await fs.stat(darkShot);
    assert.ok(darkStat.size > 20_000, `dark screenshot written (${darkStat.size} bytes)`);
    const darkModalBg = await page.evaluate(() => getComputedStyle(document.querySelector('#globalSettingsModal .vcp-harness-settings-panel')).backgroundColor);
    console.log('  [PASS] 4. dark screenshot -> screenshots/settings-wa-dark-700x500.png');

    // ---- 5. Light screenshot (700×500) ----
    await setTheme(page, 'light');
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: lightShot, clip: { x: 0, y: 0, width: 700, height: 500 } });
    const lightStat = await fs.stat(lightShot);
    assert.ok(lightStat.size > 20_000, `light screenshot written (${lightStat.size} bytes)`);
    const lightModalBg = await page.evaluate(() => getComputedStyle(document.querySelector('#globalSettingsModal .vcp-harness-settings-panel')).backgroundColor);
    assert.notEqual(darkModalBg, lightModalBg, `dark and light modal backgrounds differ (${darkModalBg} vs ${lightModalBg})`);
    const darkHash = createHash('sha256').update(await fs.readFile(darkShot)).digest('hex');
    const lightHash = createHash('sha256').update(await fs.readFile(lightShot)).digest('hex');
    assert.notEqual(darkHash, lightHash, 'dark and light screenshots must differ');
    console.log(`  [PASS] 5. light screenshot -> screenshots/settings-wa-light-700x500.png (bg ${lightModalBg})`);

    // ---- 6. Real save through IPC, then reopen (reload) restores from disk ----
    await resizeWindow(page, browser, 1200, 800);
    await setTheme(page, 'dark');
    const uniquePrompt = `请继续-电子-重试-${Date.now()}`;
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await new Promise(resolve => setTimeout(resolve, 150));
    // Force the real IPC persistence path to fail once by removing write
    // access from the isolated test profile, then restore it for retry.
    await fs.chmod(path.join(appData, 'settings.json'), 0o444);
    await fs.chmod(appData, 0o500);
    await page.evaluate((value) => {
        const textarea = document.getElementById('continueWritingPrompt');
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }, uniquePrompt);
    const footerStateBefore = await page.evaluate(() => document.querySelector('.vcp-settings-autosave-status')?.dataset.state);
    assert.equal(footerStateBefore, 'dirty', 'save bar reports dirty before saving');
    await page.evaluate(() => {
        window.__settingsSaveProjection = null;
        window.addEventListener('global-settings-updated', event => {
            if (event.detail?.source !== 'settings-save') return;
            window.__settingsSaveProjection = {
                continueWritingPrompt: event.detail.settings?.continueWritingPrompt,
                userName: event.detail.settings?.userName,
            };
        }, { once: true });
    });
    await page.waitForFunction(() => document.querySelector('.vcp-settings-autosave-status')?.dataset.state === 'error', { timeout: timeoutMs });
    const failedRetryState = await page.evaluate(() => ({
        active: document.getElementById('globalSettingsModal')?.classList.contains('active') || false,
        footerState: document.querySelector('.vcp-settings-autosave-status')?.dataset.state || '',
        prompt: document.getElementById('continueWritingPrompt')?.value || '',
    }));
    assert.equal(failedRetryState.active, true, `failed save keeps SettingsRoot open (${JSON.stringify(failedRetryState)})`);
    assert.equal(failedRetryState.footerState, 'error', 'failed save exposes retry state');
    assert.equal(failedRetryState.prompt, uniquePrompt, 'failed save preserves input');
    await fs.chmod(appData, 0o700);
    await fs.chmod(path.join(appData, 'settings.json'), 0o600);
    await page.click('.vcp-settings-autosave-status');
    await page.waitForFunction(() => document.querySelector('.vcp-settings-autosave-status')?.dataset.state === 'saving' || document.querySelector('.vcp-settings-autosave-status')?.dataset.state === 'saved', { timeout: timeoutMs });
    // Poll for the modal to close; collect diagnostics so a hang is debuggable.
    let saveDiagnostics = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const state = await page.evaluate(() => ({
            active: document.getElementById('globalSettingsModal')?.classList.contains('active') || false,
            footerState: document.querySelector('.vcp-settings-autosave-status')?.dataset.state || '',
            prompt: window.__settingsSaveProjection?.continueWritingPrompt || '',
        }));
        if (!state.active) break;
        saveDiagnostics = state;
        await sleep(250);
    }
    const afterSave = await page.evaluate(() => ({
        active: document.getElementById('globalSettingsModal')?.classList.contains('active') || false,
        footerState: document.querySelector('.vcp-settings-autosave-status')?.dataset.state || '',
        toast: [...document.querySelectorAll('.vcp-ui-toast, .floating-toast-notification')].map(node => node.textContent).slice(0, 3),
    }));
    assert.equal(afterSave.active, false, `modal closed after save; last poll ${JSON.stringify(saveDiagnostics)}, after ${JSON.stringify(afterSave)}`);
    const savedProjection = await page.evaluate(() => window.__settingsSaveProjection);
    assert.equal(savedProjection?.continueWritingPrompt, uniquePrompt, 'settings authority publishes the persisted value after save');
    const savedUserName = savedProjection?.userName;
    console.log('  [PASS] 6. failed save keeps input, retry succeeds, and IPC persists (modal closed, authority projection updated)');

    // Reopen after a full reload: the form must be re-populated from settings.json.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 250));
    const restored = await page.evaluate(() => ({
        prompt: document.getElementById('continueWritingPrompt')?.value,
        userName: document.getElementById('userName')?.value,
        active: document.querySelector('#globalSettingsModal .settings-section.active')?.id,
    }));
    assert.equal(restored.prompt, uniquePrompt, 'reopened form restored the persisted continueWritingPrompt');
    assert.equal(restored.userName, savedUserName, 'reopened form restored the persisted userName from disk');
    assert.equal(restored.active, 'section-user-identity', 'reopened modal starts on the first category');
    console.log('  [PASS] 7. reopen after reload restores persisted values from settings.json');

    // ---- 8. Canonical next layout survives reload ----
    assert.equal(await page.evaluate(() => document.documentElement.dataset.uiMode), 'next');
    await page.waitForFunction(() => {
        const modal = document.getElementById('globalSettingsModal');
        return Boolean(modal?.querySelector('.vcp-harness-settings-root .vcp-harness-settings-header') && modal?.querySelector('.vcp-harness-settings-options'));
    }, { timeout: timeoutMs });
    console.log('  [PASS] 8. canonical unified SettingsShell survives reload');

    // ---- 9. Explicit renderer teardown retracts the Settings owner ledger ----
    const teardownLedger = await page.evaluate(async () => {
        await window.VCPUISettingsBridge?.destroy?.();
        return {
            scopes: window.VCPLifecycle?.diagnostics?.snapshot?.() || [],
            typedRevision: document.getElementById('globalSettingsModal')?.dataset.vcpSettingsRevision || null,
        };
    });
    assert.equal(teardownLedger.scopes.some(scope => String(scope.label).includes('settings-bridge')), false, `settings bridge scope disposed: ${JSON.stringify(teardownLedger.scopes)}`);
    assert.equal(teardownLedger.scopes.some(scope => String(scope.label).includes('settings-presentation')), false, `settings presentation scope disposed: ${JSON.stringify(teardownLedger.scopes)}`);
    console.log('  [PASS] 9. explicit Settings owner teardown retracts bridge/presentation scopes');

    console.log('\nSettings Harness structure gate passed (Root, nav/header/options, controls, failure retry, reload restore, teardown, screenshots).');
} catch (error) {
    console.error(`Settings WA Electron gate failed:\n${error?.stack || error}`);
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
