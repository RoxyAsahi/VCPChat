import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe'
        : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

const mime = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8']]);
const html = `<!doctype html><html data-vcp-ui-surface="main-chat"><head><meta charset="utf-8"></head><body class="vcp-ui-scope">
<script src="/modules/ui-system/surface-policy.js"></script>
<script type="module">
import '/modules/ui-system/webawesome-adapter.js';
await window.VCPWebAwesome.loadComponents(['input', 'textarea']);
const { default: VCPUI } = await import('/modules/ui-system/vcp-ui.js');
const form = document.createElement('form');
const input = VCPUI.create('Input', {
  value: 'alpha', name: 'agentName', type: 'password', required: true,
  autocomplete: 'current-password', autocapitalize: 'none', autocorrect: false,
  enterkeyhint: 'next', inputmode: 'text', minlength: 2, maxlength: 64,
  pattern: '.+', min: 1, max: 9, step: 1, title: 'Agent name', passwordToggle: true, spellcheck: false
});
const textarea = VCPUI.create('Textarea', {
  value: 'body', name: 'body', rows: 6, resize: 'vertical', required: true,
  autocomplete: 'off', minlength: 2, maxlength: 256, spellcheck: false
});
const field = VCPUI.create('Field', { label: '名称', helper: '输入助手名称', control: input });
form.append(field.element, textarea.element);
document.body.append(form);
await Promise.all([input.element.updateComplete, textarea.element.updateComplete]);
window.textControls = { form, input, textarea, field };
window.textControlReady = true;
</script></body></html>`;

const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname === '/text-controls.html') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(html);
            return;
        }
        const target = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('path escape');
        response.writeHead(200, { 'content-type': mime.get(path.extname(target)) || 'application/octet-stream' });
        response.end(await fs.readFile(target));
    } catch (error) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(String(error?.message || error));
    }
});

await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
const webPort = server.address().port;
const debugPort = await freePort();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vcp-text-controls-'));
const mainPath = path.join(tempRoot, 'main.cjs');
await fs.writeFile(mainPath, `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  await win.loadURL(${JSON.stringify(`http://127.0.0.1:${webPort}/text-controls.html`)});
});
app.on('window-all-closed', () => app.quit());
`, 'utf8');

const child = spawn(electron, [mainPath, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${tempRoot}`], {
    cwd: root, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
let browser;
try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Electron exited early: ${stderr}`);
        try {
            await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${debugPort}/json/version`, response => {
                response.resume(); response.on('end', resolve);
            }).on('error', reject));
            break;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}` });
    let page;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => candidate.url().includes('/text-controls.html'));
        if (page) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(page, `text-control page did not open: ${stderr}`);
    await page.waitForFunction(() => window.textControlReady === true);

    const state = await page.evaluate(async () => {
        const { form, input, textarea, field } = window.textControls;
        const hostInput = input.element;
        const hostTextarea = textarea.element;
        const internalInput = hostInput.shadowRoot?.querySelector('input');
        const internalTextarea = hostTextarea.shadowRoot?.querySelector('textarea');
        const events = [];
        for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'change']) {
            hostInput.addEventListener(type, () => events.push(type));
        }
        internalInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' }));
        internalInput.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, composed: true, data: '你' }));
        internalInput.value = '你好';
        internalInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: '你好' }));
        internalInput.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: '好', inputType: 'insertCompositionText' }));
        hostInput.dispatchEvent(new Event('change', { bubbles: true }));
        await hostInput.updateComplete;
        const imeEvents = [...events];
        input.focus();
        input.setSelectionRange(0, 1, 'forward');
        const selection = [internalInput.selectionStart, internalInput.selectionEnd, internalInput.selectionDirection];
        const focused = document.activeElement === hostInput && hostInput.shadowRoot.activeElement === internalInput;
        const formValue = new FormData(form).get('agentName');
        input.setValue('changed before reset');
        await hostInput.updateComplete;
        form.reset();
        await new Promise(resolve => setTimeout(resolve, 0));
        input.update({ placeholder: 'after reset' });
        await hostInput.updateComplete;
        const resetValue = input.getValue();
        input.setCustomValidity('controlled invalid');
        const invalid = input.checkValidity();
        input.setCustomValidity('');
        hostInput.value = 'autofilled';
        hostInput.dispatchEvent(new Event('change', { bubbles: true }));
        input.update({ placeholder: 'after autofill' });
        await hostInput.updateComplete;
        const result = {
            providers: [hostInput.localName, hostTextarea.localName],
            lightDomNative: [hostInput.querySelector('input'), hostTextarea.querySelector('textarea')].filter(Boolean).length,
            internalTags: [internalInput?.localName, internalTextarea?.localName],
            internalInputType: internalInput?.type,
            passwordToggleProperty: hostInput.passwordToggle,
            attrs: {
                name: hostInput.getAttribute('name'), autocomplete: hostInput.getAttribute('autocomplete'),
                autocapitalize: hostInput.getAttribute('autocapitalize'), autocorrect: hostInput.getAttribute('autocorrect'),
                enterkeyhint: hostInput.getAttribute('enterkeyhint'), inputmode: hostInput.getAttribute('inputmode'),
                minlength: hostInput.getAttribute('minlength'), maxlength: hostInput.getAttribute('maxlength'),
                pattern: hostInput.getAttribute('pattern'), min: hostInput.getAttribute('min'), max: hostInput.getAttribute('max'),
                step: hostInput.getAttribute('step'), title: hostInput.getAttribute('title'),
                spellcheck: hostInput.getAttribute('spellcheck'), passwordToggle: hostInput.hasAttribute('password-toggle'),
            },
            field: {
                labelFor: field.element.querySelector('label')?.htmlFor,
                inputId: hostInput.id,
                describedBy: hostInput.getAttribute('aria-describedby'),
                messageId: field.element.querySelector('.vcp-ui-field-message')?.id,
                required: hostInput.required,
            },
            events: imeEvents,
            selection,
            focused,
            formValue,
            resetValue,
            invalid,
            validAfterClear: input.checkValidity(),
            autofillValue: input.getValue(),
            textarea: { rows: hostTextarea.rows, value: textarea.getValue() },
        };
        field.destroy();
        input.destroy();
        textarea.destroy();
        input.setValue('late mutation');
        input.setSelectionRange(0, 0);
        input.setCustomValidity('late invalid');
        for (let index = 0; index < 20; index += 1) {
            const transient = VCPUI.create('Input', { value: `cycle-${index}`, name: `cycle-${index}` });
            document.body.append(transient.element);
            await transient.element.updateComplete;
            transient.destroy();
        }
        return {
            ...result,
            postDestroyInputValue: input.control.value,
            remaining: document.querySelectorAll('wa-input, wa-textarea, .vcp-ui-field').length,
        };
    });

    assert.deepEqual(state.providers, ['wa-input', 'wa-textarea']);
    assert.equal(state.lightDomNative, 0, 'owned text controls must not fabricate native shims');
    assert.deepEqual(state.internalTags, ['input', 'textarea']);
    assert.equal(state.internalInputType, 'password');
    assert.equal(state.passwordToggleProperty, true);
    assert.deepEqual(state.attrs, {
        name: 'agentName', autocomplete: 'current-password', autocapitalize: 'none', autocorrect: 'off',
        enterkeyhint: 'next', inputmode: 'text', minlength: '2', maxlength: '64', pattern: '.+', min: '1', max: '9',
        step: '1', title: 'Agent name', spellcheck: 'false', passwordToggle: true,
    });
    assert.equal(state.field.labelFor, state.field.inputId);
    assert.ok(state.field.describedBy?.includes(state.field.messageId));
    assert.equal(state.field.required, true);
    assert.deepEqual(state.events, ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'change']);
    assert.deepEqual(state.selection, [0, 1, 'forward']);
    assert.equal(state.focused, true);
    assert.equal(state.formValue, '你好');
    assert.equal(state.resetValue, '', 'form reset must become the controller state before unrelated updates');
    assert.equal(state.invalid, false);
    assert.equal(state.validAfterClear, true);
    assert.equal(state.autofillValue, 'autofilled');
    assert.equal(state.postDestroyInputValue, 'autofilled', 'destroyed text controls must reject late writes');
    assert.deepEqual(state.textarea, { rows: 6, value: '' }, 'form reset must synchronize Textarea state too');
    assert.equal(state.remaining, 0);
    console.log(`VCPUI text controls passed in Electron (${process.platform}/${process.arch}).`);
} finally {
    browser?.disconnect();
    child.kill();
    if (child.exitCode === null) {
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 2_000)),
        ]);
    }
    server.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
}
