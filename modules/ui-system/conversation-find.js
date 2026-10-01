/**
 * modules/ui-system/conversation-find.js
 * 主聊天的「在当前对话中查找」：Ctrl+F 打开浮动查找条，匹配高亮，Enter / ↓ 下一处，Shift+Enter / ↑ 上一处。
 *
 * 导航规则与高亮方式对照 ZCode（https://github.com/zai-org/ZCode ，Apache-2.0）的
 * conversationFindSearch.ts / conversationFindHighlightDom.ts：用 CSS Custom Highlight API 给文本范围上色，
 * 不改动消息 DOM，流式输出时也不会被重渲染冲掉。
 * 原来的 Ctrl+F（searchManager 的跨话题全局搜索）仍可用：查找条里有「全局搜索」按钮，
 * 它会派发一个合成的 Ctrl+F 交给 searchManager（带 vcpFindBypass 标记，不会被这里拦截）。
 */

'use strict';

const FIND_HIGHLIGHT_NAME = 'vcp-conversation-find';
const ACTIVE_FIND_HIGHLIGHT_NAME = 'vcp-conversation-find-active';
const SKIP_SELECTOR = 'script,style,button,input,textarea,select,.thinking-indicator,[data-conversation-find-ignore="true"]';
import { releaseChatBottomFollow } from './chat-scroll-release.js';

const RESEARCH_DEBOUNCE_MS = 160;
const SCROLL_SETTLE_MS = 360;
const SCROLL_SETTLE_ATTEMPTS = 6;

// ------------------------------------------------------------------ pure helpers

/** Enter / ↓ 下一处，Shift+Enter / ↑ 上一处，其余键不导航。 */
export function resolveFindNavigationDirection(key, shiftKey) {
    if (key === 'ArrowUp') return 'previous';
    if (key === 'ArrowDown') return 'next';
    if (key === 'Enter') return shiftKey ? 'previous' : 'next';
    return null;
}

export function getFindState(total, preferredIndex) {
    if (total <= 0) return { currentIndex: -1, total: 0 };
    return {
        currentIndex: preferredIndex >= 0 && preferredIndex < total ? preferredIndex : 0,
        total
    };
}

export function moveFindSelection(state, direction) {
    if (state.total <= 0 || state.currentIndex < 0) return -1;
    const delta = direction === 'next' ? 1 : -1;
    return (state.currentIndex + delta + state.total) % state.total;
}

/** 收集 root 下所有 .message-item .md-content 里与 query 相等（忽略大小写）的文本范围，按文档顺序。 */
export function collectFindRanges(root, query, doc = root?.ownerDocument) {
    const normalized = String(query || '').trim().toLocaleLowerCase();
    if (!root || !doc || !normalized) return [];
    const ranges = [];
    const containers = root.querySelectorAll('.message-item .md-content');
    for (const container of containers) {
        const walker = doc.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */, {
            acceptNode(node) {
                if (node.parentElement?.closest(SKIP_SELECTOR)) return 2; // REJECT
                return node.data.toLocaleLowerCase().includes(normalized) ? 1 : 3; // ACCEPT : SKIP
            }
        });
        let node = walker.nextNode();
        while (node) {
            const text = node.data.toLocaleLowerCase();
            let from = 0;
            while (from < text.length) {
                const index = text.indexOf(normalized, from);
                if (index === -1) break;
                const range = doc.createRange();
                range.setStart(node, index);
                range.setEnd(node, index + normalized.length);
                ranges.push(range);
                from = index + normalized.length;
            }
            node = walker.nextNode();
        }
    }
    return ranges;
}

// ------------------------------------------------------------------ controller

const ICONS = {
    up: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 10.5 8 6l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 5.5 8 10l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
};

function h(doc, tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

export function createConversationFind({
    document: doc = document,
    messagesRoot = null,
    highlightApi = null // 测试注入：{ highlights: Map-like, Highlight: class }
} = {}) {
    const win = doc.defaultView;
    const cleanups = [];
    let messages = messagesRoot;
    let scroller = null;
    let bar = null;
    let input = null;
    let countEl = null;
    let prevBtn = null;
    let nextBtn = null;
    let ranges = [];
    let activeIndex = -1;
    let lastQuery = '';
    let researchTimer = null;
    let scrollSettleTimer = null;
    let observer = null;
    let open = false;
    let mounted = false;
    let disposed = false;

    function getHighlightSupport() {
        if (highlightApi) return highlightApi;
        const highlights = win?.CSS?.highlights;
        const Highlight = win?.Highlight;
        return highlights && Highlight ? { highlights, Highlight } : null;
    }

    function paintHighlights() {
        const support = getHighlightSupport();
        if (!support) return;
        if (!open || ranges.length === 0) {
            support.highlights.delete(FIND_HIGHLIGHT_NAME);
            support.highlights.delete(ACTIVE_FIND_HIGHLIGHT_NAME);
            return;
        }
        const all = new support.Highlight(...ranges);
        all.priority = 0;
        support.highlights.set(FIND_HIGHLIGHT_NAME, all);
        const active = new support.Highlight(...(ranges[activeIndex] ? [ranges[activeIndex]] : []));
        active.priority = 1;
        support.highlights.set(ACTIVE_FIND_HIGHLIGHT_NAME, active);
    }

    function updateCount() {
        if (!countEl) return;
        const hasQuery = Boolean(input?.value.trim());
        countEl.textContent = !hasQuery ? '' : ranges.length === 0 ? '无结果' : `${activeIndex + 1} / ${ranges.length}`;
        countEl.classList.toggle('is-empty', hasQuery && ranges.length === 0);
        if (prevBtn) prevBtn.disabled = ranges.length === 0;
        if (nextBtn) nextBtn.disabled = ranges.length === 0;
    }

    /** 当前匹配与滚动容器的相对位置；没有布局信息（测试环境）时返回 null。 */
    function viewportOffsetOf(range) {
        const rect = range.getBoundingClientRect?.();
        const box = (scroller || messages)?.getBoundingClientRect?.();
        if (!rect || !box || box.height === 0) return null;
        return { rect, box };
    }

    /**
     * 长话题里消息用了 content-visibility: auto：往上滚时屏幕外的消息才真正渲染、高度跟着变，
     * 一次 smooth 的 scrollIntoView（尤其是几万像素的长距离）会被布局抖动带偏，匹配落在视口外几万像素。
     * 所以：远的先用瞬时滚动，滚完再校验，没进视口就重来几次。
     */
    function scrollActiveIntoView(attempt = 0) {
        win.clearTimeout(scrollSettleTimer);
        scrollSettleTimer = null;
        const range = ranges[activeIndex];
        if (!range) return;
        const container = range.commonAncestorContainer;
        const element = container.nodeType === 1 ? container : container.parentElement;
        const where = viewportOffsetOf(range);
        releaseChatBottomFollow(scroller);
        const far = where && Math.abs(where.rect.top - where.box.top) > where.box.height * 1.5;
        element?.scrollIntoView?.({ block: 'center', behavior: attempt === 0 && !far ? 'smooth' : 'auto' });
        if (attempt >= SCROLL_SETTLE_ATTEMPTS) return;
        scrollSettleTimer = win.setTimeout(() => {
            scrollSettleTimer = null;
            if (disposed || !open || ranges[activeIndex] !== range) return;
            const now = viewportOffsetOf(range);
            if (now && (now.rect.bottom <= now.box.top || now.rect.top >= now.box.bottom)) scrollActiveIntoView(attempt + 1);
        }, SCROLL_SETTLE_MS);
    }

    /** 重新搜索。query 不变时（DOM 变化触发）保留当前位置，不滚动。 */
    function search({ keepPosition = false, scroll = true } = {}) {
        const query = input?.value ?? '';
        const previous = keepPosition && query === lastQuery ? activeIndex : -1;
        lastQuery = query;
        ranges = collectFindRanges(messages, query, doc);
        activeIndex = getFindState(ranges.length, previous).currentIndex;
        paintHighlights();
        updateCount();
        if (scroll && previous < 0) scrollActiveIntoView();
    }

    function scheduleSearch(options) {
        win.clearTimeout(researchTimer);
        researchTimer = win.setTimeout(() => { researchTimer = null; if (open && !disposed) search(options); }, RESEARCH_DEBOUNCE_MS);
    }

    function navigate(direction) {
        if (ranges.length === 0) return;
        activeIndex = moveFindSelection(getFindState(ranges.length, activeIndex), direction);
        paintHighlights();
        updateCount();
        scrollActiveIntoView();
    }

    function openBar(initialQuery = '') {
        if (!bar || disposed) return;
        open = true;
        bar.hidden = false;
        const selected = String(win.getSelection?.()?.toString() || '').trim();
        const preset = typeof initialQuery === 'string' ? initialQuery.trim() : '';
        if (preset) input.value = preset;
        else if (selected && !selected.includes('\n') && selected.length <= 200) input.value = selected;
        input.focus();
        input.select();
        search({ scroll: false });
        // 只在 DOM 真的变化（流式输出、切话题）时重搜
        observer = observer || (typeof win.MutationObserver === 'function' ? new win.MutationObserver(() => scheduleSearch({ keepPosition: true, scroll: false })) : null);
        observer?.observe(messages, { childList: true, subtree: true, characterData: true });
    }

    function closeBar({ restoreFocus = true } = {}) {
        if (!open) return;
        open = false;
        win.clearTimeout(researchTimer);
        win.clearTimeout(scrollSettleTimer);
        observer?.disconnect();
        ranges = [];
        activeIndex = -1;
        paintHighlights();
        if (bar) bar.hidden = true;
        if (restoreFocus) doc.getElementById('messageInput')?.focus?.();
    }

    function canHandleFind(event) {
        if (event.vcpFindBypass) return false; // 「全局搜索」按钮派发的合成事件交给 searchManager
        if (!messages?.isConnected || !messages.querySelector('.message-item')) return false;
        const globalSearch = doc.getElementById('global-search-modal');
        if (globalSearch && globalSearch.style.display && globalSearch.style.display !== 'none') return false;
        return true;
    }

    function onKeydown(event) {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
            if (!canHandleFind(event)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            openBar();
            return;
        }
        if (event.key === 'Escape' && open && bar.contains(doc.activeElement)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeBar();
        }
    }

    function openGlobalSearch() {
        closeBar({ restoreFocus: false });
        const KeyboardEventCtor = win.KeyboardEvent;
        const event = new KeyboardEventCtor('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
        event.vcpFindBypass = true;
        win.dispatchEvent(event);
    }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    function mount() {
        if (mounted || disposed) return bar;
        messages = messages || doc.getElementById('chatMessages');
        scroller = messages?.closest('.chat-messages-container') || null;
        const host = scroller?.parentElement;
        if (!messages || !host) return null;
        if (win.getComputedStyle(host).position === 'static') host.style.position = 'relative';

        bar = h(doc, 'div', 'vcp-find-bar zc-scope');
        bar.setAttribute('role', 'search');
        bar.setAttribute('data-conversation-find-ignore', 'true');
        bar.hidden = true;

        input = h(doc, 'input', 'vcp-find-input');
        input.type = 'text';
        input.placeholder = '在当前对话中查找';
        input.setAttribute('aria-label', '在当前对话中查找');
        input.spellcheck = false;
        countEl = h(doc, 'span', 'vcp-find-count');
        countEl.setAttribute('aria-live', 'polite');
        prevBtn = h(doc, 'button', 'vcp-find-btn');
        prevBtn.type = 'button';
        prevBtn.title = '上一处（Shift+Enter / ↑）';
        prevBtn.setAttribute('aria-label', '上一处');
        prevBtn.innerHTML = ICONS.up;
        nextBtn = h(doc, 'button', 'vcp-find-btn');
        nextBtn.type = 'button';
        nextBtn.title = '下一处（Enter / ↓）';
        nextBtn.setAttribute('aria-label', '下一处');
        nextBtn.innerHTML = ICONS.down;
        const globalBtn = h(doc, 'button', 'vcp-find-btn vcp-find-btn-text', '全局');
        globalBtn.type = 'button';
        globalBtn.title = '在所有话题中搜索';
        globalBtn.setAttribute('aria-label', '在所有话题中搜索');
        const closeBtn = h(doc, 'button', 'vcp-find-btn');
        closeBtn.type = 'button';
        closeBtn.title = '关闭（Esc）';
        closeBtn.setAttribute('aria-label', '关闭查找');
        closeBtn.innerHTML = ICONS.close;
        bar.append(input, countEl, prevBtn, nextBtn, globalBtn, closeBtn);
        host.appendChild(bar);
        mounted = true;

        on(doc, 'keydown', onKeydown, true);
        on(input, 'input', () => scheduleSearch());
        on(input, 'keydown', (event) => {
            if (event.isComposing) return;
            const direction = resolveFindNavigationDirection(event.key, event.shiftKey);
            if (!direction) return;
            event.preventDefault();
            if (researchTimer !== null) { win.clearTimeout(researchTimer); researchTimer = null; search(); return; }
            navigate(direction);
        });
        on(prevBtn, 'click', () => navigate('previous'));
        on(nextBtn, 'click', () => navigate('next'));
        on(closeBtn, 'click', () => closeBar());
        on(globalBtn, 'click', openGlobalSearch);
        return bar;
    }

    function dispose() {
        if (disposed) return;
        closeBar({ restoreFocus: false });
        disposed = true;
        observer?.disconnect();
        observer = null;
        cleanups.splice(0).forEach(fn => fn());
        bar?.remove();
        bar = null;
    }

    return {
        mount,
        dispose,
        open: openBar,
        close: closeBar,
        navigate,
        getState: () => ({ open, total: ranges.length, activeIndex, query: lastQuery })
    };
}
