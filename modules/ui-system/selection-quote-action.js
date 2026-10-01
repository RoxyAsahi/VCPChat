/**
 * modules/ui-system/selection-quote-action.js
 * 选中消息文字后，在「在侧栏提问」旁边多一个「引用」：把选区作为 Markdown 引用块插进输入框。
 *
 * 对应 ZCode 的 SelectionActionMenu 里的「添加到当前任务」
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4/SelectionActionMenu.tsx）：
 * 选区多个动作并排，按钮不抢选区（mousedown 不取焦点），位置优先放在选区上方，放不下就放到下方。
 * 这里只观察 selectionchange，不碰 renderer.js 里已有的「在侧栏提问」按钮逻辑；
 * 侧栏提问按钮可见时，引用按钮紧跟在它右边。
 * 用户消息渲染前会整段做 HTML 转义（防 XSS），行首的 ">" 因此不会成为 Markdown 引用，
 * 所以发出去之后由 renderQuotedParagraphs 在 DOM 上把「整段都以 > 开头」的段落补成 <blockquote>；
 * 渲染管线（上游边界文件）和消息原文都不动。
 */

'use strict';

const MIN_SELECTION_LENGTH = 2;
const MAX_QUOTE_LENGTH = 8000;
const VIEWPORT_MARGIN = 10;
const BUTTON_GAP = 6;
const QUOTE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 10.5c0-2.4.9-4 3-5M8.5 10.5c0-2.4.9-4 3-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3 10.5h2.5v2.5H3zM8.5 10.5H11v2.5H8.5z" fill="currentColor"/></svg>';

// ------------------------------------------------------------------ pure helpers

/** 选区文本 → Markdown 引用块（空行保留为单独的 ">"）。 */
export function toMarkdownQuote(text) {
    return String(text || '')
        .replace(/\r\n?/gu, '\n')
        .trim()
        .split('\n')
        .map(line => (line.trim() ? `> ${line.trimEnd()}` : '>'))
        .join('\n');
}

/**
 * 把引用块插到光标（或选中区域）处：与前文之间空一行，后面留一个空行让用户接着写。
 * 返回新的输入框内容和插入后的光标位置。
 */
export function buildQuoteInsertion(value, selectionStart, selectionEnd, text) {
    const quote = toMarkdownQuote(text);
    const start = Math.max(0, Math.min(selectionStart ?? value.length, value.length));
    const end = Math.max(start, Math.min(selectionEnd ?? start, value.length));
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const inserted = `${lead}${quote}\n\n`;
    return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

// 引用文字里常有引号（渲染成 span.highlighted-quote）、行内代码、粗体等，这些行内元素不该让整段放弃。
const INLINE_TAGS = new Set(['SPAN', 'CODE', 'B', 'STRONG', 'I', 'EM', 'DEL', 'S', 'MARK', 'A', 'SUB', 'SUP', 'KBD']);

/**
 * 一个段落的内容按行拆开，每行是一串节点；认纯文本、<br> 和上面的行内元素，
 * 出现块级元素、图片等别的东西就返回 null。
 */
function paragraphLines(paragraph) {
    const lines = [[]];
    for (const node of paragraph.childNodes) {
        if (node.nodeType === 3) {
            const parts = node.nodeValue.split('\n');
            parts.forEach((part, index) => {
                if (index > 0) lines.push([]);
                if (part) lines[lines.length - 1].push(node.ownerDocument.createTextNode(part));
            });
        } else if (node.nodeType === 1 && node.tagName === 'BR') {
            lines.push([]);
        } else if (node.nodeType === 1 && INLINE_TAGS.has(node.tagName)) {
            lines[lines.length - 1].push(node.cloneNode(true));
        } else {
            return null;
        }
    }
    return lines;
}

const QUOTE_MARK = /^\s*>[ \t]?/;
const lineText = (nodes) => nodes.map(node => node.textContent).join('');
/** 这一行以 ">" 开头，且这个 ">" 就在行首的文本节点里（不在行内元素里面）。 */
const startsWithQuoteMark = (nodes) => nodes[0]?.nodeType === 3 && /^\s*>/.test(nodes[0].nodeValue);

/**
 * 把用户消息里「每一行都以 > 开头」的段落补成 <blockquote>，行内的引号、代码、粗体等保留。
 * 返回转换的段落数；已经是引用块里的段落、含块级元素的段落都不碰。
 */
export function renderQuotedParagraphs(root) {
    let converted = 0;
    if (!root?.querySelectorAll) return converted;
    for (const paragraph of root.querySelectorAll('.message-item.user .md-content p')) {
        if (paragraph.closest('blockquote')) continue;
        const lines = paragraphLines(paragraph);
        if (!lines) continue;
        const filled = lines.filter(nodes => lineText(nodes).trim());
        if (!filled.length || !filled.every(startsWithQuoteMark)) continue;
        const doc = paragraph.ownerDocument;
        const quote = doc.createElement('blockquote');
        const inner = doc.createElement('p');
        lines.forEach((nodes, index) => {
            if (index > 0) inner.appendChild(doc.createElement('br'));
            nodes.forEach((node, position) => {
                if (position === 0 && node.nodeType === 3) node.nodeValue = node.nodeValue.replace(QUOTE_MARK, '');
                inner.appendChild(node);
            });
        });
        quote.appendChild(inner);
        paragraph.replaceWith(quote);
        converted += 1;
    }
    return converted;
}

/** 引用按钮的位置：侧栏提问按钮可见时紧跟其右，否则选区上方居中；都放不下时换到选区下方/左边。 */
export function resolveQuoteButtonPosition({ selectionRect, anchorRect, buttonWidth, buttonHeight, viewportWidth, viewportHeight }) {
    const maxLeft = viewportWidth - buttonWidth - VIEWPORT_MARGIN;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    if (anchorRect) {
        const right = anchorRect.right + BUTTON_GAP;
        const left = right <= maxLeft ? right : clamp(anchorRect.left - BUTTON_GAP - buttonWidth, VIEWPORT_MARGIN, maxLeft);
        return { left, top: clamp(anchorRect.top, VIEWPORT_MARGIN, viewportHeight - buttonHeight - VIEWPORT_MARGIN) };
    }
    const center = selectionRect.left + selectionRect.width / 2;
    const above = selectionRect.top - buttonHeight - 8;
    const top = above >= VIEWPORT_MARGIN ? above : selectionRect.bottom + 8;
    return {
        left: clamp(center - buttonWidth / 2, VIEWPORT_MARGIN, maxLeft),
        top: clamp(top, VIEWPORT_MARGIN, viewportHeight - buttonHeight - VIEWPORT_MARGIN)
    };
}

// ------------------------------------------------------------------ controller

export function createSelectionQuoteAction({
    document: doc = document,
    messagesRoot = null,
    getInput = () => doc.getElementById('messageInput'),
    getAnchorButton = () => doc.getElementById('floatingSelectionSideChatBtn'),
    notify = null
} = {}) {
    const win = doc.defaultView;
    let button = null;
    let frame = null;
    let disposed = false;
    const cleanups = [];
    let quoteObserver = null;

    function selectionInMessages() {
        const selection = win.getSelection?.();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
        const text = selection.toString().trim();
        if (text.length < MIN_SELECTION_LENGTH) return null;
        const range = selection.getRangeAt(0);
        const ancestor = range.commonAncestorContainer;
        const element = ancestor.nodeType === 1 ? ancestor : ancestor.parentElement;
        const item = element?.closest?.('.message-item');
        if (!item || !messagesRoot?.contains(item)) return null;
        return { text, range };
    }

    function hide() {
        if (button) button.style.display = 'none';
    }

    function update() {
        frame = null;
        if (disposed || !button) return;
        const current = selectionInMessages();
        if (!current) return hide();
        button.style.display = 'inline-flex';
        const anchor = getAnchorButton?.();
        const anchorVisible = anchor && anchor.style.display !== 'none' && anchor.isConnected;
        const buttonRect = button.getBoundingClientRect();
        const position = resolveQuoteButtonPosition({
            selectionRect: current.range.getBoundingClientRect(),
            anchorRect: anchorVisible ? anchor.getBoundingClientRect() : null,
            buttonWidth: buttonRect.width || 64,
            buttonHeight: buttonRect.height || 26,
            viewportWidth: win.innerWidth,
            viewportHeight: win.innerHeight
        });
        button.style.left = `${position.left}px`;
        button.style.top = `${position.top}px`;
    }

    function scheduleUpdate() {
        if (frame !== null) return;
        // 等 renderer.js 里的侧栏提问按钮先完成定位，再跟在它旁边
        frame = win.requestAnimationFrame(update);
    }

    function quoteSelection() {
        const current = selectionInMessages();
        hide();
        if (!current) return false;
        if (current.text.length > MAX_QUOTE_LENGTH) {
            notify?.(`选区文本超过 ${MAX_QUOTE_LENGTH} 字符上限，无法引用`, 'warning');
            return false;
        }
        const input = getInput?.();
        if (!input) return false;
        const next = buildQuoteInsertion(input.value, input.selectionStart, input.selectionEnd, current.text);
        input.value = next.value;
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange(next.caret, next.caret);
        win.getSelection()?.removeAllRanges();
        return true;
    }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    function mount() {
        messagesRoot = messagesRoot || doc.getElementById('chatMessages');
        if (button || disposed || !messagesRoot || !doc.body) return null;
        button = doc.createElement('button');
        button.type = 'button';
        button.className = 'vcp-selection-quote-btn vcp-ui-scope';
        button.style.display = 'none';
        button.title = '把选中的文字作为引用放进输入框';
        button.setAttribute('aria-label', '引用选中文字');
        button.setAttribute('data-conversation-selection-action', 'quote');
        button.innerHTML = `${QUOTE_ICON}<span>引用</span>`;
        doc.body.appendChild(button);

        renderQuotedParagraphs(messagesRoot);
        if (win.MutationObserver) {
            quoteObserver = new win.MutationObserver(() => renderQuotedParagraphs(messagesRoot));
            quoteObserver.observe(messagesRoot, { childList: true, subtree: true });
        }
        on(doc, 'selectionchange', scheduleUpdate);
        on(win, 'resize', scheduleUpdate);
        on(button, 'mousedown', event => event.preventDefault()); // 不抢焦点，选区才不会丢
        on(button, 'click', (event) => {
            event.stopPropagation();
            quoteSelection();
        });
        return button;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        if (frame !== null) win.cancelAnimationFrame(frame);
        quoteObserver?.disconnect();
        quoteObserver = null;
        cleanups.splice(0).forEach(fn => fn());
        button?.remove();
        button = null;
    }

    return { mount, dispose, update, quoteSelection };
}
