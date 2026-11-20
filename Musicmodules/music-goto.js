// Musicmodules/music-goto.js
// 右键「转到歌手 / 转到专辑」：主流播放器的右键菜单都有，从一首歌直接跳到它所在的那一组。
// 落点是档案页目录：换到「歌手」或「专辑」分类，把这一组顶到最上面并选中这首。
// 只在档案页（不在舞台、不在经典视图）显示；曲目没有歌手或专辑信息时对应那一项隐藏。

(function (global) {
    'use strict';

    const ITEMS = [
        ['artist', '转到歌手', 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'],
        ['album', '转到专辑', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z']
    ];

    const fieldOf = (track, kind) => String((track && track[kind]) || '').trim();

    function archiveReady(app) {
        const view = app.archiveView;
        if (!view || view.mode !== 'archive' || !view.list) return null;
        if (app.isStageActive || global.document?.body?.classList.contains('music-stage-active')) return null;
        return view;
    }

    /* 换到分类并选中；成功返回 true。不依赖菜单，方便别处（比如详情卡）直接调用 */
    function goToGroup(app, index, kind) {
        const view = archiveReady(app);
        const track = app.playlist?.[index];
        if (!view || !track || !fieldOf(track, kind)) return false;
        try { view.closeDetail?.(); } catch (e) { /* 详情没开 */ }
        try { view.setListOpen?.(true, { persist: false }); } catch (e) { /* 旧档案页 */ }
        return Boolean(view.list.goToGroup?.(index, kind));
    }

    function setupMusicGoto(app) {
        if (!app || app.goToGroup) return;
        app.goToGroup = (index, kind) => goToGroup(app, index, kind);

        const menu = app.contextMenu;
        const doc = global.document;
        if (!menu || !doc || menu.querySelector('[data-action^="goto-"]')) return;
        const anchor = menu.querySelector('[data-action="toggle-like"]') || menu.querySelector('[data-action="add-to-queue"]');
        let after = anchor;
        const nodes = ITEMS.map(([kind, label, d]) => {
            const item = doc.createElement('div');
            item.className = 'context-menu-item';
            item.dataset.action = 'goto-' + kind;
            item.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg><span>${label}</span>`;
            if (after && after.parentNode === menu) { menu.insertBefore(item, after.nextSibling); after = item; } else menu.appendChild(item);
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = app.contextMenuTrackIndex;
                menu.classList.remove('visible');
                goToGroup(app, index, kind);
            });
            return { kind, label, item };
        });

        const paint = () => {
            const track = app.playlist?.[app.contextMenuTrackIndex];
            const ready = Boolean(archiveReady(app));
            for (const { kind, label, item } of nodes) {
                const name = fieldOf(track, kind);
                const show = ready && Boolean(name);
                item.style.display = show ? '' : 'none';
                item.title = show ? `${label}「${name}」` : '';
            }
        };
        const show = app.showContextMenu;
        if (typeof show === 'function') app.showContextMenu = (...args) => { paint(); return show(...args); };
    }

    global.setupMusicGoto = setupMusicGoto;
    if (typeof module !== 'undefined' && module.exports) module.exports = { setupMusicGoto };
})(typeof window !== 'undefined' ? window : globalThis);
