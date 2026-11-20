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
    const SCRIPT_BASE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';

    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const fileUrl = (p) => (p ? 'file://' + String(p).replace(/\\/g, '/').replace(/#/g, '%23') : '');

    const TEMPLATE = `
        <div class="archive-atmos" aria-hidden="true"></div>
        <div class="archive-hud" data-ref="hud">
            <header class="archive-brand" aria-hidden="true"><h1>VCP MUSIC</h1><div>ACOUSTIC INFORMATION</div><p><span>ARCHIVE</span><b>OS</b></p></header>
            <nav class="archive-nav">
                <button type="button" data-act="list" data-ref="listBtn" title="档案目录" aria-pressed="false"><span class="archive-glyph-list" aria-hidden="true"></span> LIST</button>
                <button type="button" data-act="search" title="检索曲目（/）"><span class="archive-glyph-search"></span> ARCHIVE INDEX <span class="archive-key">/</span></button>
                <button type="button" data-act="save" title="把选中的曲目加入歌单">＋ SAVED <span data-ref="savedN">00</span></button>
                <button type="button" data-act="now" title="定位当前播放（Ctrl+L）" aria-label="定位当前播放"><span class="archive-glyph-now">◷</span></button>
            </nav>
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
                <div class="archive-rows"><button type="button" data-act="up" aria-label="上一首">↑</button><div class="archive-ticks" data-ref="ticks" role="slider" aria-label="在这一列里的位置（可拖动）"></div><button type="button" data-act="down" aria-label="下一首">↓</button></div>
                <div class="archive-lanes"><button type="button" data-act="left" aria-label="上一个歌单">←</button><div><span>COLUMN <span data-ref="colN" class="archive-roll"></span> / <span data-ref="colT"></span></span><strong data-ref="colName"></strong></div><button type="button" data-act="right" aria-label="下一个歌单">→</button></div>
                <div class="archive-hint">← → 切换歌单 <span>／</span> ↑ ↓ 前后曲目 <span>／</span> ENTER 播放 <span>／</span> 直接打字检索</div>
                <div class="archive-powered" aria-hidden="true">POWERED BY <b>VCP</b><i></i></div>
                <footer class="archive-footer"><span><i class="archive-status-light"></i> SESSION AUTHORIZED</span><span class="archive-queue" title="正在播放的这一组">QUEUE <b data-ref="queue">全部曲目</b></span><span><span data-ref="files">0000</span> FILES <i>／</i> <span data-ref="clock">00:00:00</span></span><button type="button" data-act="classic" title="切换到经典列表视图">CLASSIC VIEW ↗</button></footer>
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

        const rebuild = ({ keep = true, track = -1 } = {}) => {
            // 曲库从空变成有歌（启动时异步读进来）：直接落到正在播放的那首
            if (state.dataRefs.length <= 0) keep = false;
            const keepId = keep && column() ? column().id : null;
            const keepIndex = keep ? selectedIndex() : track;
            const firstData = state.dataRefs.length <= 0 && tracks().length > 0;
            rebuildIndex();
            const columns = buildColumns();
            state.columns = columns;
            state.sig = Model.signature(columns);
            state.dataRefs = { playlist: app.playlist, length: tracks().length, playlists: app.customPlaylists, plSig: playlistsSig() };

            let lane = 0, row = 0;
            const placed = tracks().length ? restorePlace(columns) : null;
            const byId = !placed && keepId ? columns.findIndex((c) => c.id === keepId) : -1;
            if (placed) {
                lane = placed.lane; row = placed.row;
            } else if (byId !== -1) {
                lane = byId;
                const r = keepIndex >= 0 ? columns[byId].items.indexOf(keepIndex) : -1;
                row = r !== -1 ? r : Math.min(state.row, Math.max(0, columns[byId].items.length - 1));
            } else {
                const at = Model.locate(columns, keepIndex >= 0 ? keepIndex : app.currentTrackIndex, 0);
                if (at) { lane = at.lane; row = at.row; }
            }
            state.lane = lane;
            state.row = row;
            const col0 = columns[lane];
            if (col0 && col0.items.length) focusByColumn.set(col0.id, Model.wrap(row, col0.items.length));
            state.scene?.jump(lane, row);
            state.scene?.refreshLabels?.();
            root.classList.toggle('is-empty', tracks().length === 0);
            refs.files.textContent = pad(tracks().length, 4);
            refs.savedN.textContent = pad((app.customPlaylists || []).length);
            if (firstData && !pendingPlace && !placed) { placeSettled = true; followUntil.t = performance.now() + 4000; }
            renderHud(true);
            updatePlaying(true);
            list?.rebuild();
            syncList();
            schedulePlace();
        };

        /*
         * 上次的位置：视图（档案页、经典视图、播放页）、选中的列和那张卡，重启后回到原位，不自动播放。
         * 曲库、歌单、拼音表都是启动后陆续到的：曲库到了之后最多等 5 秒，等到那一列出现再落位；
         * 用户先动了就不再恢复。播放器自己恢复上次那首（不播放），这里只读它的 currentTrackIndex。
         */
        const PLACE_KEY = 'musicArchivePlace';
        const PLACE_WAIT = 5000;
        let pendingPlace = null;
        try {
            const p = JSON.parse(localStorage.getItem(PLACE_KEY) || 'null');
            if (p && typeof p === 'object') pendingPlace = p;
        } catch (e) { pendingPlace = null; }
        let placeDeadline = 0;
        let placeSettled = false;     // 已经落过位（或放弃了），之后才记新的位置
        const followUntil = { t: 0 }; // 没有记录时：启动后几秒内选中跟着播放器恢复的那首走
        const settlePlace = ({ stage = false } = {}) => {
            const p = pendingPlace;
            pendingPlace = null;
            placeSettled = true;
            if (stage && p && p.stage) {
                // 上次停在播放页：曲库到了、当前那首在，就回到播放页（不播放）
                setTimeout(() => {
                    if (state.destroyed || !tracks()[app.currentTrackIndex]) return;
                    if (app.stageHost && !app.stageHost.active) { try { app.stageHost.enter(); } catch (e) { /* 舞台没准备好就留在这里 */ } }
                }, 0);
            }
        };
        const restorePlace = (columns) => {
            if (!pendingPlace) return null;
            const now = performance.now();
            if (!placeDeadline) placeDeadline = now + PLACE_WAIT;
            const p = pendingPlace;
            const lane = typeof p.col === 'string' ? columns.findIndex((c) => c.id === p.col) : -1;
            const want = typeof p.path === 'string' ? Model.normalizePath(p.path) : '';
            const indexOfPath = want ? tracks().findIndex((t) => Model.normalizePath(t && t.path) === want) : -1;
            let at = null;
            if (lane !== -1) {
                const items = columns[lane].items;
                const r = indexOfPath >= 0 ? items.indexOf(indexOfPath) : -1;
                at = { lane, row: r !== -1 ? r : Math.max(0, Math.min(items.length - 1, Number(p.row) || 0)) };
            } else if (indexOfPath >= 0) {
                at = Model.locate(columns, indexOfPath, 0);
            }
            if ((at && lane !== -1) || now > placeDeadline) settlePlace({ stage: true });
            return at;
        };
        const savePlace = () => {
            if (!placeSettled || !state.columns.length || !tracks().length) return;
            const col = column();
            const t = selectedTrack();
            const place = {
                mode: state.mode,
                stage: document.body.classList.contains('music-stage-active'),
                col: col ? col.id : null,
                row: col && col.items.length ? Model.wrap(state.row, col.items.length) : 0,
                path: t ? t.path : null
            };
            try { localStorage.setItem(PLACE_KEY, JSON.stringify(place)); } catch (e) { /* 只是记住 */ }
        };
        let placeTimer = 0;
        const schedulePlace = () => { clearTimeout(placeTimer); placeTimer = setTimeout(savePlace, 400); };

        /*
         * 阵列的列：曲库够大时「全部曲目」按首字母拆成 A、B…あ行…0–9、其他几列（歌少的相邻字母合并），
         * 前面有数据时加「最近播放」「收藏」；后面是歌单和专辑。
         */
        const LETTER_SPLIT_MIN = 40;
        const LETTER_MIN_SIZE = 4;
        let letterOf = null;          // 首字母 → 列 id
        const favoritePaths = () => (Array.isArray(app.favoriteTracks) ? app.favoriteTracks : []).map((t) => (typeof t === 'string' ? t : t && t.path)).filter(Boolean);
        const buildColumns = () => {
            const base = Model.buildColumns(tracks(), app.customPlaylists);
            letterOf = null;
            // 「全部曲目」用全局顺序（和目录一致），不用扫描顺序
            const spec = sortSpec();
            if (spec) base[0].items = IndexLib.sortedIndices(searchIndex, base[0].items, spec);
            const n = tracks().length;
            if (n < LETTER_SPLIT_MIN || !spec) return base;
            const letters = IndexLib.groupColumns(searchIndex, base[0].items, { minSize: LETTER_MIN_SIZE, spec });
            letterOf = new Map();
            for (const c of letters) for (const g of c.groups) letterOf.set(g, c.id);
            const front = [];
            const recent = recentIndices();
            if (recent.length) front.push({ id: 'recent', kind: 'recent', name: '最近播放', ref: 'RECENT FILES', items: recent });
            const fav = favoritePaths();
            if (fav.length) {
                const byPath = new Map();
                tracks().forEach((t, i) => { const k = Model.normalizePath(t && t.path); if (k && !byPath.has(k)) byPath.set(k, i); });
                const items = fav.map((p) => byPath.get(Model.normalizePath(p))).filter((i) => i !== undefined);
                if (items.length) front.push({ id: 'favorite', kind: 'favorite', name: '收藏', ref: 'SAVED FILES', items });
            }
            return [...front, ...letters, ...base.slice(1)];
        };
        const columnOfGroup = (g) => (letterOf && letterOf.get(g)) || 'all';

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

        /*
         * 位置条：刻度均匀铺满整列（歌多于 12 首时每格代表一段），竖线游标停在当前位置；
         * 可以点、可以拖，拖的时候游标上方显示首字母和第几首。
         */
        const ticksReady = () => {
            if (refs.ticks.dataset.ready) return;
            refs.ticks.dataset.ready = '1';
            refs.ticks.innerHTML = Array.from({ length: TICKS }, () => '<span></span>').join('')
                + '<i class="archive-ticks-cursor"></i><b class="archive-ticks-tip" aria-hidden="true"></b>';
        };
        const tickTip = (r) => {
            const col = column();
            const index = col ? col.items[r] : -1;
            const g = index >= 0 && searchIndex ? searchIndex.group(index) : '';
            const letter = g ? (IndexLib.groupName(g) || g) : '';
            return (letter ? letter + ' · ' : '') + pad(r + 1, 3);
        };
        const renderTicks = (count, current) => {
            ticksReady();
            const n = Math.min(count, TICKS);
            const frac = count > 1 ? current / (count - 1) : 0;
            const nearest = n > 1 ? Math.round(frac * (n - 1)) : 0;
            const marks = refs.ticks.querySelectorAll('span');
            marks.forEach((m, i) => {
                const shown = i < n;
                m.hidden = !shown;
                if (!shown) return;
                m.style.left = `calc(${n > 1 ? i / (n - 1) : 0} * (100% - 14px))`;
                m.classList.toggle('on', i === nearest);
            });
            refs.ticks.style.setProperty('--pos', String(frac));
            refs.ticks.setAttribute('aria-valuemin', '1');
            refs.ticks.setAttribute('aria-valuemax', String(Math.max(1, count)));
            refs.ticks.setAttribute('aria-valuenow', String(count ? current + 1 : 0));
            refs.ticks.querySelector('.archive-ticks-tip').textContent = count ? tickTip(current) : '';
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
            if (pendingPlace && tracks().length) settlePlace();
            followUntil.t = 0;
            if (lane === state.lane && row === state.row) return;
            state.lane = lane;
            state.row = row;
            collapse();
            const col = column();
            if (col && col.items.length) focusByColumn.set(col.id, Model.wrap(row, col.items.length));
            state.scene?.select(lane, row, { pulse });
            renderHud();
            syncList();
            schedulePlace();
            kick();
        };

        /* 每一列记住上次停在第几首：换列回来时回到那一首（第一次进某列时保持行号） */
        const focusByColumn = new Map();
        const stepLane = (dl) => {
            const n = state.columns.length;
            if (!n || !dl) return;
            const lane = state.lane + dl;
            const col = state.columns[Model.wrap(lane, n)];
            const remembered = col ? focusByColumn.get(col.id) : undefined;
            let row = state.row;
            if (col && col.items.length && remembered !== undefined) {
                const m = col.items.length;
                row = remembered + m * Math.round((state.row - remembered) / m);
            }
            select(lane, row);
        };
        /* 展开选中卡：多抬一点，焦点落到 ACCESS FILE；换选中就收回 */
        let expanded = false;
        const expandSelected = () => {
            if (selectedIndex() < 0) return;
            expanded = true;
            root.classList.add('is-expanded');
            if (!document.body.classList.contains('music-stage-entering')) state.scene?.raise(0.7);
            refs.access.focus({ preventScroll: true });
            kick();
        };
        const collapse = () => {
            if (!expanded) return;
            expanded = false;
            root.classList.remove('is-expanded');
            if (!document.body.classList.contains('music-stage-entering')) state.scene?.raise();
        };

        const playSelected = ({ stage = true, group = null } = {}) => {
            const col = column();
            const index = selectedIndex();
            if (!col || index < 0) return;
            const already = index === app.currentTrackIndex && (app.isPlaying || app.playIntent);
            if (!already && group && group.items.includes(index)) {
                // 从目录的某一组点播（歌手、专辑、最近、检索结果）：队列就是看到的这一组
                const list = group.items.map((i) => tracks()[i]).filter(Boolean);
                app.currentFilteredTracks = list;
                app.filteredPlaylistSource = { type: 'archive-group', name: group.name };
                try { app.renderPlaylist?.(list); } catch (e) { /* 旧列表只是同步显示 */ }
                state.playedLane = state.lane;
                setQueueName(group.name);
                app.loadTrack(index, true);
            } else if (!already) {
                // 播放队列跟着所在的列走：全部曲目列用整个曲库，其他列用这一列的曲目
                // 按首字母拆开的列：队列是整个曲库（按首字母顺序接着放），不只这一个字母
                const queue = col.kind === 'letter' ? state.columns.filter((c) => c.kind === 'letter').flatMap((c) => c.items) : col.items;
                const list = col.kind === 'all' ? null : queue.map((i) => tracks()[i]).filter(Boolean);
                app.currentFilteredTracks = list;
                app.filteredPlaylistSource = col.kind === 'playlist' ? { type: 'playlist', name: col.name, id: col.playlistId }
                    : col.kind === 'album' ? { type: 'album', name: col.name } : null;
                try { app.renderPlaylist?.(list); } catch (e) { /* 旧列表只是同步显示，失败不影响播放 */ }
                state.playedLane = state.lane;
                setQueueName(col.kind === 'letter' || col.kind === 'all' ? '全部曲目' : col.name);
                app.loadTrack(index, true);
            }
            if (stage && app.stageHost && !app.stageHost.active) app.stageHost.enter();
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
            // 启动时播放器晚一点才恢复上次那首：用户还没动过，就直接落到那张卡（不飞过去）
            if (!pendingPlace && followUntil.t && performance.now() < followUntil.t && selectedIndex() !== app.currentTrackIndex) {
                const at0 = Model.locate(state.columns, app.currentTrackIndex, 0);
                if (at0) {
                    state.lane = at0.lane; state.row = at0.row;
                    state.scene?.jump(at0.lane, at0.row);
                    renderHud(true);
                    syncList();
                }
            }
            const at = Model.locate(state.columns, app.currentTrackIndex, Model.wrap(state.playedLane, state.columns.length || 1));
            let cell = null;
            if (at) {
                const n = state.columns.length, m = state.columns[at.lane].items.length;
                cell = { lane: at.lane + n * Math.round((state.lane - at.lane) / n), row: at.row + m * Math.round((state.row - at.row) / m) };
            }
            state.scene?.setPlaying(cell, app.isPlaying);
            list?.setPlaying(app.currentTrackIndex);
            if (recordRecent()) {
                if (letterOf) queueMicrotask(() => { if (!state.destroyed) rebuild(); });
                else if (list && list.kind === 'recent') list.rebuild();
            }
            refs.access.classList.toggle('is-playing', selectedIndex() === app.currentTrackIndex && app.isPlaying);
            kick();
        };

        // ---------- 目录列表与检索索引 ----------
        const IndexLib = global.MusicArchiveIndex;
        const ListLib = global.MusicArchiveList;
        const pinyinCache = new Map();
        const pinyinOf = () => {
            const lib = global.pinyinPro;
            if (!lib || typeof lib.pinyin !== 'function') return null;
            return (c) => {
                if (!pinyinCache.has(c)) {
                    let p = '';
                    try { p = lib.pinyin(c, { toneType: 'none' }); } catch (e) { p = ''; }
                    pinyinCache.set(c, p);
                }
                return pinyinCache.get(c);
            };
        };
        let searchIndex = null;
        const rebuildIndex = () => { searchIndex = IndexLib ? IndexLib.createIndex(tracks(), { pinyin: pinyinOf() }) : null; };

        /* 排序方式（标题、歌手、时长、添加时间）：阵列的列、目录、队列都跟着它；记在本机 */
        const SORT_KEY = 'musicArchiveSort';
        let sortMode = 'title';
        try { sortMode = localStorage.getItem(SORT_KEY) || 'title'; } catch (e) { sortMode = 'title'; }
        if (!IndexLib || !IndexLib.SORTS || !IndexLib.SORTS.includes(sortMode)) sortMode = 'title';
        const sortSpec = () => (IndexLib && searchIndex && IndexLib.sortSpec
            ? IndexLib.sortSpec(searchIndex, { mode: sortMode, tracks: tracks(), durationOf: (t) => durationOf(t) }) : null);
        const setSort = (mode) => {
            if (!IndexLib || !IndexLib.SORTS.includes(mode) || mode === sortMode) return;
            sortMode = mode;
            try { localStorage.setItem(SORT_KEY, mode); } catch (e) { /* 只是记住 */ }
            // 按新顺序重排：选中的那首留在选中，换到它在新排法里的那一列
            const keepIndex = selectedIndex();
            rebuild({ keep: false, track: keepIndex });
        };
        // 拼音表按需加载（项目已有的依赖），加载好之后重建索引，汉字才能按拼音检索和分组
        const loadPinyin = () => {
            if (global.pinyinPro || options.pinyinSrc === false) return;
            const src = options.pinyinSrc || (SCRIPT_BASE ? new URL('../../node_modules/pinyin-pro/dist/index.js', SCRIPT_BASE).href : '');
            if (!src) return;
            const tag = document.createElement('script');
            tag.src = src;
            tag.async = true;
            tag.onload = () => { if (!state.destroyed) rebuild(); }; // 汉字有了拼音，分组和检索都要重算
            tag.onerror = () => { /* 没有拼音表就只按原文检索 */ };
            document.head.appendChild(tag);
        };

        // 最近播放：记路径，最多 60 首，存在本机
        const RECENT_KEY = 'musicArchiveRecent';
        let recentPaths = [];
        try { recentPaths = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((p) => typeof p === 'string'); } catch (e) { recentPaths = []; }
        const recentIndices = () => {
            const byPath = new Map();
            tracks().forEach((t, i) => { if (t && t.path && !byPath.has(t.path)) byPath.set(t.path, i); });
            return recentPaths.map((p) => byPath.get(p)).filter((i) => i !== undefined);
        };
        let lastRecorded = null;
        const recordRecent = () => {
            const t = tracks()[app.currentTrackIndex];
            if (!t || !t.path || !app.isPlaying || t.path === lastRecorded) return false;
            lastRecorded = t.path;
            recentPaths = [t.path, ...recentPaths.filter((p) => p !== t.path)].slice(0, 60);
            try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentPaths)); } catch (e) { /* 只是方便 */ }
            return true;
        };

        // 曲目没带时长时，播放过一次就记下来（按路径，存在本机），目录里能显示
        const DURATION_KEY = 'musicArchiveDurations';
        let durations = {};
        try { durations = JSON.parse(localStorage.getItem(DURATION_KEY) || '{}') || {}; } catch (e) { durations = {}; }
        const durationOf = (t) => (t && t.path && durations[t.path]) || 0;
        const recordDuration = () => {
            const t = tracks()[app.currentTrackIndex];
            const d = Number(app.lastKnownDuration);
            if (!t || !t.path || Number(t.duration) > 0 || !(d > 0) || Math.abs((durations[t.path] || 0) - d) < 1) return;
            durations[t.path] = Math.round(d);
            const keys = Object.keys(durations);
            if (keys.length > 4000) for (const k of keys.slice(0, keys.length - 4000)) delete durations[k];
            try { localStorage.setItem(DURATION_KEY, JSON.stringify(durations)); } catch (e) { /* 只是方便 */ }
            list?.rebuild();
        };

        let list = null;
        const LIST_KEY = 'musicArchiveList';
        let listPref = null;
        try { listPref = localStorage.getItem(LIST_KEY); } catch (e) { listPref = null; }
        const isNarrow = () => refs.hud.classList.contains('narrow');
        const listOpen = () => refs.hud.classList.contains('list-open');
        const setListOpen = (open, { persist = true } = {}) => {
            if (!list) return;
            refs.hud.classList.toggle('list-open', open);
            list.el.hidden = !open;
            refs.listBtn?.setAttribute('aria-pressed', String(open));
            if (persist) { listPref = open ? '1' : '0'; try { localStorage.setItem(LIST_KEY, listPref); } catch (e) { /* 只是记住 */ } }
            if (open) { list.render(); syncList(); }
        };
        const applyListDefault = () => {
            // 宽窗口默认打开，窄窗口默认收起（用户手动开过就按记住的）
            if (listPref === '1' || listPref === '0') setListOpen(listPref === '1', { persist: false });
            else setListOpen(!isNarrow(), { persist: false });
        };

        /* 列表选中某首：在对应的列里找到它，相机飞过去 */
        const goToTrack = (i, ctx, { pulse = true } = {}) => {
            const n = state.columns.length;
            if (!n || i < 0) return;
            let lane = ctx ? state.columns.findIndex((c) => c.id === ctx) : -1;
            let row = lane >= 0 ? state.columns[lane].items.indexOf(i) : -1;
            if (row < 0) {
                const at = Model.locate(state.columns, i, Model.wrap(state.lane, n));
                if (!at) return;
                lane = at.lane; row = at.row;
            }
            const m = state.columns[lane].items.length;
            const nearLane = lane + n * Math.round((state.lane - lane) / n);
            const nearRow = row + m * Math.round((state.row - row) / m);
            fromList = true;
            select(nearLane, nearRow, { pulse });
            fromList = false;
        };
        let fromList = false;
        const syncList = () => {
            if (!list || fromList || !listOpen()) return;
            const col = column();
            list.reveal(selectedIndex(), col ? col.id : null);
        };

        const playIndex = (i, ctx, { stage, group = null }) => {
            goToTrack(i, ctx, { pulse: false });
            if (selectedIndex() !== i) return;
            playSelected({ stage, group });
        };
        /* 底部显示正在放的这一组（队列）叫什么 */
        const setQueueName = (name) => { if (refs.queue) refs.queue.textContent = name || '全部曲目'; };
        /* 定位当前播放：相机飞到那张卡，目录滚到那一行并居中 */
        const locatePlaying = () => {
            goToPlaying();
            if (list && listOpen()) {
                if (list.kind !== 'all' && !list.query) list.setKind('all');
                const col = column();
                list.reveal(app.currentTrackIndex, col ? col.id : null, { center: true });
            }
        };

        const composing = (e) => e.isComposing || e.key === 'Process' || e.keyCode === 229;
        const typeIntoSearch = (e) => {
            if (!list || composing(e) || typeof e.key !== 'string') return false;
            // 只接可见的单个字符；空格留给播放暂停
            if ([...e.key].length !== 1 || /\s/.test(e.key) || /[\u0000-\u001f\u007f]/.test(e.key)) return false;
            e.preventDefault();
            stopInertia();
            if (!listOpen()) setListOpen(true, { persist: false });
            list.typeInto(e.key);
            return true;
        };
        const openSearch = () => {
            if (!list) return;
            if (!listOpen()) setListOpen(true);
            list.focusSearch();
        };


        // ---------- 视图切换（档案页 / 经典视图） ----------
        const isShown = () => state.mode === 'archive';
        // 进播放页的过场里（music-stage-entering，最多 1.1 秒）舞台还没盖上来，继续画让选中卡的上浮看得见；
        // 开场动画（music-intro-playing）是一层不透明全屏层，期间不画
        let enteringSince = 0;
        const renderAllowed = () => {
            if (!isShown() || state.destroyed || document.hidden) return false;
            const body = document.body.classList;
            if (body.contains('music-intro-playing')) return false;
            if (!body.contains('music-stage-active')) return true;
            return body.contains('music-stage-entering') && performance.now() - enteringSince < 1100;
        };
        const shouldRender = () => Boolean(state.scene) && renderAllowed();

        const setMode = (mode, { persist = true } = {}) => {
            state.mode = mode === 'classic' ? 'classic' : 'archive';
            const on = state.mode === 'archive';
            root.hidden = !on;
            document.body.classList.toggle('music-archive-on', on);
            document.body.classList.toggle('music-archive-off', !on);
            app.isArchiveActive = on;
            if (persist) { try { localStorage.setItem(VIEW_KEY, state.mode); } catch (e) { /* 只是记住上次的视图 */ } schedulePlace(); }
            if (on) {
                app.destroyAmbientPixi?.();
                ensureScene();
                resize();
                if (dataChanged()) rebuild();
                updatePlaying(true);
                kick();
            } else {
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
        /* wave: true 时从当前选中格起一圈圈翻色（运行中切主题用）；第一次建场景直接换 */
        const applyTheme = ({ wave = false } = {}) => {
            if (!state.scene) return;
            const th = readTheme();
            state.scene.setTheme(th.colors, th.dark, wave && isShown() ? { wave: { lane: state.lane, row: state.row } } : {});
            kick();
        };
        /* 进播放页的过场期间（body.music-stage-entering）选中卡多抬一点；外部也可以直接调 raise(高度) */
        const raise = (amount) => { state.scene?.raise(amount); kick(); };
        const syncEntering = () => {
            const on = document.body.classList.contains('music-stage-entering');
            if (on) enteringSince = performance.now();
            raise(on ? 0.9 : undefined);
        };

        let sceneQuality = null;
        const ensureScene = () => {
            if (state.scene && sceneQuality === quality()) return;
            const prev = state.scene;
            const keepTarget = prev ? prev.target : { lane: state.lane, row: state.row };
            if (prev) prev.dispose();
            try {
                state.scene = (options.sceneLib || SceneLib).create({ host: root, quality: quality(), reducedMotion });
            } catch (e) {
                console.warn('[MusicArchive] 3D 场景创建失败，只显示文字：', e);
                state.scene = null;
                return;
            }
            sceneQuality = quality();
            root.insertBefore(state.scene.canvas, root.firstChild);
            bindCanvas(state.scene.canvas);
            updateLabelMask();
            // 卡面标题：近处几张卡印曲名和档案号
            state.scene.setLabeler?.((lane, row) => {
                const index = Model.cellTrack(state.columns, lane, row);
                const t = index >= 0 ? tracks()[index] : null;
                if (!t) return null;
                return { key: index + ':' + (t.path || ''), title: Model.stripExtension(t.title) || '未知标题', code: fileNumber(t, index) };
            });
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
            const wasNarrow = refs.hud.classList.contains('narrow');
            refs.hud.classList.toggle('narrow', w / sc < 1500);
            if (list && wasNarrow !== isNarrow() && listPref !== '1' && listPref !== '0') applyListDefault();
            const safe = parseFloat(getComputedStyle(document.body).getPropertyValue('--music-dock-safe-bottom')) || 0;
            refs.hud.style.setProperty('--archive-dock-lift', Math.round(safe / sc) + 'px');
            state.scene?.resize(w, h);
            updateLabelMask();
            kick();
        };
        // 说明块（档案号、曲名、ACCESS FILE）下面的卡不印标题
        const updateLabelMask = () => {
            if (!state.scene?.setLabelMask) return;
            const callout = root.querySelector('.archive-callout');
            const base = root.getBoundingClientRect();
            if (!callout || callout.offsetParent === null) { state.scene.setLabelMask([]); return; }
            const r = callout.getBoundingClientRect();
            const sc = (root.clientHeight || global.innerHeight) / DESIGN_H;
            const pad = 24 * sc;
            // 说明块右半是一条延伸到边缘的细线，只挡文字和封面那一段
            const right = Math.min(r.right, r.left + 730 * sc);
            state.scene.setLabelMask([{ left: r.left - base.left - pad, top: r.top - base.top - pad, right: right - base.left + pad, bottom: r.bottom - base.top + pad }]);
        };

        const frame = (now) => {
            state.raf = 0;
            if (!shouldRender()) return;
            const tier = state.scene.tier;
            // 静止 2 秒后降到 12 帧；一有新输入（场景被标脏）这一帧立刻画，不等下一个 12 帧的格
            const fps = state.activity.idle && !state.activity.moving ? tier.idleFps : tier.fps;
            const aim = fps ? 1000 / fps : 0;
            if (!aim || state.scene.dirty || now - state.lastDraw >= aim - 3) {
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
            // 单击侧卡只把它移到中间；再点中间那张才展开（抬高、焦点落到 ACCESS FILE）；双击或回车播放
            canvas.addEventListener('click', (e) => {
                const c = state.scene?.pick(e.clientX, e.clientY, canvas.getBoundingClientRect());
                if (!c || Model.cellTrack(state.columns, c.lane, c.row) < 0) return;
                if (c.lane === state.lane && c.row === state.row) expandSelected();
                else select(c.lane, c.row);
            });
            canvas.addEventListener('dblclick', (e) => {
                const c = state.scene?.pick(e.clientX, e.clientY, canvas.getBoundingClientRect());
                if (!c || Model.cellTrack(state.columns, c.lane, c.row) < 0) return;
                if (c.lane !== state.lane || c.row !== state.row) select(c.lane, c.row);
                playSelected();
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
        // 列里跳到第几首（0 起），保持在当前视野附近那一圈
        const goRow = (target, opts) => {
            const col = column();
            const count = col ? col.items.length : 0;
            if (!count) return;
            const current = Model.wrap(state.row, count);
            if (target !== current) select(state.lane, state.row + (target - current), opts);
        };
        // 滚轮惯性：松手后按衰减的速度再走几格
        const inertia = Model.createInertia();
        let inertiaTimer = 0, inertiaRaf = 0;
        const stopInertia = () => { inertia.stop(); clearTimeout(inertiaTimer); if (inertiaRaf) cancelAnimationFrame(inertiaRaf); inertiaRaf = 0; };
        const glide = (now) => {
            inertiaRaf = 0;
            if (state.destroyed || !isShown()) { inertia.stop(); return; }
            const n = inertia.tick(now / 1000);
            if (n) { state.scene?.touch(); select(state.lane, state.row + n, { pulse: false }); }
            if (inertia.active) inertiaRaf = requestAnimationFrame(glide);
        };
        const releaseWheel = () => {
            if (inertia.release(performance.now() / 1000) && !inertiaRaf) inertiaRaf = requestAnimationFrame(glide);
        };

        // 位置条：按下就跳，拖着走，松开停
        let scrubbing = null;
        const scrubTo = (clientX) => {
            const col = column();
            const count = col ? col.items.length : 0;
            if (!count) return;
            const rect = refs.ticks.getBoundingClientRect();
            const usable = Math.max(1, rect.width - 14);
            goRow(Model.rowAtFraction((clientX - rect.left - 7) / usable, count), { pulse: false });
        };
        refs.ticks.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            stopInertia();
            state.scene?.touch();
            scrubbing = e.pointerId;
            refs.ticks.setPointerCapture?.(e.pointerId);
            refs.ticks.classList.add('is-scrubbing');
            scrubTo(e.clientX);
        });
        refs.ticks.addEventListener('pointermove', (e) => { if (scrubbing === e.pointerId) scrubTo(e.clientX); });
        const endScrub = (e) => {
            if (scrubbing !== e.pointerId) return;
            scrubbing = null;
            refs.ticks.classList.remove('is-scrubbing');
        };
        refs.ticks.addEventListener('pointerup', endScrub);
        refs.ticks.addEventListener('pointercancel', endScrub);
        root.addEventListener('wheel', (e) => {
            if (e.target.closest && e.target.closest('input')) return;
            e.preventDefault();
            state.scene?.touch();
            const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
            const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
            // 鼠标滚轮一格就是一张（不累计余量）；触控板的小增量照常累计，惯性交给系统
            const notch = e.deltaMode !== 0 || (Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
            if (horizontal) {
                const n = notch ? Math.sign(e.shiftKey ? e.deltaY : e.deltaX) : wheelLanes((e.shiftKey ? e.deltaY : e.deltaX) * unit, e.timeStamp);
                if (n) stepLane(n);
            } else {
                const n = notch ? Math.sign(e.deltaY) : wheelRows(e.deltaY * unit, e.timeStamp);
                if (n) {
                    select(state.lane, state.row + n);
                    // 连续快速拨滚轮松手后再滑一段；触控板自己有惯性，不再叠
                    if (notch && !reducedMotion()) {
                        inertia.push(n, performance.now() / 1000);
                        clearTimeout(inertiaTimer);
                        inertiaTimer = setTimeout(releaseWheel, 90);
                    }
                }
            }
        }, { passive: false });

        root.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (btn) {
                switch (btn.dataset.act) {
                    case 'access': playSelected(); break;
                    case 'up': select(state.lane, state.row - 1); break;
                    case 'down': select(state.lane, state.row + 1); break;
                    case 'left': stepLane(-1); break;
                    case 'right': stepLane(1); break;
                    case 'search': openSearch(); break;
                    case 'list': setListOpen(!listOpen()); break;
                    case 'now': locatePlaying(); break;
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
        });
        // 别让档案页的点击把右键菜单立刻关掉
        root.addEventListener('mousedown', () => { stopInertia(); state.scene?.touch(); });
        returnBtn?.addEventListener('click', () => setMode('archive'));

        const modalOpen = () => Boolean(document.querySelector('#lyrics-fetch-modal.visible, #playlist-dialog.visible, #playlist-edit-modal.visible, .music-modal-overlay.visible, .dialog-overlay.visible, #track-context-menu.visible'));
        const onKeyDown = (e) => {
            if (!isShown() || app.isStageActive || document.body.classList.contains('music-stage-active') || e.defaultPrevented) return;
            // Ctrl+L 定位当前播放（输入框里也能用）
            if (!modalOpen() && (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); locatePlaying(); return; }
            const tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
            if (modalOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
            stopInertia();
            const next = Model.step({ lane: state.lane, row: state.row }, e.key);
            if (next) {
                e.preventDefault();
                state.scene?.touch();
                if (next.lane !== state.lane) stepLane(next.lane - state.lane);
                else select(next.lane, next.row);
                return;
            }
            if (e.key === 'Enter') {
                if (tag === 'BUTTON' && e.target.closest('#music-archive-view') && !e.target.closest('.archive-access, .archive-file-title')) return;
                e.preventDefault(); playSelected(); return;
            }
            if (e.key === '/') { e.preventDefault(); openSearch(); return; }
            // 直接打字：打开目录、聚焦检索框并带入这个字（不用先按 /）。
            // 输入法正在组字（isComposing / Process / 229）时不抢，让输入法把字交给它自己的输入框
            if (typeIntoSearch(e)) return;
            if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                const col = column();
                if (col && col.items.length) goRow(e.key === 'Home' ? 0 : col.items.length - 1);
                return;
            }
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
            const enteringChanged = cls.includes('music-stage-entering') !== lastBodyClass.includes('music-stage-entering');
            lastBodyClass = cls;
            if (themeChanged) applyTheme({ wave: true });
            if (enteringChanged) syncEntering();
            if (stageChanged) savePlace();
            if (stageChanged && !cls.includes('music-stage-active') && isShown()) {
                // 从播放页回来：旧界面的背景声纹不要重新起来
                app.destroyAmbientPixi?.();
                updatePlaying(true);
                goToPlaying();
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
            recordDuration();
        }, 1000);

        const destroy = () => {
            if (state.destroyed) return;
            clearTimeout(placeTimer);
            savePlace();
            state.destroyed = true;
            clearInterval(clockTimer);
            clearTimeout(state.coverTimer);
            stopInertia();
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

        if (ListLib && IndexLib) {
            list = ListLib.create({
                host: refs.hud,
                app,
                Index: IndexLib,
                getIndex: () => searchIndex,
                getSpec: sortSpec,
                getSort: () => sortMode,
                onSort: setSort,
                getRecent: recentIndices, durationOf,
                columnOfGroup,
                fileNumber: (t, i) => fileNumber(t, i),
                onPick: (i, ctx) => goToTrack(i, ctx),
                onPlay: (i, ctx, o) => playIndex(i, ctx, o)
            });
        }
        loadPinyin();

        let initialMode = 'archive';
        try { initialMode = localStorage.getItem(VIEW_KEY) || 'archive'; } catch (e) { /* 默认档案页 */ }
        rebuild({ keep: false });
        setMode(initialMode, { persist: false });
        applyListDefault();

        const api = {
            show: () => setMode('archive'),
            showClassic: () => setMode('classic'),
            refresh: () => rebuild(),
            select,
            playSelected,
            openSearch,
            setListOpen,
            setSort,
            get sort() { return sortMode; },
            raise,
            setThemeWave: () => applyTheme({ wave: true }),
            get list() { return list; },
            destroy,
            get mode() { return state.mode; },
            debug: () => ({
                mode: state.mode, lane: state.lane, row: state.row, columns: state.columns.map((c) => ({ id: c.id, n: c.items.length })),
                selected: selectedIndex(), rendering: Boolean(state.raf), allowed: renderAllowed(), scene: state.scene?.debug() || null
            })
        };
        app.archiveView = api;
        return api;
    };

    global.MusicArchive = Object.freeze({ init });
})(window);
