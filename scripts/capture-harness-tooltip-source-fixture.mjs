import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness';
const harnessRequire = createRequire(`${harnessRoot}/apps/web/package.json`);
const { createServer } = await import(harnessRequire.resolve('vite'));
const { chromium } = harnessRequire('playwright');
const harnessReact = harnessRequire.resolve('react');
const harnessReactDom = harnessRequire.resolve('react-dom/client');
const harnessReactJsxDev = harnessRequire.resolve('react/jsx-dev-runtime');
const harnessTooltip = path.join(harnessRoot, 'packages/client/ui-primitives/src/Tooltip.tsx');
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const virtualId = 'virtual:harness-tooltip-source-fixture';
const resolvedVirtualId = `\0${virtualId}`;
const fixture = `import React from 'react'; import { createRoot } from 'react-dom/client'; import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/src/Tooltip.tsx';
const root = createRoot(document.querySelector('#root')); const render = (disabled = false) => root.render(React.createElement(React.Fragment, null,
React.createElement(Tooltip, { label: 'Open workspace details', side: 'bottom', delayMs: 80, disabled }, React.createElement('button', { type: 'button', className: 'anchor primary' }, 'Workspace details')),
React.createElement(Tooltip, { label: 'Flip above the viewport edge', side: 'bottom' }, React.createElement('button', { type: 'button', className: 'anchor lower' }, 'Bottom details')))); render(); globalThis.__harnessTooltipFixture = { root, render };`;
const vite = await createServer({
  root: harnessRoot,
  appType: 'custom',
  resolve: { alias: { 'react/jsx-dev-runtime': harnessReactJsxDev, 'react-dom/client': harnessReactDom, react: harnessReact, '@deepseek-ai/dsh-client-ui-primitives/src/Tooltip.tsx': harnessTooltip } },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [harnessRoot, root] } },
  plugins: [{
    name: 'vcp-harness-tooltip-source-fixture',
    resolveId(id) { return id === virtualId ? resolvedVirtualId : null; },
    load(id) { return id === resolvedVirtualId ? fixture : null; },
    configureServer(server) {
      server.middlewares.use('/__vcp_harness_tooltip_fixture.html', (_request, response) => {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff;--dsw-alias-tooltip-bg:#2c2c2e;--dsw-static-neutral-bluish-00:#fff;--ds-ease-in-out:ease-in-out}.anchor{position:absolute;font:inherit}.primary{left:120px;top:160px}.lower{left:120px;top:550px}</style></head><body><main id="root"></main><script type="module" src="/@id/__x00__${virtualId}"></script></body></html>`);
      });
    },
  }],
});
await vite.listen();
const url = `${vite.resolvedUrls.local[0]}__vcp_harness_tooltip_fixture.html`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.deviceScaleFactor });
  await page.goto(url, { waitUntil: 'load' });
  const anchor = page.locator('.primary');
  await anchor.waitFor();
  await anchor.hover();
  await page.waitForTimeout(50);
  const beforeDelay = await page.getByRole('tooltip').count();
  await page.waitForTimeout(50);
  const hover = await page.getByRole('tooltip').evaluate(element => { const style = getComputedStyle(element); const box = element.getBoundingClientRect(); return { dom: element.outerHTML, role: element.getAttribute('role'), side: element.getAttribute('data-side'), parent: element.parentElement?.tagName.toLowerCase(), rect: { x: box.x, y: box.y, width: box.width, height: box.height }, style: { position: style.position, zIndex: style.zIndex, width: style.width, maxWidth: style.maxWidth, padding: style.padding, borderRadius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight, pointerEvents: style.pointerEvents, transform: style.transform, backgroundColor: style.backgroundColor, color: style.color } }; });
  await page.getByRole('tooltip').screenshot({ path: path.join(root, 'reports/harness-tooltip-source.png') });
  await page.mouse.move(10, 10);
  await page.waitForTimeout(20);
  const hiddenAfterLeave = await page.getByRole('tooltip').count() === 0;
  await anchor.focus();
  const focusImmediate = await page.getByRole('tooltip').count() === 1;
  await anchor.blur();
  const hiddenAfterBlur = await page.getByRole('tooltip').count() === 0;
  const lower = page.locator('.lower');
  await lower.hover();
  const flipped = await page.getByRole('tooltip').evaluate(element => ({ side: element.getAttribute('data-side') }));
  await page.mouse.move(10, 10);
  await page.waitForTimeout(20);
  assert.equal(await page.getByRole('tooltip').count(), 0);
  const disabled = await page.evaluate(async () => {
    globalThis.__harnessTooltipFixture.render(true);
    await new Promise(requestAnimationFrame);
    document.querySelector('.primary').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    return { bubbleCount: document.querySelectorAll('[role="tooltip"]').length, anchorUnwrapped: document.querySelector('.primary')?.parentElement?.id === 'root' };
  });
  // React's disabled effect retracts a bubble on the following commit. The
  // first animation frame above only guarantees the new tree is scheduled;
  // wait for the observable DOM state instead of sampling a stale bubble.
  await page.waitForFunction(() => document.querySelectorAll('[role="tooltip"]').length === 0, { timeout: 5_000 });
  disabled.bubbleCount = await page.getByRole('tooltip').count();
  const unmounted = await page.evaluate(() => { globalThis.__harnessTooltipFixture.root.unmount(); const result = { rootEmpty: document.querySelector('#root')?.childNodes.length === 0, bubbles: document.querySelectorAll('[role="tooltip"]').length }; delete globalThis.__harnessTooltipFixture; return result; });
  const evidence = { source: 'Harness Tooltip.tsx through isolated Vite source module', sourcePath: 'packages/client/ui-primitives/src/Tooltip.tsx', styleSource: 'packages/client/ui-primitives/src/Tooltip.module.css', semanticFixture: 'tooltip/bottom-delayed-hover-focus-flip-disabled-dispose', status: 'harness-source-component-capture', viewport, beforeDelay, hover, hiddenAfterLeave, focusImmediate, hiddenAfterBlur, flipped, disabled, unmounted, missingEvidence: ['cross-page Candidate DOM/computed-style/pixel comparison', 'VCP Candidate body-portal structural mismatch'] };
  assert.equal(beforeDelay, 0);
  assert.equal(hover.role, 'tooltip');
  assert.equal(hover.side, 'bottom');
  assert.equal(hover.parent, 'main');
  assert.equal(hover.style.position, 'fixed');
  assert.equal(hover.style.zIndex, '100');
  assert.equal(hiddenAfterLeave, true);
  assert.equal(focusImmediate, true);
  assert.equal(hiddenAfterBlur, true);
  assert.equal(flipped.side, 'top');
  assert.deepEqual(disabled, { bubbleCount: 0, anchorUnwrapped: true });
  assert.deepEqual(unmounted, { rootEmpty: true, bubbles: 0 });
  await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'reports/harness-tooltip-source.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log('Harness Tooltip source fixture captured (real Tooltip.tsx hover/focus/flip/disabled/unmount; 800x600 @1x).');
} finally {
  await browser.close();
  await vite.close();
}
