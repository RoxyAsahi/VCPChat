import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const timeout = 45_000;

function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

function request(url) {
    return new Promise((resolve, reject) => {
        http.get(url, response => {
            response.resume();
            response.once('end', resolve);
        }).once('error', reject);
    });
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-uiux-theme-'));
await fs.mkdir(path.join(appData, 'Agents', 'ThemeProbe'), { recursive: true });
await fs.writeFile(path.join(appData, 'Agents', 'ThemeProbe', 'config.json'), JSON.stringify({
    name: 'Theme Probe', model: 'theme-probe', promptMode: 'original',
    originalSystemPrompt: 'Theme probe', systemPrompt: 'Theme probe', stripRegexes: [],
}), 'utf8');
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next', enableDistributedServer: false, vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'theme-probe', assistantAgent: 'ThemeProbe', currentThemeMode: 'light',
}), 'utf8');

const port = await freePort();
const child = spawn(electron, [
    '.', '--allow-multiple-instances',
    `--user-data-dir=${path.join(appData, 'ElectronProfile')}`,
    `--remote-debugging-port=${port}`,
], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
let browser;
try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try { await request(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
    assert.ok(page, `Theme probe main renderer missing: ${stderr}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout });
    const artifactBoundary = await page.evaluate(async () => {
        const scripts = [...document.scripts].map(script => script.src || script.getAttribute('src') || '');
        const generated = scripts.filter(src => src.includes('/modules/uiux/generated/'));
        const sourcePlane = scripts.filter(src => /modules\/uiux\/(?!generated\/)/.test(src));
        let state = { userName: 'electron-artifact' };
        const service = window.VCPUIUX?.createSettingsUiService?.({
            get: () => state,
            save: async patch => { state = { ...state, ...patch }; return { success: true }; },
            subscribe: () => () => {},
        });
        const save = await service?.save?.execute?.({ userName: 'electron-artifact-next' });
        const value = service?.state?.get?.().userName;
        await service?.dispose?.();
        return { generated, sourcePlane, save, value };
    });
    assert.ok(artifactBoundary.generated.some(src => src.endsWith('/modules/uiux/generated/browser-entry.js')),
        `Electron did not load generated UIUX browser artifact: ${JSON.stringify(artifactBoundary)}`);
    assert.equal(artifactBoundary.sourcePlane.length, 0,
        `Electron UIUX smoke loaded source-plane UIUX modules: ${JSON.stringify(artifactBoundary)}`);
    assert.deepEqual(artifactBoundary.save, { success: true });
    assert.equal(artifactBoundary.value, 'electron-artifact-next');
    const primitiveScreenshot = path.join(root, 'reports', 'vcp-uiux-primitive-contract.png');
    const primitiveBoundary = await page.evaluate(() => {
        const host = document.createElement('div');
        host.innerHTML = '<label id="artifact-field"><span>Density</span><select id="artifact-density"><option>Comfortable</option><option>Compact</option></select></label><input id="artifact-input" value="hello"><div id="artifact-choice"><label><input type="radio" name="artifact-choice" value="a">A</label><label><input type="radio" name="artifact-choice" value="b">B</label></div><div id="artifact-range-field"><input id="artifact-range" type="range" value="32"><output id="artifact-range-output"></output></div><label id="artifact-toggle"><input type="checkbox" checked><span class="slider"></span></label><div id="artifact-color-pair"><input id="artifact-color" type="color" value="#3d5a80"><input id="artifact-color-text" type="text" value="#3d5a80"></div>';
        document.body.append(host);
        const disposers = [];
        const scope = {
            own(disposer) { disposers.push(disposer); return disposer; },
            listen(target, type, handler, options) { target.addEventListener(type, handler, options); const release = () => target.removeEventListener(type, handler, options); disposers.push(release); return release; },
        };
        const select = host.querySelector('select');
        window.VCPUIUX.mountField(host.querySelector('label'), { label: 'Density', control: select }, scope);
        window.VCPUIUX.mountSelect(select, { label: 'Density', portal: true }, scope);
        const input = host.querySelector('#artifact-input');
        window.VCPUIUX.mountInput(input, {}, scope);
        const choice = host.querySelector('#artifact-choice');
        window.VCPUIUX.mountChoice(choice, scope);
        const range = host.querySelector('#artifact-range');
        const rangeOutput = host.querySelector('#artifact-range-output');
        window.VCPUIUX.mountRange(range, { output: rangeOutput }, scope);
        const toggle = host.querySelector('#artifact-toggle input');
        const legacySlider = host.querySelector('#artifact-toggle .slider');
        window.VCPUIUX.mountToggle(toggle, scope);
        const color = host.querySelector('#artifact-color');
        const colorText = host.querySelector('#artifact-color-text');
        window.VCPUIUX.mountColorPair(color, colorText, scope);
        colorText.value = '#112233';
        colorText.dispatchEvent(new Event('change', { bubbles: true }));
        colorText.value = 'invalid';
        // ColorPair deliberately keeps intermediate invalid text while editing;
        // its canonical rollback contract is committed on blur.
        colorText.dispatchEvent(new Event('blur', { bubbles: true }));
        range.value = '40';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        const trigger = host.querySelector('.vcp-harness-select-trigger');
        trigger.click();
        const item = document.querySelector('.vcp-harness-menu-list [role="menuitem"]');
        const style = item && getComputedStyle(item);
        const menuStyle = getComputedStyle(document.querySelector('.vcp-harness-menu-list'));
        const viewportStyle = getComputedStyle(document.querySelector('.vcp-harness-menu-viewport'));
        choice.querySelector('input[value="b"]').click();
        const inputWrapStyle = input?.parentElement ? getComputedStyle(input.parentElement) : null;
        const inputStyle = input ? getComputedStyle(input) : null;
        const result = { trigger: trigger?.getAttribute('aria-haspopup'), menu: document.querySelector('.vcp-harness-menu-list[role="menu"]') !== null, menuMinWidth: menuStyle?.minWidth, menuRadius: menuStyle?.borderRadius, viewport: document.querySelector('.vcp-harness-menu-list .vcp-harness-menu-viewport') !== null, viewportDisplay: viewportStyle?.display, viewportDirection: viewportStyle?.flexDirection, itemWrap: document.querySelector('.vcp-harness-menu-list .vcp-harness-menu-item-wrap') !== null, item: item?.getAttribute('role'), minHeight: style?.minHeight, padding: style?.padding, itemGap: style?.gap, itemRadius: style?.borderRadius, itemFontSize: style?.fontSize, itemLineHeight: style?.lineHeight, expanded: trigger?.getAttribute('aria-expanded'), inputWrap: input?.parentElement?.className, inputWrapHeight: inputWrapStyle?.height, inputWrapGap: inputWrapStyle?.gap, inputWrapRadius: inputWrapStyle?.borderRadius, inputWrapPadding: inputWrapStyle?.padding, inputPadding: inputStyle?.padding, inputFontSize: inputStyle?.fontSize, inputLineHeight: inputStyle?.lineHeight, choiceClass: choice.classList.contains('vcp-uiux-choice'), choiceValue: choice.dataset.value, rangeWrap: range?.parentElement?.className, rangeOutput: rangeOutput?.textContent, toggleWrap: toggle?.parentElement?.className, toggleChecked: toggle?.checked, legacySliderDisplay: legacySlider?.style.display, colorPairWrap: color?.parentElement?.className, colorValue: color?.value, colorText: colorText?.value };
        result.selectedCheck = document.querySelector('[role="menuitem"][data-selected="true"] .vcp-harness-menu-item-check')?.hasAttribute('hidden') === false;
        for (const dispose of disposers.reverse()) dispose();
        result.toggleRestored = toggle?.parentElement?.id === 'artifact-toggle' && legacySlider?.style.display === '';
        host.remove();
        return result;
    });
    assert.deepEqual(primitiveBoundary, { trigger: 'menu', menu: true, menuMinWidth: '218px', menuRadius: '12px', viewport: true, viewportDisplay: 'flex', viewportDirection: 'column', itemWrap: true, selectedCheck: true, item: 'menuitem', minHeight: '40px', padding: '8px 10px', itemGap: '8px', itemRadius: '10px', itemFontSize: '14px', itemLineHeight: '22px', expanded: 'true', inputWrap: 'vcp-uiux-input-wrap wrap', inputWrapHeight: '32px', inputWrapGap: '6px', inputWrapRadius: '8px', inputWrapPadding: '0px 8px', inputPadding: '0px 10px', inputFontSize: '14px', inputLineHeight: '22px', choiceClass: true, choiceValue: 'b', rangeWrap: 'vcp-uiux-range', rangeOutput: '40px', toggleWrap: 'vcp-uiux-toggle', toggleChecked: true, legacySliderDisplay: 'none', toggleRestored: true, colorPairWrap: 'vcp-uiux-color-pair', colorValue: '#112233', colorText: '#112233' }, `generated artifact primitive contract mismatch: ${JSON.stringify(primitiveBoundary)}`);
    const candidateLabBoundary = await page.evaluate(async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-lab');
        const release = window.VCPUIUX.mountPrimitiveLabFromScope(host, scope);
        const result = {
            maturity: host.querySelector('.vcp-harness-primitive-lab')?.dataset.maturity || '',
            buttons: host.querySelectorAll('.vcp-harness-button.button').length,
            input: Boolean(host.querySelector('.vcp-uiux-input-wrap > .input')),
            field: Boolean(host.querySelector('.vcp-harness-field-head')),
            select: Boolean(host.querySelector('.vcp-harness-select-trigger')),
            menuRoot: Boolean(host.querySelector('.vcp-harness-menu-root')),
        };
        const menuTrigger = [...host.querySelectorAll('button')].find(button => button.textContent === 'View options');
        menuTrigger?.click();
        const atomMenu = document.querySelector('.vcp-harness-menu-list.vcp-harness-menu-portal');
        result.menuOpen = menuTrigger?.getAttribute('aria-expanded') === 'true' && atomMenu?.getAttribute('role') === 'menu';
        result.menuLabels = atomMenu?.querySelectorAll('.vcp-harness-menu-label').length || 0;
        result.menuSeparators = atomMenu?.querySelectorAll('[role="separator"]').length || 0;
        result.menuSelected = atomMenu?.querySelectorAll('.vcp-harness-menu-item-check').length || 0;
        result.menuDanger = Boolean(atomMenu?.querySelector('.vcp-harness-menu-item-danger'));
        const layout = [...(atomMenu?.querySelectorAll('[role="menuitem"]') || [])].find(item => item.textContent === 'Layout');
        let submenuOpen = false;
        for (let attempt = 0; attempt < 5 && !submenuOpen; attempt += 1) {
            // Exercise the owner event rather than relying on an Electron focus
            // side effect: the submenu contract is attached to the item wrap's
            // pointer entry (keyboard focus remains covered by focused tests).
            layout?.closest('.vcp-harness-menu-item-wrap')?.dispatchEvent(new MouseEvent('mouseenter'));
            await new Promise(resolve => setTimeout(resolve, 10));
            submenuOpen = Boolean(atomMenu?.querySelector('.vcp-harness-submenu[role="menu"]'));
        }
        result.menuSubmenu = submenuOpen;
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        result.menuOutsideClosed = menuTrigger?.getAttribute('aria-expanded') === 'false';
        menuTrigger?.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        result.menuEscapeClosed = menuTrigger?.getAttribute('aria-expanded') === 'false';
        const modalTrigger = [...host.querySelectorAll('button')].find(button => button.textContent === 'Open modal');
        modalTrigger?.click();
        let modalRoot = document.querySelector('.vcp-harness-modal-root');
        result.modalOpen = Boolean(modalRoot?.querySelector('[role="dialog"][aria-modal="true"][aria-label="Create workspace"]'));
        result.modalDescription = modalRoot?.querySelector('.vcp-harness-modal-description')?.textContent || '';
        result.modalBody = Boolean(modalRoot?.querySelector('.vcp-harness-modal-body'));
        result.modalFooter = modalRoot?.querySelectorAll('.vcp-harness-modal-footer > button').length || 0;
        result.modalCloseIcon = Boolean(modalRoot?.querySelector('.vcp-harness-modal-close svg[data-vcp-icon="close"]'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        result.modalEscapeClosed = !document.querySelector('.vcp-harness-modal-root');
        modalTrigger?.click();
        document.querySelector('.vcp-harness-modal-mask')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        result.modalMaskClosed = !document.querySelector('.vcp-harness-modal-root');
        modalTrigger?.click();
        document.querySelector('.vcp-harness-modal-close')?.click();
        result.modalButtonClosed = !document.querySelector('.vcp-harness-modal-root');
        const headlessTrigger = [...host.querySelectorAll('button')].find(button => button.textContent === 'Open headless');
        headlessTrigger?.click();
        modalRoot = document.querySelector('.vcp-harness-modal-root');
        result.modalHeadless = Boolean(modalRoot?.querySelector('.vcp-harness-lab-headless-modal'))
            && !modalRoot?.querySelector('.vcp-harness-modal-header')
            && !modalRoot?.querySelector('.vcp-harness-modal-footer');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        result.modalHeadlessClosed = !document.querySelector('.vcp-harness-modal-root');
        const tooltipAnchor = [...host.querySelectorAll('button')].find(button => button.textContent === 'Hover for details');
        tooltipAnchor?.dispatchEvent(new MouseEvent('mouseenter'));
        await new Promise(resolve => setTimeout(resolve, 140));
        // Tooltip is a body-owned portal; the anchor remains in the lab host.
        const tooltipBubble = document.querySelector('.vcp-harness-tooltip-bubble[role="tooltip"]');
        result.tooltipOpen = tooltipBubble?.textContent === 'Open workspace details';
        result.tooltipSide = tooltipBubble?.getAttribute('data-side') || '';
        tooltipAnchor?.dispatchEvent(new MouseEvent('mouseleave'));
        result.tooltipClosed = !document.querySelector('.vcp-harness-tooltip-bubble');
        const hoverRoot = [...host.querySelectorAll('.vcp-harness-hover-card-root')].find(node => node.textContent?.includes('Workspace path'));
        hoverRoot?.dispatchEvent(new PointerEvent('pointerenter'));
        await new Promise(resolve => setTimeout(resolve, 140));
        const hoverCard = document.querySelector('.vcp-harness-hover-card');
        result.hoverCardOpen = hoverCard?.parentElement === document.body;
        result.hoverCardCopyable = hoverCard?.getAttribute('role') === 'button' && hoverCard?.tabIndex === 0;
        result.hoverCardLabel = hoverCard?.getAttribute('aria-label') || '';
        hoverRoot?.dispatchEvent(new PointerEvent('pointerleave'));
        await new Promise(resolve => setTimeout(resolve, 220));
        result.hoverCardClosed = !document.querySelector('.vcp-harness-hover-card');
        const disclosure = host.querySelector('.vcp-harness-disclosure-row[role="button"]');
        result.disclosureCollapsed = disclosure?.getAttribute('aria-expanded') === 'false'
            && Boolean(disclosure?.querySelector('.vcp-harness-disclosure-icon-idle'))
            && Boolean(disclosure?.querySelector('.vcp-harness-disclosure-chevron-hover'));
        disclosure?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        result.disclosureOpen = disclosure?.getAttribute('aria-expanded') === 'true'
            && Boolean(host.querySelector('.vcp-harness-lab-disclosure-body'))
            && Boolean(disclosure?.querySelector('.vcp-harness-disclosure-chevron'));
        disclosure?.click();
        result.disclosureClosed = disclosure?.getAttribute('aria-expanded') === 'false'
            && !host.querySelector('.vcp-harness-lab-disclosure-body');
        result.stateDotStates = [...host.querySelectorAll('.vcp-harness-lab-state-dot-fixture')].map(fixture => fixture.getAttribute('data-state'));
        const ongoingDot = host.querySelector('.vcp-harness-state-matrix[data-state="ongoing"]');
        result.stateDotOngoingCells = ongoingDot?.querySelectorAll('rect').length || 0;
        result.stateDotAriaHidden = [...host.querySelectorAll('.vcp-harness-state-dot,.vcp-harness-state-matrix')].every(dot => dot.getAttribute('aria-hidden') === 'true');
        const toastTrigger = [...host.querySelectorAll('button')].find(button => button.textContent === 'Show toast');
        toastTrigger?.click();
        const toast = document.querySelector('.vcp-harness-toast[role="alert"]');
        result.toastOpen = toast?.parentElement === document.body;
        result.toastText = toast?.querySelector('.vcp-harness-toast-text')?.textContent || '';
        result.toastIcon = Boolean(toast?.querySelector('.vcp-harness-toast-icon[aria-hidden="true"] .vcp-ui-icon'));
        result.toastAnchorLeft = toast?.style.left || '';
        const riskTrigger = [...host.querySelectorAll('button')].find(button => button.textContent === 'Open risk confirmation');
        riskTrigger?.click();
        const riskDialog = document.querySelector('.vcp-harness-risk-confirmation[role="dialog"]');
        const riskCheckbox = riskDialog?.querySelector('.vcp-harness-risk-acknowledgement input');
        const riskConfirm = [...(riskDialog?.querySelectorAll('button') || [])].find(button => button.textContent === 'Allow command');
        result.riskOpen = Boolean(riskDialog);
        result.riskConfirmDisabled = riskConfirm?.disabled === true;
        result.riskAutofocus = document.activeElement === riskCheckbox;
        riskCheckbox?.click();
        result.riskAcknowledged = riskConfirm?.disabled === false;
        riskConfirm?.click();
        result.riskClosed = !document.querySelector('.vcp-harness-risk-confirmation[role="dialog"]');
        const icons = [...host.querySelectorAll('.vcp-harness-lab-icon-fixture')];
        await new Promise(resolve => setTimeout(resolve, 0));
        result.semanticIconNames = icons.map(fixture => fixture.getAttribute('data-icon'));
        result.semanticIconRendered = icons.every(fixture => {
            const icon = fixture.querySelector('.vcp-harness-icon-slot > svg[data-vcp-icon]');
            return icon?.getAttribute('aria-hidden') === 'true' && icon?.getAttribute('focusable') === 'false';
        });
        result.semanticIconGeometry = icons.map(fixture => {
            const slot = fixture.querySelector('.vcp-harness-icon-slot');
            const svg = slot?.querySelector('svg[data-vcp-icon]');
            const slotStyle = slot ? getComputedStyle(slot) : null;
            return { name: fixture.getAttribute('data-icon'), width: slotStyle?.width || '', height: slotStyle?.height || '', hasInheritedColor: Boolean(slotStyle?.color), ariaHidden: svg?.getAttribute('aria-hidden') || null, focusable: svg?.getAttribute('focusable') || null };
        });
        const seatButton = [...host.querySelectorAll('button')].find(button => button.classList.contains('vcp-agent-preset-seat'));
        result.agentPresetSeatMounted = seatButton?.getAttribute('aria-haspopup') === 'menu';
        result.agentPresetSeatInitial = seatButton?.textContent.includes('Standard mode') === true;
        seatButton?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const seatMenu = document.querySelector('.vcp-harness-menu-list.vcp-harness-menu-portal');
        result.agentPresetSeatOpen = seatButton?.getAttribute('aria-expanded') === 'true' && seatMenu?.parentElement === document.body;
        result.agentPresetSeatRows = [...(seatMenu?.querySelectorAll('.vcp-agent-preset-seat-item-name') || [])].map(name => name.textContent);
        result.agentPresetSeatSelectedRow = seatMenu?.querySelector('[data-selected="true"] .vcp-agent-preset-seat-item-name')?.textContent || '';
        seatMenu?.querySelectorAll('[role="menuitem"]')[1]?.click();
        // The lab pick demo stages busy for 600ms; let it drain so the busy
        // toggle below observes a settled trigger.
        await new Promise(resolve => setTimeout(resolve, 700));
        result.agentPresetSeatStaged = seatButton?.textContent.includes('Code mode') === true;
        result.agentPresetSeatClosedAfterPick = seatButton?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.vcp-harness-menu-list');
        const busyToggleBtn = [...host.querySelectorAll('button')].find(button => button.textContent === 'Toggle busy');
        busyToggleBtn?.click();
        result.agentPresetSeatBusyDisabled = seatButton?.disabled === true;
        busyToggleBtn?.click();
        const errorToggleBtn = [...host.querySelectorAll('button')].find(button => button.textContent === 'Set error');
        errorToggleBtn?.click();
        result.agentPresetSeatErrorTitle = seatButton?.getAttribute('title') || '';
        errorToggleBtn?.click();
        const languageTrigger = host.querySelector('.vcp-harness-language-row-selector');
        result.languageRowMounted = Boolean(languageTrigger)
            && languageTrigger?.getAttribute('aria-haspopup') === 'menu'
            && languageTrigger?.textContent?.includes('English') === true;
        languageTrigger?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const languageMenu = document.querySelector('.vcp-harness-menu-list.vcp-harness-menu-portal');
        result.languageRowOpen = languageTrigger?.getAttribute('aria-expanded') === 'true'
            && Boolean(languageMenu?.querySelector('[role="menuitem"]'));
        [...(languageMenu?.querySelectorAll('[role="menuitem"]') || [])]
            .find(item => item.textContent === 'Simplified Chinese')?.click();
        result.languageRowSelected = languageTrigger?.textContent?.includes('Simplified Chinese') === true;
        await release();
        result.restored = host.childNodes.length === 0;
        result.scopeActive = scope.active;
        host.remove();
        return result;
    });
    assert.deepEqual(candidateLabBoundary, {
        maturity: 'candidate',
        buttons: 17,
        input: true,
        field: true,
        select: true,
        menuRoot: true,
        menuOpen: true,
        menuLabels: 2,
        menuSeparators: 1,
        menuSelected: 2,
        menuDanger: true,
        menuSubmenu: true,
        menuOutsideClosed: true,
        menuEscapeClosed: true,
        modalOpen: true,
        modalDescription: 'Choose a name and location for the workspace.',
        modalBody: true,
        modalFooter: 2,
        modalCloseIcon: true,
        modalEscapeClosed: true,
        modalMaskClosed: true,
        modalButtonClosed: true,
        modalHeadless: true,
        modalHeadlessClosed: true,
        tooltipOpen: true,
        tooltipSide: 'top',
        tooltipClosed: true,
        hoverCardOpen: true,
        hoverCardCopyable: true,
        hoverCardLabel: 'Copy path: /Users/asahi/Documents/Codex/VCPChat-newarchitecture',
        hoverCardClosed: true,
        disclosureCollapsed: true,
        disclosureOpen: true,
        disclosureClosed: true,
        stateDotStates: ['done', 'warning', 'ongoing', 'error'],
        stateDotOngoingCells: 8,
        stateDotAriaHidden: true,
        toastOpen: true,
        toastText: 'The selected model is temporarily unavailable.',
        toastIcon: true,
        toastAnchorLeft: candidateLabBoundary.toastAnchorLeft,
        riskOpen: true,
        riskConfirmDisabled: true,
        riskAutofocus: true,
        riskAcknowledged: true,
        riskClosed: true,
        semanticIconNames: ['warning', 'close', 'check', 'chevron-down'],
        semanticIconRendered: true,
        semanticIconGeometry: [
            { name: 'warning', width: '18px', height: '18px', hasInheritedColor: true, ariaHidden: 'true', focusable: 'false' },
            { name: 'close', width: '16px', height: '16px', hasInheritedColor: true, ariaHidden: 'true', focusable: 'false' },
            { name: 'check', width: '16px', height: '16px', hasInheritedColor: true, ariaHidden: 'true', focusable: 'false' },
            { name: 'chevron-down', width: '16px', height: '16px', hasInheritedColor: true, ariaHidden: 'true', focusable: 'false' },
        ],
        agentPresetSeatMounted: true,
        agentPresetSeatInitial: true,
        agentPresetSeatOpen: true,
        agentPresetSeatRows: ['Standard mode', 'Code mode', 'Minimal mode'],
        agentPresetSeatSelectedRow: 'Standard mode',
        agentPresetSeatStaged: true,
        agentPresetSeatClosedAfterPick: true,
        agentPresetSeatBusyDisabled: true,
        agentPresetSeatErrorTitle: 'Could not stage the preset. Try again.',
        languageRowMounted: true,
        languageRowOpen: true,
        languageRowSelected: true,
        restored: true,
        scopeActive: true,
    }, `generated Harness Candidate Lab mismatch: ${JSON.stringify(candidateLabBoundary)}`);
    const menuCandidateGeometry = await page.evaluate(() => {
        const host = document.createElement('div');
        host.dataset.electronCandidateMenu = 'true';
        host.className = 'vcp-ui-scope';
        host.style.cssText = 'position:fixed;left:40px;top:40px;z-index:1000;padding:16px;background:#fff;color:#0f1115';
        document.body.append(host);
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.textContent = 'View options';
        host.append(trigger);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-menu-visual');
        const controller = window.VCPUIUX.mountMenu(trigger, {
            portal: true,
            dense: true,
            open: true,
            selectedIds: ['workspace', 'updated'],
            items: [
                { type: 'label', id: 'group-label', text: 'Group by' },
                { id: 'workspace', label: 'Workspace' },
                { id: 'flat', label: 'Flat list' },
                { type: 'separator', id: 'order-separator' },
                { type: 'label', id: 'order-label', text: 'Order by' },
                { id: 'manual', label: 'Manual' },
                { id: 'updated', label: 'Recently updated' },
                { id: 'disabled', label: 'Unavailable', disabled: true },
                { id: 'danger', label: 'Remove view', danger: true },
                { id: 'layout', label: 'Layout', submenu: [{ id: 'list', label: 'List' }, { id: 'grid', label: 'Grid' }] },
            ],
            footer: [{ id: 'settings', label: 'View settings' }],
            onSelect: () => {},
        }, scope);
        window.__harnessCandidateMenuController = controller;
        window.__harnessCandidateMenuScope = scope;
        const menu = document.querySelector('.vcp-harness-menu-list.vcp-harness-menu-portal');
        const layout = [...(menu?.querySelectorAll('[role="menuitem"]') || [])].find(item => item.textContent === 'Layout');
        layout?.focus();
        // Submenus are owned by the item wrapper's pointer-entry contract.
        // Electron's synthetic focus can be delivered before the listener is
        // observable in this geometry probe, so replay the semantic pointer
        // entry explicitly and sample the resulting DOM in the same task.
        layout?.closest('.vcp-harness-menu-item-wrap')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        const menuStyle = menu ? getComputedStyle(menu) : null;
        const item = menu?.querySelector('[role="menuitem"]');
        const itemStyle = item ? getComputedStyle(item) : null;
        const rect = menu?.getBoundingClientRect();
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio },
            source: 'generated-artifact-electron',
            state: 'open-selected-disabled-danger-submenu',
            rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
            menu: menuStyle ? { padding: menuStyle.padding, borderRadius: menuStyle.borderRadius, minWidth: menuStyle.minWidth, maxWidth: menuStyle.maxWidth, position: menuStyle.position } : null,
            item: itemStyle ? { minHeight: itemStyle.minHeight, padding: itemStyle.padding, gap: itemStyle.gap, borderRadius: itemStyle.borderRadius, fontSize: itemStyle.fontSize, lineHeight: itemStyle.lineHeight } : null,
            labels: menu?.querySelectorAll('.vcp-harness-menu-label').length || 0,
            separators: menu?.querySelectorAll('[role="separator"]').length || 0,
            selected: menu?.querySelectorAll('.vcp-harness-menu-item-check').length || 0,
            disabled: menu?.querySelectorAll('[role="menuitem"]:disabled').length || 0,
            danger: menu?.querySelectorAll('.vcp-harness-menu-item-danger').length || 0,
            submenu: menu?.querySelectorAll('.vcp-harness-submenu[role="menu"]').length || 0,
        };
    });
    assert.deepEqual(menuCandidateGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(menuCandidateGeometry.menu, { padding: '4px', borderRadius: '12px', minWidth: '218px', maxWidth: '360px', position: 'fixed' });
    assert.deepEqual(menuCandidateGeometry.item, { minHeight: '34px', padding: '5px 10px', gap: '8px', borderRadius: '10px', fontSize: '14px', lineHeight: '22px' });
    assert.deepEqual({ labels: menuCandidateGeometry.labels, separators: menuCandidateGeometry.separators, selected: menuCandidateGeometry.selected, disabled: menuCandidateGeometry.disabled, danger: menuCandidateGeometry.danger, submenu: menuCandidateGeometry.submenu }, { labels: 2, separators: 1, selected: 2, disabled: 1, danger: 1, submenu: 1 });
    const menuCandidateScreenshot = path.join(root, 'reports', 'vcp-harness-menu-candidate.png');
    await page.screenshot({ path: menuCandidateScreenshot });
    assert.ok((await fs.stat(menuCandidateScreenshot)).size > 1024, 'Menu Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-menu-candidate.json'), `${JSON.stringify(menuCandidateGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        await window.__harnessCandidateMenuController?.dispose?.();
        await window.__harnessCandidateMenuScope?.dispose?.('candidate-menu-visual-complete');
        delete window.__harnessCandidateMenuController;
        delete window.__harnessCandidateMenuScope;
        document.querySelector('[data-electron-candidate-menu]')?.remove();
    });
    const modalCandidateGeometry = await page.evaluate(() => {
        const body = document.createElement('div');
        body.textContent = 'Create a workspace without leaving the current page.';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        const create = document.createElement('button');
        create.textContent = 'Create';
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-modal-visual');
        window.VCPUIUX.mountButton(cancel, { variant: 'outline', size: 'sm' }, scope);
        window.VCPUIUX.mountButton(create, { variant: 'primary', size: 'sm' }, scope);
        const controller = window.VCPUIUX.mountModal({
            title: 'Create workspace',
            closeLabel: 'Close dialog',
            description: 'Choose a name and location for the workspace.',
            body,
            footer: [cancel, create],
            open: true,
            onClose: () => controller.setOpen(false),
        }, scope);
        window.__harnessCandidateModalController = controller;
        window.__harnessCandidateModalScope = scope;
        const root = document.querySelector('.vcp-harness-modal-root');
        const mask = root?.querySelector('.vcp-harness-modal-mask');
        const dialog = root?.querySelector('.vcp-harness-modal-dialog');
        const header = root?.querySelector('.vcp-harness-modal-header');
        const title = root?.querySelector('.vcp-harness-modal-title');
        const footer = root?.querySelector('.vcp-harness-modal-footer');
        const rootStyle = root ? getComputedStyle(root) : null;
        const maskStyle = mask ? getComputedStyle(mask) : null;
        const dialogStyle = dialog ? getComputedStyle(dialog) : null;
        const headerStyle = header ? getComputedStyle(header) : null;
        const titleStyle = title ? getComputedStyle(title) : null;
        const footerStyle = footer ? getComputedStyle(footer) : null;
        const rect = dialog?.getBoundingClientRect();
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio },
            source: 'generated-artifact-electron',
            state: 'standard-open-description-body-footer',
            rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
            root: rootStyle ? { position: rootStyle.position, inset: rootStyle.inset, zIndex: rootStyle.zIndex, padding: rootStyle.padding } : null,
            mask: maskStyle ? { backgroundColor: maskStyle.backgroundColor, backdropFilter: maskStyle.backdropFilter } : null,
            dialog: dialogStyle ? { width: dialogStyle.width, padding: dialogStyle.padding, gap: dialogStyle.gap, borderRadius: dialogStyle.borderRadius } : null,
            header: headerStyle ? { padding: headerStyle.padding, gap: headerStyle.gap } : null,
            title: titleStyle ? { fontSize: titleStyle.fontSize, lineHeight: titleStyle.lineHeight, fontWeight: titleStyle.fontWeight } : null,
            footer: footerStyle ? { padding: footerStyle.padding, gap: footerStyle.gap, justifyContent: footerStyle.justifyContent } : null,
            closeIcon: Boolean(root?.querySelector('.vcp-harness-modal-close svg[data-vcp-icon="close"]')),
        };
    });
    assert.deepEqual(modalCandidateGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(modalCandidateGeometry.root, { position: 'fixed', inset: '0px', zIndex: '1000', padding: '24px' });
    assert.deepEqual(modalCandidateGeometry.dialog, { width: '380px', padding: '0px 0px 24px', gap: '20px', borderRadius: '24px' });
    assert.deepEqual(modalCandidateGeometry.header, { padding: '22px 14px 12px 24px', gap: '8px' });
    assert.deepEqual(modalCandidateGeometry.title, { fontSize: '16px', lineHeight: '24px', fontWeight: '500' });
    assert.deepEqual(modalCandidateGeometry.footer, { padding: '0px 24px', gap: '8px', justifyContent: 'flex-end' });
    assert.equal(modalCandidateGeometry.closeIcon, true);
    const modalCandidateScreenshot = path.join(root, 'reports', 'vcp-harness-modal-candidate.png');
    await page.screenshot({ path: modalCandidateScreenshot });
    assert.ok((await fs.stat(modalCandidateScreenshot)).size > 1024, 'Modal Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-modal-candidate.json'), `${JSON.stringify(modalCandidateGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        await window.__harnessCandidateModalController?.dispose?.();
        await window.__harnessCandidateModalScope?.dispose?.('candidate-modal-visual-complete');
        delete window.__harnessCandidateModalController;
        delete window.__harnessCandidateModalScope;
    });
    const tooltipHoverCardGeometry = await page.evaluate(async () => {
        const host = document.createElement('section');
        host.dataset.electronCandidateTooltipHoverCard = 'true';
        host.className = 'vcp-ui-scope';
        host.style.cssText = 'position:fixed;left:48px;top:80px;z-index:1200;display:grid;gap:72px;width:260px;padding:24px;background:#fff;color:#0f1115;border:1px solid rgba(0,0,0,.08);border-radius:12px';
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-tooltip-hover-card-visual');
        const tooltipAnchor = document.createElement('button');
        tooltipAnchor.type = 'button';
        tooltipAnchor.textContent = 'Workspace details';
        host.append(tooltipAnchor);
        window.VCPUIUX.mountButton(tooltipAnchor, { variant: 'toolbar', size: 'sm' }, scope);
        const tooltip = window.VCPUIUX.mountTooltip(tooltipAnchor, { label: 'Open workspace details', side: 'bottom', maxWidth: 240 }, scope);
        tooltipAnchor.focus();
        // Drive the hover contract explicitly. Window focus can remain on the
        // host page in artifact-only Electron runs, while pointerenter is the
        // deterministic visual trigger for this fixture.
        tooltipAnchor.dispatchEvent(new PointerEvent('pointerenter'));
        const hoverAnchor = document.createElement('div');
        hoverAnchor.textContent = 'Workspace path';
        hoverAnchor.style.cssText = 'padding:10px 12px;border:1px solid rgba(0,0,0,.12);border-radius:8px';
        host.append(hoverAnchor);
        const content = document.createElement('div');
        content.textContent = '/Users/asahi/Documents/Codex/VCPChat-newarchitecture';
        content.style.cssText = 'font-size:13px;line-height:20px;overflow-wrap:anywhere';
        const hoverCard = window.VCPUIUX.mountHoverCard(hoverAnchor, { content, openDelayMs: 0, copyText: '/Users/asahi/Documents/Codex/VCPChat-newarchitecture', copyLabel: 'Copy path', copiedLabel: 'Copied' }, scope);
        hoverCard.root.dispatchEvent(new PointerEvent('pointerenter'));
        // Wait for the owner-controlled portals to reach their observable
        // open state instead of assuming a fixed timer is enough on every
        // Electron run. The timeout keeps a broken mount diagnostic rather
        // than allowing an unbounded evidence journey.
        const deadline = Date.now() + 1000;
        while ((!tooltip.open || !hoverCard.open) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const bubble = tooltip.bubble;
        const card = hoverCard.card;
        const bubbleStyle = bubble ? getComputedStyle(bubble) : null;
        const cardStyle = card ? getComputedStyle(card) : null;
        const rootStyle = getComputedStyle(hoverCard.root);
        const bubbleRect = bubble?.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        window.__harnessCandidateTooltipController = tooltip;
        window.__harnessCandidateHoverCardController = hoverCard;
        window.__harnessCandidateTooltipHoverCardScope = scope;
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio },
            source: 'generated-artifact-electron',
            tooltip: {
                text: bubble?.textContent || '',
                side: bubble?.dataset.side || '',
                rect: bubbleRect ? { x: bubbleRect.x, y: bubbleRect.y, width: bubbleRect.width, height: bubbleRect.height } : null,
                style: bubbleStyle ? { position: bubbleStyle.position, zIndex: bubbleStyle.zIndex, padding: bubbleStyle.padding, borderRadius: bubbleStyle.borderRadius, fontSize: bubbleStyle.fontSize, lineHeight: bubbleStyle.lineHeight, maxWidth: bubbleStyle.maxWidth, backgroundColor: bubbleStyle.backgroundColor, color: bubbleStyle.color } : null,
            },
            hoverCard: {
                role: card?.getAttribute('role') || null,
                tabIndex: card?.tabIndex ?? null,
                ariaLabel: card?.getAttribute('aria-label') || null,
                rect: cardRect ? { x: cardRect.x, y: cardRect.y, width: cardRect.width, height: cardRect.height } : null,
                root: { position: rootStyle.position, display: rootStyle.display },
                style: cardStyle ? { position: cardStyle.position, zIndex: cardStyle.zIndex, width: cardStyle.width, padding: cardStyle.padding, borderRadius: cardStyle.borderRadius, backgroundColor: cardStyle.backgroundColor } : null,
            },
        };
    });
    assert.deepEqual(tooltipHoverCardGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(tooltipHoverCardGeometry.tooltip.style, { position: 'fixed', zIndex: '100', padding: '3px 7px', borderRadius: '8px', fontSize: '13px', lineHeight: '20px', maxWidth: '240px', backgroundColor: 'rgb(44, 44, 46)', color: 'rgb(255, 255, 255)' });
    assert.equal(tooltipHoverCardGeometry.tooltip.text, 'Open workspace details');
    assert.equal(tooltipHoverCardGeometry.tooltip.side, 'bottom');
    assert.deepEqual(tooltipHoverCardGeometry.hoverCard.root, { position: 'relative', display: 'block' });
    assert.deepEqual(tooltipHoverCardGeometry.hoverCard.style, { position: 'fixed', zIndex: '100', width: '244px', padding: '12px 16px', borderRadius: '12px', backgroundColor: 'rgb(44, 44, 46)' });
    assert.equal(tooltipHoverCardGeometry.hoverCard.role, 'button');
    assert.equal(tooltipHoverCardGeometry.hoverCard.tabIndex, 0);
    const tooltipHoverCardScreenshot = path.join(root, 'reports', 'vcp-harness-tooltip-hover-card-candidate.png');
    await page.screenshot({ path: tooltipHoverCardScreenshot });
    assert.ok((await fs.stat(tooltipHoverCardScreenshot)).size > 1024, 'Tooltip/HoverCard Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-tooltip-hover-card-candidate.json'), `${JSON.stringify(tooltipHoverCardGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        await window.__harnessCandidateTooltipController?.dispose?.();
        await window.__harnessCandidateHoverCardController?.dispose?.();
        await window.__harnessCandidateTooltipHoverCardScope?.dispose?.('candidate-tooltip-hover-card-visual-complete');
        delete window.__harnessCandidateTooltipController;
        delete window.__harnessCandidateHoverCardController;
        delete window.__harnessCandidateTooltipHoverCardScope;
        document.querySelector('[data-electron-candidate-tooltip-hover-card]')?.remove();
    });
    const disclosureGeometry = await page.evaluate(() => {
        const host = document.createElement('section');
        host.dataset.electronCandidateDisclosure = 'true';
        host.className = 'vcp-ui-scope';
        host.style.cssText = 'position:fixed;left:64px;top:96px;z-index:1200;width:520px;padding:24px;background:#fff;color:#0f1115;border:1px solid rgba(0,0,0,.08);border-radius:12px';
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-disclosure-visual');
        const icon = document.createElement('span');
        icon.className = 'vcp-ui-icon';
        icon.textContent = 'terminal';
        const summary = document.createElement('span');
        summary.textContent = ' · npm run check:uiux';
        summary.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#737780;font-size:13px;line-height:20px';
        const body = document.createElement('div');
        body.textContent = 'UIUX contract verification completed successfully.';
        body.style.cssText = 'margin-top:8px;padding:12px 16px;border-radius:12px;background:#2c2c2e;color:#fff;font-size:13px;line-height:20px';
        let controller;
        controller = window.VCPUIUX.mountDisclosureRow(host, {
            icon,
            title: 'Terminal',
            open: false,
            expandable: true,
            expandOnRowClick: true,
            keepContentWhenOpen: true,
            collapsedContent: summary,
            children: body,
            onToggle: () => controller.setOpen(!controller.open),
        }, scope);
        controller.setOpen(true);
        const row = controller.row;
        const leading = controller.leading;
        const title = row.querySelector('.vcp-harness-disclosure-title');
        const rootStyle = getComputedStyle(controller.root);
        const rowStyle = getComputedStyle(row);
        const leadingStyle = getComputedStyle(leading);
        const titleStyle = title ? getComputedStyle(title) : null;
        const rect = row.getBoundingClientRect();
        window.__harnessCandidateDisclosureController = controller;
        window.__harnessCandidateDisclosureScope = scope;
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio },
            source: 'generated-artifact-electron',
            state: 'row-click-open-keep-content',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            root: { display: rootStyle.display, flexDirection: rootStyle.flexDirection, width: rootStyle.width, minWidth: rootStyle.minWidth },
            row: { display: rowStyle.display, alignItems: rowStyle.alignItems, height: rowStyle.height, overflow: rowStyle.overflow, role: row.getAttribute('role'), tabIndex: row.tabIndex, ariaExpanded: row.getAttribute('aria-expanded') },
            leading: { tag: leading.tagName, width: leadingStyle.width, height: leadingStyle.height, marginRight: leadingStyle.marginRight, padding: leadingStyle.padding, borderWidth: leadingStyle.borderWidth, chevron: Boolean(leading.querySelector('svg[data-vcp-icon="chevron_down"],svg[data-vcp-icon="chevron-down"]')) },
            title: titleStyle ? { text: title?.textContent || '', fontSize: titleStyle.fontSize, lineHeight: titleStyle.lineHeight } : null,
            summaryVisible: summary.parentElement === row,
            bodyVisible: body.parentElement === controller.root,
        };
    });
    assert.deepEqual(disclosureGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.equal(disclosureGeometry.rect.height, 24);
    assert.deepEqual(disclosureGeometry.root, { display: 'flex', flexDirection: 'column', width: '470px', minWidth: '0px' });
    assert.deepEqual(disclosureGeometry.row, { display: 'flex', alignItems: 'center', height: '24px', overflow: 'hidden', role: 'button', tabIndex: 0, ariaExpanded: 'true' });
    assert.deepEqual(disclosureGeometry.leading, { tag: 'SPAN', width: '16px', height: '16px', marginRight: '6px', padding: '0px', borderWidth: '0px', chevron: true });
    assert.deepEqual(disclosureGeometry.title, { text: 'Terminal', fontSize: '14px', lineHeight: '24px' });
    assert.equal(disclosureGeometry.summaryVisible, true);
    assert.equal(disclosureGeometry.bodyVisible, true);
    const disclosureScreenshot = path.join(root, 'reports', 'vcp-harness-disclosure-row-candidate.png');
    await page.screenshot({ path: disclosureScreenshot });
    assert.ok((await fs.stat(disclosureScreenshot)).size > 1024, 'DisclosureRow Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-disclosure-row-candidate.json'), `${JSON.stringify(disclosureGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        await window.__harnessCandidateDisclosureController?.dispose?.();
        await window.__harnessCandidateDisclosureScope?.dispose?.('candidate-disclosure-visual-complete');
        delete window.__harnessCandidateDisclosureController;
        delete window.__harnessCandidateDisclosureScope;
        document.querySelector('[data-electron-candidate-disclosure]')?.remove();
    });
    const stateDotGeometry = await page.evaluate(() => {
        const host = document.createElement('section');
        host.dataset.electronCandidateStateDot = 'true';
        host.className = 'vcp-ui-scope';
        host.style.cssText = 'position:fixed;left:64px;top:96px;z-index:1200;display:flex;align-items:center;gap:28px;padding:24px;background:#fff;color:#0f1115;border:1px solid rgba(0,0,0,.08);border-radius:12px';
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-state-dot-visual');
        const controllers = [];
        for (const state of ['done', 'warning', 'ongoing', 'error']) {
            const fixture = document.createElement('span');
            fixture.style.cssText = 'display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:20px';
            const dotHost = document.createElement('span');
            const label = document.createElement('span');
            label.textContent = state;
            fixture.append(dotHost, label);
            host.append(fixture);
            controllers.push(window.VCPUIUX.mountStateDot(dotHost, { state }, scope));
        }
        const dots = [...host.querySelectorAll('.vcp-harness-state-dot,.vcp-harness-state-matrix')];
        const states = dots.map(dot => {
            const rect = dot.getBoundingClientRect();
            const style = getComputedStyle(dot);
            return {
                state: dot.getAttribute('data-state'),
                tag: dot.tagName,
                ariaHidden: dot.getAttribute('aria-hidden'),
                rect: { width: rect.width, height: rect.height },
                color: style.color,
                cells: dot.querySelectorAll('rect').length,
                delays: [...dot.querySelectorAll('rect')].map(cell => cell.style.animationDelay),
                animation: dot.querySelector('rect') ? getComputedStyle(dot.querySelector('rect')).animationName : null,
            };
        });
        window.__harnessCandidateStateDotControllers = controllers;
        window.__harnessCandidateStateDotScope = scope;
        return { viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio }, source: 'generated-artifact-electron', states };
    });
    assert.deepEqual(stateDotGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(stateDotGeometry.states.map(item => ({ state: item.state, tag: item.tag, ariaHidden: item.ariaHidden, rect: item.rect, cells: item.cells })), [
        { state: 'done', tag: 'SPAN', ariaHidden: 'true', rect: { width: 10, height: 10 }, cells: 0 },
        { state: 'warning', tag: 'SPAN', ariaHidden: 'true', rect: { width: 10, height: 10 }, cells: 0 },
        { state: 'ongoing', tag: 'svg', ariaHidden: 'true', rect: { width: 10, height: 10 }, cells: 8 },
        { state: 'error', tag: 'SPAN', ariaHidden: 'true', rect: { width: 10, height: 10 }, cells: 0 },
    ]);
    assert.deepEqual(stateDotGeometry.states[2].delays, ['-1000ms', '-875ms', '-750ms', '-625ms', '-500ms', '-375ms', '-250ms', '-125ms']);
    assert.equal(stateDotGeometry.states[2].animation, 'vcp-harness-state-dot-chase');
    assert.equal(stateDotGeometry.states[2].color, 'rgb(86, 134, 254)');
    const stateDotScreenshot = path.join(root, 'reports', 'vcp-harness-state-dot-candidate.png');
    await page.screenshot({ path: stateDotScreenshot });
    assert.ok((await fs.stat(stateDotScreenshot)).size > 1024, 'StateDot Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-state-dot-candidate.json'), `${JSON.stringify(stateDotGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        for (const controller of window.__harnessCandidateStateDotControllers || []) await controller.dispose?.();
        await window.__harnessCandidateStateDotScope?.dispose?.('candidate-state-dot-visual-complete');
        delete window.__harnessCandidateStateDotControllers;
        delete window.__harnessCandidateStateDotScope;
        document.querySelector('[data-electron-candidate-state-dot]')?.remove();
    });
    const toastCandidateGeometry = await page.evaluate(() => {
        const host = document.createElement('section');
        host.dataset.electronCandidateToast = 'true';
        host.style.cssText = 'position:fixed;left:240px;top:300px;width:200px;height:40px';
        const anchor = document.createElement('button');
        anchor.textContent = 'Anchor';
        anchor.style.cssText = 'position:absolute;left:20px;top:0;width:160px;height:40px';
        host.append(anchor);
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-toast-visual');
        const icon = document.createElement('span');
        icon.className = 'vcp-ui-icon';
        icon.dataset.vcpIcon = 'info';
        const controller = window.VCPUIUX.mountToast({ text: 'The selected model is temporarily unavailable.', icon, anchor, onDone: () => {} }, scope);
        window.__harnessCandidateToastController = controller;
        window.__harnessCandidateToastScope = scope;
        controller.root.style.animation = 'none';
        const style = getComputedStyle(controller.root);
        const rect = controller.root.getBoundingClientRect();
        return {
            viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }, settled: true,
            source: 'generated-artifact-electron', state: 'anchor-centered-icon-alert',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            style: { position: style.position, top: style.top, left: style.left, zIndex: style.zIndex, pointerEvents: style.pointerEvents, gap: style.gap, padding: style.padding, borderRadius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight },
            role: controller.root.getAttribute('role'), iconAriaHidden: controller.root.querySelector('.vcp-harness-toast-icon')?.getAttribute('aria-hidden'),
            anchorCenter: anchor.getBoundingClientRect().left + anchor.getBoundingClientRect().width / 2,
        };
    });
    assert.deepEqual(toastCandidateGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(toastCandidateGeometry.style, { position: 'fixed', top: '120px', left: '340px', zIndex: '1100', pointerEvents: 'none', gap: '10px', padding: '12px 16px', borderRadius: '14px', fontSize: '14px', lineHeight: '22px' });
    assert.equal(toastCandidateGeometry.role, 'alert');
    assert.equal(toastCandidateGeometry.iconAriaHidden, 'true');
    assert.equal(toastCandidateGeometry.rect.x, toastCandidateGeometry.anchorCenter - toastCandidateGeometry.rect.width / 2);
    const toastCandidateScreenshot = path.join(root, 'reports', 'vcp-harness-toast-candidate.png');
    await page.screenshot({ path: toastCandidateScreenshot });
    assert.ok((await fs.stat(toastCandidateScreenshot)).size > 1024, 'Toast Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-toast-candidate.json'), `${JSON.stringify(toastCandidateGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        await window.__harnessCandidateToastController?.dispose?.();
        await window.__harnessCandidateToastScope?.dispose?.('candidate-toast-visual-complete');
        document.querySelector('[data-electron-candidate-toast]')?.remove();
        document.querySelector('.vcp-harness-toast')?.remove();
    });
    const riskConfirmationGeometry = await page.evaluate(() => {
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-risk-confirmation-visual');
        let controller;
        controller = window.VCPUIUX.mountRiskConfirmation({
            title: 'Allow external command?', description: 'This action may access files outside the current workspace.',
            acknowledgeLabel: 'I understand the risk.', cancelLabel: 'Cancel', confirmLabel: 'Allow command', acknowledged: false,
            onAcknowledgedChange: value => controller.setAcknowledged(value), onCancel: () => controller.setOpen(false), onConfirm: () => controller.setOpen(false), open: true,
        }, scope);
        window.__harnessCandidateRiskController = controller;
        window.__harnessCandidateRiskScope = scope;
        const dialog = controller.modal.dialog;
        const warning = dialog.querySelector('.vcp-harness-risk-warning');
        const acknowledgement = dialog.querySelector('.vcp-harness-risk-acknowledgement');
        const dialogStyle = getComputedStyle(dialog);
        const warningStyle = getComputedStyle(warning);
        const acknowledgementStyle = getComputedStyle(acknowledgement);
        return {
            viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }, source: 'generated-artifact-electron', state: 'unacknowledged-autofocused',
            dialog: { width: dialogStyle.width, maxHeight: dialogStyle.maxHeight, overflow: dialogStyle.overflow, role: dialog.getAttribute('role'), ariaModal: dialog.getAttribute('aria-modal') },
            warning: { gap: warningStyle.gap, fontSize: warningStyle.fontSize, lineHeight: warningStyle.lineHeight },
            acknowledgement: { gap: acknowledgementStyle.gap, marginTop: acknowledgementStyle.marginTop, fontSize: acknowledgementStyle.fontSize, lineHeight: acknowledgementStyle.lineHeight, checked: controller.acknowledgement.checked, disabled: controller.acknowledgement.disabled, autofocus: document.activeElement === controller.acknowledgement },
            actions: { cancelMinWidth: getComputedStyle([...dialog.querySelectorAll('button')].find(button => button.textContent === 'Cancel')).minWidth, confirmMinWidth: getComputedStyle(controller.confirmButton).minWidth, confirmDisabled: controller.confirmButton.disabled },
        };
    });
    assert.deepEqual(riskConfirmationGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(riskConfirmationGeometry.dialog, { width: '440px', maxHeight: '552px', overflow: 'hidden', role: 'dialog', ariaModal: 'true' });
    assert.deepEqual(riskConfirmationGeometry.warning, { gap: '10px', fontSize: '14px', lineHeight: '22px' });
    assert.deepEqual(riskConfirmationGeometry.acknowledgement, { gap: '10px', marginTop: '20px', fontSize: '14px', lineHeight: '22px', checked: false, disabled: false, autofocus: true });
    assert.deepEqual(riskConfirmationGeometry.actions, { cancelMinWidth: '72px', confirmMinWidth: '136px', confirmDisabled: true });
    const riskConfirmationScreenshot = path.join(root, 'reports', 'vcp-harness-risk-confirmation-candidate.png');
    await page.screenshot({ path: riskConfirmationScreenshot });
    assert.ok((await fs.stat(riskConfirmationScreenshot)).size > 1024, 'RiskConfirmation Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-risk-confirmation-candidate.json'), `${JSON.stringify(riskConfirmationGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        await window.__harnessCandidateRiskController?.dispose?.();
        await window.__harnessCandidateRiskScope?.dispose?.('candidate-risk-confirmation-visual-complete');
        delete window.__harnessCandidateRiskController;
        delete window.__harnessCandidateRiskScope;
    });
    const semanticIconGeometry = await page.evaluate(async () => {
        const host = document.createElement('div');
        host.dataset.electronCandidateSemanticIcons = 'true';
        host.className = 'vcp-ui-scope';
        host.style.cssText = 'position:fixed;left:80px;top:120px;display:flex;align-items:center;gap:16px;padding:24px;background:#fff;color:#2678ff;border:1px solid rgba(0,0,0,.08);border-radius:12px';
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-semantic-icons-visual');
        const controllers = [];
        for (const [name, size] of [['warning', 18], ['close', 16], ['check', 16], ['chevron-down', 14]]) {
            const fixture = document.createElement('span');
            fixture.dataset.icon = name;
            const iconHost = document.createElement('span');
            fixture.append(iconHost, document.createTextNode(name));
            host.append(fixture);
            controllers.push(window.VCPUIUX.mountSemanticIcon(iconHost, { name, size }, scope));
        }
        await new Promise(resolve => setTimeout(resolve, 0));
        const states = [...host.querySelectorAll('[data-icon]')].map(fixture => {
            const slot = fixture.querySelector('.vcp-harness-icon-slot');
            const svg = slot?.querySelector('svg[data-vcp-icon]');
            const style = slot ? getComputedStyle(slot) : null;
            return { name: fixture.dataset.icon, width: style?.width || '', height: style?.height || '', color: style?.color || '', ariaHidden: svg?.getAttribute('aria-hidden') || null, focusable: svg?.getAttribute('focusable') || null, dataIcon: svg?.getAttribute('data-vcp-icon') || null };
        });
        const screenshot = { viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }, source: 'generated-artifact-electron', state: 'four-semantic-icons-current-color', states };
        window.__harnessCandidateSemanticIconControllers = controllers;
        window.__harnessCandidateSemanticIconScope = scope;
        return screenshot;
    });
    assert.deepEqual(semanticIconGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(semanticIconGeometry.states, [
        { name: 'warning', width: '18px', height: '18px', color: semanticIconGeometry.states[0].color, ariaHidden: 'true', focusable: 'false', dataIcon: 'warning' },
        { name: 'close', width: '16px', height: '16px', color: semanticIconGeometry.states[0].color, ariaHidden: 'true', focusable: 'false', dataIcon: 'close' },
        { name: 'check', width: '16px', height: '16px', color: semanticIconGeometry.states[0].color, ariaHidden: 'true', focusable: 'false', dataIcon: 'check' },
        { name: 'chevron-down', width: '14px', height: '14px', color: semanticIconGeometry.states[0].color, ariaHidden: 'true', focusable: 'false', dataIcon: 'chevron_down' },
    ]);
    const semanticIconScreenshot = path.join(root, 'reports', 'vcp-harness-semantic-icons-candidate.png');
    await page.screenshot({ path: semanticIconScreenshot });
    assert.ok((await fs.stat(semanticIconScreenshot)).size > 1024, 'Semantic icon Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-semantic-icons-candidate.json'), `${JSON.stringify(semanticIconGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        for (const controller of window.__harnessCandidateSemanticIconControllers || []) await controller.dispose?.();
        await window.__harnessCandidateSemanticIconScope?.dispose?.('candidate-semantic-icons-visual-complete');
        delete window.__harnessCandidateSemanticIconControllers;
        delete window.__harnessCandidateSemanticIconScope;
        document.querySelector('[data-electron-candidate-semantic-icons]')?.remove();
    });
    const agentPresetSeatGeometry = await page.evaluate(async () => {
        const host = document.createElement('div');
        host.dataset.electronCandidateAgentPresetSeat = 'true';
        host.style.cssText = 'position:fixed;left:80px;top:120px;display:inline-flex;padding:24px;background:#fff;color:#0f1115;border:1px solid rgba(0,0,0,.08);border-radius:12px';
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-agent-preset-seat');
        const button = document.createElement('button');
        button.type = 'button';
        host.append(button);
        const picks = [];
        const seat = window.VCPUIUX.mountAgentPresetSeat(button, {
            options: [
                { id: 'standard', name: 'Standard mode', description: 'Full coding agent with file editing, shell and search.' },
                { id: 'minimal', name: 'Minimal mode', description: 'Two-tool coding agent.' },
                { id: 'code', name: 'Code mode', description: 'Standard capabilities through the Code Mode SDK.' },
            ],
            selectedId: 'standard',
            onSelect: (id) => { picks.push(id); seat.setSelected(id); },
            onClose: () => {},
        }, scope);
        await new Promise(resolve => setTimeout(resolve, 0));
        const seatStyle = getComputedStyle(button);
        const closed = {
            minHeight: seatStyle.minHeight,
            padding: seatStyle.padding,
            borderRadius: seatStyle.borderRadius,
            fontSize: seatStyle.fontSize,
            fontWeight: seatStyle.fontWeight,
            ariaExpanded: button.getAttribute('aria-expanded'),
            hasPopup: button.getAttribute('aria-haspopup'),
            title: button.getAttribute('title'),
            // The next-shell native tooltip bridge converts [title] into
            // data-tooltip/aria-label on a microtask; record both carriers.
            titleTooltipBridge: button.getAttribute('data-tooltip'),
            titleAriaLabel: button.getAttribute('aria-label'),
            disabled: button.disabled,
            label: seat.selectedLabel(),
        };
        seat.setOpen(true);
        await new Promise(resolve => setTimeout(resolve, 0));
        const menu = document.body.querySelector('.vcp-harness-menu-list[role="menu"]');
        const items = [...(menu?.querySelectorAll('.vcp-harness-menu-item-label') ?? [])].map(label => ({
            name: label.querySelector('.vcp-agent-preset-seat-item-name')?.textContent || '',
            description: label.querySelector('.vcp-agent-preset-seat-item-desc')?.textContent || '',
        }));
        const selectedName = menu?.querySelector('[data-selected="true"] .vcp-agent-preset-seat-item-name')?.textContent || '';
        seat.setBusy(true);
        const busyDisabled = button.disabled;
        seat.setBusy(false);
        seat.setError('Could not stage the preset. Try again.');
        const errorTitle = button.getAttribute('title');
        seat.setError(null);
        const screenshot = { viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }, source: 'generated-artifact-electron', state: 'open-selected-busy-error-closed', closed, open: { ariaExpanded: button.getAttribute('aria-expanded'), itemCount: items.length, items, selectedName, minMenuWidth: menu ? getComputedStyle(menu).minWidth : null, menuRadius: menu ? getComputedStyle(menu).borderRadius : null }, busyDisabled, errorTitle, picks };
        window.__harnessCandidateAgentPresetSeatController = seat;
        window.__harnessCandidateAgentPresetSeatScope = scope;
        return screenshot;
    });
    assert.deepEqual(agentPresetSeatGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(agentPresetSeatGeometry.closed, {
        minHeight: agentPresetSeatGeometry.closed.minHeight,
        padding: '0px 8px',
        borderRadius: '16px',
        fontSize: '13px',
        fontWeight: '500',
        ariaExpanded: 'false',
        hasPopup: 'menu',
        title: null,
        titleTooltipBridge: 'Agent preset for the session you are about to start',
        titleAriaLabel: 'Agent preset for the session you are about to start',
        disabled: false,
        label: 'Standard mode',
    });
    assert.equal(agentPresetSeatGeometry.open.itemCount, 3);
    assert.equal(agentPresetSeatGeometry.open.items[0].name, 'Standard mode');
    assert.equal(agentPresetSeatGeometry.open.items[1].description, 'Two-tool coding agent.');
    assert.equal(agentPresetSeatGeometry.open.selectedName, 'Standard mode');
    assert.equal(agentPresetSeatGeometry.busyDisabled, true);
    assert.equal(agentPresetSeatGeometry.errorTitle, 'Could not stage the preset. Try again.');
    const agentPresetSeatScreenshot = path.join(root, 'reports', 'vcp-harness-agent-preset-seat-candidate.png');
    await page.screenshot({ path: agentPresetSeatScreenshot });
    assert.ok((await fs.stat(agentPresetSeatScreenshot)).size > 1024, 'Agent preset seat Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-agent-preset-seat-candidate.json'), `${JSON.stringify(agentPresetSeatGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        await window.__harnessCandidateAgentPresetSeatController?.dispose?.();
        await window.__harnessCandidateAgentPresetSeatScope?.dispose?.('candidate-agent-preset-seat-visual-complete');
        delete window.__harnessCandidateAgentPresetSeatController;
        delete window.__harnessCandidateAgentPresetSeatScope;
        document.querySelector('[data-electron-candidate-agent-preset-seat]')?.remove();
    });
    const agentPresetRowGeometry = await page.evaluate(async () => {
        const host = document.createElement('div');
        host.dataset.electronCandidateAgentPresetRow = 'true';
        host.style.cssText = 'position:fixed;left:80px;top:240px;width:560px;padding:0 24px;background:#fff;color:#0f1115;border:1px solid rgba(0,0,0,.08);border-radius:12px';
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-agent-preset-row');
        const picks = [];
        const row = window.VCPUIUX.mountAgentPresetRow(host, {
            options: [
                { id: 'standard', name: 'Standard mode', trust: 'system' },
                { id: 'draft', name: 'Research draft', trust: 'user' },
                { id: 'minimal', name: 'Minimal mode', trust: 'system' },
            ],
            currentValue: 'standard',
            onSelect: (id) => { picks.push(id); row.setCurrent(id); },
            onClose: () => {},
        }, scope);
        await new Promise(resolve => setTimeout(resolve, 0));
        const triggerStyle = getComputedStyle(row.trigger);
        const rowStyle = getComputedStyle(row.root);
        const titleStyle = getComputedStyle(document.querySelector('.vcp-agent-preset-row-title'));
        const descNode = document.querySelector('.vcp-agent-preset-row-desc');
        const descStyle = getComputedStyle(descNode);
        const closed = {
            height: triggerStyle.height,
            padding: triggerStyle.padding,
            borderRadius: triggerStyle.borderRadius,
            gap: triggerStyle.gap,
            background: triggerStyle.backgroundColor,
            fontSize: triggerStyle.fontSize,
            lineHeight: triggerStyle.lineHeight,
            ariaExpanded: row.trigger.getAttribute('aria-expanded'),
            hasPopup: row.trigger.getAttribute('aria-haspopup'),
            label: row.selectedLabel(),
            rowBorderBottomWidth: rowStyle.borderBottomWidth,
            rowGap: rowStyle.gap,
            titleFontSize: titleStyle.fontSize,
            titleLineHeight: titleStyle.lineHeight,
            descFontSize: descStyle.fontSize,
            descLineHeight: descStyle.lineHeight,
            descRole: descNode?.getAttribute('role') ?? null,
        };
        row.setOpen(true);
        await new Promise(resolve => setTimeout(resolve, 0));
        const menu = document.body.querySelector('.vcp-harness-menu-list[role="menu"]');
        const items = [...(menu?.querySelectorAll('.vcp-harness-menu-item-label') ?? [])].map(label => label.textContent);
        // Read placement while open: closing the menu detaches the portal list.
        const portalToBody = menu?.parentElement === document.body;
        menu?.querySelectorAll('[role="menuitem"]')[1].click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const pickedLabel = row.selectedLabel();
        const pickedClosed = row.trigger.getAttribute('aria-expanded') === 'false' && !document.querySelector('.vcp-harness-menu-list');
        row.setBusy(true);
        const busyDisabled = row.trigger.disabled;
        row.setBusy(false);
        row.setError('Could not load presets. Try again.');
        const errorRole = document.querySelector('.vcp-agent-preset-row-desc')?.getAttribute('role') ?? null;
        row.setError(null);
        const screenshot = { viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }, source: 'generated-artifact-electron', primitive: 'AgentPresetRow', state: 'open-selected-busy-error-picked-closed', closed, open: { alignEnd: menu?.classList.contains('vcp-harness-menu-align-end') === true, itemCount: items.length, items, portalToBody }, picks, pickedLabel, pickedClosed, busyDisabled, errorRole };
        window.__harnessCandidateAgentPresetRowController = row;
        window.__harnessCandidateAgentPresetRowScope = scope;
        return screenshot;
    });
    assert.deepEqual(agentPresetRowGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(agentPresetRowGeometry.closed, {
        height: '36px',
        padding: '0px 14px',
        borderRadius: '18px',
        gap: '12px',
        background: 'rgb(245, 246, 247)',
        fontSize: '14px',
        lineHeight: '22px',
        ariaExpanded: 'false',
        hasPopup: 'menu',
        label: 'Standard mode',
        rowBorderBottomWidth: '1px',
        rowGap: '8px',
        titleFontSize: '14px',
        titleLineHeight: '22px',
        descFontSize: '12px',
        descLineHeight: '18px',
        descRole: null,
    });
    assert.equal(agentPresetRowGeometry.open.alignEnd, true);
    assert.equal(agentPresetRowGeometry.open.portalToBody, true);
    assert.equal(agentPresetRowGeometry.open.itemCount, 3);
    // PresetMenu appends `· <userTrust>` only for locally authored presets.
    assert.deepEqual(agentPresetRowGeometry.open.items, ['Standard mode', 'Research draft · Custom', 'Minimal mode']);
    assert.deepEqual(agentPresetRowGeometry.picks, ['draft']);
    assert.equal(agentPresetRowGeometry.pickedLabel, 'Research draft');
    assert.equal(agentPresetRowGeometry.pickedClosed, true);
    assert.equal(agentPresetRowGeometry.busyDisabled, true);
    assert.equal(agentPresetRowGeometry.errorRole, 'alert');
    const agentPresetRowScreenshot = path.join(root, 'reports', 'vcp-harness-agent-preset-row-candidate.png');
    await page.screenshot({ path: agentPresetRowScreenshot });
    assert.ok((await fs.stat(agentPresetRowScreenshot)).size > 1024, 'Agent preset row Candidate screenshot is unexpectedly empty');
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-agent-preset-row-candidate.json'), `${JSON.stringify(agentPresetRowGeometry, null, 2)}\n`, 'utf8');
    await page.evaluate(async () => {
        await window.__harnessCandidateAgentPresetRowController?.dispose?.();
        await window.__harnessCandidateAgentPresetRowScope?.dispose?.('candidate-agent-preset-row-visual-complete');
        delete window.__harnessCandidateAgentPresetRowController;
        delete window.__harnessCandidateAgentPresetRowScope;
        document.querySelector('[data-electron-candidate-agent-preset-row]')?.remove();
    });
    const popupSelectGeometry = await page.evaluate(async () => {
        const host = document.createElement('div');
        host.dataset.electronCandidatePopupSelect = 'true';
        host.style.cssText = 'position:fixed;left:80px;top:420px;width:360px;min-height:44px;padding:16px;background:#fff;color:#0f1115;border:1px solid rgba(0,0,0,.08);border-radius:12px';
        document.body.append(host);
        const focusTarget = document.createElement('button');
        focusTarget.type = 'button';
        focusTarget.textContent = 'Lab focus owner';
        host.append(focusTarget);
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-candidate-popup-select');
        const selected = [];
        const consumed = [];
        let focused = 0;
        const popup = window.VCPUIUX.createPopupSelectController({
            options: async () => [
                { id: 'balanced', label: 'Balanced', detail: 'General purpose model', active: true },
                { id: 'careful', label: 'Careful', detail: 'Requires acknowledgement', confirmation: { title: 'Confirm model', description: 'Electron Candidate fixture only.', acknowledgeLabel: 'I understand', cancelLabel: 'Cancel', confirmLabel: 'Apply' } },
            ],
            onSelect: async option => { selected.push(option.id); },
        }, {
            consume: segment => { consumed.push(segment); return true; },
            focusComposer: () => { focused += 1; focusTarget.focus(); },
        });
        const view = window.VCPUIUX.mountPopupSelectView(host, { popup, overlayAria: '/{command} options' }, scope);
        popup.open('model', { fixture: true }, { via: 'enter', token: '/model' });
        await new Promise(resolve => setTimeout(resolve, 0));
        const cardStyle = getComputedStyle(view.card);
        const rows = [...view.card.querySelectorAll('[role="option"]')].map(row => ({
            // The non-grouped row keeps detail text beside the label in the
            // same copy span; assert the semantic label node, not its full
            // rendered copy.
            label: row.querySelector('.vcp-harness-popup-select-label')?.firstElementChild?.textContent
                ?? row.querySelector('.vcp-harness-popup-select-label')?.textContent
                ?? '',
            selected: row.getAttribute('aria-selected'),
        }));
        window.__harnessCandidatePopupSelect = { host, scope, popup, view, focusTarget, selected, consumed, get focused() { return focused; } };
        return {
            viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
            source: 'generated-artifact-electron',
            state: 'open-ready-highlight',
            card: { parentIsHost: view.card.parentElement === host, ariaLabel: view.card.getAttribute('aria-label'), bottom: cardStyle.bottom, padding: cardStyle.padding, borderRadius: cardStyle.borderRadius, minWidth: cardStyle.minWidth, zIndex: cardStyle.zIndex },
            focusIsSearch: document.activeElement === view.search,
            rows,
        };
    });
    assert.deepEqual(popupSelectGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(popupSelectGeometry.card, {
        parentIsHost: true,
        ariaLabel: '/model options',
        // Computed from the fixed fixture host's 76px content box plus the
        // Harness 4px `calc(100% + 4px)` separation.
        bottom: '80px',
        padding: '4px',
        borderRadius: '12px',
        minWidth: 'min(220px, 100%)',
        zIndex: '100',
    });
    assert.equal(popupSelectGeometry.focusIsSearch, true);
    assert.deepEqual(popupSelectGeometry.rows, [{ label: 'Balanced', selected: 'true' }, { label: 'Careful', selected: 'false' }]);
    const popupSelectScreenshot = path.join(root, 'reports', 'vcp-harness-popup-select-candidate.png');
    await page.screenshot({ path: popupSelectScreenshot });
    assert.ok((await fs.stat(popupSelectScreenshot)).size > 1024, 'PopupSelect Candidate screenshot is unexpectedly empty');
    const popupSelectLifecycle = await page.evaluate(async () => {
        const fixture = window.__harnessCandidatePopupSelect;
        fixture.popup.setSearch('care');
        await fixture.popup.select(0);
        const riskVisible = document.querySelector('[role="dialog"]') !== null && fixture.view.card.style.display === 'none';
        fixture.popup.acknowledge(true);
        await fixture.popup.confirm();
        const result = {
            riskVisible,
            selected: fixture.selected,
            consumed: fixture.consumed,
            focused: fixture.focused,
            closed: fixture.popup.getSnapshot().open === false && fixture.view.card.isConnected === false && document.activeElement === fixture.focusTarget,
        };
        await fixture.view.dispose();
        await fixture.scope.dispose('candidate-popup-select-visual-complete');
        fixture.host.remove();
        delete window.__harnessCandidatePopupSelect;
        return result;
    });
    assert.deepEqual(popupSelectLifecycle, { riskVisible: true, selected: ['careful'], consumed: [{ via: 'enter', token: '/model' }], focused: 1, closed: true });
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-popup-select-candidate.json'), `${JSON.stringify({ ...popupSelectGeometry, lifecycle: popupSelectLifecycle }, null, 2)}\n`, 'utf8');
    const directoryBrowserGeometry = await page.evaluate(async () => {
        const scope = new window.VCPLifecycle.LifecycleScope('test:harness-directory-browser-foundation');
        const opened = [];
        const closed = [];
        const listings = {
            '/home': { path: '/home', crumbs: [{ name: 'Home', path: '/home' }], entries: [{ name: 'projects', path: '/home/projects' }, { name: '.hidden', path: '/home/.hidden', hidden: true }] },
            '/home/projects': { path: '/home/projects', crumbs: [{ name: 'Home', path: '/home' }, { name: 'projects', path: '/home/projects' }], entries: [{ name: 'vcpchat', path: '/home/projects/vcpchat' }, { name: 'labs', path: '/home/projects/labs' }] },
        };
        const browser = window.VCPUIUX.mountDirectoryBrowser({
            open: true,
            listDirectory: async path => listings[path || '/home'] || { path: path || '/home', entries: [] },
            createDirectory: async (path, name) => `${path}/${name}`,
            onOpen: path => opened.push(path),
            onClose: () => closed.push(true),
        }, scope);
        await new Promise(resolve => setTimeout(resolve, 0));
        const dialog = document.querySelector('.vcp-directory-browser[role="dialog"]');
        const initialRows = [...dialog.querySelectorAll('.vcp-directory-browser-row-name')].map(node => node.textContent);
        dialog.querySelector('.vcp-directory-browser-hidden').click();
        const visibleRows = [...dialog.querySelectorAll('.vcp-directory-browser-row-name')].map(node => node.textContent);
        [...dialog.querySelectorAll('.vcp-directory-browser-row')].find(row => row.textContent.includes('projects'))?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const style = getComputedStyle(dialog);
        const selectedRow = dialog.querySelector('.vcp-directory-browser-row[aria-current="true"]');
        const result = {
            viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
            source: 'generated-artifact-electron',
            state: 'two-pane-selected-hidden',
            dialog: { width: style.width, height: style.height, padding: style.padding, gap: style.gap, role: dialog.getAttribute('role'), modal: dialog.getAttribute('aria-modal') },
            columns: dialog.querySelectorAll('.vcp-directory-browser-column').length,
            divider: dialog.querySelector('.vcp-directory-browser-divider') !== null,
            initialRows,
            visibleRows,
            selected: selectedRow?.textContent || '',
            hiddenPressed: dialog.querySelector('.vcp-directory-browser-hidden')?.getAttribute('aria-pressed'),
            geometry: { rowHeight: getComputedStyle(selectedRow).height, rowRadius: getComputedStyle(selectedRow).borderRadius, columnMinWidth: getComputedStyle(dialog.querySelector('.vcp-directory-browser-column')).minWidth, footerPadding: getComputedStyle(dialog.querySelector('.vcp-directory-browser-footer')).padding },
        };
        window.__harnessDirectoryBrowserFixture = { scope, browser, opened, closed };
        return result;
    });
    assert.deepEqual(directoryBrowserGeometry.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.deepEqual(directoryBrowserGeometry.dialog, { width: '680px', height: '500px', padding: '0px', gap: '0px', role: 'dialog', modal: 'true' });
    assert.equal(directoryBrowserGeometry.columns, 2);
    assert.equal(directoryBrowserGeometry.divider, true);
    assert.deepEqual(directoryBrowserGeometry.initialRows, ['projects']);
    assert.deepEqual(directoryBrowserGeometry.visibleRows, ['projects', '.hidden']);
    assert.equal(directoryBrowserGeometry.selected, 'projects');
    assert.equal(directoryBrowserGeometry.hiddenPressed, 'true');
    assert.deepEqual(directoryBrowserGeometry.geometry, { rowHeight: '28px', rowRadius: '6px', columnMinWidth: '256px', footerPadding: '12px 24px' });
    const directoryBrowserCreateGeometry = await page.evaluate(async () => {
        const dialog = document.querySelector('.vcp-directory-browser[role="dialog"]');
        [...dialog.querySelectorAll('.vcp-directory-browser-footer button')].find(button => button.textContent === 'New folder')?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const child = document.querySelector('.vcp-directory-browser-create-dialog[role="dialog"]');
        const childStyle = getComputedStyle(child);
        const parentRow = dialog.querySelector('.vcp-directory-browser-row');
        const input = child.querySelector('.vcp-directory-browser-create-input');
        const beforeEscape = { parentDisabled: parentRow.disabled, childWidth: childStyle.width, childPadding: childStyle.padding, inputHeight: getComputedStyle(input).height };
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const escaped = document.querySelector('.vcp-directory-browser-create-dialog') === null && dialog.isConnected;
        [...dialog.querySelectorAll('.vcp-directory-browser-footer button')].find(button => button.textContent === 'New folder')?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const activeInput = document.querySelector('.vcp-directory-browser-create-input');
        activeInput.value = 'labs'; activeInput.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('.vcp-directory-browser-create-actions button')].find(button => button.textContent === 'Create')?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const selected = dialog.querySelector('.vcp-directory-browser-row[aria-current="true"]')?.textContent || '';
        return { beforeEscape, escaped, selected, childRemoved: document.querySelector('.vcp-directory-browser-create-dialog') === null };
    });
    assert.deepEqual(directoryBrowserCreateGeometry, { beforeEscape: { parentDisabled: true, childWidth: '380px', childPadding: '0px', inputHeight: '44px' }, escaped: true, selected: 'labs', childRemoved: true });
    const directoryBrowserScreenshot = path.join(root, 'reports', 'vcp-harness-directory-browser-foundation.png');
    await page.screenshot({ path: directoryBrowserScreenshot });
    assert.ok((await fs.stat(directoryBrowserScreenshot)).size > 1024, 'DirectoryBrowser foundation screenshot is unexpectedly empty');
    const directoryBrowserLifecycle = await page.evaluate(async () => {
        const fixture = window.__harnessDirectoryBrowserFixture;
        const dialog = document.querySelector('.vcp-directory-browser[role="dialog"]');
        [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Open')?.click();
        fixture.browser.setOpen(false);
        const closed = fixture.browser.open === false && document.querySelector('.vcp-directory-browser') === null;
        await fixture.browser.dispose();
        await fixture.scope.dispose('directory-browser-foundation-complete');
        delete window.__harnessDirectoryBrowserFixture;
        return { opened: fixture.opened, closed, onClose: fixture.closed.length };
    });
    assert.deepEqual(directoryBrowserLifecycle, { opened: ['/home/projects/labs'], closed: true, onClose: 0 });
    await fs.writeFile(path.join(root, 'reports', 'vcp-harness-directory-browser-foundation.json'), `${JSON.stringify({ ...directoryBrowserGeometry, nestedCreate: directoryBrowserCreateGeometry, lifecycle: directoryBrowserLifecycle }, null, 2)}\n`, 'utf8');
    await page.screenshot({ path: primitiveScreenshot });
    const screenshotStat = await fs.stat(primitiveScreenshot);
    assert.ok(screenshotStat.size > 1024, `primitive screenshot is unexpectedly empty: ${screenshotStat.size} bytes`);
    await fs.writeFile(path.join(root, 'reports', 'vcp-primitive-geometry.json'), `${JSON.stringify({ viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, primitive: 'Input+Select', source: 'generated-artifact-electron', geometry: primitiveBoundary }, null, 2)}\n`, 'utf8');
    const readBoundary = () => page.evaluate(() => {
        const dock = document.querySelector('.next-ui-account-dock');
        const theme = window.VCPStateChannels?.diagnostics?.().find(item => item.name === 'theme');
        return {
            provider: typeof window.VCPUIUX?.mountThemePresenterFromScope === 'function',
            projection: dock?.dataset.themeEffective || null,
            ready: dock?.dataset.themeReady || null,
            revision: dock?.dataset.themeRevision || null,
            subscribers: theme?.subscribers ?? null,
        };
    });
    try {
        await page.waitForFunction(() => /^(light|dark)$/.test(document.querySelector('.next-ui-account-dock')?.dataset.themeEffective || ''), { timeout });
    } catch (error) {
        const diagnostic = await page.evaluate(() => ({
            dock: Boolean(document.querySelector('.next-ui-account-dock')),
            bodyTheme: document.body?.dataset.vcpTheme || null,
            manager: Boolean(window.uiManager),
            managerSnapshot: window.uiManager?.getThemeSnapshot?.() || null,
            presenterFlag: Boolean(window.__vcpDocumentThemePresenterMounted),
            subscribers: window.VCPStateChannels?.diagnostics?.().find(item => item.name === 'theme')?.subscribers ?? null,
        }));
        throw new Error(`Theme presenter did not reach projection: ${JSON.stringify(diagnostic)}; ${error.message}`);
    }
    const initial = await readBoundary();
    assert.deepEqual(initial.provider, true);
    assert.ok(['light', 'dark'].includes(initial.projection), `typed theme projection missing: ${JSON.stringify(initial)}`);
    assert.equal(initial.ready, 'true');
    assert.ok(Number.isInteger(Number(initial.revision)), `typed theme revision missing: ${JSON.stringify(initial)}`);
    // The document-level presenter is the sole global DOM owner; only the
    // Web Awesome adapter remains as a separate token consumer.
    assert.equal(initial.subscribers, 2, `unexpected theme subscriber ledger: ${JSON.stringify(initial)}`);

    await page.evaluate(() => window.uiManager.applyTheme('dark'));
    await page.waitForFunction(() => document.querySelector('.next-ui-account-dock')?.dataset.themeEffective === 'dark', { timeout: 8_000 });
    const dark = await readBoundary();
    assert.equal(dark.projection, 'dark');
    assert.equal(dark.ready, 'true');
    assert.ok(Number(dark.revision) > Number(initial.revision), `theme revision did not advance: ${JSON.stringify({ initial, dark })}`);
    assert.equal(dark.subscribers, initial.subscribers, 'theme update changed subscriber ownership');

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 12_000 });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout });
    await page.waitForFunction(() => /^(light|dark)$/.test(document.querySelector('.next-ui-account-dock')?.dataset.themeEffective || ''), { timeout });
    const recovered = await readBoundary();
    assert.equal(recovered.provider, true);
    assert.equal(recovered.ready, 'true');
    assert.equal(recovered.subscribers, initial.subscribers, `theme consumer ledger changed after reload: ${JSON.stringify({ initial, recovered })}`);
    console.log(`UIUX Theme Electron journey passed: initial=${initial.projection}/${initial.revision}, dark=${dark.projection}/${dark.revision}, reload=${recovered.projection}/${recovered.revision}, subscribers=${recovered.subscribers}`);
} finally {
    browser?.disconnect();
    if (child.exitCode === null) child.kill('SIGKILL');
}
