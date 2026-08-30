import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const pnpmRoot = '/Users/asahi/Documents/Codex/deepseek-harness/node_modules/.pnpm';
const playwrightDir = (await fs.readdir(pnpmRoot)).filter(name => name.startsWith('playwright@')).sort().at(-1);
assert.ok(playwrightDir, 'Playwright runtime is unavailable');
const { chromium } = await import(pathToFileURL(path.join(pnpmRoot, playwrightDir, 'node_modules/playwright/index.mjs')).href);
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff}.fixture-copy{margin:72px 24px;color:#151821}.fixture-host{display:block}</style><script type="module">import { mountConnectionBanner } from '/modules/uiux/generated/primitives/connection-banner.js';window.__mountConnectionBanner=mountConnectionBanner;</script></head><body><div class="fixture-copy">Candidate-only ConnectionBanner fixture</div><div class="fixture-host"><span data-original="true">original host node</span></div></body></html>`;
const server = http.createServer(async (request, response) => {
    try {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return; }
        const file = path.join(root, pathname.replace(/^\//, ''));
        if (!file.startsWith(root)) throw new Error('invalid fixture path');
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(await fs.readFile(file));
    } catch (error) { response.writeHead(404); response.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const browser = await chromium.launch();
try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.deviceScaleFactor });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof globalThis.__mountConnectionBanner === 'function');
    const evidence = await page.evaluate(() => {
        const host = document.querySelector('.fixture-host');
        if (!(host instanceof HTMLElement)) throw new Error('fixture host is missing');
        const releases = [];
        const scope = { own(disposer) { releases.push(disposer); return disposer; } };
        const controller = globalThis.__mountConnectionBanner(host, { reconnecting: false }, scope);
        const capture = () => {
            const banner = host.querySelector('.vcp-harness-connection-banner');
            if (!(banner instanceof HTMLElement)) return { present: false, dom: null };
            const style = getComputedStyle(banner);
            const rect = banner.getBoundingClientRect();
            return {
                present: true,
                dom: banner.outerHTML,
                text: banner.textContent,
                aria: { role: banner.getAttribute('role'), live: banner.getAttribute('aria-live') },
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                style: {
                    position: style.position, top: style.top, left: style.left, right: style.right,
                    zIndex: style.zIndex, padding: style.padding, textAlign: style.textAlign,
                    fontSize: style.fontSize, lineHeight: style.lineHeight,
                    backgroundColor: style.backgroundColor, color: style.color,
                },
            };
        };
        const connectedHidden = capture();
        controller.setReconnecting(true);
        const reconnectingVisible = capture();
        controller.setLabel('Reconnecting to Harness…');
        const labelUpdate = capture();
        globalThis.__connectionBannerReleases = releases;
        return { source: 'VCP generated artifact Candidate Lab', semanticFixture: 'connection-banner/reconnecting-visible/label-update', candidateStatus: 'candidate-interaction-active; no VCP connection consumer or paired Harness capture', viewport, connectedHidden, reconnectingVisible, labelUpdate, ownerRegistrations: releases.length };
    });
    assert.equal(evidence.connectedHidden.present, false);
    assert.equal(evidence.reconnectingVisible.present, true);
    assert.deepEqual(evidence.reconnectingVisible.aria, { role: 'status', live: 'polite' });
    assert.deepEqual(evidence.reconnectingVisible.style, {
        position: 'fixed', top: '0px', left: '0px', right: '0px', zIndex: '100', padding: '4px 12px', textAlign: 'center',
        fontSize: '12px', lineHeight: '18px', backgroundColor: 'rgb(217, 45, 32)', color: 'rgb(255, 255, 255)',
    });
    assert.equal(evidence.labelUpdate.text, 'Reconnecting to Harness…');
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/vcp-connection-banner-candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await page.locator('.vcp-harness-connection-banner').screenshot({ path: path.join(root, 'reports/vcp-connection-banner-candidate.png') });
    const disposed = await page.evaluate(() => {
        const releases = globalThis.__connectionBannerReleases || [];
        releases.slice().reverse().forEach(release => release());
        delete globalThis.__connectionBannerReleases;
        const host = document.querySelector('.fixture-host');
        return { count: releases.length, restored: host?.className === 'fixture-host' && host?.querySelector('[data-original="true"]')?.textContent === 'original host node' };
    });
    assert.deepEqual(disposed, { count: 1, restored: true });
    console.log('VCP ConnectionBanner Candidate fixture captured (hidden/reconnecting/label-update; 800x600 @1x; owner restore passed).');
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
