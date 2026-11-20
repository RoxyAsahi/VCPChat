/*
 * 档案页右侧的滚动歌词：和左侧档案目录同一套排版（字浮在场景上、不做面板、从右边缘向左渐隐的纸色柔光），
 * 正在唱的一行用目录选中行的记号（小方块 + 一条细线）标出，跟着播放进度往上滚。
 * 歌词来自播放器已经取好的 app.currentLyrics（{ time, text | original, translation }），
 * 进度用 app.lastKnownCurrentTime + 距 lastStateUpdateTime 的时间估算，不另取歌词、不碰播放器。
 * 点一行跳到那一句（app.seekTo）。
 */
(function (global) {
    'use strict';

    const LINE_H = 52;           // 只有原文的一行
    const LINE_H_TR = 74;        // 带译文的一行
    const ANCHOR = 0.34;         // 当前行停在可视高度的这个位置
    const TICK_MS = 200;

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const textOf = (line) => String((line && (line.text || line.original || line.fullText)) || '').trim();

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
        <div class="archive-lyrics-head"><span>LYRICS</span><i>／</i><b data-y="title"></b></div>
        <div class="archive-lyrics-viewport" data-y="viewport"><div class="archive-lyrics-track" data-y="track"></div></div>`;

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

        const state = { source: null, lines: [], offsets: [], index: -2, shown: false, allowed: true, timer: 0, path: null };

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
                return `<p data-k="${k}"${tr ? ' class="tr"' : ''}><b>${esc(textOf(l))}</b>${tr ? `<em>${esc(tr)}</em>` : ''}</p>`;
            }).join('');
            state.index = -2;
            const t = current();
            state.path = t ? t.path : null;
            r.title.textContent = t ? String(t.title || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '') : '';
        };

        const show = (on) => {
            if (on === state.shown) return;
            state.shown = on;
            el.hidden = !on;
            if (on) { state.index = -2; tick(); }
            schedule();
            onChange?.(on);
        };

        /* 播放器换了歌词（或换了歌）就重建；有歌词才显示 */
        const sync = () => {
            const t = current();
            if (app.currentLyrics !== state.source || (t ? t.path : null) !== state.path) build();
            show(state.allowed && state.lines.length > 0);
        };

        const tick = () => {
            if (!state.shown) return;
            const k = lineAt(state.lines, now());
            if (k === state.index) return;
            const prev = r.track.querySelector('p.on');
            prev?.classList.remove('on');
            state.index = k;
            const node = k >= 0 ? r.track.children[k] : null;
            node?.classList.add('on');
            const h = r.viewport.clientHeight || 600;
            const y = k >= 0 ? state.offsets[k] : 0;
            const shift = Math.max(0, y - h * ANCHOR);
            r.track.style.transition = reducedMotion() ? 'none' : '';
            r.track.style.transform = `translateY(${-shift}px)`;
        };

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
            state.index = -2;
            tick();
        });

        return {
            el,
            sync: () => { sync(); schedule(); tick(); },
            tick,
            setAllowed: (on) => { state.allowed = Boolean(on); sync(); },
            get shown() { return state.shown; },
            destroy: () => { if (state.timer) clearInterval(state.timer); state.timer = 0; el.remove(); },
            debug: () => ({ shown: state.shown, lines: state.lines.length, index: state.index, ticking: Boolean(state.timer) })
        };
    };

    global.MusicArchiveLyrics = Object.freeze({ create, lineAt });
})(window);
