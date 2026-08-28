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
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff}.fixture{position:relative;width:100%;height:100%}.anchor{position:absolute;font:inherit}.primary{left:120px;top:160px}.lower{left:120px;top:550px}</style><script type="module" src="/modules/uiux/generated/browser-entry.js"></script></head><body><main class="fixture"><button type="button" class="anchor primary">Workspace details</button><button type="button" class="anchor lower">Bottom details</button></main></body></html>`;

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
const rect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height });

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const browser = await chromium.launch();
try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.deviceScaleFactor });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof globalThis.VCPUIUX?.mountTooltip === 'function');
    await page.evaluate(() => {
        const makeScope = () => {
            const releases = [];
            return {
                own(disposer) { releases.push(disposer); return disposer; },
                listen(target, type, listener, options) { target.addEventListener(type, listener, options); const release = () => target.removeEventListener(type, listener, options); releases.push(release); return release; },
                child() { return makeScope(); },
                async dispose() { for (const release of releases.splice(0).reverse()) await release(); },
                get count() { return releases.length; },
            };
        };
        const primary = document.querySelector('.primary');
        const lower = document.querySelector('.lower');
        if (!(primary instanceof HTMLButtonElement) || !(lower instanceof HTMLButtonElement)) throw new Error('Tooltip fixture anchors are missing');
        const scope = makeScope();
        globalThis.__tooltipFixture = {
            scope,
            primary,
            lower,
            primaryController: globalThis.VCPUIUX.mountTooltip(primary, { label: 'Open workspace details', side: 'bottom', delayMs: 80 }, scope),
            lowerController: globalThis.VCPUIUX.mountTooltip(lower, { label: 'Flip above the viewport edge', side: 'bottom' }, scope),
        };
    });
    const primary = page.locator('.primary');
    await primary.hover();
    await page.waitForTimeout(50);
    const beforeDelay = await page.getByRole('tooltip').count();
    await page.waitForTimeout(50);
    const hover = await page.getByRole('tooltip').evaluate(element => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
            dom: element.outerHTML,
            role: element.getAttribute('role'),
            side: element.getAttribute('data-side'),
            parent: element.parentElement?.tagName.toLowerCase(),
            rect: { x: box.x, y: box.y, width: box.width, height: box.height },
            style: { position: style.position, zIndex: style.zIndex, width: style.width, maxWidth: style.maxWidth, padding: style.padding, borderRadius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight, pointerEvents: style.pointerEvents, transform: style.transform },
        };
    });
    await page.getByRole('tooltip').screenshot({ path: path.join(root, 'reports', 'vcp-tooltip-candidate.png') });
    await primary.dispatchEvent('mouseleave');
    const hiddenAfterLeave = await page.getByRole('tooltip').count() === 0;
    await primary.focus();
    const focusImmediate = await page.getByRole('tooltip').count() === 1;
    await primary.blur();
    const hiddenAfterBlur = await page.getByRole('tooltip').count() === 0;
    const lower = page.locator('.lower');
    await lower.hover();
    const flipped = await page.getByRole('tooltip').evaluate(element => {
        const box = element.getBoundingClientRect();
        return { side: element.getAttribute('data-side'), rect: { x: box.x, y: box.y, width: box.width, height: box.height } };
    });
    await lower.dispatchEvent('mouseleave');
    const disabled = await page.evaluate(async () => {
        const fixture = globalThis.__tooltipFixture;
        fixture.primaryController.setDisabled(true);
        fixture.primary.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        return { open: fixture.primaryController.open, bubbleCount: document.querySelectorAll('[role="tooltip"]').length, anchorUnwrapped: fixture.primary.parentElement?.classList.contains('fixture') === true };
    });
    const disposed = await page.evaluate(async () => {
        const fixture = globalThis.__tooltipFixture;
        await fixture.scope.dispose();
        const result = { bubbles: document.querySelectorAll('[role="tooltip"]').length, primaryAttached: fixture.primary.isConnected, lowerAttached: fixture.lower.isConnected, parentRegistrations: fixture.scope.count };
        delete globalThis.__tooltipFixture;
        return result;
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof globalThis.VCPUIUX?.mountTooltip === 'function');
    const reloaded = await page.evaluate(() => ({ bubbles: document.querySelectorAll('[role="tooltip"]').length, anchors: document.querySelectorAll('.anchor').length }));
    const evidence = { source: 'VCP generated artifact Candidate Lab', semanticFixture: 'tooltip/bottom-delayed-hover-focus-flip-disabled-dispose', candidateStatus: 'candidate-interaction-active; no same-semantic Harness browser capture, computed-style diff, pixel diff, or VCP production consumer', viewport, beforeDelay, hover, hiddenAfterLeave, focusImmediate, hiddenAfterBlur, flipped, disabled, disposed, reloaded };
    assert.equal(evidence.beforeDelay, 0);
    assert.equal(evidence.hover.role, 'tooltip');
    assert.equal(evidence.hover.parent, 'body');
    assert.equal(evidence.hover.side, 'bottom');
    assert.equal(evidence.hover.style.position, 'fixed');
    assert.equal(evidence.hover.style.zIndex, '100');
    assert.equal(evidence.hover.style.pointerEvents, 'none');
    assert.equal(evidence.hiddenAfterLeave, true);
    assert.equal(evidence.focusImmediate, true);
    assert.equal(evidence.hiddenAfterBlur, true);
    assert.equal(evidence.flipped.side, 'top');
    assert.equal(evidence.disabled.open, false);
    assert.equal(evidence.disabled.bubbleCount, 0);
    assert.equal(evidence.disabled.anchorUnwrapped, true);
    assert.deepEqual(evidence.disposed, { bubbles: 0, primaryAttached: true, lowerAttached: true, parentRegistrations: 0 });
    assert.deepEqual(evidence.reloaded, { bubbles: 0, anchors: 2 });
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports', 'vcp-tooltip-candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log('VCP Tooltip Candidate fixture captured (delayed hover/focus/flip/disabled/dispose; 800x600 @1x).');
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
