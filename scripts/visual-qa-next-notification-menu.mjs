/* Real Electron visual-cascade fixture for the production Next notification menu. */
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
  : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const theme = process.env.VCPCHAT_VISUAL_QA_THEME || 'light';
const output = path.resolve(process.env.VCPCHAT_NOTIFICATION_MENU_QA_OUTPUT
  || path.join(root, 'reports/visual-forensics-qa/notification-menu', theme));
const viewports = [[800, 600], [1280, 800], [1680, 1000]];
const timeout = 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = url => new Promise((resolve, reject) => http.get(url, response => { response.resume(); response.once('end', resolve); }).once('error', reject));
const port = await new Promise((resolve, reject) => { const server = http.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-notification-menu-'));
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({ uiMode: 'next', currentThemeMode: theme, enableDistributedServer: false, vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'notification-qa' }), 'utf8');
const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${port}`], { cwd: root, env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
let stderr = ''; child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
let browser;
const evidence = { generatedAt: new Date().toISOString(), theme, viewports, output, source: 'VCP production Next notification menu', captures: [], gate: { pass: true, failures: [] } };

async function terminate() {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5_000)]);
  if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

// The remote-debugging endpoint can become available before Electron has
// created its real renderer page.  Poll for that page first so a harness
// startup race is not reported as a missing notification-menu UI.
async function waitForMainRenderer(browser, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const page = (await browser.pages()).find(candidate => !candidate.isClosed() && candidate.url().includes('main.html'));
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`main renderer missing after ${timeout}ms${lastError ? `: ${lastError.message}` : ''}`);
}

try {
  const css = await fs.readFile(new URL('../styles/ui-system/notifications.css', import.meta.url), 'utf8');
  evidence.cascadeContract = {
    triggerRule: /\.next-ui-notification-menu-trigger[\s\S]*?height:\s*var\(--vcp-ui-control-md\)/.test(css),
    menuRule: /\.next-ui-notification-menu[\s\S]*?z-index:\s*90/.test(css),
    itemRule: /\.next-ui-notification-menu-item[\s\S]*?min-height:\s*var\(--vcp-ui-control-md\)/.test(css),
    focusRule: /\.next-ui-notification-menu-item\):focus-visible/.test(css),
  };
  assert.deepEqual(evidence.cascadeContract, { triggerRule: true, menuRule: true, itemRule: true, focusRule: true }, 'notification menu authored cascade contract drifted');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { await request(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); } }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = await waitForMainRenderer(browser, deadline);
  assert.ok(page, `main renderer missing: ${stderr}`);
  await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true'
    && document.getElementById('nextUiNotificationMenuBtn')
    && document.getElementById('nextUiNotificationMenu'), { timeout: Math.max(1, deadline - Date.now()) });

  for (const [width, height] of viewports) {
    const name = `${width}x${height}`;
    await page.setViewport({ width, height, deviceScaleFactor: 1 }); await sleep(120);
    await page.evaluate(() => { if (!document.getElementById('notificationsSidebar')?.classList.contains('active')) document.getElementById('toggleNotificationsBtn')?.click(); });
    await page.waitForFunction(() => document.getElementById('notificationsSidebar')?.classList.contains('active'), { timeout });
    await page.$eval('#nextUiNotificationMenuBtn', node => node.click());
    await page.waitForFunction(() => !document.getElementById('nextUiNotificationMenu')?.hidden, { timeout });
    const open = await page.evaluate(() => {
      const menu = document.getElementById('nextUiNotificationMenu'); const trigger = document.getElementById('nextUiNotificationMenuBtn');
      const r = menu.getBoundingClientRect(); const t = trigger.getBoundingClientRect();
      const items = [...menu.querySelectorAll('[role^="menuitem"]')];
      const describe = node => { const b = node.getBoundingClientRect(); const s = getComputedStyle(node); return { id: node.id, rect: { x: b.x, y: b.y, width: b.width, height: b.height }, height: s.height, minHeight: s.minHeight, padding: s.padding, gap: s.gap, radius: s.borderRadius, color: s.color, backgroundColor: s.backgroundColor, outline: s.outline, role: node.getAttribute('role'), ariaChecked: node.getAttribute('aria-checked'), harnessButton: node.classList.contains('vcp-harness-button') }; };
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const ms = getComputedStyle(menu); const as = getComputedStyle(trigger.parentElement);
      return { menu: { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, position: ms.position, zIndex: ms.zIndex, left: ms.left, right: ms.right, inViewport: r.left >= -2 && r.top >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2, topmost: menu.contains(hit) }, trigger: { rect: { x: t.x, y: t.y, width: t.width, height: t.height }, expanded: trigger.getAttribute('aria-expanded'), color: getComputedStyle(trigger).color, backgroundColor: getComputedStyle(trigger).backgroundColor }, actionsPosition: as.position, innerWidth, compactMedia: matchMedia('(max-width: 960px)').matches, items: items.map(describe), bodyInlineStyle: document.body.getAttribute('style') || '' };
    });
    assert.equal(open.trigger.expanded, 'true', `${name}: notification trigger did not expand`);
    assert.ok(open.menu.inViewport && open.menu.topmost, `${name}: notification menu is clipped or occluded: ${JSON.stringify(open.menu)}`);
    assert.equal(open.items.length, 7, `${name}: notification action count drifted`);
    assert.ok(open.items.filter(item => !['nextUiNotificationFilterToggle', 'nextUiNotificationClear'].includes(item.id)).every(item => item.harnessButton), `${name}: neutral notification actions lost generated Button presentation`);
    assert.ok(open.items.filter(item => item.harnessButton).every(item => Number.parseFloat(item.height) >= 35.5), `${name}: generated notification action below 36px: ${JSON.stringify(open.items)}`);
    await page.hover('#nextUiNotificationForum'); await sleep(50);
    const hover = await page.$eval('#nextUiNotificationForum', node => ({ hovered: node.matches(':hover'), backgroundColor: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
    await page.$eval('#nextUiNotificationForum', node => node.focus());
    const focus = await page.$eval('#nextUiNotificationForum', node => ({ focused: document.activeElement === node, outline: getComputedStyle(node).outline }));
    await page.$eval('#nextUiNotificationFilterToggle', node => node.click());
    await page.waitForFunction(() => document.getElementById('nextUiNotificationMenu')?.hidden, { timeout });
    const selected = await page.$eval('#nextUiNotificationFilterToggle', node => ({ checked: node.getAttribute('aria-checked'), state: document.getElementById('nextUiNotificationFilterState')?.textContent || '', backgroundColor: getComputedStyle(node).backgroundColor }));
    const resizedWidth = Math.max(640, width - 120);
    await page.setViewport({ width: resizedWidth, height, deviceScaleFactor: 1 }); await sleep(100);
    const resized = await page.evaluate(() => { const menu = document.getElementById('nextUiNotificationMenu'); const r = menu.getBoundingClientRect(); return { innerWidth, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, inViewport: r.left >= -2 && r.top >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2 }; });
    await page.setViewport({ width, height, deviceScaleFactor: 1 }); await sleep(100);
    const restored = await page.evaluate(() => { const menu = document.getElementById('nextUiNotificationMenu'); const r = menu.getBoundingClientRect(); return { innerWidth, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, inViewport: r.left >= -2 && r.top >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2 }; });
    await page.$eval('#nextUiNotificationMenuBtn', node => node.click());
    await page.waitForFunction(() => !document.getElementById('nextUiNotificationMenu')?.hidden, { timeout });
    await page.screenshot({ path: path.join(output, `${name}-notification-menu-open.png`), fullPage: false });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('nextUiNotificationMenu')?.hidden && document.activeElement?.id === 'nextUiNotificationMenuBtn', { timeout });
    const closed = await page.evaluate(() => ({ hidden: document.getElementById('nextUiNotificationMenu')?.hidden, expanded: document.getElementById('nextUiNotificationMenuBtn')?.getAttribute('aria-expanded'), focus: document.activeElement?.id || '', bodyInlineStyle: document.body.getAttribute('style') || '' }));
    await page.$eval('#nextUiNotificationMenuBtn', node => node.click()); await page.waitForFunction(() => !document.getElementById('nextUiNotificationMenu')?.hidden, { timeout });
    const reopen = await page.evaluate(() => ({ hidden: document.getElementById('nextUiNotificationMenu')?.hidden, active: document.activeElement?.id || '', selected: document.getElementById('nextUiNotificationFilterToggle')?.getAttribute('aria-checked') }));
    await page.keyboard.press('Escape');
    evidence.captures.push({ viewport: { width, height }, open, hover, focus, selected, resized, restored, closed, reopen });
  }
} catch (error) { evidence.gate.pass = false; evidence.gate.failures.push(error?.stack || String(error)); process.exitCode = 2; }
finally { await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`); try { browser?.disconnect(); } catch {} await terminate(); await fs.rm(appData, { recursive: true, force: true }); }
console.log(JSON.stringify({ output, pass: evidence.gate.pass, captures: evidence.captures.length }, null, 2));
