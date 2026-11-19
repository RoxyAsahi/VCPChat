/*
 * 曲目档案阵列的数据层：把播放器的曲库和歌单整理成「列」。
 * 一列 = 一个歌单（第一列是全部曲目，之后是自建歌单，再之后是专辑），
 * 一张卡 = 一首歌。这里不碰 DOM 和 WebGL，方便在 node 里测试。
 */
(function (global) {
    'use strict';

    const wrap = (value, size) => (size > 0 ? ((value % size) + size) % size : 0);

    const normalizePath = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();

    const stripExtension = (title) => String(title || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '');

    const asciiRef = (name, fallback) => {
        const ascii = String(name || '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
        return ascii.length >= 2 ? ascii.slice(0, 28) : fallback;
    };

    /*
     * 把播放器状态整理成列。tracks 是 app.playlist（全局曲库，下标就是 loadTrack 用的下标），
     * playlists 是 app.customPlaylists（{ id, name, tracks: [path] }）。
     * 专辑列只收两首以上的专辑，按曲目数从多到少，最多 maxAlbums 列。
     */
    const buildColumns = (tracks, playlists, options = {}) => {
        const list = Array.isArray(tracks) ? tracks : [];
        const maxAlbums = Number.isFinite(options.maxAlbums) ? options.maxAlbums : 24;
        const indexByPath = new Map();
        list.forEach((track, index) => {
            const key = normalizePath(track && track.path);
            if (key && !indexByPath.has(key)) indexByPath.set(key, index);
        });

        const columns = [{
            id: 'all',
            kind: 'all',
            name: '全部曲目',
            ref: 'ALL FILES',
            items: list.map((_, index) => index)
        }];

        (Array.isArray(playlists) ? playlists : []).forEach((playlist, order) => {
            if (!playlist) return;
            const items = [];
            (playlist.tracks || []).forEach((path) => {
                const index = indexByPath.get(normalizePath(path));
                if (index !== undefined) items.push(index);
            });
            columns.push({
                id: 'playlist:' + (playlist.id ?? order),
                kind: 'playlist',
                playlistId: playlist.id,
                name: String(playlist.name || '未命名歌单'),
                ref: asciiRef(playlist.name, 'PLAYLIST ' + String(order + 1).padStart(2, '0')),
                items
            });
        });

        if (maxAlbums > 0) {
            const albums = new Map();
            list.forEach((track, index) => {
                const name = track && track.album ? String(track.album).trim() : '';
                if (!name) return;
                if (!albums.has(name)) albums.set(name, []);
                albums.get(name).push(index);
            });
            [...albums.entries()]
                .filter(([, items]) => items.length >= 2)
                .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
                .slice(0, maxAlbums)
                .forEach(([name, items], order) => {
                    columns.push({
                        id: 'album:' + name,
                        kind: 'album',
                        name,
                        ref: asciiRef(name, 'ALBUM ' + String(order + 1).padStart(2, '0')),
                        items
                    });
                });
        }
        return columns;
    };

    /* 普通搜索：标题、歌手、专辑包含关键字（不分大小写），返回曲库下标。 */
    const search = (tracks, query) => {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return [];
        const out = [];
        (tracks || []).forEach((track, index) => {
            if (!track) return;
            const hay = (stripExtension(track.title) + '\n' + (track.artist || '') + '\n' + (track.album || '')).toLowerCase();
            if (hay.includes(q)) out.push(index);
        });
        return out;
    };

    const searchColumn = (tracks, query) => ({
        id: 'search',
        kind: 'search',
        name: '检索：' + String(query || '').trim(),
        ref: 'SEARCH RESULT',
        items: search(tracks, query)
    });

    /* 档案号：曲库里的序号，至少三位。 */
    const fileCode = (index) => String(index + 1).padStart(3, '0');

    /* 某一格（列、行可以越界，阵列是循环的）对应的曲库下标；空列返回 -1。 */
    const cellTrack = (columns, lane, row) => {
        if (!columns || !columns.length) return -1;
        const column = columns[wrap(lane, columns.length)];
        if (!column.items.length) return -1;
        return column.items[wrap(row, column.items.length)];
    };

    /* 找曲库下标 index 所在的位置，优先 preferLane 那一列。 */
    const locate = (columns, index, preferLane = 0) => {
        if (!columns || !columns.length || index < 0) return null;
        const order = [wrap(preferLane, columns.length)];
        for (let i = 0; i < columns.length; i++) if (i !== order[0]) order.push(i);
        for (const lane of order) {
            const row = columns[lane].items.indexOf(index);
            if (row !== -1) return { lane, row };
        }
        return null;
    };

    /* 键盘方向 → 选中格的变化。阵列在两个方向都循环。 */
    const KEY_STEPS = Object.freeze({
        ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
        PageUp: [0, -8], PageDown: [0, 8]
    });

    const step = (selection, key) => {
        const delta = KEY_STEPS[key];
        if (!delta) return null;
        return { lane: selection.lane + delta[0], row: selection.row + delta[1] };
    };

    /* 滚轮累计：超过阈值走一格，返回走的格数（带符号）并保留余量。 */
    const createWheel = (threshold = 60) => {
        let acc = 0;
        let lastAt = 0;
        return (deltaY, now = 0) => {
            if (now - lastAt > 400) acc = 0;
            lastAt = now;
            acc += deltaY;
            const steps = Math.trunc(acc / threshold);
            if (steps) acc -= steps * threshold;
            return Math.max(-6, Math.min(6, steps));
        };
    };

    /* 两次 build 之间列结构有没有变（决定要不要重建 HUD 和保持选中） */
    const signature = (columns) => columns.map((c) => c.id + ':' + c.items.length).join('|');

    const api = Object.freeze({
        wrap, normalizePath, stripExtension, buildColumns, search, searchColumn,
        fileCode, cellTrack, locate, step, createWheel, signature
    });

    if (typeof module === 'object' && module.exports) module.exports = api;
    global.MusicArchiveModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
