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
const reopenCycles = Math.max(1, Number.parseInt(process.env.VCPCHAT_SETTINGS_REOPEN_CYCLES || '3', 10) || 3);
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

    // Typed Settings consumer owns the avatar preview projection while the
    // upload/save capability remains in the legacy business command owner.
    const avatarProbe = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    await page.evaluate((avatarUrl) => {
        window.dispatchEvent(new CustomEvent('global-settings-updated', {
            detail: { settings: { userAvatarUrl: avatarUrl }, source: 'settings-avatar-probe' },
        }));
    }, avatarProbe);
    await page.waitForFunction((avatarUrl) => {
        const preview = document.getElementById('userAvatarPreview');
        return preview?.src === avatarUrl && preview.style.display === 'block';
    }, { timeout: timeoutMs }, avatarProbe);
    await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('global-settings-updated', {
            detail: { settings: { userAvatarUrl: '' }, source: 'settings-avatar-probe-clear' },
        }));
    });
    await page.waitForFunction(() => document.getElementById('userAvatarPreview')?.style.display === 'none', { timeout: timeoutMs });
    console.log('  [PASS] 1c. typed avatar preview projection and clear');

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
    assert.ok(visibleGeometry.some(item => item.selector === '.vcp-harness-select-trigger' && ((item.height === '36px' && item.borderRadius === '18px') || (item.minHeight === '40px' && item.borderRadius === '10px')) && item.fontSize === '14px' && item.lineHeight === '22px'), 'visible select geometry matches Harness trigger contract');
    assert.ok(shellState.computedGeometry.some(item => item.selector === '.vcp-harness-input-wrap' && item.borderRadius === '8px'), 'Input wrapper geometry matches Harness contract');
    console.log(`  [INFO] visible control geometry ${JSON.stringify(visibleGeometry)}`);
    const typedPrimitiveEvidence = await page.evaluate(() => {
        const select = document.getElementById('appearanceDensity');
        const root = select?.closest('.vcp-harness-field');
        const trigger = root?.querySelector('.vcp-harness-select-trigger');
        trigger?.click();
        const menu = trigger?.getAttribute('aria-controls') ? document.getElementById(trigger.getAttribute('aria-controls')) : null;
        const item = menu?.querySelector('[role="menuitem"]');
        const style = item ? getComputedStyle(item) : null;
        return {
            field: Boolean(root?.classList.contains('vcp-harness-field')),
            legacyWrap: Boolean(select?.closest('.vcp-harness-select-wrap')),
            trigger: Boolean(trigger?.matches('button[aria-haspopup="menu"]')),
            menu: Boolean(menu?.matches('.vcp-harness-menu-list[role="menu"]')),
            item: Boolean(item?.matches('button[role="menuitem"]')),
            itemGeometry: style && { minHeight: style.minHeight, padding: style.padding, borderRadius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight },
        };
    });
    assert.equal(typedPrimitiveEvidence.field, true, 'typed Field owns appearance density root');
    assert.equal(typedPrimitiveEvidence.legacyWrap, false, 'typed Select has no legacy presentation wrapper');
    assert.equal(typedPrimitiveEvidence.trigger, true, 'typed Select exposes Harness trigger contract');
    assert.equal(typedPrimitiveEvidence.menu, true, 'typed Select exposes Light-DOM menu contract');
    assert.equal(typedPrimitiveEvidence.item, true, 'typed Select exposes menuitem contract');
    assert.deepEqual(typedPrimitiveEvidence.itemGeometry, { minHeight: '40px', padding: '8px 10px', borderRadius: '10px', fontSize: '14px', lineHeight: '22px' }, 'typed Select menu item geometry matches reference pack');
    await page.evaluate(() => document.querySelector('#appearanceDensity')?.closest('.vcp-harness-field')?.querySelector('.vcp-harness-select-trigger')?.click());
    console.log(`  [PASS] 1d. typed Field/Select DOM and geometry contract ${JSON.stringify(typedPrimitiveEvidence)}`);
    assert.equal(await page.$eval('#appearanceRadius', node => Boolean(node.closest('.vcp-harness-field')?.querySelector('.vcp-harness-select-trigger'))), true, 'typed radius Select is mounted as the second vertical slice');
    assert.equal(await page.$eval('#appearanceRadius', node => Boolean(node.closest('.vcp-harness-select-wrap'))), false, 'typed radius legacy Select wrapper is deleted');
    for (const id of ['appearanceTypography', 'appearanceFontScale', 'appearanceContentWidth', 'appearanceSurface']) {
        assert.equal(await page.$eval(`#${id}`, node => Boolean(node.closest('.vcp-harness-field')?.querySelector('.vcp-harness-select-trigger'))), true, `typed ${id} Select is mounted`);
        assert.equal(await page.$eval(`#${id}`, node => Boolean(node.closest('.vcp-harness-select-wrap'))), false, `typed ${id} legacy Select wrapper is deleted`);
    }
    assert.equal(await page.$eval('#homeVisualTagline', node => node.parentElement?.classList.contains('vcp-uiux-input-wrap')), true, 'typed Home tagline Input is mounted');
    assert.equal(await page.$eval('#userAvatarBorderColor', node => node.parentElement?.classList.contains('vcp-uiux-color-pair')), true, 'typed avatar color pair is mounted');
    assert.equal(await page.$eval('#userAvatarBorderColorText', node => node.value === node.previousElementSibling?.value), true, 'avatar color mirror follows native source');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('global-settings-updated', { detail: { settings: { userAvatarBorderColor: '#112233' }, source: 'avatar-color-snapshot-probe' } })));
    await page.waitForFunction(() => document.getElementById('userAvatarBorderColor')?.value === '#112233' && document.getElementById('userAvatarBorderColorText')?.value === '#112233', { timeout: timeoutMs });
    assert.equal(await page.$eval('#appearanceSidebarAvatarSize', node => node.parentElement?.classList.contains('vcp-uiux-range')), true, 'typed avatar Range is mounted');
    for (const id of ['appearanceSidebarRowHeight', 'appearanceCustomRadius']) {
        assert.equal(await page.$eval(`#${id}`, node => node.parentElement?.classList.contains('vcp-uiux-range')), true, `typed ${id} Range is mounted`);
    }
    for (const id of ['showHomeVisualBrand', 'showHomeVisualTagline']) {
        assert.equal(await page.$eval(`#${id}`, node => node.parentElement?.classList.contains('vcp-uiux-toggle')), true, `typed ${id} Toggle is mounted`);
    }
    const choiceEvidence = await page.evaluate(() => {
        const group = document.querySelector('.appearance-radius-choice-grid');
        const options = [...(group?.querySelectorAll('label') || [])];
        const checked = options.find(label => label.querySelector('input')?.checked);
        const before = checked?.querySelector('input')?.value || null;
        const target = options.find(label => label.querySelector('input')?.value === 'square');
        target?.querySelector('input')?.click();
        return { mounted: group?.classList.contains('vcp-uiux-choice'), options: options.length, before, after: target?.querySelector('input')?.checked ? 'square' : null, optionClass: target?.classList.contains('vcp-uiux-choice-option') };
    });
    assert.equal(choiceEvidence.mounted, true, 'typed Choice owns sidebar radius group');
    assert.ok(choiceEvidence.options >= 4, 'sidebar radius Choice exposes all native options');
    assert.equal(choiceEvidence.after, 'square', 'Choice click updates native selected source');
    assert.equal(choiceEvidence.optionClass, true, 'Choice options expose Harness presentation class');
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
    assert.equal(controlState.nativeSources, controlState.longSelects.length + 6, 'native select remains the sole source for long controls and typed vertical slices');
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
    await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('global-settings-updated', {
            detail: { settings: {
                userName: 'typed-external-user',
                assistantAgent: 'agent-b',
                userAvatarBorderColor: '#123456',
                userNameTextColor: '#abcdef',
                userUseThemeColorsInChat: true,
                continueWritingPrompt: 'typed-external-prompt',
                networkNotesPaths: ['typed-nas', '/typed/notes'],
                vcpServerUrl: 'http://typed-external:6005',
                vcpApiKey: 'typed-api-key',
                fileKey: 'typed-file-key',
                vcpLogUrl: 'ws://typed-log:6006',
                vcpLogKey: 'typed-log-key',
                voiceMode: 'network',
                speechRecognizerBrowserPath: '/typed/chrome',
                speechRecognizerPagePath: '/typed/recognizer.html',
                voiceLocalSettings: { sovitsUrl: 'http://typed-local:9880', sovitsKey: 'typed-local-key' },
                voiceNetworkSettings: { providerUrl: 'https://typed-voice.example/api', providerKey: 'typed-network-key' },
                enableDistributedServer: true,
                agentMusicControl: true,
                enableVcpToolInjection: true,
                enableThoughtChainInjection: true,
                enableContextSanitizer: true,
                contextSanitizerDepth: 7,
                enableAiMessageButtons: false,
                flowlockContinueDelay: 12,
                enableMiddleClickQuickAction: true,
                middleClickQuickAction: 'edit',
                enableMiddleClickAdvanced: true,
                middleClickAdvancedDelay: 1800,
                enableRegenerateConfirmation: false,
                chatPresentationMode: 'panel',
                enableWideChatLayout: true,
                enableUserChatBubbleUi: true,
                showUserMetaInChatBubbleUi: false,
                chatBubbleMaxWidthWideDefault: 88,
                chatBubbleMaxWidthWideNotifications: 94,
                chatBubbleMaxWidthWideNarrow: 90,
                minChunkBufferSize: 24,
                smoothStreamIntervalMs: 140,
                chatFontPreset: 'serif',
                appearanceProfile: {
                    density: 'compact',
                    radius: 'round',
                    typography: 'humanist',
                    fontScale: 'large',
                    contentWidth: 'centered',
                    surface: 'custom',
                    sidebarRowHeight: 52,
                    sidebarAvatarSize: 36,
                    sidebarRadius: 'round',
                    customRadius: 14,
                },
                enableSmoothStreaming: false,
            }, source: 'external-test' }
        }));
    });
    await page.waitForFunction(() => document.getElementById('userName')?.value === 'typed-external-user');
    assert.equal(await page.$eval('#assistantAgent', node => node.value), 'agent-b', 'dynamic assistant select consumes typed Settings snapshot');
    assert.equal(await page.$eval('#userAvatarBorderColor', node => node.value), '#123456', 'clean avatar border color consumes typed Settings snapshot');
    assert.equal(await page.$eval('#userAvatarBorderColorText', node => node.value), '#123456', 'clean avatar border color mirror consumes typed Settings snapshot');
    assert.equal(await page.$eval('#userNameTextColor', node => node.value), '#abcdef', 'clean name color consumes typed Settings snapshot');
    assert.equal(await page.$eval('#userNameTextColorText', node => node.value), '#abcdef', 'clean name color mirror consumes typed Settings snapshot');
    assert.deepEqual(await page.$$eval('#networkNotesPathsContainer input[name="networkNotesPath"]', nodes => nodes.map(node => node.value)), ['typed-nas', '/typed/notes'], 'clean network notes list consumes typed Settings snapshot');
    await page.$eval('#addNetworkPathBtn', button => button.click());
    assert.equal(await page.$$eval('#networkNotesPathsContainer input[name="networkNotesPath"]', nodes => nodes.length), 3, 'typed network path consumer owns Add row creation');
    await page.$$eval('#networkNotesPathsContainer .network-path-input-group:last-child button', buttons => buttons[0]?.click());
    assert.equal(await page.$$eval('#networkNotesPathsContainer input[name="networkNotesPath"]', nodes => nodes.length), 2, 'typed network path consumer owns Remove row teardown');
    assert.equal(await page.$eval('#continueWritingPrompt', node => node.value), 'typed-external-prompt', 'clean form consumes typed Settings snapshot');
    assert.equal(await page.$eval('#vcpServerUrl', node => node.value), 'http://typed-external:6005', 'clean text control consumes typed Settings snapshot');
    assert.equal(await page.$eval('#vcpApiKey', node => node.value), 'typed-api-key', 'clean API key control consumes typed Settings snapshot');
    assert.equal(await page.$eval('#fileKey', node => node.value), 'typed-file-key', 'clean file key control consumes typed Settings snapshot');
    assert.equal(await page.$eval('#vcpLogUrl', node => node.value), 'ws://typed-log:6006', 'clean VCPLog URL consumes typed Settings snapshot');
    assert.equal(await page.$eval('#vcpLogKey', node => node.value), 'typed-log-key', 'clean VCPLog key consumes typed Settings snapshot');
    assert.equal(await page.$eval('#voiceModeNetwork', node => node.checked), true, 'clean voice mode consumes typed Settings snapshot');
    assert.equal(await page.$eval('#voiceModeLocal', node => node.checked), false, 'clean local voice mode consumes typed Settings snapshot');
    assert.equal(await page.$eval('#speechRecognizerBrowserPath', node => node.value), '/typed/chrome', 'clean STT browser path consumes typed Settings snapshot');
    assert.equal(await page.$eval('#speechRecognizerPagePath', node => node.value), '/typed/recognizer.html', 'clean STT page path consumes typed Settings snapshot');
    assert.equal(await page.$eval('#voiceLocalSovitsUrl', node => node.value), 'http://typed-local:9880', 'clean local voice URL consumes typed Settings snapshot');
    assert.equal(await page.$eval('#voiceLocalSovitsKey', node => node.value), 'typed-local-key', 'clean local voice key consumes typed Settings snapshot');
    assert.equal(await page.$eval('#voiceNetworkProviderUrl', node => node.value), 'https://typed-voice.example/api', 'clean network voice URL consumes typed Settings snapshot');
    assert.equal(await page.$eval('#voiceNetworkProviderKey', node => node.value), 'typed-network-key', 'clean network voice key consumes typed Settings snapshot');
    assert.equal(await page.$eval('#enableDistributedServer', node => node.checked), true, 'clean distributed server checkbox consumes typed Settings snapshot');
    assert.equal(await page.$eval('#agentMusicControl', node => node.checked), true, 'clean music control checkbox consumes typed Settings snapshot');
    assert.equal(await page.$eval('#enableVcpToolInjection', node => node.checked), true, 'clean tool injection checkbox consumes typed Settings snapshot');
    assert.equal(await page.$eval('#enableThoughtChainInjection', node => node.checked), true, 'clean thought-chain checkbox consumes typed Settings snapshot');
    assert.equal(await page.$eval('#enableContextSanitizer', node => node.checked), true, 'clean context sanitizer checkbox consumes typed Settings snapshot');
    assert.equal(await page.$eval('#contextSanitizerDepth', node => node.value), '7', 'clean sanitizer depth consumes typed Settings snapshot');
    assert.equal(await page.$eval('#contextSanitizerDepthContainer', node => getComputedStyle(node).display), 'block', 'sanitizer depth visibility follows typed snapshot');
    assert.equal(await page.$eval('#enableAiMessageButtons', node => node.checked), false, 'clean AI buttons checkbox consumes typed Settings snapshot');
    assert.equal(await page.$eval('#flowlockContinueDelay', node => node.value), '12', 'clean flowlock delay consumes typed Settings snapshot');
    assert.equal(await page.$eval('#enableMiddleClickQuickAction', node => node.checked), true, 'clean middle-click checkbox consumes typed Settings snapshot');
    assert.equal(await page.$eval('#middleClickQuickAction', node => node.value), 'edit', 'clean middle-click action consumes typed Settings snapshot');
    assert.equal(await page.$eval('#middleClickQuickActionContainer', node => getComputedStyle(node).display), 'block', 'middle-click action visibility follows typed snapshot');
    assert.equal(await page.$eval('#enableMiddleClickAdvanced', node => node.checked), true, 'clean advanced middle-click checkbox consumes typed Settings snapshot');
    assert.equal(await page.$eval('#middleClickAdvancedDelay', node => node.value), '1800', 'clean advanced middle-click delay consumes typed Settings snapshot');
    assert.equal(await page.$eval('#middleClickAdvancedSettings', node => getComputedStyle(node).display), 'block', 'advanced middle-click visibility follows typed snapshot');
    assert.equal(await page.$eval('#enableRegenerateConfirmation', node => node.checked), false, 'clean regenerate confirmation consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatPresentationModePanel', node => node.checked), true, 'clean presentation mode consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatLayoutModeWide', node => node.checked), true, 'clean wide layout consumes typed Settings snapshot');
    assert.equal(await page.$eval('#enableUserChatBubbleUi', node => node.checked), true, 'clean user bubble toggle consumes typed Settings snapshot');
    assert.equal(await page.$eval('#showUserMetaInChatBubbleUi', node => node.checked), false, 'clean user metadata toggle consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatBubbleMaxWidthWideDefault', node => node.value), '88', 'clean wide bubble width consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatBubbleMaxWidthWideNotifications', node => node.value), '94', 'clean wide notification width consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatBubbleMaxWidthWideNarrow', node => node.value), '90', 'clean wide narrow width consumes typed Settings snapshot');
    assert.equal(await page.$eval('#minChunkBufferSize', node => node.value), '24', 'clean chunk buffer consumes typed Settings snapshot');
    assert.equal(await page.$eval('#smoothStreamIntervalMs', node => node.value), '140', 'clean stream interval consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatFontPreset', node => node.value), 'serif', 'clean select control consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceDensity', node => node.value), 'compact', 'clean appearance density consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceRadius', node => node.value), 'round', 'clean appearance radius consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceSidebarRadiusChoice-round', node => node.checked), true, 'clean sidebar radius Choice consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceTypography', node => node.value), 'humanist', 'clean appearance typography consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceFontScale', node => node.value), 'large', 'clean appearance scale consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceContentWidth', node => node.value), 'centered', 'clean appearance width consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceSurface', node => node.value), 'custom', 'clean appearance surface consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceSidebarRowHeight', node => node.value), '52', 'clean sidebar row height consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceSidebarAvatarSize', node => node.value), '36', 'clean sidebar avatar size consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceSidebarRowHeightValue', node => node.value), '52px', 'clean row-height output consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceSidebarAvatarSizeValue', node => node.value), '36px', 'clean avatar-size output consumes typed Settings snapshot');
    assert.equal(await page.$eval('#showHomeVisualBrand', node => node.checked), true, 'clean Home brand toggle consumes typed Settings snapshot');
    assert.equal(await page.$eval('#showHomeVisualTagline', node => node.checked), true, 'clean Home tagline toggle consumes typed Settings snapshot');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('global-settings-updated', { detail: { settings: { showHomeVisualBrand: false, showHomeVisualTagline: false }, source: 'toggle-snapshot-probe' } })));
    await page.waitForFunction(() => document.getElementById('showHomeVisualBrand')?.checked === false && document.getElementById('showHomeVisualTagline')?.checked === false, { timeout: timeoutMs });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('global-settings-updated', { detail: { settings: { showHomeVisualBrand: true, showHomeVisualTagline: true }, source: 'toggle-snapshot-restore' } })));
    await page.waitForFunction(() => document.getElementById('showHomeVisualBrand')?.checked === true && document.getElementById('showHomeVisualTagline')?.checked === true, { timeout: timeoutMs });
    assert.equal(await page.$eval('#appearanceCustomRadius', node => node.value), '14', 'clean custom radius consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceCustomRadiusValue', node => node.value), '14px', 'clean custom-radius output consumes typed Settings snapshot');
    assert.equal(await page.$eval('#appearanceSidebarRadiusChoice-round', node => node.checked), true, 'clean radius choice consumes typed Settings snapshot');
    assert.equal(await page.$eval('#enableSmoothStreaming', node => node.checked), false, 'clean checkbox consumes typed Settings snapshot');
    const rustConsumerState = await page.evaluate(() => {
        const service = window.VCPUISettingsBridge?.getRustAssistantService?.();
        return {
            available: Boolean(service?.state?.get),
            debugMode: service?.state?.get()?.debugMode,
            controlDebugMode: document.getElementById('rustDebugMode')?.checked,
        };
    });
    assert.equal(rustConsumerState.available, true, 'Rust Assistant UI service is assembled in the production bridge');
    assert.equal(rustConsumerState.controlDebugMode, rustConsumerState.debugMode === true, 'Rust control consumes the typed Rust snapshot');
    const forumConsumerState = await page.evaluate(() => {
        const service = window.VCPUISettingsBridge?.getForumConfigService?.();
        return {
            available: Boolean(service?.state?.get),
            username: service?.state?.get()?.username ?? '',
            controlUsername: document.getElementById('adminUsername')?.value ?? '',
            usernameInputPrimitive: Boolean(document.getElementById('adminUsername')?.closest('.vcp-uiux-input-wrap')),
            passwordInputPrimitive: Boolean(document.getElementById('adminPassword')?.closest('.vcp-uiux-input-wrap')),
        };
    });
    assert.equal(forumConsumerState.available, true, 'Forum config UI service is assembled in the production bridge');
    assert.equal(forumConsumerState.controlUsername, forumConsumerState.username, 'Forum admin control consumes the typed forum snapshot');
    assert.equal(forumConsumerState.usernameInputPrimitive, true, 'Forum username uses the typed Light-DOM Input primitive');
    assert.equal(forumConsumerState.passwordInputPrimitive, true, 'Forum password uses the typed Light-DOM Input primitive');
    // Forum fields own their draft/autosave seam: typing there must not
    // schedule the legacy whole-form settings submit, and the save must go
    // through the typed forum service instead.
    const forumSeamState = await page.evaluate(async () => {
        const form = document.getElementById('globalSettingsForm');
        const input = document.getElementById('adminUsername');
        const previousValue = input.value;
        let legacySubmitCalls = 0;
        let forumServiceCalls = 0;
        const originalRequestSubmit = typeof form.requestSubmit === 'function' ? form.requestSubmit.bind(form) : null;
        try { form.requestSubmit = (...args) => { legacySubmitCalls += 1; return originalRequestSubmit?.(...args); }; } catch { /* readonly */ }
        const service = window.VCPUISettingsBridge?.getForumConfigService?.();
        let releaseExecute = () => {};
        if (service?.save?.execute) {
            const originalExecute = service.save.execute.bind(service.save);
            service.save.execute = async patch => {
                forumServiceCalls += 1;
                return originalExecute(patch);
            };
            releaseExecute = () => { service.save.execute = originalExecute; };
        }
        try {
            input.value = `${previousValue}A`.slice(0, 40);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            // Outlast both 400ms debounce chains so whichever path ran shows up.
            await new Promise(resolve => setTimeout(resolve, 900));
        } finally {
            releaseExecute();
            if (originalRequestSubmit) form.requestSubmit = originalRequestSubmit;
            input.value = previousValue;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 900));
        }
        return { legacySubmitCalls, forumServiceCalls };
    });
    assert.equal(forumSeamState.legacySubmitCalls, 0, `typing in forum fields never triggers the legacy whole-form settings submit (${JSON.stringify(forumSeamState)})`);
    assert.equal(forumSeamState.forumServiceCalls >= 1, true, `typing in forum fields saves through the typed forum service (${JSON.stringify(forumSeamState)})`);
    const runtimeConsumerState = await page.evaluate(() => {
        const service = window.VCPUISettingsBridge?.getAssistantRuntimeService?.();
        return {
            available: Boolean(service?.state?.get),
            mode: service?.state?.get()?.mode,
            renderedMode: document.getElementById('assistantRuntimeMode')?.textContent,
        };
    });
    assert.equal(runtimeConsumerState.available, true, 'Assistant runtime UI service is assembled in the production bridge');
    if (runtimeConsumerState.mode) {
        const expected = runtimeConsumerState.mode === 'rust' ? 'Rust' : (runtimeConsumerState.mode === 'disabled' ? 'Disabled' : runtimeConsumerState.mode);
        assert.equal(runtimeConsumerState.renderedMode, expected, 'runtime diagnostics consume the typed runtime snapshot');
    }
    // Force the real IPC persistence path to fail once by removing write
    // access from the isolated test profile, then restore it for retry.
    await fs.chmod(path.join(appData, 'settings.json'), 0o444);
    await fs.chmod(appData, 0o500);
    await page.evaluate((value) => {
        const textarea = document.getElementById('continueWritingPrompt');
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }, uniquePrompt);
    await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('global-settings-updated', {
            detail: { settings: { userName: 'late-external-user', continueWritingPrompt: 'late-external-prompt' }, source: 'external-during-dirty' }
        }));
    });
    assert.equal(await page.$eval('#continueWritingPrompt', node => node.value), uniquePrompt, 'dirty form rejects external snapshot overwrite');
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

    // ---- 6b. Per-field close flush: edit each field then close immediately,
    // bypassing the 400ms debounce, so only the modal-visibility flush can
    // commit the drafts. ----
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 250));
    const flushValues = {
        rowHeight: '53',
        avatarSize: '33',
        customRadius: '17',
        radiusChoice: 'small',
        tagline: `close-flush-tagline-${Date.now()}`,
        forumUser: `flush-user-${Date.now()}`,
    };
    await page.evaluate((values) => {
        const set = (id, value) => {
            const node = document.getElementById(id);
            node.value = value;
            node.dispatchEvent(new Event('input', { bubbles: true }));
        };
        // Navigate to the appearance category so all target nodes exist as they
        // do for real users; every typed control keeps its canonical id.
        set('appearanceSidebarRowHeight', values.rowHeight);
        set('appearanceSidebarAvatarSize', values.avatarSize);
        set('appearanceCustomRadius', values.customRadius);
        set('homeVisualTagline', values.tagline);
        const choice = document.getElementById(`appearanceSidebarRadiusChoice-${values.radiusChoice}`);
        choice.checked = true;
        choice.dispatchEvent(new Event('change', { bubbles: true }));
        set('adminUsername', values.forumUser);
    }, flushValues);
    const dirtyAtClose = await page.evaluate(() => {
        const form = document.getElementById('globalSettingsForm');
        return {
            dirty: form.dataset.vcpSettingsDirty === 'true',
            fieldOwnerMounted: form.dataset.vcpTypedFieldOwnerMounted === 'true',
            forumOwnerMounted: form.dataset.vcpTypedForumFieldOwnerMounted === 'true',
            // Geometry linkage rewrites range drafts; capture the final DOM
            // values so the assertion compares the true on-screen draft.
            rowHeight: document.getElementById('appearanceSidebarRowHeight')?.value,
            avatarSize: document.getElementById('appearanceSidebarAvatarSize')?.value,
            customRadius: document.getElementById('appearanceCustomRadius')?.value,
        };
    });
    assert.equal(dirtyAtClose.dirty, true, `typed drafts mark the form dirty before close (${JSON.stringify(dirtyAtClose)})`);
    assert.equal(dirtyAtClose.fieldOwnerMounted && dirtyAtClose.forumOwnerMounted, true, `both typed owners are mounted (${JSON.stringify(dirtyAtClose)})`);
    const expectedFlush = {
        rowHeight: dirtyAtClose.rowHeight,
        avatarSize: dirtyAtClose.avatarSize,
        customRadius: dirtyAtClose.customRadius,
    };
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    const flushDeadline = Date.now() + timeoutMs;
    let flushedSnapshot = null;
    while (Date.now() < flushDeadline) {
        flushedSnapshot = await page.evaluate(() => {
            const settingsService = window.VCPUISettingsBridge?.getTypedService?.();
            const forumService = window.VCPUISettingsBridge?.getForumConfigService?.();
            const profile = settingsService?.state?.get?.()?.appearanceProfile || {};
            return {
                sidebarRowHeight: profile.sidebarRowHeight,
                sidebarAvatarSize: profile.sidebarAvatarSize,
                customRadius: profile.customRadius,
                sidebarRadius: profile.sidebarRadius,
                homeVisualTagline: settingsService?.state?.get?.()?.homeVisualTagline || '',
                forumUsername: String(forumService?.state?.get?.()?.username ?? ''),
            };
        });
        if (
            String(flushedSnapshot.sidebarRowHeight) === expectedFlush.rowHeight
            && Number(flushedSnapshot.customRadius) === Number(expectedFlush.customRadius)
            && flushedSnapshot.homeVisualTagline.startsWith('close-flush-tagline-')
            && flushedSnapshot.forumUsername === flushValues.forumUser
        ) break;
        await sleep(250);
    }
    assert.equal(String(flushedSnapshot.sidebarRowHeight), expectedFlush.rowHeight, `close flush committed the on-screen row-height draft (${JSON.stringify({ flushedSnapshot, expectedFlush })})`);
    assert.equal(String(flushedSnapshot.sidebarAvatarSize), expectedFlush.avatarSize, `close flush committed the on-screen avatar-size draft (${JSON.stringify({ flushedSnapshot, expectedFlush })})`);
    assert.equal(Number(flushedSnapshot.customRadius), Number(expectedFlush.customRadius), `close flush committed the on-screen custom-radius draft (${JSON.stringify({ flushedSnapshot, expectedFlush })})`);
    assert.equal(flushedSnapshot.sidebarRadius, 'small', `close flush committed radius choice draft (${JSON.stringify(flushedSnapshot)})`);
    assert.ok(flushedSnapshot.homeVisualTagline.startsWith('close-flush-tagline-'), `close flush committed home tagline draft (${JSON.stringify(flushedSnapshot)})`);
    assert.equal(flushedSnapshot.forumUsername, flushValues.forumUser, `close flush committed forum username draft via ForumConfigUiService (${JSON.stringify(flushedSnapshot)})`);
    console.log('  [PASS] 6b. close flush commits per-field typed drafts (settings fields + forum credentials)');

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

    // ---- 8b. Repeated close/reopen must not duplicate owners or rows ----
    const reopenLedgers = [];
    for (let cycle = 0; cycle < reopenCycles; cycle += 1) {
        await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
        await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
        await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
        await page.waitForFunction(() => document.querySelector('#globalSettingsModal.vcp-harness-settings-root'), { timeout: timeoutMs });
        await sleep(120);
        reopenLedgers.push(await page.evaluate(() => ({
            scopeLabels: window.VCPLifecycle?.diagnostics?.snapshot?.().map(scope => scope.label) || [],
            pathCount: document.querySelectorAll('#networkNotesPathsContainer input[name="networkNotesPath"]').length,
            typedServices: [
                window.VCPUISettingsBridge?.getTypedService?.(),
                window.VCPUISettingsBridge?.getRustAssistantService?.(),
                window.VCPUISettingsBridge?.getForumConfigService?.(),
                window.VCPUISettingsBridge?.getAssistantRuntimeService?.(),
            ].filter(Boolean).length,
        })));
    }
    reopenLedgers.forEach((ledger, index) => {
        assert.equal(ledger.scopeLabels.filter(label => String(label).includes('settings-presentation')).length, 1, `reopen ${index + 1} has one presentation scope`);
        assert.equal(ledger.scopeLabels.filter(label => String(label).includes('ui-services')).length, 1, `reopen ${index + 1} has one typed service scope`);
        assert.equal(ledger.pathCount, 2, `reopen ${index + 1} keeps one row per network path`);
        assert.equal(ledger.typedServices, 4, `reopen ${index + 1} retains all typed services`);
    });
    console.log(`  [PASS] 8b. repeated reopen (${reopenCycles} cycles) has stable owner/service/list ledgers`);

    // ---- 9. Explicit renderer teardown retracts the Settings owner ledger ----
    const teardownLedger = await page.evaluate(async () => {
        const rust = window.VCPUISettingsBridge?.getRustAssistantService?.();
        const forum = window.VCPUISettingsBridge?.getForumConfigService?.();
        const runtime = window.VCPUISettingsBridge?.getAssistantRuntimeService?.();
        await window.VCPUISettingsBridge?.destroy?.();
        const latePathResult = window.VCPUISettingsBridge?.addNetworkPathInput?.('late') ?? false;
        const [rustResult, forumResult, runtimeResult] = await Promise.all([
            rust?.save?.execute?.({ debugMode: false }),
            forum?.save?.execute?.({ username: 'late' }),
            runtime?.refresh?.execute?.(),
        ]);
        return {
            scopes: window.VCPLifecycle?.diagnostics?.snapshot?.() || [],
            typedRevision: document.getElementById('globalSettingsModal')?.dataset.vcpSettingsRevision || null,
            latePathResult,
            rustResult,
            forumResult,
            runtimeResult,
        };
    });
    assert.equal(teardownLedger.scopes.some(scope => String(scope.label).includes('settings-bridge')), false, `settings bridge scope disposed: ${JSON.stringify(teardownLedger.scopes)}`);
    assert.equal(teardownLedger.scopes.some(scope => String(scope.label).includes('settings-presentation')), false, `settings presentation scope disposed: ${JSON.stringify(teardownLedger.scopes)}`);
    assert.equal(teardownLedger.scopes.some(scope => String(scope.label).includes('ui-services')), false, `typed service scope disposed: ${JSON.stringify(teardownLedger.scopes)}`);
    assert.equal(teardownLedger.typedRevision, null, 'typed Settings readiness marker retracts with the consumer');
    assert.equal(teardownLedger.latePathResult, false, 'disposed Settings bridge rejects late network path commands');
    assert.equal(teardownLedger.rustResult?.success, false, 'disposed Rust service rejects late command');
    assert.equal(teardownLedger.forumResult?.success, false, 'disposed Forum service rejects late command');
    assert.equal(teardownLedger.runtimeResult?.success, false, 'disposed runtime service rejects late refresh');
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
