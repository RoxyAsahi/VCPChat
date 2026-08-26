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
    const primitiveScreenshot = path.join(appData, 'uiux-primitive-contract.png');
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
