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

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-human-toolbox-classic-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    // Deliberately request next: the surface policy must override it.
    uiMode: 'next',
    vcpServerUrl: 'http://127.0.0.1:6005/v1/human/tool',
    vcpApiKey: 'hermetic-test',
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
try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Human ToolBox exited before startup: ${stderr.value}`);
        try { await requestJson(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(120); }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    let page;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => candidate.url().includes('VCPHumanToolBox/index.html'));
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `Human ToolBox renderer did not appear: ${stderr.value}`);
    await page.waitForSelector('.container', { timeout: timeoutMs });
    const state = await page.evaluate(() => ({
        mode: document.documentElement.dataset.uiMode,
        legacy: Boolean(document.querySelector('.container')),
        shell: Boolean(document.querySelector('.vcp-ui-page-shell')),
        bodyScope: document.body.classList.contains('vcp-ui-scope'),
        waCount: document.querySelectorAll('wa-button, wa-input, wa-select, wa-card, wa-tooltip').length,
    }));
    assert.deepEqual(state, { mode: 'classic', legacy: true, shell: false, bodyScope: false, waCount: 0 });
    console.log('Electron Human ToolBox archived-classic smoke passed.');
} finally {
    try { await browser?.disconnect(); } catch { /* best effort */ }
    if (child.exitCode === null) child.kill();
    await fs.rm(appData, { recursive: true, force: true });
}
