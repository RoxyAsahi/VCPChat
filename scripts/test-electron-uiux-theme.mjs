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
        colorText.dispatchEvent(new Event('change', { bubbles: true }));
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
        layout?.focus();
        result.menuSubmenu = Boolean(atomMenu?.querySelector('.vcp-harness-submenu[role="menu"]'));
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
        const tooltipBubble = host.querySelector('.vcp-harness-tooltip-bubble[role="tooltip"]');
        result.tooltipOpen = tooltipBubble?.textContent === 'Open workspace details';
        result.tooltipSide = tooltipBubble?.getAttribute('data-side') || '';
        tooltipAnchor?.dispatchEvent(new MouseEvent('mouseleave'));
        result.tooltipClosed = !host.querySelector('.vcp-harness-tooltip-bubble');
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
        await release();
        result.restored = host.childNodes.length === 0;
        result.scopeActive = scope.active;
        host.remove();
        return result;
    });
    assert.deepEqual(candidateLabBoundary, {
        maturity: 'candidate',
        buttons: 10,
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
        const hoverAnchor = document.createElement('div');
        hoverAnchor.textContent = 'Workspace path';
        hoverAnchor.style.cssText = 'padding:10px 12px;border:1px solid rgba(0,0,0,.12);border-radius:8px';
        host.append(hoverAnchor);
        const content = document.createElement('div');
        content.textContent = '/Users/asahi/Documents/Codex/VCPChat-newarchitecture';
        content.style.cssText = 'font-size:13px;line-height:20px;overflow-wrap:anywhere';
        const hoverCard = window.VCPUIUX.mountHoverCard(hoverAnchor, { content, openDelayMs: 0, copyText: '/Users/asahi/Documents/Codex/VCPChat-newarchitecture', copyLabel: 'Copy path', copiedLabel: 'Copied' }, scope);
        hoverCard.root.dispatchEvent(new PointerEvent('pointerenter'));
        await new Promise(resolve => setTimeout(resolve, 180));
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
    const initial = await readBoundary();
    assert.deepEqual(initial.provider, true);
    assert.ok(['light', 'dark'].includes(initial.projection), `typed theme projection missing: ${JSON.stringify(initial)}`);
    assert.equal(initial.ready, 'true');
    assert.ok(Number.isInteger(Number(initial.revision)), `typed theme revision missing: ${JSON.stringify(initial)}`);
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
