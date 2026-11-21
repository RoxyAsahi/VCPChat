/*
 * 档案页右侧的滚动歌词：和左侧档案目录同一套排版（字浮在场景上、不做面板、从右边缘向左渐隐的纸色柔光），
 * 正在唱的一行用目录选中行的记号（小方块 + 一条细线）标出，跟着播放进度往上滚。
 * 歌词来自播放器已经取好的 app.currentLyrics（{ time, text | original, translation }），
 * 进度用 app.lastKnownCurrentTime + 距 lastStateUpdateTime 的时间估算，不另取歌词、不碰播放器。
 * 点一行跳到那一句（app.seekTo），暂停着就接着播。
 * 有逐字时间（line.words）的歌，正在唱的那一行逐字填色（像 Apple Music）；滚轮可以自己往前往后翻，
 * 翻的时候先不跟着跑，停手 3 秒后再滑回正在唱的那一行。
 * 正在放的歌没有歌词时（等上一会儿，免得歌词还在取的时候闪一下）只留栏头和一行说明，带「获取歌词」入口；
 * 这时不占右侧的版面，封面照旧用大图。
 */
(function (global) {
    'use strict';

    const LINE_H = 52;           // 只有原文的一行
    const LINE_H_TR = 74;        // 带译文的一行
    const ANCHOR = 0.34;         // 当前行停在可视高度的这个位置
    const TICK_MS = 200;
    const FOLLOW_AFTER = 3000;   // 手动滚过歌词后，停手这么久再回到跟随
    const NONE_AFTER = 2500;     // 换歌后这么久还没有歌词，才说「没有歌词」

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const textOf = (line) => String((line && (line.text || line.original || line.fullText)) || '').trim();
    /* 这一行有能用的逐字时间才返回（每个字都有起止时间、拼起来和整行一样），否则按整行显示 */
    const wordsOf = (line) => {
        const words = line && Array.isArray(line.words) ? line.words : null;
        if (!words || words.length < 2) return null;
        if (!words.every((w) => w && typeof w.text === 'string' && Number.isFinite(w.startTime) && Number.isFinite(w.endTime) && w.endTime >= w.startTime)) return null;
        return words.map((w) => w.text).join('').trim() === textOf(line).replace(/\s+/g, ' ').trim() || words.map((w) => w.text).join('').replace(/\s+/g, '') === textOf(line).replace(/\s+/g, '') ? words : null;
    };

    /* 第几行在唱：最后一个 time <= t 的行；都还没到就是 -1 */
    const lineAt = (lines, t) => {
        let lo = 0, hi = lines.length - 1, at = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if ((Number(lines[mid].time) || 0) <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return at;
    };

    const TEMPLATE = `
        <div class="archive-lyrics-head"><span>歌词</span><i>／</i><b data-y="title"></b><button type="button" class="archive-lyrics-desk" data-y="desk" hidden aria-pressed="false" title="在桌面上显示歌词（切到别的程序也能看到）">桌面歌词</button></div>
        <div class="archive-lyrics-viewport" data-y="viewport"><div class="archive-lyrics-track" data-y="track"></div></div>
        <div class="archive-lyrics-none" data-y="none"><span>这首歌还没有歌词</span><button type="button" data-y="fetch">获取歌词 <i aria-hidden="true">→</i></button></div>`;

    /*
     * opts: { host, app, reducedMotion(), onChange(shown) }
     * 返回 { el, sync(), tick(), setAllowed(on), destroy(), debug() }
     */
    const create = ({ host, app, reducedMotion = () => false, onChange = null }) => {
        const el = document.createElement('section');
        el.className = 'archive-lyrics';
        el.setAttribute('aria-label', '歌词');
        el.hidden = true;
        el.innerHTML = TEMPLATE;
        host.appendChild(el);
        const r = {};
        el.querySelectorAll('[data-y]').forEach((n) => { r[n.dataset.y] = n; });

        const state = { source: null, lines: [], offsets: [], index: -2, shown: false, allowed: true, timer: 0, path: null, none: false, nonePath: null, nonePending: null, noneTimer: 0, shift: 0, manual: 0, manualTimer: 0, words: null };

        const tracks = () => (Array.isArray(app.playlist) ? app.playlist : []);
        const current = () => tracks()[app.currentTrackIndex] || null;
        const now = () => {
            const base = Number(app.lastKnownCurrentTime) || 0;
            if (!app.isPlaying || !app.lastStateUpdateTime) return base;
            return base + Math.max(0, Date.now() - app.lastStateUpdateTime) / 1000;
        };

        const build = () => {
            const src = Array.isArray(app.currentLyrics) ? app.currentLyrics : [];
            state.source = app.currentLyrics;
            state.lines = src.filter((l) => l && textOf(l));
            state.offsets = [];
            let y = 0;
            r.track.innerHTML = state.lines.map((l, k) => {
                state.offsets.push(y);
                const tr = String(l.translation || '').trim();
                y += tr ? LINE_H_TR : LINE_H;
                const words = wordsOf(l);
                const body = words ? words.map((w) => `<span class="w">${esc(w.text)}</span>`).join('') : esc(textOf(l));
                return `<p data-k="${k}"${tr ? ' class="tr"' : ''}><b${words ? ' class="ww"' : ''}>${body}</b>${tr ? `<em>${esc(tr)}</em>` : ''}</p>`;
            }).join('');
            state.index = -2;
            state.words = null;
            const t = current();
            state.path = t ? t.path : null;
            r.title.textContent = t ? String(t.title || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '') : '';
        };

        const show = (on) => {
            if (on === state.shown) return;
            state.shown = on;
            el.hidden = !(on || state.none);
            if (on) { state.index = -2; tick(); }
            schedule();
            onChange?.(on);
        };

        /* 播放器换了歌词（或换了歌）就重建；有歌词才显示 */
        const sync = () => {
            const t = current();
            if (app.currentLyrics !== state.source || (t ? t.path : null) !== state.path) build();
            const has = state.lines.length > 0;
            if (has) setNone(false);
            show(state.allowed && has);
            syncNone();
        };

        /* 没有歌词的说明：在播放（或者已经显示着、只是暂停了）而且等够了才出现 */
        const setNone = (on) => {
            if (on === state.none) return;
            state.none = on;
            el.classList.toggle('none', on);
            el.hidden = !(state.shown || on);
        };
        const wantNone = () => {
            const t = current();
            if (!state.allowed || !t || !t.path || state.lines.length) return null;
            return app.isPlaying || state.nonePath === t.path ? t.path : null;
        };
        const syncNone = () => {
            const path = wantNone();
            if (path && state.none && state.nonePath === path) return;
            if (path && state.nonePending === path) return;
            clearTimeout(state.noneTimer);
            state.noneTimer = 0;
            state.nonePending = path;
            setNone(false);
            if (!path) return;
            state.noneTimer = setTimeout(() => {
                state.noneTimer = 0;
                state.nonePending = null;
                if (wantNone() !== path) return;
                state.nonePath = path;
                r.fetch.hidden = typeof app.openLyricsFetchModal !== 'function';
                setNone(true);
            }, NONE_AFTER);
        };
        // 桌面歌词开关（music-desktop-lyrics.js 提供；没有就不显示）
        const syncDesk = () => {
            const d = app.desktopLyrics;
            r.desk.hidden = !(d && d.available);
            r.desk.setAttribute('aria-pressed', String(Boolean(d && d.on)));
        };
        r.desk.addEventListener('click', () => { app.desktopLyrics?.toggle?.(); });
        document.addEventListener('music-desktop-lyrics-change', syncDesk);
        setTimeout(syncDesk, 0);
        r.fetch.addEventListener('click', () => {
            if (typeof app.openLyricsFetchModal === 'function') app.openLyricsFetchModal(app.currentTrackIndex);
        });

        /* 正在唱的那一行逐字填色：唱过的填满，正在唱的那个字用 CSS 过渡按剩余时长填，暂停时停在当前比例 */
        const paintWords = (t) => {
            const k = state.index;
            const line = k >= 0 ? state.lines[k] : null;
            const words = line && wordsOf(line);
            const node = words ? r.track.children[k]?.querySelector('b.ww') : null;
            if (!node) { state.words = null; return; }
            const spans = node.children;
            const playing = Boolean(app.isPlaying);
            for (let j = 0; j < words.length && j < spans.length; j++) {
                const w = words[j], span = spans[j];
                const want = t >= w.endTime ? 'sung' : t >= w.startTime ? (playing ? 'singing' : 'held') : '';
                if (span.dataset.st === want) continue;
                span.dataset.st = want;
                span.className = want ? 'w ' + want : 'w';
                if (want === 'singing') span.style.setProperty('--d', Math.max(0, w.endTime - t).toFixed(2) + 's');
                if (want === 'held') span.style.setProperty('--p', Math.round(100 * (t - w.startTime) / Math.max(0.01, w.endTime - w.startTime)) + '%');
            }
            state.words = node;
        };
        const place = (animate = true) => {
            const max = Math.max(0, (state.offsets[state.offsets.length - 1] || 0) - (r.viewport.clientHeight || 600) * 0.4);
            const y = Math.max(0, Math.min(max + LINE_H_TR, state.shift + state.manual));
            r.track.style.transition = !animate || reducedMotion() ? 'none' : '';
            r.track.style.transform = `translateY(${-y}px)`;
        };
        const tick = () => {
            if (!state.shown) return;
            const t = now();
            const k = lineAt(state.lines, t);
            if (k !== state.index) {
                const prev = r.track.querySelector('p.on');
                prev?.classList.remove('on');
                prev?.querySelectorAll('.w[data-st]').forEach((n) => { n.className = 'w'; delete n.dataset.st; });
                state.index = k;
                const node = k >= 0 ? r.track.children[k] : null;
                node?.classList.add('on');
                const h = r.viewport.clientHeight || 600;
                const y = k >= 0 ? state.offsets[k] : 0;
                state.shift = Math.max(0, y - h * ANCHOR);
                if (!state.manualTimer) place();
            }
            paintWords(t);
        };

        // 滚轮自己翻歌词：先不跟随，停手 3 秒后滑回正在唱的那一行（不让档案页把滚轮当成切歌）
        r.viewport.addEventListener('wheel', (e) => {
            if (!state.shown || !state.lines.length) return;
            e.preventDefault();
            e.stopPropagation();
            const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
            state.manual += e.deltaY * unit;
            state.manual = Math.max(-state.shift, state.manual);
            el.classList.add('browsing');
            place(false);
            clearTimeout(state.manualTimer);
            state.manualTimer = setTimeout(() => {
                state.manualTimer = 0;
                state.manual = 0;
                el.classList.remove('browsing');
                place();
            }, FOLLOW_AFTER);
        }, { passive: false });

        // 只在显示着、而且在播放时走表（暂停时停在原处）
        const schedule = () => {
            const want = state.shown && Boolean(app.isPlaying);
            if (want && !state.timer) state.timer = setInterval(tick, TICK_MS);
            else if (!want && state.timer) { clearInterval(state.timer); state.timer = 0; }
        };

        r.track.addEventListener('click', (e) => {
            const p = e.target.closest('p[data-k]');
            const line = p && state.lines[Number(p.dataset.k)];
            if (!line || typeof app.seekTo !== 'function') return;
            const t = Number(line.time) || 0;
            app.seekTo(t);
            app.lastKnownCurrentTime = t;
            app.lastStateUpdateTime = Date.now();
            // 暂停着点一句：从这句接着播（和主流播放器一样），加载中不发
            if (!app.isPlaying && !app.isTrackLoading && typeof app.playTrack === 'function') app.playTrack();
            clearTimeout(state.manualTimer);
            state.manualTimer = 0;
            state.manual = 0;
            el.classList.remove('browsing');
            state.index = -2;
            tick();
        });

        return {
            el,
            sync: () => { sync(); schedule(); tick(); },
            tick,
            setAllowed: (on) => { state.allowed = Boolean(on); sync(); },
            get shown() { return state.shown; },
            destroy: () => { if (state.timer) clearInterval(state.timer); state.timer = 0; clearTimeout(state.noneTimer); clearTimeout(state.manualTimer); el.remove(); },
            debug: () => ({ shown: state.shown, none: state.none, lines: state.lines.length, index: state.index, ticking: Boolean(state.timer) })
        };
    };

    global.MusicArchiveLyrics = Object.freeze({ create, lineAt, wordsOf });
})(window);
