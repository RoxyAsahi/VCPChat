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
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff}.fixture{padding:72px}.fixture>*{margin-right:12px}</style><script type="module">import { mountPill } from '/modules/uiux/generated/primitives/pill.js';window.__mountPill=mountPill;</script></head><body><main class="fixture"><span id="static-pill" class="original-static">Static</span><button id="interactive-pill" class="original-button">Interactive</button><button id="active-pill">Active</button></main></body></html>`;
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
    await page.waitForFunction(() => typeof globalThis.__mountPill === 'function');
    const base = await page.evaluate(() => {
        const releases = [];
        const scope = {
            own(disposer) { releases.push(disposer); return disposer; },
            listen(target, type, listener, options) { target.addEventListener(type, listener, options); const release = () => target.removeEventListener(type, listener, options); releases.push(release); return release; },
        };
        let clicks = 0;
        const staticPill = document.getElementById('static-pill');
        const interactivePill = document.getElementById('interactive-pill');
        const activePill = document.getElementById('active-pill');
        if (!(staticPill instanceof HTMLElement) || !(interactivePill instanceof HTMLButtonElement) || !(activePill instanceof HTMLButtonElement)) throw new Error('fixture pills are missing');
        globalThis.__mountPill(staticPill, {}, scope);
        globalThis.__mountPill(interactivePill, { interactive: true, onClick: () => { clicks += 1; } }, scope);
        globalThis.__mountPill(activePill, { active: true }, scope);
        const capture = element => {
            const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
            return { tag: element.tagName.toLowerCase(), className: element.className, type: element.getAttribute('type'), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: { display: style.display, alignItems: style.alignItems, gap: style.gap, height: style.height, padding: style.padding, borderRadius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight, cursor: style.cursor, backgroundColor: style.backgroundColor, boxShadow: style.boxShadow } };
        };
        globalThis.__pillFixture = { releases, clicks: () => clicks, capture, interactivePill };
        return { source: 'VCP generated artifact Candidate Lab', semanticFixture: 'pill/static-interactive-hover-active-dispose', candidateStatus: 'candidate-interaction-active; no VCP production consumer or paired Harness capture', viewport, static: capture(staticPill), interactive: capture(interactivePill), active: capture(activePill), ownerRegistrations: releases.length };
    });
    await page.locator('#interactive-pill').hover();
    const hover = await page.evaluate(() => ({ interactive: globalThis.__pillFixture.capture(globalThis.__pillFixture.interactivePill) }));
    await page.locator('#interactive-pill').click();
    const clicks = await page.evaluate(() => globalThis.__pillFixture.clicks());
    const evidence = { ...base, hover, clicks };
    assert.equal(evidence.static.tag, 'span');
    assert.equal(evidence.static.className, 'original-static vcp-harness-pill pill');
    assert.equal(evidence.interactive.tag, 'button');
    assert.equal(evidence.interactive.type, 'button');
    assert.equal(evidence.interactive.style.cursor, 'pointer');
    assert.equal(evidence.active.className, 'vcp-harness-pill pill active');
    assert.deepEqual(Object.fromEntries(['display', 'alignItems', 'gap', 'height', 'padding', 'borderRadius', 'fontSize', 'lineHeight'].map(key => [key, evidence.static.style[key]])), { display: 'inline-flex', alignItems: 'center', gap: '4px', height: '24px', padding: '0px 8px', borderRadius: '12px', fontSize: '12px', lineHeight: '18px' });
    assert.equal(evidence.hover.interactive.style.backgroundColor, 'rgba(0, 0, 0, 0.06)');
    assert.equal(evidence.clicks, 1);
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/vcp-pill-candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await page.locator('.fixture').screenshot({ path: path.join(root, 'reports/vcp-pill-candidate.png') });
    const disposed = await page.evaluate(async () => {
        const fixture = globalThis.__pillFixture;
        for (const release of fixture.releases.slice().reverse()) await release();
        delete globalThis.__pillFixture;
        const staticPill = document.getElementById('static-pill'); const interactivePill = document.getElementById('interactive-pill'); const activePill = document.getElementById('active-pill');
        return { count: fixture.releases.length, restored: staticPill?.className === 'original-static' && interactivePill?.className === 'original-button' && interactivePill?.getAttribute('type') === null && activePill?.className === '' && activePill?.getAttribute('type') === null };
    });
    assert.deepEqual(disposed, { count: 4, restored: true });
    console.log('VCP Pill Candidate fixture captured (static/interactive-hover/active/click/dispose; 800x600 @1x).');
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
