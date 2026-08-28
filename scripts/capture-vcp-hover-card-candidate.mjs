import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const pnpmRoot = '/Users/asahi/Documents/Codex/deepseek-harness/node_modules/.pnpm';
const playwrightDir = (await fs.readdir(pnpmRoot)).filter(name => name.startsWith('playwright@')).sort().at(-1);
assert.ok(playwrightDir, 'Harness Playwright runtime is unavailable');
const { chromium } = await import(pathToFileURL(path.join(pnpmRoot, playwrightDir, 'node_modules/playwright/index.mjs')).href);
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff}.fixture{position:relative;width:100%;height:100%}.anchor{position:absolute;left:120px;top:160px;padding:8px}.lower{top:550px}</style><script type="module" src="/modules/uiux/generated/browser-entry.js"></script></head><body><main class="fixture"><span class="anchor">Workspace path</span><span class="anchor lower">Bottom path</span><div id="content">/tmp/workspace</div></main></body></html>`;
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
    await page.waitForFunction(() => typeof globalThis.VCPUIUX?.mountHoverCard === 'function');
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined });
        document.execCommand = command => { globalThis.__hoverFixtureClipboard = command; return command === 'copy'; };
        const makeScope = () => { const releases = []; let active = true; return { own(d) { releases.push(d); return d; }, listen(t, e, f, o) { t.addEventListener(e, f, o); const r = () => t.removeEventListener(e, f, o); releases.push(r); return r; }, track(value) { return Promise.resolve(value); }, child() { return makeScope(); }, async dispose() { active = false; for (const r of releases.splice(0).reverse()) await r(); }, get active() { return active; }, get count() { return releases.length; } }; };
        const anchors = [...document.querySelectorAll('.anchor')];
        const content = document.querySelector('#content');
        const scope = makeScope();
        globalThis.__hoverFixture = { anchors, content, scope, first: globalThis.VCPUIUX.mountHoverCard(anchors[0], { content, openDelayMs: 40, copyText: '/tmp/workspace', copyLabel: 'Copy path', copiedLabel: 'Copied' }, scope), second: globalThis.VCPUIUX.mountHoverCard(anchors[1], { content: document.createTextNode('bottom content'), openDelayMs: 0 }, scope) };
    });
    const first = page.locator('.anchor').first();
    await first.hover();
    await page.waitForTimeout(20);
    const beforeDelay = await page.locator('.vcp-harness-hover-card').count();
    await page.waitForTimeout(40);
    const open = await page.locator('.vcp-harness-hover-card').evaluate(element => { const style = getComputedStyle(element); const box = element.getBoundingClientRect(); return { dom: element.outerHTML, role: element.getAttribute('role'), ariaLabel: element.getAttribute('aria-label'), parent: element.parentElement?.tagName.toLowerCase(), rect: { x: box.x, y: box.y, width: box.width, height: box.height }, style: { position: style.position, zIndex: style.zIndex, width: style.width, padding: style.padding, borderRadius: style.borderRadius, boxSizing: style.boxSizing } }; });
    await page.screenshot({ path: path.join(root, 'reports', 'vcp-hover-card-candidate.png') });
    const card = page.locator('.vcp-harness-hover-card');
    await card.dispatchEvent('pointerenter');
    await page.locator('.vcp-harness-hover-card-root').first().dispatchEvent('pointerleave');
    await page.waitForTimeout(100);
    const graceOpen = await card.count() === 1;
    await card.dispatchEvent('pointerleave');
    await page.waitForTimeout(220);
    const graceClosed = await card.count() === 0;
    await page.locator('.vcp-harness-hover-card-root').first().dispatchEvent('pointerenter');
    await page.waitForTimeout(50);
    await page.locator('.vcp-harness-hover-card').evaluate(element => element.click());
    await page.waitForTimeout(100);
    const copied = await page.evaluate(() => ({ text: document.querySelector('.vcp-harness-hover-card')?.textContent?.trim(), status: document.querySelector('[role="status"]')?.textContent ?? '', clipboard: globalThis.__hoverFixtureClipboard }));
    await page.evaluate(() => globalThis.__hoverFixture.first.setDisabled(true));
    const disabled = await page.locator('.vcp-harness-hover-card').count() === 0;
    const disposed = await page.evaluate(async () => { const f = globalThis.__hoverFixture; await f.scope.dispose(); return { cards: document.querySelectorAll('.vcp-harness-hover-card').length, roots: document.querySelectorAll('.vcp-harness-hover-card-root').length, anchorCount: document.querySelectorAll('.anchor').length, registrations: f.scope.count }; });
    await page.reload({ waitUntil: 'load' });
    const reloaded = { cards: await page.locator('.vcp-harness-hover-card').count(), anchors: await page.locator('.anchor').count() };
    const evidence = { source: 'VCP generated artifact Candidate Lab', semanticFixture: 'hover-card/portal-grace-copy-disabled-dispose', candidateStatus: 'candidate-interaction-active; no same-semantic Harness capture, computed-style diff, pixel diff, or VCP production consumer', viewport, beforeDelay, open, graceOpen, graceClosed, copied, disabled, disposed, reloaded };
    assert.equal(beforeDelay, 0); assert.equal(open.role, 'button'); assert.equal(open.parent, 'body'); assert.equal(open.style.position, 'fixed'); assert.equal(open.style.zIndex, '100'); assert.equal(graceOpen, true); assert.equal(graceClosed, true); assert.equal(copied.text, 'Copied'); assert.equal(copied.status, 'Copied'); assert.equal(copied.clipboard, 'copy'); assert.equal(disabled, true); assert.deepEqual(disposed, { cards: 0, roots: 0, anchorCount: 2, registrations: 0 }); assert.deepEqual(reloaded, { cards: 0, anchors: 2 });
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/vcp-hover-card-candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log('VCP HoverCard Candidate fixture captured (portal/grace/copy/disabled/dispose; 800x600 @1x).');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
