/**
 * modules/ui-system/conversation-turn-navigator.js
 * 主聊天左侧的「按提问快速定位」导轨：每条用户提问一根短横条，悬停的那根像山峰一样放大，
 * 悬停卡片里是这条提问和助手回答的开头，点击平滑滚动到对应位置。
 *
 * 结构、交互和数值对照 ZCode 的 ConversationTurnNavigator / conversationTurnNavigatorHelpers
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4），
 * 由 React + Tailwind 改写为原生 DOM + styles/ui-system/turn-navigator.css。
 * ZCode 的数据来自虚拟列表的 render unit；这里直接观察主聊天的消息 DOM：
 * 每个 .message-item.user 是一个导航项，它到下一条用户消息之间的助手消息提供回答摘要。
 */

'use strict';

import { releaseChatBottomFollow } from './chat-scroll-release.js';

export const TURN_NAVIGATOR_MIN_WIDTH_PX = 560; // ZCode 是 864；VCPChat 的聊天列常被侧栏和右侧栏挤窄
const DEFAULT_MAX_PREVIEW_CHARS = 220;
const DEFAULT_MAX_PREVIEW_PARAGRAPHS = 2;
const HOVER_OPEN_DELAY_MS = 120;
const HOVER_CLOSE_DELAY_MS = 80;
const REFRESH_DEBOUNCE_MS = 150;
const JUMP_TOP_MARGIN_PX = 12;
const JUMP_RELEASE_FOLLOW_MIN_PX = 80;
const JUMP_SETTLE_MS = 450;
const JUMP_SETTLE_ATTEMPTS = 5;
const JUMP_SETTLE_TOLERANCE_PX = 40;
const USER_FALLBACK_PREVIEW = '（没有文字内容）';
const ASSISTANT_EMPTY_PREVIEW = '还没有回答';
const ASSISTANT_RUNNING_PREVIEW = '正在回答…';

// ------------------------------------------------------------------ pure helpers

function normalizePreviewParagraphs(text, maxParagraphs) {
    return String(text || '')
        .trim()
        .split(/\n\s*\n/u)
        .map(paragraph => paragraph.replace(/\s+/gu, ' ').trim())
        .filter(Boolean)
        .slice(0, Math.max(1, maxParagraphs));
}

function truncatePreview(text, maxChars) {
    const limit = Math.max(8, maxChars);
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 3).trimEnd()}...`;
}

export function buildPreviewText(texts, fallback, {
    maxPreviewChars = DEFAULT_MAX_PREVIEW_CHARS,
    maxPreviewParagraphs = DEFAULT_MAX_PREVIEW_PARAGRAPHS
} = {}) {
    const paragraphs = normalizePreviewParagraphs(texts.join('\n\n'), maxPreviewParagraphs);
    if (paragraphs.length === 0) return fallback;
    return truncatePreview(paragraphs.join('\n'), maxPreviewChars);
}

/**
 * entries: [{ id, userText, assistantTexts: string[], running }]，按出现顺序。
 * 没有用户提问就没有导航项；助手摘要取该提问到下一条提问之间的文字。
 */
export function buildTurnNavigatorItems(entries, options = {}) {
    return (entries || []).map((entry, index) => {
        const assistantTexts = (entry.assistantTexts || []).filter(text => String(text || '').trim());
        let assistantPreview;
        let assistantPreviewKind;
        if (assistantTexts.length > 0) {
            assistantPreview = buildPreviewText(assistantTexts, ASSISTANT_EMPTY_PREVIEW, options);
            assistantPreviewKind = 'text';
        } else if (entry.running) {
            assistantPreview = ASSISTANT_RUNNING_PREVIEW;
            assistantPreviewKind = 'running';
        } else {
            assistantPreview = ASSISTANT_EMPTY_PREVIEW;
            assistantPreviewKind = 'empty';
        }
        return {
            key: String(entry.id ?? index),
            index,
            userPreview: buildPreviewText([entry.userText || ''], USER_FALLBACK_PREVIEW, options),
            assistantPreview,
            assistantPreviewKind,
            isRunning: Boolean(entry.running)
        };
    });
}

function finiteNonNegative(value) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * positions: [{ key, start, end }]（相对滚动容器内容的像素）。
 * 视口里可见的提问中取离视口顶部最近的；一个都看不见就取视口上方最近的一条，再不行取下方第一条。
 */
export function resolveActiveTurnKey({ positions, scrollOffsetPx, viewportHeightPx }) {
    if (!positions?.length) return undefined;
    const viewportStart = finiteNonNegative(scrollOffsetPx);
    const viewportEnd = viewportStart + Math.max(1, finiteNonNegative(viewportHeightPx));
    const normalized = positions
        .map(position => {
            const start = finiteNonNegative(position.start);
            return { key: position.key, start, end: Math.max(start, finiteNonNegative(position.end)) };
        })
        .sort((left, right) => left.start - right.start);

    const visible = normalized.filter(position => position.end >= viewportStart && position.start <= viewportEnd);
    if (visible.length > 0) {
        return visible.reduce((nearest, candidate) =>
            Math.abs(candidate.start - viewportStart) < Math.abs(nearest.start - viewportStart) ? candidate : nearest).key;
    }
    const above = normalized.filter(position => position.start <= viewportStart);
    return above.length ? above[above.length - 1].key : normalized.find(position => position.start > viewportStart)?.key;
}

/** 悬停/聚焦的那根放大成「山峰」，左右邻居依次递减。 */
export function resolveBarVisualState({ itemIndex, visualFocusItemIndex }) {
    if (visualFocusItemIndex === undefined) return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
    const distance = Math.abs(itemIndex - visualFocusItemIndex);
    if (distance === 0) return { colorTone: 'focus', opacity: 1, scaleX: 2.6, tone: 'peak' };
    if (distance === 1) return { colorTone: 'muted', opacity: 0.86, scaleX: 1.7, tone: 'near' };
    if (distance === 2) return { colorTone: 'muted', opacity: 0.72, scaleX: 1.25, tone: 'mid' };
    return { colorTone: 'muted', opacity: 0.58, scaleX: 1, tone: 'idle' };
}

// ------------------------------------------------------------------ DOM reading

function readMessageText(messageItem) {
    const content = messageItem.querySelector('.md-content');
    if (!content) return '';
    const clone = content.cloneNode(true);
    clone.querySelectorAll('.thinking-indicator, style, script, .vcp-tool-use-bubble, details').forEach(node => node.remove());
    return clone.textContent || '';
}

/**
 * 把消息列表读成 buildTurnNavigatorItems 需要的 entries。
 * textCache（WeakMap）+ dirty（Set）让没有变化的消息不必每次都克隆一遍 DOM：
 * 只有被标记为 dirty 的消息才会重新读取文字。
 */
export function collectTurnEntries(messagesRoot, { textCache = null, dirty = null } = {}) {
    const textOf = (element) => {
        if (!textCache) return readMessageText(element);
        if (!dirty?.has(element) && textCache.has(element)) return textCache.get(element);
        const text = readMessageText(element);
        textCache.set(element, text);
        dirty?.delete(element);
        return text;
    };
    const entries = [];
    let current = null;
    for (const child of Array.from(messagesRoot?.children || [])) {
        if (!child.classList?.contains('message-item')) continue;
        if (child.classList.contains('user')) {
            current = {
                id: child.dataset.messageId || `idx-${entries.length}`,
                element: child,
                userText: textOf(child),
                assistantTexts: [],
                running: false
            };
            entries.push(current);
        } else if (child.classList.contains('assistant') && current) {
            current.assistantTexts.push(textOf(child));
            if (child.classList.contains('streaming')) current.running = true;
        }
    }
    return entries;
}

// ------------------------------------------------------------------ controller

export function createConversationTurnNavigator({
    document: doc = document,
    messagesRoot = null,
    scrollRoot = null,
    minWidthPx = TURN_NAVIGATOR_MIN_WIDTH_PX
} = {}) {
    const win = doc.defaultView;
    const cleanups = [];
    let disposed = false;
    let mounted = false;
    let nav = null;
    let railScroll = null;
    let railInner = null;
    let card = null;
    let cardUser = null;
    let cardAssistant = null;
    let messages = messagesRoot;
    let scroller = scrollRoot;
    let entries = [];
    let items = [];
    let signature = '';
    let buttons = [];
    let activeKey;
    let interactionIndex;
    let cardIndex = -1;
    let openTimer = null;
    let closeTimer = null;
    let refreshTimer = null;
    let jumpSettleTimer = null;
    let frame = null;
    let reducedMotion = false;
    const textCache = new WeakMap();
    const dirty = new Set();

    const h = (tag, className) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        return node;
    };

    function activeIndex() {
        return items.findIndex(item => item.key === activeKey);
    }

    function applyVisuals() {
        const active = activeIndex();
        buttons.forEach((button, index) => {
            const item = items[index];
            const state = resolveBarVisualState({ itemIndex: index, visualFocusItemIndex: interactionIndex });
            const scrollActive = interactionIndex === undefined && index === active;
            const bar = button.firstChild;
            bar.style.opacity = String(scrollActive ? 0.9 : item.isRunning ? Math.max(state.opacity, 0.72) : state.opacity);
            bar.style.transform = `scaleX(${state.scaleX})`;
            bar.classList.toggle('is-strong', state.colorTone === 'focus' || scrollActive);
            button.dataset.visualTone = state.tone;
            button.dataset.visualScale = String(state.scaleX);
            button.dataset.active = index === active ? 'true' : 'false';
            button.dataset.running = item.isRunning ? 'true' : 'false';
            if (index === active) button.setAttribute('aria-current', 'location');
            else button.removeAttribute('aria-current');
        });
    }

    function setInteraction(index) {
        interactionIndex = index;
        applyVisuals();
    }

    // -------------------------------------------------------------- hover card

    function showCard(index) {
        const item = items[index];
        const button = buttons[index];
        if (!item || !button) return;
        cardIndex = index;
        cardUser.textContent = item.userPreview;
        cardAssistant.textContent = item.assistantPreview;
        cardAssistant.classList.toggle('is-muted', item.assistantPreviewKind !== 'text');
        const navRect = nav.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        card.style.top = `${Math.round(buttonRect.top - navRect.top + buttonRect.height / 2)}px`;
        card.hidden = false;
        card.dataset.key = item.key;
    }

    function hideCard() {
        cardIndex = -1;
        card.hidden = true;
    }

    function scheduleCard(index) {
        win.clearTimeout(closeTimer);
        closeTimer = null;
        if (!card.hidden) { // 已经开着：直接换成这一条，不再等待
            win.clearTimeout(openTimer);
            showCard(index);
            return;
        }
        win.clearTimeout(openTimer);
        openTimer = win.setTimeout(() => showCard(index), HOVER_OPEN_DELAY_MS);
    }

    function scheduleHideCard() {
        win.clearTimeout(openTimer);
        openTimer = null;
        win.clearTimeout(closeTimer);
        closeTimer = win.setTimeout(hideCard, HOVER_CLOSE_DELAY_MS);
    }

    // -------------------------------------------------------------- rendering

    function buildButtons() {
        railInner.textContent = '';
        buttons = items.map((item, index) => {
            const button = h('button', 'vcp-turn-nav-item');
            button.type = 'button';
            button.setAttribute('aria-label', `跳转到第 ${index + 1} 条提问`);
            button.setAttribute('aria-posinset', String(index + 1));
            button.setAttribute('aria-setsize', String(items.length));
            button.dataset.itemIndex = String(index);
            button.dataset.turnKey = item.key;
            button.appendChild(h('span', 'vcp-turn-nav-bar'));
            button.addEventListener('pointerenter', () => { setInteraction(index); scheduleCard(index); });
            button.addEventListener('pointerleave', () => { setInteraction(undefined); scheduleHideCard(); });
            button.addEventListener('focus', () => { setInteraction(index); scheduleCard(index); });
            button.addEventListener('blur', () => { setInteraction(undefined); scheduleHideCard(); });
            button.addEventListener('click', () => jumpTo(index, reducedMotion ? 'auto' : 'smooth'));
            railInner.appendChild(button);
            return button;
        });
        nav.dataset.itemCount = String(items.length);
    }

    function revealActiveBar() {
        const index = activeIndex();
        const button = buttons[index];
        if (!button || !railScroll.clientHeight) return;
        const top = button.offsetTop;
        const bottom = top + button.offsetHeight;
        if (top < railScroll.scrollTop) railScroll.scrollTop = top;
        else if (bottom > railScroll.scrollTop + railScroll.clientHeight) railScroll.scrollTop = bottom - railScroll.clientHeight;
    }

    function measureOverlay() {
        if (!nav || !scroller) return;
        nav.style.top = `${scroller.offsetTop}px`;
        nav.style.height = `${scroller.clientHeight}px`;
        const wide = scroller.clientWidth >= minWidthPx;
        nav.classList.toggle('is-wide', wide);
        if (!wide) hideCard();
    }

    function updateActive() {
        frame = null;
        if (disposed || !scroller) return;
        const scrollerTop = scroller.getBoundingClientRect().top;
        const positions = entries.map(entry => {
            const rect = entry.element.getBoundingClientRect();
            const start = rect.top - scrollerTop + scroller.scrollTop;
            return { key: String(entry.id), start, end: start + rect.height };
        });
        const next = resolveActiveTurnKey({
            positions,
            scrollOffsetPx: scroller.scrollTop,
            viewportHeightPx: scroller.clientHeight
        });
        if (next === activeKey) return;
        activeKey = next;
        applyVisuals();
        revealActiveBar();
    }

    function scheduleActiveUpdate() {
        if (frame !== null || disposed) return;
        frame = win.requestAnimationFrame(updateActive);
    }

    function refresh() {
        refreshTimer = null;
        if (disposed || !mounted) return;
        entries = collectTurnEntries(messages, { textCache, dirty });
        items = buildTurnNavigatorItems(entries);
        const nextSignature = items.map(item => item.key).join('|');
        const show = items.length >= 2;
        nav.hidden = !show;
        if (!show) {
            signature = '';
            buttons = [];
            railInner.textContent = '';
            hideCard();
            return;
        }
        if (nextSignature !== signature) {
            signature = nextSignature;
            buildButtons();
            if (!items.some(item => item.key === activeKey)) activeKey = undefined;
        }
        if (cardIndex >= 0 && items[cardIndex]) showCard(cardIndex); // 流式回答时悬停卡片里的摘要跟着更新
        else if (cardIndex >= 0) hideCard();
        measureOverlay();
        applyVisuals();
        updateActive();
    }

    function markDirty(records) {
        for (const record of records) {
            const node = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
            const item = node?.closest?.('.message-item');
            if (item) dirty.add(item);
        }
    }

    function onMutations(records) {
        markDirty(records);
        scheduleRefresh();
    }

    function scheduleRefresh() {
        if (disposed || refreshTimer !== null) return;
        refreshTimer = win.setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    }

    function jumpTargetTop(entry) {
        const scrollerTop = scroller.getBoundingClientRect().top;
        return Math.max(0, entry.element.getBoundingClientRect().top - scrollerTop + scroller.scrollTop - JUMP_TOP_MARGIN_PX);
    }

    /**
     * 长话题里（content-visibility: auto）滚动途中屏幕外的消息才渲染、高度变化，一次算出来的目标位置会过期；
     * 另外聊天区的「粘底跟随」会把跳转拽回底部（见 chat-scroll-release.js）。所以先放开跟随，滚完再校验几次。
     */
    function jumpTo(index, behavior, attempt = 0) {
        const entry = entries[index];
        if (!entry?.element || !scroller) return;
        win.clearTimeout(jumpSettleTimer);
        jumpSettleTimer = null;
        const top = jumpTargetTop(entry);
        const maxTop = scroller.scrollHeight - scroller.clientHeight;
        if (maxTop - top > JUMP_RELEASE_FOLLOW_MIN_PX) releaseChatBottomFollow(scroller);
        scroller.scrollTo({ top, behavior: attempt === 0 ? behavior : 'auto' });
        if (attempt >= JUMP_SETTLE_ATTEMPTS) return;
        jumpSettleTimer = win.setTimeout(() => {
            jumpSettleTimer = null;
            if (disposed || !entry.element?.isConnected) return;
            if (Math.abs(jumpTargetTop(entry) - scroller.scrollTop) > JUMP_SETTLE_TOLERANCE_PX) jumpTo(index, 'auto', attempt + 1);
        }, JUMP_SETTLE_MS);
    }

    // -------------------------------------------------------------- lifecycle

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    function mount() {
        if (mounted || disposed) return nav;
        messages = messages || doc.getElementById('chatMessages');
        scroller = scroller || messages?.closest('.chat-messages-container') || null;
        const host = scroller?.parentElement;
        if (!messages || !scroller || !host) return null;
        if (win.getComputedStyle(host).position === 'static') host.style.position = 'relative';

        nav = h('nav', 'vcp-turn-nav zc-scope');
        nav.setAttribute('aria-label', '提问目录');
        nav.hidden = true;
        railScroll = h('div', 'vcp-turn-nav-scroll');
        railInner = h('div', 'vcp-turn-nav-inner');
        railScroll.appendChild(railInner);
        card = h('div', 'vcp-turn-nav-card');
        card.hidden = true;
        card.setAttribute('role', 'tooltip');
        cardUser = h('p', 'vcp-turn-nav-card-user');
        cardAssistant = h('p', 'vcp-turn-nav-card-assistant');
        card.append(cardUser, cardAssistant);
        nav.append(railScroll, card);
        host.appendChild(nav);
        mounted = true;

        on(railScroll, 'pointerleave', () => setInteraction(undefined));
        on(railScroll, 'scroll', () => { setInteraction(undefined); hideCard(); });
        on(scroller, 'scroll', scheduleActiveUpdate, { passive: true });
        on(card, 'pointerenter', () => { win.clearTimeout(closeTimer); closeTimer = null; });
        on(card, 'pointerleave', scheduleHideCard);

        if (typeof win.MutationObserver === 'function') {
            const observer = new win.MutationObserver(onMutations);
            observer.observe(messages, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
            cleanups.push(() => observer.disconnect());
        }
        if (typeof win.ResizeObserver === 'function') {
            const resizeObserver = new win.ResizeObserver(() => { measureOverlay(); scheduleActiveUpdate(); });
            resizeObserver.observe(scroller);
            cleanups.push(() => resizeObserver.disconnect());
        }
        if (typeof win.matchMedia === 'function') {
            const query = win.matchMedia('(prefers-reduced-motion: reduce)');
            const update = () => { reducedMotion = query.matches; };
            update();
            query.addEventListener?.('change', update);
            cleanups.push(() => query.removeEventListener?.('change', update));
        }

        refresh();
        return nav;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        win.clearTimeout(openTimer);
        win.clearTimeout(closeTimer);
        win.clearTimeout(refreshTimer);
        win.clearTimeout(jumpSettleTimer);
        if (frame !== null) win.cancelAnimationFrame(frame);
        while (cleanups.length) cleanups.pop()();
        nav?.remove();
        nav = null;
    }

    return {
        mount,
        dispose,
        refresh: () => { win.clearTimeout(refreshTimer); refresh(); },
        jumpTo,
        getItems: () => items.slice()
    };
}
