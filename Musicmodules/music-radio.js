// Musicmodules/music-radio.js
// 电台与自动续播（Spotify 的「自动播放」、Plexamp 的电台）：
//   - 右键「从这首开电台」：以这首为种子，从曲库里挑同歌手、同专辑、常听、喜欢的歌排成一串接着放，
//     快放完时自己再续一段，不会绕回开头。
//   - 自动续播：从一组（专辑、歌手、歌单、检索结果）点播，放到这一组最后一首时，后面自动接上相似的歌，
//     不再绕回这一组开头。提示条上可以一键关掉；整个曲库顺序播放、单曲循环、随机时不接。
// 挑歌只用本机的曲目信息和听歌记录（music-stats.js），不联网。
//
// 对外：app.startRadio(trackOrIndex)、app.dailyMix()、app.neverPlayed()、app.autoplay.enabled（读写，存本机）、
//       app.radio（正在放的电台：{ seed, label } 或 null）。纯函数 pickSimilar 供测试。

(function (global) {
    'use strict';

    const KEY = 'musicAutoplay';
    const BATCH = 25;     // 一次续多少首
    const REFILL_AT = 4;  // 剩这么多首时再续

    const norm = (s) => String(s || '').trim().toLowerCase();
    const artistsOf = (t) => norm(t && t.artist).split(/\s*(?:\/|,|，|、|&|;|feat\.?|ft\.)\s*/).filter(Boolean);

    /*
     * 从曲库里挑和种子相近的歌。seeds 是最近放的几首（越靠后越重要），exclude 是不要的（刚放过、已在队列里）。
     * 打分：同歌手 3、同专辑 1.5、同流派 1、常听 0..2、喜欢 1.5、跳得多的往后，再加一点随机让每次不一样；
     * 然后控制同一歌手不超过三分之一、同一专辑不超过 3 首，避免一串全是同一张专辑。
     */
    function pickSimilar(library, seeds, { size = BATCH, exclude = new Set(), affinity = () => 0, liked = () => false, novelty = () => 0, random = Math.random } = {}) {
        const seedArtists = new Map();
        const seedAlbums = new Set();
        const seedGenres = new Set();
        seeds.forEach((t, k) => {
            const w = 0.6 + 0.4 * (k + 1) / seeds.length; // 越近的种子分量越重
            for (const a of artistsOf(t)) seedArtists.set(a, Math.max(seedArtists.get(a) || 0, w));
            if (norm(t.album)) seedAlbums.add(norm(t.album) + '\n' + norm(t.artist));
            if (norm(t.genre)) seedGenres.add(norm(t.genre));
        });
        const scored = [];
        for (const t of library) {
            if (!t || !t.path || exclude.has(t)) continue;
            let s = 0;
            let artistHit = 0;
            for (const a of artistsOf(t)) artistHit = Math.max(artistHit, seedArtists.get(a) || 0);
            s += 3 * artistHit;
            if (seedAlbums.has(norm(t.album) + '\n' + norm(t.artist))) s += 1.5;
            if (norm(t.genre) && seedGenres.has(norm(t.genre))) s += 1;
            s += 2 * affinity(t);
            if (liked(t)) s += 1.5;
            s += novelty(t); // 每日推荐里给没听过的歌一点加分，让曲库里沉着的歌浮上来
            s += 1.2 * random();
            scored.push([s, t]);
        }
        scored.sort((a, b) => b[0] - a[0]);
        const out = [];
        const perArtist = new Map();
        const perAlbum = new Map();
        const artistCap = Math.max(2, Math.ceil(size / 3));
        const pass = (strict) => {
            for (const [, t] of scored) {
                if (out.length >= size) return;
                if (out.includes(t)) continue;
                const a = artistsOf(t)[0] || '';
                const al = norm(t.album) + '\n' + norm(t.artist);
                if (strict && ((perArtist.get(a) || 0) >= artistCap || (norm(t.album) && (perAlbum.get(al) || 0) >= 3))) continue;
                // 同一歌手不连着放两首以上
                if (strict && out.length >= 2 && a && artistsOf(out[out.length - 1])[0] === a && artistsOf(out[out.length - 2])[0] === a) continue;
                out.push(t);
                perArtist.set(a, (perArtist.get(a) || 0) + 1);
                perAlbum.set(al, (perAlbum.get(al) || 0) + 1);
            }
        };
        // 「不连着三首」会让一遍扫下来留空位，空位在后面几遍里补上，直到补不动
        for (let before = -1; out.length < size && out.length !== before;) { before = out.length; pass(true); }
        if (out.length < size) pass(false); // 曲库小、歌手少时放宽
        return out;
    }

    function setupMusicRadio(app, { storage = (() => { try { return global.localStorage; } catch (e) { return null; } })() } = {}) {
        if (!app || app.startRadio) return;
        const doc = global.document;
        let enabled = true;
        try { enabled = storage?.getItem(KEY) !== '0'; } catch (e) { /* 默认开 */ }
        app.autoplay = {
            get enabled() { return enabled; },
            set enabled(v) {
                enabled = Boolean(v);
                try { storage?.setItem(KEY, enabled ? '1' : '0'); } catch (e) { /* 只是偏好 */ }
                try { doc?.dispatchEvent?.(new CustomEvent('music-autoplay-change', { detail: { enabled } })); } catch (e) { /* 旧内核 */ }
            }
        };
        app.radio = null;

        const toast = (message, action) => { try { global.MusicToast?.show?.({ message, action, duration: action ? 8000 : undefined }); } catch (e) { /* 没有提示层 */ } };
        const title = (t) => (app.stripAudioExtension ? app.stripAudioExtension(t.title || '') : String(t.title || '')) || '未知标题';
        const recentSet = (list) => {
            const set = new Set(list);
            // 最近放过的 30 首（档案页记的最近播放）先不放
            let paths = [];
            try { paths = JSON.parse(global.localStorage?.getItem('musicArchiveRecent') || '[]'); } catch (e) { paths = []; }
            const want = new Set(paths.slice(0, 30).map((p) => norm(String(p).replace(/\\/g, '/'))));
            for (const t of app.playlist || []) if (want.has(norm(String(t.path).replace(/\\/g, '/')))) set.add(t);
            return set;
        };
        const pick = (seeds, exclude, size = BATCH) => pickSimilar(app.playlist || [], seeds, {
            size,
            exclude,
            affinity: (t) => app.musicStats?.affinity?.(t) || 0,
            liked: (t) => Boolean(app.isLiked?.(t))
        });
        const setContext = (list) => {
            app.currentFilteredTracks = list;
            if (app.playbackContext) app.playbackContext.list = list;
            try { doc?.dispatchEvent?.(new CustomEvent('music-queue-change')); } catch (e) { /* 旧内核 */ }
            try { app.refreshPreload?.(); } catch (e) { /* 还没在放 */ }
        };

        // ---- 从一首歌开电台 ----
        app.startRadio = (ref) => {
            const track = typeof ref === 'number' ? app.playlist?.[ref] : ref;
            if (!track || !(app.playlist || []).includes(track)) return false;
            const exclude = recentSet([track]);
            const list = [track, ...pick([track], exclude)];
            if (list.length < 2) { toast('曲库里没有能接着放的歌'); return false; }
            app.radio = { seed: track, label: `「${title(track)}」电台`, list };
            app.playFromContext(list, app.playlist.indexOf(track), { origin: 'radio', render: false });
            toast(`已开始${app.radio.label}：${list.length} 首，快放完时会自己续上`);
            return true;
        };

        // ---- 每日推荐（Spotify 的 Daily Mix）：以最常听、最近听的几首为种子，同一天结果不变；
        //      大约三分之一是还没听过的歌。没有听歌记录时用最近播放；都没有就随机。
        const seeded = (seedText) => {
            let h = 2166136261;
            for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
            return () => { h += 0x6D2B79F5; let x = h; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
        };
        const byPaths = (paths) => {
            const want = new Map((app.playlist || []).map((t) => [norm(String(t.path).replace(/\\/g, '/')), t]));
            return paths.map((p) => want.get(norm(String(p).replace(/\\/g, '/')))).filter(Boolean);
        };
        let mixCache = { key: '', list: [] };
        app.dailyMix = ({ size = 30 } = {}) => {
            const lib = app.playlist || [];
            const day = new Date().toISOString().slice(0, 10);
            const key = day + '|' + lib.length + '|' + size;
            if (mixCache.key === key) return mixCache.list;
            const stats = app.musicStats;
            let seeds = byPaths(stats ? stats.top(8, { minPlays: 1 }) : []);
            if (seeds.length < 3) {
                let recent = [];
                try { recent = JSON.parse(global.localStorage?.getItem('musicArchiveRecent') || '[]'); } catch (e) { recent = []; }
                seeds = seeds.concat(byPaths(recent.slice(0, 8)).filter((t) => !seeds.includes(t)));
            }
            const random = seeded(day + '|' + lib.length);
            const list = pickSimilar(lib, seeds, {
                size,
                exclude: new Set(byPaths(stats ? stats.lastPlayed(15) : [])),
                affinity: (t) => app.musicStats?.affinity?.(t) || 0,
                liked: (t) => Boolean(app.isLiked?.(t)),
                novelty: (t) => (stats && !stats.get(t) ? 1.6 : 0),
                random
            });
            mixCache = { key, list };
            return list;
        };
        // 还没听过的歌：随机一批（同一天不变），按歌手打散
        app.neverPlayed = ({ size = 30 } = {}) => {
            const stats = app.musicStats;
            const lib = (app.playlist || []).filter((t) => t && t.path && !(stats && stats.get(t)));
            const random = seeded('never|' + new Date().toISOString().slice(0, 10));
            return pickSimilar(lib, [], { size, random });
        };

        // ---- 每换一首检查：电台快放完就续；一组放到最后一首就接上相似的歌 ----
        const lastOf = (list, k) => list.slice(Math.max(0, k - 4), k + 1);
        const onTrack = () => {
            const list = app.currentFilteredTracks;
            const current = app.playlist?.[app.currentTrackIndex];
            const mode = app.playModes?.[app.currentPlayMode] || 'repeat';
            if (!Array.isArray(list) || !current) { if (!Array.isArray(list)) app.radio = null; return; }
            const at = list.indexOf(current);
            if (at < 0) return;
            if (app.radio && app.radio.list !== list) app.radio = null; // 换了别的上下文，电台结束
            if (app.radio) {
                if (list.length - 1 - at > REFILL_AT || mode === 'repeat-one') return;
                const more = pick(lastOf(list, at), recentSet(list));
                if (!more.length) return;
                const next = list.concat(more);
                app.radio.list = next;
                setContext(next);
                return;
            }
            if (!enabled || mode !== 'repeat' || at !== list.length - 1 || list.length < 1) return;
            if (app.playbackContext && app.playbackContext.autoplayed === list) return;
            const more = pick(lastOf(list, at), recentSet(list));
            if (!more.length) return;
            const before = list;
            const next = list.concat(more);
            setContext(next);
            if (app.playbackContext) app.playbackContext.autoplayed = next;
            toast('这一组放到最后一首了，接下来接着放相似的歌', {
                label: '不要接',
                run: () => {
                    app.autoplay.enabled = false;
                    if (app.currentFilteredTracks === next) setContext(before);
                    toast('已关闭自动续播：一组放完会回到开头');
                }
            });
        };
        const loadTrack = app.loadTrack;
        if (typeof loadTrack === 'function') {
            app.loadTrack = async function (...args) {
                const result = await loadTrack.apply(this, args);
                try { onTrack(); } catch (e) { console.warn('[MusicRadio] continue failed:', e?.message || e); }
                return result;
            };
        }

        // 无缝切歌时引擎自己进了下一首，播放器走的是 syncTrackIndexByPath，不经过 loadTrack
        const syncByPath = app.syncTrackIndexByPath;
        if (typeof syncByPath === 'function') {
            app.syncTrackIndexByPath = function (...args) {
                const result = syncByPath.apply(this, args);
                try { onTrack(); } catch (e) { console.warn('[MusicRadio] continue failed:', e?.message || e); }
                return result;
            };
        }

        // 抽屉「声音」页里的开关
        const sw = doc?.getElementById?.('autoplay-switch');
        if (sw) {
            sw.checked = enabled;
            sw.addEventListener('change', () => { app.autoplay.enabled = sw.checked; });
            doc.addEventListener('music-autoplay-change', (e) => { sw.checked = Boolean(e.detail?.enabled); });
        }

        // ---- 右键菜单：从这首开电台 ----
        const menu = app.contextMenu;
        if (menu && doc && !menu.querySelector('[data-action="start-radio"]')) {
            const item = doc.createElement('div');
            item.className = 'context-menu-item';
            item.dataset.action = 'start-radio';
            item.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M3.24 6.15C2.51 6.43 2 7.17 2 8v12c0 1.1.89 2 2 2h16c1.11 0 2-.9 2-2V8c0-1.11-.89-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z" fill="currentColor"/></svg><span>从这首开电台</span>';
            const anchor = menu.querySelector('[data-action="add-to-queue"]') || menu.querySelector('[data-action="toggle-like"]');
            if (anchor && anchor.parentNode === menu) menu.insertBefore(item, anchor.nextSibling); else menu.appendChild(item);
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.classList.remove('visible');
                app.startRadio(app.contextMenuTrackIndex);
            });
        }
    }

    const exported = { setupMusicRadio, pickSimilar };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    global.setupMusicRadio = setupMusicRadio;
})(typeof window !== 'undefined' ? window : globalThis);
