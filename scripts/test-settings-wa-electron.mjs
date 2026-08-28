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
    // Own the process group so a timeout cannot leave helper children behind.
    detached: process.platform !== 'win32',
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

    // ---- 1p (retirement contract). First-open ordering: the modal is
    // template-instantiated by the first openModal, and `modal-ready` fires
    // synchronously inside that task - before the bridge's MutationObserver
    // microtask can mount the typed consumer and stamp the revision.  The
    // startup fallback projection is retired, so at modal-ready the form
    // still shows its HTML defaults; the typed service's subscribe replay
    // fills it within the same open cycle and stamps the revision. ----
    await page.evaluate(() => {
        window.__e3FirstOpenProbe = null;
        document.addEventListener('modal-ready', event => {
            if (event.detail?.modalId !== 'globalSettingsModal') return;
            const modal = document.getElementById('globalSettingsModal');
            window.__e3FirstOpenProbe = {
                revisionAtReady: modal?.dataset?.vcpSettingsRevision ?? null,
                formAtReady: Boolean(document.getElementById('globalSettingsForm')),
                userNameAtReady: document.getElementById('userName')?.value ?? null,
            };
        }, { once: true });
    });
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    const e3FirstOpen = await page.evaluate(() => window.__e3FirstOpenProbe);
    assert.equal(e3FirstOpen.formAtReady, true, `E3: the form exists at modal-ready (${JSON.stringify(e3FirstOpen)})`);
    assert.equal(e3FirstOpen.revisionAtReady, null, `E3: typed readiness is absent at modal-ready (${JSON.stringify(e3FirstOpen)})`);
    assert.equal(String(e3FirstOpen.userNameAtReady ?? ''), '', `E3: the retired fallback no longer fills at modal-ready - HTML defaults show (${JSON.stringify(e3FirstOpen)})`);
    await page.waitForFunction(() => {
        const revision = document.getElementById('globalSettingsModal')?.dataset?.vcpSettingsRevision;
        return Boolean(document.getElementById('globalSettingsForm')
            && window.VCPUISettingsBridge?.getTypedService?.()
            && Number.isInteger(Number(revision)));
    }, { timeout: timeoutMs });
    console.log('  [PASS] 1p. the typed subscribe replay owns the modal-ready window (form fills and revision stamps in the same open cycle)');

    // ---- 1. SettingsShell layout ----
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
                    pick('.vcp-uiux-input-wrap'),
                    pick('.vcp-harness-select-trigger'),
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

    // ---- 1q (retirement evidence E2). First-open parity: every control the
    // presentationOwner startup fallback would fill mirrors the typed
    // snapshot with the same defaulting, so deleting the fallback cannot
    // change the first-open outcome.  Mirrors the projection contracts in
    // settings-bridge (typed field owner defaults) and
    // mainChatSettingsPresentationOwner (fallback defaults) exactly.
    // vcpServerUrl is asserted against the raw snapshot deliberately: the
    // typed projection projects the stored URL verbatim (the fallback's
    // completeVcpUrl completion is a documented owner divergence, see
    // handoff E4 inventory).  userUseThemeColorsInChat has no control in
    // #globalSettingsForm and is excluded on both sides. ----
    const fallbackParity = await page.evaluate(() => {
        const s = window.VCPUISettingsBridge.getTypedService().state.get() || {};
        const val = (id) => { const el = document.getElementById(id); return el ? String(el.value) : null; };
        const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : null; };
        const clampWidth = (value, fallback) => {
            const parsed = Number.parseInt(value, 10);
            return Number.isFinite(parsed) ? Math.min(98, Math.max(50, parsed)) : fallback;
        };
        const modes = ['bubble', 'panel', 'immersive'];
        const mode = modes.includes(s.chatPresentationMode) ? s.chatPresentationMode : 'bubble';
        const presentationId = `chatPresentationMode${mode[0].toUpperCase()}${mode.slice(1)}`;
        const wide = s.enableWideChatLayout === true;
        const expected = {
            userName: s.userName || '用户',
            userAvatarBorderColor: s.userAvatarBorderColor || '#3d5a80',
            userAvatarBorderColorText: s.userAvatarBorderColor || '#3d5a80',
            userNameTextColor: s.userNameTextColor || '#ffffff',
            userNameTextColorText: s.userNameTextColor || '#ffffff',
            vcpServerUrl: String(s.vcpServerUrl ?? ''),
            vcpApiKey: s.vcpApiKey || '',
            fileKey: s.fileKey || '',
            vcpLogUrl: s.vcpLogUrl || '',
            vcpLogKey: s.vcpLogKey || '',
            topicSummaryModel: s.topicSummaryModel || '',
            continueWritingPrompt: s.continueWritingPrompt || '请继续',
            flowlockContinueDelay: s.flowlockContinueDelay ?? 5,
            speechRecognizerBrowserPath: s.speechRecognizerBrowserPath || '',
            // Owner-divergence note (handoff E4): these two display defaults
            // live in the renderer default-settings universe (renderer.js)
            // and reach the screen through the startup fallback fill; the
            // typed state stores raw persisted data where the keys may be
            // unset.  The oracle mirrors the actual first-open outcome.
            speechRecognizerPagePath: s.speechRecognizerPagePath || 'Voicechatmodules/recognizer.html',
            voiceLocalSovitsUrl: s.voiceLocalSettings?.sovitsUrl || '',
            voiceLocalSovitsKey: s.voiceLocalSettings?.sovitsKey || '',
            voiceNetworkProviderUrl: s.voiceNetworkSettings?.providerUrl || 'https://api.siliconflow.cn',
            voiceNetworkProviderKey: s.voiceNetworkSettings?.providerKey || '',
            enableSmoothStreaming: s.enableSmoothStreaming === true,
            voiceModeLocal: (s.voiceMode || 'local') !== 'network',
            voiceModeNetwork: (s.voiceMode || 'local') === 'network',
            [presentationId]: true,
            chatLayoutModeWide: wide,
            chatLayoutModeNormal: !wide,
            enableUserChatBubbleUi: s.enableUserChatBubbleUi !== false,
            showUserMetaInChatBubbleUi: s.showUserMetaInChatBubbleUi !== false,
            chatBubbleMaxWidthWideDefault: clampWidth(s.chatBubbleMaxWidthWideDefault, 92),
            chatBubbleMaxWidthWideNotifications: clampWidth(s.chatBubbleMaxWidthWideNotifications, 96),
            chatBubbleMaxWidthWideNarrow: clampWidth(s.chatBubbleMaxWidthWideNarrow, clampWidth(s.chatBubbleMaxWidthWideDefault, 92)),
            minChunkBufferSize: s.minChunkBufferSize ?? 16,
            smoothStreamIntervalMs: s.smoothStreamIntervalMs ?? 100,
            chatFontPreset: s.chatFontPreset || 'system',
            chatFontCustom: s.chatFontCustom || '',
            chatCodeFontPreset: s.chatCodeFontPreset || 'consolas',
            chatCodeFontCustom: s.chatCodeFontCustom || '',
            chatDiaryFontPreset: s.chatDiaryFontPreset || 'serif',
            chatDiaryFontCustom: s.chatDiaryFontCustom || '',
            chatToolFontPreset: s.chatToolFontPreset || 'system',
            chatToolFontCustom: s.chatToolFontCustom || '',
        };
        const mismatches = [];
        for (const [id, want] of Object.entries(expected)) {
            const got = typeof want === 'boolean' ? chk(id) : val(id);
            if (got === null) { mismatches.push({ id, want: String(want), got: null }); continue; }
            if (String(got) !== String(want)) mismatches.push({ id, want: String(want), got: String(got) });
        }
        const paths = [...document.querySelectorAll('#networkNotesPathsContainer input[name="networkNotesPath"]')]
            .map(node => node.value.trim()).filter(Boolean);
        const wantPaths = Array.isArray(s.networkNotesPaths) ? s.networkNotesPaths.map(String) : [];
        if (JSON.stringify(paths) !== JSON.stringify(wantPaths)) mismatches.push({ id: 'networkNotesPaths', want: wantPaths, got: paths });
        return { mismatches, checkedControls: Object.keys(expected).length };
    });
    assert.deepEqual(fallbackParity.mismatches, [], `first-open fill of every fallback-owned control mirrors the typed snapshot (${JSON.stringify(fallbackParity)})`);
    console.log(`  [PASS] 1q. first-open fill mirrors the typed snapshot across ${fallbackParity.checkedControls} fallback-owned controls + path rows`);

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
        return [probe('.vcp-harness-select-trigger'), probe('.vcp-harness-menu-item')].filter(Boolean);
    });
    assert.ok(visibleGeometry.some(item => item.selector === '.vcp-harness-select-trigger' && ((item.height === '36px' && item.borderRadius === '18px') || (item.minHeight === '40px' && item.borderRadius === '10px')) && item.fontSize === '14px' && item.lineHeight === '22px'), 'visible select geometry matches Harness trigger contract');
    assert.ok(shellState.computedGeometry.some(item => item.selector === '.vcp-uiux-input-wrap' && item.borderRadius === '8px'), 'Input primitive wrap geometry matches Harness contract');
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
    // ---- 1e. Body-level portal menus must stack above the settings overlay.
    // The generated select primitive appends its menu to document.body; a
    // hard-coded z-index below the modal overlay made every appearance
    // select open invisibly behind the modal (regression 2026-08-27).
    const portalStacking = await page.evaluate(async () => {
        const densityTrigger = document.querySelector('#appearanceDensity')?.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger');
        if (!densityTrigger) return { triggerFound: false };
        densityTrigger.scrollIntoView({ block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 150));
        densityTrigger.click();
        await new Promise(resolve => setTimeout(resolve, 250));
        const menu = document.body.querySelector(':scope > .vcp-uiux-primitive-menu');
        const evidence = {
            triggerFound: true,
            expanded: densityTrigger.getAttribute('aria-expanded'),
            menuFound: Boolean(menu),
            menuZ: menu ? getComputedStyle(menu).zIndex : null,
            menuHitInside: null,
        };
        if (menu && menu.getBoundingClientRect().height > 0) {
            const rect = menu.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(20, rect.height / 2));
            evidence.menuHitInside = hit ? menu.contains(hit) : false;
        }
        document.body.click();
        await new Promise(resolve => setTimeout(resolve, 150));
        return evidence;
    });
    assert.equal(portalStacking.triggerFound && portalStacking.expanded === 'true' && portalStacking.menuFound, true, `appearance select opens a body-level portal menu (${JSON.stringify(portalStacking)})`);
    assert.equal(Number(portalStacking.menuZ) > 1400, true, `portal menu z-index stacks above the settings overlay 1400 (got ${portalStacking.menuZ})`);
    assert.equal(portalStacking.menuHitInside, true, 'portal menu is the topmost hit-target at its own position (visible to pointer events)');
    console.log('  [PASS] 1e. portal menu stacks above the settings overlay (z-index + hit-test evidence)');
    // The library Select primitive mounted by the bridge for every non-typed
    // select (font presets, quick actions) also appends its menu to
    // document.body with the same hard-coded z-index; the stacking override
    // must cover it too.
    const harnessPortalStacking = await page.evaluate(async () => {
        const fontTrigger = document.querySelector('#chatFontPreset')?.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger');
        if (!fontTrigger) return { triggerFound: false };
        fontTrigger.scrollIntoView({ block: 'center' });
        await new Promise(resolve => setTimeout(resolve, 150));
        fontTrigger.click();
        await new Promise(resolve => setTimeout(resolve, 250));
        const menu = document.body.querySelector(':scope > .vcp-uiux-primitive-menu:not([hidden])');
        const evidence = {
            triggerFound: true,
            expanded: fontTrigger.getAttribute('aria-expanded'),
            menuFound: Boolean(menu),
            menuZ: menu ? getComputedStyle(menu).zIndex : null,
            menuHitInside: null,
            closedAfterPointerdown: null,
        };
        if (menu && menu.getBoundingClientRect().height > 0) {
            const rect = menu.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(20, rect.height / 2));
            evidence.menuHitInside = hit ? menu.contains(hit) : false;
        }
        // The harness select closes on a captured document pointerdown, not on
        // a plain click; a synthetic click alone leaves the portal open.
        document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 150));
        evidence.closedAfterPointerdown = !document.body.querySelector(':scope > .vcp-uiux-primitive-menu:not([hidden])');
        return evidence;
    });
    assert.equal(harnessPortalStacking.triggerFound && harnessPortalStacking.expanded === 'true' && harnessPortalStacking.menuFound, true, `harness font-preset select opens a body-level portal (${JSON.stringify(harnessPortalStacking)})`);
    assert.equal(Number(harnessPortalStacking.menuZ) > 1400, true, `harness portal z-index stacks above the settings overlay 1400 (got ${harnessPortalStacking.menuZ})`);
    assert.equal(harnessPortalStacking.menuHitInside, true, 'harness portal is the topmost hit-target at its own position');
    assert.equal(harnessPortalStacking.closedAfterPointerdown, true, 'harness portal closes on an outside pointerdown');
    console.log('  [PASS] 1e-2. harness select portal (font presets) stacks above the overlay and closes on outside pointerdown');
    assert.equal(await page.$eval('#appearanceRadius', node => Boolean(node.closest('.vcp-harness-field')?.querySelector('.vcp-harness-select-trigger'))), true, 'typed radius Select is mounted as the second vertical slice');
    assert.equal(await page.$eval('#appearanceRadius', node => Boolean(node.closest('.vcp-harness-select-wrap'))), false, 'typed radius legacy Select wrapper is deleted');
    for (const id of ['appearanceTypography', 'appearanceFontScale', 'appearanceContentWidth', 'appearanceSurface']) {
        assert.equal(await page.$eval(`#${id}`, node => Boolean(node.closest('.vcp-harness-field')?.querySelector('.vcp-harness-select-trigger'))), true, `typed ${id} Select is mounted`);
        assert.equal(await page.$eval(`#${id}`, node => Boolean(node.closest('.vcp-harness-select-wrap'))), false, `typed ${id} legacy Select wrapper is deleted`);
    }
    assert.equal(await page.$eval('#homeVisualTagline', node => node.parentElement?.classList.contains('vcp-uiux-input-wrap')), true, 'typed Home tagline Input is mounted');
    // Keep a field-level artifact for the Harness equivalence chain. This is
    // observational only: the native input remains the canonical business node.
    const taglineEvidence = await page.$eval('#homeVisualTagline', (input) => {
        const node = input.parentElement;
        const rect = (element) => {
            const value = element.getBoundingClientRect();
            return { x: value.x, y: value.y, width: value.width, height: value.height };
        };
        const style = (element) => {
            const value = getComputedStyle(element);
            return {
                display: value.display,
                padding: value.padding,
                gap: value.gap,
                height: value.height,
                borderRadius: value.borderRadius,
                fontSize: value.fontSize,
                fontWeight: value.fontWeight,
                lineHeight: value.lineHeight,
                color: value.color,
                backgroundColor: value.backgroundColor,
                borderColor: value.borderColor,
            };
        };
        return {
            source: 'VCP real Electron Settings consumer',
            viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
            fieldId: input.id,
            dom: node?.outerHTML || null,
            root: node ? { tag: node.tagName.toLowerCase(), class: node.className, rect: rect(node), style: style(node) } : null,
            input: { tag: input.tagName.toLowerCase(), class: input.className, rect: rect(input), style: style(input) },
            states: { disabled: input.disabled, placeholder: input.getAttribute('placeholder') || '', value: input.value },
        };
    });
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/vcp-home-tagline-input.json'), `${JSON.stringify(taglineEvidence, null, 2)}\n`, 'utf8');
    await page.$eval('#homeVisualTagline', (input) => input.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await page.$('#homeVisualTagline').then((handle) => handle?.screenshot({ path: path.join(root, 'reports/vcp-home-tagline-input.png') }));
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
    const voiceChoiceEvidence = await page.evaluate(() => {
        const local = document.getElementById('voiceModeLocal');
        const network = document.getElementById('voiceModeNetwork');
        const group = local?.closest('.vcp-settings-control-row');
        network?.click();
        return {
            mounted: group?.classList.contains('vcp-uiux-choice'),
            options: group?.querySelectorAll('.vcp-uiux-choice-option').length || 0,
            localChecked: local?.checked,
            networkChecked: network?.checked,
            value: group?.dataset.value || null,
            nativeParent: network?.closest('.vcp-settings-control-row') === group,
        };
    });
    assert.equal(voiceChoiceEvidence.mounted, true, 'global voice mode is owned by the generated Choice primitive');
    assert.equal(voiceChoiceEvidence.options, 2, 'voice Choice exposes both native radio options');
    assert.equal(voiceChoiceEvidence.networkChecked, true, 'voice Choice writes through to the native network radio');
    assert.equal(voiceChoiceEvidence.localChecked, false, 'voice Choice clears the native local radio');
    assert.equal(voiceChoiceEvidence.value, 'network', 'voice Choice mirrors the selected native value for presentation diagnostics');
    assert.equal(voiceChoiceEvidence.nativeParent, true, 'voice Choice preserves the original canonical radio group');
    await page.evaluate(() => document.querySelector('.vcp-harness-settings-nav-cell[data-section="user-identity"]')?.click());
    await page.waitForFunction(() => document.querySelector('#globalSettingsModal #section-user-identity.active'), { timeout: timeoutMs });

    // ---- 1b. Library select primitive adoption over every business select ----
    const controlState = await page.evaluate(() => ({
        primitiveSelects: [...document.querySelectorAll('#globalSettingsModal .vcp-harness-select select')].map(select => select.id),
        typedSelects: [...document.querySelectorAll('#globalSettingsModal .vcp-harness-field .vcp-harness-select select')].map(select => select.id),
        legacyChoiceRows: document.querySelectorAll('#globalSettingsModal .vcp-harness-choice-wrap').length,
        legacyWraps: document.querySelectorAll('#globalSettingsModal .vcp-harness-select-wrap').length,
        bareSelects: [...document.querySelectorAll('#globalSettingsModal select.vcp-settings-bare-select')].map(select => select.id),
        nativeSources: document.querySelectorAll('#globalSettingsModal select.vcp-harness-select-native').length,
        visibleSelectProjections: [...document.querySelectorAll('#globalSettingsModal .vcp-harness-select select')].filter(select => {
            const trigger = select.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger');
            return trigger && getComputedStyle(trigger).display !== 'none';
        }).length,
        legacyInputWraps: document.querySelectorAll('#globalSettingsModal .vcp-harness-input-wrap').length,
        primitiveInputs: document.querySelectorAll('#globalSettingsModal .vcp-uiux-input-wrap input').length,
        bareTextareas: [...document.querySelectorAll('#globalSettingsModal textarea')].filter(textarea => !textarea.closest('.vcp-uiux-input-wrap')).length,
        totalTextareas: document.querySelectorAll('#globalSettingsModal textarea').length,
        textareaMinHeight: (() => {
            const textarea = document.getElementById('continueWritingPrompt');
            return textarea ? getComputedStyle(textarea).minHeight : null;
        })(),
        switchInputs: document.querySelectorAll('#globalSettingsModal label.switch input[type="checkbox"]').length,
        primitiveToggles: [...document.querySelectorAll('#globalSettingsModal label.switch input[type="checkbox"]')]
            .filter(input => input.parentElement?.classList.contains('vcp-uiux-toggle')).length,
        visibleLegacySliders: [...document.querySelectorAll('#globalSettingsModal .slider')]
            .filter(slider => getComputedStyle(slider).display !== 'none').length,
    }));
    assert.ok(controlState.primitiveSelects.includes('chatFontPreset'), `font preset uses the library select primitive: ${controlState.primitiveSelects.join(',')}`);
    assert.ok(controlState.typedSelects.length === 6, `six typed appearance selects stay inside the typed Field owner (${controlState.typedSelects.join(',')})`);
    assert.equal(controlState.legacyChoiceRows, 0, 'retired local choice projection is deleted');
    assert.equal(controlState.legacyWraps, 0, 'retired local select wrap is deleted');
    assert.ok(controlState.bareSelects.includes('assistantAgent'), `empty enumerations keep the bare-select fallback: ${controlState.bareSelects.join(',')}`);
    const disclosureState = await page.evaluate(() => {
        const header = document.querySelector('#globalSettingsModal .vcp-harness-disclosure-row');
        return header ? { role: header.getAttribute('role'), controls: header.getAttribute('aria-controls'), expanded: header.getAttribute('aria-expanded') } : null;
    });
    if (disclosureState) {
        assert.equal(disclosureState.role, 'button', 'DisclosureRow exposes button role');
        assert.ok(disclosureState.controls, 'DisclosureRow exposes aria-controls');
        assert.ok(['true', 'false'].includes(disclosureState.expanded), 'DisclosureRow exposes aria-expanded');
    }
    assert.equal(controlState.nativeSources, controlState.primitiveSelects.length, 'the native select remains the sole business source behind every primitive projection');
    assert.equal(controlState.visibleSelectProjections, controlState.primitiveSelects.length, 'each projected select has exactly one visible primitive trigger');
    assert.equal(controlState.legacyInputWraps, 0, 'retired local input wrap is deleted');
    assert.ok(controlState.primitiveInputs > 0, `single-line inputs are projected by the library Input primitive (${controlState.primitiveInputs})`);
    assert.equal(controlState.bareTextareas, controlState.totalTextareas, 'textareas stay bare controls outside the fixed-height Input wrap');
    assert.equal(controlState.textareaMinHeight, '64px', 'bare textareas keep their multiline geometry contract');
    assert.ok(controlState.switchInputs > 0, `switch checkboxes present (${controlState.switchInputs})`);
    assert.equal(controlState.switchInputs, controlState.primitiveToggles, 'every switch checkbox is projected by the library Toggle primitive');
    assert.equal(controlState.visibleLegacySliders, 0, 'retired local slider spans are hidden or gone');
    await page.evaluate(() => {
        const select = document.getElementById('chatFontPreset');
        const trigger = select.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger');
        trigger?.click();
    });
    await page.waitForFunction(() => document.querySelector('#chatFontPreset')?.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger[aria-expanded="true"]')
        && document.querySelector('.vcp-uiux-primitive-menu:not([hidden])'), { timeout: timeoutMs });
    const popoverState = await page.evaluate(() => {
        const wrap = document.getElementById('chatFontPreset').closest('.vcp-harness-select');
        const popover = document.querySelector('.vcp-uiux-primitive-menu:not([hidden])');
        const trigger = wrap.querySelector('.vcp-harness-select-trigger');
        const style = getComputedStyle(trigger);
        return {
            options: popover?.querySelectorAll('[role="menuitem"]').length || 0,
            checked: popover?.querySelectorAll('[role="menuitem"][data-selected="true"]').length || 0,
            triggerHasMenu: trigger?.getAttribute('aria-haspopup') === 'menu',
            background: style.backgroundColor,
            border: style.borderTopColor,
            height: style.height,
            minHeight: style.minHeight,
            radius: style.borderTopLeftRadius,
            triggerWidth: wrap.getBoundingClientRect().width,
        };
    });
    assert.ok(popoverState.options >= 5, 'long select renders a real option popover');
    assert.equal(popoverState.triggerHasMenu, true, 'primitive select trigger owns a Menu primitive');
    assert.equal(popoverState.checked, 1, 'popover exposes one checked option');
    assert.equal(popoverState.minHeight, '40px', 'primitive trigger uses the 40px control contract');
    assert.equal(popoverState.radius, '10px', 'primitive trigger uses the 10px control radius');
    assert.equal(await page.$eval('.vcp-uiux-primitive-menu:not([hidden])', menu => getComputedStyle(menu).borderRadius), '12px', 'primitive menu surface uses r12');
    assert.equal(await page.$eval('.vcp-uiux-primitive-menu:not([hidden]) [role="menuitem"]', option => getComputedStyle(option).minHeight), '40px', 'primitive menu item uses min-height 40px');
    await page.waitForFunction(() => {
        const menu = document.querySelector('.vcp-uiux-primitive-menu:not([hidden])');
        return menu && getComputedStyle(menu).visibility === 'visible';
    }, { timeout: timeoutMs });
    const focusedMenuItem = await page.$eval('.vcp-uiux-primitive-menu:not([hidden]) [role="menuitem"]:not(:disabled)', option => {
        option.focus();
        return document.activeElement === option;
    });
    assert.equal(focusedMenuItem, true, 'menu item receives keyboard focus');
    await page.keyboard.press('ArrowDown');
    const activeAfterArrow = await page.evaluate(() => ({ role: document.activeElement?.getAttribute('role'), selected: document.querySelector('#chatFontPreset')?.value, active: document.activeElement?.id }));
    assert.equal(activeAfterArrow.role, 'menuitem', 'menu ArrowDown keeps focus inside the Menu primitive (bridge keyboard glue)');
    assert.equal(activeAfterArrow.selected, await page.$eval('#chatFontPreset', select => select.value), 'menu highlight does not write business value before Enter');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.vcp-uiux-primitive-menu:not([hidden])'), { timeout: timeoutMs });
    await page.evaluate(() => document.querySelector('#chatFontPreset')?.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger')?.click());
    await page.waitForFunction(() => document.querySelector('.vcp-uiux-primitive-menu:not([hidden])'), { timeout: timeoutMs });
    await page.evaluate(() => document.querySelectorAll('.vcp-uiux-primitive-menu:not([hidden]) [role="menuitem"]')[1]?.click());
    assert.equal(await page.$eval('#chatFontPreset', select => select.value), await page.$eval('#chatFontPreset', select => select.options[1].value), 'select choice writes through to native source');
    await page.evaluate(() => document.querySelector('#chatFontPreset')?.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger')?.click());
    await page.waitForFunction(() => Boolean(document.querySelector('.vcp-uiux-primitive-menu:not([hidden])')), { timeout: timeoutMs });
    await page.mouse.click(4, 4);
    await page.waitForFunction(() => !document.querySelector('.vcp-uiux-primitive-menu:not([hidden])'), { timeout: timeoutMs });
    assert.equal(await page.$eval('#chatFontPreset', select => select.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger')?.getAttribute('aria-expanded')), 'false', 'outside click closes the owned portal');
    await page.evaluate(() => {
        const select = document.getElementById('assistantAgent');
        select.replaceChildren(new Option('助手 A', 'agent-a'), new Option('助手 B', 'agent-b'));
    });
    await page.waitForFunction(() => Boolean(document.querySelector('#assistantAgent')?.closest('.vcp-harness-select')?.querySelector('.vcp-harness-select-trigger')), { timeout: timeoutMs });
    assert.ok(await page.$eval('#assistantAgent', select => Boolean(select.closest('.vcp-harness-select'))), 'dynamic assistant options receive a library Select primitive');
    assert.equal(await page.$eval('#assistantAgent', select => select.classList.contains('vcp-settings-bare-select')), false, 'dynamic assistant options drop the bare-select fallback');
    console.log(`  [PASS] 1b. library select primitive adoption (background ${popoverState.background}, border ${popoverState.border})`);

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
                // Retirement evidence E5: these keys were previously only
                // covered by the presentationOwner fallback; exercise the
                // typed snapshot path for every remaining fallback id too.
                topicSummaryModel: 'typed-topic-model',
                chatFontCustom: 'typed-chat-font',
                chatCodeFontPreset: 'cascadia',
                chatCodeFontCustom: 'typed-code-font',
                chatDiaryFontCustom: 'typed-diary-font',
                chatToolFontPreset: 'ubuntu',
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
    // The silent removal now schedules a typed save; wait for it to settle so
    // later snapshot probes cannot interleave with its debounced commit.
    await page.waitForFunction(() => {
        const form = document.getElementById('globalSettingsForm');
        return form?.dataset.vcpSettingsDirty !== 'true'
            && document.querySelector('.vcp-settings-autosave-status')?.dataset.state !== 'saving';
    }, { timeout: timeoutMs });
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
    assert.equal(await page.$eval('#topicSummaryModel', node => node.value), 'typed-topic-model', 'clean topic summary model consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatFontCustom', node => node.value), 'typed-chat-font', 'clean chat font custom consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatCodeFontPreset', node => node.value), 'cascadia', 'clean code font preset consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatCodeFontCustom', node => node.value), 'typed-code-font', 'clean code font custom consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatDiaryFontCustom', node => node.value), 'typed-diary-font', 'clean diary font custom consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatToolFontPreset', node => node.value), 'ubuntu', 'clean tool font preset consumes typed Settings snapshot');
    assert.equal(await page.$eval('#chatLayoutModeNormal', node => node.checked), false, 'clean normal-layout radio consumes typed Settings snapshot');
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
    assert.equal(failedRetryState.active, true, 'failed save keeps SettingsRoot open');
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
        forumPassword: `flush-pass-${Date.now()}`,
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
        // First-batch toggles: flip both home-visual booleans so their
        // checkbox drafts also ride the same close flush.
        ['showHomeVisualBrand', 'showHomeVisualTagline'].forEach(id => {
            const node = document.getElementById(id);
            node.checked = !node.checked;
            node.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const choice = document.getElementById(`appearanceSidebarRadiusChoice-${values.radiusChoice}`);
        choice.checked = true;
        choice.dispatchEvent(new Event('change', { bubbles: true }));
        set('adminUsername', values.forumUser);
        set('adminPassword', values.forumPassword);
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
            showHomeVisualBrand: document.getElementById('showHomeVisualBrand')?.checked === true,
            showHomeVisualTagline: document.getElementById('showHomeVisualTagline')?.checked === true,
        };
    });
    assert.equal(dirtyAtClose.dirty, true, `typed drafts mark the form dirty before close (${JSON.stringify(dirtyAtClose)})`);
    assert.equal(dirtyAtClose.fieldOwnerMounted && dirtyAtClose.forumOwnerMounted, true, `both typed owners are mounted (${JSON.stringify(dirtyAtClose)})`);
    const expectedFlush = {
        rowHeight: dirtyAtClose.rowHeight,
        avatarSize: dirtyAtClose.avatarSize,
        customRadius: dirtyAtClose.customRadius,
        showHomeVisualBrand: dirtyAtClose.showHomeVisualBrand,
        showHomeVisualTagline: dirtyAtClose.showHomeVisualTagline,
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
                showHomeVisualBrand: settingsService?.state?.get?.()?.showHomeVisualBrand === true,
                showHomeVisualTagline: settingsService?.state?.get?.()?.showHomeVisualTagline === true,
                forumUsername: String(forumService?.state?.get?.()?.username ?? ''),
                forumPassword: String(forumService?.state?.get?.()?.password ?? ''),
            };
        });
        if (
            String(flushedSnapshot.sidebarRowHeight) === expectedFlush.rowHeight
            && Number(flushedSnapshot.customRadius) === Number(expectedFlush.customRadius)
            && flushedSnapshot.homeVisualTagline.startsWith('close-flush-tagline-')
            && flushedSnapshot.showHomeVisualBrand === expectedFlush.showHomeVisualBrand
            && flushedSnapshot.showHomeVisualTagline === expectedFlush.showHomeVisualTagline
            && flushedSnapshot.forumUsername === flushValues.forumUser
            && flushedSnapshot.forumPassword === flushValues.forumPassword
        ) break;
        await sleep(250);
    }
    assert.equal(String(flushedSnapshot.sidebarRowHeight), expectedFlush.rowHeight, `close flush committed the on-screen row-height draft (${JSON.stringify({ flushedSnapshot, expectedFlush })})`);
    assert.equal(String(flushedSnapshot.sidebarAvatarSize), expectedFlush.avatarSize, `close flush committed the on-screen avatar-size draft (${JSON.stringify({ flushedSnapshot, expectedFlush })})`);
    assert.equal(Number(flushedSnapshot.customRadius), Number(expectedFlush.customRadius), `close flush committed the on-screen custom-radius draft (${JSON.stringify({ flushedSnapshot, expectedFlush })})`);
    assert.equal(flushedSnapshot.sidebarRadius, 'small', `close flush committed radius choice draft (${JSON.stringify(flushedSnapshot)})`);
    assert.ok(flushedSnapshot.homeVisualTagline.startsWith('close-flush-tagline-'), `close flush committed home tagline draft (${JSON.stringify(flushedSnapshot)})`);
    assert.equal(flushedSnapshot.showHomeVisualBrand, expectedFlush.showHomeVisualBrand, `close flush committed home brand toggle draft (${JSON.stringify({ flushedSnapshot, expectedFlush })})`);
    assert.equal(flushedSnapshot.showHomeVisualTagline, expectedFlush.showHomeVisualTagline, `close flush committed home tagline toggle draft (${JSON.stringify({ flushedSnapshot, expectedFlush })})`);
    assert.equal(flushedSnapshot.forumUsername, flushValues.forumUser, `close flush committed forum username draft via ForumConfigUiService (${JSON.stringify(flushedSnapshot)})`);
    assert.equal(flushedSnapshot.forumPassword, flushValues.forumPassword, `close flush committed forum password draft via ForumConfigUiService (${JSON.stringify(flushedSnapshot)})`);
    console.log('  [PASS] 6b. close flush commits per-field typed drafts (settings fields + forum credentials)');

    // ---- 6c. Wide layout radio pair is owned by the typed field owner:
    // toggling marks dirty without driving legacy submit, and closing the
    // modal before the debounce commits the boolean through the same owner.
    const wideLayoutBefore = await page.evaluate(() => window.VCPUISettingsBridge.getTypedService().state.get().enableWideChatLayout);
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 250));
    const wideLayoutSeam = {
        requestSubmitCalls: 0,
    };
    const seamProbesBound = await page.evaluate((baseline) => {
        const form = document.getElementById('globalSettingsForm');
        if (!form || !form.requestSubmit) return false;
        const originalSubmit = form.requestSubmit.bind(form);
        form.requestSubmit = (...args) => {
            baseline.requestSubmitCalls += 1;
            return originalSubmit(...args);
        };
        return true;
    }, wideLayoutSeam);
    assert.equal(seamProbesBound, true, 'wide-layout seam probes bound');
    // Attribution: the save-result CustomEvent does not bubble, so listen
    // directly on the form node itself; a listener keeps firing even after
    // the modal tree is torn down, since dispatch does not need connectivity.
    await page.evaluate(() => {
        window.__wideLayoutSaveResult = null;
        const form = document.getElementById('globalSettingsForm');
        form?.addEventListener('vcp-settings-save-result', event => {
            window.__wideLayoutSaveResult = { owner: event.detail?.owner || null, success: event.detail?.success === true };
        }, false);
    });
    const wideLayoutToggle = wideLayoutBefore === true ? 'chatLayoutModeNormal' : 'chatLayoutModeWide';
    const expectedWideLayout = wideLayoutBefore !== true;
    await page.evaluate(id => {
        const radio = document.getElementById(id);
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
    }, wideLayoutToggle);
    const wideDirtyAtClose = await page.evaluate(() => {
        const form = document.getElementById('globalSettingsForm');
        return {
            dirty: form.dataset.vcpSettingsDirty === 'true',
            ownerMarker: document.getElementById('chatLayoutModeWide')?.dataset.vcpTypedFieldOwner || null,
            normalChecked: document.getElementById('chatLayoutModeNormal')?.checked,
            wideChecked: document.getElementById('chatLayoutModeWide')?.checked,
        };
    });
    assert.equal(wideDirtyAtClose.dirty && wideDirtyAtClose.ownerMarker === 'true', true, `wide-layout radio is typed-owned and marks dirty (${JSON.stringify(wideDirtyAtClose)})`);
    assert.equal(wideDirtyAtClose.wideChecked, expectedWideLayout, `wide-layout radio draft matches toggle (${JSON.stringify(wideDirtyAtClose)})`);
    assert.equal(wideDirtyAtClose.normalChecked, !expectedWideLayout, `normal-layout radio draft matches toggle (${JSON.stringify(wideDirtyAtClose)})`);
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    const wideFlushDeadline = Date.now() + timeoutMs;
    let flushedWideLayout = null;
    while (Date.now() < wideFlushDeadline) {
        flushedWideLayout = await page.evaluate(() => window.VCPUISettingsBridge.getTypedService().state.get().enableWideChatLayout);
        if (flushedWideLayout === expectedWideLayout) break;
        await sleep(250);
    }
    assert.equal(flushedWideLayout, expectedWideLayout, `close flush committed the wide-layout boolean draft (${JSON.stringify({ flushedWideLayout, expectedWideLayout })})`);
    assert.equal(wideLayoutSeam.requestSubmitCalls, 0, `wide-layout drafting never drives legacy whole-form submit (${JSON.stringify(wideLayoutSeam)})`);
    let wideSaveAttribution = null;
    const attributionDeadline = Date.now() + timeoutMs;
    while (Date.now() < attributionDeadline) {
        wideSaveAttribution = await page.evaluate(() => window.__wideLayoutSaveResult);
        if (wideSaveAttribution?.owner === 'typed-settings-field-owner') break;
        await sleep(250);
    }
    assert.equal(wideSaveAttribution?.owner === 'typed-settings-field-owner' && wideSaveAttribution.success === true, true, `wide-layout close flush published by typed field owner (${JSON.stringify({ wideSaveAttribution })})`);
    console.log('  [PASS] 6c. wide layout radio pair is a single-owner typed field with close-flush evidence');

    // ---- 6d. Chat typography preset + custom text ride the same typed
    // owner: edit both, close before the debounce, and the flush must commit
    // exactly what was on screen while the harness select stays canonical.
    const fontValues = {
        diaryPreset: 'monospace',
        toolCustom: `flush-tool-font-${Date.now()}`,
    };
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.evaluate(values => {
        const set = (id, value) => {
            const node = document.getElementById(id);
            node.value = value;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // chatDiaryFontPreset defaults to serif in the snapshot; pick a value
        // that is guaranteed different from the current service state.
        const service = window.VCPUISettingsBridge.getTypedService();
        const current = String(service.state.get().chatDiaryFontPreset || '');
        set('chatDiaryFontPreset', values.diaryPreset === current ? 'serif' : values.diaryPreset);
        set('chatToolFontCustom', values.toolCustom);
    }, fontValues);
    const fontDirtyAtClose = await page.evaluate(() => {
        const form = document.getElementById('globalSettingsForm');
        return {
            dirty: form.dataset.vcpSettingsDirty === 'true',
            ownerMarker: document.getElementById('chatToolFontCustom')?.dataset.vcpTypedFieldOwner || null,
            onScreen: {
                chatDiaryFontPreset: document.getElementById('chatDiaryFontPreset')?.value,
                chatToolFontCustom: document.getElementById('chatToolFontCustom')?.value,
            },
        };
    });
    assert.equal(fontDirtyAtClose.dirty && fontDirtyAtClose.ownerMarker === 'true', true, `font fields are typed-owned and mark dirty (${JSON.stringify(fontDirtyAtClose)})`);
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    let flushedFonts = null;
    const fontFlushDeadline = Date.now() + timeoutMs;
    while (Date.now() < fontFlushDeadline) {
        flushedFonts = await page.evaluate(() => ({
            chatDiaryFontPreset: window.VCPUISettingsBridge.getTypedService().state.get().chatDiaryFontPreset,
            chatToolFontCustom: window.VCPUISettingsBridge.getTypedService().state.get().chatToolFontCustom,
        }));
        if (String(flushedFonts.chatDiaryFontPreset) === fontDirtyAtClose.onScreen.chatDiaryFontPreset
            && flushedFonts.chatToolFontCustom === fontDirtyAtClose.onScreen.chatToolFontCustom) break;
        await sleep(250);
    }
    assert.equal(String(flushedFonts.chatDiaryFontPreset), fontDirtyAtClose.onScreen.chatDiaryFontPreset, `close flush committed the font preset draft (${JSON.stringify({ flushedFonts, onScreen: fontDirtyAtClose.onScreen })})`);
    assert.equal(flushedFonts.chatToolFontCustom, fontDirtyAtClose.onScreen.chatToolFontCustom, `close flush committed the font custom draft (${JSON.stringify({ flushedFonts, onScreen: fontDirtyAtClose.onScreen })})`);
    console.log('  [PASS] 6d. chat typography preset/custom close flush through the single typed owner');

    // ---- 6e. Dynamic network-notes path rows are a single typed-owner list:
    // edit an existing row, add one, remove one, then close before the
    // debounce; the flush must commit exactly the on-screen list while the
    // legacy whole-form chain stays silent.
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await page.waitForFunction(() => Boolean(document.querySelector('#networkNotesPathsContainer input[name="networkNotesPath"]')), { timeout: timeoutMs });
    const pathValues = {
        edited: `edited-path-${Date.now()}`,
        added: `added-path-${Date.now()}`,
    };
    await page.evaluate(values => {
        const container = document.getElementById('networkNotesPathsContainer');
        const first = container.querySelector('input[name="networkNotesPath"]');
        first.value = values.edited;
        first.dispatchEvent(new Event('input', { bubbles: true }));
    }, pathValues);
    const pathMidState = await page.evaluate(() => ({
        dirty: document.getElementById('globalSettingsForm').dataset.vcpSettingsDirty === 'true',
        rows: [...document.querySelectorAll('#networkNotesPathsContainer input[name="networkNotesPath"]')].map(input => input.value),
        legacySubmitCount: window.__legacyPathSubmitCount || 0,
    }));
    assert.equal(pathMidState.dirty && pathMidState.rows[0] === pathValues.edited, true, `editing a path row marks the typed owner dirty (${JSON.stringify(pathMidState)})`);
    // Removing a row is silent at the input level; it must still mark dirty.
    await page.evaluate(() => {
        document.querySelectorAll('#networkNotesPathsContainer .network-path-input-group')[0]?.querySelector('.danger-button')?.click();
    });
    const afterRemoval = await page.evaluate(() => ({
        dirty: document.getElementById('globalSettingsForm').dataset.vcpSettingsDirty === 'true',
        rows: [...document.querySelectorAll('#networkNotesPathsContainer input[name="networkNotesPath"]')].map(input => input.value),
    }));
    assert.equal(afterRemoval.dirty, true, `row removal re-marks the typed owner dirty (${JSON.stringify(afterRemoval)})`);
    // Add a fresh row through the production add-button seam and fill it.
    await page.evaluate(() => {
        document.getElementById('addNetworkPathBtn')?.click();
    });
    await page.waitForFunction(countBaseline => document.querySelectorAll('#networkNotesPathsContainer input[name="networkNotesPath"]').length > countBaseline, {}, afterRemoval.rows.length);
    const pathDirtyAtClose = await page.evaluate(values => {
        const rowInputs = [...document.querySelectorAll('#networkNotesPathsContainer input[name="networkNotesPath"]')];
        const target = rowInputs[rowInputs.length - 1];
        target.value = values.added;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        return {
            dirty: document.getElementById('globalSettingsForm').dataset.vcpSettingsDirty === 'true',
            rowOwnerMarkers: rowInputs.map(input => input.dataset.vcpTypedFieldOwner || null),
            onScreen: rowInputs.map(input => input.value.trim()).filter(Boolean),
        };
    }, pathValues);
    assert.equal(pathDirtyAtClose.dirty && pathDirtyAtClose.rowOwnerMarkers.every(marker => marker === 'true'), true, `path rows carry the typed owner marker and mark dirty (${JSON.stringify(pathDirtyAtClose)})`);
    await page.evaluate(() => {
        window.__pathAttributionProbe = [];
        document.getElementById('globalSettingsForm').addEventListener('vcp-settings-save-result', event => {
            window.__pathAttributionProbe.push(event.detail?.owner || 'unknown');
        });
    });
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    let flushedPaths = null;
    const pathFlushDeadline = Date.now() + timeoutMs;
    while (Date.now() < pathFlushDeadline) {
        flushedPaths = await page.evaluate(onScreen => ({
            committed: window.VCPUISettingsBridge.getTypedService().state.get().networkNotesPaths,
            attributions: window.__pathAttributionProbe,
        }), pathDirtyAtClose.onScreen);
        if (JSON.stringify(flushedPaths.committed) === JSON.stringify(pathDirtyAtClose.onScreen)) break;
        await sleep(250);
    }
    assert.equal(JSON.stringify(flushedPaths.committed), JSON.stringify(pathDirtyAtClose.onScreen), `close flush committed the exact on-screen path list (${JSON.stringify({ flushedPaths, onScreen: pathDirtyAtClose.onScreen })})`);
    assert.equal(flushedPaths.attributions.includes('typed-settings-field-owner'), true, `list save attributed to the typed field owner (${JSON.stringify(flushedPaths.attributions)})`);
    console.log(`  [PASS] 6e. network notes path rows commit as a single typed list on close (${flushedPaths.committed.length} paths)`);
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
        // ---- retirement evidence E5: the durable-restore assertion set
        // covers every id the presentationOwner fallback used to fill, so
        // deleting the fallback cannot change the reload-restore outcome. ----
        // ---- forum credential seam: the 6b close flush persisted these
        // values through the ForumConfigUiService; after reload the typed
        // forum consumer must re-project them (single typed route, no
        // legacy re-fill). ----
        forumUser: document.getElementById('adminUsername')?.value,
        forumPassword: document.getElementById('adminPassword')?.value,
        topicSummaryModel: document.getElementById('topicSummaryModel')?.value,
        chatFontPreset: document.getElementById('chatFontPreset')?.value,
        chatFontCustom: document.getElementById('chatFontCustom')?.value,
        chatCodeFontPreset: document.getElementById('chatCodeFontPreset')?.value,
        chatCodeFontCustom: document.getElementById('chatCodeFontCustom')?.value,
        chatDiaryFontPreset: document.getElementById('chatDiaryFontPreset')?.value,
        chatDiaryFontCustom: document.getElementById('chatDiaryFontCustom')?.value,
        chatToolFontPreset: document.getElementById('chatToolFontPreset')?.value,
        chatToolFontCustom: document.getElementById('chatToolFontCustom')?.value,
        avatarBorder: document.getElementById('userAvatarBorderColor')?.value,
        avatarBorderText: document.getElementById('userAvatarBorderColorText')?.value,
        nameColor: document.getElementById('userNameTextColor')?.value,
        nameColorText: document.getElementById('userNameTextColorText')?.value,
        vcpServerUrl: document.getElementById('vcpServerUrl')?.value,
        vcpApiKey: document.getElementById('vcpApiKey')?.value,
        fileKey: document.getElementById('fileKey')?.value,
        vcpLogUrl: document.getElementById('vcpLogUrl')?.value,
        vcpLogKey: document.getElementById('vcpLogKey')?.value,
        flowlockContinueDelay: document.getElementById('flowlockContinueDelay')?.value,
        enableSmoothStreaming: document.getElementById('enableSmoothStreaming')?.checked,
        voiceModeLocal: document.getElementById('voiceModeLocal')?.checked,
        voiceModeNetwork: document.getElementById('voiceModeNetwork')?.checked,
        speechRecognizerBrowserPath: document.getElementById('speechRecognizerBrowserPath')?.value,
        speechRecognizerPagePath: document.getElementById('speechRecognizerPagePath')?.value,
        voiceLocalSovitsUrl: document.getElementById('voiceLocalSovitsUrl')?.value,
        voiceLocalSovitsKey: document.getElementById('voiceLocalSovitsKey')?.value,
        voiceNetworkProviderUrl: document.getElementById('voiceNetworkProviderUrl')?.value,
        voiceNetworkProviderKey: document.getElementById('voiceNetworkProviderKey')?.value,
        chatPresentationModePanel: document.getElementById('chatPresentationModePanel')?.checked,
        chatLayoutModeWide: document.getElementById('chatLayoutModeWide')?.checked,
        chatLayoutModeNormal: document.getElementById('chatLayoutModeNormal')?.checked,
        enableUserChatBubbleUi: document.getElementById('enableUserChatBubbleUi')?.checked,
        showUserMetaInChatBubbleUi: document.getElementById('showUserMetaInChatBubbleUi')?.checked,
        bubbleWideDefault: document.getElementById('chatBubbleMaxWidthWideDefault')?.value,
        bubbleWideNotifications: document.getElementById('chatBubbleMaxWidthWideNotifications')?.value,
        bubbleWideNarrow: document.getElementById('chatBubbleMaxWidthWideNarrow')?.value,
        minChunkBufferSize: document.getElementById('minChunkBufferSize')?.value,
        smoothStreamIntervalMs: document.getElementById('smoothStreamIntervalMs')?.value,
        networkPaths: [...document.querySelectorAll('#networkNotesPathsContainer input[name="networkNotesPath"]')]
            .map(node => node.value.trim()).filter(Boolean),
    }));
    assert.equal(restored.prompt, uniquePrompt, 'reopened form restored the persisted continueWritingPrompt');
    assert.equal(restored.userName, savedUserName, 'reopened form restored the persisted userName from disk');
    assert.equal(restored.active, 'section-user-identity', 'reopened modal starts on the first category');
    assert.equal(restored.topicSummaryModel, 'typed-topic-model', 'restore covers the topic summary model fallback id');
    assert.equal(restored.chatFontPreset, 'serif', 'restore covers the chat font preset fallback id');
    assert.equal(restored.chatFontCustom, 'typed-chat-font', 'restore covers the chat font custom fallback id');
    assert.equal(restored.chatCodeFontPreset, 'cascadia', 'restore covers the code font preset fallback id');
    assert.equal(restored.chatCodeFontCustom, 'typed-code-font', 'restore covers the code font custom fallback id');
    // 6d's preset edit can land as an empty-string draft (the diary select
    // has no 'monospace' option, so the pre-existing section assigns '');
    // the reload path then re-applies the projection default, which is the
    // exact contract the fallback used to own.
    assert.equal(restored.chatDiaryFontPreset, String(flushedFonts.chatDiaryFontPreset || 'serif'), 'restore covers the diary font preset fallback id');
    assert.equal(restored.chatDiaryFontCustom, 'typed-diary-font', 'restore covers the diary font custom fallback id');
    assert.equal(restored.chatToolFontPreset, 'ubuntu', 'restore covers the tool font preset fallback id');
    assert.equal(restored.chatToolFontCustom, flushedFonts.chatToolFontCustom, 'restore covers the tool font custom fallback id');
    assert.equal(restored.avatarBorder, '#123456', 'restore covers the avatar border color fallback id');
    assert.equal(restored.avatarBorderText, '#123456', 'restore covers the avatar border color text mirror fallback id');
    assert.equal(restored.nameColor, '#abcdef', 'restore covers the name color fallback id');
    assert.equal(restored.nameColorText, '#abcdef', 'restore covers the name color text mirror fallback id');
    // The save path normalizes the URL through completeVcpUrl before
    // persisting (legacy collect contract); reload projects the stored
    // value verbatim.
    assert.equal(restored.vcpServerUrl, 'http://typed-external:6005/v1/chat/completions', 'restore covers the vcp server url fallback id (save-time completeVcpUrl normalization included)');
    assert.equal(restored.vcpApiKey, 'typed-api-key', 'restore covers the api key fallback id');
    assert.equal(restored.fileKey, 'typed-file-key', 'restore covers the file key fallback id');
    assert.equal(restored.vcpLogUrl, 'ws://typed-log:6006', 'restore covers the log url fallback id');
    assert.equal(restored.vcpLogKey, 'typed-log-key', 'restore covers the log key fallback id');
    assert.equal(restored.flowlockContinueDelay, '12', 'restore covers the flowlock delay fallback id');
    assert.equal(restored.enableSmoothStreaming, false, 'restore covers the smooth streaming fallback id');
    assert.equal(restored.voiceModeNetwork, true, 'restore covers the network voice radio fallback id');
    assert.equal(restored.voiceModeLocal, false, 'restore covers the local voice radio fallback id');
    assert.equal(restored.speechRecognizerBrowserPath, '/typed/chrome', 'restore covers the STT browser path fallback id');
    assert.equal(restored.speechRecognizerPagePath, '/typed/recognizer.html', 'restore covers the STT page path fallback id');
    assert.equal(restored.voiceLocalSovitsUrl, 'http://typed-local:9880', 'restore covers the local sovits url fallback id');
    assert.equal(restored.voiceLocalSovitsKey, 'typed-local-key', 'restore covers the local sovits key fallback id');
    assert.equal(restored.voiceNetworkProviderUrl, 'https://typed-voice.example/api', 'restore covers the network provider url fallback id');
    assert.equal(restored.voiceNetworkProviderKey, 'typed-network-key', 'restore covers the network provider key fallback id');
    assert.equal(restored.chatPresentationModePanel, true, 'restore covers the presentation mode radio fallback id');
    assert.equal(restored.chatLayoutModeWide, flushedWideLayout, 'restore covers the wide layout radio fallback id');
    assert.equal(restored.chatLayoutModeNormal, !flushedWideLayout, 'restore covers the normal layout radio fallback id');
    assert.equal(restored.enableUserChatBubbleUi, true, 'restore covers the user bubble toggle fallback id');
    assert.equal(restored.showUserMetaInChatBubbleUi, false, 'restore covers the bubble meta toggle fallback id');
    assert.equal(restored.bubbleWideDefault, '88', 'restore covers the wide default width fallback id');
    assert.equal(restored.bubbleWideNotifications, '94', 'restore covers the notification width fallback id');
    assert.equal(restored.bubbleWideNarrow, '90', 'restore covers the narrow width fallback id');
    assert.equal(restored.minChunkBufferSize, '24', 'restore covers the chunk buffer fallback id');
    assert.equal(restored.smoothStreamIntervalMs, '140', 'restore covers the stream interval fallback id');
    assert.equal(JSON.stringify(restored.networkPaths), JSON.stringify(flushedPaths.committed), 'restore covers the network notes path list fallback owner');
    assert.equal(restored.forumUser, flushValues.forumUser, `restore covers the forum admin username via the typed forum consumer (${JSON.stringify({ forumUser: restored.forumUser, expected: flushValues.forumUser })})`);
    assert.equal(restored.forumPassword, flushValues.forumPassword, 'restore covers the forum admin password via the typed forum consumer');
    console.log('  [PASS] 7. reopen after reload restores persisted values from settings.json (full fallback-id coverage + forum credentials)');

    // ---- 8. Canonical next layout survives reload ----
    assert.equal(await page.evaluate(() => document.documentElement.dataset.uiMode), 'next');
    await page.waitForFunction(() => {
        const modal = document.getElementById('globalSettingsModal');
        return Boolean(modal?.querySelector('.vcp-harness-settings-root .vcp-harness-settings-header') && modal?.querySelector('.vcp-harness-settings-options'));
    }, { timeout: timeoutMs });
    console.log('  [PASS] 8. canonical unified SettingsShell survives reload');

    // ---- 6f. Name cluster keeps legacy collect semantics under the typed owner:
    // trimmed name, default-filled prompt and one color key mirrored by two ids
    // commit through the same close-flush channel.  (userUseThemeColorsInChat is
    // excluded: the persisted key has no control inside #globalSettingsForm.)
    await page.evaluate(() => {
        window.__nameClusterAttributionProbe = [];
        document.getElementById('globalSettingsForm').addEventListener('vcp-settings-save-result', event => {
            window.__nameClusterAttributionProbe.push(event.detail?.owner || 'unknown');
        });
    });
    await page.evaluate(() => {
        const name = document.getElementById('userName');
        name.value = '  batch15-typed-user  ';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        const mirror = document.getElementById('userNameTextColorText');
        mirror.value = '#123abc';
        mirror.dispatchEvent(new Event('input', { bubbles: true }));
        const prompt = document.getElementById('continueWritingPrompt');
        prompt.value = '';
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const nameClusterDirtyState = await page.evaluate(() => ({
        dirty: document.getElementById('globalSettingsForm').dataset.vcpSettingsDirty === 'true',
        markers: ['userName', 'userNameTextColor', 'userNameTextColorText', 'continueWritingPrompt']
            .map(id => document.getElementById(id)?.dataset.vcpTypedFieldOwner || null),
    }));
    assert.equal(nameClusterDirtyState.dirty && nameClusterDirtyState.markers.every(marker => marker === 'true'), true, `name cluster controls carry the typed owner marker (${JSON.stringify(nameClusterDirtyState)})`);
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    let flushedNameCluster = null;
    const nameFlushDeadline = Date.now() + timeoutMs;
    while (Date.now() < nameFlushDeadline) {
        flushedNameCluster = await page.evaluate(() => {
            const snapshot = window.VCPUISettingsBridge.getTypedService().state.get();
            return {
                userName: snapshot.userName,
                userTextColor: snapshot.userNameTextColor,
                prompt: snapshot.continueWritingPrompt,
                attributions: window.__nameClusterAttributionProbe,
            };
        });
        if (flushedNameCluster.userName === 'batch15-typed-user'
            && flushedNameCluster.userTextColor === '#123abc'
            && flushedNameCluster.prompt === '请继续'
            && flushedNameCluster.attributions.length > 0) break;
        await sleep(250);
    }
    assert.equal(flushedNameCluster.userName, 'batch15-typed-user', `close flush persists the trimmed typed name draft (${JSON.stringify(flushedNameCluster)})`);
    assert.equal(flushedNameCluster.prompt, '请继续', 'cleared prompt commits the legacy default fill under the typed owner');
    assert.equal(flushedNameCluster.userTextColor, '#123abc', 'color mirror id commits the shared persisted key');
    assert.equal(flushedNameCluster.attributions.includes('typed-settings-field-owner'), true, `name cluster save attributed to the typed field owner (${JSON.stringify(flushedNameCluster.attributions)})`);
    console.log('  [PASS] 6f. name cluster keeps trim/fallback/mirror semantics through the typed close flush');

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

    // ---- 8c (retirement evidence E3, negative contract). The fallback's
    // only trigger surface is the one-shot `modal-ready` (first template
    // instantiation) plus the cold-start load; reopens never re-run it.
    // With the typed readiness marker deleted, a reopen must leave the
    // on-screen drafts untouched (no surprise re-fill from a stale
    // snapshot), and only a state commit may reclaim the marker and
    // re-project. ----
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    const e3BeforeReopen = await page.evaluate(() => ({
        userName: document.getElementById('userName')?.value ?? null,
        prompt: document.getElementById('continueWritingPrompt')?.value ?? null,
        revisionCleared: (delete document.getElementById('globalSettingsModal').dataset.vcpSettingsRevision,
            document.getElementById('globalSettingsModal').dataset.vcpSettingsRevision === undefined),
    }));
    assert.equal(e3BeforeReopen.revisionCleared, true, 'E3 probe cleared the typed readiness marker');
    await page.evaluate(() => window.uiHelperFunctions.openModal('globalSettingsModal'));
    await page.waitForFunction(() => document.getElementById('globalSettingsForm'), { timeout: timeoutMs });
    await new Promise(resolve => setTimeout(resolve, 250));
    const e3AfterReopen = await page.evaluate(() => ({
        revision: document.getElementById('globalSettingsModal')?.dataset?.vcpSettingsRevision ?? null,
        userName: document.getElementById('userName')?.value ?? null,
        prompt: document.getElementById('continueWritingPrompt')?.value ?? null,
    }));
    assert.equal(e3AfterReopen.revision, null, 'E3: the readiness marker stays absent across a reopen (no fallback re-run)');
    assert.equal(e3AfterReopen.userName, e3BeforeReopen.userName, `E3: reopen keeps the on-screen draft untouched while readiness is absent (${JSON.stringify({ e3BeforeReopen, e3AfterReopen })})`);
    assert.equal(e3AfterReopen.prompt, e3BeforeReopen.prompt, 'E3: reopen keeps the prompt draft untouched while readiness is absent');
    console.log('  [PASS] 8c-1. reopen with readiness absent never re-runs the fallback (drafts preserved verbatim)');
    // A state commit reclaims the readiness marker and re-projects the
    // authoritative typed snapshot over whatever is on screen.  The probe
    // toggles a harmless key so the commit is a real state change (services
    // may deduplicate equal-value notifications), then restores it.
    const e3ProbeValue = await page.evaluate(() => {
        const current = document.getElementById('topicSummaryModel')?.value || '';
        window.dispatchEvent(new CustomEvent('global-settings-updated', {
            detail: { settings: { topicSummaryModel: `${current}#e3` }, source: 'e3-reclaim-probe' }
        }));
        return current;
    });
    await page.waitForFunction(() => Number.isInteger(Number(document.getElementById('globalSettingsModal')?.dataset?.vcpSettingsRevision)), { timeout: timeoutMs });
    await page.evaluate(value => {
        window.dispatchEvent(new CustomEvent('global-settings-updated', {
            detail: { settings: { topicSummaryModel: value }, source: 'e3-reclaim-restore' }
        }));
    }, e3ProbeValue);
    const e3Reclaim = await page.evaluate(() => ({
        userName: document.getElementById('userName')?.value || '',
        stateUserName: String(window.VCPUISettingsBridge.getTypedService().state.get().userName ?? '') || '用户',
    }));
    assert.equal(e3Reclaim.userName, e3Reclaim.stateUserName, `E3: reclaim re-projects the authoritative typed snapshot (${JSON.stringify(e3Reclaim)})`);
    console.log('  [PASS] 8c-2. a state commit reclaims the readiness marker and re-projects the authoritative snapshot');

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
    try {
        if (child.pid && process.platform !== 'win32') {
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch {
                child.kill();
            }
        } else {
            child.kill();
        }
    } catch {
        /* already exited */
    }
    browser?.disconnect();
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
        if (child.pid && process.platform !== 'win32' && !child.killed) {
            process.kill(-child.pid, 'SIGKILL');
        } else {
            child.kill('SIGKILL');
        }
    } catch {
        /* already exited */
    }
}
