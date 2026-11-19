/*
 * 曲目档案阵列主视图：把曲库摆成 3D 档案卡阵列，文字浮在场景上。
 * 一张卡一首歌，一列一个歌单。选中、切列、检索都在这里；点「ACCESS FILE」
 * 用播放器现有的 loadTrack 播放并进入歌词舞台（播放页），Esc 退出舞台就回到这里。
 *
 * 只通过 app 上已有的函数和字段与播放器打交道：playlist、customPlaylists、
 * currentTrackIndex、isPlaying、loadTrack、playTrack、pauseTrack、renderPlaylist、
 * showContextMenu、stageHost。
 */
(function (global) {
    'use strict';

    const Model = global.MusicArchiveModel;
    const SceneLib = global.MusicArchiveScene;
    const VIEW_KEY = 'musicArchiveView';
    const DESIGN_W = 1920, DESIGN_H = 1080;
    const TICKS = 12;

    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const fileUrl = (p) => (p ? 'file://' + String(p).replace(/\\/g, '/').replace(/#/g, '%23') : '');

    const TEMPLATE = `
        <div class="archive-atmos" aria-hidden="true"></div>
        <div class="archive-hud" data-ref="hud">
            <header class="archive-brand" aria-hidden="true"><h1>VCP MUSIC</h1><div>ACOUSTIC INFORMATION</div><p><span>ARCHIVE</span><b>OS</b></p></header>
            <nav class="archive-nav">
                <button type="button" data-act="search" title="检索曲目（/）"><span class="archive-glyph-search"></span> ARCHIVE INDEX <span class="archive-key">/</span></button>
                <button type="button" data-act="save" title="把选中的曲目加入歌单">＋ SAVED <span data-ref="savedN">00</span></button>
                <button type="button" data-act="now" title="回到正在播放（Home）" aria-label="回到正在播放"><span class="archive-glyph-now">◷</span></button>
            </nav>
            <div class="archive-search" data-ref="search">
                <label for="music-archive-search-input">INDEX QUERY</label>
                <input id="music-archive-search-input" type="search" data-ref="searchInput" placeholder="标题、歌手或专辑" autocomplete="off" spellcheck="false">
                <output data-ref="searchCount"></output>
            </div>
            <div class="archive-callout">
                <div class="archive-eyebrow">TRACK DATABASE <span>／</span> <span data-ref="cat"></span></div>
                <button type="button" class="archive-file-title" data-act="access">FILE NUMBER: <span data-ref="fno"></span><span class="archive-file-open">↗</span></button>
                <div class="archive-rule"><i></i></div>
                <div class="archive-summary"><span data-ref="ftitle"></span><span data-ref="fmeta"></span></div>
                <button type="button" class="archive-access" data-act="access" data-ref="access">ACCESS FILE <span>→</span></button>
                <div class="archive-cover" data-ref="cover" aria-hidden="true"></div>
            </div>
            <div class="archive-empty">
                <h2>ARCHIVE EMPTY</h2>
                <p>曲库里还没有歌曲。添加本地文件夹或从云端导入后，这里会按歌单排成档案阵列。</p>
                <button type="button" data-act="add-local">ADD LOCAL FOLDER →</button>
                <button type="button" data-act="add-cloud">IMPORT FROM CLOUD →</button>
            </div>
            <div class="archive-bottom">
                <div class="archive-counter"><span class="archive-tiny">ARCHIVE / SELECT</span><div><span data-ref="selN" class="archive-roll"></span><i>/</i><span class="archive-count-total" data-ref="selT"></span></div></div>
                <div class="archive-rows"><button type="button" data-act="up" aria-label="上一首">↑</button><div class="archive-ticks" data-ref="ticks"></div><button type="button" data-act="down" aria-label="下一首">↓</button></div>
                <div class="archive-lanes"><button type="button" data-act="left" aria-label="上一个歌单">←</button><div><span>COLUMN <span data-ref="colN" class="archive-roll"></span> / <span data-ref="colT"></span></span><strong data-ref="colName"></strong></div><button type="button" data-act="right" aria-label="下一个歌单">→</button></div>
                <div class="archive-hint">← → 切换歌单 <span>／</span> ↑ ↓ 前后曲目 <span>／</span> ENTER 播放 <span>／</span> / 检索</div>
                <div class="archive-powered" aria-hidden="true">POWERED BY <b>VCP</b><i></i></div>
                <footer class="archive-footer"><span><i class="archive-status-light"></i> SESSION AUTHORIZED</span><span><span data-ref="files">0000</span> FILES <i>／</i> <span data-ref="clock">00:00:00</span></span><button type="button" data-act="classic" title="切换到经典列表视图">CLASSIC VIEW ↗</button></footer>
            </div>
        </div>`;

    const init = (app, options = {}) => {
        const root = options.root || document.getElementById('music-archive-view');
        if (!root || !Model || !SceneLib || app.archiveView) return null;
        root.innerHTML = TEMPLATE;
        const refs = {};
        root.querySelectorAll('[data-ref]').forEach((el) => { refs[el.dataset.ref] = el; });
        const returnBtn = document.getElementById('music-archive-return');

        const reducedQuery = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
        const reducedMotion = () => Boolean(reducedQuery && reducedQuery.matches);
        const stageConfig = global.MusicStageConfig;
        const quality = () => (stageConfig && stageConfig.get && stageConfig.get().quality) || 'standard';

        const state = {
            columns: [],
            sig: '',
            lane: 0,
            row: 0,
            searchOpen: false,
            searchQuery: '',
            beforeSearch: null,      // { id, row }
            playedLane: 0,           // 最近一次从哪一列开始播放
            mode: 'archive',
            scene: null,
            raf: 0,
            lastDraw: 0,
            activity: { animated: true, idle: false },
            destroyed: false,
            coverCache: new Map(),
            coverTimer: 0,
            playingKey: '',
            dataRefs: { playlist: null, length: -1, playlists: null, plSig: '' }
        };

        // ---------- 数据 ----------
        const tracks = () => (Array.isArray(app.playlist) ? app.playlist : []);
        const column = () => state.columns.length ? state.columns[Model.wrap(state.lane, state.columns.length)] : null;
        const selectedIndex = () => Model.cellTrack(state.columns, state.lane, state.row);
        const selectedTrack = () => tracks()[selectedIndex()] || null;
        const playlistsSig = () => (app.customPlaylists || []).map((p) => (p && p.id) + ':' + (p && p.tracks ? p.tracks.length : 0) + ':' + (p && p.name)).join('|');

        const rebuild = ({ keep = true } = {}) => {
            // 曲库从空变成有歌（启动时异步读进来）：直接落到正在播放的那首
            if (state.dataRefs.length <= 0) keep = false;
            const keepId = keep && column() ? column().id : null;
            const keepIndex = keep ? selectedIndex() : -1;
            let columns = Model.buildColumns(tracks(), app.customPlaylists);
            if (state.searchOpen && state.searchQuery) columns = [Model.searchColumn(tracks(), state.searchQuery), ...columns];
            state.columns = columns;
            state.sig = Model.signature(columns);
            state.dataRefs = { playlist: app.playlist, length: tracks().length, playlists: app.customPlaylists, plSig: playlistsSig() };

            let lane = 0, row = 0;
            const byId = keepId ? columns.findIndex((c) => c.id === keepId) : -1;
            if (byId !== -1) {
                lane = byId;
                const r = keepIndex >= 0 ? columns[byId].items.indexOf(keepIndex) : -1;
                row = r !== -1 ? r : Math.min(state.row, Math.max(0, columns[byId].items.length - 1));
            } else {
                const at = Model.locate(columns, keep && keepIndex >= 0 ? keepIndex : app.currentTrackIndex, 0);
                if (at) { lane = at.lane; row = at.row; }
            }
            state.lane = lane;
            state.row = row;
            state.scene?.jump(lane, row);
            root.classList.toggle('is-empty', tracks().length === 0);
            refs.files.textContent = pad(tracks().length, 4);
            refs.savedN.textContent = pad((app.customPlaylists || []).length);
            renderHud(true);
            updatePlaying(true);
        };

        const dataChanged = () => {
            const d = state.dataRefs;
            return d.playlist !== app.playlist || d.length !== tracks().length || d.playlists !== app.customPlaylists || d.plSig !== playlistsSig();
        };

        // ---------- HUD ----------
        const rollTo = (el, str) => {
            if (el.childElementCount !== str.length) {
                el.innerHTML = [...str].map(() => `<span class="d"><span>${'0123456789'.split('').map((n) => `<b>${n}</b>`).join('')}</span></span>`).join('');
            }
            [...el.children].forEach((c, i) => {
                const s = c.firstChild;
                const next = `translateY(-${(+str[i] || 0) * 1.1}em)`;
                if (s.style.transform !== next) s.style.transform = next;
            });
        };

        const renderTicks = (count, current) => {
            const n = Math.min(count, TICKS);
            // 歌曲多于 12 首时，刻度是当前位置附近的一段窗口
            const start = count <= TICKS ? 0 : Math.max(0, Math.min(count - TICKS, current - Math.floor(TICKS / 2)));
            if (refs.ticks.childElementCount !== n) {
                refs.ticks.innerHTML = Array.from({ length: n }, () => '<button type="button"></button>').join('');
            }
            [...refs.ticks.children].forEach((b, i) => {
                const r = start + i;
                b.dataset.row = r;
                b.classList.toggle('on', r === current);
                b.setAttribute('aria-label', `第 ${r + 1} 首`);
            });
        };

        const renderHud = (force = false) => {
            const col = column();
            if (!col) return;
            const count = col.items.length;
            const r = count ? Model.wrap(state.row, count) : 0;
            const index = selectedIndex();
            const t = tracks()[index];
            refs.cat.textContent = col.name;
            refs.fno.textContent = t ? fileNumber(t, index) : 'TRK-000';
            refs.ftitle.textContent = t ? (Model.stripExtension(t.title) || '未知标题') : (col.kind === 'search' ? '没有匹配的曲目' : '这个歌单还是空的');
            const meta = t ? [t.artist, t.album].filter(Boolean).join(' · ') : '';
            refs.fmeta.textContent = (meta || (t ? 'UNKNOWN ARTIST' : '')).toUpperCase();
            const digits = Math.max(2, String(count).length);
            rollTo(refs.selN, pad(count ? r + 1 : 0, digits));
            refs.selT.textContent = pad(count, digits);
            const lanes = state.columns.length;
            const laneDigits = Math.max(2, String(lanes).length);
            rollTo(refs.colN, pad(Model.wrap(state.lane, lanes) + 1, laneDigits));
            refs.colT.textContent = pad(lanes, laneDigits);
            refs.colName.textContent = col.name;
            renderTicks(count, r);
            refs.access.classList.toggle('is-playing', Boolean(t) && index === app.currentTrackIndex && app.isPlaying);
            refs.access.disabled = !t;
            scheduleCover(t, force);
        };

        // 档案号和列表、舞台用同一套（按路径算的稳定编号）；没有那套时退回曲库序号
        const fileNumber = (t, index) => {
            const specs = global.MusicTrackSpecs;
            const n = specs && typeof specs.fileNumber === 'function' ? specs.fileNumber(t) : '';
            if (n) return /^TRK/i.test(n) ? n : 'TRK-' + n;
            return 'TRK-' + Model.fileCode(index);
        };

        // 封面：只给选中的那张加载，停稳 120ms 后再取，同时预取前后两首
        const coverOf = (t) => (t && t.albumArt ? fileUrl(t.albumArt) : '');
        const preload = (url) => {
            if (!url || state.coverCache.has(url)) return;
            const img = new Image();
            img.decoding = 'async';
            const entry = { img, ok: null };
            img.onload = () => { entry.ok = true; };
            img.onerror = () => { entry.ok = false; };
            img.src = url;
            state.coverCache.set(url, entry);
            if (state.coverCache.size > 64) state.coverCache.delete(state.coverCache.keys().next().value);
        };
        const scheduleCover = (t, immediate) => {
            clearTimeout(state.coverTimer);
            const url = coverOf(t);
            refs.cover.classList.remove('on');
            if (!url) { refs.cover.style.backgroundImage = ''; return; }
            state.coverTimer = setTimeout(() => {
                preload(url);
                const entry = state.coverCache.get(url);
                const show = () => {
                    if (coverOf(selectedTrack()) !== url) return;
                    refs.cover.style.backgroundImage = `url("${url}")`;
                    refs.cover.classList.add('on');
                };
                if (entry.ok) show();
                else if (entry.ok === null) entry.img.addEventListener('load', show, { once: true });
                const col = column();
                if (col && col.items.length > 1) {
                    for (const d of [-2, -1, 1, 2]) preload(coverOf(tracks()[Model.cellTrack(state.columns, state.lane, state.row + d)]));
                }
            }, immediate ? 0 : 120);
        };

        // ---------- 选中与播放 ----------
        const select = (lane, row, { pulse = true } = {}) => {
            if (!state.columns.length) return;
            if (lane === state.lane && row === state.row) return;
            state.lane = lane;
            state.row = row;
            state.scene?.select(lane, row, { pulse });
            renderHud();
            kick();
        };

        const playSelected = () => {
            const col = column();
            const index = selectedIndex();
            if (!col || index < 0) return;
            const already = index === app.currentTrackIndex && (app.isPlaying || app.playIntent);
            if (!already) {
                // 播放队列跟着所在的列走：全部曲目列用整个曲库，其他列用这一列的曲目
                const list = col.kind === 'all' ? null : col.items.map((i) => tracks()[i]).filter(Boolean);
                app.currentFilteredTracks = list;
                app.filteredPlaylistSource = col.kind === 'playlist' ? { type: 'playlist', name: col.name, id: col.playlistId }
                    : col.kind === 'album' ? { type: 'album', name: col.name } : null;
                try { app.renderPlaylist?.(list); } catch (e) { /* 旧列表只是同步显示，失败不影响播放 */ }
                state.playedLane = state.lane;
                app.loadTrack(index, true);
            }
            if (app.stageHost && !app.stageHost.active) app.stageHost.enter();
        };

        const goToPlaying = () => {
            const at = Model.locate(state.columns, app.currentTrackIndex, Model.wrap(state.playedLane, state.columns.length || 1));
            if (!at) return;
            const n = state.columns.length;
            const lane = at.lane + n * Math.round((state.lane - at.lane) / n);
            const m = state.columns[at.lane].items.length;
            const row = at.row + m * Math.round((state.row - at.row) / m);
            select(lane, row);
        };

        // 正在播放那张卡：在当前视野里找最近的一格
        const updatePlaying = (force = false) => {
            const key = app.currentTrackIndex + ':' + Boolean(app.isPlaying) + ':' + state.sig;
            if (!force && key === state.playingKey) return;
            state.playingKey = key;
            const at = Model.locate(state.columns, app.currentTrackIndex, Model.wrap(state.playedLane, state.columns.length || 1));
            let cell = null;
            if (at) {
                const n = state.columns.length, m = state.columns[at.lane].items.length;
                cell = { lane: at.lane + n * Math.round((state.lane - at.lane) / n), row: at.row + m * Math.round((state.row - at.row) / m) };
            }
            state.scene?.setPlaying(cell, app.isPlaying);
            refs.access.classList.toggle('is-playing', selectedIndex() === app.currentTrackIndex && app.isPlaying);
            kick();
        };

        // ---------- 检索 ----------
        let searchTimer = 0;
        const openSearch = () => {
            if (state.searchOpen) { refs.searchInput.focus(); return; }
            state.searchOpen = true;
            state.beforeSearch = column() ? { id: column().id, row: state.row } : null;
            refs.search.classList.add('open');
            refs.searchInput.value = state.searchQuery;
            refs.searchInput.focus();
            refs.searchInput.select();
        };
        const closeSearch = () => {
            if (!state.searchOpen) return;
            state.searchOpen = false;
            state.searchQuery = '';
            refs.search.classList.remove('open');
            refs.searchCount.textContent = '';
            refs.searchInput.blur();
            const back = state.beforeSearch;
            state.beforeSearch = null;
            const keepIndex = selectedIndex();
            let columns = Model.buildColumns(tracks(), app.customPlaylists);
            state.columns = columns;
            state.sig = Model.signature(columns);
            const byId = back ? columns.findIndex((c) => c.id === back.id) : -1;
            let lane = Math.max(0, byId), row = back && byId !== -1 ? back.row : 0;
            // 在检索结果里换过选中：回到「全部曲目」里那首歌
            if (keepIndex >= 0 && Model.cellTrack(columns, lane, row) !== keepIndex) {
                const at = Model.locate(columns, keepIndex, lane);
                if (at) { lane = at.lane; row = at.row; }
            }
            state.lane = lane; state.row = row;
            state.scene?.jump(lane, row);
            renderHud(true);
            updatePlaying(true);
            kick();
        };
        const runSearch = () => {
            state.searchQuery = refs.searchInput.value.trim();
            const base = Model.buildColumns(tracks(), app.customPlaylists);
            state.columns = state.searchQuery ? [Model.searchColumn(tracks(), state.searchQuery), ...base] : base;
            state.sig = Model.signature(state.columns);
            const hits = state.searchQuery ? state.columns[0].items.length : 0;
            refs.searchCount.textContent = state.searchQuery ? pad(hits) + ' HIT' : '';
            if (state.searchQuery) {
                state.lane = 0; state.row = 0;
                state.scene?.jump(0, 0);
            } else {
                const at = state.beforeSearch ? state.columns.findIndex((c) => c.id === state.beforeSearch.id) : 0;
                state.lane = Math.max(0, at); state.row = state.beforeSearch ? state.beforeSearch.row : 0;
                state.scene?.jump(state.lane, state.row);
            }
            renderHud(true);
            updatePlaying(true);
            kick();
        };
        refs.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(runSearch, 120);
        });
        refs.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); }
            else if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchTimer); runSearch(); refs.searchInput.blur(); if (e.ctrlKey || e.metaKey) playSelected(); }
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); clearTimeout(searchTimer); if (refs.searchInput.value.trim() !== state.searchQuery) runSearch(); refs.searchInput.blur(); select(state.lane, state.row + (e.key === 'ArrowDown' ? 1 : -1)); }
        });

        // ---------- 视图切换（档案页 / 经典视图） ----------
        const isShown = () => state.mode === 'archive';
        const shouldRender = () => isShown() && !state.destroyed && !document.hidden && !document.body.classList.contains('music-stage-active') && state.scene;

        const setMode = (mode, { persist = true } = {}) => {
            state.mode = mode === 'classic' ? 'classic' : 'archive';
            const on = state.mode === 'archive';
            root.hidden = !on;
            document.body.classList.toggle('music-archive-on', on);
            document.body.classList.toggle('music-archive-off', !on);
            app.isArchiveActive = on;
            if (persist) { try { localStorage.setItem(VIEW_KEY, state.mode); } catch (e) { /* 只是记住上次的视图 */ } }
            if (on) {
                app.destroyAmbientPixi?.();
                ensureScene();
                resize();
                if (dataChanged()) rebuild();
                updatePlaying(true);
                kick();
            } else {
                closeSearch();
                if (!app.isStageActive) originalCreateAmbient?.();
                app.visualizerCanvas && (app.visualizerCanvas.width = app.visualizerCanvas.clientWidth);
            }
        };

        // 档案页显示时，旧界面的背景声纹不需要画
        const originalCreateAmbient = app.createAmbientPixi;
        if (typeof originalCreateAmbient === 'function') {
            app.createAmbientPixi = (...args) => (app.isArchiveActive ? undefined : originalCreateAmbient(...args));
        }

        // ---------- 场景与渲染循环 ----------
        const readTheme = () => {
            const cs = getComputedStyle(document.body);
            const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
            return {
                colors: {
                    paper: v('--ar-paper', '#11181b'),
                    card: v('--ar-card', '#3b4448'),
                    floor: v('--ar-floor', '#192125'),
                    badge: v('--ar-badge', '#5d676b'),
                    groove: v('--ar-groove', '#4a5559'),
                    font: v('--mt-font-archive', 'sans-serif')
                },
                dark: !document.body.classList.contains('light-theme')
            };
        };
        const applyTheme = () => {
            if (!state.scene) return;
            const th = readTheme();
            state.scene.setTheme(th.colors, th.dark);
            kick();
        };

        let sceneQuality = null;
        const ensureScene = () => {
            if (state.scene && sceneQuality === quality()) return;
            const prev = state.scene;
            const keepTarget = prev ? prev.target : { lane: state.lane, row: state.row };
            if (prev) prev.dispose();
            try {
                state.scene = SceneLib.create({ host: root, quality: quality(), reducedMotion });
            } catch (e) {
                console.warn('[MusicArchive] 3D 场景创建失败，只显示文字：', e);
                state.scene = null;
                return;
            }
            sceneQuality = quality();
            root.insertBefore(state.scene.canvas, root.firstChild);
            bindCanvas(state.scene.canvas);
            applyTheme();
            resize();
            state.scene.jump(keepTarget.lane, keepTarget.row);
            updatePlaying(true);
        };

        const resize = () => {
            const w = root.clientWidth || global.innerWidth;
            const h = root.clientHeight || global.innerHeight;
            const sc = h / DESIGN_H;
            refs.hud.style.width = (w / sc) + 'px';
            refs.hud.style.transform = `scale(${sc})`;
            refs.hud.classList.toggle('narrow', w / sc < 1500);
            const safe = parseFloat(getComputedStyle(document.body).getPropertyValue('--music-dock-safe-bottom')) || 0;
            refs.hud.style.setProperty('--archive-dock-lift', Math.round(safe / sc) + 'px');
            state.scene?.resize(w, h);
            kick();
        };

        const frame = (now) => {
            state.raf = 0;
            if (!shouldRender()) return;
            const tier = state.scene.tier;
            const fps = state.activity.idle && !state.activity.moving ? tier.idleFps : tier.fps;
            const aim = fps ? 1000 / fps : 0;
            if (!aim || now - state.lastDraw >= aim - 3) {
                state.lastDraw = now;
                state.activity = state.scene.step(now);
            }
            if (state.activity.animated || state.scene.dirty) state.raf = requestAnimationFrame(frame);
        };
        const kick = () => {
            if (!state.raf && shouldRender()) state.raf = requestAnimationFrame(frame);
        };

        // ---------- 输入 ----------
        let pendingPick = null;
        let pickRaf = 0;
        const bindCanvas = (canvas) => {
            canvas.addEventListener('pointermove', (e) => {
                const rect = canvas.getBoundingClientRect();
                state.scene?.setPointer((e.clientX - rect.left) / rect.width * 2 - 1, (e.clientY - rect.top) / rect.height * 2 - 1);
                pendingPick = { x: e.clientX, y: e.clientY, rect };
                if (!pickRaf) {
                    pickRaf = requestAnimationFrame(() => {
                        pickRaf = 0;
                        if (!pendingPick || !state.scene) return;
                        const c = state.scene.pick(pendingPick.x, pendingPick.y, pendingPick.rect);
                        state.scene.setHover(c);
                        canvas.style.cursor = c && Model.cellTrack(state.columns, c.lane, c.row) >= 0 ? 'pointer' : '';
                    });
                }
                kick();
            });
            canvas.addEventListener('pointerleave', () => { pendingPick = null; state.scene?.setHover(null); kick(); });
            canvas.addEventListener('click', (e) => {
                const c = state.scene?.pick(e.clientX, e.clientY, canvas.getBoundingClientRect());
                if (!c || Model.cellTrack(state.columns, c.lane, c.row) < 0) return;
                if (c.lane === state.lane && c.row === state.row) playSelected();
                else select(c.lane, c.row);
            });
            canvas.addEventListener('contextmenu', (e) => {
                const c = state.scene?.pick(e.clientX, e.clientY, canvas.getBoundingClientRect());
                const index = c ? Model.cellTrack(state.columns, c.lane, c.row) : -1;
                if (index < 0) return;
                e.preventDefault();
                if (c.lane !== state.lane || c.row !== state.row) select(c.lane, c.row);
                app.contextMenuTrackIndex = index;
                app.showContextMenu?.(e.clientX, e.clientY);
            });
        };

        const wheelRows = Model.createWheel(60);
        const wheelLanes = Model.createWheel(90);
        root.addEventListener('wheel', (e) => {
            if (e.target.closest && e.target.closest('input')) return;
            e.preventDefault();
            state.scene?.touch();
            const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
            const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
            if (horizontal) {
                const n = wheelLanes((e.shiftKey ? e.deltaY : e.deltaX) * unit, e.timeStamp);
                if (n) select(state.lane + n, state.row);
            } else {
                const n = wheelRows(e.deltaY * unit, e.timeStamp);
                if (n) select(state.lane, state.row + n);
            }
        }, { passive: false });

        root.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (btn) {
                switch (btn.dataset.act) {
                    case 'access': playSelected(); break;
                    case 'up': select(state.lane, state.row - 1); break;
                    case 'down': select(state.lane, state.row + 1); break;
                    case 'left': select(state.lane - 1, state.row); break;
                    case 'right': select(state.lane + 1, state.row); break;
                    case 'search': state.searchOpen ? closeSearch() : openSearch(); break;
                    case 'now': goToPlaying(); break;
                    case 'classic': setMode('classic'); break;
                    case 'add-local': document.getElementById('add-folder-btn')?.click(); break;
                    case 'add-cloud': document.getElementById('add-webdav-btn')?.click(); break;
                    case 'save': {
                        const index = selectedIndex();
                        if (index < 0) break;
                        const r = btn.getBoundingClientRect();
                        app.contextMenuTrackIndex = index;
                        app.showContextMenu?.(r.left, r.bottom + 8);
                        break;
                    }
                    default: break;
                }
                e.stopPropagation();
                return;
            }
            const tick = e.target.closest('.archive-ticks button');
            if (tick) {
                const col = column();
                const count = col ? col.items.length : 0;
                const current = count ? Model.wrap(state.row, count) : 0;
                select(state.lane, state.row + (Number(tick.dataset.row) - current));
            }
        });
        // 别让档案页的点击把右键菜单立刻关掉
        root.addEventListener('mousedown', () => state.scene?.touch());
        returnBtn?.addEventListener('click', () => setMode('archive'));

        const modalOpen = () => Boolean(document.querySelector('#lyrics-fetch-modal.visible, #playlist-dialog.visible, #playlist-edit-modal.visible, .music-modal-overlay.visible, .dialog-overlay.visible, #track-context-menu.visible'));
        const onKeyDown = (e) => {
            if (!isShown() || app.isStageActive || document.body.classList.contains('music-stage-active') || e.defaultPrevented) return;
            const tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
            if (modalOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
            const next = Model.step({ lane: state.lane, row: state.row }, e.key);
            if (next) { e.preventDefault(); state.scene?.touch(); select(next.lane, next.row); return; }
            if (e.key === 'Enter') {
                if (tag === 'BUTTON' && e.target.closest('#music-archive-view') && !e.target.closest('.archive-access, .archive-file-title')) return;
                e.preventDefault(); playSelected(); return;
            }
            if (e.key === '/') { e.preventDefault(); openSearch(); return; }
            if (e.key === 'Escape' && state.searchOpen) { e.preventDefault(); closeSearch(); return; }
            if (e.key === 'Home') { e.preventDefault(); goToPlaying(); return; }
            if (e.code === 'Space' && tag !== 'BUTTON') {
                e.preventDefault();
                app.isPlaying ? app.pauseTrack?.() : app.playTrack?.();
            }
        };
        document.addEventListener('keydown', onKeyDown);

        // ---------- 外部状态 ----------
        const onResize = () => resize();
        global.addEventListener('resize', onResize);
        const onVisibility = () => { if (!document.hidden) { state.lastDraw = 0; kick(); } };
        document.addEventListener('visibilitychange', onVisibility);
        // 主题（light-theme）、舞台进出（music-stage-active）、底栏高度（body 上的变量）都挂在 body 上
        let lastBodyClass = document.body.className;
        const bodyObserver = new MutationObserver(() => {
            const cls = document.body.className;
            const themeChanged = cls.includes('light-theme') !== lastBodyClass.includes('light-theme');
            const stageChanged = cls.includes('music-stage-active') !== lastBodyClass.includes('music-stage-active');
            lastBodyClass = cls;
            if (themeChanged) applyTheme();
            if (stageChanged && !cls.includes('music-stage-active') && isShown()) {
                // 从播放页回来：旧界面的背景声纹不要重新起来
                app.destroyAmbientPixi?.();
                updatePlaying(true);
                if (!state.searchOpen) goToPlaying();
            }
            resize();
            kick();
        });
        bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
        const unsubscribeQuality = stageConfig && stageConfig.subscribe ? stageConfig.subscribe(() => { if (isShown()) { ensureScene(); kick(); } }) : null;
        reducedQuery?.addEventListener?.('change', () => kick());

        const clockTimer = setInterval(() => {
            refs.clock.textContent = new Date().toTimeString().slice(0, 8);
            if (!isShown()) return;
            if (dataChanged()) rebuild();
            updatePlaying();
        }, 1000);

        const destroy = () => {
            if (state.destroyed) return;
            state.destroyed = true;
            clearInterval(clockTimer);
            clearTimeout(state.coverTimer);
            clearTimeout(searchTimer);
            if (state.raf) cancelAnimationFrame(state.raf);
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('visibilitychange', onVisibility);
            global.removeEventListener('resize', onResize);
            bodyObserver.disconnect();
            if (typeof unsubscribeQuality === 'function') unsubscribeQuality();
            state.scene?.dispose();
            state.scene = null;
            if (originalCreateAmbient) app.createAmbientPixi = originalCreateAmbient;
        };
        global.addEventListener('beforeunload', destroy, { once: true });

        let initialMode = 'archive';
        try { initialMode = localStorage.getItem(VIEW_KEY) || 'archive'; } catch (e) { /* 默认档案页 */ }
        rebuild({ keep: false });
        setMode(initialMode, { persist: false });

        const api = {
            show: () => setMode('archive'),
            showClassic: () => setMode('classic'),
            refresh: () => rebuild(),
            select,
            playSelected,
            openSearch,
            closeSearch,
            destroy,
            get mode() { return state.mode; },
            debug: () => ({
                mode: state.mode, lane: state.lane, row: state.row, columns: state.columns.map((c) => ({ id: c.id, n: c.items.length })),
                selected: selectedIndex(), rendering: Boolean(state.raf), scene: state.scene?.debug() || null
            })
        };
        app.archiveView = api;
        return api;
    };

    global.MusicArchive = Object.freeze({ init });
})(window);
