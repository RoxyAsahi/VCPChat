/*
 * 档案页左侧常驻的「档案目录」列表：顶部检索框，筛选（全部/歌手/专辑/歌单/最近），
 * 按分组的长列表，字直接浮在场景上（不做面板），首字母大字放在左侧外边距并随滚动吸附。
 * 只画看得见的那几十行（虚拟滚动），几千首也一样快。
 * 选中状态和阵列共用：列表里选哪首，阵列相机就跟到那张卡；阵列里换卡，列表滚到那一行。
 */
(function (global) {
    'use strict';

    const LETTER_H = 20;  // 首字母分组前的留白（字母本身在左侧外边距里）
    const LABEL_H = 40;   // 歌手/专辑/歌单分组的小标题行
    const ROW_H = 58;     // 曲目行高
    const LETTER_PUSH = 78; // 下一组的字母离顶端不到这么远时，把吸附的字母往上推走（避免两个字母叠在一起）
    const OVERSCAN = 8;
    const SORTS = [['title', '标题', 'TITLE'], ['artist', '歌手', 'ARTIST'], ['duration', '时长', 'LENGTH'], ['added', '添加时间', 'ADDED']];
    const KINDS = [['all', '全部', 'ALL'], ['artist', '歌手', 'ARTIST'], ['album', '专辑', 'ALBUM'], ['playlist', '歌单', 'LIST'], ['recent', '最近', 'RECENT']];

    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const fmtTime = (sec) => {
        const s = Number(sec);
        if (!(s > 0)) return '--:--';
        const h = Math.floor(s / 3600);
        return (h ? h + ':' + pad(Math.floor(s / 60) % 60) : pad(Math.floor(s / 60))) + ':' + pad(Math.floor(s % 60));
    };
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const TEMPLATE = `
        <label class="archive-list-search">
            <span class="archive-glyph-search" aria-hidden="true"></span>
            <input type="search" data-l="input" placeholder="标题、歌手、专辑、拼音首字母" autocomplete="off" spellcheck="false" aria-label="检索曲目">
            <span class="archive-key" aria-hidden="true">/</span>
        </label>
        <div class="archive-list-kinds" role="tablist" data-l="kinds">
            ${KINDS.map(([k, zh, en]) => `<button type="button" role="tab" data-kind="${k}" title="${zh}（${en}）">${zh}</button>`).join('')}
            <span class="archive-list-sort">
                <button type="button" data-l="sortBtn" aria-haspopup="menu" aria-expanded="false" title="排序方式（阵列跟着重排）"><span class="archive-glyph-sort" aria-hidden="true"></span><span data-l="sortName">标题</span></button>
                <span class="archive-list-sort-menu" role="menu" data-l="sortMenu" hidden>
                    ${SORTS.map(([k, zh, en]) => `<button type="button" role="menuitemradio" data-sort="${k}" aria-checked="false"><span>${zh}</span><i>${en}</i></button>`).join('')}
                </span>
            </span>
        </div>
        <div class="archive-list-viewport" data-l="viewport" tabindex="0" role="listbox" aria-label="曲目目录">
            <div class="archive-list-sticky" data-l="sticky" aria-hidden="true"></div>
            <div class="archive-list-spacer" data-l="spacer"></div>
            <div class="archive-list-empty" data-l="empty">没有匹配的曲目</div>
        </div>
        <div class="archive-list-foot" aria-live="polite">
            <b data-l="pos">---</b><i>/</i><span data-l="tot">000</span>
        </div>`;

    /*
     * opts: {
     *   host, app, Index, getIndex(), getRecent(), columnOfGroup(g),
     *   onPick(i, ctx), onPlay(i, ctx, { stage, group }), fileNumber(track, i), isNarrow()
     *   group = { name, items } 是这一行所在的那组（歌手、专辑、最近、检索结果），点播时用它当队列；
     *   全部曲目且没有检索词时不给（按首字母分的组只是索引，队列仍是整个曲库）
     * }
     */
    /* 首字母分组（全部曲目、无检索词）：字母放到左侧外边距里，大号细体 */
    const isLetter = (row) => row.type === 'head' && String(row.key || '').startsWith('letter:');
    const letterHtml = (row) => {
        const g = String(row.key).slice(7);
        const text = g === '0-9' ? '0–9' : g === '#' ? '#' : g;
        return `<span class="${text.length > 1 ? 'wide' : ''}">${esc(text)}</span>`;
    };


    /*
     * 右键菜单的键盘操作。菜单本身是播放器的 #track-context-menu（几行 div），这里在档案页打开它之后接管按键：
     * ↑ ↓ Home End 移动，Enter / 空格执行，→ 打开「加入歌单」子菜单、← 收回，Esc / Tab 关闭并把焦点还回去。
     * 菜单关掉（visible 类没了）就自动撤掉这些处理。
     */
    const menuKeyboard = (app, { restore = null } = {}) => {
        const menu = app.contextMenu || document.getElementById('track-context-menu');
        if (!menu || !menu.classList.contains('visible')) return null;
        const shown = (el) => !el.hidden && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
        const topItems = () => [...menu.querySelectorAll(':scope > .context-menu-item')].filter(shown);
        let sub = null; // 打开着的子菜单所在的那一项
        const subItems = () => (sub ? [...sub.querySelectorAll('.submenu-item')] : []);
        const items = () => (sub ? subItems() : topItems());
        const prep = (el) => { el.setAttribute('role', 'menuitem'); el.tabIndex = -1; };
        menu.setAttribute('role', 'menu');
        topItems().forEach(prep);
        const focusAt = (k) => { const list = items(); if (list.length) list[(k + list.length) % list.length].focus({ preventScroll: true }); };
        const openSub = (item) => {
            if (!subItemsOf(item).length) return;
            sub = item;
            item.classList.add('archive-kbd-sub');
            subItems().forEach(prep);
            focusAt(0);
        };
        const subItemsOf = (item) => [...item.querySelectorAll('.submenu-item')];
        const closeSub = () => { if (!sub) return; const item = sub; sub = null; item.classList.remove('archive-kbd-sub'); item.focus({ preventScroll: true }); };
        let done = false;
        const finish = ({ focusBack = true } = {}) => {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            observer.disconnect();
            menu.querySelectorAll('.archive-kbd-sub').forEach((el) => el.classList.remove('archive-kbd-sub'));
            if (focusBack && restore && restore.isConnected) restore.focus({ preventScroll: true });
        };
        const close = () => { menu.classList.remove('visible'); finish(); };
        const onKey = (e) => {
            if (!menu.classList.contains('visible')) { finish({ focusBack: false }); return; }
            const list = items();
            const at = list.indexOf(document.activeElement);
            switch (e.key) {
                case 'ArrowDown': focusAt(at + 1); break;
                case 'ArrowUp': focusAt(at < 0 ? -1 : at - 1); break;
                case 'Home': focusAt(0); break;
                case 'End': focusAt(-1); break;
                case 'ArrowRight': if (!sub && at >= 0 && list[at].classList.contains('has-submenu')) openSub(list[at]); break;
                case 'ArrowLeft': closeSub(); break;
                case 'Enter': case ' ': {
                    const el = list[at];
                    if (!el) break;
                    if (!sub && el.classList.contains('has-submenu')) { openSub(el); break; }
                    el.click();
                    if (menu.classList.contains('visible')) menu.classList.remove('visible');
                    finish();
                    break;
                }
                case 'Escape': if (sub) closeSub(); else close(); break;
                case 'Tab': close(); break;
                default: return;
            }
            e.preventDefault();
            e.stopPropagation();
        };
        const observer = new MutationObserver(() => { if (!menu.classList.contains('visible')) finish({ focusBack: false }); });
        observer.observe(menu, { attributes: true, attributeFilter: ['class'] });
        document.addEventListener('keydown', onKey, true);
        focusAt(0);
        return { close };
    };

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
        // 时长：扫描器给的 duration，没有就用播放过后记下的；都没有就不显示
        const durationOf = (t, i) => (Number(t && t.duration) > 0 ? Number(t.duration) : Number(opts.durationOf?.(t, i)) || 0);

        const rebuild = () => {
            const index = opts.getIndex();
            if (!index) return;
            const out = Index.listRows({
                tracks: tracks(), playlists: app.customPlaylists, recent: opts.getRecent(), index,
                kind: state.kind, query: state.query, columnOfGroup: opts.columnOfGroup, spec: opts.getSpec?.() || null
            });
            state.rows = out.rows;
            state.count = out.count;
            state.offsets = new Array(out.rows.length + 1);
            state.heads = [];
            let y = 0;
            out.rows.forEach((row, k) => {
                state.offsets[k] = y;
                if (row.type === 'head') state.heads.push(k);
                y += row.type === 'head' ? (isLetter(row) ? LETTER_H : LABEL_H) : ROW_H;
            });
            state.offsets[out.rows.length] = y;
            r.spacer.style.height = y + 'px';
            r.empty.style.display = out.count ? 'none' : 'block';
            el.querySelectorAll('[data-kind]').forEach((b) => {
                const on = b.dataset.kind === state.kind;
                b.classList.toggle('on', on);
                b.setAttribute('aria-selected', String(on));
            });
            paintSort();
            for (const node of state.rendered.values()) node.remove();
            state.rendered.clear();
            state.selectedRow = findRow(state.selected, state.preferCtx);
            // 重排后（比如拼音表加载好、分组变了）选中行可能跑到视野外，拉回来
            if (state.selectedRow >= 0 && !inView(state.selectedRow)) scrollToRow(state.selectedRow, { center: true });
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
            if (row.type === 'head') {
                if (isLetter(row)) return letterHtml(row);
                return `<span>${esc(row.label)}</span><i>${pad(row.n)}</i>`;
            }
            const t = tracks()[row.i] || {};
            const meta = [t.artist, t.album].filter(Boolean).join(' · ') || 'UNKNOWN ARTIST';
            const title = String(t.title || '').replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus|ape|wma|alac|aiff?|dsf|dff)$/i, '') || '未知标题';
            const time = durationOf(t, row.i);
            return '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>'
                + `<span class="tx"><b>${esc(title)}</b><em>${esc(meta)}</em></span>`
                + `<span class="rt"><i>${esc(opts.fileNumber(t, row.i))}</i>${time > 0 ? `<i>${fmtTime(time)}</i>` : ''}</span>`;
        };

        const paintRow = (node, row, k) => {
            const on = k === state.selectedRow;
            node.classList.toggle('on', on);
            const current = row.type === 'track' && row.i === state.playing;
            node.classList.toggle('current', current);
            node.classList.toggle('playing', current && Boolean(app.isPlaying));
            if (row.type === 'head') node.classList.toggle('stuck', k === state.stuck);
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
            // 吸附的首字母：当前可见第一行所属的分组（只有首字母分组才吸附）
            let headK = -1;
            for (const hk of state.heads) { if (state.offsets[hk] <= top + 1) headK = hk; else break; }
            if (headK === -1 && state.heads.length) headK = state.heads[0];
            const stuckRow = state.rows[headK];
            state.stuck = stuckRow && isLetter(stuckRow) ? headK : -1;
            for (let k = first; k <= last; k++) {
                const row = state.rows[k];
                let node = state.rendered.get(k);
                if (!node) {
                    node = document.createElement('div');
                    node.className = row.type === 'track' ? 'archive-list-row' : isLetter(row) ? 'archive-list-letter' : 'archive-list-group';
                    node.dataset.k = k;
                    if (row.type === 'track') node.setAttribute('role', 'option');
                    node.style.transform = `translateY(${state.offsets[k]}px)`;
                    node.innerHTML = rowHtml(row, k);
                    r.spacer.appendChild(node);
                    state.rendered.set(k, node);
                }
                paintRow(node, row, k);
            }
            // 吸附字母停在顶上，下一组的字母顶上来时把它推上去
            if (state.stuck === -1) {
                r.sticky.style.visibility = 'hidden';
            } else {
                r.sticky.style.visibility = '';
                const html = letterHtml(stuckRow);
                if (r.sticky.innerHTML !== html) r.sticky.innerHTML = html;
                const nextHead = state.heads.find((hk) => hk > headK);
                const y = Math.max(top, state.offsets[headK]);
                const push = nextHead !== undefined ? Math.min(0, state.offsets[nextHead] - y - LETTER_PUSH) : 0;
                r.sticky.style.transform = `translateY(${y + push}px)`;
            }
            const sel = state.selectedRow;
            let nth = 0;
            if (sel >= 0) for (let k = 0; k <= sel; k++) if (state.rows[k].type === 'track') nth++;
            r.pos.textContent = sel >= 0 ? pad(nth, 3) : '---';
            r.tot.textContent = pad(state.count, 3);
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
            const pad2 = LABEL_H;
            if (center) vp.scrollTop = Math.max(0, y - h / 2 + ROW_H / 2);
            else if (y < vp.scrollTop + pad2) vp.scrollTop = Math.max(0, y - pad2);
            else if (y + ROW_H > vp.scrollTop + h) vp.scrollTop = y + ROW_H - h;
            schedule();
        };

        /* 阵列那边换了选中：列表跟着高亮并滚到那一行 */
        const reveal = (i, ctx, { center = false } = {}) => {
            state.selected = i;
            state.preferCtx = ctx;
            const k = findRow(i, ctx);
            const moved = k !== state.selectedRow;
            state.selectedRow = k;
            if ((moved || center) && k >= 0) scrollToRow(k, { center: center || !inView(k) });
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
        /* 第 k 行所在的那一组：组名和组里的曲目（按显示顺序） */
        const groupOf = (k) => {
            if (state.kind === 'all' && !state.query.trim()) return null;
            let h = -1;
            for (const hk of state.heads) { if (hk <= k) h = hk; else break; }
            const head = state.rows[h];
            const items = [];
            for (let j = h + 1; j < state.rows.length && state.rows[j].type === 'track'; j++) items.push(state.rows[j].i);
            if (!items.length) return null;
            const kindName = (KINDS.find(([kk]) => kk === state.kind) || [])[1] || '';
            const label = head ? head.label : kindName;
            const name = state.kind === 'all' || state.kind === 'recent' || !kindName || label === kindName ? label : kindName + '：' + label;
            return { name, items };
        };

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
            }, 30); // 570 首时一次检索约 5–15ms，去抖只为合并连续按键，不再让人等
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
                    if (row && row.type === 'track') opts.onPlay(row.i, row.ctx, { stage: e.shiftKey, group: groupOf(state.selectedRow) });
                    break;
                }
                case 'ArrowRight': {
                    if (inInput && r.input.selectionStart < r.input.value.length) return;
                    const row = selectedRowData();
                    if (row && row.type === 'track') { e.preventDefault(); opts.onPlay(row.i, row.ctx, { stage: true, group: groupOf(state.selectedRow) }); }
                    break;
                }
                case 'Escape':
                    e.preventDefault();
                    if (inInput && r.input.value) { r.input.value = ''; flushQuery(); } else { e.target.blur(); }
                    break;
                case 'ContextMenu': case 'F10': {
                    if (e.key === 'F10' && !e.shiftKey) return;
                    e.preventDefault();
                    openMenuForRow(state.selectedRow);
                    break;
                }
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
            if (row && row.type === 'track') opts.onPlay(row.i, row.ctx, { stage: false, group: groupOf(Number(node.dataset.k)) });
        });
        /* 歌单分类里的行：右键菜单的「移除」只从这个歌单里移除；其他行按曲库处理 */
        const scopeOf = (row) => {
            const m = /^playlist:(.+)$/.exec(String(row.ctx || ''));
            const pl = m && (app.customPlaylists || []).find((p) => String(p.id) === m[1]);
            return pl ? { type: 'playlist', id: pl.id, name: pl.name } : null;
        };
        r.viewport.addEventListener('contextmenu', (e) => {
            const node = e.target.closest('.archive-list-row');
            const row = node && state.rows[Number(node.dataset.k)];
            if (!row || row.type !== 'track') return;
            e.preventDefault();
            pickRow(Number(node.dataset.k));
            app.contextMenuTrackIndex = row.i;
            app.contextMenuScopeHint = scopeOf(row);
            app.showContextMenu?.(e.clientX, e.clientY);
        });
        /*
         * 键盘打开右键菜单（Shift+F10、菜单键）：在选中那一行上发一次 contextmenu，走和鼠标右键完全一样的路
         * （播放器据此知道菜单是从档案页打开的），菜单出现后接管方向键，关掉后焦点回到目录
         */
        const openMenuForRow = (k) => {
            const row = state.rows[k];
            if (!row || row.type !== 'track') return;
            scrollToRow(k);
            render();
            const node = state.rendered.get(k);
            if (!node) return;
            const rect = node.getBoundingClientRect();
            const back = document.activeElement;
            node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 40, clientY: rect.top + rect.height / 2 }));
            menuKeyboard(app, { restore: back && back !== document.body ? back : r.viewport });
        };
        el.querySelector('[data-l="kinds"]').addEventListener('click', (e) => {
            const b = e.target.closest('[data-kind]');
            if (b) setKind(b.dataset.kind);
        });

        // ---------- 排序菜单 ----------
        const sortMode = () => (opts.getSort ? opts.getSort() : 'title');
        const paintSort = () => {
            const mode = sortMode();
            const entry = SORTS.find(([k]) => k === mode) || SORTS[0];
            r.sortName.textContent = entry[1];
            r.sortBtn.classList.toggle('on', mode !== 'title');
            r.sortMenu.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sort === mode)));
        };
        const sortOpen = () => !r.sortMenu.hidden;
        const closeSort = ({ focus = false } = {}) => {
            if (!sortOpen()) return;
            r.sortMenu.hidden = true;
            r.sortBtn.setAttribute('aria-expanded', 'false');
            document.removeEventListener('pointerdown', outside, true);
            if (focus) r.sortBtn.focus();
        };
        const outside = (e) => { if (!e.target.closest || !e.target.closest('.archive-list-sort')) closeSort(); };
        const openSort = () => {
            paintSort();
            r.sortMenu.hidden = false;
            r.sortBtn.setAttribute('aria-expanded', 'true');
            document.addEventListener('pointerdown', outside, true);
            (r.sortMenu.querySelector('[aria-checked="true"]') || r.sortMenu.querySelector('[data-sort]')).focus();
        };
        const chooseSort = (mode) => {
            closeSort({ focus: true });
            if (mode === sortMode()) return;
            opts.onSort?.(mode); // 阵列和目录一起按新顺序重建
        };
        r.sortBtn.addEventListener('click', (e) => { e.stopPropagation(); sortOpen() ? closeSort() : openSort(); });
        r.sortMenu.addEventListener('click', (e) => {
            const b = e.target.closest('[data-sort]');
            if (!b) return;
            e.stopPropagation();
            chooseSort(b.dataset.sort);
        });
        r.sortMenu.addEventListener('keydown', (e) => {
            const items = [...r.sortMenu.querySelectorAll('[data-sort]')];
            const at = items.indexOf(document.activeElement);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
            } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                items[e.key === 'Home' ? 0 : items.length - 1].focus();
            } else if (e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                closeSort({ focus: true });
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (at >= 0) chooseSort(items[at].dataset.sort);
            } else return;
            e.stopPropagation();
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
            /* 在档案页直接打字：聚焦检索框并带入这个字（替换掉原来的检索词） */
            typeInto: (text) => {
                r.input.focus();
                r.input.value = text;
                r.input.setSelectionRange(text.length, text.length);
                r.input.dispatchEvent(new Event('input', { bubbles: true }));
            },
            input: r.input,
            closeSort,
            get sortOpen() { return sortOpen(); },
            hasFocus: () => el.contains(document.activeElement),
            get kind() { return state.kind; },
            get query() { return state.query; },
            get count() { return state.count; },
            debug: () => ({ kind: state.kind, query: state.query, count: state.count, rows: state.rows.length, selectedRow: state.selectedRow, rendered: state.rendered.size })
        };
    };

    global.MusicArchiveList = Object.freeze({ create, KINDS, SORTS, menuKeyboard });
})(window);
