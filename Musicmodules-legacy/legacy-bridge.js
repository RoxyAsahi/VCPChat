// Musicmodules-legacy/legacy-bridge.js
// 旧版音乐界面（上游原版）的接线：这个文件夹里其余文件都和上游 main 一字不差，只有 music.html 多引了这一个脚本。
// 只做两件事：
//   1. 设置面板里加一个「旧版界面（原版）」开关，关掉就回到新版（窗口当场换页，播放不断）。
//   2. 音频引擎的端口现在由主进程启动时探测（默认 63789 被系统占用时会换），
//      原版频谱直接连 ws://127.0.0.1:63789/ws，这里把这个地址换成引擎实际的地址。

(function () {
    'use strict';

    const api = window.utilityAPI || window.electronAPI;
    const DEFAULT_WS = 'ws://127.0.0.1:63789/ws';

    // ---- 1. 引擎地址 ----
    let engineWs = null;
    try {
        api?.getAudioEngineEndpoint?.().then((ep) => { if (ep && ep.wsUrl) engineWs = ep.wsUrl; }).catch(() => {});
        api?.onAudioEngineStatus?.((ep) => { if (ep && ep.wsUrl) engineWs = ep.wsUrl; });
    } catch (e) { /* 旧主进程没有这个接口，就用默认端口 */ }
    const NativeWebSocket = window.WebSocket;
    if (NativeWebSocket) {
        const Bridged = function (url, protocols) {
            const target = (String(url) === DEFAULT_WS && engineWs) ? engineWs : url;
            return protocols === undefined ? new NativeWebSocket(target) : new NativeWebSocket(target, protocols);
        };
        Bridged.prototype = NativeWebSocket.prototype;
        ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { Bridged[k] = NativeWebSocket[k]; });
        window.WebSocket = Bridged;
    }

    // ---- 2. 「旧版界面（原版）」开关 ----
    const mount = () => {
        if (!api?.setMusicLegacyUI || document.getElementById('legacy-ui-switch')) return;
        const grid = document.querySelector('.settings-container .settings-grid');
        if (!grid) return;
        const item = document.createElement('div');
        item.className = 'setting-item toggle-item';
        item.innerHTML = '<label for="legacy-ui-switch" title="关掉回到新版音乐界面">旧版界面（原版）</label>'
            + '<label class="switch compact"><input type="checkbox" id="legacy-ui-switch" checked><span class="slider round"></span></label>';
        grid.appendChild(item);
        const input = item.querySelector('input');
        input.addEventListener('change', async () => {
            input.disabled = true;
            try {
                await api.setMusicLegacyUI(input.checked);
            } catch (e) {
                input.checked = !input.checked;
                console.warn('[Music legacy] 切换界面失败：', e);
            } finally {
                input.disabled = false;
            }
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
