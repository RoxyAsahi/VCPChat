import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body></body></html>', {
    url: 'https://vcp.local/',
    runScripts: 'outside-only'
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;
globalThis.HTMLElement = dom.window.HTMLElement;

const adapter = (await import('../modules/ui-system/webawesome-adapter.js')).default;
const adapterWin = dom.window;

function scopeRoot() {
    const root = adapterWin.document.createElement('div');
    root.className = 'vcp-ui-scope';
    adapterWin.document.body.append(root);
    return root;
}

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL - ${name}\n    ${error.message}`);
    }
}

check('exposes the VCP-shaped API', () => {
    for (const key of ['loadComponents', 'create', 'on', 'awaitUpdate', 'applyTokens', 'registerTheme', 'destroy', 'isNextUi']) {
        assert.equal(typeof adapter[key], 'function', `missing ${key}`);
    }
    assert.equal(typeof adapterWin.VCPWebAwesome, 'object');
});

check('create builds a wa-* element and translates attributes', () => {
    const el = adapter.create('button', { size: 'small', disabled: true, hidden: false, label: '保存' });
    assert.equal(el.tagName.toLowerCase(), 'wa-button');
    assert.equal(el.getAttribute('size'), 'small');
    assert.equal(el.getAttribute('disabled'), '');
    assert.equal(el.hasAttribute('hidden'), false);
    assert.equal(el.getAttribute('label'), '保存');
});

check('create appends children', () => {
    const child = adapterWin.document.createElement('span');
    const el = adapter.create('button', {}, [child]);
    assert.equal(el.firstElementChild, child);
});

check('on attaches and detaches a listener', () => {
    const el = adapterWin.document.createElement('button');
    let count = 0;
    const off = adapter.on(el, 'click', () => { count += 1; });
    el.dispatchEvent(new adapterWin.window.Event('click'));
    off();
    el.dispatchEvent(new adapterWin.window.Event('click'));
    assert.equal(count, 1);
});

check('awaitUpdate resolves without updateComplete', async () => {
    const el = adapterWin.document.createElement('div');
    assert.equal(await adapter.awaitUpdate(el), el);
});

check('applyTokens marks an adapter scope in next mode and unmarks on release', () => {
    const root = scopeRoot();
    const release = adapter.applyTokens(root);
    assert.equal(root.dataset.waScope, 'true');
    release();
    assert.equal(root.hasAttribute('data-wa-scope'), false);
});

check('registerTheme is ref-counted', () => {
    const releaseOne = adapter.registerTheme();
    const releaseTwo = adapter.registerTheme();
    let link = adapterWin.document.querySelector('link[data-webawesome-runtime-theme]');
    assert.ok(link, 'theme link created');
    assert.equal(Number(link.dataset.ownerCount), 2);
    releaseOne();
    link = adapterWin.document.querySelector('link[data-webawesome-runtime-theme]');
    assert.ok(link, 'link survives first release');
    assert.equal(Number(link.dataset.ownerCount), 1);
    releaseTwo();
    link = adapterWin.document.querySelector('link[data-webawesome-runtime-theme]');
    assert.equal(link, null, 'link removed at zero owners');
});

check('isNextUi reflects the current ui mode', () => {
    assert.equal(adapter.isNextUi(), true);
    adapterWin.document.documentElement.dataset.uiMode = 'classic';
    assert.equal(adapter.isNextUi(), false);
    adapterWin.document.documentElement.dataset.uiMode = 'next';
});

check('applyTokens is a no-op outside next mode', () => {
    adapterWin.document.documentElement.dataset.uiMode = 'classic';
    const root = scopeRoot();
    const release = adapter.applyTokens(root);
    assert.equal(root.hasAttribute('data-wa-scope'), false);
    release();
    adapterWin.document.documentElement.dataset.uiMode = 'next';
});

check('loadComponents refuses to run outside next mode', async () => {
    adapterWin.document.documentElement.dataset.uiMode = 'classic';
    await assert.rejects(adapter.loadComponents(['button']), /next/);
    adapterWin.document.documentElement.dataset.uiMode = 'next';
});

check('destroy clears theme ref-count nodes', () => {
    adapter.registerTheme();
    adapter.destroy();
    assert.equal(adapterWin.document.querySelector('link[data-webawesome-runtime-theme]'), null);
});

if (failures) {
    console.error(`\n${failures} webawesome-adapter contract check(s) failed.`);
    process.exit(1);
}
console.log('\nwebawesome-adapter contract checks passed.');
