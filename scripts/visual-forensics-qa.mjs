/**
 * Real Electron visual-forensics scan for the active Next UI surfaces.
 * This intentionally records runtime evidence (pixels, geometry, computed
 * styles and DOM) instead of treating static CSS or unit tests as proof.
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
const viewports = [[800, 600], [1280, 800], [1680, 1000]];
const timeout = 90_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = url => new Promise((resolve, reject) => http.get(url, response => { response.resume(); response.once('end', resolve); }).once('error', reject));
const port = await new Promise((resolve, reject) => { const server = http.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const output = path.resolve(process.env.VCPCHAT_VISUAL_QA_OUTPUT || path.join(root, 'reports/visual-forensics-qa', new Date().toISOString().replaceAll(':', '-')));
await fs.mkdir(output, { recursive: true });
const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-visual-qa-'));
await fs.mkdir(path.join(appData, 'Agents', 'VisualQA'), { recursive: true });
await fs.writeFile(path.join(appData, 'Agents', 'VisualQA', 'config.json'), JSON.stringify({ name: 'Visual QA', model: 'visual-qa', promptMode: 'original', originalSystemPrompt: 'Visual QA', systemPrompt: 'Visual QA', stripRegexes: [] }));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({ uiMode: 'next', enableDistributedServer: false, vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'visual-qa', assistantAgent: 'VisualQA', currentThemeMode: process.env.VCPCHAT_VISUAL_QA_THEME || 'light' }));
const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${port}`], { cwd: root, env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12_000); });
let browser;
const evidence = { generatedAt: new Date().toISOString(), viewports, output, observations: [], gate: { pass: true, failures: [] } };
try {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { await request(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); } }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
  assert.ok(page, `main renderer missing: ${stderr}`);
  await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout });
  // Exercise the shipped showcase entry when available. If the app is booted
  // in a minimal mode the main surface remains the useful fallback evidence.
  const showcaseButton = await page.$('#nextUiAddTabBtn');
  if (showcaseButton) {
    await showcaseButton.click().catch(() => {});
    await sleep(300);
    await page.evaluate(() => {
      if (document.querySelector('.vcp-ui-showcase-root')) return;
      const item = [...document.querySelectorAll('.next-ui-internal-app-item')].find(node => node.getAttribute('title') === 'UI 组件库');
      if (item) { item.click(); return; }
      window.topTabManager?.openInternalApp?.('ui-component-library');
    }).catch(() => {});
    await page.waitForSelector('.vcp-ui-showcase-root', { timeout: 15_000 }).catch(() => {});
  }
  for (const [width, height] of viewports) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(250);
    const name = `${width}x${height}`;
    await page.screenshot({ path: path.join(output, `${name}-initial.png`), fullPage: true });
    const initial = await page.evaluate(() => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const owner = el.closest('.vcp-ui-showcase-root, .vcp-ui-page-shell, #main-content, #chat-container')?.className || 'document'; return { tag: el.tagName.toLowerCase(), id: el.id, className: el.className, owner, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, display: s.display, position: s.position, zIndex: s.zIndex, color: s.color, backgroundColor: s.backgroundColor, borderRadius: s.borderRadius }; };
      const controls = [...document.querySelectorAll('button, input, select, textarea, [role="dialog"], [role="menu"], [role="tooltip"]')].filter(el => el.getClientRects().length).slice(0, 400);
      const rects = controls.map(visible);
      const overlapPairs = [];
      rects.forEach((a, i) => rects.forEach((b, j) => {
        if (i >= j || a.tag !== b.tag || a.owner !== b.owner) return false;
        const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
        if (contains(a.rect, b.rect) || contains(b.rect, a.rect)) return false;
        if (a.rect.x < b.rect.x + b.rect.width && a.rect.x + a.rect.width > b.rect.x && a.rect.y < b.rect.y + b.rect.height && a.rect.y + a.rect.height > b.rect.y && overlapPairs.length < 8) overlapPairs.push([a.className, b.className]);
      }));
      const overlap = overlapPairs.length > 0;
      const portals = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="tooltip"], [class*="portal"], [class*="overlay"]')].filter(el => el.getClientRects().length).map(visible);
      return { url: location.href, surface: document.querySelector('.vcp-ui-showcase-root') ? 'component-showcase' : 'main', uiMode: document.documentElement.dataset.uiMode || '', theme: document.documentElement.dataset.theme || document.documentElement.dataset.themeMode || '', bodyClass: document.body.className, scroll: { x: document.documentElement.scrollWidth, y: document.documentElement.scrollHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight }, controls: rects, portals, dom: { bodyLength: document.body.innerHTML.length, classes: [...document.body.classList], inlineStyle: document.body.getAttribute('style') || '' }, overlap, overlapPairs };
    });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(100);
    const scrolled = await page.evaluate(() => ({ y: window.scrollY, scrollHeight: document.documentElement.scrollHeight, viewport: innerHeight }));
    await page.screenshot({ path: path.join(output, `${name}-scrolled.png`), fullPage: false });
    await page.setViewport({ width: Math.max(320, width - 240), height });
    await sleep(150);
    const resized = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 1, overflowY: document.documentElement.scrollHeight > innerHeight + 1 }));
    await page.screenshot({ path: path.join(output, `${name}-narrow.png`), fullPage: false });
    evidence.observations.push({ viewport: { width, height }, initial, scrolled, resized });
    if (initial.overlap) evidence.gate.failures.push(`${name}: visible control overlap`);
    if (resized.overflowX) evidence.gate.failures.push(`${name}: horizontal overflow after resize`);
  }
  evidence.gate.pass = evidence.gate.failures.length === 0;
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, stderr: stderr || undefined }, null, 2));
  if (!evidence.gate.pass) process.exitCode = 2;
} catch (error) {
  evidence.gate.pass = false; evidence.gate.failures.push(error.message); await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(evidence, null, 2)); throw error;
} finally {
  await browser?.close().catch(() => {}); child.kill('SIGTERM');
}
