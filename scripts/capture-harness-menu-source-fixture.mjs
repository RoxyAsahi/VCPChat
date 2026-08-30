import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const harness = '/Users/asahi/Documents/Codex/deepseek-harness';
const req = createRequire(`${harness}/apps/web/package.json`);
const { createServer } = await import(req.resolve('vite'));
const { chromium } = req('playwright');
const source = path.join(harness, 'packages/client/ui-primitives/src/Menu.tsx');
const id = 'virtual:harness-menu-source';
const rid = `\0${id}`;
const react = req.resolve('react');
const dom = req.resolve('react-dom/client');
const jsx = req.resolve('react/jsx-dev-runtime');
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const code = `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Menu}from'@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx';let setOpen;const items=[{type:'label',id:'group',text:'Group by'},{id:'workspace',label:'Workspace'},{id:'flat',label:'Flat list'},{type:'separator',id:'separator'},{id:'updated',label:'Recently updated'},{id:'disabled',label:'Unavailable',disabled:true},{id:'danger',label:'Remove view',danger:true},{id:'layout',label:'Layout',submenu:[{id:'list',label:'List'},{id:'grid',label:'Grid'}]}];const footer=[{id:'settings',label:'View settings'}];function Host(){const[open,set]=useState(true);setOpen=set;return React.createElement(Menu,{open,portal:true,dense:true,anchor:React.createElement('button',{className:'trigger',type:'button'},'View options'),items,footer,selectedIds:['workspace','updated'],onSelect:()=>{},onClose:()=>set(false)})}const root=createRoot(document.querySelector('#root'));root.render(React.createElement(Host));globalThis.__menu={root,setOpen:v=>setOpen(v)};`;
const vite = await createServer({
    root: harness,
    appType: 'custom',
    resolve: { alias: { 'react/jsx-dev-runtime': jsx, 'react-dom/client': dom, react, '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx': source } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [harness, root] } },
    plugins: [{
        name: 'menu-source',
        resolveId: value => value === id ? rid : null,
        load: value => value === rid ? code : null,
        configureServer(server) {
            server.middlewares.use('/fixture.html', (_request, response) => response.end(`<!doctype html><style>html,body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif}.fixture{margin:96px 80px}.trigger{font:inherit}</style><main class=fixture><div id=root></div><p class=outside>outside target</p></main><script type=module src="/@id/__x00__${id}"></script>`));
        },
    }],
});
await vite.listen();
const browser = await chromium.launch();
try {
    const page = await browser.newPage({ viewport });
    await page.goto(`${vite.resolvedUrls.local[0]}fixture.html`);
    await page.locator('[role="menu"]').waitFor();
    const capture = () => {
        const menu = document.body.querySelector('[role="menu"]');
        const trigger = document.querySelector('.trigger');
        if (!menu) return { present: false, aria: { triggerHasPopup: trigger?.getAttribute('aria-haspopup'), triggerExpanded: trigger?.getAttribute('aria-expanded') } };
        const style = getComputedStyle(menu);
        const rect = menu.getBoundingClientRect();
        return {
            present: true,
            role: menu.getAttribute('role'),
            aria: { triggerHasPopup: trigger.getAttribute('aria-haspopup'), triggerExpanded: trigger.getAttribute('aria-expanded') },
            rect: { width: rect.width, height: rect.height },
            style: { position: style.position, zIndex: style.zIndex, padding: style.padding, borderRadius: style.borderRadius, minWidth: style.minWidth, fontFamily: style.fontFamily },
            items: [...menu.querySelectorAll('[role="menuitem"]')].map(item => ({ text: item.textContent.trim(), disabled: item.hasAttribute('disabled'), selected: item.className.includes('selected'), danger: item.className.includes('danger') })),
            separators: menu.querySelectorAll('[role="separator"]').length,
            footer: [...menu.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.trim() === 'View settings'),
        };
    };
    const open = await page.evaluate(capture);
    await page.getByRole('menuitem', { name: 'Layout' }).focus();
    const submenuItems = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menu"] [role="menuitem"]')].map(item => item.textContent.trim()));
    await page.locator('.outside').dispatchEvent('pointerdown');
    await page.waitForTimeout(10);
    const outsideClosed = await page.evaluate(() => document.body.querySelector('[role="menu"]') === null);
    await page.evaluate(() => globalThis.__menu.setOpen(true));
    await page.waitForTimeout(20);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(10);
    const escapeClosed = await page.evaluate(() => document.body.querySelector('[role="menu"]') === null);
    await page.evaluate(() => globalThis.__menu.setOpen(true));
    await page.waitForTimeout(20);
    await page.locator('[role="menu"]').screenshot({ path: path.join(root, 'reports/harness-menu-source.png') });
    const unmounted = await page.evaluate(() => { globalThis.__menu.root.unmount(); return { rootEmpty: document.querySelector('#root').childNodes.length === 0, menus: document.body.querySelectorAll('[role="menu"]').length }; });
    assert.equal(open.present, true);
    assert.equal(open.role, 'menu');
    assert.equal(outsideClosed, true);
    assert.equal(escapeClosed, true);
    assert.deepEqual(submenuItems, ['List', 'Grid']);
    assert.deepEqual(unmounted, { rootEmpty: true, menus: 0 });
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/harness-menu-source.json'), `${JSON.stringify({ source: 'Harness Menu.tsx through isolated Vite source module', sourcePath: 'packages/client/ui-primitives/src/Menu.tsx', styleSource: 'packages/client/ui-primitives/src/Menu.module.css', semanticFixture: 'menu/dense-portal/selected-disabled-danger-submenu', status: 'harness-source-component-capture', viewport, open, submenuItems, outsideClosed, escapeClosed, unmounted, missingEvidence: [] }, null, 2)}\n`);
    console.log('Harness Menu source fixture captured (portal/danger/footer/submenu/outside/Escape/unmount).');
} finally {
    await browser.close();
    await vite.close();
}
