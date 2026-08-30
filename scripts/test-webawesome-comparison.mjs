import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body></body></html>', {
    url: 'https://vcp.local/',
    runScripts: 'outside-only',
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.customElements = dom.window.customElements;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.CustomEvent = dom.window.CustomEvent;

const { mountWebAwesomeComparison } = await import('../modules/ui-system/webawesome-comparison.js');

function createStub(name, props = {}) {
    const element = document.createElement(name === 'Input' ? 'input' : 'button');
    Object.assign(element.dataset, { stub: name });
    if (props.label) element.textContent = props.label;
    return { element, update() {}, close() {} };
}

function mount() {
    const host = document.createElement('div');
    document.body.append(host);
    const disposer = mountWebAwesomeComparison(host, {
        create: createStub,
        on: (target, type, listener) => {
            target.addEventListener(type, listener);
            return () => target.removeEventListener(type, listener);
        },
    });
    return { host, disposer };
}

let listener;
window.uiManager = {
    getThemeSnapshot: () => ({ value: { effective: 'dark' } }),
    subscribeTheme: callback => {
        listener = callback;
        return () => { listener = null; };
    },
};
document.body.className = 'light-theme';
const typed = mount();
const typedRoot = typed.host.querySelector('.vcp-ui-wa-comparison');
assert.equal(typedRoot.classList.contains('wa-dark'), true, 'typed snapshot must win over body class');
assert.equal(typedRoot.classList.contains('wa-light'), false);
listener(null, { value: { effective: 'light' } });
assert.equal(typedRoot.classList.contains('wa-light'), true, 'subscription must update comparison theme');
assert.equal(typedRoot.classList.contains('wa-dark'), false);
typed.disposer();
assert.equal(listener, null, 'dispose must release typed theme subscription');

delete window.uiManager;
document.body.className = 'dark-theme';
const fallback = mount();
const fallbackRoot = fallback.host.querySelector('.vcp-ui-wa-comparison');
assert.equal(fallbackRoot.classList.contains('wa-dark'), true);
document.body.className = 'light-theme';
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(fallbackRoot.classList.contains('wa-light'), true, 'legacy fallback must follow body class changes');
fallback.disposer();
assert.equal(document.querySelector('.vcp-ui-wa-comparison'), null);

console.log('webawesome-comparison theme contract checks passed.');
