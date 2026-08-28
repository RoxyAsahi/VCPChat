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
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff}#root{min-height:100%;padding:24px;box-sizing:border-box}.onboarding-content{width:320px;margin-top:120px;padding:20px;border-radius:12px;background:#fff;box-shadow:0 12px 32px rgba(0,0,0,.12)}</style><script type="module">import { mountOnboardingSurface } from '/modules/uiux/generated/primitives/onboarding-surface.js';window.__mountOnboardingSurface=mountOnboardingSurface;</script></head><body><div id="root"><main><section class="onboarding-content"><h1>Welcome</h1><p>Candidate-only onboarding content</p></section></main></div></body></html>`;
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
    await page.waitForFunction(() => typeof globalThis.__mountOnboardingSurface === 'function');
    const evidence = await page.evaluate(() => {
        const appRoot = document.getElementById('root');
        const content = document.querySelector('.onboarding-content');
        if (!(appRoot instanceof HTMLElement) || !(content instanceof HTMLElement)) throw new Error('fixture root/content is missing');
        const releases = [];
        const scope = { own(disposer) { releases.push(disposer); return disposer; } };
        const controller = globalThis.__mountOnboardingSurface({ content, appRoot, open: false }, scope);
        const capture = () => {
            const overlay = document.body.querySelector('.vcp-harness-onboarding-overlay');
            if (!(overlay instanceof HTMLElement)) return { present: false, rootInert: appRoot.inert, contentInRoot: appRoot.contains(content) };
            const mask = overlay.querySelector('.vcp-harness-onboarding-mask');
            const stage = overlay.querySelector('.vcp-harness-onboarding-stage');
            const overlayStyle = getComputedStyle(overlay);
            const maskStyle = mask ? getComputedStyle(mask) : null;
            const stageStyle = stage ? getComputedStyle(stage) : null;
            return {
                present: true, dom: overlay.outerHTML, rootInert: appRoot.inert, contentInRoot: appRoot.contains(content),
                aria: { overlayRole: overlay.getAttribute('role'), maskHidden: mask?.getAttribute('aria-hidden') ?? null },
                style: {
                    overlay: { position: overlayStyle.position, inset: overlayStyle.inset, zIndex: overlayStyle.zIndex },
                    mask: maskStyle ? { top: maskStyle.top, bottom: maskStyle.bottom, backgroundColor: maskStyle.backgroundColor, backdropFilter: maskStyle.backdropFilter } : null,
                    stage: stageStyle ? { position: stageStyle.position, inset: stageStyle.inset, display: stageStyle.display, justifyContent: stageStyle.justifyContent, overflow: stageStyle.overflow } : null,
                },
            };
        };
        const closed = capture();
        controller.setOpen(true);
        const open = capture();
        controller.setOpen(false);
        const close = capture();
        controller.setOpen(true);
        const reopen = capture();
        globalThis.__onboardingFixtureReleases = releases;
        return { source: 'VCP generated artifact Candidate Lab', semanticFixture: 'onboarding-surface/closed-open-close-reopen-dispose', candidateStatus: 'candidate-interaction-active; no VCP first-run consumer or paired Harness capture', viewport, closed, open, close, reopen, ownerRegistrations: releases.length };
    });
    assert.deepEqual(evidence.closed, { present: false, rootInert: false, contentInRoot: true });
    assert.equal(evidence.open.present, true);
    assert.equal(evidence.open.rootInert, true);
    assert.equal(evidence.open.contentInRoot, false);
    assert.deepEqual(evidence.open.aria, { overlayRole: 'presentation', maskHidden: 'true' });
    assert.deepEqual(evidence.open.style, {
        overlay: { position: 'fixed', inset: '0px', zIndex: '1100' },
        mask: { top: '80px', bottom: '0px', backgroundColor: 'rgba(0, 0, 0, 0.24)', backdropFilter: 'blur(2px)' },
        stage: { position: 'absolute', inset: '0px', display: 'flex', justifyContent: 'center', overflow: 'hidden' },
    });
    assert.deepEqual(evidence.close, { present: false, rootInert: false, contentInRoot: true });
    assert.equal(evidence.reopen.present, true);
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/vcp-onboarding-surface-candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await page.locator('.vcp-harness-onboarding-overlay').screenshot({ path: path.join(root, 'reports/vcp-onboarding-surface-candidate.png') });
    const disposed = await page.evaluate(async () => {
        const releases = globalThis.__onboardingFixtureReleases || [];
        for (const release of releases.slice().reverse()) await release();
        delete globalThis.__onboardingFixtureReleases;
        const appRoot = document.getElementById('root');
        const content = document.querySelector('.onboarding-content');
        return { count: releases.length, restored: appRoot?.inert === false && appRoot?.contains(content) && document.body.querySelector('.vcp-harness-onboarding-overlay') === null };
    });
    assert.deepEqual(disposed, { count: 1, restored: true });
    console.log('VCP OnboardingSurface Candidate fixture captured (portal/inert/open-close-reopen/dispose; 800x600 @1x).');
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
