// Musicmodules/music-track-file.js
// 曲目右键菜单「在文件夹中显示」：打开资源管理器并选中这个文件（整理文件、改标签、找同专辑其他文件时用）。
// 云端（WebDAV）的歌没有本机文件，菜单打开时把这一项藏起来。

(function (global) {
    'use strict';

    const isLocal = (p) => typeof p === 'string' && p !== '' && !/^[a-z][a-z0-9+.-]+:\/\//i.test(p);

    function setupMusicTrackFile(app) {
        if (!app || app.showTrackInFolder) return;
        const doc = global.document;
        if (typeof app.api?.showMusicInFolder !== 'function') return;
        const toast = (message) => { try { global.MusicToast?.show?.({ kind: 'error', message }); } catch (e) { /* 没有提示层 */ } };

        app.showTrackInFolder = async (ref) => {
            const track = typeof ref === 'number' ? app.playlist?.[ref] : ref;
            if (!track || !isLocal(track.path)) { toast('云端的歌没有本机文件'); return false; }
            let res;
            try { res = await app.api.showMusicInFolder({ path: track.path }); } catch (e) { res = { ok: false, message: String(e && e.message || e) }; }
            if (!res || !res.ok) { toast(res?.message || '打不开文件所在的文件夹'); return false; }
            return true;
        };

        const menu = app.contextMenu;
        if (!menu || !doc || menu.querySelector('[data-action="show-in-folder"]')) return;
        const item = doc.createElement('div');
        item.className = 'context-menu-item';
        item.dataset.action = 'show-in-folder';
        item.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span>在文件夹中显示</span>';
        const anchor = menu.querySelector('[data-action="get-lyrics"]');
        if (anchor && anchor.parentNode === menu) menu.insertBefore(item, anchor.nextSibling); else menu.appendChild(item);
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.remove('visible');
            app.showTrackInFolder(app.contextMenuTrackIndex);
        });
        // 菜单每次打开时看一眼：云端的歌没有这一项
        const sync = () => {
            if (!menu.classList.contains('visible')) return;
            const hide = !isLocal(app.playlist?.[app.contextMenuTrackIndex]?.path);
            if (item.hidden !== hide) item.hidden = hide;
        };
        if (typeof global.MutationObserver === 'function') new global.MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ['class'] });
    }

    const exported = { setupMusicTrackFile, isLocal };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.MusicTrackFile = exported;
})(typeof window !== 'undefined' ? window : globalThis);
