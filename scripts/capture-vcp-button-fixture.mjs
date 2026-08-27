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
const welcomeMode = process.env.VCP_BUTTON_FIXTURE === 'welcome';
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#fff}body{font-family:system-ui;color:#0f1115}.fixture{display:flex;gap:12px;align-items:center;padding:24px}${welcomeMode ? ';position:fixed;left:552px;top:384px;padding:0' : ''}</style><script type="module" src="/modules/uiux/generated/browser-entry.js"></script></head><body><div class="fixture"></div></body></html>`;
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
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(globalThis.VCPUIUX));
    const evidence = await page.evaluate((isWelcomeMode) => {
        const host = document.querySelector('.fixture');
        const releases = [];
        const scope = {
            own(disposer) { releases.push(disposer); return disposer; },
            listen(target, type, handler, options) { target.addEventListener(type, handler, options); const release = () => target.removeEventListener(type, handler, options); releases.push(release); return release; },
        };
        const cases = isWelcomeMode ? [['continue', { variant: 'primary' }]] : [
            ['primary', { variant: 'primary' }], ['ghost', { variant: 'ghost' }],
            ['outline', { variant: 'outline' }], ['toolbar', { variant: 'toolbar' }],
            ['compact', { variant: 'ghost', size: 'sm' }], ['disabled', { variant: 'primary', disabled: true }],
        ];
        const nodes = cases.map(([name, props]) => {
            const button = document.createElement('button');
            button.textContent = isWelcomeMode ? '继续' : name;
            host.append(button);
            window.VCPUIUX.mountButton(button, props, scope);
            const rect = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return { name, dom: button.outerHTML, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: { display: style.display, gap: style.gap, borderRadius: style.borderRadius, padding: style.padding, fontSize: style.fontSize, lineHeight: style.lineHeight, backgroundColor: style.backgroundColor, opacity: style.opacity } };
        });
        window.__vcpButtonFixtureReleases = releases;
        return { source: 'VCP generated artifact Candidate Lab', semanticFixture: isWelcomeMode ? 'settings-onboarding/welcome-notice/continue/primary-md/enabled' : 'portable-button/all-variants-and-disabled', viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, cases: nodes, ownerRegistrations: releases.length };
    }, welcomeMode);
    assert.equal(evidence.cases.length, welcomeMode ? 1 : 6);
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    const outputStem = welcomeMode ? 'vcp-button-welcome-production' : 'vcp-button-candidate';
    await fs.writeFile(path.join(root, 'reports', `${outputStem}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    await page.screenshot({ path: path.join(root, 'reports', `${outputStem}.png`) });
    const disposed = await page.evaluate(() => {
        const releases = window.__vcpButtonFixtureReleases || [];
        releases.slice().reverse().forEach(release => release());
        const restored = [...document.querySelectorAll('.fixture > button')].every(button => button.className === '' && button.type === 'submit' && !button.disabled);
        delete window.__vcpButtonFixtureReleases;
        return { count: releases.length, restored };
    });
    assert.equal(disposed.count, welcomeMode ? 1 : 6);
    assert.equal(disposed.restored, true, 'Button fixture owner must restore each native button after capture');
    console.log(`VCP Button fixture captured (${evidence.cases.length} states; 800x600 @1x; ${welcomeMode ? 'WelcomeNotice semantic' : 'portable variants'}).`);
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
