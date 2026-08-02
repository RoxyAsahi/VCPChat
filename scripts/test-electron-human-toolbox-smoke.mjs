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
const timeoutMs = 30_000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const captureDir = path.join(root, 'screenshots');

async function capture(page, name) {
    await fs.mkdir(captureDir, { recursive: true });
    const filePath = path.join(captureDir, name);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        }).on('error', reject);
    });
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-human-toolbox-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    vcpServerUrl: 'http://127.0.0.1:6005/v1/human/tool',
    vcpApiKey: 'hermetic-test',
    vcpht_theme: 'dark',
}), 'utf8');

const port = await freePort();
const stderr = { value: '' };
const child = spawn(electron, ['VCPHumanToolBox', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
child.stderr.on('data', chunk => { stderr.value = `${stderr.value}${chunk}`.slice(-12_000); });

let browser;
const rendererConsole = [];
try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Human ToolBox exited before startup: ${stderr.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            break;
        } catch {
            await sleep(120);
        }
    }

    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    let page;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => candidate.url().includes('VCPHumanToolBox/index.html'));
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `Human ToolBox renderer did not appear: ${stderr.value}`);

    const rendererErrors = [];
    page.on('pageerror', error => rendererErrors.push(error?.stack || String(error)));
    page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning') rendererConsole.push(message.text());
    });
    page.on('dialog', async dialog => {
        rendererConsole.push(`[dialog:${dialog.type()}] ${dialog.message()}`);
        await dialog.dismiss();
    });
    await page.waitForSelector('.vcp-ui-page-shell', { timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelectorAll('.tool-card').length > 0, { timeout: timeoutMs });

    const gridState = await page.evaluate(() => ({
        mode: document.documentElement.dataset.uiMode,
        cards: document.querySelectorAll('.tool-card').length,
        shell: Boolean(document.querySelector('.vcp-ui-page-shell')),
        scope: document.body.classList.contains('vcp-ui-human-toolbox'),
        directWaTooltips: document.querySelectorAll('wa-tooltip').length,
        waCards: document.querySelectorAll('wa-card.tool-card').length,
        waInputs: document.querySelectorAll('wa-input.tool-search-input').length,
        waSelects: document.querySelectorAll('wa-select.tool-category-select').length,
        workflowVisible: Boolean(document.querySelector('#workflow-btn-next')?.getClientRects().length),
        lucideIcons: document.querySelectorAll('[data-lucide]').length,
    }));
    assert.equal(gridState.mode, 'next');
    assert.ok(gridState.shell && gridState.scope, `next shell missing: ${JSON.stringify(gridState)}`);
    assert.ok(gridState.cards >= 1, `tool cards missing: ${JSON.stringify(gridState)}`);
    assert.ok(gridState.directWaTooltips >= 1, `VCPUI tooltip did not resolve through Web Awesome: ${JSON.stringify(gridState)}`);
    assert.equal(gridState.waCards, gridState.cards, `tool list is not Web Awesome-backed: ${JSON.stringify(gridState)}`);
    assert.ok(gridState.waInputs >= 1, `search is not Web Awesome-backed: ${JSON.stringify(gridState)}`);
    assert.ok(gridState.waSelects >= 1, `category Select is not Web Awesome-backed: ${JSON.stringify(gridState)}`);
    assert.equal(gridState.workflowVisible, true, `workflow action is hidden: ${JSON.stringify(gridState)}`);
    assert.ok(gridState.lucideIcons >= 2, `Lucide icons missing: ${JSON.stringify(gridState)}`);

    // Focus + keyboard main flow: the search control takes focus and Tab moves.
    const searchFocused = await page.evaluate(() => {
        const search = document.querySelector('wa-input.tool-search-input');
        if (!search) return { focused: false };
        search.focus();
        const active = document.activeElement;
        const inShadow = active?.shadowRoot?.contains(search) || active === search;
        return { focused: inShadow || active === search, activeTag: active?.tagName || '' };
    });
    assert.ok(searchFocused.focused, `search input did not take focus: ${JSON.stringify(searchFocused)}`);
    await page.keyboard.press('Tab');
    const tabMoved = await page.evaluate(() => {
        const active = document.activeElement;
        const search = document.querySelector('wa-input.tool-search-input');
        return document.activeElement !== search && document.activeElement !== search?.shadowRoot?.activeElement;
    });
    assert.equal(tabMoved, true, 'Tab did not move focus away from the search input');

    // Empty state: a non-matching query hides every card and the badge reports 0.
    await page.evaluate(() => {
        const search = document.querySelector('wa-input.tool-search-input');
        search.value = 'zzz-no-match-query-zzz';
        search.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });
    await sleep(150);
    const emptyState = await page.evaluate(() => ({
        visibleCards: [...document.querySelectorAll('.tool-card')].filter(card => getComputedStyle(card).display !== 'none').length,
        badge: document.querySelector('.tool-count-badge')?.textContent || '',
    }));
    assert.equal(emptyState.visibleCards, 0, `empty-state query should hide all cards: ${JSON.stringify(emptyState)}`);
    assert.match(emptyState.badge, /匹配\s*0/, `empty-state badge should report 0 matches: ${JSON.stringify(emptyState)}`);
    await capture(page, 'human-toolbox-empty.png');
    // Clear the filter.
    await page.evaluate(() => {
        const search = document.querySelector('wa-input.tool-search-input');
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });
    await sleep(150);
    assert.equal(await page.$eval('.tool-count-badge', el => el.textContent.trim().startsWith('共')), true, 'search filter did not clear');
    await page.$eval('#workflow-btn-next', element => element.click());
    await page.waitForSelector('#workflowEditorContainer', { visible: true, timeout: timeoutMs });
    const workflowState = await page.evaluate(() => ({
        visible: Boolean(document.querySelector('#workflowEditorContainer')?.getClientRects().length),
        nativeSelects: document.querySelectorAll('#workflowEditorContainer select.vcp-ui-select-source').length,
        selectProxies: document.querySelectorAll('#workflowEditorContainer wa-select.vcp-ui-select-proxy').length,
        overflowX: document.querySelector('#workflowEditorContainer')?.scrollWidth
            > document.querySelector('#workflowEditorContainer')?.clientWidth + 1,
    }));
    assert.equal(workflowState.visible, true, `workflow editor did not open: ${JSON.stringify(workflowState)}`);
    assert.equal(workflowState.selectProxies, workflowState.nativeSelects, `workflow Select proxies mismatch: ${JSON.stringify(workflowState)}`);
    assert.equal(workflowState.overflowX, false, `workflow editor overflows horizontally: ${JSON.stringify(workflowState)}`);
    await capture(page, 'human-toolbox-workflow.png');
    await page.$eval('#closeWorkflowBtn', element => element.click());

    await page.evaluate(() => window.openComfyUISettings?.());
    await page.waitForSelector('#comfyui-drawer-content #workflowSelect', { timeout: timeoutMs });
    await page.waitForFunction(() => {
        const drawer = document.getElementById('comfyui-drawer-content');
        const sources = drawer?.querySelectorAll('select.vcp-ui-select-source').length || 0;
        return sources > 0 && drawer.querySelectorAll('wa-select.vcp-ui-select-proxy').length === sources;
    }, { timeout: timeoutMs });
    const comfyState = await page.evaluate(() => {
        const drawer = document.getElementById('comfyui-drawer-content');
        const proxies = [...drawer.querySelectorAll('wa-select.vcp-ui-select-proxy')];
        return {
            nativeSelects: drawer.querySelectorAll('select.vcp-ui-select-source').length,
            selectProxies: proxies.length,
            visibleNative: [...drawer.querySelectorAll('select.vcp-ui-select-source')]
                .filter(select => !select.hidden && getComputedStyle(select).display !== 'none').length,
            hostShellsReset: proxies.every(select => {
                const style = getComputedStyle(select);
                return parseFloat(style.borderTopWidth) === 0
                    && parseFloat(style.paddingTop) === 0
                    && style.backgroundColor === 'rgba(0, 0, 0, 0)';
            }),
            overflowX: drawer.scrollWidth > drawer.clientWidth + 1,
        };
    });
    assert.ok(comfyState.nativeSelects >= 4, `ComfyUI Select sources missing: ${JSON.stringify(comfyState)}`);
    assert.equal(comfyState.selectProxies, comfyState.nativeSelects, `ComfyUI Select proxies mismatch: ${JSON.stringify(comfyState)}`);
    assert.equal(comfyState.visibleNative, 0, `ComfyUI native Select remains visible: ${JSON.stringify(comfyState)}`);
    assert.equal(comfyState.hostShellsReset, true, `ComfyUI Select host still draws a second shell: ${JSON.stringify(comfyState)}`);
    assert.equal(comfyState.overflowX, false, `ComfyUI drawer overflows horizontally: ${JSON.stringify(comfyState)}`);
    await page.$eval('.config-tab-button[data-tab="parameters"]', element => element.click());
    await page.waitForFunction(() => document.getElementById('parametersTab')?.classList.contains('active'));
    await capture(page, 'human-toolbox-comfyui.png');
    await page.evaluate(() => window.closeComfyUISettings?.());
    await capture(page, 'human-toolbox-tools.png');

    await page.$eval('.tool-card', element => element.click());
    await page.waitForFunction(() => getComputedStyle(document.getElementById('tool-detail-view')).display === 'block');
    const detailState = await page.evaluate(() => ({
        title: document.getElementById('tool-title')?.textContent?.trim(),
        controls: document.querySelectorAll('#tool-form input, #tool-form textarea, #tool-form select').length,
        enhanced: document.querySelectorAll('#tool-form .vcp-ui-native-input, #tool-form .vcp-ui-native-textarea, #tool-form .vcp-ui-native-select').length,
        nativeSelects: document.querySelectorAll('#tool-form select.vcp-ui-select-source').length,
        selectProxies: document.querySelectorAll('#tool-form wa-select.vcp-ui-select-proxy').length,
    }));
    assert.ok(detailState.title, `tool detail title missing: ${JSON.stringify(detailState)}`);
    assert.ok(detailState.controls > 0 && detailState.enhanced > 0, `dynamic form controls were not enhanced: ${JSON.stringify(detailState)}`);
    assert.equal(detailState.selectProxies, detailState.nativeSelects, `dynamic Select proxies mismatch: ${JSON.stringify(detailState)}`);
    await capture(page, 'human-toolbox-detail.png');

    // Long text in a form textarea must not break the page layout.
    const longText = await page.evaluate(() => {
        const target = document.querySelector('#tool-form textarea');
        if (!target) return { applied: false };
        target.value = '长文本'.repeat(800);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        const ta = target.closest('.vcp-ui-textarea-wrap') || target;
        const rect = target.getBoundingClientRect();
        return {
            applied: true,
            scrollable: target.scrollHeight > target.clientHeight + 1,
            pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
            formOverflowX: document.getElementById('tool-form').scrollWidth > document.getElementById('tool-form').clientWidth + 1,
            taHeight: Math.round(rect.height),
        };
    });
    if (longText.applied) {
        assert.equal(longText.pageOverflowX, false, `page overflows horizontally after long text: ${JSON.stringify(longText)}`);
        assert.equal(longText.formOverflowX, false, `tool form overflows after long text: ${JSON.stringify(longText)}`);
        assert.ok(longText.scrollable, `textarea should scroll with long text: ${JSON.stringify(longText)}`);
    }

    await page.$eval('#back-to-grid-btn', element => element.click());
    await page.$eval('#manage-tab-btn', element => element.click());
    await page.waitForFunction(() => getComputedStyle(document.getElementById('manage-panel')).display === 'block');
    assert.ok(await page.$eval('#manage-panel', element => element.childElementCount > 0), 'manage panel did not render');
    const manageState = await page.evaluate(() => {
        const search = document.querySelector('#tm-global-search');
        const remove = document.querySelector('#tm-delete-mode-btn');
        const imported = document.querySelector('#tm-import-btn');
        const boxes = [search, remove, imported].map(element => element?.getBoundingClientRect());
        return {
            tags: [search?.tagName, remove?.tagName, imported?.tagName],
            visible: boxes.every(box => box && box.width > 0 && box.height > 0),
            aligned: boxes.every(box => Math.abs(box.top - boxes[0].top) < 8),
            overlap: boxes.some((box, index) => boxes.some((other, otherIndex) => index < otherIndex
                && box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
        };
    });
    assert.deepEqual(manageState.tags, ['WA-INPUT', 'WA-BUTTON', 'WA-BUTTON'], `manager controls are not Web Awesome-backed: ${JSON.stringify(manageState)}`);
    assert.ok(manageState.visible && manageState.aligned && !manageState.overlap, `manager toolbar layout invalid: ${JSON.stringify(manageState)}`);
    await capture(page, 'human-toolbox-manage.png');

    await page.setViewport({ width: 680, height: 760, deviceScaleFactor: 1 });
    await page.$eval('#tool-tab-btn', element => element.click());
    const narrowState = await page.evaluate(() => ({
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        cards: document.querySelectorAll('.tool-card').length,
    }));
    assert.equal(narrowState.overflowX, false, `narrow layout overflows: ${JSON.stringify(narrowState)}`);
    await capture(page, 'human-toolbox-narrow.png');
    assert.equal(rendererErrors.length, 0, `renderer errors:\n${rendererErrors.join('\n')}`);

    console.log(`Electron Human ToolBox smoke passed (${gridState.cards} tools, workflow/ComfyUI Selects, focus/keyboard/empty/long-text/detail/manage/narrow verified).`);
} catch (error) {
    console.error(`Electron Human ToolBox smoke failed:\n${error?.stack || error}`);
    if (rendererConsole.length) console.error(`Renderer console:\n${rendererConsole.slice(-20).join('\n')}`);
    process.exitCode = 1;
} finally {
    child.kill();
    browser?.disconnect();
    await sleep(250);
    child.kill('SIGKILL');
    await fs.rm(appData, { recursive: true, force: true });
}
