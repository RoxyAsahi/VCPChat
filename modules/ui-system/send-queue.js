/**
 * modules/ui-system/send-queue.js
 * 回复还在输出时，Enter 不再直接发出第二条，而是把草稿排进「待发送消息」队列，
 * 这一轮结束后按顺序自动发送；队列可以拖拽排序、退回输入框编辑、删除、「立即」发送（先中止当前回复）。
 *
 * 行为对照 ZCode 的 ConversationQueuePanel
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4/ConversationQueuePanel.tsx）：
 * 拖拽排序锚点算法照搬 resolveV4QueueReorderAnchor；用户手动中止回复后队列暂停并显示「继续」横幅；
 * 排队的消息发不出去（发送抛错，或一直没有进入输出状态）同样暂停并放回队首，内容不丢。
 * ZCode 的队列在 CLI 里，这里是纯渲染端：只观察发送按钮的 data-mode（mainChatSendOwner 维护，
 * "interrupt" 表示有回复在输出），自动发送走 chatManager.handleSendMessage(文本)。
 * 队列按「Agent/群组 + 话题」分开保存，只在当前话题空闲时自动发送；切走话题时原话题的队列会暂停。
 * 只排纯文本草稿：带附件的草稿仍走原来的发送流程。
 * 队列写进 localStorage：重启 / 刷新后恢复，恢复出来的队列一律处于暂停状态，由用户确认后点「继续」，
 * 避免上次没发完的话在下次打开时被悄悄发出去。
 */

'use strict';

const DEFAULT_DRAIN_DELAY_MS = 250;
const DEFAULT_START_TIMEOUT_MS = 2500;
export const STORAGE_KEY = 'vcp.ui.sendQueue.v1';
const MAX_PERSISTED_ITEMS = 50;

const ICON_GRIP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g fill="currentColor"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></g></svg>';
const ICON_SEND_NOW = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4M3 14h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 13.5l.6-3L10.7 3a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2l-7.6 7.6-2.9.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5M7 7v4M9 7v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const PAUSE_MESSAGES = {
    stopped: '由于你中断了当前响应，队列已暂停',
    error: '由于当前响应出错，队列已暂停（内容未丢失）',
    switched: '已切换话题，该话题的队列已暂停',
    restored: '已恢复上次没有发出的消息，确认后点「继续」发送',
    pending: '正在等待发送确认，消息仍保留；确认前不会重试',
    generic: '队列已暂停'
};

function defaultStorage(doc) {
    try { return doc.defaultView?.localStorage ?? null; } catch (_error) { return null; }
}

// ------------------------------------------------------------------ pure helpers

/** 拖拽排序锚点（照搬 ZCode resolveV4QueueReorderAnchor）：返回要移动的项和它应排在谁前面（null = 队尾）。 */
export function resolveReorderAnchor(items, activeId, overId) {
    if (activeId === overId) return null;
    const fromIndex = items.findIndex(item => item.id === activeId);
    const overIndex = items.findIndex(item => item.id === overId);
    if (fromIndex < 0 || overIndex < 0) return null;
    if (fromIndex < overIndex) {
        const rest = items.filter(item => item.id !== activeId);
        const overInRest = rest.findIndex(item => item.id === overId);
        return { id: activeId, beforeId: rest[overInRest + 1]?.id ?? null };
    }
    return { id: activeId, beforeId: overId };
}

/** 把 id 项移到 beforeId 之前（null = 队尾），返回新数组；找不到时原样返回。 */
export function moveQueueItem(items, id, beforeId) {
    const moving = items.find(item => item.id === id);
    if (!moving) return items;
    const rest = items.filter(item => item.id !== id);
    const index = beforeId === null ? rest.length : rest.findIndex(item => item.id === beforeId);
    if (index < 0) return items;
    return [...rest.slice(0, index), moving, ...rest.slice(index)];
}

// ------------------------------------------------------------------ controller

export function createSendQueue({
    document: doc = document,
    sendButton = doc.getElementById('sendMessageBtn'),
    getInput = () => doc.getElementById('messageInput'),
    getContext = () => null,
    hasAttachments = () => false,
    sendText = async () => {},
    notify = null,
    drainDelayMs = DEFAULT_DRAIN_DELAY_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    storage = defaultStorage(doc)
} = {}) {
    const win = doc.defaultView;
    const queues = new Map(); // key -> { items: [{ id, text }], paused: false|reason }
    let panel = null;
    let modeObserver = null;
    let drainTimer = null;
    let startTimer = null;
    let awaitingStart = false;
    let dispatch = null;
    let sawBusy = false;
    let internalStop = false;
    let dragId = null;
    let lastKey = null;
    let sequence = 0;
    let disposed = false;
    const cleanups = [];

    const isBusy = () => sendButton?.dataset.mode === 'interrupt';
    const currentKey = () => getContext?.()?.key || null;
    const getQueue = key => {
        if (!queues.has(key)) queues.set(key, { items: [], paused: false });
        return queues.get(key);
    };

    // -------- persistence
    function persist() {
        if (!storage) return;
        try {
            const data = {};
            for (const [key, queue] of queues) {
                if (queue.items.length) data[key] = queue.items.map(({ id, text }) => ({ id, text }));
            }
            if (Object.keys(data).length) storage.setItem(STORAGE_KEY, JSON.stringify(data));
            else storage.removeItem(STORAGE_KEY);
        } catch (_error) { /* 存储不可用或已满：队列退化为只在内存里 */ }
    }

    function restore() {
        if (!storage) return;
        try {
            const data = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
            if (!data || typeof data !== 'object') return;
            for (const [key, entries] of Object.entries(data)) {
                if (!Array.isArray(entries) || queues.has(key)) continue;
                const items = entries
                    .filter(entry => entry && typeof entry.text === 'string' && entry.text.trim())
                    .map(entry => ({ id: typeof entry.id === 'string' ? entry.id : `q${(sequence += 1)}r`, text: entry.text }));
                if (items.length) queues.set(key, { items, paused: 'restored' });
            }
        } catch (_error) { /* 数据损坏：忽略 */ }
    }

    // -------- rendering
    function h(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function iconButton(className, label, icon, onClick) {
        const button = h('button', `vcp-queue-btn ${className}`);
        button.type = 'button';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.innerHTML = icon;
        button.addEventListener('click', onClick);
        return button;
    }

    function render() {
        if (disposed) return;
        persist(); // 所有队列变更之后都会走到 render，在这里统一落盘
        if (!panel) return;
        const key = currentKey();
        const queue = key ? queues.get(key) : null;
        if (!queue || queue.items.length === 0) {
            panel.hidden = true;
            panel.textContent = '';
            return;
        }
        panel.hidden = false;
        panel.textContent = '';
        panel.dataset.queueCount = String(queue.items.length);
        panel.dataset.paused = queue.paused ? 'true' : 'false';

        if (queue.paused) {
            const banner = h('div', 'vcp-queue-banner');
            banner.append(h('span', 'vcp-queue-banner-text', PAUSE_MESSAGES[queue.paused] || PAUSE_MESSAGES.generic));
            const resume = h('button', 'vcp-queue-resume', '继续');
            resume.type = 'button';
            resume.title = '继续按顺序自动发送队列中的内容';
            resume.addEventListener('click', () => resumeQueue());
            banner.append(resume);
            panel.append(banner);
        } else {
            panel.append(h('div', 'vcp-queue-title', `待发送消息（${queue.items.length}）`));
        }

        const list = h('ul', 'vcp-queue-list');
        for (const item of queue.items) {
            const row = h('li', 'vcp-queue-item');
            row.dataset.queueItemId = item.id;
            row.draggable = true;
            row.addEventListener('dragstart', (event) => {
                dragId = item.id;
                row.classList.add('dragging');
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'move';
                    try { event.dataTransfer.setData('text/plain', item.id); } catch (_error) { /* 部分环境不允许 */ }
                }
            });
            row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); });
            row.addEventListener('dragover', (event) => { if (dragId) event.preventDefault(); });
            row.addEventListener('drop', (event) => {
                event.preventDefault();
                const active = dragId;
                dragId = null;
                if (active) reorder(active, item.id);
            });

            const grip = h('span', 'vcp-queue-grip');
            grip.title = '拖拽排序';
            grip.innerHTML = ICON_GRIP;
            const text = h('span', 'vcp-queue-text', item.text);
            text.title = item.text;
            const sendNowBtn = h('button', 'vcp-queue-send-now');
            sendNowBtn.type = 'button';
            sendNowBtn.title = '中止当前回复并立即发送这一条';
            sendNowBtn.innerHTML = `${ICON_SEND_NOW}<span>立即</span>`;
            sendNowBtn.addEventListener('click', () => sendNow(item.id));
            row.append(
                grip,
                text,
                sendNowBtn,
                iconButton('vcp-queue-edit', '编辑', ICON_EDIT, () => editItem(item.id)),
                iconButton('vcp-queue-remove', '移除待发送消息', ICON_REMOVE, () => removeItem(item.id))
            );
            list.append(row);
        }
        panel.append(list);
    }

    // -------- queue operations
    function enqueue(text) {
        const key = currentKey();
        if (!key) return false;
        const queue = getQueue(key);
        if (typeof text !== 'string' || !text.trim()) return false;
        if (queue.items.length >= MAX_PERSISTED_ITEMS) { notify?.('队列最多保留 50 条，请先发送或移除一些消息。', 'warning'); return false; }
        queue.items.push({ id: `q${Date.now().toString(36)}${(sequence += 1)}`, text });
        render();
        return true;
    }

    function removeItem(id) {
        const queue = queues.get(currentKey());
        if (!queue || dispatch?.item.id === id) return false;
        const before = queue.items.length;
        queue.items = queue.items.filter(item => item.id !== id);
        if (queue.items.length === 0) queue.paused = false;
        render();
        return queue.items.length !== before;
    }

    function reorder(activeId, overId) {
        const queue = queues.get(currentKey());
        if (!queue) return false;
        const anchor = resolveReorderAnchor(queue.items, activeId, overId);
        if (!anchor) return false;
        queue.items = moveQueueItem(queue.items, anchor.id, anchor.beforeId);
        render();
        return true;
    }

    /** 退回输入框编辑：草稿非空时不覆盖，提示先处理草稿。 */
    function editItem(id) {
        const queue = queues.get(currentKey());
        const input = getInput?.();
        const item = queue?.items.find(entry => entry.id === id);
        if (!item || !input || dispatch?.item.id === id) return false;
        if (input.value.trim()) {
            notify?.('请先发送或清空当前草稿，再编辑队列消息。', 'warning');
            return false;
        }
        removeItem(id);
        input.value = item.text;
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
        input.focus();
        input.setSelectionRange?.(input.value.length, input.value.length);
        return true;
    }

    function pauseQueue(key, reason) {
        const queue = queues.get(key);
        if (!queue || queue.items.length === 0) return;
        queue.paused = reason;
        if (key === currentKey()) render();
    }

    function resumeQueue() {
        const key = currentKey();
        const queue = key ? queues.get(key) : null;
        if (!queue || dispatch) return false;
        queue.paused = false;
        render();
        if (!isBusy()) scheduleDrain(0);
        return true;
    }

    function sendNow(id) {
        const key = currentKey();
        const queue = key ? queues.get(key) : null;
        if (!queue || dispatch || !queue.items.some(item => item.id === id)) return false;
        queue.items = moveQueueItem(queue.items, id, queue.items[0].id);
        queue.paused = false;
        render();
        if (isBusy()) {
            // 先中止当前回复；回复一结束，按钮回到 send 模式，drain 会发出队首（也就是这一条）
            internalStop = true;
            try { sendButton.click(); } finally { internalStop = false; }
        } else {
            scheduleDrain(0);
        }
        return true;
    }

    // -------- draining
    function scheduleDrain(delay = drainDelayMs) {
        win.clearTimeout(drainTimer);
        drainTimer = win.setTimeout(drain, delay);
    }

    async function drain() {
        drainTimer = null;
        if (disposed || dispatch || awaitingStart || isBusy()) return;
        const key = currentKey();
        const queue = key ? queues.get(key) : null;
        if (!queue || queue.paused || queue.items.length === 0) return;
        const item = queue.items[0];
        const current = {key, item, accepted: false};
        dispatch = current;
        awaitingStart = true;
        render(); // Persist the pending item before admission; a reload restores it paused.
        const accept = () => {
            if (dispatch !== current || current.accepted) return;
            current.accepted = true;
            queue.items = queue.items.filter(entry => entry.id !== item.id);
            if (queue.paused === 'pending') queue.paused = false;
            awaitingStart = false;
            win.clearTimeout(startTimer);startTimer = null;
            render();
        };
        startTimer = win.setTimeout(() => {
            if (dispatch !== current || current.accepted) return;
            queue.paused = 'pending';render();
        }, startTimeoutMs);
        try {
            await sendText(item.text, {id: item.id, key, onAccepted: accept});
            if (!current.accepted) failDispatch(key);
        } catch (error) {
            console.warn('[SendQueue] queued message failed to send:', error);
            // An accepted message is already durable; later model errors cannot requeue it.
            if (!current.accepted) failDispatch(key);
        } finally {
            if (dispatch === current) dispatch = null;
            awaitingStart = false;
            win.clearTimeout(startTimer);startTimer = null;
            render();
            if (!disposed && currentKey() === key && !isBusy()) scheduleDrain();
        }
    }

    function failDispatch(key) {
        const queue = getQueue(key);
        queue.paused = 'error';
        render();
    }

    function onModeChange() {
        if (disposed || dispatch) return;
        if (!isBusy()) scheduleDrain();
    }

    // -------- events
    function onInputKeydown(event) {
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
        if (!isBusy() || hasAttachments()) return;
        const input = event.currentTarget;
        const text = String(input.value || '').trim();
        if (!text || !currentKey()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!enqueue(text)) return;
        input.value = '';
        input.dispatchEvent(new win.Event('input', { bubbles: true }));
    }

    function onSendButtonClickCapture() {
        // 用户自己点「中止回复」：队列暂停，免得马上又发出下一条
        if (internalStop || !isBusy()) return;
        pauseQueue(currentKey(), 'stopped');
    }

    /** 当前 Agent / 话题变化：把离开的话题的队列暂停，并刷新面板。 */
    function refresh() {
        if (disposed) return;
        const key = currentKey();
        if (lastKey && lastKey !== key) pauseQueue(lastKey, 'switched');
        lastKey = key;
        render();
        if (key && !isBusy()) scheduleDrain();
    }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    function mount() {
        if (panel || disposed) return panel;
        const input = getInput?.();
        const footer = input?.closest('.chat-input-area');
        const card = footer?.querySelector('.chat-input-card');
        if (!input || !footer || !card || !sendButton) return null;
        panel = h('div', 'vcp-queue-panel');
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', '待发送消息队列');
        panel.hidden = true;
        footer.insertBefore(panel, card);
        lastKey = currentKey();
        restore();
        render();

        on(input, 'keydown', onInputKeydown, true);
        on(sendButton, 'click', onSendButtonClickCapture, true);
        if (typeof win.MutationObserver === 'function') {
            modeObserver = new win.MutationObserver(onModeChange);
            modeObserver.observe(sendButton, { attributes: true, attributeFilter: ['data-mode'], attributeOldValue: true });
        }
        return panel;
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        win.clearTimeout(drainTimer);
        win.clearTimeout(startTimer);
        modeObserver?.disconnect();
        modeObserver = null;
        cleanups.splice(0).forEach(fn => fn());
        panel?.remove();
        panel = null;
        queues.clear();
    }

    return {
        mount,
        dispose,
        refresh,
        enqueue,
        removeItem,
        reorder,
        editItem,
        sendNow,
        resume: resumeQueue,
        getState: () => {
            const key = currentKey();
            const queue = key ? queues.get(key) : null;
            return { items: queue ? queue.items.map(item => item.text) : [], paused: queue?.paused || false, awaitingStart };
        }
    };
}
