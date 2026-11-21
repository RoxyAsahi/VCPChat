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
    // 窗口再矮，界面也不缩到这个比例以下（小字 11px 缩完还有 10px 左右）；矮窗口改成少显示，不是缩小
    const MIN_SCALE = 0.9;
    const TICKS = 12;
    const SCRIPT_BASE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';

    const pad = (n, w = 2) => String(n).padStart(w, '0');
    // 和 music-utils 的 app.fileUrl 一样：路径里的空格、#、?、'、% 都要编码，否则封面断图
    const fileUrl = (path) => {
        if (!path) return '';
        const p = String(path).replace(/\\/g, '/');
        return 'file://' + encodeURI(p.startsWith('/') ? p : '/' + p).replace(/[?#']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    };

    const TEMPLATE = `
        <div class="archive-atmos" aria-hidden="true"></div>
        <div class="archive-tip" data-ref="tip" aria-hidden="true"><b></b><span></span></div>
        <div class="archive-hud" data-ref="hud">
            <header class="archive-brand"><h1 data-ref="ctxName">曲库</h1><div data-ref="ctxSub"></div><button type="button" class="archive-brand-play" data-act="play-col" data-ref="playCol">播放这一组 <span aria-hidden="true">→</span></button><button type="button" class="archive-brand-resume" data-act="resume" data-ref="resume" hidden><span data-ref="resumeLabel">接着听</span> <b data-ref="resumeName"></b> <span data-ref="resumeAt"></span></button></header>
            <nav class="archive-nav">
                <button type="button" data-act="list" data-ref="listBtn" title="显示或收起左侧目录" aria-pressed="false"><span class="archive-glyph-list" aria-hidden="true"></span> 目录</button>
                <button type="button" data-act="search" title="检索曲目（/，或直接打字）"><span class="archive-glyph-search" aria-hidden="true"></span> 检索 <span class="archive-key" aria-hidden="true">/</span></button>
                <button type="button" data-act="save" title="把选中的曲目加入歌单">＋ 加入歌单</button>
                <button type="button" data-act="lyrics" data-ref="lyricsBtn" title="歌词面板（选好歌播放后自动打开，浏览别的歌时收起）" aria-pressed="false">歌词</button>
                <button type="button" data-act="controls" title="音效、舞台与播放设置">设置 <span aria-hidden="true">↗</span></button>
                <button type="button" data-act="now" title="回到正在播放的曲目（Ctrl+L）"><span class="archive-glyph-now" aria-hidden="true">◷</span> 正在播放</button>
            </nav>
            <div class="archive-callout">
                <div class="archive-eyebrow"><span data-ref="cat"></span><span data-ref="catPos"></span></div>
                <button type="button" class="archive-file-title" data-act="open-detail" title="查看曲目详情"><span data-ref="ftitle"></span><span class="archive-file-open" aria-hidden="true">↗</span></button>
                <div class="archive-rule"><i></i></div>
                <div class="archive-summary"><span data-ref="fmeta"></span><span data-ref="fspec"></span></div>
                <div class="archive-callout-acts"><button type="button" class="archive-access" data-act="access" data-ref="access" title="播放并进入歌词舞台（回车）">播放 <span aria-hidden="true">→</span></button><button type="button" class="archive-more" data-act="open-detail">详情 <span aria-hidden="true">↗</span></button></div>
                <div class="archive-cover" data-ref="cover" data-act="open-detail" title="查看曲目详情" aria-hidden="true"></div>
            </div>
            <section class="archive-detail" data-ref="detail" role="dialog" aria-label="曲目详情" aria-hidden="true" inert>
                <button type="button" class="archive-detail-back" data-act="detail-close">← 返回曲库 <span class="archive-key">Esc</span></button>
                <div class="archive-detail-card">
                    <div class="archive-detail-head"><b data-ref="dNo"></b><span data-ref="dWhere"></span><span data-ref="dSpec" class="archive-detail-spec"></span></div>
                    <div class="archive-detail-album" data-ref="dAlbum"></div>
                    <div class="archive-detail-titlerow"><h2 data-ref="dTitle"></h2><button type="button" class="archive-detail-like" data-act="d-like" data-ref="dLike" aria-pressed="false" title="喜欢" aria-label="喜欢" hidden><span aria-hidden="true">♡</span></button></div>
                    <div class="archive-detail-artist" data-ref="dArtist"></div>
                    <div class="archive-detail-actions">
                        <button type="button" class="is-primary" data-act="d-play" data-ref="dPlay"><i aria-hidden="true">▶</i><span data-ref="dPlayText">播放</span></button>
                        <button type="button" data-act="d-next"><i aria-hidden="true">▷</i>下一首播放</button>
                        <button type="button" data-act="d-queue"><i aria-hidden="true">＋</i>加入队列</button>
                        <button type="button" data-act="d-playlist"><i aria-hidden="true">＋</i>加入歌单</button>
                        <button type="button" data-act="d-artist" data-ref="dArtistBtn"><i aria-hidden="true">↗</i>这位歌手的歌</button>
                        <button type="button" data-act="d-lyrics"><i aria-hidden="true">≡</i>获取歌词</button>
                    </div>
                    <dl class="archive-detail-meta">
                        <div><dt>专辑</dt><dd data-ref="dAlbum2"></dd></div>
                        <div><dt>时长</dt><dd data-ref="dDur"></dd></div>
                        <div><dt>格式</dt><dd data-ref="dFmt"></dd></div>
                        <div><dt>所在分组</dt><dd data-ref="dGroup"></dd></div>
                        <div class="wide"><dt>文件位置</dt><dd data-ref="dPath"></dd></div>
                    </dl>
                    <div class="archive-detail-more" data-ref="dMoreWrap">
                        <div class="archive-detail-more-head" data-ref="dMoreHead">同专辑</div>
                        <ol data-ref="dMore"></ol>
                    </div>
                </div>
            </section>
            <div class="archive-empty" role="status">
                <h2 data-ref="emptyTitle">曲库是空的</h2>
                <p data-ref="emptyText"></p>
                <div class="archive-scan-bar" aria-hidden="true"><i data-ref="scanBar"></i></div>
                <button type="button" data-act="add-local">添加音乐文件夹 <span aria-hidden="true">→</span></button>
                <button type="button" data-act="add-cloud">从云端导入 <span aria-hidden="true">→</span></button>
            </div>
            <div class="archive-bottom">
                <div class="archive-counter"><span class="archive-tiny">这一组里的位置</span><div><span data-ref="selN" class="archive-roll"></span><i>/</i><span class="archive-count-total" data-ref="selT"></span></div></div>
                <div class="archive-rows"><button type="button" data-act="up" aria-label="上一首">↑</button><div class="archive-ticks" data-ref="ticks" role="slider" aria-label="在这一列里的位置（可拖动）"></div><button type="button" data-act="down" aria-label="下一首">↓</button></div>
                <div class="archive-lanes"><button type="button" data-act="left" aria-label="上一个歌单">←</button><div><span>分组 <span data-ref="colN" class="archive-roll"></span> / <span data-ref="colT"></span></span><strong data-ref="colName"></strong></div><button type="button" data-act="right" aria-label="下一个歌单">→</button></div>
                <div class="archive-hint">← → 切换分组 <span>／</span> ↑ ↓ 前后曲目 <span>／</span> 回车 播放 <span>／</span> 点中间的卡 看详情 <span>／</span> 直接打字检索</div>
                <footer class="archive-footer"><span class="archive-status" role="status"><i class="archive-status-light"></i> <span data-ref="status"></span></span><span class="archive-queue" title="播放队列来自哪一组">正在播放 <b data-ref="queue">全部曲目</b></span><span>曲库 <span data-ref="files">0</span> 首</span><button type="button" data-act="classic" title="切换到经典列表视图">经典视图 ↗</button></footer>
            </div>
        </div>`;

    const init = (app, options = {}) => {
        const root = options.root || document.getElementById('music-archive-view');
        if (!root || !Model || !SceneLib || app.archiveView) return null;
        root.innerHTML = TEMPLATE;
        const refs = {};
        root.querySelectorAll('[data-ref]').forEach((el) => { refs[el.dataset.ref] = el; });
        const returnBtn = document.getElementById('music-archive-return');

        // 降低动态：读设置里的统一开关（跟随系统 / 开 / 关）；没有那个模块时退回系统设置
        const reducedQuery = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
        const reducedMotion = () => {
            const m = global.MusicMotion;
            if (m && typeof m.reduced === 'function') return Boolean(m.reduced());
            return Boolean(reducedQuery && reducedQuery.matches);
        };
        // 样式只认 body.music-reduce-motion；统一开关不在时由这里按系统设置挂上
        const syncMotionClass = () => { if (!global.MusicMotion) document.body.classList.toggle('music-reduce-motion', reducedMotion()); };
        syncMotionClass();
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
            dirCovers: new Map(),
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

        let listTimer = 0;
        /*
         * 「曲库为空」要等一等再说：窗口刚打开时曲库还在读（通常几百毫秒），这时不显示空状态和添加入口，免得每次启动闪一下；
         * 过了这段时间还是没有歌才显示。大曲库分片重建期间（已经知道有歌，只是还没排好）也不显示，左下角写 LOADING。
         */
        const BOOT_HOLD = 1500;
        const bootUntil = performance.now() + BOOT_HOLD;
        let bootTimer = 0;
        const applyEmpty = (preparing = false) => {
            const empty = !preparing && tracks().length === 0;
            const holding = preparing || (empty && performance.now() < bootUntil && !root.classList.contains('is-scanning'));
            root.classList.toggle('is-empty', empty && !holding);
            root.classList.toggle('is-loading', holding);
            if (holding && refs.status && !root.classList.contains('is-scanning')) refs.status.textContent = preparing ? '正在整理 ' + tracks().length + ' 首曲目' : '正在读取曲库';
            else if (!holding && refs.status && /^正在(读取|整理)/.test(refs.status.textContent)) refs.status.textContent = '';
            clearTimeout(bootTimer);
            if (holding && !preparing) bootTimer = setTimeout(() => { if (!state.destroyed) applyEmpty(); }, Math.max(0, bootUntil - performance.now()) + 20);
        };
        const rebuild = ({ keep = true, track = -1, reindex = true, prepared = null, laterList = false, steady = false } = {}) => {
            // 曲库从空变成有歌（启动时异步读进来）：直接落到正在播放的那首
            if (state.dataRefs.length <= 0) keep = false;
            const keepId = keep && column() ? column().id : null;
            const keepKind = keep && column() ? column().kind : null;
            let keepIndex = keep ? selectedIndex() : track;
            // 选中的那首按路径认：曲库变了以后（扫描途中追加、扫完重排）下标会变，路径不会
            if (keep && state.selPath) {
                const k = pathIndex().get(Model.normalizePath(state.selPath));
                if (k !== undefined) keepIndex = k;
            }
            if (state.dataRefs.length <= 0) steady = false;
            const firstData = state.dataRefs.length <= 0 && tracks().length > 0;
            // 只换排序时曲库没变，检索索引（拼音、罗马音）不用重建
            if (prepared && prepared.index && prepared.list === app.playlist && prepared.index.size === tracks().length) searchIndex = prepared.index;
            else if (reindex || !searchIndex || searchIndex.size !== tracks().length) rebuildIndex();
            const columns = buildColumns(prepared);
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
                // 原来那一列没了（歌变多以后首字母列会拆开或改名）：先在同一类的列里找这首歌
                let at = null;
                if (keepKind && keepIndex >= 0) {
                    const l = columns.findIndex((c) => c.kind === keepKind && c.items.includes(keepIndex));
                    if (l !== -1) at = { lane: l, row: columns[l].items.indexOf(keepIndex) };
                }
                at = at || Model.locate(columns, keepIndex >= 0 ? keepIndex : app.currentTrackIndex, 0);
                if (at) { lane = at.lane; row = at.row; }
            }
            state.lane = lane;
            state.row = row;
            const col0 = columns[lane];
            if (col0 && col0.items.length) focusByColumn.set(col0.id, Model.wrap(row, col0.items.length));
            state.scene?.jump(lane, row);
            state.scene?.refreshLabels?.();
            applyEmpty();
            refs.files.textContent = String(tracks().length);
            if (firstData && !pendingPlace && !placed) { placeSettled = true; followUntil.t = performance.now() + 4000; }
            renderHud(true);
            updatePlaying(true);
            // 大曲库分片重建时，目录（两万行的分组和排序）放到下一片再排
            if (laterList && list) { clearTimeout(listTimer); listTimer = setTimeout(() => { listTimer = 0; if (state.destroyed) return; list.rebuild({ steady }); syncList(steady); }, 0); }
            else { clearTimeout(listTimer); listTimer = 0; list?.rebuild({ steady }); syncList(steady); }
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
        // 路径（归一化后）→ 曲库下标，同一份曲库只建一次；建列、最近播放、收藏都用它
        let pathMemo = { list: null, n: -1, map: new Map() };
        const pathIndex = () => {
            if (pathMemo.list !== app.playlist || pathMemo.n !== tracks().length) pathMemo = { list: app.playlist, n: tracks().length, map: Model.pathIndex(tracks()) };
            return pathMemo.map;
        };
        /* 算出各列和「首字母 → 列」的对照，不改任何状态（分片重建时可以提前算好） */
        const computeColumns = (index) => {
            const base = Model.buildColumns(tracks(), app.customPlaylists, { indexByPath: pathIndex() });
            let letters0 = null;
            // 「全部曲目」用全局顺序（和目录一致），不用扫描顺序
            const spec = sortSpecFor(index);
            if (spec) base[0].items = IndexLib.sortedIndices(index, base[0].items, spec);
            const n = tracks().length;
            if (n < LETTER_SPLIT_MIN || !spec) return { columns: base, letterOf: null };
            const letters = IndexLib.groupColumns(index, base[0].items, { minSize: LETTER_MIN_SIZE, spec });
            letters0 = new Map();
            for (const c of letters) for (const g of c.groups) letters0.set(g, c.id);
            const front = [];
            // 每日推荐（按听歌记录和喜欢挑的 30 首，一天内固定）：放在最前面一列，和最近播放、收藏一样是一组卡
            const daily = dailyIndices();
            if (daily.length) front.push({ id: 'daily', kind: 'daily', name: '每日推荐', ref: 'DAILY', items: daily });
            const recent = recentIndices();
            if (recent.length) front.push({ id: 'recent', kind: 'recent', name: '最近播放', ref: 'RECENT FILES', items: recent });
            const fav = favoritePaths();
            if (fav.length) {
                const byPath = pathIndex();
                const items = fav.map((p) => byPath.get(Model.normalizePath(p))).filter((i) => i !== undefined);
                if (items.length) front.push({ id: 'favorite', kind: 'favorite', name: '收藏', ref: 'SAVED FILES', items });
            }
            return { columns: [...front, ...letters, ...base.slice(1)], letterOf: letters0 };
        };
        const dailyIndices = () => {
            let mix = [];
            try { mix = typeof app.dailyMix === 'function' ? app.dailyMix() || [] : []; } catch (e) { mix = []; }
            if (!mix.length) return [];
            const byPath = pathIndex();
            return mix.map((t) => byPath.get(Model.normalizePath(t && t.path))).filter((i) => i !== undefined);
        };
        // 每日推荐跨天会换：日期也算进列的指纹
        const dailyKey = () => (typeof app.dailyMix === 'function' ? new Date().toISOString().slice(0, 10) : '');
        const columnsKey = () => dailyKey() + '\n' + sortMode + '\n' + playlistsSig() + '\n' + recentPaths.join('|') + '\n' + favoritePaths().join('|');
        const buildColumns = (prepared = null) => {
            const out = prepared && prepared.cols && prepared.colsKey === columnsKey() && prepared.index === searchIndex ? prepared.cols : computeColumns(searchIndex);
            letterOf = out.letterOf;
            return out.columns;
        };
        const columnOfGroup = (g) => (letterOf && letterOf.get(g)) || 'all';

        /*
         * 扫描曲库的过程：主进程先报总数、再逐首报进度、扫完才把曲目一次交过来，
         * 所以这里显示的是进度（空曲库时占中间的位置，有歌时写在左下角状态里），阵列在扫完那一刻换上新曲库。
         */
        const EMPTY_TEXT = '曲库里还没有歌曲。添加本地文件夹或从云端导入后，这里会按首字母和歌单排成档案阵列。';
        const scan = { active: false, current: 0, total: 0, timer: 0 };
        const renderScan = () => {
            root.classList.toggle('is-scanning', scan.active);
            const total = scan.total;
            // 不补零（0437 这种是装饰写法）；数字等宽，跳动时宽度不变
            const progress = total ? Math.max(0, Math.round(scan.current)) + ' / ' + total : '';
            refs.emptyTitle.textContent = scan.active ? '正在扫描曲库' : '曲库是空的';
            refs.emptyText.textContent = scan.active
                ? (total ? '正在读取曲目信息 ' + progress + '，读完后这里会排成档案阵列。' : '正在查找音乐文件…')
                : EMPTY_TEXT;
            refs.scanBar.style.transform = `scaleX(${total ? Math.min(1, scan.current / total) : 0})`;
            if (scan.active) refs.status.textContent = total ? '扫描中 ' + progress : '正在查找音乐文件';
            else if (!scan.timer) refs.status.textContent = '';
        };
        const setScan = (next) => {
            Object.assign(scan, next);
            renderScan();
            if (root.classList.contains('is-loading') && tracks().length === 0) applyEmpty();
        };
        const scanDone = (data) => {
            const got = Array.isArray(data) ? data.length : (data && Array.isArray(data.tracks) ? data.tracks.length : 0);
            clearTimeout(scan.timer);
            setScan({ active: false });
            refs.status.textContent = got ? '扫描完成，共 ' + got + ' 首' : '扫描完成，没有找到音乐文件';
            scan.timer = setTimeout(() => { scan.timer = 0; renderScan(); }, 4000);
        };
        let growTimer = 0;
        const scanOff = [
            app.api?.onMusicScanStart?.((data) => setScan({ active: true, current: 0, total: Number(data && data.total) || 0 })),
            app.api?.onMusicScanProgress?.((data) => setScan({ active: true, current: Number(data && data.current) || 0, total: Number(data && data.total) || scan.total })),
            app.api?.onMusicScanComplete?.(scanDone),
            // 扫描途中播放器会把新读到的曲目一批批接到曲库末尾：阵列和目录跟着长（歌多时隔久一点再排）。
            // 旧的主进程不发这个事件，那就和以前一样扫完一次换上。
            app.api?.onMusicScanBatch?.(() => {
                if (growTimer) return;
                growTimer = setTimeout(() => { growTimer = 0; if (!state.destroyed && isShown() && dataChanged()) rebuildSoon(); }, tracks().length > 5000 ? 1500 : 500);
            })
        ];
        renderScan();

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
        /* 位置条上的流体小滴：底栏的通用模块在时才用，没有就还是竖线游标 */
        let tickMarker = null;
        let tickDropAt = null;
        const tickDrop = () => {
            if (tickMarker || typeof global.createMusicFluidMarker !== 'function') return tickMarker;
            tickMarker = global.createMusicFluidMarker(refs.ticks, { axis: 'x', thickness: 7, align: 'center' });
            if (tickMarker) refs.ticks.classList.add('has-drop');
            return tickMarker;
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
            // 流体小滴（有底栏的流体标记模块时）：停在当前位置，离得越远的刻度越淡
            const drop = tickDrop();
            if (drop) {
                const w = refs.ticks.clientWidth || 300;
                const x = frac * (w - 14) + 7;
                // 位置没变就不叫它（每叫一次它都会排一帧）
                if (tickDropAt !== x) { tickDropAt = x; drop.moveTo({ start: x - 7, end: x + 7 }); }
                marks.forEach((m, i) => { if (i < n) m.dataset.mdDist = String(Math.min(4, Math.abs(i - nearest))); });
            }
            refs.ticks.setAttribute('aria-valuemin', '1');
            refs.ticks.setAttribute('aria-valuemax', String(Math.max(1, count)));
            refs.ticks.setAttribute('aria-valuenow', String(count ? current + 1 : 0));
            refs.ticks.querySelector('.archive-ticks-tip').textContent = count ? tickTip(current) : '';
        };

        let searchCtx = null;   // 目录检索中：{ q, n }
        const renderHud = (force = false) => {
            const col = column();
            if (!col) return;
            const count = col.items.length;
            const r = count ? Model.wrap(state.row, count) : 0;
            const index = selectedIndex();
            const t = tracks()[index];
            state.selPath = t ? t.path : null;
            refs.cat.textContent = col.name;
            refs.catPos.textContent = count ? '第 ' + (r + 1) + ' / ' + count + ' 首' : '';
            refs.ftitle.textContent = t ? (Model.stripExtension(t.title) || '未知标题') : (col.kind === 'search' ? '没有匹配的曲目' : '这个歌单还是空的');
            // 标题被省略号截断时，悬停能看到完整曲名
            refs.ftitle.title = t ? refs.ftitle.textContent : '';
            const meta = t ? [t.artist, t.album].filter(Boolean).join(' · ') : '';
            // 空列：告诉人下一步怎么做
            const idle = col.kind === 'search' ? 'Esc 清除检索' : col.kind === 'playlist' ? '在曲目上右键 → 加入歌单' : '';
            refs.fmeta.textContent = t ? (meta || '未知歌手') : idle;
            refs.fspec.textContent = t ? [fmtDur(trackDuration(t)), (formatOf(t).split(' · ')[0] || '')].filter(Boolean).join(' · ') : '';
            // 按首字母拆开的列，大标题还是「全部曲目」，下面一行写明「首字母 H」，免得把「H · 23 首」读成全部只有 23 首
            const letterCol = col.kind === 'letter';
            if (searchCtx) {
                // 目录里在检索：左上写检索词和结果数，免得看着「全部曲目」以为没在搜
                // 检索词太长时在引号里面截断，右引号总在
                refs.ctxName.textContent = '';
                const qEl = document.createElement('span');
                qEl.className = 'archive-brand-q';
                qEl.textContent = searchCtx.q;
                refs.ctxName.append('检索「', qEl, '」');
                refs.ctxSub.textContent = searchCtx.n ? searchCtx.n + ' 首结果 · 曲库共 ' + tracks().length + ' 首' : '没有结果';
            } else if (!tracks().length) {
                // 空曲库：左上不写「全部曲目 · 0 首」，下面的空状态说明会告诉人怎么加歌
                refs.ctxName.textContent = '曲库';
                refs.ctxSub.textContent = '还没有歌曲';
            } else {
                refs.ctxName.textContent = letterCol ? '全部曲目' : col.name;
                refs.ctxSub.textContent = (letterCol ? '首字母 ' + col.name + ' · ' : '') + count + ' 首' + (count !== tracks().length ? ' · 曲库共 ' + tracks().length + ' 首' : '');
            }
            refs.playCol.disabled = !count;
            refs.playCol.hidden = Boolean(searchCtx);
            renderResume();
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
            renderDetail();
        };

        // 档案号和列表、舞台用同一套（按路径算的稳定编号）；没有那套时退回曲库序号
        const fileNumber = (t, index) => {
            const specs = global.MusicTrackSpecs;
            const n = specs && typeof specs.fileNumber === 'function' ? specs.fileNumber(t) : '';
            if (n) return /^TRK/i.test(n) ? n : 'TRK-' + n;
            return 'TRK-' + Model.fileCode(index);
        };

        /*
         * 封面：只给选中的那张加载，停稳 120ms 后再取，同时预取前后两首。
         * 曲库里带了封面（内嵌封面扫描时已存成文件）就用它；没有的话试同目录下常见的封面图（cover / folder / front），
         * 每个目录只试一次。图片缓存最多 64 张、目录结果最多 256 条；读不出来的就不显示（露出后面的阵列），不留破图。
         */
        const COVER_NAMES = ['cover.jpg', 'folder.jpg', 'cover.png', 'front.jpg', 'folder.png', 'Cover.jpg', 'Folder.jpg'];
        const dirOf = (t) => {
            const p = String((t && t.path) || '');
            if (!p || /^[a-z][a-z0-9+.-]{2,}:\/\//i.test(p)) return ''; // 远程曲目没有本地目录
            const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
            return cut > 0 ? p.slice(0, cut) : '';
        };
        const capped = (map, key, value, max) => {
            map.set(key, value);
            if (map.size > max) map.delete(map.keys().next().value);
            return value;
        };
        const probeDir = (dir) => {
            const entry = capped(state.dirCovers, dir, { url: null }, 256);
            let k = 0;
            const next = () => {
                if (k >= COVER_NAMES.length) { entry.url = ''; return; }
                const url = fileUrl(dir + '/' + COVER_NAMES[k++]);
                const img = new Image();
                img.decoding = 'async';
                img.onload = () => {
                    entry.url = url;
                    capped(state.coverCache, url, { img, ok: true }, 64);
                    const t = selectedTrack();
                    if (t && !t.albumArt && dirOf(t) === dir) scheduleCover(t, true);
                };
                img.onerror = next;
                img.src = url;
            };
            next();
        };
        const coverOf = (t, probe = false) => {
            if (!t) return '';
            if (t.albumArt) return fileUrl(t.albumArt);
            const dir = dirOf(t);
            if (!dir) return '';
            const known = state.dirCovers.get(dir);
            if (known) return known.url || '';
            if (probe) probeDir(dir);
            return '';
        };
        const preload = (url) => {
            if (!url || state.coverCache.has(url)) return;
            const img = new Image();
            img.decoding = 'async';
            const entry = { img, ok: null };
            img.onload = () => { entry.ok = true; };
            img.onerror = () => { entry.ok = false; };
            img.src = url;
            capped(state.coverCache, url, entry, 64);
        };
        const scheduleCover = (t, immediate) => {
            clearTimeout(state.coverTimer);
            const url = coverOf(t);
            // 还是同一张、已经显示着：不动它（曲库重建时会重画说明块，封面不该跟着闪）
            if (url && refs.cover.dataset.url === url && refs.cover.dataset.state === 'ready') return;
            refs.cover.dataset.url = '';
            refs.cover.classList.remove('on');
            refs.cover.dataset.state = url ? 'loading' : 'none';
            if (!url) refs.cover.style.backgroundImage = '';
            state.coverTimer = setTimeout(() => {
                if (!url) { coverOf(t, true); return; } // 没有自带封面：停稳后才去试同目录的图
                preload(url);
                const entry = state.coverCache.get(url);
                const show = () => {
                    if (coverOf(selectedTrack()) !== url) return;
                    refs.cover.style.backgroundImage = `url("${url}")`;
                    refs.cover.classList.add('on');
                    refs.cover.dataset.state = 'ready';
                    refs.cover.dataset.url = url;
                };
                const fail = () => {
                    if (coverOf(selectedTrack()) !== url) return;
                    refs.cover.style.backgroundImage = '';
                    refs.cover.dataset.state = 'failed';
                };
                if (entry.ok) show();
                else if (entry.ok === false) fail();
                else { entry.img.addEventListener('load', show, { once: true }); entry.img.addEventListener('error', fail, { once: true }); }
                const col = column();
                if (col && col.items.length > 1) {
                    for (const d of [-2, -1, 1, 2]) preload(coverOf(tracks()[Model.cellTrack(state.columns, state.lane, state.row + d)]));
                }
            }, immediate ? 0 : 120);
        };

        // ---------- 选中与播放 ----------
        /*
         * 选中移动的速度：给外面的动效用（比如刻度上的小滴，快速滚动时拉长）。
         * onMotion(fn) 每次换选中回调 fn({ axis: 'row' | 'lane', velocity, fraction })，
         * velocity 按最近 160ms 的移动估算（行或列/秒，有符号），fraction 是在这一列里的位置（0..1）。
         */
        const motionListeners = new Set();
        let motionSamples = [];
        const emitMotion = (dLane, dRow) => {
            if (!motionListeners.size) return;
            const t = performance.now();
            motionSamples.push([t, dLane, dRow]);
            motionSamples = motionSamples.filter((x) => t - x[0] <= 160);
            const span = Math.max(0.06, (t - motionSamples[0][0]) / 1000);
            const sum = motionSamples.reduce((a, x) => [a[0] + x[1], a[1] + x[2]], [0, 0]);
            const axis = dLane ? 'lane' : 'row';
            const col = column();
            const count = col ? col.items.length : 0;
            const info = { axis, velocity: (axis === 'lane' ? sum[0] : sum[1]) / span, fraction: count > 1 ? Model.wrap(state.row, count) / (count - 1) : 0 };
            for (const fn of motionListeners) { try { fn(info); } catch (e) { /* 外面的动效出错不影响选中 */ } }
        };
        motionListeners.add((m) => { if (tickMarker) tickMarker.setVelocity(m.axis === 'row' ? m.velocity : 0); });
        const select = (lane, row, { pulse = true } = {}) => {
            if (!state.columns.length) return;
            if (pendingPlace && tracks().length) settlePlace();
            followUntil.t = 0;
            if (lane === state.lane && row === state.row) return;
            const dLane = lane - state.lane, dRow = row - state.row;
            state.lane = lane;
            state.row = row;
            emitMotion(dLane, dRow);
            refs.tip.classList.remove('on');
            collapse();
            const col = column();
            if (col && col.items.length) focusByColumn.set(col.id, Model.wrap(row, col.items.length));
            state.scene?.select(lane, row, { pulse });
            renderHud();
            syncList();
            if (state.lyricsOn && selectedIndex() !== app.currentTrackIndex) wantLyrics(false);
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
        /*
         * 取出（曲目详情）：点中间那张卡（或标题）把它从列里取出来，镜头推近，卡面显出封面，右侧是资料卡。
         * 取出时 ↑ ↓ / 滚轮换前后一首（旧卡落回、新卡升起，详情留着），← → 或 Esc、点空白处放回去。
         */
        let detailOpen = false;
        const fmtDur = (sec) => {
            sec = Math.round(Number(sec) || 0);
            if (!(sec > 0)) return '';
            const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
            return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(x);
        };
        const trackDuration = (t) => (Number(t && t.duration) > 0 ? Number(t.duration) : durationOf(t));
        const formatOf = (t) => {
            if (!t) return '';
            const m = /\.([a-z0-9]{2,5})$/i.exec(String(t.path || ''));
            const parts = [];
            if (m) parts.push(m[1].toUpperCase());
            const sr = Number(t.sampleRate || t.sample_rate);
            if (sr > 0) parts.push((sr / 1000).toFixed(sr % 1000 ? 1 : 0) + ' kHz');
            const bits = Number(t.bitsPerSample || t.bitDepth);
            if (bits > 0) parts.push(bits + ' bit');
            const br = Number(t.bitrate);
            if (br > 0) parts.push(Math.round(br / 1000) + ' kbps');
            return parts.join(' · ');
        };
        const sameAlbum = (t, index) => {
            if (!t) return { head: '', items: [] };
            const all = tracks();
            const pick = (key, value) => {
                const out = [];
                for (let i = 0; i < all.length && out.length < 8; i++) if (i !== index && all[i] && all[i][key] === value) out.push(i);
                return out;
            };
            if (t.album) { const items = pick('album', t.album); if (items.length) return { head: '同专辑', items }; }
            if (t.artist) { const items = pick('artist', t.artist); if (items.length) return { head: '同一歌手', items }; }
            return { head: '', items: [] };
        };
        // 跳到曲库里第 index 首：优先留在当前列，其次是离得近的列
        const goToIndex = (index) => {
            const n = state.columns.length;
            if (!n) return;
            const at = Model.locate(state.columns, index, Model.wrap(state.lane, n));
            if (!at) return;
            const lane = at.lane + n * Math.round((state.lane - at.lane) / n);
            const m = state.columns[at.lane].items.length;
            select(lane, at.row + m * Math.round((state.row - at.row) / m));
        };
        // 卡面封面：有图就用图，没有（或还没读到、读不出来）就画一张写着曲名的素色卡面
        const syncDetailCover = () => {
            if (!detailOpen || !state.scene) return;
            const t = selectedTrack();
            if (!t) return;
            const url = coverOf(t);
            const entry = url ? state.coverCache.get(url) : null;
            if (entry && entry.ok) { state.scene.setCover(url, entry.img); kick(); return; }
            if (entry && entry.ok === null) {
                entry.img.addEventListener('load', syncDetailCover, { once: true });
                entry.img.addEventListener('error', syncDetailCover, { once: true });
                if (state.scene.detail) state.scene.setCover('ph:' + t.path, null, { title: Model.stripExtension(t.title) || '未知标题', artist: t.artist || '' });
                kick();
                return;
            }
            if (url && !entry) preload(url);
            state.scene.setCover('ph:' + t.path, null, { title: Model.stripExtension(t.title) || '未知标题', artist: t.artist || '' });
            if (url && !entry) { const e2 = state.coverCache.get(url); e2?.img.addEventListener('load', syncDetailCover, { once: true }); }
            kick();
        };
        // 资料卡滚到底（或本来就放得下）时去掉底边淡出
        const syncDetailEnd = () => {
            const card = refs.detail?.querySelector('.archive-detail-card');
            if (card) card.classList.toggle('at-end', card.scrollTop + card.clientHeight >= card.scrollHeight - 2);
        };
        const renderDetail = () => {
            if (!detailOpen) return;
            const index = selectedIndex();
            const t = tracks()[index];
            if (!t) { closeDetail(); return; }
            const col = column();
            const count = col ? col.items.length : 0;
            const r = count ? Model.wrap(state.row, count) : 0;
            refs.dNo.textContent = pad(r + 1, Math.max(2, String(count).length));
            refs.dWhere.textContent = (col ? col.name : '') + ' · 共 ' + count + ' 首';
            const spec = formatOf(t);
            refs.dSpec.textContent = spec ? spec.split(' · ')[0] : '';
            refs.dSpec.hidden = !spec;
            refs.dAlbum.textContent = t.album || '';
            refs.dTitle.textContent = Model.stripExtension(t.title) || '未知标题';
            refs.dArtist.textContent = t.artist || '未知歌手';
            refs.dAlbum2.textContent = t.album || '—';
            refs.dDur.textContent = fmtDur(trackDuration(t)) || '—';
            refs.dFmt.textContent = spec || '—';
            refs.dGroup.textContent = col ? col.name + ' · 第 ' + (r + 1) + ' 首' : '—';
            const remote = /^[a-z][a-z0-9+.-]{2,}:\/\//i.test(String(t.path || ''));
            refs.dPath.textContent = remote ? '云端曲目' : String(t.path || '—');
            refs.dPath.title = String(t.path || '');
            refs.dArtistBtn.disabled = !t.artist;
            const canLike = typeof app.toggleLike === 'function' && typeof app.isLiked === 'function';
            refs.dLike.hidden = !canLike;
            if (canLike) {
                const liked = Boolean(app.isLiked(t));
                refs.dLike.setAttribute('aria-pressed', String(liked));
                refs.dLike.title = liked ? '取消喜欢' : '喜欢';
                refs.dLike.setAttribute('aria-label', refs.dLike.title);
                refs.dLike.firstChild.textContent = liked ? '♥' : '♡';
            }
            // 没有的信息整格不显示，不放占位横线
            for (const k of ['dAlbum2', 'dDur', 'dFmt']) refs[k].parentElement.hidden = refs[k].textContent === '—';
            const playingThis = index === app.currentTrackIndex && (app.isPlaying || app.playIntent);
            refs.dPlayText.textContent = playingThis ? '暂停' : index === app.currentTrackIndex ? '继续播放' : '播放';
            refs.dPlay.querySelector('i').textContent = playingThis ? '❚❚' : '▶';
            const more = sameAlbum(t, index);
            refs.dMoreWrap.hidden = !more.items.length;
            refs.dMoreHead.textContent = more.head;
            refs.dMore.innerHTML = '';
            for (const i of more.items) {
                const x = tracks()[i];
                const li = document.createElement('li');
                const b = document.createElement('button');
                b.type = 'button';
                b.dataset.act = 'd-goto';
                b.dataset.index = String(i);
                const name = document.createElement('span');
                name.textContent = Model.stripExtension(x.title) || '未知标题';
                const dur = document.createElement('small');
                dur.textContent = fmtDur(trackDuration(x));
                b.append(name, dur);
                if (i === app.currentTrackIndex) b.classList.add('is-current');
                li.appendChild(b);
                refs.dMore.appendChild(li);
            }
            syncDetailCover();
            syncDetailEnd();
        };
        let openedFrom = null;
        const openDetail = () => {
            if (selectedIndex() < 0) return;
            if (!detailOpen) {
                // 记下是从哪里打开的，关掉时把焦点还回去（键盘用户不会掉到页面开头）
                const from = document.activeElement;
                openedFrom = from && from !== document.body && root.contains(from) && !refs.detail.contains(from) ? from : null;
                detailOpen = true;
                root.classList.add('is-detail');
                refs.detail.removeAttribute('inert');
                refs.detail.setAttribute('aria-hidden', 'false');
                syncDetailRoom();
                state.scene?.setDetail(true);
                state.scene?.setHover(null);
                refs.tip.classList.remove('on');
            }
            renderDetail();
            global.requestAnimationFrame?.(syncDetailEnd);
            refs.dPlay.focus({ preventScroll: true });
            kick();
        };
        const closeDetail = () => {
            if (!detailOpen) return;
            detailOpen = false;
            root.classList.remove('is-detail');
            refs.detail.setAttribute('inert', '');
            refs.detail.setAttribute('aria-hidden', 'true');
            state.scene?.setDetail(false);
            if (refs.detail.contains(document.activeElement)) {
                const back = openedFrom && openedFrom.isConnected && !openedFrom.closest('[hidden],[inert]') ? openedFrom : null;
                if (back) back.focus({ preventScroll: true }); else document.activeElement.blur();
            }
            openedFrom = null;
            kick();
        };
        const expandSelected = openDetail;
        const collapse = () => {};

        /* 整个曲库按当前排序的顺序（就是阵列里从左到右、从上到下看到的顺序） */
        const libraryOrder = () => {
            const letters = state.columns.filter((c) => c.kind === 'letter');
            if (letters.length) return letters.flatMap((c) => c.items);
            const all = state.columns.find((c) => c.kind === 'all');
            return all ? all.items : tracks().map((_, i) => i);
        };
        /*
         * 设队列并播放：播放器有统一点播入口（playFromContext）就走它，
         * 之后换排序时能用 reorderContext 跟着换顺序；没有时退回直接设 currentFilteredTracks。
         */
        const startQueue = (items, index, source, name) => {
            const list = items.map((i) => tracks()[i]).filter(Boolean);
            state.playedLane = state.lane;
            setQueueName(name);
            if (typeof app.playFromContext === 'function') {
                app.playFromContext(list, index, { source, origin: 'archive' });
                return;
            }
            const whole = list.length === tracks().length && list.every((t, i) => t === tracks()[i]);
            app.currentFilteredTracks = whole ? null : list;
            app.filteredPlaylistSource = source;
            try { app.renderPlaylist?.(app.currentFilteredTracks); } catch (e) { /* 旧列表只是同步显示，失败不影响播放 */ }
            app.loadTrack(index, true);
        };
        /* 换了排序：正在放的还是从档案页点的整个曲库，就换成新顺序，不打断播放 */
        const followSort = () => {
            if (typeof app.reorderContext !== 'function' || !app.contextFrom?.('archive')) return;
            app.reorderContext(libraryOrder().map((i) => tracks()[i]).filter(Boolean), 'archive');
        };

        const playSelected = ({ stage = true, group = null } = {}) => {
            const col = column();
            const index = selectedIndex();
            if (!col || index < 0) return;
            const already = index === app.currentTrackIndex && (app.isPlaying || app.playIntent);
            if (!already && group && group.items.includes(index)) {
                // 从目录的某一组点播（歌手、专辑、最近、检索结果）：队列就是看到的这一组
                startQueue(group.items, index, { type: 'archive-group', name: group.name }, group.name);
            } else if (!already) {
                // 播放队列跟着所在的列走，按阵列里看到的顺序：
                // 按首字母（或排序方式）拆开的列，队列是整个曲库按当前排序接着放；其他列是这一列的曲目
                const source = col.kind === 'playlist' ? { type: 'playlist', name: col.name, id: col.playlistId }
                    : col.kind === 'album' ? { type: 'album', name: col.name } : null;
                const whole = col.kind === 'letter' || col.kind === 'all';
                startQueue(whole ? libraryOrder() : col.items, index, source, whole ? '全部曲目' : col.name);
            }
            wantLyrics(true);
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

        /* 接着听：上次没听完的那首（听歌记录给的位置），放在「播放这一组」旁边。
           正在放的就是它时不显示；播放器已经恢复到这首、只是暂停着，就写「继续播放」 */
        const resumeInfo = () => {
            let r = null;
            try { r = app.musicStats?.resume?.() || null; } catch (e) { r = null; }
            if (!r || !r.track) return null;
            const index = tracks().indexOf(r.track);
            return index < 0 ? null : { index, track: r.track, position: Math.max(0, Number(r.position) || 0) };
        };
        const renderResume = () => {
            const el = refs.resume;
            if (!el) return;
            const r = resumeInfo();
            const isCurrent = r && r.index === app.currentTrackIndex;
            const show = Boolean(r) && !searchCtx && !(isCurrent && (app.isPlaying || app.playIntent));
            el.hidden = !show;
            if (!show) return;
            const name = Model.stripExtension(r.track.title || '') || '未知标题';
            refs.resumeLabel.textContent = isCurrent ? '继续播放' : '接着听';
            refs.resumeName.textContent = name;
            refs.resumeAt.textContent = fmtDur(r.position);
            el.title = (isCurrent ? '继续播放「' : '从上次停下的地方接着听「') + name + '」' + (r.position ? '（' + fmtDur(r.position) + '）' : '');
        };
        let resumeWait = 0;
        const playResume = () => {
            const r = resumeInfo();
            if (!r) return;
            if (r.index === app.currentTrackIndex && tracks()[app.currentTrackIndex]) {
                // 播放器已经停在这首（重开窗口时会恢复到原位置），直接接着放
                goToTrack(r.index, null, { pulse: false });
                app.playTrack?.();
                wantLyrics(true);
                renderResume();
                return;
            }
            goToTrack(r.index, null, { pulse: false });
            if (selectedIndex() !== r.index) return;
            playSelected({ stage: false });
            if (!(r.position > 1) || typeof app.seekTo !== 'function') return;
            // 等引擎真的换到这首再跳到原位置；中途换了歌就不跳
            const path = r.track.path, token = ++resumeWait, until = Date.now() + 8000;
            const check = () => {
                if (state.destroyed || token !== resumeWait || app.currentTrackIndex !== r.index) return;
                if (app.engineTrackPath === path || (app.engineTrackPath === undefined && app.isPlaying)) { app.seekTo(r.position); return; }
                if (Date.now() < until) global.setTimeout(check, 150);
            };
            global.setTimeout(check, 150);
        };

        // 正在播放那张卡：在当前视野里找最近的一格
        const updatePlaying = (force = false) => {
            const key = app.currentTrackIndex + ':' + Boolean(app.isPlaying) + ':' + state.sig;
            if (!force && key === state.playingKey) return;
            state.playingKey = key;
            renderDetail();
            renderResume();
            // 还没放过歌时底栏不写「正在播放 全部曲目」（没有在播放的东西）
            const queueEl = refs.queue?.parentElement;
            if (queueEl) queueEl.hidden = !tracks()[app.currentTrackIndex];
            // 跟着在听：选中停在正在放的那首、歌词开着时，播放器换到下一首（自动接下一首、底栏的上一首/下一首），
            // 选中和目录跟过去，歌词面板留着；在看别的歌时不打扰
            const prevPlaying = state.playingIndex;
            state.playingIndex = app.currentTrackIndex;
            if (state.lyricsOn && prevPlaying !== undefined && prevPlaying !== app.currentTrackIndex
                && selectedIndex() === prevPlaying && tracks()[app.currentTrackIndex]) {
                goToPlaying();
            }
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
            syncLyrics();
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
        let pinyinFn = null; // 同一份拼音表始终是同一个函数，条目缓存靠它判断拼音有没有变
        const pinyinOf = () => {
            const lib = global.pinyinPro;
            if (!lib || typeof lib.pinyin !== 'function') return null;
            if (pinyinFn && pinyinFn.lib === lib) return pinyinFn;
            pinyinFn = (c) => {
                if (!pinyinCache.has(c)) {
                    let p = '';
                    try { p = lib.pinyin(c, { toneType: 'none' }); } catch (e) { p = ''; }
                    pinyinCache.set(c, p);
                }
                return pinyinCache.get(c);
            };
            pinyinFn.lib = lib;
            return pinyinFn;
        };
        let searchIndex = null;
        const entryCache = new Map();
        const rebuildIndex = () => { searchIndex = IndexLib ? IndexLib.createIndex(tracks(), { pinyin: pinyinOf(), cache: entryCache }) : null; };

        /*
         * 曲库整体变了（读进来、扫完、拼音表到了）之后的重建。大曲库的检索条目（拼音、罗马音）是最慢的一步，
         * 先分片算进缓存（每片最多 8ms，片与片之间让出线程，输入不被卡住），算完再一次重建；
         * 小曲库或者缓存已经是热的（只多了几首歌）就当场重建。
         */
        const WARM_ABOVE = 1500;
        let warming = null;
        const rebuildSoon = () => {
            const list = tracks();
            if (!IndexLib || !IndexLib.warm || list.length <= WARM_ABOVE) { warming = null; rebuild({ steady: true }); return; }
            if (warming && warming.list === app.playlist && warming.n === list.length) return;
            const job = warming = { list: app.playlist, n: list.length, at: 0, pinyin: pinyinOf() };
            if (state.dataRefs.length <= 0) applyEmpty(true); // 从空到有：先把空状态收起来
            const later = () => setTimeout(slice, 0);
            const slice = () => {
                if (state.destroyed || warming !== job) return;
                if (job.list !== app.playlist || job.n !== tracks().length) { warming = null; rebuildSoon(); return; }
                // 一片只做一件事：算条目（可能要很多片）→ 建索引 → 排名次（可能几片）→ 重建阵列 → 目录（rebuild 里再排一片）
                if (job.at !== -1) {
                    job.at = IndexLib.warm(tracks(), { pinyin: job.pinyin, cache: entryCache, from: job.at, budgetMs: 8 });
                    return later();
                }
                if (!job.index) {
                    job.index = IndexLib.createIndex(tracks(), { pinyin: job.pinyin, cache: entryCache });
                    job.sort = IndexLib.prepareSort ? IndexLib.prepareSort(job.index, sortMode) : () => true;
                    return later();
                }
                if (!job.sort(8)) return later();
                if (!job.cols) { job.colsKey = columnsKey(); job.cols = computeColumns(job.index); return later(); }
                warming = null;
                rebuild({ prepared: job, laterList: true, steady: true });
            };
            slice();
        };

        /* 排序方式（标题、歌手、时长、添加时间）：阵列的列、目录、队列都跟着它；记在本机 */
        const SORT_KEY = 'musicArchiveSort';
        let sortMode = 'title';
        try { sortMode = localStorage.getItem(SORT_KEY) || 'title'; } catch (e) { sortMode = 'title'; }
        if (!IndexLib || !IndexLib.SORTS || !IndexLib.SORTS.includes(sortMode)) sortMode = 'title';
        const sortSpecFor = (index) => (IndexLib && index && IndexLib.sortSpec
            ? IndexLib.sortSpec(index, { mode: sortMode, tracks: tracks(), durationOf: (t) => durationOf(t) }) : null);
        const sortSpec = () => sortSpecFor(searchIndex);
        const setSort = (mode) => {
            if (!IndexLib || !IndexLib.SORTS.includes(mode) || mode === sortMode) return;
            sortMode = mode;
            try { localStorage.setItem(SORT_KEY, mode); } catch (e) { /* 只是记住 */ }
            // 按新顺序重排：选中的那首留在选中，换到它在新排法里的那一列
            const keepIndex = selectedIndex();
            rebuild({ keep: false, track: keepIndex, reindex: false });
            followSort();
        };
        // 拼音表按需加载（项目已有的依赖），加载好之后重建索引，汉字才能按拼音检索和分组
        const loadPinyin = () => {
            if (global.pinyinPro || options.pinyinSrc === false) return;
            const src = options.pinyinSrc || (SCRIPT_BASE ? new URL('../../node_modules/pinyin-pro/dist/index.js', SCRIPT_BASE).href : '');
            if (!src) return;
            const tag = document.createElement('script');
            tag.src = src;
            tag.async = true;
            tag.onload = () => { if (!state.destroyed) rebuildSoon(); }; // 汉字有了拼音，分组和检索都要重算
            tag.onerror = () => { /* 没有拼音表就只按原文检索 */ };
            document.head.appendChild(tag);
        };

        // 最近播放：记路径，最多 60 首，存在本机
        const RECENT_KEY = 'musicArchiveRecent';
        let recentPaths = [];
        try { recentPaths = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((p) => typeof p === 'string'); } catch (e) { recentPaths = []; }
        const recentIndices = () => {
            const byPath = pathIndex();
            return recentPaths.map((p) => byPath.get(Model.normalizePath(p))).filter((i) => i !== undefined);
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
        let lyrics = null;
        /*
         * 歌词面板平时不占位：在这一页选好歌播放（或点了定位当前播放、LYRICS）之后才出来，
         * 选中移到别的歌上（在浏览）就收起，把地方还给选中卡的信息
         */
        const wantLyrics = (on) => {
            on = Boolean(on);
            if (on === Boolean(state.lyricsOn)) return;
            state.lyricsOn = on;
            refs.lyricsBtn?.setAttribute('aria-pressed', String(on));
            syncLyrics();
        };
        /* 一级入口：原来的控制参数（声学处理、舞台、播放）。播放器给了入口就用它的；没有就回经典视图把声学处理展开 */
        const openControls = (section) => {
            if (typeof app.openMusicControls === 'function') { app.openMusicControls(section); return; }
            if (app.musicDock && typeof app.musicDock.openPanel === 'function') { app.musicDock.openPanel('控制'); return; }
            setMode('classic', { persist: false });
            const drawer = document.getElementById('acoustic-drawer');
            const toggle = drawer && drawer.querySelector('.acoustic-drawer-toggle');
            if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
            drawer?.scrollIntoView?.({ block: 'nearest' });
            toggle?.focus?.();
        };
        const syncLyrics = () => {
            if (!lyrics) return;
            lyrics.setAllowed(state.lyricsOn && isShown() && !isNarrow() && !document.body.classList.contains('music-stage-active'));
            lyrics.sync();
        };
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
            // 设置抽屉开着时目录开合会换档（见 resize 里的 midBeside）
            if (lastInset) resize();
        };
        const applyListDefault = (narrow = isNarrow()) => {
            // 宽窗口默认打开，窄窗口默认收起（用户手动开过就按记住的）
            if (listPref === '1' || listPref === '0') setListOpen(listPref === '1', { persist: false });
            else setListOpen(!narrow, { persist: false });
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
            // 在目录里点到正在放的那首：也算选好了
            if (i === app.currentTrackIndex && selectedIndex() === i) wantLyrics(true);
        };
        let fromList = false;
        const syncList = (quiet = false) => {
            if (!list || fromList || !listOpen()) return;
            const col = column();
            list.reveal(selectedIndex(), col ? col.id : null, { quiet: quiet === true });
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
            if (tracks()[app.currentTrackIndex] && selectedIndex() === app.currentTrackIndex) wantLyrics(true);
            if (list && listOpen()) {
                if (list.kind !== 'all' && !list.query) list.setKind('all');
                const col = column();
                list.reveal(app.currentTrackIndex, col ? col.id : null, { center: true });
            }
        };

        /* 键盘打开选中卡的右键菜单（Shift+F10、菜单键）：菜单出现在 ACCESS FILE 旁边，方向键可以在菜单里移动 */
        const openMenuForSelected = () => {
            const index = selectedIndex();
            if (index < 0 || typeof app.showContextMenu !== 'function') return;
            const anchor = refs.access;
            const rect = anchor.getBoundingClientRect();
            const back = document.activeElement && document.activeElement !== document.body ? document.activeElement : anchor;
            // 先在档案页里发一次 contextmenu，播放器据此知道菜单是从档案页打开的（决定「移除」的范围）
            anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
            app.contextMenuTrackIndex = index;
            app.showContextMenu(rect.left, rect.bottom + 8);
            ListLib?.menuKeyboard?.(app, { restore: back });
        };
        const composing = (e) => e.isComposing || e.key === 'Process' || e.keyCode === 229;
        const typeIntoSearch = (e) => {
            if (!list || composing(e) || typeof e.key !== 'string') return false;
            // 只接可见的单个字符；空格留给播放暂停
            if ([...e.key].length !== 1 || /\s/.test(e.key) || /[\u0000-\u001f\u007f]/.test(e.key)) return false;
            e.preventDefault();
            stopInertia();
            closeDetail();
            if (!listOpen()) setListOpen(true, { persist: false });
            list.typeInto(e.key);
            return true;
        };
        const openSearch = () => {
            if (!list) return;
            closeDetail();
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
            if (state.mode !== 'archive') closeDetail();
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
                if (dataChanged()) rebuildSoon();
                updatePlaying(true);
                kick();
            } else {
                if (!app.isStageActive) originalCreateAmbient?.();
                app.visualizerCanvas && (app.visualizerCanvas.width = app.visualizerCanvas.clientWidth);
            }
            syncLyrics();
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
                    accent: v('--ar-accent', '#c8a15a'),
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
            refs.hud.classList.toggle('low-power', sceneQuality === 'energy-saving');
            root.insertBefore(state.scene.canvas, root.firstChild);
            bindCanvas(state.scene.canvas);
            updateLabelMask();
            // 卡面标题：近处几张卡印曲名和档案号
            state.scene.setLabeler?.((lane, row) => {
                const index = Model.cellTrack(state.columns, lane, row);
                const t = index >= 0 ? tracks()[index] : null;
                if (!t) return null;
                return { key: index + ':' + (t.path || ''), title: Model.stripExtension(t.title) || '未知标题', code: fmtDur(trackDuration(t)) };
            });
            applyTheme();
            resize();
            state.scene.jump(keepTarget.lane, keepTarget.row);
            updatePlaying(true);
        };

        const TINY_W = 760, NARROW_W = 1300, MID_W = 1720;
        const hudScale = (h) => Math.max(h / DESIGN_H, MIN_SCALE);
        // 右侧设置抽屉开着时，首页让出它占的那一条：整层按剩下的宽度重新排版（宽窄分档也按剩下的宽度算），
        // 标题、导航、说明块、封面、资料卡都挪到抽屉左边，不被盖住。用排版位置量，不受抽屉滑入的 transform 影响。
        const drawerInset = (w) => {
            // 底栏自己算好了让位宽度就用它的
            const given = Number(app.musicDock?.roomRight);
            if (Number.isFinite(given) && app.musicDock && 'roomRight' in app.musicDock) return given > 0 && given < w * 0.6 ? Math.round(given) : 0;
            const pnl = document.querySelector('#music-dock-root .md-pnl');
            if (!pnl || !pnl.classList.contains('md-open') || !pnl.offsetWidth) return 0;
            let left = 0;
            for (let el = pnl; el; el = el.offsetParent) left += el.offsetLeft;
            const inset = Math.round(root.getBoundingClientRect().right - left);
            // 窄窗口里抽屉铺满整个窗口：那时不让位，照原样被盖住
            return inset > 0 && inset < w * 0.6 ? inset : 0;
        };
        let lastInset = 0;
        let lastFullNarrow = null;
        const resize = () => {
            const full = root.clientWidth || global.innerWidth;
            const inset = drawerInset(full);
            lastInset = inset;
            const w = full - inset;
            const h = root.clientHeight || global.innerHeight;
            const sc = hudScale(h);
            refs.hud.classList.toggle('beside-drawer', inset > 0);
            refs.hud.style.width = (w / sc) + 'px';
            refs.hud.style.height = (h / sc) + 'px';
            refs.hud.style.transform = `scale(${sc})`;
            refs.hud.classList.toggle('short', h / sc < 900);
            // 窄：只留阵列和说明块；中等（笔记本常见的 1280×800 就在这档）：目录照常开着，说明块挪到目录右边
            // 设置抽屉让位后剩下的宽度落进窄档、目录又开着：窄档的目录会盖住说明块，改用中档那种「目录 + 右边说明块」的摆法
            const midBeside = inset > 0 && listOpen() && w / sc >= 900 && w / sc < NARROW_W;
            refs.hud.classList.toggle('narrow', w / sc < NARROW_W && !midBeside);
            refs.hud.classList.toggle('mid', (w / sc >= NARROW_W && w / sc < MID_W) || midBeside);
            refs.hud.classList.toggle('squeeze', midBeside);
            // 很窄（音乐窗口最小 420 宽时就在这档）：右上的导航挤到标题上、分组切换压在曲名上，改成另一种摆法。
            refs.hud.classList.toggle('tiny', w / sc < TINY_W);
            // 目录默认开合按整窗宽度判断：打开设置抽屉让位变窄时不顺手把目录收起来
            const fullNarrow = full / sc < NARROW_W;
            if (list && lastFullNarrow !== null && fullNarrow !== lastFullNarrow && listPref !== '1' && listPref !== '0') applyListDefault(fullNarrow);
            lastFullNarrow = fullNarrow;
            const safe = parseFloat(getComputedStyle(document.body).getPropertyValue('--music-dock-safe-bottom')) || 0;
            refs.hud.style.setProperty('--archive-dock-lift', Math.round(safe / sc) + 'px');
            state.scene?.resize(full, h);
            syncDetailRoom(sc);
            if (detailOpen) syncDetailEnd();
            syncLyrics();
            updateLabelMask();
            kick();
        };
        // 资料卡左边那块空地给场景，取出的卡整张放在里面（offsetLeft 不受滑入动画的位移影响）
        const syncDetailRoom = (sc = hudScale(root.clientHeight || global.innerHeight)) => {
            const card = refs.detail?.querySelector('.archive-detail-card');
            if (!card || !state.scene?.setDetailRoom) return;
            state.scene.setDetailRoom(card.offsetLeft * sc);
        };
        // 说明块（档案号、曲名、ACCESS FILE）下面的卡不印标题
        const updateLabelMask = () => {
            if (!state.scene?.setLabelMask) return;
            const callout = root.querySelector('.archive-callout');
            const base = root.getBoundingClientRect();
            if (!callout || callout.offsetParent === null) { state.scene.setLabelMask([]); return; }
            const r = callout.getBoundingClientRect();
            const sc = hudScale(root.clientHeight || global.innerHeight);
            const pad = 24 * sc;
            // 说明块右半是一条延伸到边缘的细线，只挡文字和封面那一段
            const right = Math.min(r.right, r.left + 730 * sc);
            const masks = [{ left: r.left - base.left - pad, top: r.top - base.top - pad, right: right - base.left + pad, bottom: r.bottom - base.top + pad }];
            // 右侧歌词下面的卡也不印标题，免得字叠字
            if (lyrics && lyrics.shown) {
                const y = lyrics.el.getBoundingClientRect();
                masks.push({ left: y.left - base.left - pad, top: y.top - base.top - pad, right: y.right - base.left, bottom: y.bottom - base.top });
            }
            state.scene.setLabelMask(masks);
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
        let turning = null;
        /* 鼠标指着的卡（不是选中那张）：在指针旁边写出曲名和歌手，远处的卡也能认出是哪首 */
        const showTip = (c, at) => {
            const index = c && !detailOpen && !(c.lane === state.lane && c.row === state.row) ? Model.cellTrack(state.columns, c.lane, c.row) : -1;
            const t = index >= 0 ? tracks()[index] : null;
            if (!t || !at) { refs.tip.classList.remove('on'); return; }
            refs.tip.firstChild.textContent = Model.stripExtension(t.title) || '未知标题';
            refs.tip.lastChild.textContent = [t.artist, fmtDur(trackDuration(t))].filter(Boolean).join(' · ');
            const base = root.getBoundingClientRect();
            refs.tip.style.transform = `translate(${Math.round(at.x - base.left + 16)}px, ${Math.round(at.y - base.top + 18)}px)`;
            refs.tip.classList.add('on');
        };
        let detailMiss = false;
        const bindCanvas = (canvas) => {
            canvas.addEventListener('pointermove', (e) => {
                const rect = canvas.getBoundingClientRect();
                state.scene?.setPointer((e.clientX - rect.left) / rect.width * 2 - 1, (e.clientY - rect.top) / rect.height * 2 - 1);
                if (turning) {
                    const dx = e.clientX - turning.x;
                    turning.x = e.clientX;
                    if (Math.abs(e.clientX - turning.x0) > 4) turning.moved = true;
                    state.scene?.turn(dx * 0.006);
                    kick();
                    return;
                }
                if (detailOpen) {
                    const r = state.scene?.detailRect();
                    const on = r && e.clientX - rect.left >= r.left && e.clientX - rect.left <= r.right && e.clientY - rect.top >= r.top && e.clientY - rect.top <= r.bottom;
                    canvas.style.cursor = on ? 'grab' : '';
                    kick();
                    return;
                }
                pendingPick = { x: e.clientX, y: e.clientY, rect };
                if (!pickRaf) {
                    pickRaf = requestAnimationFrame(() => {
                        pickRaf = 0;
                        if (!pendingPick || !state.scene) return;
                        const c = state.scene.pick(pendingPick.x, pendingPick.y, pendingPick.rect);
                        state.scene.setHover(c);
                        showTip(c, pendingPick);
                        canvas.style.cursor = c && Model.cellTrack(state.columns, c.lane, c.row) >= 0 ? 'pointer' : '';
                    });
                }
                kick();
            });
            canvas.addEventListener('pointerleave', () => { pendingPick = null; state.scene?.setHover(null); showTip(null); kick(); });
            // 取出时按住卡左右拖可以转着看，松手转回正面；按在卡外面（没拖）就把卡放回去
            const onDetailCard = (e) => {
                const r = state.scene?.detailRect();
                const rect = canvas.getBoundingClientRect();
                return Boolean(r) && e.clientX - rect.left >= r.left && e.clientX - rect.left <= r.right && e.clientY - rect.top >= r.top && e.clientY - rect.top <= r.bottom;
            };
            canvas.addEventListener('pointerdown', (e) => {
                if (!detailOpen || e.button !== 0) return;
                if (onDetailCard(e)) {
                    turning = { x: e.clientX, x0: e.clientX, moved: false };
                    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 拿不到捕获也能拖 */ }
                    canvas.style.cursor = 'grabbing';
                } else detailMiss = true;
            });
            const endTurn = () => {
                if (!turning) return;
                turning = null;
                state.scene?.turn(0, true);
                canvas.style.cursor = '';
                kick();
            };
            canvas.addEventListener('pointerup', endTurn);
            canvas.addEventListener('pointercancel', endTurn);
            // 单击侧卡只把它移到中间；再点中间那张才展开（抬高、焦点落到 ACCESS FILE）；双击或回车播放
            canvas.addEventListener('click', (e) => {
                if (detailOpen) {
                    if (detailMiss) closeDetail();
                    detailMiss = false;
                    return;
                }
                const c = state.scene?.pick(e.clientX, e.clientY, canvas.getBoundingClientRect());
                if (!c || Model.cellTrack(state.columns, c.lane, c.row) < 0) return;
                if (c.lane === state.lane && c.row === state.row) expandSelected();
                else select(c.lane, c.row);
            });
            canvas.addEventListener('dblclick', (e) => {
                if (detailOpen) return;
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
            // 鼠标滚轮一格就是一张（不累计余量，系统缩放 125%/150% 时也认得出）；触控板的小增量照常累计，惯性交给系统
            const notch = Model.isWheelNotch(e, global.devicePixelRatio);
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
                    case 'open-detail': openDetail(); break;
                    case 'resume': playResume(); break;
                    case 'play-col': {
                        // 从这一组的第一首放起（队列就是这一组，和在阵列里点播同一套规则）
                        const col = column();
                        if (!col || !col.items.length) break;
                        const count = col.items.length;
                        select(state.lane, state.row - Model.wrap(state.row, count), { pulse: false });
                        playSelected({ stage: false });
                        break;
                    }
                    case 'detail-close': closeDetail(); break;
                    case 'd-like': {
                        const t = selectedTrack();
                        if (t && typeof app.toggleLike === 'function') app.toggleLike(t);
                        renderDetail();
                        break;
                    }
                    case 'd-play': {
                        const index = selectedIndex();
                        if (index < 0) break;
                        if (index === app.currentTrackIndex && (app.isPlaying || app.playIntent)) app.pauseTrack?.();
                        else if (index === app.currentTrackIndex && app.playTrack) { app.playTrack(); wantLyrics(true); }
                        else playSelected({ stage: false });
                        break;
                    }
                    case 'd-next': case 'd-queue': {
                        const t = selectedTrack();
                        if (!t) break;
                        const next = btn.dataset.act === 'd-next';
                        const before = app.queueSnapshot?.() || [];
                        const queued = next ? app.queuePlayNext?.(t) : app.queueAdd?.(t);
                        if (queued) {
                            const name = Model.stripExtension(queued.title || '');
                            try {
                                global.MusicToast?.show({ id: 'queue', kind: 'success', message: (next ? '下一首播放：' : '已加入队列：') + name,
                                    action: { label: '撤销', run: () => app.queueRevert?.([queued], before) } });
                            } catch (err) { /* 没有提示层也不影响入队 */ }
                        }
                        break;
                    }
                    case 'd-playlist': case 'd-lyrics': {
                        const index = selectedIndex();
                        if (index < 0) break;
                        if (btn.dataset.act === 'd-lyrics') { app.openLyricsFetchModal?.(index); break; }
                        const r = btn.getBoundingClientRect();
                        app.contextMenuTrackIndex = index;
                        app.showContextMenu?.(r.left, r.bottom + 8);
                        // 菜单接上键盘（Esc 能关），并直接展开歌单列表
                        ListLib?.menuKeyboard?.(app, { restore: btn, playlist: true });
                        break;
                    }
                    case 'd-artist': {
                        const t = selectedTrack();
                        if (!t || !t.artist) break;
                        closeDetail();
                        if (!listOpen()) setListOpen(true);
                        list?.typeInto(t.artist);
                        break;
                    }
                    case 'd-goto': goToIndex(Number(btn.dataset.index)); break;
                    case 'up': select(state.lane, state.row - 1); break;
                    case 'down': select(state.lane, state.row + 1); break;
                    case 'left': stepLane(-1); break;
                    case 'right': stepLane(1); break;
                    case 'search': openSearch(); break;
                    // 取出看详情时目录和歌词都藏着：这时按它们是想回去看，不是想关掉
                    case 'list': if (detailOpen) { closeDetail(); setListOpen(true); } else setListOpen(!listOpen()); break;
                    case 'now': locatePlaying(); break;
                    case 'lyrics': if (detailOpen) { closeDetail(); if (!state.lyricsOn) wantLyrics(true); } else wantLyrics(!state.lyricsOn); break;
                    case 'controls': openControls(); break;
                    case 'classic': setMode('classic'); break;
                    case 'add-local': document.getElementById('add-folder-btn')?.click(); break;
                    case 'add-cloud': document.getElementById('add-webdav-btn')?.click(); break;
                    case 'save': {
                        const index = selectedIndex();
                        if (index < 0) break;
                        const r = btn.getBoundingClientRect();
                        app.contextMenuTrackIndex = index;
                        app.showContextMenu?.(r.left, r.bottom + 8);
                        ListLib?.menuKeyboard?.(app, { restore: btn, playlist: true });
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
            // 方向键在阵列里走：右下角的键盘提示这时才出现
            if (/^Arrow/.test(e.key)) refs.hud.classList.add('kbd');
            if (modalOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
            stopInertia();
            const next = Model.step({ lane: state.lane, row: state.row }, e.key);
            if (next) {
                e.preventDefault();
                state.scene?.touch();
                if (next.lane !== state.lane) { closeDetail(); stepLane(next.lane - state.lane); }
                else select(next.lane, next.row);
                return;
            }
            if (e.key === 'Enter') {
                if (tag === 'BUTTON' && e.target.closest('#music-archive-view') && !e.target.closest('.archive-access')) return;
                e.preventDefault(); playSelected(); return;
            }
            if (e.key === '/') { e.preventDefault(); openSearch(); return; }
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openMenuForSelected(); return; }
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
        const onPointerKbdOff = () => refs.hud.classList.remove('kbd');
        root.addEventListener('pointerdown', onPointerKbdOff, true);
        // 取出时 Esc 先把卡放回去（抢在检索、舞台等其他 Esc 之前）
        const onEscCapture = (e) => {
            if (!detailOpen || e.key !== 'Escape' || !isShown() || modalOpen()) return;
            if (document.body.classList.contains('music-stage-active')) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            closeDetail();
        };
        document.addEventListener('keydown', onEscCapture, true);

        // ---------- 外部状态 ----------
        const onResize = () => resize();
        global.addEventListener('resize', onResize);
        const onVisibility = () => { if (!document.hidden) { state.lastDraw = 0; kick(); } };
        document.addEventListener('visibilitychange', onVisibility);
        const onLikeChange = () => { if (detailOpen) renderDetail(); };
        document.addEventListener('music-like-change', onLikeChange);
        const onStatsChange = () => renderResume();
        document.addEventListener('music-stats-change', onStatsChange);
        refs.detail?.querySelector('.archive-detail-card')?.addEventListener('scroll', syncDetailEnd, { passive: true });
        // 主题（light-theme）、舞台进出（music-stage-active）、底栏高度（body 上的变量）都挂在 body 上
        let lastBodyClass = document.body.className;
        // body 的 style 每次切歌都会变（底栏按封面取的色调），只有底栏高度变了才影响版面
        const dockSafe = () => document.body.style.getPropertyValue('--music-dock-safe-bottom');
        let lastDockSafe = dockSafe();
        const bodyObserver = new MutationObserver(() => {
            const cls = document.body.className;
            const classChanged = cls !== lastBodyClass;
            const safe = dockSafe();
            const safeChanged = safe !== lastDockSafe;
            lastDockSafe = safe;
            const themeChanged = cls.includes('light-theme') !== lastBodyClass.includes('light-theme');
            const stageChanged = cls.includes('music-stage-active') !== lastBodyClass.includes('music-stage-active');
            const enteringChanged = cls.includes('music-stage-entering') !== lastBodyClass.includes('music-stage-entering');
            lastBodyClass = cls;
            if (themeChanged) applyTheme({ wave: true });
            if (enteringChanged) syncEntering();
            if (stageChanged) savePlace();
            // 进了播放页再回来，回到浏览状态（卡放回列里）
            if (stageChanged && !cls.includes('music-stage-active')) closeDetail();
            if (stageChanged && !cls.includes('music-stage-active') && isShown()) {
                // 从播放页回来：旧界面的背景声纹不要重新起来
                app.destroyAmbientPixi?.();
                updatePlaying(true);
                goToPlaying();
            }
            // 档案页没显示时不排版：经典视图下每次切歌都会走到这里，强制一次样式计算和布局。
            // 切回档案页时 setMode 会重新 resize。
            if (isShown() && (classChanged || safeChanged)) resize();
            kick();
        });
        bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
        // 设置抽屉开合：抽屉的 class 一变就看让位宽度变没变，变了才重排
        const dockRoot = document.getElementById('music-dock-root');
        let drawerFrame = 0;
        const drawerObserver = dockRoot ? new MutationObserver((records) => {
            if (!records.some((r) => r.target.classList?.contains('md-pnl')) || drawerFrame) return;
            drawerFrame = requestAnimationFrame(() => {
                drawerFrame = 0;
                if (state.destroyed || !isShown()) return;
                if (drawerInset(root.clientWidth || global.innerWidth) !== lastInset) resize();
            });
        }) : null;
        drawerObserver?.observe(dockRoot, { subtree: true, attributes: true, attributeFilter: ['class'] });
        const unsubscribeQuality = stageConfig && stageConfig.subscribe ? stageConfig.subscribe(() => { if (isShown()) { ensureScene(); kick(); } }) : null;
        const onMotion = () => {
            syncMotionClass();
            if (reducedMotion()) stopInertia();
            state.scene?.touch();
            kick();
        };
        reducedQuery?.addEventListener?.('change', onMotion);
        const offMotion = global.MusicMotion && typeof global.MusicMotion.onChange === 'function' ? global.MusicMotion.onChange(onMotion) : null;

        const clockTimer = setInterval(() => {
            if (!isShown()) return;
            if (dataChanged()) rebuildSoon();
            updatePlaying();
            recordDuration();
            syncLyrics();
        }, 1000);

        const destroy = () => {
            if (state.destroyed) return;
            clearTimeout(placeTimer);
            savePlace();
            state.destroyed = true;
            clearInterval(clockTimer);
            drawerObserver?.disconnect();
            cancelAnimationFrame(drawerFrame);
            clearTimeout(scan.timer);
            clearTimeout(bootTimer);
            clearTimeout(listTimer);
            clearTimeout(growTimer);
            scanOff.forEach((off) => { if (typeof off === 'function') off(); });
            clearTimeout(state.coverTimer);
            stopInertia();
            lyrics?.destroy();
            tickMarker?.destroy();
            list?.closeBatchMenu?.();
            list?.endPress?.();
            list?.destroyDrop?.();
            if (state.raf) cancelAnimationFrame(state.raf);
            state.raf = 0;
            document.removeEventListener('keydown', onKeyDown);
            root.removeEventListener('pointerdown', onPointerKbdOff, true);
            document.removeEventListener('keydown', onEscCapture, true);
            document.removeEventListener('visibilitychange', onVisibility);
            document.removeEventListener('music-like-change', onLikeChange);
            document.removeEventListener('music-stats-change', onStatsChange);
            global.removeEventListener('resize', onResize);
            bodyObserver.disconnect();
            if (typeof unsubscribeQuality === 'function') unsubscribeQuality();
            if (typeof offMotion === 'function') offMotion();
            reducedQuery?.removeEventListener?.('change', onMotion);
            state.scene?.dispose();
            state.scene = null;
            if (originalCreateAmbient) app.createAmbientPixi = originalCreateAmbient;
        };
        // 关窗、刷新、离开页面时都彻底停掉：取消渲染循环和计时器，释放 WebGL 上下文（forceContextLoss），
        // 不让已经关掉的页面还在占用显卡或软件渲染。beforeunload 不一定触发（比如直接关进程），pagehide 兜底
        global.addEventListener('beforeunload', destroy, { once: true });
        global.addEventListener('pagehide', destroy, { once: true });

        /* 目录换了分类（歌单、专辑、为你、全部），阵列跳到对应那一类的列，左上标题和中间说明块说的就是同一件事。
           已经在那一类的列上就不动；歌手没有对应的列，阵列不动 */
        const LIST_KIND_COLS = { playlist: ['playlist'], album: ['album'], recent: ['daily', 'recent'], all: ['letter', 'all'] };
        const followListKind = (kind) => {
            const want = LIST_KIND_COLS[kind];
            const n = state.columns.length;
            if (!want || !n) return;
            const cur = column();
            if (cur && want.includes(cur.kind)) return;
            let target = -1;
            // 回到「全部」：跳到选中那首所在的字母列，没有就第一列字母
            const sel = selectedIndex();
            if (kind === 'all' && sel >= 0) target = state.columns.findIndex((c) => want.includes(c.kind) && c.items.includes(sel));
            if (target < 0) target = state.columns.findIndex((c) => want.includes(c.kind));
            if (target < 0) return;
            stepLane(target - Model.wrap(state.lane, n));
        };
        if (ListLib && IndexLib) {
            list = ListLib.create({
                host: refs.hud,
                app,
                reducedMotion,
                Index: IndexLib,
                getIndex: () => searchIndex,
                getSpec: sortSpec,
                getSort: () => sortMode,
                onSort: setSort,
                getRecent: recentIndices, durationOf,
                columnOfGroup,
                fileNumber: (t, i) => fileNumber(t, i),
                onPlaylistsChanged: () => {
                    warming = null; rebuild({ steady: true });
                    // 正在放的歌单改了名：底栏「正在播放」后面的名字跟着改
                    const playing = app.filteredPlaylistSource;
                    if (playing && playing.type === 'playlist' && app.playbackSourceName) setQueueName(app.playbackSourceName(playing));
                },
                onLibraryChanged: () => { warming = null; rebuild({ steady: true }); },
                onResults: (q, n, first) => {
                    searchCtx = q ? { q, n } : null;
                    refs.hud.classList.toggle('no-match', Boolean(q) && !n);
                    // 有结果时阵列和中间的说明块跟到第一条结果，免得还停在检索前那首
                    if (q && first && first.i !== selectedIndex()) goToTrack(first.i, first.ctx, { pulse: false });
                    renderHud();
                },
                onKind: (kind) => followListKind(kind),
                onPick: (i, ctx) => goToTrack(i, ctx),
                onPlay: (i, ctx, o) => playIndex(i, ctx, o)
            });
            // 目录是后加进来的，放在 HUD 最后，Tab 要走完右边所有按钮才到它。挪到左上标题后面，
            // Tab 顺序就跟看到的一样：标题、播放这一组、目录（搜索框、分类、曲目），再到右边
            const listEl = refs.hud.querySelector(':scope > .archive-list');
            const brandEl = refs.hud.querySelector(':scope > .archive-brand');
            if (listEl && brandEl) brandEl.after(listEl);
        }
        // 右侧滚动歌词（播放器取到歌词时显示；窄窗口、经典视图、播放页里不显示）
        const LyricsLib = global.MusicArchiveLyrics;
        lyrics = LyricsLib ? LyricsLib.create({
            host: refs.hud, app, reducedMotion,
            onChange: (on) => { refs.hud.classList.toggle('has-lyrics', on); updateLabelMask(); kick(); }
        }) : null;
        loadPinyin();

        let initialMode = 'archive';
        try { initialMode = localStorage.getItem(VIEW_KEY) || 'archive'; } catch (e) { /* 默认档案页 */ }
        rebuild({ keep: false });
        setMode(initialMode, { persist: false });
        applyListDefault();

        const api = {
            show: () => setMode('archive'),
            showClassic: () => setMode('classic'),
            refresh: () => { warming = null; rebuild(); },
            refreshSoon: () => rebuildSoon(),
            select,
            playSelected,
            openDetail,
            closeDetail,
            get detailOpen() { return detailOpen; },
            get scene() { return state.scene; },
            openSearch,
            setListOpen,
            setSort,
            get sort() { return sortMode; },
            onMotion: (fn) => { motionListeners.add(fn); return () => motionListeners.delete(fn); },
            raise,
            setThemeWave: () => applyTheme({ wave: true }),
            get list() { return list; },
            destroy,
            get mode() { return state.mode; },
            debug: () => ({
                mode: state.mode, lane: state.lane, row: state.row, columns: state.columns.map((c) => ({ id: c.id, n: c.items.length })),
                selected: selectedIndex(), rendering: Boolean(state.raf), allowed: renderAllowed(), scene: state.scene?.debug() || null,
                lyrics: lyrics ? lyrics.debug() : null, lyricsOn: Boolean(state.lyricsOn)
            })
        };
        app.archiveView = api;
        return api;
    };

    global.MusicArchive = Object.freeze({ init });
})(window);
