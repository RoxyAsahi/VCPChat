// Musicmodules/music-library-sync.js
// 曲库文件夹（播放器这一侧）：主进程记住加过的音乐文件夹，打开播放器时、文件夹有变动时静默对一遍，
// 结果经 `music-library-sync` 送来，这里并进曲库（app.mergeScanResult），只在真有增删时提示一句。
// 设置卡片里的「曲库文件夹」列出记住的文件夹，可以移除、立即同步。
//
// 对外：MusicLibrarySync.summary({ added, removed }) → 提示文案（测试用）

(function (global) {
    'use strict';

    const NOTICE_AFTER = 1500; // 几个文件夹接连同步完，合成一句提示
    const BULK_REMOVE = 30;    // 后台同步一次要拿掉超过这么多首、又超过文件夹的四分之一时，先问

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');

    function summary({ added = 0, removed = 0, updated = 0 } = {}, manual = false) {
        const parts = [];
        if (added) parts.push(`新增 ${added} 首`);
        if (removed) parts.push(`移除 ${removed} 首`);
        if (!parts.length && updated) parts.push(`更新了 ${updated} 首的信息`);
        if (!parts.length) return manual ? '曲库已是最新，文件夹里没有变化' : '';
        return '曲库已和文件夹同步：' + parts.join(' · ');
    }

    function setupMusicLibrarySync(app) {
        if (!app || app.libraryFolders) return;
        const api = app.api;
        if (!api?.onMusicLibrarySync) return;
        const doc = global.document;
        let pending = null;
        let timer = null;
        let manual = false;
        let folders = [];

        const notify = () => {
            timer = null;
            const text = summary(pending || {}, manual);
            pending = null;
            manual = false;
            if (!text) return;
            try { global.MusicToast?.show?.({ message: text, duration: 5000 }); } catch (e) { /* 没有提示层 */ }
        };
        // 一次要从曲库拿掉很多歌（比如移动硬盘换了盘符、文件夹被整体挪走）：先不删，问一句
        const norm = (p) => String((app.normalizePathForCompare ? app.normalizePathForCompare(p) : p) || '').replace(/\\/g, '/').toLowerCase();
        const missingOf = (data) => {
            const key = norm(data.folderPath).replace(/\/+$/, '') + '/';
            const seen = new Set(data.tracks.map((t) => t && t.path));
            return (app.playlist || []).filter((t) => t && t.path && norm(t.path).startsWith(key) && !seen.has(t.path));
        };
        api.onMusicLibrarySync((data) => {
            if (!data || !Array.isArray(data.tracks) || typeof app.mergeScanResult !== 'function' || !data.folderPath) return;
            const missing = missingOf(data);
            const inside = missing.length + data.tracks.length;
            if (missing.length > BULK_REMOVE && missing.length > inside * 0.25) {
                // 先只加新的、更新信息，找不到的留着；用户点了才真的移除
                app.mergeScanResult({ ...data, tracks: data.tracks.concat(missing) }, { skipIfUnchanged: true });
                try {
                    global.MusicToast?.show?.({
                        message: `「${baseName(data.folderPath)}」里有 ${missing.length} 首找不到了，先留在曲库里`,
                        duration: 12000,
                        action: { label: '从曲库移除', run: () => app.mergeScanResult(data) }
                    });
                } catch (e) { /* 没有提示层 */ }
                return;
            }
            const r = app.mergeScanResult(data, { skipIfUnchanged: true }) || {};
            pending = pending || { added: 0, removed: 0, updated: 0 };
            pending.added += r.added || 0;
            pending.removed += r.removed || 0;
            pending.updated += r.updated || 0;
            if (data.reason === 'manual') manual = true;
            clearTimeout(timer);
            timer = global.setTimeout(notify, NOTICE_AFTER);
        });

        // ---- 设置卡片：曲库文件夹 ----
        const box = doc?.getElementById?.('library-folders');
        const listEl = box?.querySelector?.('[data-lf="list"]');
        const syncBtn = box?.querySelector?.('[data-lf="sync"]');
        const render = () => {
            if (!box || !listEl) return;
            box.hidden = false;
            listEl.innerHTML = folders.length
                ? folders.map((f, i) => `<li class="lf-row${f.online ? '' : ' offline'}" title="${esc(f.path)}">
                        <span class="lf-name">${esc(baseName(f.path))}</span>
                        <span class="lf-path">${esc(f.path)}</span>
                        ${f.online ? '' : '<em class="lf-off">没接上</em>'}
                        <button type="button" class="lf-remove" data-i="${i}" title="不再自动同步这个文件夹（曲库里的歌留着）" aria-label="不再同步 ${esc(baseName(f.path))}">×</button>
                    </li>`).join('')
                : '<li class="lf-empty">还没有记住的文件夹。用「添加文件夹」或把文件夹拖进窗口，以后里面加的歌会自动出现。</li>';
        };
        const apply = (list) => { if (Array.isArray(list)) { folders = list; render(); } };
        if (box && api.getLibraryFolders) {
            api.getLibraryFolders().then(apply).catch(() => {});
            api.onLibraryFoldersChanged?.(apply);
            listEl?.addEventListener('click', async (e) => {
                const b = e.target.closest('.lf-remove');
                if (!b) return;
                const f = folders[Number(b.dataset.i)];
                if (!f) return;
                try {
                    apply(await api.removeLibraryFolder(f.path));
                    global.MusicToast?.show?.({ message: `不再自动同步「${baseName(f.path)}」，曲库里的歌都还在`, duration: 4000 });
                } catch (err) { console.warn('[Music] 移除曲库文件夹失败：', err); }
            });
            syncBtn?.addEventListener('click', async () => {
                syncBtn.disabled = true;
                const label = syncBtn.textContent;
                syncBtn.textContent = '同步中…';
                manual = true;
                try { apply(await api.syncLibraryFolders()); } catch (err) { console.warn('[Music] 同步曲库失败：', err); }
                syncBtn.disabled = false;
                syncBtn.textContent = label;
                // 没有任何文件夹或都没接上时，不会有同步结果送来，也给一句
                if (!folders.some((f) => f.online)) { manual = false; global.MusicToast?.show?.({ message: '没有接上的曲库文件夹可以同步', duration: 3000 }); }
            });
        }
        app.libraryFolders = { list: () => folders.slice(), refresh: () => api.getLibraryFolders?.().then(apply) };
    }

    const api = { setupMusicLibrarySync, summary };
    global.MusicLibrarySync = api;
    global.setupMusicLibrarySync = setupMusicLibrarySync;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
