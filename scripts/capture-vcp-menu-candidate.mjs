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
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff}.fixture{margin:96px 80px}.fixture button{font:inherit}</style><script type="module">import { mountMenu } from '/modules/uiux/generated/primitives/menu.js';window.__mountMenu=mountMenu;</script></head><body><main class="fixture"><button type="button" class="trigger">View options</button><p>outside target</p></main></body></html>`;
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
    await page.waitForFunction(() => typeof globalThis.__mountMenu === 'function');
    const evidence = await page.evaluate(() => {
        const createScope = () => {
            const releases = [];
            return {
                own(disposer) { releases.push(disposer); return disposer; },
                listen(target, type, listener, options) { target.addEventListener(type, listener, options); const release = () => target.removeEventListener(type, listener, options); releases.push(release); return release; },
                child() { return createScope(); },
                async dispose() { for (const release of releases.splice(0).reverse()) await release(); },
                get count() { return releases.length; },
            };
        };
        const anchor = document.querySelector('.trigger');
        if (!(anchor instanceof HTMLButtonElement)) throw new Error('fixture trigger is missing');
        const scope = createScope();
        const selections = [];
        const controller = globalThis.__mountMenu(anchor, {
            portal: true, dense: true, open: true, selectedIds: ['workspace', 'updated'], align: 'start',
            items: [
                { type: 'label', id: 'group', text: 'Group by' },
                { id: 'workspace', label: 'Workspace' }, { id: 'flat', label: 'Flat list' },
                { type: 'separator', id: 'separator' }, { id: 'updated', label: 'Recently updated' },
                { id: 'disabled', label: 'Unavailable', disabled: true }, { id: 'danger', label: 'Remove view', danger: true },
                { id: 'layout', label: 'Layout', submenu: [{ id: 'list', label: 'List' }, { id: 'grid', label: 'Grid' }] },
            ],
            footer: [{ id: 'settings', label: 'View settings' }],
            onSelect: id => selections.push(id),
        }, scope);
        const capture = () => {
            const menu = document.body.querySelector('.vcp-harness-menu-list');
            if (!(menu instanceof HTMLElement)) return { present: false };
            const style = getComputedStyle(menu);
            const rect = menu.getBoundingClientRect();
            return {
                present: true, dom: menu.outerHTML, role: menu.getAttribute('role'),
                aria: { triggerHasPopup: anchor.getAttribute('aria-haspopup'), triggerExpanded: anchor.getAttribute('aria-expanded') },
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                style: { position: style.position, zIndex: style.zIndex, padding: style.padding, borderRadius: style.borderRadius, minWidth: style.minWidth, fontFamily: style.fontFamily },
                items: [...menu.querySelectorAll('[role="menuitem"]')].map(item => ({ text: item.textContent?.trim(), disabled: item.hasAttribute('disabled'), selected: item.getAttribute('data-selected'), danger: item.classList.contains('vcp-harness-menu-item-danger') })),
                labels: [...menu.querySelectorAll('.vcp-harness-menu-label')].map(item => item.textContent),
                separators: menu.querySelectorAll('[role="separator"]').length,
                footer: menu.querySelector('.vcp-harness-menu-footer') !== null,
            };
        };
        const open = capture();
        const layout = [...controller.list.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === 'Layout');
        if (!(layout instanceof HTMLButtonElement)) throw new Error('submenu trigger is missing');
        layout.focus();
        const submenu = controller.list.querySelector('.vcp-harness-submenu');
        const submenuItems = submenu ? [...submenu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim()) : [];
        document.querySelector('.fixture p')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const outsideClosed = !controller.open && document.body.querySelector('.vcp-harness-menu-list') === null;
        controller.setOpen(true);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const escapeClosed = !controller.open && document.body.querySelector('.vcp-harness-menu-list') === null;
        globalThis.__menuFixtureScope = scope;
        globalThis.__menuFixtureController = controller;
        return { source: 'VCP generated artifact Candidate Lab', semanticFixture: 'menu/dense-portal/selected-disabled-danger-submenu', candidateStatus: 'candidate-interaction-active; same-engine real-source DOM/ARIA/computed-style and strict ROI evidence recorded, but no VCP production consumer', viewport, open, submenuItems, outsideClosed, escapeClosed, selections, ownerRegistrations: scope.count };
    });
    assert.equal(evidence.open.present, true);
    assert.equal(evidence.open.role, 'menu');
    assert.deepEqual(evidence.open.aria, { triggerHasPopup: 'menu', triggerExpanded: 'true' });
    assert.equal(evidence.open.style.position, 'fixed');
    assert.equal(evidence.open.style.zIndex, '1100');
    assert.equal(evidence.open.items.filter(item => item.selected === 'true').length, 2);
    assert.equal(evidence.open.items.find(item => item.text === 'Unavailable')?.disabled, true);
    assert.equal(evidence.open.items.find(item => item.text === 'Remove view')?.danger, true);
    assert.deepEqual(evidence.submenuItems, ['List', 'Grid']);
    assert.equal(evidence.outsideClosed, true);
    assert.equal(evidence.escapeClosed, true);
    await page.evaluate(() => globalThis.__menuFixtureController?.setOpen(true));
    await page.locator('.vcp-harness-menu-list').screenshot({ path: path.join(root, 'reports/vcp-menu-candidate.png') });
    await page.evaluate(() => globalThis.__menuFixtureScope?.dispose());
    const restored = await page.evaluate(() => {
        delete globalThis.__menuFixtureScope;
        delete globalThis.__menuFixtureController;
        const anchor = document.querySelector('.trigger');
        return anchor?.parentElement?.classList.contains('fixture') && anchor.getAttribute('aria-haspopup') === null && anchor.getAttribute('aria-expanded') === null && document.body.querySelector('.vcp-harness-menu-list') === null;
    });
    assert.equal(restored, true, 'Menu fixture owner must restore the trigger and body portal');
    evidence.disposed = { restored };
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/vcp-menu-candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log('VCP Menu Candidate fixture captured (portal/ARIA/selected/submenu/outside/Escape/dispose; 800x600 @1x).');
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
