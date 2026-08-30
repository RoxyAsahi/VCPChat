import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const harness = '/Users/asahi/Documents/Codex/deepseek-harness';
const req = createRequire(`${harness}/apps/web/package.json`);
const { createServer } = await import(req.resolve('vite'));
const { chromium } = req('playwright');
const source = path.join(harness, 'packages/client/ui-primitives/src/Pill.tsx');
const id = 'virtual:harness-pill-source';
const rid = `\0${id}`;
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const code = `import React from'react';import{createRoot}from'react-dom/client';import{Pill}from'@deepseek-ai/dsh-client-ui-primitives/src/Pill.tsx';let clicks=0;const root=createRoot(document.querySelector('#root'));root.render(React.createElement('main',{className:'fixture'},React.createElement(Pill,{className:'source-static'},'Static'),React.createElement(Pill,{onClick:()=>{clicks++},className:'source-interactive'},'Interactive'),React.createElement(Pill,{active:true},'Active')));globalThis.__pill={root,get clicks(){return clicks}};`;
const vite = await createServer({
    root: harness,
    appType: 'custom',
    resolve: { alias: { 'react/jsx-dev-runtime': req.resolve('react/jsx-dev-runtime'), 'react-dom/client': req.resolve('react-dom/client'), react: req.resolve('react'), '@deepseek-ai/dsh-client-ui-primitives/src/Pill.tsx': source } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [harness, root] } },
    plugins: [{
        name: 'pill-source',
        resolveId(value) { return value === id ? rid : null; },
        load(value) { return value === rid ? code : null; },
        configureServer(server) {
            server.middlewares.use('/fixture.html', (_request, response) => response.end(`<!doctype html><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui;background:#fff}.fixture{padding:72px}.fixture>*{margin-right:12px}.fixture{--dsw-alias-label-secondary:#667085;--dsw-alias-bg-layer-2:#fff;--dsw-alias-interactive-bg-hover:rgba(0,0,0,.06);--dsw-alias-button-ghost-active-fill:rgba(0,0,0,.08);--dsw-alias-button-ghost-active-border:transparent}</style><div id=root></div><script type=module src="/@id/__x00__${id}"></script>`));
        },
    }],
});
await vite.listen();
const browser = await chromium.launch();
try {
    const page = await browser.newPage({ viewport });
    await page.goto(`${vite.resolvedUrls.local[0]}fixture.html`);
    await page.locator('.source-interactive').waitFor();
    const states = await page.evaluate(() => {
        const describe = element => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return { tag: element.tagName.toLowerCase(), className: element.className, type: element.getAttribute('type'), rect: { width: rect.width, height: rect.height }, style: { display: style.display, alignItems: style.alignItems, gap: style.gap, height: style.height, padding: style.padding, borderRadius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight, cursor: style.cursor, backgroundColor: style.backgroundColor } }; };
        return { static: describe(document.querySelector('.source-static')), interactive: describe(document.querySelector('.source-interactive')), active: describe(document.querySelector('#root main > :nth-child(3)')) };
    });
    await page.locator('.source-interactive').hover();
    const hover = await page.evaluate(() => getComputedStyle(document.querySelector('.source-interactive')).backgroundColor);
    await page.locator('.source-interactive').click();
    const clicks = await page.evaluate(() => globalThis.__pill.clicks);
    await page.locator('.fixture').screenshot({ path: path.join(root, 'reports/harness-pill-source.png') });
    const unmounted = await page.evaluate(() => { globalThis.__pill.root.unmount(); return { rootEmpty: document.querySelector('#root').childNodes.length === 0, pills: document.querySelectorAll('span,button').length === 0 }; });
    assert.equal(states.static.tag, 'span');
    assert.equal(states.interactive.tag, 'button');
    assert.equal(states.interactive.type, 'button');
    assert.equal(states.active.tag, 'span');
    assert.equal(clicks, 1);
    assert.equal(unmounted.rootEmpty, true);
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/harness-pill-source.json'), `${JSON.stringify({ source: 'Harness Pill.tsx through isolated Vite source module', sourcePath: 'packages/client/ui-primitives/src/Pill.tsx', styleSource: 'packages/client/ui-primitives/src/Pill.module.css', semanticFixture: 'pill/static-interactive-hover-active-dispose', status: 'harness-source-component-capture', viewport, states, hover, clicks, unmounted, missingEvidence: [] }, null, 2)}\n`);
    console.log('Harness Pill source fixture captured (native static/interactive/hover/active/click/unmount; 800x600 @1x).');
} finally {
    await browser.close();
    await vite.close();
}
