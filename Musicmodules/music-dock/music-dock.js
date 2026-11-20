// Musicmodules/music-dock/music-dock.js
// 音乐窗口底栏：左下“正在播放”药丸、底部中间的进度胶囊（悬停展开、快捷行）、
// 右下面板把手和统一面板（封面 / 歌词 / 控制 / 播放列表 / 音质）。
// 主界面和舞台共用这一条底栏。
//
// 约定：
// - 只读 app 上的状态、只调 app 上已有的播放方法（playTrack / pauseTrack / seekTo / loadTrack ...），
//   不改 music-player.js 的竞态处理；旧的按钮和滑块留在 DOM 里，音量照旧经由 #volume-slider 发给引擎。
// - 状态变化靠 MutationObserver 和少量事件得知，不每帧轮询；进度只在播放时每 250ms 刷一次。
// - 颜色全部来自 music-theme/music-tokens.css 的 --md-* / --mt-* 变量。
(function (global) {
    'use strict';

    const ICONS = global.MusicDockIcons || {};

    // 胶囊尺寸弹簧（刚度 280、阻尼 24、质量 1）和悬停时序（展开 20ms、收起 100ms、快捷行停留 250ms）。
    const SPRING_K = 280;
    const SPRING_C = 24;
    const HOVER_EXPAND_MS = 20;
    const HOVER_COLLAPSE_MS = 100;
    const QUICK_DWELL_MS = 250;
    const CAPSULE_MAX_W = 480;
    const CAPSULE_H_COLLAPSED = 50;
    const CAPSULE_H_EXPANDED = 74;
    const PROGRESS_TICK_MS = 250;
    const QUEUE_ROW_H = 48;
    const SAFE_BOTTOM_PX = 96;
    const COMPACT_BELOW = 640;

    const TABS = Object.freeze(['封面', '歌词', '控制', '播放列表', '音质']);
    const MODE_LABELS = Object.freeze({ repeat: '列表循环', 'repeat-one': '单曲循环', shuffle: '随机播放' });
    const MODE_ICONS = Object.freeze({ repeat: 'repeat', 'repeat-one': 'repeat-1', shuffle: 'shuffle' });

    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));

    const icon = (name, size = 16, options = {}) => (
        `<svg class="md-i" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"`
        + ` fill="${options.fill || 'none'}" stroke="currentColor" stroke-width="${options.strokeWidth || 2}"`
        + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`
    );

    const formatClock = (seconds) => {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    };

    const fileUrl = (path) => path ? `file://${String(path).replace(/\\/g, '/')}` : '';

    function initMusicDock(app) {
        const host = document.getElementById('music-dock-root');
        if (!host || !app) return null;

        const cleanups = [];
        const listen = (target, type, handler, options) => {
            target.addEventListener(type, handler, options);
            cleanups.push(() => target.removeEventListener(type, handler, options));
        };
        const timers = new Set();
        const later = (fn, ms) => {
            const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
            timers.add(id);
            return id;
        };
        const cancel = (id) => { if (id) { clearTimeout(id); timers.delete(id); } };

        host.innerHTML = `
<button class="md-np" type="button" data-md="np" aria-label="进入歌词舞台">
  <span class="md-np-cv"><span class="md-np-img"></span></span>
  <span class="md-np-tx"><span class="md-np-k">正在播放</span><span class="md-np-t"></span><span class="md-np-a"></span></span>
</button>
<div class="md-dock"><div class="md-dock-in">
  <div class="md-quick"><div class="md-quick-in"><div class="md-quick-g" role="toolbar" aria-label="快捷操作"></div></div></div>
  <div class="md-cap" title="点一下进入歌词舞台">
    <div class="md-cap-c">
      <div class="md-prow"><span class="md-tm" data-md="t1"></span><div class="md-trk" role="slider" aria-label="播放进度" tabindex="0"><div class="md-fill"></div><div class="md-kn-rail"><div class="md-kn"></div></div></div><span class="md-tm md-r" data-md="t2"></span></div>
    </div>
    <div class="md-cap-e">
      <button class="md-pb" type="button" data-md="play" aria-label="播放"></button>
      <div class="md-ttl"><div class="md-tnav">
        <div class="md-zone md-l"><button class="md-arw" type="button" data-md="prev" aria-label="上一首">${icon('chevron-left', 16, { strokeWidth: 2.4 })}</button></div>
        <div class="md-zone md-r"><button class="md-arw" type="button" data-md="next" aria-label="下一首">${icon('chevron-right', 16, { strokeWidth: 2.4 })}</button></div>
        <div class="md-txt"><div class="md-cur"><span data-md="title"></span></div><div class="md-pv"><span data-md="preview"></span></div></div>
      </div></div>
      <div class="md-slots">
        <button class="md-slot" type="button" data-md="mode"></button>
        <button class="md-slot" type="button" data-md="stage" aria-label="歌词舞台">${icon('captions', 18)}</button>
        <button class="md-slot md-vslot" type="button" data-md="vol" aria-label="静音"></button>
      </div>
      <div class="md-prow"><span class="md-tm" data-md="t1"></span><div class="md-trk" role="slider" aria-label="播放进度" tabindex="0"><div class="md-fill"></div><div class="md-kn-rail"><div class="md-kn"></div></div></div><span class="md-tm md-r" data-md="t2"></span></div>
    </div>
  </div>
</div></div>
<div class="md-hdl"><button type="button" data-md="handle" aria-label="打开面板" aria-expanded="false" aria-controls="music-dock-panel">
  <span class="md-sw md-g">${icon('settings-2', 20)}</span><span class="md-sw md-x">${icon('x', 20)}</span>
</button></div>
<section class="md-pnl" id="music-dock-panel" role="dialog" aria-label="播放面板" aria-hidden="true">
  <div class="md-hd">
    <div class="md-hd-cv"></div>
    <div class="md-hd-tx"><b data-md="p-title"></b><span data-md="p-artist"></span></div>
    <button class="md-ib md-m md-hd-act" type="button" data-md="share" aria-label="分享当前音频" title="分享当前音频">${icon('share-2', 17)}</button>
  </div>
  <div class="md-body"><div class="md-hr"></div><div class="md-tab" data-md="body"></div></div>
  <div class="md-dockrow"><div class="md-seg md-seg-l" data-md="tabs" role="tablist"></div></div>
</section>
<div class="md-pop" role="listbox" aria-label="选择舞台"><div class="md-pop-g"></div>
  <button class="md-pop-more" type="button" data-md="pop-more"><span>更多舞台设置</span>${icon('chevron-right', 14)}</button>
</div>
<section class="md-sheet" role="dialog" aria-label="音效设置" aria-hidden="true">
  <div class="md-sheet-hd"><b>音效设置</b><button class="md-ib md-m" type="button" data-md="sheet-close" aria-label="关闭音效设置">${icon('x', 17)}</button></div>
  <div class="md-sheet-body"></div>
</section>`;

        const $ = (sel) => host.querySelector(sel);
        const $$ = (sel) => Array.from(host.querySelectorAll(sel));
        const el = {
            np: $('[data-md="np"]'),
            npImg: $('.md-np-img'),
            npTitle: $('.md-np-t'),
            npArtist: $('.md-np-a'),
            dockIn: $('.md-dock-in'),
            quick: $('.md-quick'),
            quickGroup: $('.md-quick-g'),
            cap: $('.md-cap'),
            play: $('[data-md="play"]'),
            prev: $('[data-md="prev"]'),
            next: $('[data-md="next"]'),
            tnav: $('.md-tnav'),
            cur: $('.md-cur'),
            pv: $('.md-pv'),
            title: $('[data-md="title"]'),
            preview: $('[data-md="preview"]'),
            modeSlot: $('[data-md="mode"]'),
            stageSlot: $('[data-md="stage"]'),
            volSlot: $('[data-md="vol"]'),
            tracks: $$('.md-trk'),
            t1: $$('[data-md="t1"]'),
            t2: $$('[data-md="t2"]'),
            hdl: $('.md-hdl'),
            handle: $('[data-md="handle"]'),
            pnl: $('.md-pnl'),
            pCover: $('.md-hd-cv'),
            pTitle: $('[data-md="p-title"]'),
            pArtist: $('[data-md="p-artist"]'),
            share: $('[data-md="share"]'),
            body: $('[data-md="body"]'),
            tabs: $('[data-md="tabs"]'),
            pop: $('.md-pop'),
            popGrid: $('.md-pop-g'),
            popMore: $('[data-md="pop-more"]'),
            sheet: $('.md-sheet'),
            sheetBody: $('.md-sheet-body'),
            sheetClose: $('[data-md="sheet-close"]')
        };

        const state = {
            hover: false,
            expanded: false,
            panelOpen: false,
            tab: '控制',
            popOpen: false,
            sheetOpen: false,
            dragging: null,
            lastTimeText: '',
            lastDurText: '',
            lyricIndex: -2,
            lyricsSource: null,
            queueSource: null,
            queueLength: -1,
            trackKey: '',
            destroyed: false
        };
        let expandTimer = null;
        let collapseTimer = null;
        let dwellTimer = null;
        let progressTimer = null;

        document.body.style.setProperty('--music-dock-safe-bottom', `${SAFE_BOTTOM_PX}px`);
        document.body.classList.add('music-dock-on');

        // ───────── 读状态 ─────────
        const currentTrack = () => app.playlist?.[app.currentTrackIndex] || null;
        const activeList = () => app.currentFilteredTracks || app.playlist || [];
        const playMode = () => app.playModes?.[app.currentPlayMode] || 'repeat';
        const stageActive = () => app.isStageActive === true || document.body.classList.contains('music-stage-active');
        const duration = () => Math.max(0, Number(app.lastKnownDuration) || 0);
        const currentTime = () => {
            if (state.dragging) return state.dragging.time;
            const base = Number(app.lastKnownCurrentTime) || 0;
            const elapsed = app.isPlaying && app.lastStateUpdateTime && !app.isTrackLoading
                ? (Date.now() - app.lastStateUpdateTime) / 1000
                : 0;
            const d = duration();
            const t = base + elapsed;
            return d > 0 ? Math.min(d, Math.max(0, t)) : Math.max(0, t);
        };
        const trackTitle = (track) => track ? (app.stripAudioExtension?.(track.title) || track.title || '未知标题') : '未选择歌曲';
        const trackArtist = (track) => track ? (track.artist || '未知艺术家') : '';
        const coverUrl = (track) => track?.albumArt ? fileUrl(track.albumArt) : '';

        // ───────── 胶囊弹簧 ─────────
        const spring = { w: { v: 0, vel: 0 }, h: { v: CAPSULE_H_COLLAPSED, vel: 0 } };
        let springFrame = 0;
        let springLast = 0;
        const capsuleTarget = () => {
            const max = Math.min(CAPSULE_MAX_W, Math.max(0, global.innerWidth - 32));
            // 窄窗口（紧凑档）收起和展开同宽，面板把手挂在胶囊右端。
            const ratio = global.innerWidth < COMPACT_BELOW ? 1 : global.innerWidth >= 768 ? 0.6 : 0.8;
            return state.expanded
                ? { w: max, h: CAPSULE_H_EXPANDED }
                : { w: Math.round(max * ratio), h: CAPSULE_H_COLLAPSED };
        };
        // 「降低动态」统一读音乐窗口的设置（跟随系统 / 开 / 关）；没有这个模块时才退回系统设置。
        const systemReduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const reducedMotion = {
            get matches() { return global.MusicMotion ? global.MusicMotion.reduced() : Boolean(systemReduced?.matches); }
        };
        if (!global.MusicMotion && systemReduced) {
            const syncBodyClass = () => document.body.classList.toggle('music-reduce-motion', systemReduced.matches);
            syncBodyClass();
            listen(systemReduced, 'change', syncBodyClass);
        }
        const writeCapsuleSize = () => {
            el.cap.style.width = `${spring.w.v.toFixed(2)}px`;
            el.cap.style.height = `${spring.h.v.toFixed(2)}px`;
        };
        const stepSpring = (now) => {
            springFrame = 0;
            const dt = Math.min((now - springLast) / 1000, 1 / 30);
            springLast = now;
            const target = capsuleTarget();
            let moving = false;
            for (const key of ['w', 'h']) {
                const s = spring[key];
                const sub = dt / 6;
                for (let i = 0; i < 6; i++) {
                    const accel = -SPRING_K * (s.v - target[key]) - SPRING_C * s.vel;
                    s.vel += accel * sub;
                    s.v += s.vel * sub;
                }
                if (Math.abs(s.v - target[key]) > 0.25 || Math.abs(s.vel) > 0.5) moving = true;
                else { s.v = target[key]; s.vel = 0; }
            }
            writeCapsuleSize();
            if (moving && !state.destroyed) springFrame = requestAnimationFrame(stepSpring);
        };
        const animateCapsule = (instant = false) => {
            if (instant || reducedMotion?.matches || document.hidden) {
                if (springFrame) cancelAnimationFrame(springFrame);
                springFrame = 0;
                const target = capsuleTarget();
                spring.w.v = target.w; spring.h.v = target.h;
                spring.w.vel = spring.h.vel = 0;
                writeCapsuleSize();
                return;
            }
            if (springFrame) return;
            springLast = performance.now();
            springFrame = requestAnimationFrame(stepSpring);
        };

        const shouldExpand = () => state.hover
            || state.dragging !== null
            || (!app.isPlaying && !app.isTrackLoading && duration() > 0 && currentTime() > 0);
        const syncExpanded = () => {
            const next = shouldExpand();
            if (next === state.expanded) return;
            state.expanded = next;
            el.cap.classList.toggle('md-ex', next);
            animateCapsule();
        };

        // ───────── 进度 ─────────
        const renderProgress = () => {
            const d = duration();
            const t = currentTime();
            const fraction = d > 0 ? Math.min(1, t / d) : 0;
            for (const trk of el.tracks) {
                trk.firstElementChild.style.transform = `scaleX(${fraction.toFixed(5)})`;
                trk.querySelector('.md-kn-rail').style.transform = `translateX(${(fraction * 100).toFixed(3)}%)`;
                trk.setAttribute('aria-valuenow', String(Math.round(t)));
            }
            const timeText = formatClock(t);
            const durText = formatClock(d);
            if (timeText !== state.lastTimeText) {
                state.lastTimeText = timeText;
                for (const node of el.t1) node.textContent = timeText;
            }
            if (durText !== state.lastDurText) {
                state.lastDurText = durText;
                for (const node of el.t2) node.textContent = durText;
                for (const trk of el.tracks) trk.setAttribute('aria-valuemax', String(Math.round(d)));
            }
            if (state.panelOpen && state.tab === '歌词') syncLyricHighlight();
        };
        const progressLoop = () => {
            progressTimer = null;
            if (state.destroyed) return;
            renderProgress();
            if (app.isPlaying && !document.hidden) progressTimer = later(progressLoop, PROGRESS_TICK_MS);
        };
        const kickProgress = () => {
            if (progressTimer) cancel(progressTimer);
            progressTimer = null;
            progressLoop();
            syncExpanded();
        };

        const seekFromPointer = (trk, clientX) => {
            const rect = trk.getBoundingClientRect();
            const d = duration();
            if (!(d > 0) || rect.width <= 0) return null;
            const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            return fraction * d;
        };
        for (const trk of el.tracks) {
            listen(trk, 'pointerdown', (event) => {
                if (event.button !== 0) return;
                const time = seekFromPointer(trk, event.clientX);
                if (time === null) return;
                event.preventDefault();
                event.stopPropagation();
                trk.setPointerCapture?.(event.pointerId);
                state.dragging = { time, trk, pointerId: event.pointerId };
                trk.classList.add('md-held');
                renderProgress();
            });
            listen(trk, 'pointermove', (event) => {
                if (!state.dragging || state.dragging.trk !== trk) return;
                const time = seekFromPointer(trk, event.clientX);
                if (time === null) return;
                state.dragging.time = time;
                renderProgress();
            });
            const finish = (event, commit) => {
                if (!state.dragging || state.dragging.trk !== trk) return;
                const { time } = state.dragging;
                state.dragging = null;
                trk.classList.remove('md-held');
                trk.releasePointerCapture?.(event.pointerId);
                if (commit) app.seekTo?.(time);
                kickProgress();
            };
            listen(trk, 'pointerup', (event) => finish(event, true));
            listen(trk, 'pointercancel', (event) => finish(event, false));
            listen(trk, 'click', (event) => event.stopPropagation());
            listen(trk, 'keydown', (event) => {
                const d = duration();
                if (!(d > 0)) return;
                const step = event.shiftKey ? 15 : 5;
                let target = null;
                if (event.key === 'ArrowLeft') target = currentTime() - step;
                else if (event.key === 'ArrowRight') target = currentTime() + step;
                else if (event.key === 'Home') target = 0;
                else if (event.key === 'End') target = Math.max(0, d - 1);
                if (target === null) return;
                event.preventDefault();
                app.seekTo?.(Math.min(d, Math.max(0, target)));
                kickProgress();
            });
        }

        // ───────── 胶囊悬停与快捷行 ─────────
        const setQuick = (show) => el.quick.classList.toggle('md-show', show);
        listen(el.cap, 'pointerenter', (event) => {
            if (event.pointerType === 'touch') return;
            cancel(collapseTimer); collapseTimer = null;
            if (!state.hover && !expandTimer) {
                expandTimer = later(() => {
                    expandTimer = null;
                    state.hover = true;
                    syncExpanded();
                }, HOVER_EXPAND_MS);
            }
            if (!dwellTimer) dwellTimer = later(() => { dwellTimer = null; setQuick(true); }, QUICK_DWELL_MS);
        });
        listen(el.dockIn, 'pointerleave', () => {
            cancel(expandTimer); expandTimer = null;
            cancel(dwellTimer); dwellTimer = null;
            setQuick(false);
            if (!state.hover || collapseTimer) return;
            collapseTimer = later(() => {
                collapseTimer = null;
                state.hover = false;
                syncExpanded();
            }, HOVER_COLLAPSE_MS);
        });
        listen(el.cap, 'click', (event) => {
            if (event.target.closest('button, .md-trk')) return;
            // 舞台里点胶囊就在要去的地方，这一下改成打开命令面板。
            if (!stageActive()) app.stageHost?.enter?.();
            else if (palette) palette.open();
            else openPanel();
        });

        const quickItems = () => {
            const inStage = stageActive();
            return [
                { id: 'volume', icon: volumeIcon(), label: '音量', run: () => openPanel('控制') },
                { id: 'queue', icon: 'list-music', label: '播放列表', run: () => openPanel('播放列表') },
                { id: 'stage', icon: 'captions', label: inStage ? '离开歌词舞台' : '歌词舞台', on: inStage, run: toggleStage },
                { id: 'fx', icon: 'sliders-horizontal', label: '音效设置', run: () => openSheet() }
            ];
        };
        const renderQuick = () => {
            const items = quickItems();
            el.quickGroup.innerHTML = items.map((item) => (
                `<button class="md-qb${item.on ? ' md-on' : ''}" type="button" data-q="${item.id}" title="${item.label}" aria-label="${item.label}"${item.on ? ' aria-pressed="true"' : ''}>${icon(item.icon, 16)}</button>`
            )).join('') + '<span class="md-qsep" aria-hidden="true"></span>'
                + `<button class="md-qb" type="button" data-q="panel" title="命令面板（Ctrl+K）" aria-label="命令面板">${icon('command', 16)}</button>`;
        };
        listen(el.quickGroup, 'click', (event) => {
            const button = event.target.closest('[data-q]');
            if (!button) return;
            event.stopPropagation();
            if (button.dataset.q === 'panel') { if (palette) palette.toggle(); else togglePanel(); return; }
            quickItems().find((item) => item.id === button.dataset.q)?.run();
        });

        // ───────── 播放按钮、切歌、两个槽位 ─────────
        const renderPlay = () => {
            const playing = app.isPlaying === true;
            el.play.innerHTML = playing
                ? icon('pause', 20, { fill: 'currentColor' })
                : `<span class="md-play-nudge">${icon('play', 20, { fill: 'currentColor' })}</span>`;
            el.play.setAttribute('aria-label', playing ? '暂停' : '播放');
        };
        listen(el.play, 'click', (event) => {
            event.stopPropagation();
            if (app.isPlaying) app.pauseTrack?.();
            else app.playTrack?.();
        });

        // 悬停标题区左右两边时预览上一首 / 下一首：下一首取播放器的真实队列（手动层优先，随机时也是洗好的那首），
        // 上一首按播放历史。播放器没提供这两个接口时退回按列表前后数。
        const neighbour = (dir) => {
            if (dir > 0 && typeof app.getUpNext === 'function') {
                const up = app.getUpNext(1);
                return up.manual[0] || up.context[0] || null;
            }
            if (dir < 0 && typeof app.peekPrevious === 'function') return app.peekPrevious();
            const list = activeList();
            if (!list.length) return null;
            if (playMode() === 'shuffle' && dir > 0) return null;
            const pos = list.indexOf(currentTrack());
            return list[((Math.max(pos, 0) + dir) % list.length + list.length) % list.length] || null;
        };
        const showPreview = (track) => {
            el.tnav.classList.toggle('md-previewing', Boolean(track));
            if (track) el.preview.textContent = trackTitle(track);
        };
        listen($('.md-zone.md-l'), 'pointerenter', () => showPreview(neighbour(-1)));
        listen($('.md-zone.md-r'), 'pointerenter', () => showPreview(neighbour(1)));
        listen($('.md-zone.md-l'), 'pointerleave', () => showPreview(null));
        listen($('.md-zone.md-r'), 'pointerleave', () => showPreview(null));
        const slideTitle = (dir) => {
            if (reducedMotion?.matches) return;
            el.cur.style.transition = 'none';
            el.cur.style.transform = `translateX(${dir * 12}px)`;
            el.cur.style.opacity = '0';
            requestAnimationFrame(() => {
                el.cur.style.transition = '';
                el.cur.style.transform = '';
                el.cur.style.opacity = '';
            });
        };
        listen(el.prev, 'click', (event) => { event.stopPropagation(); showPreview(null); slideTitle(-1); app.prevTrack?.(); });
        listen(el.next, 'click', (event) => { event.stopPropagation(); showPreview(null); slideTitle(1); app.nextTrack?.(); });

        const cycleMode = () => {
            if (typeof app.setPlayMode === 'function') app.setPlayMode((app.currentPlayMode || 0) + 1);
            else app.modeBtn?.click();
        };
        const renderMode = () => {
            const mode = playMode();
            el.modeSlot.innerHTML = icon(MODE_ICONS[mode] || 'repeat', 18);
            el.modeSlot.classList.toggle('md-on', mode !== 'repeat');
            el.modeSlot.setAttribute('aria-label', MODE_LABELS[mode] || '播放模式');
            el.modeSlot.title = MODE_LABELS[mode] || '播放模式';
        };
        listen(el.modeSlot, 'click', (event) => { event.stopPropagation(); cycleMode(); });

        const toggleStage = () => app.stageHost?.toggle?.();
        listen(el.stageSlot, 'click', (event) => { event.stopPropagation(); toggleStage(); });
        // 胶囊右侧的音量：悬停时滚轮调（一格 5%，触控板按累计距离算），单击静音 / 恢复。
        let wheelAcc = 0;
        let vtipTimer = null;
        // 调的时候在歌名那一行借位显示「音量 55%」，停手 0.9 秒后换回歌名（胶囊会裁掉外面的气泡）。
        const flashVolume = () => {
            const v = readVolume();
            el.volSlot.classList.add('md-vshow');
            el.preview.textContent = v > 0.001 ? `音量 ${Math.round(v * 100)}%` : '已静音';
            el.tnav.classList.add('md-previewing');
            clearTimeout(vtipTimer);
            vtipTimer = setTimeout(() => {
                el.volSlot.classList.remove('md-vshow');
                el.tnav.classList.remove('md-previewing');
            }, 900);
            timers.add(vtipTimer);
        };
        listen(el.volSlot, 'click', (event) => { event.stopPropagation(); toggleMute(); flashVolume(); });
        listen(el.volSlot, 'wheel', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 400 : 1;
            wheelAcc += (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
            const steps = Math.trunc(wheelAcc / 100); // 鼠标滚轮一格约 100px
            if (!steps) return;
            wheelAcc -= steps * 100;
            setVolume(Math.round((readVolume() - steps * 0.05) * 100) / 100);
            flashVolume();
        }, { passive: false });
        listen(el.np, 'click', () => app.stageHost?.enter?.());

        const renderStage = () => {
            const inStage = stageActive();
            el.stageSlot.classList.toggle('md-on', inStage);
            el.stageSlot.setAttribute('aria-pressed', String(inStage));
            el.stageSlot.title = inStage ? '离开歌词舞台' : '歌词舞台';
            el.cap.title = inStage ? '点一下打开命令面板（Ctrl+K）' : '点一下进入歌词舞台';
            renderQuick();
            if (state.panelOpen && state.tab === '控制') renderBody();
        };

        // ───────── 曲目信息 ─────────
        const renderTrack = () => {
            const track = currentTrack();
            const title = trackTitle(track);
            const artist = trackArtist(track);
            const cover = coverUrl(track);
            const key = track?.path || '';
            el.title.textContent = title;
            el.npTitle.textContent = title;
            el.npArtist.textContent = artist;
            el.pTitle.textContent = title;
            el.pArtist.textContent = artist;
            el.np.hidden = !track;
            const coverCss = cover ? `url("${cover.replace(/"/g, '%22')}")` : '';
            el.npImg.style.backgroundImage = coverCss;
            el.npImg.classList.toggle('md-empty', !cover);
            el.pCover.innerHTML = cover ? '' : icon('music', 18);
            el.pCover.style.backgroundImage = coverCss;
            if (key !== state.trackKey) {
                state.trackKey = key;
                // 换了歌，上一首的加载失败提示就不用再留着了。
                if (state.noticeTrackKey && state.noticeTrackKey !== key) { global.MusicToast?.dismiss('playback'); state.noticeTrackKey = ''; }
                state.lyricIndex = -2;
                if (state.panelOpen) renderBody();
            }
        };
        listen(el.share, 'click', () => {
            if (app.pendingTrackPath) app.api?.shareMusicTrack?.(app.pendingTrackPath);
        });

        // ───────── 音量 ─────────
        const readVolume = () => {
            const v = parseFloat(app.volumeSlider?.value);
            return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
        };
        function volumeIcon(v = readVolume()) {
            return v <= 0.001 ? 'volume-x' : v < 0.5 ? 'volume-1' : 'volume-2';
        }
        // 静音前的音量记下来（也存一份，重启后再点也能恢复到原来的大小）。
        const MUTE_KEY = 'musicDockVolumeBeforeMute';
        let volumeBeforeMute = (() => {
            try { const v = parseFloat(global.localStorage.getItem(MUTE_KEY)); return v > 0.001 && v <= 1 ? v : 1; } catch (error) { return 1; }
        })();
        const toggleMute = () => {
            const v = readVolume();
            if (v > 0.001) {
                volumeBeforeMute = v;
                try { global.localStorage.setItem(MUTE_KEY, String(v)); } catch (error) {}
                setVolume(0);
            } else setVolume(volumeBeforeMute || 1);
        };
        const setVolume = (value) => {
            const slider = app.volumeSlider;
            if (!slider) return;
            const v = Math.min(1, Math.max(0, value));
            slider.value = String(Math.round(v * 100) / 100);
            // 走旧滑块的 input 处理：节流发给引擎、同步舞台、保存设置都在那里。
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            renderVolume();
        };
        const renderVolume = () => {
            const v = readVolume();
            const row = el.body.querySelector('.md-vol');
            if (row) {
                row.querySelector('.md-sld-fill').style.transform = `scaleX(${v})`;
                row.querySelector('.md-sld-kn').style.left = `calc(${v} * (100% - 16px))`;
                row.querySelector('.md-pct').textContent = `${Math.round(v * 100)}%`;
                row.querySelector('.md-sld').setAttribute('aria-valuenow', String(Math.round(v * 100)));
                const btn = row.querySelector('[data-act="mute"]');
                const name = volumeIcon(v);
                if (btn.dataset.icon !== name) { btn.dataset.icon = name; btn.innerHTML = icon(name, 17); }
            }
            if (el.volSlot) {
                const name = volumeIcon(v);
                const pct = Math.round(v * 100);
                if (el.volSlot.dataset.icon !== name) {
                    el.volSlot.dataset.icon = name;
                    el.volSlot.innerHTML = icon(name, 18);
                }
                el.volSlot.setAttribute('aria-label', v > 0.001 ? `静音（音量 ${pct}%）` : '取消静音');
                el.volSlot.title = v > 0.001 ? `音量 ${pct}%：滚轮调节，点一下静音（M）` : '已静音：点一下恢复（M）';
            }
            const qb = el.quickGroup.querySelector('[data-q="volume"]');
            if (qb) {
                const name = volumeIcon(v);
                if (qb.dataset.icon !== name) { qb.dataset.icon = name; qb.innerHTML = icon(name, 16); }
            }
        };

        // ───────── 面板 ─────────
        const segment = (attrs, options, activeIndex, extraClass = '') => (
            `<div class="md-seg ${extraClass}" ${attrs}><i class="md-mk"></i>${options.map((option, index) => (
                `<button type="button" class="${index === activeIndex ? 'md-on' : ''}" data-i="${index}"${option.aria ? ` aria-label="${option.aria}"` : ''}><span>${option.html}</span></button>`
            )).join('')}</div>`
        );
        const placeMarks = (root) => {
            for (const seg of root.querySelectorAll('.md-seg')) {
                const on = seg.querySelector('button.md-on');
                const mark = seg.querySelector('.md-mk');
                if (!on || !mark) continue;
                mark.style.left = `${on.offsetLeft}px`;
                mark.style.width = `${on.offsetWidth}px`;
            }
        };

        const stageModes = () => global.MusicStageConfig?.modes || [];
        const currentStageMode = () => {
            const id = app.stageHost?.modeId;
            return stageModes().find((mode) => mode.id === id) || stageModes()[0] || null;
        };

        const facts = () => {
            const track = currentTrack();
            const pickText = (select) => select?.selectedOptions?.[0]?.textContent?.trim() || '';
            const ext = (track?.path || '').split('.').pop();
            const rows = [
                ['来源', track ? (/^https?:/i.test(track.path || '') ? '云端' : '本地文件') : '—'],
                ['格式', track ? [ext && ext.length <= 5 ? ext.toUpperCase() : '', track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : ''].filter(Boolean).join(' · ') || '—' : '—'],
                ['输出', [pickText(app.deviceSelect) || '默认设备', app.wasapiSwitch?.checked ? 'WASAPI 独占' : ''].filter(Boolean).join(' · ')],
                ['升频', pickText(app.upsamplingSelect) || '关闭'],
                ['均衡器', app.eqSwitch?.checked ? `开 · ${pickText(app.eqTypeSelect) || 'IIR'}` : '关'],
                ['响度', app.loudnessSwitch?.checked === false ? '关' : (pickText(app.loudnessModeSelect) || '开')],
                ['抖动', app.ditherSwitch?.checked ? '开' : '关']
            ];
            return rows;
        };

        function renderBody() {
            const oldScroller = state.tab === '播放列表' ? el.body.querySelector('.md-ql') : null;
            const keepScroll = oldScroller ? oldScroller.scrollTop : null;
            const tab = state.tab;
            let html = '';
            if (tab === '控制') {
                const v = readVolume();
                const mode = playMode();
                const inStage = stageActive();
                const scene = currentStageMode();
                const light = document.body.classList.contains('light-theme');
                html += `<div class="md-vol"><button class="md-ib md-m" type="button" data-act="mute" data-icon="${volumeIcon(v)}" aria-label="静音">${icon(volumeIcon(v), 17)}</button>`
                    + `<div class="md-sld" role="slider" tabindex="0" aria-label="音量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v * 100)}"><span class="md-sld-tr"><i class="md-sld-fill" style="transform:scaleX(${v})"></i></span><span class="md-sld-kn" style="left:calc(${v} * (100% - 16px))"></span></div>`
                    + `<span class="md-pct">${Math.round(v * 100)}%</span></div>`;
                html += '<div class="md-tiles">'
                    + `<button class="md-tile${mode !== 'repeat' ? ' md-lit' : ''}" type="button" data-act="mode"><span class="md-ti">${icon(MODE_ICONS[mode] || 'repeat', 18)}</span><span>${MODE_LABELS[mode] || '播放模式'}</span></button>`
                    + `<button class="md-tile${inStage ? ' md-lit' : ''}" type="button" data-act="stage" aria-pressed="${inStage}"><span class="md-ti">${icon('captions', 18)}</span><span>歌词舞台</span></button>`
                    + `<button class="md-tile" type="button" data-act="fx"><span class="md-ti">${icon('sliders-horizontal', 18)}<span class="md-chev">${icon('chevron-right', 14)}</span></span><span>音频效果器</span></button>`
                    + '</div><div class="md-sep"></div>';
                if (scene) {
                    html += `<div class="md-mode"><div class="md-rw"><button class="md-st" type="button" data-act="scene-step" data-d="-1" aria-label="上一个舞台">${icon('chevron-left', 14)}</button>`
                        + `<button class="md-mid${state.popOpen ? ' md-open' : ''}" type="button" data-act="scene-pick" aria-haspopup="listbox" aria-expanded="${state.popOpen}"><span class="md-in"><span class="md-pic">${icon('clapperboard', 16)}</span>`
                        + `<span class="md-mid-tx"><span class="md-cap2">舞台</span><span class="md-val"><span>${escapeHtml(scene.label)}</span>${icon('chevron-down', 13)}</span></span></span></button>`
                        + `<button class="md-st" type="button" data-act="scene-step" data-d="1" aria-label="下一个舞台">${icon('chevron-right', 14)}</button></div></div>`;
                    html += '<div class="md-sep"></div>';
                }
                html += `<div class="md-nrow"><span class="md-lb">${light ? '日光素白' : '午夜墨染'}</span><span class="md-r">`
                    + segment('data-act="theme"', [{ html: icon('sun', 15), aria: '浅色' }, { html: icon('moon', 15), aria: '深色' }], light ? 0 : 1, 'md-inline')
                    + '</span></div>';
                const motion = global.MusicMotion;
                if (motion && Array.isArray(motion.PREFERENCES)) {
                    const prefs = motion.PREFERENCES;
                    const at = Math.max(0, prefs.findIndex((p) => p.value === motion.preference));
                    html += `<div class="md-nrow"><span class="md-lb">降低动态</span><span class="md-r">`
                        + segment('data-act="motion"', prefs.map((p) => ({ html: escapeHtml(p.label), aria: `降低动态：${p.label}` })), at, 'md-inline md-seg-tx')
                        + '</span></div>';
                }
                if (typeof global.MusicIntro?.replay === 'function') {
                    html += `<button class="md-wide md-intro" type="button" data-act="intro">${icon('clapperboard', 15)}<span>播放完整开场</span>${icon('chevron-right', 14)}</button>`;
                }
            } else if (tab === '播放列表') {
                const rows = buildQueueRows();
                const upcoming = rows.filter((r) => r.type === 'manual' || r.type === 'ctx').length;
                html += `<div class="md-qh"><b>播放队列</b><span>${upcoming}</span><span class="md-g"></span>`
                    + `<button class="md-ib md-s${playMode() === 'shuffle' ? ' md-lit' : ''}" type="button" data-act="shuffle" aria-label="随机播放" title="随机播放">${icon('shuffle', 15)}</button></div>`
                    + (rows.length ? `<div class="md-ql" role="list"><div class="md-ql-sizer" style="height:${rows.total}px"></div></div>` : '<p class="md-empty">还没有歌曲，用左侧“本地”添加音乐文件夹。</p>');
            } else if (tab === '封面') {
                const cover = coverUrl(currentTrack());
                html += cover
                    ? `<div class="md-bigcv"><img src="${escapeHtml(cover)}" alt="封面" decoding="async"></div>`
                    : `<div class="md-bigcv md-empty-cv">${icon('disc-3', 48, { strokeWidth: 1.4 })}</div>`;
            } else if (tab === '歌词') {
                const lines = Array.isArray(app.currentLyrics) ? app.currentLyrics : [];
                html += lines.length
                    ? `<div class="md-lyrl">${lines.map((line, index) => `<p data-i="${index}" data-time="${Number(line.time) || 0}">${escapeHtml(line.text || line.original || '') || '&nbsp;'}</p>`).join('')}</div>`
                    : '<p class="md-empty">这首歌还没有歌词。</p>';
                state.lyricsSource = app.currentLyrics;
                state.lyricIndex = -2;
            } else {
                html += `<dl class="md-facts">${facts().map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`
                    + `<button class="md-wide" type="button" data-act="fx">${icon('sliders-horizontal', 15)}<span>打开完整音效设置</span>${icon('chevron-right', 14)}</button>`;
            }
            el.body.innerHTML = html;
            placeMarks(el.body);
            if (tab === '播放列表') {
                state.queueSource = activeList();
                state.queueLength = state.queueSource.length;
                const scroller = el.body.querySelector('.md-ql');
                if (scroller) {
                    // 重画时保住滚动位置；第一次打开时从正在放的那首开始。
                    scroller.scrollTop = keepScroll != null ? keepScroll : 0;
                    renderQueueWindow(scroller);
                    scroller.addEventListener('scroll', () => renderQueueWindow(scroller), { passive: true });
                    scroller.addEventListener('pointerdown', onQueuePointerDown);
                }
            }
            if (tab === '歌词') syncLyricHighlight(true);
        }

        // ───────── 播放队列页 ─────────
        // 一张表里三段：正在播放 → 手动队列（可拖动排序、移除、清空）→ 接下来会放的上下文
        // （随机时就是洗好的真实顺序）。上下文可能有上千首：只画看得见的那几行。
        const QUEUE_HEAD_H = 36;
        function buildQueueRows() {
            const current = currentTrack();
            const up = typeof app.getUpNext === 'function'
                ? app.getUpNext(2000)
                : { manual: [], context: activeList().filter((t) => t !== current) };
            const rows = [];
            let y = 0;
            const push = (row, h) => { row.top = y; row.h = h; y += h; rows.push(row); };
            if (current) push({ type: 'now', track: current }, QUEUE_ROW_H);
            if (up.manual.length) {
                push({ type: 'head', label: '接下来播放', count: up.manual.length, clear: true }, QUEUE_HEAD_H);
                up.manual.forEach((track, i) => push({ type: 'manual', i, track }, QUEUE_ROW_H));
            }
            if (up.context.length) {
                const mode = playMode();
                const name = app.filteredPlaylistSource?.name || (app.currentFilteredTracks ? '当前列表' : '全部曲目');
                const label = mode === 'shuffle' ? `随机 · ${name}` : mode === 'repeat-one' ? '单曲循环' : `接着播放 · ${name}`;
                push({ type: 'head', label, count: up.context.length }, QUEUE_HEAD_H);
                up.context.forEach((track) => push({ type: 'ctx', track }, QUEUE_ROW_H));
            }
            rows.total = y;
            state.queueRows = rows;
            return rows;
        }

        const queueRowHtml = (row, k, current) => {
            const style = `top:${row.top}px;height:${row.h - 2}px`;
            if (row.type === 'head') {
                return `<div class="md-qhd" role="presentation" style="${style}"><span>${escapeHtml(row.label)}</span><em>${row.count}</em>`
                    + (row.clear ? '<span class="md-g"></span><button class="md-qclr" type="button" data-qact="clear">清空</button>' : '') + '</div>';
            }
            const text = `<span class="md-qi-tx"><b>${escapeHtml(trackTitle(row.track))}</b><span>${escapeHtml(trackArtist(row.track))}</span></span>`;
            if (row.type === 'now') {
                return `<div class="md-qi md-cur md-now" role="listitem" style="${style}">${text}<span class="md-g"></span><span class="md-qtag">正在播放</span></div>`;
            }
            if (row.type === 'manual') {
                return `<div class="md-qi md-man" role="listitem" data-k="${k}" data-qi="${row.i}" style="${style}">`
                    + `<span class="md-qgrip" title="拖动排序" aria-hidden="true">${icon('grip-vertical', 14)}</span>`
                    + `<button class="md-qplay" type="button" data-qact="play" aria-label="现在播放 ${escapeHtml(trackTitle(row.track))}">${text}</button>`
                    + `<button class="md-qx" type="button" data-qact="remove" aria-label="从队列移除" title="从队列移除">${icon('x', 14)}</button></div>`;
            }
            return `<div class="md-qi${row.track === current ? ' md-cur' : ''}" role="listitem" data-k="${k}" style="${style}">`
                + `<button class="md-qplay" type="button" data-qact="play" aria-label="播放 ${escapeHtml(trackTitle(row.track))}">${text}</button>`
                + `<button class="md-qx md-qnext" type="button" data-qact="next" aria-label="下一首播放" title="下一首播放">${icon('list-plus', 15)}</button></div>`;
        };

        function renderQueueWindow(scroller, force = false) {
            if (state.queueDrag?.active) return; // 拖动时别重建行
            const rows = state.queueRows || [];
            const top = scroller.scrollTop - QUEUE_ROW_H * 4;
            const bottom = scroller.scrollTop + (scroller.clientHeight || 300) + QUEUE_ROW_H * 4;
            let first = 0;
            while (first < rows.length && rows[first].top + rows[first].h < top) first++;
            let last = first;
            while (last < rows.length && rows[last].top < bottom) last++;
            const key = `${first}:${last}:${app.currentTrackIndex}:${rows.length}`;
            if (!force && scroller.dataset.window === key) return;
            scroller.dataset.window = key;
            const current = currentTrack();
            // 手动队列的行总是全画出来，拖动排序时才有地方让位。
            const keep = new Set();
            for (let k = first; k < last; k++) keep.add(k);
            rows.forEach((row, k) => { if (row.type === 'manual' && rows.length < 400) keep.add(k); });
            scroller.firstElementChild.innerHTML = [...keep].sort((a, b) => a - b).map((k) => queueRowHtml(rows[k], k, current)).join('');
        }

        function rerenderQueue() {
            if (!state.panelOpen || state.tab !== '播放列表' || state.queueDrag?.active) return;
            renderBody();
        }

        // 拖动排序：按住超过 4px 才算拖；其他行 140ms 让位；靠近上下边 32px 自动滚动。
        function onQueuePointerDown(event) {
            const rowEl = event.target.closest('.md-man');
            if (!rowEl || event.button !== 0 || event.target.closest('.md-qx')) return;
            event.preventDefault(); // 拖动时别选中文字
            const scroller = event.currentTarget;
            const from = Number(rowEl.dataset.qi);
            const manualEls = [...scroller.querySelectorAll('.md-man')];
            state.queueDrag = { from, to: from, startY: event.clientY, startScroll: scroller.scrollTop, y: event.clientY, active: false, rowEl, manualEls, scroller, raf: 0, moved: false };
            const move = (e) => {
                const d = state.queueDrag;
                if (!d) return;
                d.y = e.clientY;
                if (!d.active && Math.abs(e.clientY - d.startY) < 4) return;
                if (!d.active) {
                    d.active = true;
                    d.moved = true;
                    rowEl.classList.add('md-qdrag');
                    scroller.classList.add('md-qdragging');
                    const loop = () => {
                        const r = scroller.getBoundingClientRect();
                        if (d.y < r.top + 32) scroller.scrollTop -= 6;
                        else if (d.y > r.bottom - 32) scroller.scrollTop += 6;
                        layoutDrag();
                        d.raf = requestAnimationFrame(loop);
                    };
                    d.raf = requestAnimationFrame(loop);
                }
                layoutDrag();
            };
            const layoutDrag = () => {
                const d = state.queueDrag;
                if (!d?.active) return;
                const dy = (d.y - d.startY) + (scroller.scrollTop - d.startScroll);
                const n = d.manualEls.length;
                d.to = Math.max(0, Math.min(n - 1, d.from + Math.round(dy / QUEUE_ROW_H)));
                d.rowEl.style.transform = `translateY(${dy}px)`;
                for (const node of d.manualEls) {
                    if (node === d.rowEl) continue;
                    const i = Number(node.dataset.qi);
                    let shift = 0;
                    if (d.from < d.to && i > d.from && i <= d.to) shift = -QUEUE_ROW_H;
                    if (d.from > d.to && i < d.from && i >= d.to) shift = QUEUE_ROW_H;
                    node.style.transform = shift ? `translateY(${shift}px)` : '';
                }
            };
            const up = () => {
                document.removeEventListener('pointermove', move, true);
                document.removeEventListener('pointerup', up, true);
                document.removeEventListener('pointercancel', up, true);
                const d = state.queueDrag;
                if (!d) return;
                cancelAnimationFrame(d.raf);
                const { active, from: f, to } = d;
                state.queueDrag = active ? { active: false, suppressClick: true } : null;
                scroller.classList.remove('md-qdragging');
                if (active) {
                    if (f !== to) app.queueMove?.(f, to);
                    rerenderQueue();
                    setTimeout(() => { if (state.queueDrag?.suppressClick) state.queueDrag = null; }, 0);
                }
            };
            document.addEventListener('pointermove', move, true);
            document.addEventListener('pointerup', up, true);
            document.addEventListener('pointercancel', up, true);
        }

        function onQueueAction(target) {
            if (state.queueDrag?.suppressClick) { state.queueDrag = null; return; }
            const act = target.dataset.qact;
            if (act === 'clear') { app.queueClear?.(); return; }
            const rowEl = target.closest('[data-k]');
            const row = rowEl && state.queueRows?.[Number(rowEl.dataset.k)];
            if (!row) return;
            const index = app.playlist.indexOf(row.track);
            if (act === 'remove' && row.type === 'manual') { app.queueRemove?.(row.i); return; }
            if (act === 'next') {
                if (app.queuePlayNext?.(row.track)) global.MusicToast?.show({ id: 'queue', kind: 'success', message: `下一首播放：${trackTitle(row.track)}` });
                return;
            }
            if (act === 'play' && index !== -1) {
                // 点手动队列里的歌：现在就放它，并把它从队列里拿掉。
                if (row.type === 'manual') app.queueRemove?.(row.i);
                app.loadTrack?.(index);
            }
        }

        function syncLyricHighlight(force = false) {
            const box = el.body.querySelector('.md-lyrl');
            if (!box) {
                if (state.lyricsSource !== app.currentLyrics && Array.isArray(app.currentLyrics) && app.currentLyrics.length) renderBody();
                return;
            }
            if (state.lyricsSource !== app.currentLyrics) { renderBody(); return; }
            const index = Number.isInteger(app.currentLyricIndex) ? app.currentLyricIndex : -1;
            if (!force && index === state.lyricIndex) return;
            box.querySelector('p.md-on')?.classList.remove('md-on');
            state.lyricIndex = index;
            const line = index >= 0 ? box.children[index] : null;
            if (!line) return;
            line.classList.add('md-on');
            const scroller = el.pnl;
            const target = line.offsetTop - scroller.clientHeight / 2 + line.offsetHeight / 2;
            if (typeof scroller.scrollTo === 'function') {
                scroller.scrollTo({ top: Math.max(0, target), behavior: force || reducedMotion?.matches ? 'auto' : 'smooth' });
            } else scroller.scrollTop = Math.max(0, target);
        }

        const renderTabs = () => {
            el.tabs.innerHTML = '<i class="md-mk"></i>' + TABS.map((tab, index) => (
                `<button type="button" role="tab" aria-selected="${tab === state.tab}" class="${tab === state.tab ? 'md-on' : ''}" data-i="${index}"><span>${tab}</span></button>`
            )).join('');
            placeMarks(el.pnl);
        };
        listen(el.tabs, 'click', (event) => {
            const button = event.target.closest('button[data-i]');
            if (!button) return;
            state.tab = TABS[Number(button.dataset.i)] || '控制';
            closePop();
            el.pnl.scrollTop = 0;
            renderTabs();
            renderBody();
        });

        listen(el.body, 'click', (event) => {
            const target = event.target.closest('[data-qact], [data-act], [data-q], .md-lyrl p, .md-seg button');
            if (!target) return;
            const motionSeg = target.closest('.md-seg[data-act="motion"]');
            if (motionSeg && target.matches('button[data-i]')) {
                const pref = global.MusicMotion?.PREFERENCES?.[Number(target.dataset.i)];
                if (pref) global.MusicMotion.set(pref.value);
                renderBody();
                return;
            }
            const seg = target.closest('.md-seg[data-act="theme"]');
            if (seg && target.matches('button[data-i]')) {
                const light = target.dataset.i === '0';
                app.applyTheme?.(light ? 'light' : 'dark');
                app.stageHost?.updateTheme?.();
                renderBody();
                return;
            }
            if (target.matches('.md-lyrl p')) {
                const time = Number(target.dataset.time);
                if (Number.isFinite(time)) { app.seekTo?.(Math.max(0, time)); kickProgress(); }
                return;
            }
            if (target.dataset.qact !== undefined) { onQueueAction(target); return; }
            const act = target.dataset.act;
            if (act === 'mode') { cycleMode(); }
            else if (act === 'stage') { toggleStage(); }
            else if (act === 'fx') { openSheet(); }
            else if (act === 'intro') { closePanel(); global.MusicIntro?.replay?.(); }
            else if (act === 'shuffle') { app.setPlayMode?.(playMode() === 'shuffle' ? 'repeat' : 'shuffle'); }
            else if (act === 'mute') {
                toggleMute();
            } else if (act === 'scene-step') {
                const modes = stageModes();
                const cur = modes.indexOf(currentStageMode());
                const next = modes[(cur + Number(target.dataset.d) + modes.length) % modes.length];
                if (next) app.stageHost?.setMode?.(next.id);
                closePop();
                renderBody();
            } else if (act === 'scene-pick') {
                if (state.popOpen) closePop(); else openPop(target);
                target.classList.toggle('md-open', state.popOpen);
                target.setAttribute('aria-expanded', String(state.popOpen));
            }
        });

        // 音量滑块：按下即跳到指针位置，拖动跟手，键盘左右 5%。
        listen(el.body, 'pointerdown', (event) => {
            const slider = event.target.closest('.md-sld');
            if (!slider || event.button !== 0) return;
            event.preventDefault();
            slider.setPointerCapture?.(event.pointerId);
            slider.classList.add('md-held');
            const apply = (clientX) => {
                const rect = slider.getBoundingClientRect();
                setVolume((clientX - rect.left - 8) / Math.max(1, rect.width - 16));
            };
            apply(event.clientX);
            const move = (ev) => apply(ev.clientX);
            const up = () => {
                slider.classList.remove('md-held');
                slider.removeEventListener('pointermove', move);
                slider.removeEventListener('pointerup', up);
                slider.removeEventListener('pointercancel', up);
            };
            slider.addEventListener('pointermove', move);
            slider.addEventListener('pointerup', up);
            slider.addEventListener('pointercancel', up);
        });
        listen(el.body, 'keydown', (event) => {
            if (!event.target.matches('.md-sld')) return;
            const delta = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -0.05
                : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 0.05 : 0;
            if (!delta) return;
            event.preventDefault();
            setVolume(readVolume() + delta);
        });

        function openPanel(tab) {
            if (tab) state.tab = tab;
            if (!state.panelOpen) {
                state.panelOpen = true;
                el.pnl.classList.add('md-open');
                el.pnl.setAttribute('aria-hidden', 'false');
                el.hdl.classList.add('md-open');
                el.handle.setAttribute('aria-expanded', 'true');
                el.handle.setAttribute('aria-label', '关闭面板');
            }
            renderTabs();
            renderBody();
        }
        function closePanel() {
            if (!state.panelOpen) return;
            state.panelOpen = false;
            closePop();
            el.pnl.classList.remove('md-open');
            el.pnl.setAttribute('aria-hidden', 'true');
            el.hdl.classList.remove('md-open');
            el.handle.setAttribute('aria-expanded', 'false');
            el.handle.setAttribute('aria-label', '打开面板');
        }
        function togglePanel() { if (state.panelOpen) closePanel(); else openPanel(); }
        listen(el.handle, 'click', togglePanel);

        // 舞台选择弹层：三列缩略格。
        function openPop(anchor) {
            const modes = stageModes();
            const current = currentStageMode();
            el.popGrid.innerHTML = modes.map((mode) => (
                `<button class="md-op${mode === current ? ' md-on' : ''}" type="button" role="option" aria-selected="${mode === current}" data-mode="${mode.id}" title="${escapeHtml(mode.description || '')}">`
                + `<span class="md-th">${icon('clapperboard', 16)}</span>${escapeHtml(mode.label)}</button>`
            )).join('');
            const panelRect = el.pnl.getBoundingClientRect();
            const anchorRect = anchor.getBoundingClientRect();
            el.pop.style.left = `${Math.max(8, panelRect.left + 8)}px`;
            el.pop.style.top = `${Math.max(8, Math.min(global.innerHeight - 330, anchorRect.bottom + 4))}px`;
            el.pop.classList.add('md-open');
            state.popOpen = true;
        }
        function closePop() {
            if (!state.popOpen) return;
            state.popOpen = false;
            el.pop.classList.remove('md-open');
        }
        listen(el.popGrid, 'click', (event) => {
            const button = event.target.closest('[data-mode]');
            if (!button) return;
            app.stageHost?.setMode?.(button.dataset.mode);
            closePop();
            renderBody();
        });
        listen(el.popMore, 'click', () => {
            closePop();
            closePanel();
            if (!stageActive()) app.stageHost?.enter?.();
            document.querySelector('.music-stage-settings-toggle')?.click();
        });

        // 完整音效设置：把原来的设置卡片整块搬进来，关掉时放回原处（事件和引用都不变）。
        const dspCard = document.querySelector('.settings-container');
        const dspHome = dspCard ? { parent: dspCard.parentNode, next: dspCard.nextSibling } : null;
        function openSheet() {
            if (!dspCard || state.sheetOpen) return;
            closePop();
            state.sheetOpen = true;
            el.sheetBody.appendChild(dspCard);
            el.sheet.classList.add('md-open');
            el.sheet.setAttribute('aria-hidden', 'false');
            document.body.classList.add('music-dock-sheet-open');
        }
        function closeSheet() {
            if (!state.sheetOpen) return;
            state.sheetOpen = false;
            el.sheet.classList.remove('md-open');
            el.sheet.setAttribute('aria-hidden', 'true');
            document.body.classList.remove('music-dock-sheet-open');
            if (dspHome?.parent) dspHome.parent.insertBefore(dspCard, dspHome.next && dspHome.next.parentNode === dspHome.parent ? dspHome.next : null);
            if (state.panelOpen && state.tab === '音质') renderBody();
        }
        listen(el.sheetClose, 'click', closeSheet);

        listen(document, 'pointerdown', (event) => {
            const t = event.target;
            if (t.closest?.('.md-cmd')) return;
            if (state.popOpen && !el.pop.contains(t) && !t.closest?.('[data-act="scene-pick"]')) closePop();
            if (state.sheetOpen && !el.sheet.contains(t) && !t.closest?.('[data-act="fx"], [data-q="fx"]')
                && !t.closest?.('.custom-select-dropdown, select, option')) closeSheet();
            if (state.panelOpen && !el.pnl.contains(t) && !el.hdl.contains(t) && !el.pop.contains(t)
                && !el.sheet.contains(t) && !el.quick.contains(t) && !t.closest?.('.md-cap')) closePanel();
        }, true);
        listen(document, 'keydown', (event) => {
            if (event.key !== 'Escape' || event.target?.closest?.('.md-cmd') || palette?.isOpen) return;
            if (state.popOpen) { closePop(); renderBody(); event.stopPropagation(); }
            else if (state.sheetOpen) { closeSheet(); event.stopPropagation(); }
            else if (state.panelOpen) { closePanel(); el.handle.focus(); event.stopPropagation(); }
        }, true);

        // ───────── 状态订阅 ─────────
        const observers = [];
        const observe = (target, options, fn) => {
            if (!target) return;
            const observer = new MutationObserver(fn);
            observer.observe(target, options);
            observers.push(observer);
        };
        let lastPlaying = null;
        let lastStage = null;
        let lastTheme = null;
        observe(document.body, { attributes: true, attributeFilter: ['class'] }, () => {
            const playing = app.isPlaying === true;
            if (playing !== lastPlaying) { lastPlaying = playing; renderPlay(); kickProgress(); }
            const inStage = stageActive();
            if (inStage !== lastStage) { lastStage = inStage; renderStage(); }
            const light = document.body.classList.contains('light-theme');
            if (light !== lastTheme) { lastTheme = light; if (state.panelOpen && state.tab === '控制') renderBody(); }
        });
        // 标题、歌手、封面都由播放器写到旧卡片上；跟着它们变。
        observe(app.trackTitle, { childList: true, characterData: true, subtree: true }, renderTrack);
        observe(app.trackArtist, { childList: true, characterData: true, subtree: true }, renderTrack);
        observe(app.albumArt, { attributes: true, attributeFilter: ['style'] }, renderTrack);
        // 暂停时的跳转和引擎校准只改旧进度文字；这里跟着刷新一次。
        observe(app.currentTimeEl, { childList: true, characterData: true, subtree: true }, kickProgress);
        observe(app.durationEl, { childList: true, characterData: true, subtree: true }, kickProgress);
        observe(app.modeBtn, { attributes: true, attributeFilter: ['title'] }, () => {
            renderMode();
            if (state.panelOpen && (state.tab === '控制' || state.tab === '播放列表')) renderBody();
        });
        if (app.volumeSlider) listen(app.volumeSlider, 'input', renderVolume);
        // 列表增删、筛选、换歌后，打开着的播放列表页跟着重画。
        observe(app.playlistEl, { childList: true }, () => {
            if (!state.panelOpen || state.tab !== '播放列表') return;
            rerenderQueue();
        });
        // 手动队列增删、排序后跟着重画。
        listen(document, 'music-queue-change', rerenderQueue);
        listen(global, 'music-motion-change', () => { if (state.panelOpen && state.tab === '控制') renderBody(); });
        observe(app.playlistEl, { subtree: true, attributes: true, attributeFilter: ['class'] }, () => {
            if (!state.panelOpen || state.tab !== '播放列表') return;
            const scroller = el.body.querySelector('.md-ql');
            if (scroller) renderQueueWindow(scroller, true);
        });
        listen(document, 'visibilitychange', () => { if (!document.hidden) kickProgress(); });
        listen(global, 'resize', () => {
            animateCapsule(true);
            if (state.panelOpen) placeMarks(el.pnl);
        });

        // ───────── 全窗口键位 ─────────
        // 在 document 的捕获阶段统一处理，处理了就 preventDefault，档案页等后面的监听看到就不再重复处理。
        // 焦点在输入框里时单键一律不管（打字优先）；有弹窗开着时也不管。
        // 档案页显示时方向键留给它选歌，快进快退只在舞台和经典视图里用 ←/→。
        const KEYMAP = [
            ['空格', '播放 / 暂停（按住不会连续切换）'],
            ['← / →', '快退 / 快进 5 秒（档案页里方向键用来选歌）'],
            ['Shift + ← / →', '上一首 / 下一首'],
            ['Ctrl + ↑ / ↓', '音量 +5% / −5%'],
            ['M', '静音 / 恢复'],
            ['Ctrl + K', '命令面板：搜歌、歌单和操作'],
            ['Ctrl + L', '档案页里定位到正在播放的那首'],
            ['L', '档案页里打开 / 收起目录'],
            ['/', '档案页里检索'],
            ['?', '打开这张快捷键表'],
            ['Esc', '关闭面板、命令面板或这张表']
        ];
        const typingTarget = (t) => Boolean(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')));
        const modalOpen = () => [app.playlistDialog, app.playlistEditModal, app.lyricsFetchModal].some((m) => m?.classList?.contains('visible'))
            || document.body.classList.contains('music-intro-playing');
        const archiveShown = () => !stageActive() && !document.body.classList.contains('music-stage-active')
            && app.archiveView?.mode === 'archive';
        let helpEl = null;
        const helpOpen = () => Boolean(helpEl && !helpEl.hidden);
        const closeHelp = () => {
            if (!helpOpen()) return;
            helpEl.classList.remove('md-open');
            helpEl.hidden = true;
        };
        const openHelp = () => {
            if (!helpEl) {
                helpEl = document.createElement('div');
                helpEl.className = 'md-keys';
                helpEl.innerHTML = `<div class="md-keys-scrim" data-keys="close"></div>`
                    + `<section class="md-keys-box" role="dialog" aria-modal="true" aria-label="快捷键" tabindex="-1">`
                    + `<header><b>快捷键</b><button class="md-ib md-m" type="button" data-keys="close" aria-label="关闭">${icon('x', 16)}</button></header>`
                    + `<dl>${KEYMAP.map(([k, v]) => `<dt>${k.split(' ').map((part) => (/^[+/]$/.test(part) ? `<i>${part}</i>` : `<kbd>${escapeHtml(part)}</kbd>`)).join('')}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`
                    + `<footer>焦点在输入框里时，单个按键只用来打字。</footer></section>`;
                host.appendChild(helpEl);
                helpEl.addEventListener('click', (event) => { if (event.target.closest('[data-keys="close"]')) closeHelp(); });
            }
            closePop(); setQuick(false);
            helpEl.hidden = false;
            requestAnimationFrame(() => helpEl.classList.add('md-open'));
            helpEl.querySelector('.md-keys-box').focus({ preventScroll: true });
        };
        const seekBy = (delta) => {
            const d = duration();
            if (!(d > 0)) return;
            app.seekTo?.(Math.min(Math.max(0, d - 0.5), Math.max(0, currentTime() + delta)));
            kickProgress();
        };
        let spaceHeld = false;
        listen(document, 'keyup', (event) => { if (event.code === 'Space') spaceHeld = false; }, true);
        listen(global, 'blur', () => { spaceHeld = false; });
        listen(document, 'keydown', (event) => {
            if (event.defaultPrevented || state.destroyed) return;
            const t = event.target;
            if (t?.closest?.('.md-cmd')) return; // 命令面板自己处理
            if (helpOpen()) {
                if (event.key === 'Escape' || event.key === '?') { event.preventDefault(); event.stopPropagation(); closeHelp(); }
                return;
            }
            if (typingTarget(t) || modalOpen()) return;
            const key = event.key;
            const mod = event.ctrlKey || event.metaKey;
            const take = () => { event.preventDefault(); event.stopPropagation(); };

            if (event.code === 'Space' && !mod && !event.altKey) {
                // 焦点在按钮上时空格就是按那个按钮，不再额外切一次
                if (t?.closest?.('button, [role="button"], a[href], [role="slider"]')) return;
                take();
                if (event.repeat || spaceHeld) return; // 按住不连发
                spaceHeld = true;
                if (app.isPlaying) app.pauseTrack?.(); else app.playTrack?.();
                return;
            }
            if (event.altKey) return;
            if (mod && !event.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
                take();
                setVolume(Math.round((readVolume() + (key === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100);
                flashVolume();
                return;
            }
            if (mod) return;
            if (event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
                take();
                if (event.repeat) return;
                showPreview(null);
                slideTitle(key === 'ArrowLeft' ? -1 : 1);
                if (key === 'ArrowLeft') app.prevTrack?.(); else app.nextTrack?.();
                return;
            }
            if (!event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
                if (archiveShown()) return; // 档案页里留给选歌
                if (t?.closest?.('[role="slider"], [role="tablist"], .md-seg, .md-ql')) return;
                take();
                seekBy(key === 'ArrowLeft' ? -5 : 5);
                return;
            }
            if ((key === 'm' || key === 'M') && !event.repeat) {
                take();
                toggleMute();
                flashVolume();
                return;
            }
            if (key === '?') { take(); openHelp(); }
        }, true);

        // ───────── 命令面板 ─────────
        const palette = typeof global.createMusicDockPalette === 'function'
            ? global.createMusicDockPalette(app, {
                host, icon, escapeHtml, trackTitle, trackArtist,
                openPanel, openSheet, toggleStage, cycleMode, setVolume, readVolume, toggleMute, openHelp,
                closeOthers: () => { closePop(); setQuick(false); }
            })
            : null;

        // ───────── 提示层：播放失败、扫描进度 ─────────
        // 原来这些只写在经典视图的码率字段里，档案页和舞台里看不到；现在同时走全窗口提示层。
        const toast = global.MusicToast;
        if (toast) {
            const baseNotice = app.showPlaybackNotice;
            if (typeof baseNotice === 'function') {
                app.showPlaybackNotice = (message) => {
                    baseNotice(message);
                    if (state.destroyed) return;
                    const text = String(message || '');
                    const failedIndex = app.currentTrackIndex;
                    const list = app.currentFilteredTracks || app.playlist || [];
                    const canSkip = /^加载(失败|超时)/.test(text) && list.length > 1;
                    state.noticeTrackKey = state.trackKey;
                    toast.show({
                        id: 'playback',
                        kind: 'error',
                        message: text,
                        action: canSkip ? {
                            label: '跳过',
                            countdown: 5,
                            // 倒计时期间用户自己换了歌或又放起来了，就别再跳。
                            run: () => { if (app.currentTrackIndex === failedIndex && !app.isPlaying && !app.playIntent) app.nextTrack(); }
                        } : null
                    });
                };
                cleanups.push(() => { if (app.showPlaybackNotice !== baseNotice) app.showPlaybackNotice = baseNotice; });
            }
            const bridge = app.api;
            if (bridge?.onMusicScanProgress) {
                bridge.onMusicScanStart?.(() => {
                    if (!state.destroyed) toast.show({ id: 'scan', kind: 'progress', message: '正在扫描音乐文件夹…', delay: 300 });
                });
                bridge.onMusicScanProgress((data) => {
                    if (state.destroyed) return;
                    const total = Number(data?.total) || 0;
                    const current = Number(data?.current) || 0;
                    toast.show({ id: 'scan', kind: 'progress', message: total ? `正在扫描 ${current} / ${total}` : '正在扫描音乐文件夹…', progress: total ? current / total : undefined });
                });
                bridge.onMusicScanComplete?.((data) => {
                    if (state.destroyed) return;
                    const count = Array.isArray(data) ? data.length : (Array.isArray(data?.tracks) ? data.tracks.length : 0);
                    toast.dismiss('scan');
                    toast.show({ kind: 'success', message: count ? `扫描完成，这个文件夹里有 ${count} 首` : '扫描完成，没有找到音乐文件' });
                });
            }
        }

        // ───────── 首次渲染 ─────────
        renderTrack();
        renderPlay();
        renderMode();
        renderStage();
        renderQuick();
        renderVolume();
        state.expanded = shouldExpand();
        el.cap.classList.toggle('md-ex', state.expanded);
        animateCapsule(true);
        kickProgress();
        lastPlaying = app.isPlaying === true;
        lastStage = stageActive();
        lastTheme = document.body.classList.contains('light-theme');

        const api = {
            openPanel,
            closePanel,
            openSheet,
            closeSheet,
            openPalette: (text) => palette?.open(text),
            openShortcuts: () => openHelp(),
            closePalette: () => palette?.close(),
            get panelOpen() { return state.panelOpen; },
            get expanded() { return state.expanded; },
            destroy() {
                if (state.destroyed) return;
                state.destroyed = true;
                closeSheet();
                palette?.destroy();
                helpEl?.remove();
                global.MusicToast?.clear();
                for (const id of timers) clearTimeout(id);
                timers.clear();
                if (springFrame) cancelAnimationFrame(springFrame);
                observers.forEach((observer) => observer.disconnect());
                cleanups.splice(0).forEach((fn) => fn());
                document.body.classList.remove('music-dock-on', 'music-dock-sheet-open');
                document.body.style.removeProperty('--music-dock-safe-bottom');
                host.innerHTML = '';
            }
        };
        app.musicDock = api;
        global.addEventListener('beforeunload', api.destroy, { once: true });
        return api;
    }

    global.initMusicDock = initMusicDock;
})(window);
