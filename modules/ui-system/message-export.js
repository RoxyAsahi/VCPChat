/**
 * modules/ui-system/message-export.js
 * 「导出选中消息」：进入选择模式后，每条消息前出现复选框，点击消息即可勾选（Shift 连选一段），
 * 底部浮条里可以全选、复制 Markdown 或另存为 .md。
 *
 * 交互对照 ZCode 的 ConversationShareSelectionPanel / ConversationShareSelectionDock
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4/ 下的 ConversationShareSelection*）：
 * 选择阶段在对话上盖一层勾选态、输入区换成「已选 N / 共 M」的操作条，Esc 取消。
 * ZCode 的下一步是把选中的轮次发布成公开分享链接；VCPChat 没有分享服务，这里的落点是本地的
 * 剪贴板和 .md 文件（沿用已有的 export-topic-as-markdown 保存对话框）。
 * 正文优先取历史记录里的原始 Markdown（保留代码块、列表），取不到才退回渲染后的文本；思维链不导出。
 */

'use strict';

const SELECTABLE = '.message-item:not(.system):not(.thinking)';

const THOUGHT_CHAIN_PATTERNS = [
    /^[ \t]*\[--- VCP元思考链(?::\s*"[^"]*")?\s*---\][ \t]*\r?\n[\s\S]*?^[ \t]*\[--- 元思考链结束 ---\][ \t]*(?:\r?\n|$)/gm,
    /^[ \t]*<think(?:ing)?>[ \t]*\r?\n[\s\S]*?^[ \t]*<\/think(?:ing)?>[ \t]*(?:\r?\n|$)/gim,
    /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi
];

// ------------------------------------------------------------------ pure helpers

/** 去掉思维链（VCP 元思考链 / <think> 块）。 */
export function stripThoughtChains(text) {
    return THOUGHT_CHAIN_PATTERNS.reduce((result, pattern) => result.replace(pattern, ''), String(text ?? '')).trim();
}

/** 历史记录里的 content 可能是字符串，也可能是 [{type:'text', text}] 的分段数组。 */
export function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => (typeof part === 'string' ? part : part?.type === 'text' || typeof part?.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n');
    }
    if (content && typeof content.text === 'string') return content.text;
    return '';
}

function formatStamp(timestamp) {
    if (timestamp === null || timestamp === undefined || timestamp === '') return '';
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 选中的消息 → Markdown：话题标题、导出时间，每条消息一个三级标题（发送者 + 时间）。 */
export function buildMarkdown({ title, messages, exportedAt = Date.now() }) {
    const lines = [`# ${title || '聊天记录'}`, '', `> 导出时间：${formatStamp(exportedAt)}　共 ${messages.length} 条消息`, ''];
    for (const message of messages) {
        const stamp = formatStamp(message.timestamp);
        lines.push(`### ${message.sender || '消息'}${stamp ? ` · ${stamp}` : ''}`, '', message.content, '', '---', '');
    }
    return lines.join('\n').replace(/\n+---\n$/u, '\n');
}

/** 把 [from, to] 之间（含）的 id 都选上，用于 Shift 连选。 */
export function rangeBetween(ids, from, to) {
    const a = ids.indexOf(from);
    const b = ids.indexOf(to);
    if (a < 0 || b < 0) return [];
    return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// ------------------------------------------------------------------ controller

export function createMessageExport({
    document: doc = document,
    messagesRoot,
    getHistory = () => [],
    getTitle = () => '聊天记录',
    copyText = async (text) => navigator.clipboard.writeText(text),
    saveMarkdown = async () => ({ success: false, error: 'not available' }),
    notify = null
} = {}) {
    const win = doc.defaultView;
    let active = false;
    let dock = null;
    let countEl = null;
    let allBtn = null;
    let actionBtns = [];
    let observer = null;
    let lastClickedId = null;
    let disposed = false;
    const selected = new Set();
    const cleanups = [];

    const items = () => [...(messagesRoot?.querySelectorAll?.(SELECTABLE) || [])].filter(item => item.dataset.messageId);
    const idsInOrder = () => items().map(item => item.dataset.messageId);

    function h(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function decorate(item) {
        if (item.querySelector(':scope > .vcp-export-check')) return;
        const box = h('span', 'vcp-export-check');
        box.setAttribute('aria-hidden', 'true');
        item.prepend(box);
    }

    function paint() {
        for (const item of items()) {
            const on = selected.has(item.dataset.messageId);
            item.classList.toggle('vcp-export-selected', on);
            item.querySelector(':scope > .vcp-export-check')?.classList.toggle('checked', on);
        }
        const total = items().length;
        if (!dock) return;
        countEl.textContent = `已选 ${selected.size} / 共 ${total} 条`;
        allBtn.textContent = total > 0 && selected.size === total ? '取消全选' : '全选';
        actionBtns.forEach(button => { button.disabled = selected.size === 0; });
    }

    function toggle(id, force) {
        const next = force ?? !selected.has(id);
        if (next) selected.add(id); else selected.delete(id);
    }

    function onMessageClick(event) {
        if (!active) return;
        const item = event.target.closest?.(SELECTABLE);
        if (!item || !messagesRoot.contains(item) || !item.dataset.messageId) return;
        event.preventDefault();
        event.stopPropagation();
        const id = item.dataset.messageId;
        if (event.shiftKey && lastClickedId && lastClickedId !== id) {
            const turnOn = !selected.has(id);
            rangeBetween(idsInOrder(), lastClickedId, id).forEach(rangeId => toggle(rangeId, turnOn));
        } else {
            toggle(id);
        }
        lastClickedId = id;
        paint();
    }

    function onKeydown(event) {
        if (active && event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            cancel();
        }
    }

    function onAllClick() {
        const ids = idsInOrder();
        if (ids.length > 0 && selected.size === ids.length) selected.clear();
        else ids.forEach(id => selected.add(id));
        paint();
    }

    /** 选中的消息按对话顺序整理成 {sender, timestamp, content}。 */
    function collect() {
        const history = getHistory() || [];
        const byId = new Map(history.map(message => [message?.id, message]));
        const result = [];
        for (const item of items()) {
            const id = item.dataset.messageId;
            if (!selected.has(id)) continue;
            const record = byId.get(id);
            let content = stripThoughtChains(contentToText(record?.content));
            if (!content) {
                const body = item.querySelector('.md-content');
                if (body) {
                    const clone = body.cloneNode(true);
                    clone.querySelectorAll('.vcp-thought-chain-bubble').forEach(node => node.remove());
                    content = stripThoughtChains(clone.innerText || clone.textContent || '');
                }
            }
            if (!content) continue;
            const sender = item.querySelector('.sender-name')?.textContent?.replace(/[:：]\s*$/u, '').trim()
                || (item.classList.contains('user') ? '用户' : '助手');
            result.push({ sender, timestamp: record?.timestamp ?? (Number(item.dataset.timestamp) || null), content });
        }
        return result;
    }

    async function copy() {
        const messages = collect();
        if (messages.length === 0) return notify?.('选中的消息里没有可导出的文字', 'warning');
        try {
            await copyText(buildMarkdown({ title: getTitle(), messages }));
            notify?.(`已复制 ${messages.length} 条消息的 Markdown`, 'success');
            cancel();
        } catch (error) {
            console.error('[MessageExport] copy failed:', error);
            notify?.(`复制失败：${error?.message || error}`, 'error');
        }
    }

    async function save() {
        const messages = collect();
        if (messages.length === 0) return notify?.('选中的消息里没有可导出的文字', 'warning');
        try {
            const title = getTitle();
            const result = await saveMarkdown({ topicName: title || '聊天记录', markdownContent: buildMarkdown({ title, messages }) });
            if (result?.success) {
                notify?.(`已导出 ${messages.length} 条消息到：${result.path}`, 'success');
                cancel();
            } else if (result?.error && !/取消/u.test(result.error)) {
                notify?.(`导出失败：${result.error}`, 'error');
            }
        } catch (error) {
            console.error('[MessageExport] save failed:', error);
            notify?.(`导出失败：${error?.message || error}`, 'error');
        }
    }

    function buildDock() {
        dock = h('div', 'vcp-export-dock vcp-ui-scope');
        dock.setAttribute('role', 'toolbar');
        dock.setAttribute('aria-label', '导出选中消息');
        dock.hidden = true;
        countEl = h('span', 'vcp-export-count');
        allBtn = h('button', 'vcp-export-btn', '全选');
        const copyBtn = h('button', 'vcp-export-btn vcp-export-primary', '复制 Markdown');
        const saveBtn = h('button', 'vcp-export-btn vcp-export-primary', '保存为 .md');
        const cancelBtn = h('button', 'vcp-export-btn', '取消');
        [allBtn, copyBtn, saveBtn, cancelBtn].forEach(button => { button.type = 'button'; });
        actionBtns = [copyBtn, saveBtn];
        allBtn.addEventListener('click', onAllClick);
        copyBtn.addEventListener('click', copy);
        saveBtn.addEventListener('click', save);
        cancelBtn.addEventListener('click', () => cancel());
        dock.append(countEl, allBtn, copyBtn, saveBtn, cancelBtn);
        doc.body.appendChild(dock);
    }

    /** 操作条停在输入卡片正上方，不盖住输入框；找不到输入卡片时用 CSS 里的默认位置。 */
    function place() {
        const anchor = doc.querySelector('.chat-input-card');
        if (!dock || !anchor) return;
        const rect = anchor.getBoundingClientRect();
        if (!rect.width) return;
        dock.style.left = `${rect.left + rect.width / 2}px`;
        dock.style.bottom = `${Math.max(8, win.innerHeight - rect.top + 10)}px`;
    }

    function start() {
        if (disposed || active || !messagesRoot) return false;
        if (items().length === 0) {
            notify?.('当前话题没有可导出的消息', 'info');
            return false;
        }
        active = true;
        selected.clear();
        lastClickedId = null;
        messagesRoot.classList.add('vcp-export-mode');
        items().forEach(decorate);
        dock.hidden = false;
        place();
        observer = new win.MutationObserver(() => {
            items().forEach(decorate);
            paint();
        });
        observer.observe(messagesRoot, { childList: true });
        paint();
        return true;
    }

    function cancel() {
        if (!active) return;
        active = false;
        observer?.disconnect();
        observer = null;
        selected.clear();
        messagesRoot.classList.remove('vcp-export-mode');
        messagesRoot.querySelectorAll('.vcp-export-selected').forEach(item => item.classList.remove('vcp-export-selected'));
        messagesRoot.querySelectorAll('.vcp-export-check').forEach(node => node.remove());
        if (dock) dock.hidden = true;
    }

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
    }

    function mount() {
        if (dock || disposed || !messagesRoot || !doc.body) return null;
        buildDock();
        on(messagesRoot, 'click', onMessageClick, true);
        on(win, 'keydown', onKeydown, true);
        on(win, 'resize', () => { if (active) place(); });
        return dock;
    }

    function dispose() {
        if (disposed) return;
        cancel();
        disposed = true;
        cleanups.splice(0).forEach(fn => fn());
        dock?.remove();
        dock = null;
    }

    return {
        mount,
        dispose,
        start,
        cancel,
        toggle: () => (active ? cancel() : start()),
        getState: () => ({ active, selected: [...selected] })
    };
}
