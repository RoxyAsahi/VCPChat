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
