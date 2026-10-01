/**
 * modules/ui-system/message-meta-enhancer.js
 * 给主聊天的消息头补两类信息：助手回答的「用时」（流式开始到结束用了多久，刷新后仍保留），以及按 ZCode 规则缩短的消息时间。
 *
 * 文案规则对照 ZCode 的 formatConversationWorkDuration
 * （https://github.com/zai-org/ZCode ，Apache-2.0，packages/ui/src/v4/conversationWorkDuration.ts）：
 * 最多显示两段（天/时/分/秒），不足 1 秒按 1 秒算。
 * 只观察消息 DOM（.message-item.assistant 的 streaming 类），不改动渲染和流式管线；
 * 时长按消息 id 存在 localStorage 里，历史消息重新渲染时从那里补回。
 * 时间标签对照 messageTimeLabel.ts：今天只显示时间，昨天带「昨天」，今年显示 月/日 时间，更早显示完整日期；完整时间放进 title。
 */

'use strict';

const STORAGE_KEY = 'vcp-turn-durations';
const STORAGE_LIMIT = 3000;

// ------------------------------------------------------------------ pure helpers

/** 毫秒 → 「2 分 05 秒」式文案；未知时长返回 null。 */
export function formatWorkDuration(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;
    const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days > 0) parts.push(`${days} 天`);
    if (hours > 0) parts.push(`${hours} 时`);
    if (minutes > 0) parts.push(`${minutes} 分`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
    return parts.slice(0, 2).join(' ');
}

const TIME_LABEL_CACHE_LIMIT = 4000;
const timeLabelCache = new Map();
const formatterCache = new Map();

function getFormatter(kind) {
    let formatter = formatterCache.get(kind);
    if (!formatter) {
        const base = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        const options = kind === 'time' ? base
            : kind === 'monthDayTime' ? { month: 'numeric', day: 'numeric', ...base }
                : { year: 'numeric', month: 'numeric', day: 'numeric', ...base };
        formatter = new Intl.DateTimeFormat('zh-CN', options);
        formatterCache.set(kind, formatter);
    }
    return formatter;
}

function isSameDay(left, right) {
    return left.getFullYear() === right.getFullYear()
        && left.getMonth() === right.getMonth()
        && left.getDate() === right.getDate();
}

/**
 * 消息时间标签，规则对照 ZCode 的 formatMessageTimeLabel（messageTimeLabel.ts）：
 * 今天只显示时间，昨天带「昨天」，今年显示 月/日 时间，更早显示完整年月日。
 */
export function formatMessageTimeLabel(timestamp, nowTimestamp = Date.now()) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    const messageDate = new Date(timestamp);
    const now = new Date(nowTimestamp);
    if (Number.isNaN(messageDate.getTime()) || Number.isNaN(now.getTime())) return null;

    const cacheKey = `${timestamp}:${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    const cached = timeLabelCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let label;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (isSameDay(messageDate, now)) label = getFormatter('time').format(messageDate);
    else if (isSameDay(messageDate, yesterday)) label = `昨天 ${getFormatter('time').format(messageDate)}`;
    else if (messageDate.getFullYear() === now.getFullYear()) label = getFormatter('monthDayTime').format(messageDate);
    else label = getFormatter('yearMonthDayTime').format(messageDate);

    if (timeLabelCache.size >= TIME_LABEL_CACHE_LIMIT) timeLabelCache.clear();
    timeLabelCache.set(cacheKey, label);
    return label;
}

/** 解析 `YYYY-MM-DD HH:mm` 形式的完整时间（formatMessageTimestamp 的输出）。 */
export function parseFullTimestampText(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/u.exec(String(text || '').trim());
    if (!match) return null;
    const [year, month, day, hours, minutes] = match.slice(1).map(Number);
    return new Date(year, month - 1, day, hours, minutes).getTime();
}

function formatFullTitle(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function hasClass(value, name) {
    return typeof value === 'string' && value.split(/\s+/u).includes(name);
}

export function createDurationStore(storage) {
    let cache = null;
    const load = () => {
        if (cache) return cache;
        try {
            const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}');
            cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_error) {
            cache = {};
        }
        return cache;
    };
    return {
        get(id) {
            const value = load()[id];
            return Number.isFinite(value) ? value : undefined;
        },
        set(id, durationMs) {
            const map = load();
            delete map[id]; // 重新插入到最后，淘汰时保留最近的
            map[id] = Math.round(durationMs);
            const keys = Object.keys(map);
            for (const key of keys.slice(0, Math.max(0, keys.length - STORAGE_LIMIT))) delete map[key];
            try { storage?.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (_error) { /* 配额满了就只保留内存里的 */ }
        }
    };
}

// ------------------------------------------------------------------ controller

export function createMessageMetaEnhancer({
    document: doc = document,
    messagesRoot = null,
    storage = (() => { try { return doc.defaultView?.localStorage || null; } catch (_error) { return null; } })(),
    now = () => Date.now()
} = {}) {
    const win = doc.defaultView;
    const durations = createDurationStore(storage);
    const startedAt = new WeakMap();
    let observer = null;
    let disposed = false;

    function applyDurationLabel(item, durationMs) {
        const text = formatWorkDuration(durationMs);
        const block = item.querySelector('.name-time-block');
        if (!text || !block) return;
        let label = block.querySelector('.message-duration');
        if (!label) {
            label = doc.createElement('div');
            label.className = 'message-duration';
            block.appendChild(label);
        }
        label.textContent = `用时 ${text}`;
        label.title = '本轮回答从开始到结束所用的时间';
    }

    /** 把 .message-timestamp 里的完整时间换成短标签，完整时间留在 title 里。 */
    function relabelTimestamp(stampEl) {
        if (!stampEl || stampEl.dataset.timeLabeled === 'true') return;
        const item = stampEl.closest('.message-item');
        const fullText = stampEl.textContent.trim();
        let timestamp = Number(item?.dataset.timestamp);
        if (!Number.isFinite(timestamp) || timestamp <= 0) timestamp = parseFullTimestampText(fullText);
        const label = formatMessageTimeLabel(timestamp, now());
        if (!label) return;
        stampEl.dataset.timeLabeled = 'true';
        stampEl.title = parseFullTimestampText(fullText) ? fullText : (formatFullTitle(timestamp) || fullText);
        stampEl.textContent = label;
    }

    function adopt(item) {
        item.querySelectorAll?.('.message-timestamp').forEach(relabelTimestamp);
        if (!item.classList?.contains('assistant') || !item.classList.contains('message-item')) return;
        if (item.classList.contains('streaming')) {
            if (!startedAt.has(item)) startedAt.set(item, now());
            return;
        }
        const id = item.dataset.messageId;
        const stored = id ? durations.get(id) : undefined;
        if (stored !== undefined) applyDurationLabel(item, stored);
    }

    function finish(item) {
        const start = startedAt.get(item);
        if (start === undefined) return;
        startedAt.delete(item);
        const durationMs = now() - start;
        const id = item.dataset.messageId;
        if (id) durations.set(id, durationMs);
        applyDurationLabel(item, durationMs);
    }

    function onMutations(records) {
        for (const record of records) {
            if (record.type === 'attributes') {
                const item = record.target;
                if (!item.classList?.contains('assistant')) continue;
                const was = hasClass(record.oldValue, 'streaming');
                const is = item.classList.contains('streaming');
                if (!was && is && !startedAt.has(item)) startedAt.set(item, now());
                else if (was && !is) finish(item);
                continue;
            }
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.classList.contains('message-timestamp')) relabelTimestamp(node);
                else if (node.classList.contains('message-item')) adopt(node);
                else node.querySelectorAll?.('.message-item').forEach(adopt);
            }
        }
    }

    function mount() {
        messagesRoot = messagesRoot || doc.getElementById('chatMessages');
        if (!messagesRoot || observer || disposed || typeof win?.MutationObserver !== 'function') return null;
        observer = new win.MutationObserver(onMutations);
        observer.observe(messagesRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
            attributeOldValue: true
        });
        messagesRoot.querySelectorAll('.message-item').forEach(adopt);
        return observer;
    }

    function dispose() {
        disposed = true;
        observer?.disconnect();
        observer = null;
    }

    return { mount, dispose };
}
