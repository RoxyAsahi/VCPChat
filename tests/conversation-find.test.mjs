import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    collectFindRanges,
    createConversationFind,
    getFindState,
    moveFindSelection,
    resolveFindNavigationDirection
} from '../modules/ui-system/conversation-find.js';

const wait = (ms = 220) => new Promise(resolve => setTimeout(resolve, ms));

test('navigation keys and wrap-around selection follow ZCode', () => {
    assert.equal(resolveFindNavigationDirection('Enter', false), 'next');
    assert.equal(resolveFindNavigationDirection('Enter', true), 'previous');
    assert.equal(resolveFindNavigationDirection('ArrowUp', false), 'previous');
    assert.equal(resolveFindNavigationDirection('ArrowDown', false), 'next');
    assert.equal(resolveFindNavigationDirection('a', false), null);
    assert.deepEqual(getFindState(0, 3), { currentIndex: -1, total: 0 });
    assert.deepEqual(getFindState(5, 9), { currentIndex: 0, total: 5 });
    assert.deepEqual(getFindState(5, 2), { currentIndex: 2, total: 5 });
    assert.equal(moveFindSelection({ currentIndex: 4, total: 5 }, 'next'), 0);
    assert.equal(moveFindSelection({ currentIndex: 0, total: 5 }, 'previous'), 4);
    assert.equal(moveFindSelection({ currentIndex: -1, total: 0 }, 'next'), -1);
});

function makeChat() {
    const dom = new JSDOM(`<main><div class="chat-messages-container"><div id="chatMessages">
        <div class="message-item user"><div class="md-content">Hello hello <button>hello</button></div></div>
        <div class="message-item assistant"><div class="md-content">say <b>HeLLo</b> again<span class="thinking-indicator">hello</span></div></div>
        <div class="message-item assistant"><div class="md-content">nothing here</div></div>
    </div></div></main><textarea id="messageInput"></textarea>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const highlights = new Map();
    class Highlight { constructor(...ranges) { this.ranges = ranges; } }
    const scrolled = [];
    dom.window.Element.prototype.scrollIntoView = function scrollIntoView(options) { scrolled.push({ el: this, options }); };
    const root = doc.getElementById('chatMessages');
    return { dom, doc, root, highlights, Highlight, scrolled, highlightApi: { highlights, Highlight } };
}

const ctrlF = (dom, trusted = true) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    if (!trusted) event.vcpFindBypass = true;
    return event;
};

test('collectFindRanges matches case-insensitively in message text and skips buttons and the thinking indicator', () => {
    const { doc, root } = makeChat();
    const ranges = collectFindRanges(root, 'HELLO', doc);
    assert.equal(ranges.length, 3);
    assert.deepEqual(ranges.map(range => range.toString()), ['Hello', 'hello', 'HeLLo']);
    assert.deepEqual(collectFindRanges(root, '  ', doc), []);
});

test('Ctrl+F opens the bar, highlights, counts, navigates with Enter / Shift+Enter and closes with Esc', async () => {
    const { dom, doc, root, highlights, scrolled, highlightApi } = makeChat();
    const find = createConversationFind({ document: doc, messagesRoot: root, highlightApi });
    const bar = find.mount();
    assert.equal(bar.hidden, true);

    const event = ctrlF(dom);
    doc.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(bar.hidden, false);

    const input = bar.querySelector('.vcp-find-input');
    const count = bar.querySelector('.vcp-find-count');
    input.value = 'hello';
    input.dispatchEvent(new dom.window.Event('input'));
    await wait();
    assert.equal(count.textContent, '1 / 3');
    assert.equal(highlights.get('vcp-conversation-find').ranges.length, 3);
    assert.equal(highlights.get('vcp-conversation-find-active').ranges[0].toString(), 'Hello');
    assert.ok(scrolled.length >= 1);

    const press = (key, shiftKey = false) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    press('Enter');
    assert.equal(count.textContent, '2 / 3');
    press('Enter');
    press('Enter');
    assert.equal(count.textContent, '1 / 3', 'wraps around');
    press('Enter', true);
    assert.equal(count.textContent, '3 / 3');
    assert.equal(highlights.get('vcp-conversation-find-active').ranges[0].toString(), 'HeLLo');

    input.value = 'zzz';
    input.dispatchEvent(new dom.window.Event('input'));
    await wait();
    assert.equal(count.textContent, '无结果');
    assert.equal(bar.querySelector('.vcp-find-btn').disabled, true);
    assert.equal(highlights.has('vcp-conversation-find'), false);

    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(bar.hidden, true);
    assert.equal(find.getState().open, false);
    find.dispose();
    assert.equal(doc.querySelector('.vcp-find-bar'), null);
});

test('prefills the selected text, keeps the position when streaming changes the DOM and follows new matches', async () => {
    const { dom, doc, root, highlightApi } = makeChat();
    const find = createConversationFind({ document: doc, messagesRoot: root, highlightApi });
    const bar = find.mount();
    const range = doc.createRange();
    const text = root.querySelector('.message-item.assistant .md-content').firstChild;
    range.setStart(text, 0);
    range.setEnd(text, 3);
    dom.window.getSelection().addRange(range);

    find.open();
    const input = bar.querySelector('.vcp-find-input');
    assert.equal(input.value, 'say');
    input.value = 'hello';
    input.dispatchEvent(new dom.window.Event('input'));
    await wait();
    find.navigate('next');
    assert.equal(find.getState().activeIndex, 1);

    root.querySelector('.message-item:last-child .md-content').textContent = 'a late hello';
    await wait();
    assert.equal(find.getState().total, 4);
    assert.equal(find.getState().activeIndex, 1, 'position kept');
    find.dispose();
});

test('ignores Ctrl+F without messages, with synthetic events, and lets the global button reach searchManager', () => {
    const { dom, doc, root, highlightApi } = makeChat();
    const find = createConversationFind({ document: doc, messagesRoot: root, highlightApi });
    const bar = find.mount();

    const synthetic = ctrlF(dom, false);
    doc.dispatchEvent(synthetic);
    assert.equal(synthetic.defaultPrevented, false);
    assert.equal(bar.hidden, true);

    const received = [];
    dom.window.addEventListener('keydown', event => received.push([event.key, event.ctrlKey, event.vcpFindBypass]));
    find.open();
    bar.querySelector('.vcp-find-btn-text').click();
    assert.deepEqual(received, [['f', true, true]]);
    assert.equal(bar.hidden, true);

    root.textContent = '';
    const empty = ctrlF(dom);
    doc.dispatchEvent(empty);
    assert.equal(empty.defaultPrevented, false);
    find.dispose();
});

test('mount is a no-op without a chat container', () => {
    const dom = new JSDOM('<div></div>');
    const find = createConversationFind({ document: dom.window.document });
    assert.equal(find.mount(), null);
    find.dispose();
});

test('a match that runs away during a long scroll (layout shifts) is re-scrolled until it is in view', async () => {
    const { dom, doc, root, scrolled, highlightApi } = makeChat();
    const scroller = doc.querySelector('.chat-messages-container');
    scroller.getBoundingClientRect = () => ({ top: 100, bottom: 700, height: 600, left: 0, right: 800, width: 800 });
    // the first scrolls do not get the match into view (rows above rendered and grew); the third does
    let attempts = 0;
    const originalRange = dom.window.Range.prototype.getBoundingClientRect;
    dom.window.Range.prototype.getBoundingClientRect = function rangeRect() {
        const top = attempts >= 3 ? 300 : -25000;
        return { top, bottom: top + 16, height: 16, left: 0, right: 40, width: 40 };
    };
    dom.window.Element.prototype.scrollIntoView = function scrollIntoView(options) { attempts += 1; scrolled.push({ el: this, options }); };
    const find = createConversationFind({ document: doc, messagesRoot: root, highlightApi });
    find.mount();
    try {
        find.open();
        const input = doc.querySelector('.vcp-find-input');
        input.value = 'hello';
        input.dispatchEvent(new dom.window.Event('input'));
        await new Promise(resolve => setTimeout(resolve, 1800));
        assert.equal(scrolled.length, 3, 'scrolled again until the match was visible, then stopped');
        assert.equal(scrolled[0].options.behavior, 'auto', 'a far target uses an instant scroll');
    } finally {
        dom.window.Range.prototype.getBoundingClientRect = originalRange;
        find.dispose();
    }
});
