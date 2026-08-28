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
const timeoutMs = 60_000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
    const server = http.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function waitForDebugger(port) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}/json/version`, response => {
                response.resume();
                response.once('end', resolve);
            }).once('error', reject));
            return;
        } catch { await sleep(120); }
    }
    throw new Error('Electron remote debugger did not start.');
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-uiux-tray-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next', enableDistributedServer: false, vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'tray-probe',
}), 'utf8');
const port = await freePort();
const child = spawn(electron, [
    '.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`,
    `--remote-debugging-port=${port}`,
], { cwd: root, env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
const childExited = new Promise(resolve => child.once('exit', resolve));
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
let browser;
try {
    await waitForDebugger(port);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
    assert.ok(page, `App tray renderer missing: ${stderr}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true' && window.VCPUIUX?.mountButton, { timeout: timeoutMs });
    await page.waitForSelector('#appTrayMoreBtn');
    // The tray lives in the collapsible notification rail, which may sit
    // outside Puppeteer's layout viewport at a narrow startup geometry. Invoke
    // the real canonical trigger instead of letting a coordinate miss turn
    // this owner/lifecycle journey into a viewport-placement test.
    await page.evaluate(() => document.getElementById('appTrayMoreBtn')?.click());
    await page.waitForFunction(() => document.querySelector('#appTrayDrawer')?.classList.contains('active'), { timeout: timeoutMs });
    const initial = await page.evaluate(() => {
        const item = document.querySelector('#appTrayDrawerGrid .app-tray-drawer-item');
        const scope = window.VCPLifecycle?.diagnostics?.find?.('next:app-tray-drawer')?.[0] || null;
        return {
            candidate: item?.classList.contains('vcp-harness-button') && item?.classList.contains('toolbar') && item?.classList.contains('md'),
            title: item?.getAttribute('title') || null,
            ariaLabel: item?.getAttribute('aria-label') || '',
            marker: item?.dataset.uiuxShellAction || '',
            scopeActive: scope?.state || '',
        };
    });
    assert.deepEqual(initial, { candidate: true, title: null, ariaLabel: initial.ariaLabel, marker: 'app-tray-launch', scopeActive: 'active' });
    assert.ok(initial.ariaLabel, 'drawer launcher must preserve its accessible name');

    const firstItem = await page.$('#appTrayDrawerGrid .app-tray-drawer-item');
    await firstItem.hover();
    await page.waitForSelector('.vcp-harness-tooltip-bubble[role="tooltip"]', { timeout: timeoutMs });
    const tooltip = await page.$eval('.vcp-harness-tooltip-bubble[role="tooltip"]', node => ({ text: node.textContent, side: node.dataset.side, portal: node.parentElement === document.body }));
    assert.deepEqual(tooltip, { text: initial.ariaLabel, side: 'top', portal: true });
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => !document.querySelector('.vcp-harness-tooltip-bubble'), { timeout: timeoutMs });

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#appTrayDrawer')?.classList.contains('active'), { timeout: timeoutMs });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'appTrayMoreBtn', 'Escape restores focus to the canonical drawer trigger');
    await page.evaluate(() => document.getElementById('appTrayMoreBtn')?.click());
    await page.waitForFunction(() => document.querySelector('#appTrayDrawer')?.classList.contains('active'), { timeout: timeoutMs });

    const teardown = await page.evaluate(async () => {
        await window.trayManager?.dispose?.();
        return {
            scopes: window.VCPLifecycle?.diagnostics?.snapshot?.().filter(scope => scope.label.startsWith('next:app-tray')) || [],
            candidate: document.querySelector('#appTrayDrawerGrid .app-tray-drawer-item')?.classList.contains('vcp-harness-button') || false,
            tooltip: Boolean(document.querySelector('.vcp-harness-tooltip-bubble')),
        };
    });
    assert.deepEqual(teardown, { scopes: [], candidate: false, tooltip: false }, 'drawer owner teardown must quiesce generated effects');
    console.log('Electron generated app-tray Button/Tooltip journey passed (open/reopen/Escape/focus/teardown).');
} finally {
    await browser?.disconnect().catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    // An Electron main process can wait briefly for renderer/GPU shutdown.
    // Keep this evidence command bounded even when a prior assertion fails.
    const didExit = await Promise.race([childExited.then(() => true), sleep(5_000).then(() => false)]);
    if (!didExit && child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([childExited, sleep(5_000)]);
    }
    await fs.rm(appData, { recursive: true, force: true });
}
