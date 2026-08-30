import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness';
const harnessRequire = createRequire(`${harnessRoot}/apps/web/package.json`);
const { createServer } = await import(harnessRequire.resolve('vite'));
const { chromium } = harnessRequire('playwright');
const react = harnessRequire.resolve('react');
const reactDom = harnessRequire.resolve('react-dom/client');
const reactJsxDev = harnessRequire.resolve('react/jsx-dev-runtime');
const hoverCard = path.join(harnessRoot, 'packages/client/ui-primitives/src/HoverCard.tsx');
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const virtualId = 'virtual:harness-hover-card-source-fixture';
const resolvedVirtualId = `\0${virtualId}`;
const fixture = `import React from 'react'; import { createRoot } from 'react-dom/client'; import { HoverCard } from '@deepseek-ai/dsh-client-ui-primitives/src/HoverCard.tsx';
const root=createRoot(document.querySelector('#root')); const render=(disabled=false)=>root.render(React.createElement(HoverCard,{anchor:React.createElement('span',{className:'anchor'},'Workspace path'),content:React.createElement('div',null,'/tmp/workspace'),openDelayMs:40,disabled,copyText:'/tmp/workspace',copyLabel:'Copy path',copiedLabel:'Copied'})); render(); globalThis.__harnessHoverFixture={root,render};`;
const vite = await createServer({
  root: harnessRoot, appType: 'custom',
  resolve: { alias: { 'react/jsx-dev-runtime': reactJsxDev, 'react-dom/client': reactDom, react, '@deepseek-ai/dsh-client-ui-primitives/src/HoverCard.tsx': hoverCard } },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [harnessRoot, root] } },
  plugins: [{
    name: 'vcp-harness-hover-card-source-fixture',
    resolveId(id) { return id === virtualId ? resolvedVirtualId : null; },
    load(id) { return id === resolvedVirtualId ? fixture : null; },
    configureServer(server) { server.middlewares.use('/__vcp_harness_hover_card_fixture.html', (_request, response) => { response.statusCode = 200; response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff;--dsw-hovercard-bg:#2c2c2e;--dsw-shadow-lv3:0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08);--dsw-alias-state-business-primary:#2678ff}#root{position:absolute;left:120px;top:160px;width:max-content}.anchor{display:inline-block;padding:8px}</style></head><body><main id="root"></main><script type="module" src="/@id/__x00__${virtualId}"></script></body></html>`); }); },
  }],
});
await vite.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.deviceScaleFactor });
  await page.goto(`${vite.resolvedUrls.local[0]}__vcp_harness_hover_card_fixture.html`, { waitUntil: 'load' });
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined }); document.execCommand = command => { globalThis.__harnessHoverCopy = command; return command === 'copy'; }; });
  const anchor = page.locator('.anchor');
  await anchor.hover(); await page.waitForTimeout(20);
  const beforeDelay = await page.locator('[role="button"]').count();
  await page.waitForTimeout(40);
  const card = page.locator('[role="button"]');
  const open = await card.evaluate(element => { const style = getComputedStyle(element); const box = element.getBoundingClientRect(); return { dom: element.outerHTML, role: element.getAttribute('role'), ariaLabel: element.getAttribute('aria-label'), parent: element.parentElement?.tagName.toLowerCase(), rect: { x: box.x, y: box.y, width: box.width, height: box.height }, style: { position: style.position, zIndex: style.zIndex, width: style.width, padding: style.padding, borderRadius: style.borderRadius, boxSizing: style.boxSizing } }; });
  await card.screenshot({ path: path.join(root, 'reports/harness-hover-card-source.png') });
  await card.evaluate(element => element.click());
  await page.waitForFunction(() => document.querySelector('[role="button"]')?.textContent?.trim() === 'Copied');
  const copied = await page.evaluate(() => ({ text: document.querySelector('[role="button"]')?.textContent?.trim(), status: document.querySelector('[role="status"]')?.textContent ?? '', clipboard: globalThis.__harnessHoverCopy }));
  await page.mouse.move(10, 10); await page.waitForTimeout(250);
  const closedAfterGrace = await page.locator('[role="button"]').count() === 0;
  await anchor.hover(); await page.waitForTimeout(50);
  const disabled = await page.evaluate(async () => { globalThis.__harnessHoverFixture.render(true); await new Promise(requestAnimationFrame); return { cards: document.querySelectorAll('[role="button"]').length, statuses: document.querySelectorAll('[role="status"]').length, anchorPresent: document.querySelector('.anchor') !== null }; });
  const unmounted = await page.evaluate(() => { globalThis.__harnessHoverFixture.root.unmount(); const result = { rootEmpty: document.querySelector('#root')?.childNodes.length === 0, cards: document.querySelectorAll('[role="button"]').length, statuses: document.querySelectorAll('[role="status"]').length }; delete globalThis.__harnessHoverFixture; return result; });
  const evidence = { source: 'Harness HoverCard.tsx through isolated Vite source module', sourcePath: 'packages/client/ui-primitives/src/HoverCard.tsx', styleSource: 'packages/client/ui-primitives/src/HoverCard.module.css', semanticFixture: 'hover-card/portal-grace-copy-disabled-dispose', status: 'harness-source-component-capture', viewport, beforeDelay, open, copied, closedAfterGrace, disabled, unmounted, missingEvidence: ['cross-page Candidate DOM/computed-style/pixel comparison'] };
  assert.equal(beforeDelay, 0); assert.equal(open.role, 'button'); assert.equal(open.parent, 'body'); assert.equal(open.style.position, 'fixed'); assert.equal(open.style.zIndex, '100'); assert.equal(copied.text, 'Copied'); assert.equal(copied.status, 'Copied'); assert.equal(copied.clipboard, 'copy'); assert.equal(closedAfterGrace, true); assert.deepEqual(disabled, { cards: 0, statuses: 0, anchorPresent: true }); assert.deepEqual(unmounted, { rootEmpty: true, cards: 0, statuses: 0 });
  await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'reports/harness-hover-card-source.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log('Harness HoverCard source fixture captured (real HoverCard.tsx portal/copy/grace/disabled/unmount; 800x600 @1x).');
} finally { await browser.close(); await vite.close(); }
