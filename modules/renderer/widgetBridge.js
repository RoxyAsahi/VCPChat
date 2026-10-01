// modules/renderer/widgetBridge.js
// 给聊天气泡里的 HTML 预览（sandbox iframe）提供一个很小的宿主接口 window.vcp：
//   vcp.widgetState                     上次保存的组件状态（JSON 值，没有则为 null）
//   vcp.setWidgetState(next)            保存状态；同一条消息里的同一段 HTML 下次预览时会带回来
//   vcp.sendFollowUpMessage(text)       让用户「说」一句话（走主聊天发送，逐次经宿主确认）
//   vcp.globals                         { theme: 'light'|'dark', locale }
//   vcp.onGlobals(callback)             主题等全局值变化时回调，同时会在 window 上触发 'vcp:set_globals' 事件
// 组件仍然运行在 opaque origin 的 sandbox 里，所有能力都经 postMessage 交给宿主校验。

export const WIDGET_CHANNEL = 'vcp-widget';
export const MAX_STATE_CHARS = 64 * 1024;
export const MAX_FOLLOW_UP_CHARS = 2000;
export const MAX_FOLLOW_UPS_PER_MOUNT = 20;
export const FOLLOW_UP_MIN_INTERVAL_MS = 1500;
export const FOLLOW_UP_PREFIX = '[[组件消息:';
export const FOLLOW_UP_SUFFIX = ']]';

/** djb2，足够区分同一条消息里的不同 HTML 段；不用于安全用途。 */
export function hashText(text) {
    let hash = 5381;
    const source = String(text || '');
    for (let i = 0; i < source.length; i += 1) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
}

export function widgetStateKey(messageId, html) {
    return messageId ? `vcp-widget-state:${messageId}:${hashText(html)}` : null;
}

function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** 注入到 iframe <head> 里的脚本，先于组件自己的脚本执行。 */
export function buildBridgeScript({ frameId, state = null, globals = {} }) {
    return `(function () {
    var FRAME_ID = ${safeJson(frameId)};
    var CHANNEL = ${safeJson(WIDGET_CHANNEL)};
    var listeners = [];
    var vcp = {
        widgetState: ${safeJson(state)},
        globals: ${safeJson(globals)},
        setWidgetState: function (next) {
            var text = JSON.stringify(next === undefined ? null : next);
            if (text.length > ${MAX_STATE_CHARS}) throw new Error('widget state is too large');
            vcp.widgetState = JSON.parse(text);
            parent.postMessage({ type: CHANNEL, frameId: FRAME_ID, action: 'set-state', state: vcp.widgetState }, '*');
        },
        sendFollowUpMessage: function (text) {
            var value = String(text == null ? '' : text);
            if (!value.trim()) return false;
            parent.postMessage({ type: CHANNEL, frameId: FRAME_ID, action: 'follow-up', text: value }, '*');
            return true;
        },
        onGlobals: function (callback) {
            if (typeof callback === 'function') listeners.push(callback);
        }
    };
    window.addEventListener('message', function (event) {
        var data = event.data;
        if (event.source !== parent || !data || data.type !== CHANNEL + ':globals' || data.frameId !== FRAME_ID) return;
        vcp.globals = data.globals || {};
        listeners.forEach(function (fn) { try { fn(vcp.globals); } catch (e) { console.error(e); } });
        window.dispatchEvent(new CustomEvent('vcp:set_globals', { detail: vcp.globals }));
    });
    Object.defineProperty(window, 'vcp', { value: vcp, configurable: false, writable: false });
})();`;
}

/**
 * 宿主一侧：校验来自 iframe 的消息并执行。
 *  - handle(event)：是本通道的消息则处理并返回 true，否则返回 false（交给别的处理器）。
 *  - pushGlobals(globals)：把主题等值推给 iframe。
 */
export function createWidgetChannel({
    frame,
    frameId,
    storage = null,
    storageKey = null,
    sendMessage = null,
    now = () => Date.now(),
    requestConfirmation = null,
    isCurrent = () => true,
    onRejected = null
}) {
    let followUps = 0;
    let lastFollowUpAt = -Infinity;
    let disposed = false;
    let confirming = false;

    const reject = reason => { try { onRejected?.(reason); } catch (_e) { /* ignore */ } };

    function loadState() {
        if (!storage || !storageKey) return null;
        try {
            const raw = storage.getItem(storageKey);
            return raw ? JSON.parse(raw) : null;
        } catch (_e) {
            return null;
        }
    }

    function saveState(state) {
        if (!storage || !storageKey) return;
        const text = JSON.stringify(state === undefined ? null : state);
        if (typeof text !== 'string' || text.length > MAX_STATE_CHARS) return reject('state-too-large');
        try {
            if (state === null) storage.removeItem(storageKey);
            else storage.setItem(storageKey, text);
        } catch (_e) { /* 配额满了就放弃持久化，组件本身仍可用 */ }
    }

    async function followUp(text) {
        if (frame?.isConnected === false || !isCurrent()) return reject('conversation-changed');
        if (typeof text !== 'string') return reject('invalid-follow-up');
        const trimmed = text.trim();
        if (!trimmed) return reject('empty-follow-up');
        if (trimmed.length > MAX_FOLLOW_UP_CHARS) return reject('follow-up-too-long');
        if (typeof sendMessage !== 'function') return reject('no-sender');
        if (typeof requestConfirmation !== 'function') return reject('no-host-confirmation');
        if (confirming) return reject('confirmation-pending');
        if (followUps >= MAX_FOLLOW_UPS_PER_MOUNT) return reject('follow-up-limit');
        const at = now();
        if (at - lastFollowUpAt < FOLLOW_UP_MIN_INTERVAL_MS) return reject('follow-up-rate-limited');
        confirming = true;
        try {
            const approved = await requestConfirmation(trimmed);
            if (disposed || approved !== true) return reject('not-confirmed');
            if (frame?.isConnected === false || !isCurrent()) return reject('conversation-changed');
        } catch { return reject('confirmation-failed'); }
        finally { confirming = false; }
        followUps += 1;
        lastFollowUpAt = now();
        Promise.resolve(sendMessage(`${FOLLOW_UP_PREFIX}${trimmed}${FOLLOW_UP_SUFFIX}`)).catch(() => reject('send-failed'));
    }

    return Object.freeze({
        loadState,
        handle(event) {
            const data = event?.data;
            if (disposed || !data || data.type !== WIDGET_CHANNEL || data.frameId !== frameId) return false;
            if (!frame || event.source !== frame.contentWindow) return false;
            if (data.action === 'set-state') saveState(data.state);
            else if (data.action === 'follow-up') followUp(data.text);
            return true;
        },
        pushGlobals(globals) {
            if (disposed) return;
            try {
                frame?.contentWindow?.postMessage({ type: `${WIDGET_CHANNEL}:globals`, frameId, globals }, '*');
            } catch (_e) { /* iframe 已销毁 */ }
        },
        dispose() { disposed = true; }
    });
}

export function readGlobals(doc) {
    const theme = doc?.body?.dataset?.vcpTheme === 'light' ? 'light' : 'dark';
    return { theme, locale: doc?.defaultView?.navigator?.language || 'zh-CN' };
}
