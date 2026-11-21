// Musicmodules/music-legacy-switch.js
// 设置里的「旧版界面（原版）」：打开就把音乐窗口换成上游原版界面（Musicmodules-legacy/，原样保留）。
// 原版里同一个开关关掉就回到这里。选择存在设置的 musicLegacyUI 里，下次开窗口照这个来。

(function () {
    'use strict';
    const mount = () => {
        const api = window.utilityAPI || window.electronAPI;
        const input = document.getElementById('legacy-ui-switch');
        if (!input) return;
        if (!api?.setMusicLegacyUI) { input.closest('.setting-item')?.setAttribute('hidden', ''); return; }
        input.checked = false; // 能看到这个开关，说明现在就是新版
        input.addEventListener('change', async () => {
            input.disabled = true;
            try {
                await api.setMusicLegacyUI(input.checked);
            } catch (e) {
                input.checked = !input.checked;
                console.warn('[Music] 切换界面失败：', e);
            } finally {
                input.disabled = false;
            }
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
