import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    buildQuoteInsertion,
    createSelectionQuoteAction,
    renderQuotedParagraphs,
    resolveQuoteButtonPosition,
    toMarkdownQuote
} from '../modules/ui-system/selection-quote-action.js';

test('toMarkdownQuote prefixes every line and keeps blank lines as a bare marker', () => {
    assert.equal(toMarkdownQuote('  第一行\r\n\r\n第二行  '), '> 第一行\n>\n> 第二行');
    assert.equal(toMarkdownQuote('单行'), '> 单行');
});

test('buildQuoteInsertion separates the quote from earlier text and leaves room to keep typing', () => {
    assert.deepEqual(buildQuoteInsertion('', 0, 0, 'abc'), { value: '> abc\n\n', caret: 7 });
    assert.equal(buildQuoteInsertion('前文', 2, 2, 'abc').value, '前文\n\n> abc\n\n');
    assert.equal(buildQuoteInsertion('前文\n', 3, 3, 'abc').value, '前文\n\n> abc\n\n');
    assert.equal(buildQuoteInsertion('前文\n\n', 4, 4, 'abc').value, '前文\n\n> abc\n\n');
    // 光标在中间：后文保留，光标落在引用之后
    const mid = buildQuoteInsertion('AB', 1, 1, 'q');
    assert.equal(mid.value, 'A\n\n> q\n\nB');
    assert.equal(mid.value.slice(mid.caret), 'B');
    // 选中区域被替换
    assert.equal(buildQuoteInsertion('0123456', 2, 5, 'q').value, '01\n\n> q\n\n56');
});

test('resolveQuoteButtonPosition follows the side-chat button, else sits above the selection and flips below at the top', () => {
    const base = { buttonWidth: 60, buttonHeight: 26, viewportWidth: 800, viewportHeight: 600 };
    const selectionRect = { left: 300, width: 100, top: 200, bottom: 220 };
    assert.deepEqual(resolveQuoteButtonPosition({ ...base, selectionRect, anchorRect: { left: 250, right: 360, top: 164 } }), { left: 366, top: 164 });
    // 右边放不下：换到侧栏提问按钮左边
    assert.deepEqual(resolveQuoteButtonPosition({ ...base, selectionRect, anchorRect: { left: 690, right: 790, top: 164 } }), { left: 624, top: 164 });
    assert.deepEqual(resolveQuoteButtonPosition({ ...base, selectionRect, anchorRect: null }), { left: 320, top: 166 });
    assert.deepEqual(resolveQuoteButtonPosition({ ...base, selectionRect: { left: 300, width: 100, top: 20, bottom: 40 }, anchorRect: null }), { left: 320, top: 48 });
    assert.equal(resolveQuoteButtonPosition({ ...base, selectionRect: { left: 0, width: 10, top: 200, bottom: 220 }, anchorRect: null }).left, 10);
});

function makeChat() {
    const dom = new JSDOM(`<main><div id="chatMessages">
        <div class="message-item assistant" data-message-id="a1"><div class="md-content"><p id="para">这是一段可以被选中的回答文字</p></div></div>
    </div></main><div id="outside">外面的文字在消息之外</div><textarea id="messageInput"></textarea>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 300, width: 100, top: 200, bottom: 220, right: 400 });
    const select = (id, from, to) => {
        const node = doc.getElementById(id).firstChild;
        const range = doc.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        const selection = dom.window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        doc.dispatchEvent(new dom.window.Event('selectionchange'));
    };
    const frame = () => new Promise(resolve => dom.window.requestAnimationFrame(() => resolve()));
    return { dom, doc, select, frame, root: doc.getElementById('chatMessages'), input: doc.getElementById('messageInput') };
}

test('shows only for a long enough selection inside a message, quotes it into the composer and clears the selection', async () => {
    const { dom, doc, select, frame, root, input } = makeChat();
    const notices = [];
    const action = createSelectionQuoteAction({ document: doc, messagesRoot: root, notify: (...args) => notices.push(args) });
    const button = action.mount();
    assert.equal(button.style.display, 'none');

    select('para', 0, 1);
    await frame();
    assert.equal(button.style.display, 'none', 'one character is not worth a menu');

    select('outside', 0, 6);
    await frame();
    assert.equal(button.style.display, 'none', 'selections outside messages are ignored');

    select('para', 2, 8);
    await frame();
    await frame();
    assert.equal(button.style.display, 'inline-flex');

    input.value = '我的问题：';
    input.setSelectionRange(input.value.length, input.value.length);
    let inputEvents = 0;
    input.addEventListener('input', () => { inputEvents += 1; });
    const mousedown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(mousedown);
    assert.equal(mousedown.defaultPrevented, true, 'must not steal focus from the selection');
    button.click();
    assert.equal(input.value, '我的问题：\n\n> 一段可以被选\n\n');
    assert.equal(inputEvents, 1);
    assert.equal(doc.activeElement, input);
    assert.equal(input.selectionStart, input.value.length);
    assert.equal(dom.window.getSelection().isCollapsed, true);
    assert.equal(button.style.display, 'none');
    assert.deepEqual(notices, []);

    action.dispose();
    assert.equal(doc.querySelector('.vcp-selection-quote-btn'), null);
});

test('refuses oversized selections with a notice and keeps following the side-chat button', async () => {
    const { dom, doc, select, frame, root, input } = makeChat();
    doc.getElementById('para').firstChild.data = '长'.repeat(8100);
    const notices = [];
    const anchor = doc.createElement('button');
    anchor.id = 'floatingSelectionSideChatBtn';
    anchor.style.display = 'inline-flex';
    anchor.getBoundingClientRect = () => ({ left: 100, right: 210, top: 50 });
    doc.body.appendChild(anchor);
    const action = createSelectionQuoteAction({ document: doc, messagesRoot: root, notify: (...args) => notices.push(args) });
    const button = action.mount();

    select('para', 0, 8100);
    await frame();
    await frame();
    assert.equal(button.style.left, '216px');
    assert.equal(button.style.top, '50px');
    assert.equal(action.quoteSelection(), false);
    assert.equal(input.value, '');
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], 'warning');
    action.dispose();
    action.dispose();
});

test('mount is a no-op without a chat container', () => {
    const dom = new JSDOM('<div></div>');
    const action = createSelectionQuoteAction({ document: dom.window.document });
    assert.equal(action.mount(), null);
});

test('sent quotes: paragraphs where every line starts with > become blockquotes, nothing else is touched', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(`<div id="chatMessages">
        <div class="message-item user"><div class="md-content">
            <p>&gt; 第一行<br>&gt; 第二行</p><p>这段什么意思</p><p>1 &gt; 0 不是引用</p><p>&gt; 带<img src="x.png"></p><p>&gt; 有<span class="highlighted-quote">"引号"</span>和<code>代码</code><br>&gt; 第二行<b>粗</b></p>
        </div></div>
        <div class="message-item assistant"><div class="md-content"><p>&gt; 助手消息不动</p></div></div>
    </div>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('chatMessages');
    assert.equal(renderQuotedParagraphs(root), 2);
    const quotes = root.querySelectorAll('.message-item.user blockquote');
    assert.equal(quotes[0].querySelector('p').innerHTML, '第一行<br>第二行');
    assert.equal(quotes[1].querySelector('p').innerHTML, '有<span class="highlighted-quote">"引号"</span>和<code>代码</code><br>第二行<b>粗</b>', 'inline quotes / code / bold survive');
    assert.equal(root.querySelectorAll('.message-item.user p').length, 5, '2 quote paragraphs + 3 untouched ones (plain, "1 > 0", block-level img)');
    assert.match(root.querySelector('.message-item.assistant p').textContent, /^> /);
    assert.equal(renderQuotedParagraphs(root), 0, 'idempotent');

    const mounted = createSelectionQuoteAction({ document: doc, messagesRoot: root });
    mounted.mount();
    const late = doc.createElement('div');
    late.className = 'message-item user';
    late.innerHTML = '<div class="md-content"><p>&gt; 后来渲染的</p></div>';
    root.appendChild(late);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(late.querySelector('blockquote p').textContent, '后来渲染的');
    mounted.dispose();
});
