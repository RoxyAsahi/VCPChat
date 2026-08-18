const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { EscapeDispatcher } = require('../modules/ui-system/next-shell/escape-dispatcher.js');

function fixture() {
    const dom = new JSDOM('<!doctype html><html><body><button id="origin"></button></body></html>', {
        pretendToBeVisual: true,
        url: 'file:///escape-dispatcher.html',
    });
    return dom;
}

test('Escape dispatcher closes only the highest-priority active Next owner', () => {
    const dom = fixture();
    const dispatcher = new EscapeDispatcher({ document: dom.window.document });
    dispatcher.mount();
    const closed = [];
    const lower = dispatcher.register({ priority: 10, isActive: () => true, close: () => { closed.push('lower'); return true; } });
    dispatcher.register({ priority: 20, isActive: () => true, close: () => { closed.push('higher'); return true; } });
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    dom.window.document.dispatchEvent(event);
    assert.deepEqual(closed, ['higher']);
    assert.equal(event.defaultPrevented, true);
    lower();
    dispatcher.dispose();
    dom.window.close();
});

test('Escape dispatcher ignores already handled events and retracts owners on dispose', () => {
    const dom = fixture();
    const dispatcher = new EscapeDispatcher({ document: dom.window.document });
    dispatcher.mount();
    let count = 0;
    dispatcher.register({ priority: 1, close: () => { count += 1; return true; } });
    const handled = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    dom.window.document.dispatchEvent(handled);
    assert.equal(count, 0);
    dispatcher.dispose();
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(count, 0);
    dom.window.close();
});
