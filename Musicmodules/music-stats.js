// Musicmodules/music-stats.js
// 听歌记录：每首歌听了几次、上次什么时候听、跳过几次、第一次听是哪天。存在本机（localStorage），不上传。
// 「最常听」「很久没听」、自动续播挑歌、首页「接着听」都从这里取数。
//
// 怎么算「听了一次」（和 Last.fm 的规则一样）：实际在放的时间到了这首的一半，或者满 4 分钟；
// 不知道时长时按 60 秒。没到 30 秒（也没到一半）就换了别的歌，算跳过一次。
// 只在播放时计时：暂停、加载时不走。单曲循环每重新开始一遍算新的一遍。
//
// 对外：app.musicStats.get(track|path) → { plays, skips, last, first } | null
//       app.musicStats.top(n) → [path]（按次数，次数一样按最近）
//       app.musicStats.forgotten({ minPlays, days, limit }) → [path]（以前常听、很久没碰的）
//       app.musicStats.lastPlayed(n) → [path]
// 变化时在 document 上发 `music-stats-change`（detail: { path }）。

(function (global) {
    'use strict';

    const KEY = 'musicPlayStats';
    const SKIP_BEFORE = 30;      // 秒
    const MAX_FULL = 240;        // 满 4 分钟一定算一次
    const UNKNOWN_LEN = 60;      // 不知道时长时听满 60 秒算一次
    const DAY = 86400000;

    const normPath = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
    const playedEnough = (sec, duration) => {
        const d = Number(duration);
        const need = d > 0 ? Math.min(MAX_FULL, Math.max(d / 2, Math.min(d, SKIP_BEFORE))) : UNKNOWN_LEN;
        return sec >= need;
    };

    function setupMusicStats(app, {
        now = () => Date.now(),
        storage = (() => { try { return global.localStorage; } catch (e) { return null; } })(),
        setTimer = (fn, ms) => global.setInterval(fn, ms),
        clearTimer = (id) => global.clearInterval(id),
        observe = true
    } = {}) {
        if (!app || app.musicStats) return app && app.musicStats;

        // 存成 { v: 1, t: { 路径(小写、正斜杠): [次数, 上次时间, 跳过, 第一次时间, 原路径] } }，紧凑一些，两万首也不大
        let table = {};
        try {
            const raw = JSON.parse(storage?.getItem(KEY) || 'null');
            if (raw && raw.v === 1 && raw.t && typeof raw.t === 'object') table = raw.t;
        } catch (e) { table = {}; }
        let saveTimer = null;
        const save = () => {
            if (saveTimer !== null) return;
            saveTimer = global.setTimeout(() => {
                saveTimer = null;
                try { storage?.setItem(KEY, JSON.stringify({ v: 1, t: table })); } catch (e) { /* 存不下也不影响播放 */ }
            }, 1500);
        };
        const announce = (path) => {
            try { global.document?.dispatchEvent?.(new CustomEvent('music-stats-change', { detail: { path } })); } catch (e) { /* 旧内核 */ }
        };
        const entry = (path) => {
            const k = normPath(path);
            if (!k) return null;
            if (!table[k]) table[k] = [0, 0, 0, 0, String(path)];
            return table[k];
        };
        const bump = (path, kind) => {
            const e = entry(path);
            if (!e) return;
            const t = now();
            if (kind === 'play') { e[0]++; e[1] = t; if (!e[3]) e[3] = t; }
            else e[2]++;
            save();
            announce(path);
        };

        // ---- 一遍一遍地记 ----
        let session = null; // { path, listened, counted, lastTick, lastPos }
        const currentTrack = () => {
            return Array.isArray(app.playlist) ? app.playlist[app.currentTrackIndex] || null : null;
        };
        const duration = () => Number(app.lastKnownDuration) || Number(currentTrack()?.duration) || 0;
        const position = () => { try { return Number(app.playedSeconds?.()) || 0; } catch (e) { return 0; } };
        const close = () => {
            if (!session) return;
            if (!session.counted && session.listened > 0.2 && session.listened < SKIP_BEFORE && !session.ended) bump(session.path, 'skip');
            session = null;
        };
        const tick = () => {
            const t = currentTrack();
            const path = t && t.path;
            const playing = app.isPlaying === true && !app.isTrackLoading;
            const at = now();
            if (!path) { close(); return; }
            if (session && session.path !== path) close();
            if (!session) session = { path, listened: 0, counted: false, lastTick: at, lastPos: position() };
            const pos = position();
            const d = duration();
            // 单曲循环：同一首又从头开始了，上一遍结束、新的一遍开始
            if (session.counted && pos + 5 < session.lastPos && pos < 5) {
                session = { path, listened: 0, counted: false, lastTick: at, lastPos: pos };
            }
            if (playing) session.listened += Math.min(5, Math.max(0, (at - session.lastTick) / 1000));
            session.lastTick = at;
            session.lastPos = pos;
            if (d > 0 && pos >= d - 1.5) session.ended = true; // 放到结尾自然切走的不算跳过
            if (!session.counted && playedEnough(session.listened, d)) { session.counted = true; bump(path, 'play'); }
        };

        // 只在播放时开计时器（每秒一次）；暂停后停掉，空闲时没有任何计时器
        let timer = null;
        const sync = () => {
            const playing = app.isPlaying === true;
            if (playing && timer === null) { tick(); timer = setTimer(tick, 1000); }
            else if (!playing && timer !== null) { tick(); clearTimer(timer); timer = null; }
            else tick();
        };
        if (observe && global.MutationObserver && global.document?.body) {
            // 播放状态切换时 body 上的 music-playing 会变；切歌时也会经过这里
            let was = global.document.body.classList.contains('music-playing');
            new global.MutationObserver(() => {
                const is = global.document.body.classList.contains('music-playing');
                if (is !== was) { was = is; sync(); }
            }).observe(global.document.body, { attributes: true, attributeFilter: ['class'] });
            global.document.addEventListener?.('music-queue-change', () => tick());
        }

        // ---- 查询 ----
        const all = () => Object.values(table).filter((e) => e[0] > 0);
        const api = {
            get(input) {
                const e = table[normPath(input && typeof input === 'object' ? input.path : input)];
                return e ? { plays: e[0], last: e[1], skips: e[2], first: e[3] } : null;
            },
            top(n = 30, { minPlays = 2 } = {}) {
                return all().filter((e) => e[0] >= minPlays).sort((a, b) => b[0] - a[0] || b[1] - a[1]).slice(0, n).map((e) => e[4]);
            },
            lastPlayed(n = 30) {
                return all().sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[4]);
            },
            forgotten({ minPlays = 3, days = 30, limit = 30 } = {}) {
                const before = now() - days * DAY;
                return all().filter((e) => e[0] >= minPlays && e[1] && e[1] < before)
                    .sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, limit).map((e) => e[4]);
            },
            // 一首歌的「常听程度」0..1，自动续播挑歌时用来加权（跳过多的往后放）
            affinity(input) {
                const s = api.get(input);
                if (!s) return 0;
                const score = Math.log2(1 + s.plays) - 0.6 * Math.log2(1 + s.skips);
                return Math.max(0, Math.min(1, score / 5));
            },
            tick,
            sync,
            flush() { if (saveTimer !== null) { global.clearTimeout(saveTimer); saveTimer = null; } try { storage?.setItem(KEY, JSON.stringify({ v: 1, t: table })); } catch (e) { /* 同上 */ } }
        };
        app.musicStats = api;
        global.addEventListener?.('beforeunload', () => api.flush());
        sync();
        return api;
    }

    const exported = { setupMusicStats, playedEnough, normPath };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.setupMusicStats = setupMusicStats;
})(typeof window !== 'undefined' ? window : globalThis);
