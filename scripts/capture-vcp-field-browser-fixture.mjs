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

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:#fff;color:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
*,*::before,*::after{animation:none!important;transition:none!important}
#vcp-field-fixture::before{content:"";position:absolute;z-index:1;left:0;top:-.5px;width:100%;height:1px;background:rgb(229,229,229);pointer-events:none}
</style><script type="module" src="/modules/uiux/generated/browser-entry.js"></script></head><body></body></html>`;

const contentType = pathname => pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : pathname.endsWith('.map') ? 'application/json; charset=utf-8' : 'application/octet-stream';
const server = http.createServer(async (request, response) => {
    try {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        if (pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return; }
        const file = path.join(root, pathname.replace(/^\//, ''));
        if (!file.startsWith(root)) throw new Error('invalid fixture path');
        response.writeHead(200, { 'content-type': contentType(pathname) });
        response.end(await fs.readFile(file));
    } catch (error) { response.writeHead(404); response.end(error.message); }
});

const rect = node => {
    const value = node.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height };
};

const style = node => {
    const value = getComputedStyle(node);
    return {
        display: value.display,
        padding: value.padding,
        gap: value.gap,
        height: value.height,
        borderRadius: value.borderRadius,
        fontSize: value.fontSize,
        fontWeight: value.fontWeight,
        lineHeight: value.lineHeight,
        color: value.color,
        backgroundColor: value.backgroundColor,
        borderColor: value.borderColor,
    };
};

const cases = [
    {
        name: 'description',
        value: '60000',
        description: '单条命令允许运行多久，超时即终止。',
    },
    {
        name: 'error',
        value: 'soon',
        error: '请填数字；留空表示使用默认值。',
    },
];

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const browser = await chromium.launch();
try {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(globalThis.VCPUIUX));
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    for (const fixture of cases) {
        await page.evaluate(({ value, description, error }) => {
            document.body.replaceChildren();
            const host = document.createElement('div');
            host.id = 'vcp-field-fixture';
            // The production reference is the second ValueField in its card,
            // so its clipped root includes the documented adjacent-field rule.
            host.style.cssText = 'position:absolute;left:669px;top:348.5px;width:530px';
            const input = document.createElement('input');
            input.id = 'plugin-config-bash-timeout';
            input.type = 'text';
            input.inputMode = 'numeric';
            input.placeholder = '';
            input.value = value;
            host.append(input);
            document.body.append(host);
            const releases = [];
            const scope = {
                own(disposer) { releases.push(disposer); return disposer; },
                listen(target, type, handler, options) {
                    target.addEventListener(type, handler, options);
                    const release = () => target.removeEventListener(type, handler, options);
                    releases.push(release);
                    return release;
                },
            };
            globalThis.VCPUIUX.mountField(host, {
                label: '命令超时（毫秒）',
                control: input,
                description,
                error,
            }, scope);
            if (error) input.focus();
        }, fixture);
        const evidence = await page.locator('#vcp-field-fixture').evaluate((root, state) => {
            const rect = node => {
                const value = node.getBoundingClientRect();
                return { x: value.x, y: value.y, width: value.width, height: value.height };
            };
            const style = node => {
                const value = getComputedStyle(node);
                return {
                    display: value.display,
                    padding: value.padding,
                    gap: value.gap,
                    height: value.height,
                    borderRadius: value.borderRadius,
                    fontSize: value.fontSize,
                    fontWeight: value.fontWeight,
                    lineHeight: value.lineHeight,
                    color: value.color,
                    backgroundColor: value.backgroundColor,
                    borderColor: value.borderColor,
                };
            };
            const head = root.querySelector('.vcp-harness-field-head');
            const label = root.querySelector('.vcp-harness-field-label');
            const input = root.querySelector('input');
            const message = root.querySelector('p');
            if (!head || !label || !input || !message) throw new Error('Field fixture did not mount its full contract.');
            return {
                source: 'VCP generated artifact Playwright fixture',
                viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio },
                state,
                dom: root.outerHTML,
                rect: rect(root),
                root: { tag: root.tagName.toLowerCase(), class: root.className, rect: rect(root), style: style(root) },
                head: { tag: head.tagName.toLowerCase(), class: head.className, rect: rect(head), style: style(head) },
                label: { tag: label.tagName.toLowerCase(), class: label.className, rect: rect(label), style: style(label) },
                input: { tag: input.tagName.toLowerCase(), class: input.className, rect: rect(input), style: style(input) },
                message: { tag: message.tagName.toLowerCase(), class: message.className, rect: rect(message), style: style(message) },
            };
        }, fixture.name);
        const target = path.join(root, `reports/vcp-field-${fixture.name}`);
        await fs.writeFile(`${target}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
        await page.locator('#vcp-field-fixture').screenshot({ path: `${target}.png` });
        console.log(`VCP generated Field ${fixture.name} fixture captured.`);
    }
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
