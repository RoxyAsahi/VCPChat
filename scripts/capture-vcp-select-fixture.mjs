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
    ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(root, 'node_modules/electron/dist/electron');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = await new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const request = url => new Promise((resolve, reject) => http.get(url, response => { response.resume(); response.once('end', resolve); }).once('error', reject));
const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-select-fixture-'));
await fs.mkdir(path.join(appData, 'Agents', 'SelectProbe'), { recursive: true });
await fs.writeFile(path.join(appData, 'Agents', 'SelectProbe', 'config.json'), JSON.stringify({ name: 'Select Probe', model: 'select-probe', promptMode: 'original', originalSystemPrompt: 'Select probe', systemPrompt: 'Select probe', stripRegexes: [] }));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({ uiMode: 'next', enableDistributedServer: false, vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'select-probe', assistantAgent: 'SelectProbe', currentThemeMode: 'light' }));
const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${port}`], { cwd: root, env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let browser;
try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) { try { await request(`http://127.0.0.1:${port}/json/version`); break; } catch { await wait(100); } }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
    assert.ok(page, 'Electron main page was not found');
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: 45_000 });
    const capture = await page.evaluate(() => {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:198.859375px;top:174px;width:334px;height:40px;z-index:2147483647';
        host.innerHTML = '<select id="fixture-select"><option value="standard" data-description="Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.">Standard mode</option><option value="code" data-description="All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program.">Code mode</option><option value="minimal" data-description="Two-tool coding agent with persistent bash and str_replace_editor.">Minimal mode</option><option value="creator" data-description="Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.">Creator mode</option></select>';
        host.querySelector('select').id = `vcp-select-fixture-${Date.now()}`;
        const releases = [];
        const scope = { own(disposer) { releases.push(disposer); return disposer; }, listen(target, type, handler, options) { target.addEventListener(type, handler, options); const release = () => target.removeEventListener(type, handler, options); releases.push(release); return release; } };
        window.VCPUIUX.mountSelect(host.querySelector('select'), { label: 'Agent preset', portal: true }, scope);
        document.body.append(host);
        const triggers = host.querySelectorAll('.vcp-harness-select-trigger');
        if (triggers.length !== 1) return { status: 'unexpected-trigger-count', triggerCount: triggers.length };
        triggers[0].click();
        const menu = document.getElementById(triggers[0].getAttribute('aria-controls'));
        if (!menu) return { status: 'missing-vcp-menu' };
        const rect = menu.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const triggerRect = host.querySelector('.vcp-harness-select-trigger').getBoundingClientRect();
        const computed = getComputedStyle(menu);
        const items = [...menu.querySelectorAll('[role="menuitem"]')].map(item => { const style = getComputedStyle(item); const r = item.getBoundingClientRect(); return { tag: item.tagName.toLowerCase(), class: item.className, role: item.getAttribute('role'), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, style: { display: style.display, minHeight: style.minHeight, padding: style.padding, gap: style.gap, borderRadius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight } }; });
        const result = { status: 'captured', diagnostics: { scrollX: window.scrollX, scrollY: window.scrollY, triggerControls: triggers[0].getAttribute('aria-controls'), menuId: menu.id, matchingIds: document.querySelectorAll(`#${CSS.escape(menu.id)}`).length, mountSourceHasAnchorPlacement: window.VCPUIUX.mountSelect.toString().includes('anchor.bottom + 4'), hostRect: { x: hostRect.x, y: hostRect.y, width: hostRect.width, height: hostRect.height }, triggerRect: { x: triggerRect.x, y: triggerRect.y, width: triggerRect.width, height: triggerRect.height }, htmlTransform: getComputedStyle(document.documentElement).transform, bodyTransform: getComputedStyle(document.body).transform, menuPosition: computed.position, menuTop: computed.top, menuLeft: computed.left, menuWidth: computed.width, menuTransform: computed.transform }, dom: menu.outerHTML, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: { padding: computed.padding, borderRadius: computed.borderRadius, minWidth: computed.minWidth, boxShadow: computed.boxShadow }, items };
        return result;
    });
    assert.equal(capture.status, 'captured', JSON.stringify(capture));
    assert.equal(capture.items.length, 4, JSON.stringify(capture));
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/vcp-select-production.json'), JSON.stringify({ source: 'VCP generated artifact Electron fixture', viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, ...capture }, null, 2));
    await page.screenshot({ path: path.join(root, 'reports/vcp-select-production.png') });
    console.log(`VCP Select fixture captured (${capture.items.length} menuitems).`);
} finally {
    browser?.disconnect();
    if (child.exitCode === null) child.kill('SIGKILL');
}
