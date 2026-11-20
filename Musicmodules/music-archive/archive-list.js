/*
 * 档案页左侧常驻的「档案目录」列表：顶部检索框，筛选（全部/歌手/专辑/歌单/最近），
 * 按分组带吸顶标题的长列表。只画看得见的那几十行（虚拟滚动），几千首也一样快。
 * 选中状态和阵列共用：列表里选哪首，阵列相机就跟到那张卡；阵列里换卡，列表滚到那一行。
 */
(function (global) {
    'use strict';

    const HEAD_H = 34;    // 分组标题行高（设计像素）
    const ROW_H = 54;     // 曲目行高
    const OVERSCAN = 8;
    const KINDS = [['all', '全部', 'ALL'], ['artist', '歌手', 'ARTIST'], ['album', '专辑', 'ALBUM'], ['playlist', '歌单', 'LIST'], ['recent', '最近', 'RECENT']];

    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const fmtTime = (sec) => {
        const s = Number(sec);
        if (!(s > 0)) return '--:--';
        return pad(Math.floor(s / 60)) + ':' + pad(Math.floor(s % 60));
    };
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const TEMPLATE = `
        <div class="archive-list-head">
            <span class="archive-tiny">ARCHIVE DIRECTORY</span>
            <span class="archive-list-total" data-l="total"></span>
        </div>
        <label class="archive-list-search">
            <span class="archive-glyph-search" aria-hidden="true"></span>
            <input type="search" data-l="input" placeholder="标题、歌手、专辑、拼音首字母" autocomplete="off" spellcheck="false" aria-label="检索曲目">
            <span class="archive-key" aria-hidden="true">/</span>
        </label>
        <div class="archive-list-kinds" role="tablist" data-l="kinds">
            ${KINDS.map(([k, zh, en]) => `<button type="button" role="tab" data-kind="${k}" title="${zh}"><b>${zh}</b><i>${en}</i></button>`).join('')}
        </div>
        <div class="archive-list-cols" aria-hidden="true"><span>FILE</span><span>TITLE / ARTIST · ALBUM</span><span>TIME</span></div>
        <div class="archive-list-viewport" data-l="viewport" tabindex="0" role="listbox" aria-label="曲目目录">
            <div class="archive-list-sticky" data-l="sticky" aria-hidden="true"></div>
            <div class="archive-list-spacer" data-l="spacer"></div>
            <div class="archive-list-empty" data-l="empty">没有匹配的曲目</div>
        </div>
        <div class="archive-list-foot">
            <span class="archive-tiny">SELECT</span>
            <span class="archive-list-pos" data-l="pos"></span>
            <span class="archive-list-hint">↑↓ 选择 ／ ENTER 播放 ／ → 进入播放页</span>
        </div>`;

    /*
     * opts: {
     *   host, app, Index, getIndex(), getRecent(), columnOfGroup(g),
     *   onPick(i, ctx), onPlay(i, ctx, { stage }), fileNumber(track, i), isNarrow()
     * }
     */
    const create = (opts) => {
        const { host, app, Index } = opts;
        const el = document.createElement('section');
        el.className = 'archive-list';
        el.setAttribute('aria-label', '档案目录');
        el.innerHTML = TEMPLATE;
        host.appendChild(el);
        const r = {};
        el.querySelectorAll('[data-l]').forEach((n) => { r[n.dataset.l] = n; });

        const state = {
            kind: 'all',
            query: '',
            rows: [],
            offsets: [],
            heads: [],          // 分组标题在 rows 里的下标
            count: 0,
            selected: -1,       // 曲库下标
            selectedRow: -1,    // rows 里的下标
            rendered: new Map(),
            dirty: true,
            raf: 0,
            playing: -1
        };
        try { state.kind = localStorage.getItem('musicArchiveListKind') || 'all'; } catch (e) { /* 默认全部 */ }
        if (!KINDS.some(([k]) => k === state.kind)) state.kind = 'all';

        const tracks = () => (Array.isArray(app.playlist) ? app.playlist : []);

        const rebuild = () => {
            const index = opts.getIndex();
            if (!index) return;
            const out = Index.listRows({
                tracks: tracks(), playlists: app.customPlaylists, recent: opts.getRecent(), index,
                kind: state.kind, query: state.query, columnOfGroup: opts.columnOfGroup
            });
            state.rows = out.rows;
            state.count = out.count;
            state.offsets = new Array(out.rows.length + 1);
            state.heads = [];
            let y = 0;
            out.rows.forEach((row, k) => {
                state.offsets[k] = y;
                if (row.type === 'head') state.heads.push(k);
                y += row.type === 'head' ? HEAD_H : ROW_H;
            });
            state.offsets[out.rows.length] = y;
            r.spacer.style.height = y + 'px';
            r.empty.style.display = out.count ? 'none' : 'block';
            r.total.textContent = pad(out.count, 4) + ' / ' + pad(tracks().length, 4);
            el.querySelectorAll('[data-kind]').forEach((b) => {
                const on = b.dataset.kind === state.kind;
                b.classList.toggle('on', on);
                b.setAttribute('aria-selected', String(on));
            });
            for (const node of state.rendered.values()) node.remove();
            state.rendered.clear();
            state.selectedRow = findRow(state.selected, state.preferCtx);
            render();
        };

        /* 二分找 y 所在的行 */
        const rowAt = (y) => {
            let lo = 0, hi = state.rows.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (state.offsets[mid] <= y) lo = mid; else hi = mid - 1;
            }
            return lo;
        };

        const rowHtml = (row, k) => {
            if (row.type === 'head') return `<span>${esc(row.label)}</span><i>${pad(row.n)}</i>`;
            const t = tracks()[row.i] || {};
            const meta = [t.artist, t.album].filter(Boolean).join(' · ') || 'UNKNOWN ARTIST';
            const title = String(t.title || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '') || '未知标题';
            return `<span class="no">${esc(opts.fileNumber(t, row.i))}</span>`
                + `<span class="tx"><b>${esc(title)}</b><em>${esc(meta)}</em></span>`
                + `<span class="tm">${fmtTime(t.duration)}</span>`;
        };

        const paintRow = (node, row, k) => {
            const on = k === state.selectedRow;
            node.classList.toggle('on', on);
            node.classList.toggle('playing', row.type === 'track' && row.i === state.playing && Boolean(app.isPlaying));
            if (row.type === 'track') node.setAttribute('aria-selected', String(on));
        };

        const render = () => {
            state.raf = 0;
            if (!el.isConnected || el.hidden) return;
            const top = r.viewport.scrollTop;
            const h = r.viewport.clientHeight || 600;
            if (!state.rows.length) { r.sticky.textContent = ''; return; }
            const first = Math.max(0, rowAt(top) - OVERSCAN);
            const last = Math.min(state.rows.length - 1, rowAt(top + h) + OVERSCAN);
            for (const [k, node] of state.rendered) {
                if (k < first || k > last) { node.remove(); state.rendered.delete(k); }
            }
            for (let k = first; k <= last; k++) {
                const row = state.rows[k];
                let node = state.rendered.get(k);
                if (!node) {
                    node = document.createElement('div');
                    node.className = row.type === 'head' ? 'archive-list-group' : 'archive-list-row';
                    node.dataset.k = k;
                    if (row.type === 'track') node.setAttribute('role', 'option');
                    node.style.transform = `translateY(${state.offsets[k]}px)`;
                    node.innerHTML = rowHtml(row, k);
                    r.spacer.appendChild(node);
                    state.rendered.set(k, node);
                }
                paintRow(node, row, k);
            }
            // 吸顶分组标题：当前可见第一行所属的分组；下一组顶上来时把它推上去
            let headK = -1;
            for (const hk of state.heads) { if (state.offsets[hk] <= top) headK = hk; else break; }
            if (headK === -1 || state.offsets[headK] === top) {
                r.sticky.style.visibility = 'hidden';
            } else {
                const row = state.rows[headK];
                r.sticky.style.visibility = '';
                r.sticky.innerHTML = `<span>${esc(row.label)}</span><i>${pad(row.n)}</i>`;
                const nextHead = state.heads.find((hk) => hk > headK);
                const push = nextHead !== undefined ? Math.min(0, state.offsets[nextHead] - top - HEAD_H) : 0;
                r.sticky.style.transform = `translateY(${top + push}px)`;
            }
            const sel = state.selectedRow;
            let nth = 0;
            if (sel >= 0) for (let k = 0; k <= sel; k++) if (state.rows[k].type === 'track') nth++;
            r.pos.textContent = sel >= 0 ? pad(nth, 3) + ' / ' + pad(state.count, 3) : '--- / ' + pad(state.count, 3);
        };
        const schedule = () => { if (!state.raf) state.raf = requestAnimationFrame(render); };

        const findRow = (i, ctx) => {
            if (i < 0) return -1;
            let first = -1;
            for (let k = 0; k < state.rows.length; k++) {
                const row = state.rows[k];
                if (row.type !== 'track' || row.i !== i) continue;
                if (!ctx || row.ctx === ctx) return k;
                if (first === -1) first = k;
            }
            return first;
        };

        const scrollToRow = (k, { center = false } = {}) => {
            if (k < 0) return;
            const vp = r.viewport;
            const y = state.offsets[k];
            const h = vp.clientHeight || 600;
            const pad2 = HEAD_H + 4;
            if (center) vp.scrollTop = Math.max(0, y - h / 2 + ROW_H / 2);
            else if (y < vp.scrollTop + pad2) vp.scrollTop = Math.max(0, y - pad2);
            else if (y + ROW_H > vp.scrollTop + h) vp.scrollTop = y + ROW_H - h;
            schedule();
        };

        /* 阵列那边换了选中：列表跟着高亮并滚到那一行 */
        const reveal = (i, ctx) => {
            state.selected = i;
            state.preferCtx = ctx;
            const k = findRow(i, ctx);
            const moved = k !== state.selectedRow;
            state.selectedRow = k;
            if (moved && k >= 0) scrollToRow(k, { center: !inView(k) });
            render(); // 当场画，避免阵列和目录高亮差一帧
        };
        const inView = (k) => {
            const vp = r.viewport;
            const y = state.offsets[k];
            return y >= vp.scrollTop && y + ROW_H <= vp.scrollTop + (vp.clientHeight || 600);
        };

        /* 列表里换选中（键盘/单击）：告诉阵列 */
        const pickRow = (k) => {
            const row = state.rows[k];
            if (!row || row.type !== 'track') return;
            state.selectedRow = k;
            state.selected = row.i;
            state.preferCtx = row.ctx;
            scrollToRow(k);
            opts.onPick(row.i, row.ctx);
            render();
        };
        const stepRow = (dir, n = 1) => {
            if (!state.rows.length) return;
            let k = state.selectedRow;
            if (k < 0) k = dir > 0 ? -1 : state.rows.length;
            let moved = 0;
            let next = k;
            for (let j = k + dir; j >= 0 && j < state.rows.length; j += dir) {
                if (state.rows[j].type === 'track') { next = j; if (++moved >= n) break; }
            }
            if (next !== k) pickRow(next);
        };
        const edgeRow = (end) => {
            for (let j = end ? state.rows.length - 1 : 0; j >= 0 && j < state.rows.length; j += end ? -1 : 1) {
                if (state.rows[j].type === 'track') { pickRow(j); return; }
            }
        };
        const selectedRowData = () => state.rows[state.selectedRow] || null;

        // ---------- 输入 ----------
        let typeTimer = 0;
        r.input.addEventListener('input', () => {
            clearTimeout(typeTimer);
            typeTimer = setTimeout(() => {
                state.query = r.input.value;
                r.viewport.scrollTop = 0;
                rebuild();
                // 有检索词时第一条就是最可能的结果，直接选中，回车即可播放
                if (state.query.trim()) edgeRow(false);
            }, 80);
        });
        const flushQuery = () => {
            if (r.input.value === state.query) return;
            clearTimeout(typeTimer);
            state.query = r.input.value;
            rebuild();
            if (state.query.trim()) edgeRow(false);
        };

        const onKey = (e) => {
            const inInput = e.target === r.input;
            if (inInput) flushQuery();
            switch (e.key) {
                case 'ArrowDown': e.preventDefault(); stepRow(1); break;
                case 'ArrowUp': e.preventDefault(); stepRow(-1); break;
                case 'PageDown': e.preventDefault(); stepRow(1, 10); break;
                case 'PageUp': e.preventDefault(); stepRow(-1, 10); break;
                case 'Home': if (!inInput) { e.preventDefault(); edgeRow(false); } break;
                case 'End': if (!inInput) { e.preventDefault(); edgeRow(true); } break;
                case 'Enter': {
                    e.preventDefault();
                    const row = selectedRowData();
                    if (row && row.type === 'track') opts.onPlay(row.i, row.ctx, { stage: e.shiftKey });
                    break;
                }
                case 'ArrowRight': {
                    if (inInput && r.input.selectionStart < r.input.value.length) return;
                    const row = selectedRowData();
                    if (row && row.type === 'track') { e.preventDefault(); opts.onPlay(row.i, row.ctx, { stage: true }); }
                    break;
                }
                case 'Escape':
                    e.preventDefault();
                    if (inInput && r.input.value) { r.input.value = ''; flushQuery(); } else { e.target.blur(); }
                    break;
                case 'Tab':
                    if (!inInput) return;
                    e.preventDefault();
                    setKind(KINDS[(KINDS.findIndex(([k]) => k === state.kind) + (e.shiftKey ? KINDS.length - 1 : 1)) % KINDS.length][0]);
                    break;
                default: return;
            }
            e.stopPropagation();
        };
        r.input.addEventListener('keydown', onKey);
        r.viewport.addEventListener('keydown', onKey);

        r.viewport.addEventListener('scroll', schedule, { passive: true });
        r.viewport.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
        r.viewport.addEventListener('click', (e) => {
            const node = e.target.closest('.archive-list-row');
            if (node) pickRow(Number(node.dataset.k));
        });
        r.viewport.addEventListener('dblclick', (e) => {
            const node = e.target.closest('.archive-list-row');
            const row = node && state.rows[Number(node.dataset.k)];
            if (row && row.type === 'track') opts.onPlay(row.i, row.ctx, { stage: false });
        });
        r.viewport.addEventListener('contextmenu', (e) => {
            const node = e.target.closest('.archive-list-row');
            const row = node && state.rows[Number(node.dataset.k)];
            if (!row || row.type !== 'track') return;
            e.preventDefault();
            pickRow(Number(node.dataset.k));
            app.contextMenuTrackIndex = row.i;
            app.showContextMenu?.(e.clientX, e.clientY);
        });
        el.querySelector('[data-l="kinds"]').addEventListener('click', (e) => {
            const b = e.target.closest('[data-kind]');
            if (b) setKind(b.dataset.kind);
        });

        const setKind = (kind) => {
            if (kind === state.kind) return;
            state.kind = kind;
            try { localStorage.setItem('musicArchiveListKind', kind); } catch (e) { /* 只是记住上次 */ }
            r.viewport.scrollTop = 0;
            rebuild();
            const k = findRow(state.selected, null);
            if (k >= 0) { state.selectedRow = k; scrollToRow(k, { center: true }); }
        };

        const setPlaying = (i) => {
            if (i === state.playing) { schedule(); return; }
            state.playing = i;
            for (const [k, node] of state.rendered) paintRow(node, state.rows[k], k);
        };

        return {
            el,
            rebuild,
            reveal,
            setPlaying,
            setKind,
            render: schedule,
            focusSearch: () => { r.input.focus(); r.input.select(); },
            hasFocus: () => el.contains(document.activeElement),
            get kind() { return state.kind; },
            get query() { return state.query; },
            get count() { return state.count; },
            debug: () => ({ kind: state.kind, query: state.query, count: state.count, rows: state.rows.length, selectedRow: state.selectedRow, rendered: state.rendered.size })
        };
    };

    global.MusicArchiveList = Object.freeze({ create, KINDS });
})(window);
