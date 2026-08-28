import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const harness = '/Users/asahi/Documents/Codex/deepseek-harness';
const requireHarness = createRequire(`${harness}/apps/web/package.json`);
const { createServer } = await import(requireHarness.resolve('vite'));
const { chromium } = requireHarness('playwright');
const source = path.join(harness, 'packages/client/ui-primitives/src/ConnectionBanner.tsx');
const virtualId = 'virtual:harness-connection-banner';
const resolvedVirtualId = `\0${virtualId}`;
const fixture = `import React from 'react';import{createRoot}from'react-dom/client';import{ConnectionBanner}from'@deepseek-ai/dsh-client-ui-primitives/src/ConnectionBanner.tsx';const root=createRoot(document.querySelector('#root'));const render=(reconnecting,label)=>root.render(React.createElement(ConnectionBanner,{reconnecting,label}));render(false);globalThis.__connectionBanner={root,render};`;
const react = requireHarness.resolve('react');
const reactDom = requireHarness.resolve('react-dom/client');
const reactJsxDev = requireHarness.resolve('react/jsx-dev-runtime');
const vite = await createServer({ root: harness, appType: 'custom', resolve: { alias: { 'react/jsx-dev-runtime': reactJsxDev, 'react-dom/client': reactDom, react, '@deepseek-ai/dsh-client-ui-primitives/src/ConnectionBanner.tsx': source } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [harness, root] } }, plugins: [{ name: 'connection-banner-source', resolveId(id) { return id === virtualId ? resolvedVirtualId : null; }, load(id) { return id === resolvedVirtualId ? fixture : null; }, configureServer(server) { server.middlewares.use('/fixture.html', (_request, response) => response.end(`<!doctype html><style>:root{--dsw-alias-state-error-primary:rgb(217,45,32);--dsw-alias-label-primary-foreground:#fff}</style><div id=root></div><script type=module src="/@id/__x00__${virtualId}"></script>`)); } }] });
await vite.listen(); const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`${vite.resolvedUrls.local[0]}fixture.html`);
  const states = await page.evaluate(async () => { const capture = () => { const el = document.querySelector('#root>div'); if (!el) return { present: false }; const style = getComputedStyle(el), rect = el.getBoundingClientRect(); return { present: true, tag: el.tagName.toLowerCase(), text: el.textContent, aria: { role: el.getAttribute('role'), live: el.getAttribute('aria-live') }, rect: { width: rect.width, height: rect.height }, style: { position: style.position, top: style.top, left: style.left, right: style.right, zIndex: style.zIndex, padding: style.padding, textAlign: style.textAlign, fontSize: style.fontSize, lineHeight: style.lineHeight, backgroundColor: style.backgroundColor, color: style.color } }; }; const f = globalThis.__connectionBanner; const connectedHidden = capture(); f.render(true, '连接已断开，正在重连…'); await new Promise(requestAnimationFrame); const reconnectingVisible = capture(); f.render(true, 'Reconnecting to Harness…'); await new Promise(requestAnimationFrame); return { connectedHidden, reconnectingVisible, labelUpdate: capture() }; });
  await page.locator('#root>div').screenshot({ path: path.join(root, 'reports/harness-connection-banner-source.png') });
  states.unmounted = await page.evaluate(() => { const f = globalThis.__connectionBanner; f.root.unmount(); return { rootEmpty: document.querySelector('#root').childNodes.length === 0 }; });
  assert.equal(states.connectedHidden.present, false); assert.equal(states.reconnectingVisible.present, true); assert.equal(states.labelUpdate.text, 'Reconnecting to Harness…'); assert.equal(states.unmounted.rootEmpty, true);
  await fs.mkdir(path.join(root, 'reports'), { recursive: true });
  await fs.writeFile(path.join(root, 'reports/harness-connection-banner-source.json'), `${JSON.stringify({ source: 'Harness ConnectionBanner.tsx through isolated Vite source module', sourcePath: 'packages/client/ui-primitives/src/ConnectionBanner.tsx', styleSource: 'packages/client/ui-primitives/src/ConnectionBanner.module.css', semanticFixture: 'connection-banner/reconnecting-visible/label-update', status: 'harness-source-component-capture', viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, ...states, missingEvidence: [] }, null, 2)}\n`);
  console.log('Harness ConnectionBanner source fixture captured (hidden/reconnecting/label/unmount).');
} finally { await browser.close(); await vite.close(); }
