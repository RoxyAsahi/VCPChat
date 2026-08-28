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
const root = createRoot(document.querySelector('#root'));
root.render(React.createElement(Tooltip, { label: 'Open workspace details', side: 'bottom', delayMs: 80 }, React.createElement('button', { type: 'button', className: 'anchor' }, 'Workspace details')));`;
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
        response.end(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff;--dsw-alias-tooltip-bg:#2c2c2e;--dsw-static-neutral-bluish-00:#fff;--ds-ease-in-out:ease-in-out}.anchor{position:absolute;left:120px;top:160px;font:inherit}</style></head><body><main id="root"></main><script type="module" src="/@id/__x00__${virtualId}"></script></body></html>`);
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
  const anchor = page.locator('.anchor');
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
  const evidence = { source: 'Harness Tooltip.tsx through isolated Vite source module', sourcePath: 'packages/client/ui-primitives/src/Tooltip.tsx', styleSource: 'packages/client/ui-primitives/src/Tooltip.module.css', semanticFixture: 'tooltip/bottom-delayed-hover-focus-flip-disabled-dispose', status: 'harness-source-component-capture', viewport, beforeDelay, hover, hiddenAfterLeave, missingEvidence: ['focus/flip/disabled source capture', 'cross-page Candidate DOM/computed-style/pixel comparison', 'VCP Candidate body-portal structural mismatch'] };
  assert.equal(beforeDelay, 0);
  assert.equal(hover.role, 'tooltip');
  assert.equal(hover.side, 'bottom');
  assert.equal(hover.parent, 'main');
  assert.equal(hover.style.position, 'fixed');
  assert.equal(hover.style.zIndex, '100');
  assert.equal(hiddenAfterLeave, true);
  await fs.promises.mkdir(path.join(root, 'reports'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'reports/harness-tooltip-source.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log('Harness Tooltip source fixture captured (real Tooltip.tsx delayed bottom hover; 800x600 @1x).');
} finally {
  await browser.close();
  await vite.close();
}
