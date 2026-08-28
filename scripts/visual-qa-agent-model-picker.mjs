/**
 * Real Electron visual-forensics capture for the production Agent Model Picker.
 * This is intentionally separate from the Candidate Lab capture: it opens the
 * shipped Agent Settings surface and records topmost hit testing, stacking
 * context, geometry, theme tokens, and close/reopen cleanup.
 */
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
const electron = process.platform === 'darwin'
  ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const theme = process.env.VCPCHAT_VISUAL_QA_THEME || 'light';
const output = path.resolve(process.env.VCPCHAT_AGENT_MODEL_PICKER_QA_OUTPUT
  || path.join(root, 'reports/visual-forensics-qa/agent-model-picker', theme));
await fs.mkdir(output, { recursive: true });
const viewports = [[800, 600], [1280, 800], [1680, 1000]];
const timeoutMs = 90_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  Promise.resolve(promise).then(
    value => { clearTimeout(timer); resolve(value); },
    error => { clearTimeout(timer); reject(error); },
  );
});
const requestJson = url => new Promise((resolve, reject) => {
  http.get(url, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  }).once('error', reject);
});
const freePort = async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
const modelServer = http.createServer((request, response) => {
  if (request.url !== '/v1/models') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [
    { id: 'probe-model', name: 'Probe Model', owned_by: 'Probe' },
    { id: 'probe-secondary', name: 'Probe Secondary', owned_by: 'Probe' },
  ] }));
});
await new Promise((resolve, reject) => modelServer.once('error', reject).listen(0, '127.0.0.1', resolve));
const modelPort = modelServer.address().port;
const remotePort = await freePort();
const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-agent-model-picker-qa-'));
await fs.mkdir(path.join(appData, 'Agents', 'VisualQA'), { recursive: true });
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
  uiMode: 'next', enableDistributedServer: false, currentThemeMode: theme,
  vcpServerUrl: `http://127.0.0.1:${modelPort}`, vcpApiKey: 'visual-qa', assistantAgent: 'VisualQA',
}), 'utf8');
await fs.writeFile(path.join(appData, 'Agents', 'VisualQA', 'config.json'), JSON.stringify({
  name: 'Visual QA', model: 'probe-model', promptMode: 'original',
  originalSystemPrompt: 'Visual QA', systemPrompt: 'Visual QA', stripRegexes: [],
}), 'utf8');

const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${remotePort}`], {
  cwd: root, env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
  stdio: ['ignore', 'ignore', 'pipe'], detached: true,
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12_000); });
let browser;
const evidence = { generatedAt: new Date().toISOString(), source: 'VCP production Agent Settings Electron Surface', reference: 'deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx', theme, viewports, output, captures: [], gate: { pass: true, failures: [] } };

try {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { await requestJson(`http://127.0.0.1:${remotePort}/json/version`); break; } catch { await sleep(100); } }
  // The DevTools HTTP endpoint can be live while its CDP transport is wedged
  // by a saturated local Electron host.  Bound both setup steps so that the
  // failure is recorded in the evidence manifest and finally can reclaim the
  // detached test app instead of leaving an unbounded QA worker behind.
  browser = await within(
    puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, protocolTimeout: timeoutMs }),
    'connect to production ModelPicker Electron renderer',
  );
  const pages = await within(browser.pages(), 'enumerate production ModelPicker Electron pages');
  const page = pages.find(candidate => candidate.url().includes('main.html'));
  assert.ok(page, `main renderer missing: ${stderr}`);
  await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
  await page.waitForSelector('#agentList [data-item-id="VisualQA"]', { timeout: timeoutMs });
  await page.evaluate(async () => {
    window.topTabManager.setView('home');
    window.uiManager.switchToTab('agents');
    document.querySelector('#agentList [data-item-id="VisualQA"]')?.click();
    window.uiManager.switchToTab('settings');
    await window.settingsManager.displaySettingsForItem();
  });
  await page.waitForFunction(() => document.getElementById('editingAgentId')?.value === 'VisualQA'
    && document.getElementById('tabContentSettings')?.classList.contains('active'), { timeout: timeoutMs });
  await page.evaluate(() => {
    const button = document.querySelector('#modelToggleBtn');
    if (button?.getAttribute('aria-expanded') !== 'true') button?.click();
  });
  await page.waitForSelector('#agentSettingsForm #openModelSelectBtn.vcp-harness-agent-model-picker-trigger', { timeout: timeoutMs });
  await sleep(150);

  for (const [width, height] of viewports) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await sleep(120);
    const name = `${width}x${height}`;
    await page.evaluate(() => {
      const button = document.querySelector('#modelToggleBtn');
      if (button?.getAttribute('aria-expanded') !== 'true') button?.click();
    }).catch(() => {});
    await sleep(80);
    const before = await page.evaluate(() => {
      const describe = node => {
        if (!node) return null;
        const value = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { tag: node.tagName.toLowerCase(), id: node.id || '', className: typeof node.className === 'string' ? node.className : '', rect: { x: value.x, y: value.y, width: value.width, height: value.height }, position: style.position, zIndex: style.zIndex, display: style.display, opacity: style.opacity, transform: style.transform };
      };
      const trigger = document.querySelector('#agentSettingsForm #openModelSelectBtn');
      return { trigger: describe(trigger), theme: { body: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, colorScheme: getComputedStyle(document.documentElement).colorScheme } };
    });
    await page.click('#agentSettingsForm #openModelSelectBtn');
    await page.waitForFunction(() => document.querySelector('.vcp-harness-popup-select-card')?.getClientRects().length > 0, { timeout: timeoutMs });
    const open = await page.evaluate(() => {
      const describe = node => {
        if (!node) return null;
        const value = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { tag: node.tagName.toLowerCase(), id: node.id || '', className: typeof node.className === 'string' ? node.className : '', rect: { x: value.x, y: value.y, width: value.width, height: value.height }, position: style.position, zIndex: style.zIndex, display: style.display, opacity: style.opacity, transform: style.transform };
      };
      const trigger = document.querySelector('#agentSettingsForm #openModelSelectBtn');
      const card = document.querySelector('.vcp-harness-popup-select-card');
      const r = card?.getBoundingClientRect();
      const x = r ? Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2)) : 0;
      const y = r ? Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2)) : 0;
      const topmost = document.elementFromPoint(x, y);
      const chain = [];
      for (let node = topmost; node && chain.length < 6; node = node.parentElement) chain.push(describe(node));
      const ancestors = [];
      for (let node = card; node && ancestors.length < 8; node = node.parentElement) ancestors.push(describe(node));
      return { trigger: describe(trigger), card: describe(card), point: { x, y }, topmost: describe(topmost), topmostInsideCard: Boolean(card && topmost && card.contains(topmost)), topmostChain: chain, cardAncestors: ancestors, bodyOverflow: getComputedStyle(document.body).overflow, htmlOverflow: getComputedStyle(document.documentElement).overflow };
    });
    await page.screenshot({ path: path.join(output, `${name}-open.png`), fullPage: false });
    // Root geometry alone cannot catch a selector that only leaks into the
    // real model rows.  Enter the production model pane and capture an actual
    // pointer-hover state before returning to the root pane for resize checks.
    await page.click('.vcp-harness-popup-select-card .vcp-harness-agent-model-picker-cell');
    await page.waitForSelector('.vcp-harness-popup-select-card .vcp-harness-popup-select-viewport [data-option-id]', { timeout: timeoutMs });
    const modelRowSelector = '.vcp-harness-popup-select-card .vcp-harness-popup-select-viewport [data-option-id]:not([aria-disabled="true"])';
    assert.ok(await page.$(modelRowSelector), `${name}: production model pane has no enabled option`);
    const modelDirectory = await page.evaluate(() => {
      const card = document.querySelector('.vcp-harness-popup-select-card');
      const describe = node => {
        if (!card || !node) return null;
        const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
        const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const topmost = document.elementFromPoint(point.x, point.y);
        return {
          text: node.textContent?.trim() || '', disabled: node.disabled,
          pressed: node.getAttribute('aria-pressed'), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          color: style.color, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius,
          inViewport: rect.width > 0 && rect.height > 0 && rect.left >= -2 && rect.top >= -2 && rect.right <= innerWidth + 2 && rect.bottom <= innerHeight + 2,
          topmostInsideCard: Boolean(topmost && card.contains(topmost)),
        };
      };
      return {
        refresh: describe(card?.querySelector('.vcp-harness-agent-model-picker-directory-refresh')),
        favorite: describe(card?.querySelector('[data-option-action="favorite"]')),
      };
    });
    await page.screenshot({ path: path.join(output, `${name}-model-directory.png`), fullPage: false });
    // The real catalog may publish a fresh row list between waitForSelector
    // and pointer placement. Resolve at the action boundary so a late
    // projection rebuild cannot turn visual evidence into a detached-handle
    // false negative.
    let hoverError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await page.hover(modelRowSelector);
        hoverError = null;
        break;
      } catch (error) {
        hoverError = error;
        if (!/detached/i.test(String(error?.message || error)) || attempt === 3) break;
        await sleep(80);
      }
    }
    assert.equal(hoverError, null, `${name}: production model row detached throughout hover retry window: ${hoverError?.message || hoverError}`);
    await sleep(80);
    const modelPaneHover = await page.evaluate(() => {
      const card = document.querySelector('.vcp-harness-popup-select-card');
      const row = card?.querySelector('.vcp-harness-popup-select-viewport [data-option-id]:not([aria-disabled="true"])');
      if (!card || !row) return null;
      const rect = row.getBoundingClientRect(); const style = getComputedStyle(row);
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const topmost = document.elementFromPoint(point.x, point.y);
      return {
        role: row.getAttribute('role'), hovered: row.matches(':hover'),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        backgroundColor: style.backgroundColor, color: style.color,
        borderRadius: style.borderRadius, outline: style.outline, boxShadow: style.boxShadow,
        topmostInsideCard: Boolean(topmost && card.contains(topmost)),
      };
    });
    await page.screenshot({ path: path.join(output, `${name}-model-hover.png`), fullPage: false });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.vcp-harness-popup-select-card .vcp-harness-agent-model-picker-cell')?.hidden === false, { timeout: timeoutMs });
    await page.setViewport({ width: Math.max(320, width - 240), height, deviceScaleFactor: 1 });
    await sleep(160);
    const narrow = await page.evaluate(() => {
      const card = document.querySelector('.vcp-harness-popup-select-card');
      if (!card) return { open: false, card: null };
      const r = card.getBoundingClientRect(); const style = getComputedStyle(card);
      const point = { x: Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2)) };
      const topmost = document.elementFromPoint(point.x, point.y);
      return { open: card.getClientRects().length > 0, card: { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, position: style.position, zIndex: style.zIndex, parent: card.parentElement === document.body ? 'body' : card.parentElement?.className || '' }, point, topmostInsideCard: Boolean(topmost && card.contains(topmost)), inViewport: r.x >= -2 && r.y >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2 };
    });
    await page.screenshot({ path: path.join(output, `${name}-narrow-open.png`), fullPage: false });
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await sleep(160);
    const restored = await page.evaluate(() => {
      const card = document.querySelector('.vcp-harness-popup-select-card');
      if (!card) return { open: false, card: null };
      const r = card.getBoundingClientRect(); const style = getComputedStyle(card);
      const point = { x: Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2)), y: Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2)) };
      const topmost = document.elementFromPoint(point.x, point.y);
      return { open: card.getClientRects().length > 0, card: { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, position: style.position, zIndex: style.zIndex, parent: card.parentElement === document.body ? 'body' : card.parentElement?.className || '' }, point, topmostInsideCard: Boolean(topmost && card.contains(topmost)), inViewport: r.x >= -2 && r.y >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2 };
    });
    await page.screenshot({ path: path.join(output, `${name}-restored-open.png`), fullPage: false });
    await page.$eval('.vcp-harness-popup-select-card', card => card.focus()).catch(() => {});
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.vcp-harness-popup-select-card')?.getClientRects().length && document.activeElement?.id === 'openModelSelectBtn', { timeout: timeoutMs });
    const closed = await page.evaluate(() => ({ cardCount: document.querySelectorAll('.vcp-harness-popup-select-card').length, expanded: document.querySelector('#agentSettingsForm #openModelSelectBtn')?.getAttribute('aria-expanded'), active: document.activeElement?.id, bodyClass: document.body.className, bodyStyle: document.body.getAttribute('style') || '' }));
    evidence.captures.push({ viewport: { width, height, deviceScaleFactor: 1 }, before, open, modelDirectory, modelPaneHover, narrow, restored, closed });
    if (!open.topmostInsideCard) evidence.gate.failures.push(`${name}: menu center topmost element is outside card`);
    if (!modelPaneHover?.hovered || !modelPaneHover.topmostInsideCard) evidence.gate.failures.push(`${name}: model-row hover is not painted/hittable ${JSON.stringify(modelPaneHover)}`);
    for (const [action, snapshot] of Object.entries(modelDirectory)) {
      if (!snapshot?.inViewport || !snapshot.topmostInsideCard) evidence.gate.failures.push(`${name}: model-directory ${action} is not visible/hittable ${JSON.stringify(snapshot)}`);
    }
    if (open.card?.position !== 'fixed' && open.card?.position !== 'absolute') evidence.gate.failures.push(`${name}: menu has unexpected position ${open.card?.position}`);
    for (const [phase, snapshot] of [['narrow', narrow], ['restored', restored]]) {
      if (!snapshot.open || !snapshot.inViewport || !snapshot.topmostInsideCard) evidence.gate.failures.push(`${name}: ${phase} menu containment/hit-test ${JSON.stringify(snapshot)}`);
      if (snapshot.card?.position !== 'fixed' || snapshot.card?.parent !== 'body') evidence.gate.failures.push(`${name}: ${phase} menu portal ${JSON.stringify(snapshot.card)}`);
    }
    if (closed.cardCount !== 0 || closed.expanded !== 'false' || closed.active !== 'openModelSelectBtn') evidence.gate.failures.push(`${name}: close/focus cleanup ${JSON.stringify(closed)}`);
  }
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(output, 'stderr.txt'), stderr, 'utf8');
  console.log(JSON.stringify(evidence, null, 2));
  evidence.gate.pass = evidence.gate.failures.length === 0;
  await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  if (!evidence.gate.pass) process.exitCode = 2;
} catch (error) {
  evidence.gate.pass = false;
  evidence.gate.failures.push(error.message);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.error(JSON.stringify(evidence, null, 2));
  process.exitCode = 2;
} finally {
  try { browser?.disconnect(); } catch {}
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    await Promise.race([exited, sleep(2_000)]);
  }
  await new Promise(resolve => modelServer.close(resolve));
  // Electron descendants can retain a profile file for a short interval after
  // the detached process group receives SIGTERM.  Do not turn a completed
  // visual gate into a false failure because of that OS-level teardown race.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(appData, { recursive: true, force: true, maxRetries: 0 });
      break;
    } catch (error) {
      if (attempt === 4 || error?.code !== 'ENOTEMPTY') throw error;
      await sleep(250);
    }
  }
}
