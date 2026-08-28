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

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-uiux-settings-entry-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next', enableDistributedServer: false, vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'settings-entry-probe',
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
    assert.ok(page, `Settings entry renderer missing: ${stderr}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true'
        && window.VCPUIUX?.mountButton && window.VCPUISettingsBridge, { timeout: timeoutMs });
    await page.waitForFunction(() => document.getElementById('globalSettingsBtn')?.dataset.vcpTypedGlobalSettingsEntry === 'true', { timeout: timeoutMs });

    const initial = await page.$eval('#globalSettingsBtn', button => {
        const style = getComputedStyle(button);
        return {
            candidate: button.classList.contains('vcp-harness-button') && button.classList.contains('outline') && button.classList.contains('sm'),
            marker: button.dataset.vcpTypedGlobalSettingsEntry || '',
            type: button.getAttribute('type'),
            height: style.height,
            radius: style.borderRadius,
        };
    });
    assert.deepEqual(initial, {
        candidate: true, marker: 'true', type: 'button', height: '28px', radius: '14px',
    }, 'the Settings entry must use the generated small Button geometry');

    await page.click('#globalSettingsBtn');
    await page.waitForFunction(() => document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });
    await page.evaluate(() => window.uiHelperFunctions.closeModal('globalSettingsModal'));
    await page.waitForFunction(() => !document.getElementById('globalSettingsModal')?.classList.contains('active'), { timeout: timeoutMs });

    const teardown = await page.evaluate(async () => {
        await window.VCPUISettingsBridge.destroy();
        const button = document.getElementById('globalSettingsBtn');
        return {
            candidate: button?.classList.contains('vcp-harness-button') || false,
            marker: button?.dataset.vcpTypedGlobalSettingsEntry || '',
        };
    });
    assert.deepEqual(teardown, { candidate: false, marker: '' }, 'Settings bridge teardown must retract the generated Button owner');
    console.log('Electron generated global Settings entry Button journey passed (mount/click/close/teardown).');
} finally {
    await browser?.disconnect().catch(() => {});
    if (child.exitCode === null) child.kill('SIGTERM');
    const didExit = await Promise.race([childExited.then(() => true), sleep(5_000).then(() => false)]);
    if (!didExit && child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([childExited, sleep(5_000)]);
    }
    await fs.rm(appData, { recursive: true, force: true });
}
