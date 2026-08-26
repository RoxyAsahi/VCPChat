import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const harnessPnpm = '/Users/asahi/Documents/Codex/deepseek-harness/node_modules/.pnpm';
const playwrightDir = (await fs.readdir(harnessPnpm)).filter(name => name.startsWith('playwright@')).sort().at(-1);
assert.ok(playwrightDir, 'Harness Playwright runtime is unavailable');
const { chromium } = await import(pathToFileURL(path.join(harnessPnpm, playwrightDir, 'node_modules/playwright/index.mjs')).href);
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#fff}body{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;color:#0f1115}</style><script type="module" src="/modules/uiux/generated/browser-entry.js"></script></head><body></body></html>';
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return; }
    const file = path.join(root, pathname.replace(/^\//, ''));
    if (!file.startsWith(root)) throw new Error('invalid fixture path');
    response.writeHead(200, { 'content-type': pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream' });
    response.end(await fs.readFile(file));
  } catch (error) { response.writeHead(404); response.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.deviceScaleFactor });
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(globalThis.VCPUIUX));
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:198.859375px;top:174px';
    host.innerHTML = '<select id="vcp-select-trigger-fixture"><option value="standard" data-description="Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.">Standard mode</option><option value="code">Code mode</option><option value="minimal">Minimal mode</option><option value="creator">Creator mode</option></select>';
    const releases = [];
    const scope = { own(disposer) { releases.push(disposer); return disposer; }, listen(target, type, handler, options) { target.addEventListener(type, handler, options); const release = () => target.removeEventListener(type, handler, options); releases.push(release); return release; } };
    globalThis.VCPUIUX.mountSelect(host.querySelector('select'), { label: 'Agent preset', portal: true }, scope);
    document.body.append(host);
  });
  const trigger = page.locator('.vcp-harness-select-trigger');
  await trigger.waitFor();
  const evidence = await trigger.evaluate(element => {
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    return {
      source: 'VCP generated UIUX artifact Select primitive',
      semanticFixture: 'agent-preset-selection/ready/Standard mode/closed-trigger',
      state: 'closed-ready-trigger', text: element.textContent?.trim(), dom: element.outerHTML,
      attributes: Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      style: { display: style.display, alignItems: style.alignItems, gap: style.gap, width: style.width, minHeight: style.minHeight, padding: style.padding, borderWidth: style.borderWidth, borderRadius: style.borderRadius, backgroundColor: style.backgroundColor, color: style.color, fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, boxShadow: style.boxShadow, cursor: style.cursor, opacity: style.opacity },
    };
  });
  await fs.mkdir(path.join(root, 'reports'), { recursive: true });
  await fs.writeFile(path.join(root, 'reports/vcp-select-trigger-closed.json'), `${JSON.stringify({ viewport, ...evidence }, null, 2)}\n`);
  await trigger.screenshot({ path: path.join(root, 'reports/vcp-select-trigger-closed.png') });
  console.log(`VCP Select closed-trigger fixture captured (${evidence.rect.width}x${evidence.rect.height}).`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
