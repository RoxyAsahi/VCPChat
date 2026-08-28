/**
 * Real Electron CSS-cascade fixture for the Next sidebar Account menu and the
 * App Tray drawer. It is presentation-only: no menu item business command is
 * invoked and no Settings are persisted.
 */
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
const output = path.resolve(process.env.VCPCHAT_SIDEBAR_ACCOUNT_TRAY_QA_OUTPUT
  || path.join(root, 'reports/visual-forensics-qa/sidebar-account-tray', theme));
const viewports = [[800, 600], [1280, 800], [1680, 1000]];
const timeout = 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const styleFile = new URL('../styles/ui-system/sidebar.css', import.meta.url);
const request = url => new Promise((resolve, reject) => http.get(url, response => {
  response.resume(); response.once('end', resolve);
}).once('error', reject));
const port = await new Promise((resolve, reject) => {
  const server = http.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-sidebar-account-tray-'));
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
  uiMode: 'next', currentThemeMode: theme, enableDistributedServer: false,
  vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'sidebar-qa',
}), 'utf8');
const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${port}`], {
  cwd: root, env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
});
let stderr = ''; child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
let browser;
const evidence = { generatedAt: new Date().toISOString(), theme, viewports, output, source: 'VCP production Next sidebar', captures: [], gate: { pass: true, failures: [] } };
const rect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height });

async function terminate() {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5_000)]);
  if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

try {
  const sidebarCss = await fs.readFile(styleFile, 'utf8');
  evidence.cascadeContract = {
    accountMenuItemRule: /\.next-ui-account-menu-item[\s\S]*?min-height:\s*var\(--vcp-ui-sidebar-row-height\)/.test(sidebarCss),
    // The generated Button is mounted at runtime on exactly the three Account
    // actions.  Sidebar CSS remains the layout/material owner and must not
    // grow a competing generated-button selector.
    generatedButtonRuleAbsent: !/\.vcp-harness-button/.test(sidebarCss),
    trayMinHeightRule: /#appTrayDrawerGrid\s+\.app-tray-drawer-item[\s\S]*?min-height:\s*var\(--vcp-ui-control-md\)/.test(await fs.readFile(new URL('../styles/ui-system/notifications.css', import.meta.url), 'utf8')),
  };
  assert.deepEqual(evidence.cascadeContract, { accountMenuItemRule: true, generatedButtonRuleAbsent: true, trayMinHeightRule: true }, 'sidebar/tray authored cascade contract drifted');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { await request(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); } }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
  assert.ok(page, `main renderer missing: ${stderr}`);
  await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true' && window.topTabManager?.openAccountMenu, { timeout });

  for (const [width, height] of viewports) {
    const name = `${width}x${height}`;
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await sleep(100);

    await page.evaluate(() => window.topTabManager.openAccountMenu());
    await page.waitForFunction(() => !document.getElementById('nextUiAccountMenu')?.hidden, { timeout });
    const account = await page.evaluate(() => {
      const menu = document.getElementById('nextUiAccountMenu'); const trigger = document.getElementById('nextUiAccountMenuTrigger');
      const items = [...(menu?.querySelectorAll('[role="menuitem"]') || [])]; const r = menu?.getBoundingClientRect();
      const describe = node => { const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return { id: node.id, rect: { x: box.x, y: box.y, width: box.width, height: box.height }, height: style.height, minHeight: style.minHeight, padding: style.padding, gap: style.gap, borderRadius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color, backgroundColor: style.backgroundColor, outline: style.outline }; };
      const first = items[0]; const itemRect = first?.getBoundingClientRect(); const hit = itemRect && document.elementFromPoint(itemRect.left + itemRect.width / 2, itemRect.top + itemRect.height / 2);
      return { menu: menu && r ? { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, position: getComputedStyle(menu).position, zIndex: getComputedStyle(menu).zIndex, inViewport: r.left >= -2 && r.top >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2 } : null,
        triggerExpanded: trigger?.getAttribute('aria-expanded'), items: items.map(node => ({ ...describe(node), harnessButton: node.classList.contains('vcp-harness-button') })), topmostFirstItem: Boolean(first && hit && first.contains(hit)), bodyTheme: [...document.body.classList] };
    });
    assert.equal(account.triggerExpanded, 'true', `${name}: account trigger is not expanded`);
    assert.equal(account.items.length, 3, `${name}: account menu item count drifted`);
    assert.ok(account.items.every(item => item.harnessButton), `${name}: Account actions lost generated Harness Button presentation: ${JSON.stringify(account.items)}`);
    assert.ok(account.menu?.inViewport && account.topmostFirstItem, `${name}: account menu is clipped or occluded: ${JSON.stringify(account.menu)}`);
    assert.ok(account.items.every(item => Number.parseFloat(item.minHeight) >= 36), `${name}: sidebar CSS reduced a menu item below 36px: ${JSON.stringify(account.items)}`);
    await page.hover('#nextUiAccountAppearanceStudioBtn'); await sleep(40);
    const accountHover = await page.$eval('#nextUiAccountAppearanceStudioBtn', node => ({ hovered: node.matches(':hover'), backgroundColor: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
    await page.$eval('#nextUiAccountAppearanceStudioBtn', node => node.focus());
    const accountFocus = await page.$eval('#nextUiAccountAppearanceStudioBtn', node => ({ focused: document.activeElement === node, outline: getComputedStyle(node).outline }));
    await page.screenshot({ path: path.join(output, `${name}-account-open.png`), fullPage: false });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('nextUiAccountMenu')?.hidden && document.activeElement?.id === 'nextUiAccountMenuTrigger', { timeout });
    const accountClosed = await page.evaluate(() => ({ hidden: document.getElementById('nextUiAccountMenu')?.hidden, focus: document.activeElement?.id || '' }));
    await page.evaluate(() => window.topTabManager.openAccountMenu());
    await page.waitForFunction(() => !document.getElementById('nextUiAccountMenu')?.hidden, { timeout });
    const accountReopen = await page.evaluate(() => ({ hidden: document.getElementById('nextUiAccountMenu')?.hidden, active: document.activeElement?.id || '' }));
    await page.keyboard.press('Escape');

    await page.evaluate(() => document.getElementById('appTrayMoreBtn')?.click());
    await page.waitForFunction(() => document.getElementById('appTrayDrawer')?.classList.contains('active') && Number.parseFloat(getComputedStyle(document.getElementById('appTrayDrawer')).opacity) >= .99, { timeout });
    const tray = await page.evaluate(() => {
      const drawer = document.getElementById('appTrayDrawer'); const trigger = document.getElementById('appTrayMoreBtn'); const item = drawer?.querySelector('.app-tray-drawer-item');
      const d = drawer?.getBoundingClientRect(); const i = item?.getBoundingClientRect(); const hit = i && document.elementFromPoint(i.left + i.width / 2, i.top + i.height / 2); const style = item && getComputedStyle(item);
      return { drawer: drawer && d ? { rect: { x: d.x, y: d.y, width: d.width, height: d.height }, position: getComputedStyle(drawer).position, zIndex: getComputedStyle(drawer).zIndex, opacity: getComputedStyle(drawer).opacity, inViewport: d.left >= -2 && d.top >= -2 && d.right <= innerWidth + 2 && d.bottom <= innerHeight + 2 } : null,
        triggerExpanded: trigger?.getAttribute('aria-expanded'), candidate: item?.classList.contains('vcp-harness-button') || false, topmostItem: Boolean(item && hit && item.contains(hit)),
        item: item && style ? { rect: { x: i.x, y: i.y, width: i.width, height: i.height }, height: style.height, minHeight: style.minHeight, padding: style.padding, gap: style.gap, borderRadius: style.borderRadius, outline: style.outline } : null };
    });
    assert.equal(tray.triggerExpanded, 'true', `${name}: tray trigger did not expand`);
    assert.ok(tray.candidate && tray.drawer?.inViewport && tray.topmostItem, `${name}: tray drawer is clipped or occluded: ${JSON.stringify(tray)}`);
    // The generated Button sets an owner-bound inline 36px height because the
    // older dock rules still contribute a 32px min-height. The rendered box,
    // rather than that non-winning lower bound, is the parity contract.
    assert.ok(Number.parseFloat(tray.item?.height) >= 35.5, `${name}: legacy sidebar CSS reduced the rendered tray Button below 36px: ${JSON.stringify(tray.item)}`);
    await page.hover('#appTrayDrawerGrid .app-tray-drawer-item'); await sleep(160);
    const trayHover = await page.$eval('#appTrayDrawerGrid .app-tray-drawer-item', node => ({ hovered: node.matches(':hover'), backgroundColor: getComputedStyle(node).backgroundColor }));
    await page.$eval('#appTrayDrawerGrid .app-tray-drawer-item', node => node.focus());
    await page.waitForSelector('.vcp-harness-tooltip-bubble[role="tooltip"]', { timeout: 2_000 });
    const tooltip = await page.$eval('.vcp-harness-tooltip-bubble[role="tooltip"]', node => { const r = node.getBoundingClientRect(); const s = getComputedStyle(node); return { portal: node.parentElement === document.body, side: node.dataset.side || '', position: s.position, zIndex: s.zIndex, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, inViewport: r.left >= -2 && r.top >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2 }; });
    assert.ok(tooltip.portal && tooltip.inViewport, `${name}: tray tooltip portal is clipped: ${JSON.stringify(tooltip)}`);
    await page.screenshot({ path: path.join(output, `${name}-tray-open.png`), fullPage: false });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('appTrayDrawer')?.classList.contains('active') && document.activeElement?.id === 'appTrayMoreBtn', { timeout });
    const trayClosedImmediate = await page.evaluate(() => ({ tooltip: Boolean(document.querySelector('.vcp-harness-tooltip-bubble')), itemHovered: Boolean(document.querySelector('#appTrayDrawerGrid .app-tray-drawer-item')?.matches(':hover')) }));
    await sleep(180);
    const trayClosed = await page.evaluate((immediate) => ({ active: document.getElementById('appTrayDrawer')?.classList.contains('active') || false, tooltip: Boolean(document.querySelector('.vcp-harness-tooltip-bubble')), focus: document.activeElement?.id || '', immediateTooltip: immediate.tooltip, itemHovered: Boolean(document.querySelector('#appTrayDrawerGrid .app-tray-drawer-item')?.matches(':hover')) }), trayClosedImmediate);
    assert.equal(trayClosed.active, false, `${name}: tray remains active after Escape`);
    assert.equal(trayClosed.focus, 'appTrayMoreBtn', `${name}: tray close did not restore trigger focus`);
    if (trayClosed.tooltip) {
      evidence.gate.failures.push(`${name}: tray close leaves a body tooltip portal after focused item Escape`);
      // Isolate subsequent viewport samples after recording the production
      // leak. The fixture never changes business state; this is only teardown
      // for the next independent capture.
      await page.evaluate(() => document.querySelector('.vcp-harness-tooltip-bubble')?.remove());
    }
    await page.evaluate(() => document.getElementById('appTrayMoreBtn')?.click());
    await page.waitForFunction(() => document.getElementById('appTrayDrawer')?.classList.contains('active'), { timeout });
    const trayReopen = await page.evaluate(() => ({ active: document.getElementById('appTrayDrawer')?.classList.contains('active') || false, itemCount: document.querySelectorAll('#appTrayDrawerGrid .app-tray-drawer-item').length }));
    await page.keyboard.press('Escape');
    evidence.captures.push({ viewport: { width, height }, account: { open: account, hover: accountHover, focus: accountFocus, closed: accountClosed, reopen: accountReopen }, tray: { open: tray, hover: trayHover, tooltip, closed: trayClosed, reopen: trayReopen } });
  }
} catch (error) {
  evidence.gate.pass = false; evidence.gate.failures.push(error?.stack || String(error)); process.exitCode = 2;
} finally {
  await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  try { browser?.disconnect(); } catch {}
  await terminate();
  await fs.rm(appData, { recursive: true, force: true });
}
console.log(JSON.stringify({ output, pass: evidence.gate.pass, captures: evidence.captures.length }, null, 2));
