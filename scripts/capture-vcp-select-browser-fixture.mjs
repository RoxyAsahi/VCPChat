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

const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#fff}body{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;color:#0f1115}</style><script type="module" src="/modules/uiux/generated/browser-entry.js"></script></head><body></body></html>`;
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
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(globalThis.VCPUIUX));
    const capture = await page.evaluate(() => {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:198.859375px;top:174px;width:334px;height:40px';
        host.innerHTML = '<select id="vcp-browser-select"><option value="standard" data-description="Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.">Standard mode</option><option value="code" data-description="All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program.">Code mode</option><option value="minimal" data-description="Two-tool coding agent with persistent bash and str_replace_editor.">Minimal mode</option><option value="creator" data-description="Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.">Creator mode</option></select>';
        const releases = [];
        const scope = { own(disposer) { releases.push(disposer); return disposer; }, listen(target, type, handler, options) { target.addEventListener(type, handler, options); const release = () => target.removeEventListener(type, handler, options); releases.push(release); return release; } };
        globalThis.VCPUIUX.mountSelect(host.querySelector('select'), { label: 'Agent preset', portal: true }, scope);
        document.body.append(host);
        return true;
    });
    assert.equal(capture, true);
    await page.locator('.vcp-harness-select-trigger').click();
    const menu = page.locator('#vcp-browser-select-menu');
    await menu.waitFor();
    const evidence = await menu.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const computed = getComputedStyle(element);
        const items = [...element.querySelectorAll('[role="menuitem"]')].map(item => {
            const style = getComputedStyle(item); const name = getComputedStyle(item.querySelector('.vcp-harness-menu-item-name')); const description = getComputedStyle(item.querySelector('.vcp-harness-menu-item-description')); const r = item.getBoundingClientRect();
            return { tag: item.tagName.toLowerCase(), class: item.className, role: item.getAttribute('role'), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, style: { display: style.display, minHeight: style.minHeight, padding: style.padding, gap: style.gap, borderRadius: style.borderRadius, fontFamily: style.fontFamily, fontWeight: style.fontWeight, fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color, backgroundColor: style.backgroundColor }, nameStyle: { fontFamily: name.fontFamily, fontWeight: name.fontWeight, fontSize: name.fontSize, lineHeight: name.lineHeight, color: name.color }, descriptionStyle: { fontFamily: description.fontFamily, fontWeight: description.fontWeight, fontSize: description.fontSize, lineHeight: description.lineHeight, color: description.color } };
        });
        return { status: 'captured', dom: element.outerHTML, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: { padding: computed.padding, borderRadius: computed.borderRadius, minWidth: computed.minWidth, boxShadow: computed.boxShadow }, items };
    });
    assert.equal(evidence.items.length, 4);
    await page.mouse.move(evidence.items[0].rect.x + 20, evidence.items[0].rect.y + 20);
    await page.waitForTimeout(50);
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/vcp-select-browser-production.json'), `${JSON.stringify({ source: 'VCP generated artifact Playwright fixture', viewport: { width: 800, height: 600, deviceScaleFactor: 1 }, ...evidence }, null, 2)}\n`);
    await page.screenshot({ path: path.join(root, 'reports/vcp-select-browser-production.png') });
    console.log(`VCP browser Select fixture captured (${evidence.items.length} menuitems).`);
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
