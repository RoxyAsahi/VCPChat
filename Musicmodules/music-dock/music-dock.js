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
    const HOVER_EXPAND_MS = 20;
    const HOVER_COLLAPSE_MS = 100;
    const QUICK_DWELL_MS = 250;
    const PROGRESS_TICK_MS = 250;
    const PROGRESS_INSET = 0.06;
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
<div class="md-dock"><div class="md-dock-in">
  <div class="md-quick"><div class="md-quick-in"><div class="md-quick-g" role="toolbar" aria-label="快捷操作"></div></div></div>
  <div class="md-cap" title="点一下进入歌词舞台">
    <div class="md-trk" role="slider" aria-label="播放进度" tabindex="0"><div class="md-fill"></div><div class="md-kn-rail"><div class="md-kn"></div></div></div>
    <button class="md-pb" type="button" data-md="play" aria-label="播放"></button>
    <div class="md-ttl"><div class="md-tnav">
      <div class="md-zone md-l"><button class="md-arw" type="button" data-md="prev" aria-label="上一首">${icon('chevron-left', 15, { strokeWidth: 2.4 })}</button></div>
      <div class="md-zone md-r"><button class="md-arw" type="button" data-md="next" aria-label="下一首">${icon('chevron-right', 15, { strokeWidth: 2.4 })}</button></div>
      <div class="md-txt"><div class="md-cur"><span data-md="title"></span></div><div class="md-pv"><span data-md="preview"></span></div></div>
      <div class="md-sub"><span data-md="artist"></span><span class="md-tms"><span class="md-tm" data-md="t1"></span> / <span class="md-tm" data-md="t2"></span></span></div>
    </div></div>
    <div class="md-nx"><button class="md-nxb" type="button" data-md="nx1"></button><button class="md-nxb md-nx2" type="button" data-md="nx2"></button></div>
    <div class="md-slots">
      <button class="md-slot" type="button" data-md="mode"></button>
      <button class="md-slot" type="button" data-md="stage" aria-label="歌词舞台">${icon('captions', 17)}</button>
      <button class="md-slot md-vslot" type="button" data-md="vol" aria-label="静音"></button>
    </div>
  </div>
  <div class="md-vrail" role="slider" tabindex="-1" aria-label="音量" aria-valuemin="0" aria-valuemax="100" aria-hidden="true"><i class="md-vfill"></i></div>
</div></div>
<div class="md-hdl"><button type="button" data-md="handle" aria-label="打开面板" aria-expanded="false" aria-controls="music-dock-panel" title="设置">
  <span class="md-sw md-g">${icon('settings-2', 20)}</span><span class="md-sw md-x">${icon('x', 20)}</span>
</button></div>
<section class="md-pnl" id="music-dock-panel" role="dialog" aria-label="播放面板" aria-hidden="true">
  <div class="md-hd">
    <div class="md-hd-cv"></div>
    <div class="md-hd-tx"><b data-md="p-title"></b><span data-md="p-artist"></span></div>
    <button class="md-ib md-m md-hd-act" type="button" data-md="share" aria-label="分享当前音频" title="分享当前音频">${icon('share-2', 17)}</button>
  </div>
  <div class="md-body"><div class="md-hr"></div><div class="md-tab" data-md="body"></div></div>
  <div class="md-sp" data-md="stagepage" hidden>
    <div class="md-sp-hd"><button class="md-ib md-m" type="button" data-md="sp-back" aria-label="返回控制页" title="返回">${icon('chevron-left', 18)}</button><b>舞台调制</b><span class="md-sp-cur" data-md="sp-cur"></span></div>
    <div class="md-sp-sc" data-md="sp-scroll">
      <div class="md-sp-sec"><div class="md-sp-k">当前舞台</div><div class="md-pop-g" role="listbox" aria-label="选择舞台" data-md="sp-modes"></div></div>
    </div>
  </div>
  <div class="md-sp md-fxp" data-md="fxpage" hidden>
    <div class="md-sp-hd"><button class="md-ib md-m" type="button" data-md="fx-back" aria-label="返回" title="返回">${icon('chevron-left', 18)}</button><b>音效设置</b><span class="md-sp-cur" data-md="fx-cur"></span></div>
    <div class="md-fx-sc" data-md="fx-scroll"><div class="md-fx-h md-fx-out"><span class="md-fx-n">01</span><b>输出</b></div></div>
  </div>
  <div class="md-dockrow"><div class="md-seg md-seg-l" data-md="tabs" role="tablist"></div></div>
</section>
<div class="md-drbg" aria-hidden="true"></div>
`;

        const $ = (sel) => host.querySelector(sel);
        const $$ = (sel) => Array.from(host.querySelectorAll(sel));
        const el = {
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
            artist: $('[data-md="artist"]'),
            nx: [$('[data-md="nx1"]'), $('[data-md="nx2"]')],
            vrail: $('.md-vrail'),
            vfill: $('.md-vfill'),
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
            sp: $('[data-md="stagepage"]'),
            spBack: $('[data-md="sp-back"]'),
            spCur: $('[data-md="sp-cur"]'),
            spScroll: $('[data-md="sp-scroll"]'),
            spModes: $('[data-md="sp-modes"]'),
            fx: $('[data-md="fxpage"]'),
            fxBack: $('[data-md="fx-back"]'),
            fxCur: $('[data-md="fx-cur"]'),
            fxScroll: $('[data-md="fx-scroll"]')
        };

        const state = {
            hover: false,
            expanded: false,
            panelOpen: false,
            tab: '控制',
            subOpen: false,
            sheetOpen: false,
            dragging: null,
            lastTimeText: '',
            lastDurText: '',
            lyricIndex: -2,
            lyricsSource: null,
            queueSource: null,
            queueLength: -1,
            trackKey: '',
            volOpen: false,
            volDrag: false,
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

        // ───────── 流体层 ─────────
        // 播放条是一块会变状态的物质：播放过的部分凝固成实心玻璃，没播的部分是雾，凝固的边界就是进度；
        // 暂停时整条化成雾，鼠标移上来（关注）又凝固。设置小环停在顶边时播放条凹进去让它，
        // 打开面板时小环飞到右下角，凹口愈合。音量从播放条里像水滴一样分裂上去。
        // 舞台的「性能档位」选节能时不跑流体层，播放条退成不透明的实色。
        // 播放条玻璃里透出的颜色跟着主题走：平时取 VCPChat 当前主题的强调色（--highlight-text），
        // 舞台换了自定义主题就取舞台的；有自己固定色调的舞台（镜台黄昏、隧图深空、町景霓虹）用各自的颜色。
        // 强调色太灰（单色主题）时退回默认的暖橙。深浅两套各自调亮度，保证上面的字看得清。
        const SCENE_GLOW = {
            light: {
                diorama: ['#ef7b3f', '#f6cdb0', '#ffffff'],
                tunnel: ['#4fa597', '#cfe9e2', '#ffffff'],
                kowloon: ['#e0629f', '#bfe2ea', '#ffffff']
            },
            dark: {
                diorama: ['#e06a30', '#6e4733', '#45403b'],
                tunnel: ['#46a593', '#3c5853', '#3d4441'],
                kowloon: ['#d24a8d', '#2f5a6a', '#3b3e46']
            }
        };
        const FALLBACK_ACCENT = [217, 119, 63];
        const colorProbe = document.createElement('i');
        colorProbe.hidden = true;
        const readRgb = (value) => {
            const text = String(value || '').trim();
            if (!text) return null;
            colorProbe.style.color = '';
            colorProbe.style.color = text;
            if (!colorProbe.style.color) return null;
            if (!colorProbe.isConnected) host.appendChild(colorProbe);
            const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(getComputedStyle(colorProbe).color || '');
            return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
        };
        const rgbToHsl = ([r, g, b]) => {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const l = (max + min) / 2;
            if (max === min) return [0, 0, l];
            const d = max - min;
            const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            return [h / 6, s, l];
        };
        const hslToRgb = ([h, s, l]) => {
            if (!s) return [l * 255, l * 255, l * 255];
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            const f = (t) => {
                t = (t + 1) % 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
        };
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
        const hex = (rgb) => `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
        const glowFromAccent = (accent, light) => {
            let [h, s, l] = rgbToHsl(accent || FALLBACK_ACCENT);
            if (s < 0.12) [h, s, l] = rgbToHsl(FALLBACK_ACCENT);
            if (light) {
                const a = hslToRgb([h, clamp(s, 0.5, 0.85), clamp(l, 0.6, 0.68)]);
                return [hex(a), hex(mix(a, [255, 255, 255], 0.7)), '#ffffff'];
            }
            const a = hslToRgb([h, clamp(s, 0.45, 0.8), clamp(l, 0.5, 0.58)]);
            return [hex(a), hex(mix(a, [70, 64, 59], 0.68)), hex(mix(a, [64, 63, 62], 0.92))];
        };
        const themeAccent = () => {
            const stageRoot = document.getElementById('music-stage');
            if (stageActive() && stageRoot?.classList.contains('stage-theme-custom')) {
                const custom = readRgb(getComputedStyle(stageRoot).getPropertyValue('--highlight-text'));
                if (custom) return custom;
            }
            return readRgb(getComputedStyle(document.documentElement).getPropertyValue('--highlight-text'));
        };
        const currentGlow = () => {
            const light = document.body.classList.contains('light-theme');
            const mode = stageActive() ? app.stageHost?.modeId : null;
            const custom = stageActive() && document.getElementById('music-stage')?.classList.contains('stage-theme-custom');
            return (!custom && SCENE_GLOW[light ? 'light' : 'dark'][mode]) || glowFromAccent(themeAccent(), light);
        };
        const lowQuality = () => global.MusicStageConfig?.get?.()?.quality === 'energy-saving';
        let fluid = null;
        const syncFluid = () => {
            const want = typeof global.createMusicDockFluid === 'function' && !lowQuality();
            if (want && !fluid) {
                fluid = global.createMusicDockFluid({
                    host,
                    bar: el.cap,
                    ring: el.hdl,
                    reduced: () => reducedMotion.matches
                });
            } else if (!want && fluid) {
                fluid.destroy();
                fluid = null;
                el.hdl.style.transform = '';
            }
            host.classList.toggle('md-fl-on', Boolean(fluid));
            host.classList.toggle('md-fl-low', !fluid);
            if (fluid) {
                fluid.layout();
                fluid.setRingDocked(!state.panelOpen);
                syncGlow();
                syncSolid();
                syncRing();
                renderProgress();
            }
        };
        // 节能档没有流体层：把同一套颜色混进实心播放条的进度底色和快捷胶囊的描边里。
        let lastGlowKey = '';
        const syncGlow = () => {
            const colors = currentGlow();
            const key = colors.join();
            const light = document.body.classList.contains('light-theme');
            const a = readRgb(colors[0]) || FALLBACK_ACCENT;
            host.style.setProperty('--md-fl-low-fill', hex(mix(a, light ? [247, 242, 238] : [43, 41, 39], light ? 0.62 : 0.55)));
            host.style.setProperty('--md-fl-tint', colors[0]);
            if (fluid && (key !== lastGlowKey || !fluid.glowSet)) { fluid.setGlow(colors); fluid.glowSet = true; }
            lastGlowKey = key;
        };
        // 实心 = 正在播放，或者正被关注（悬停、拖动）。
        const syncSolid = () => {
            const solid = app.isPlaying === true || state.hover || state.dragging !== null;
            host.classList.toggle('md-vapor', !solid);
            fluid?.setSolid(solid);
        };
        const animateCapsule = () => { fluid?.layout(); };

        const shouldExpand = () => state.hover
            || state.dragging !== null
            || (!app.isPlaying && !app.isTrackLoading && duration() > 0 && currentTime() > 0);
        // 小环的角色还在挑：存在 localStorage musicDockRingMode 里（fixed / playhead / hover / drop）。
        const RING_MODES = ['fixed', 'playhead', 'hover', 'drop'];
        const readRingMode = () => {
            try { const v = global.localStorage?.getItem('musicDockRingMode'); return RING_MODES.includes(v) ? v : 'fixed'; } catch (e) { return 'fixed'; }
        };
        let ringMode = readRingMode();
        const syncRing = () => {
            if (!fluid) return;
            if (fluid.ringMode !== ringMode) fluid.setRingMode(ringMode);
            fluid.setRingHover(state.hover || state.dragging !== null);
        };
        const syncExpanded = () => {
            syncSolid();
            syncRing();
            const next = shouldExpand();
            if (next === state.expanded) return;
            state.expanded = next;
            el.cap.classList.toggle('md-ex', next);
        };

        // ───────── 进度 ─────────
        const renderProgress = () => {
            const d = duration();
            const t = currentTime();
            const fraction = d > 0 ? Math.min(1, t / d) : 0;
            // 进度边界在 6%～94% 之间走，和流体层、拖动反算用同一个比例。
            const edge = PROGRESS_INSET + fraction * (1 - 2 * PROGRESS_INSET);
            for (const trk of el.tracks) {
                trk.firstElementChild.style.transform = `scaleX(${edge.toFixed(5)})`;
                trk.querySelector('.md-kn-rail').style.transform = `translateX(${(edge * 100).toFixed(3)}%)`;
                trk.setAttribute('aria-valuenow', String(Math.round(t)));
            }
            fluid?.setProgress(fraction);
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
            // 进度边界在播放条宽度的 6%～94% 之间走（两端是播放键和音量键），按同样的比例反算。
            const fraction = Math.min(1, Math.max(0, ((clientX - rect.left) / rect.width - PROGRESS_INSET) / (1 - 2 * PROGRESS_INSET)));
            return fraction * d;
        };
        for (const trk of el.tracks) {
            // 在播放条空白处按下：横向拖动超过 4px 才算拖进度，否则就是一次普通点击（交给播放条）。
            let pending = null;
            let swallowClick = false;
            listen(trk, 'pointerdown', (event) => {
                if (event.button !== 0) return;
                pending = { x: event.clientX, pointerId: event.pointerId };
                trk.setPointerCapture?.(event.pointerId);
            });
            listen(trk, 'pointermove', (event) => {
                if (!state.dragging && pending && Math.abs(event.clientX - pending.x) > 4) {
                    const time = seekFromPointer(trk, event.clientX);
                    if (time === null) { pending = null; return; }
                    state.dragging = { time, trk, pointerId: pending.pointerId };
                    trk.classList.add('md-held');
                    syncExpanded();
                }
                if (!state.dragging || state.dragging.trk !== trk) return;
                const time = seekFromPointer(trk, event.clientX);
                if (time === null) return;
                state.dragging.time = time;
                renderProgress();
            });
            const finish = (event, commit) => {
                pending = null;
                trk.releasePointerCapture?.(event.pointerId);
                if (!state.dragging || state.dragging.trk !== trk) return;
                const { time } = state.dragging;
                state.dragging = null;
                swallowClick = true;
                trk.classList.remove('md-held');
                if (commit) app.seekTo?.(time);
                kickProgress();
            };
            listen(trk, 'pointerup', (event) => finish(event, true));
            listen(trk, 'pointercancel', (event) => finish(event, false));
            listen(trk, 'click', (event) => {
                if (!swallowClick) return;
                swallowClick = false;
                event.stopPropagation();
            });
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
        const setQuick = (show) => {
            if (el.quick.classList.contains('md-show') === Boolean(show)) return;
            el.quick.classList.toggle('md-show', show);
            fluid?.setQuick(show, show ? el.quickGroup.getBoundingClientRect() : null);
        };
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
        listen(el.cap, 'pointermove', (event) => {
            if (event.pointerType === 'touch') return;
            fluid?.pointer(event.clientX);
        });
        listen(el.cap, 'pointerleave', () => fluid?.pointer(null));
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
            if (event.target.closest('button')) return;
            // 不在舞台时点胶囊进舞台；已经在舞台里就不做事（以前会弹出搜索面板，太容易误触）。
            if (!stageActive()) app.stageHost?.enter?.();
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
            )).join('');
        };
        listen(el.quickGroup, 'click', (event) => {
            const button = event.target.closest('[data-q]');
            if (!button) return;
            event.stopPropagation();
            quickItems().find((item) => item.id === button.dataset.q)?.run();
        });

        // ───────── 播放按钮、切歌、两个槽位 ─────────
        const renderPlay = () => {
            const playing = app.isPlaying === true;
            el.play.innerHTML = playing
                ? icon('pause', 20, { fill: 'currentColor' })
                : `<span class="md-play-nudge">${icon('play', 20, { fill: 'currentColor' })}</span>`;
            el.play.setAttribute('aria-label', playing ? '暂停' : '播放');
            el.play.dataset.on = playing ? '1' : '0';
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
        // 条上的「下一首、再下一首」：越往后越糊，悬停变清楚，点它就切过去。
        // 手动队列里的歌点了就从队列里拿掉；上下文里的直接跳到那一首。
        const upNext = () => {
            if (typeof app.getUpNext === 'function') {
                const up = app.getUpNext(2);
                return [...up.manual.map((track, i) => ({ track, manual: i })), ...up.context.map((track) => ({ track, manual: -1 }))].slice(0, 2);
            }
            const one = neighbour(1);
            return one ? [{ track: one, manual: -1 }] : [];
        };
        let nextRows = [];
        function renderNext() {
            nextRows = upNext();
            el.nx.forEach((button, i) => {
                const row = nextRows[i];
                button.hidden = !row;
                if (!row) return;
                const name = trackTitle(row.track);
                if (button.textContent !== name) button.textContent = name;
                button.setAttribute('aria-label', `切到 ${name}`);
                button.title = i === 0 ? `下一首：${name}` : `再下一首：${name}`;
            });
        }
        el.nx.forEach((button, i) => listen(button, 'click', (event) => {
            event.stopPropagation();
            const row = nextRows[i];
            if (!row) return;
            showPreview(null);
            if (i === 0) { app.nextTrack?.(); return; }
            const index = (app.playlist || []).indexOf(row.track);
            if (index < 0) return;
            if (row.manual >= 0) app.queueRemove?.(row.manual);
            app.loadTrack?.(index);
        }));
        listen(document, 'music-queue-change', () => renderNext());

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
            renderNext();
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
        // 悬停音量键一会儿（或者在上面滚轮）：音量像一滴水从播放条里分裂上去，里面是一根竖着的音量条，可以拖。
        let volOpenTimer = null;
        let volCloseTimer = null;
        const placeRail = () => {
            const slot = el.volSlot.getBoundingClientRect();
            const box = el.dockIn.getBoundingClientRect();
            const bar = el.cap.getBoundingClientRect();
            if (!slot.width) return;
            el.vrail.style.left = `${Math.round(slot.left + slot.width / 2 - box.left)}px`;
            el.vrail.style.bottom = `${Math.round(box.bottom - bar.top + 16)}px`;
        };
        const setVolumeOpen = (open) => {
            cancel(volOpenTimer); volOpenTimer = null;
            if (open) { cancel(volCloseTimer); volCloseTimer = null; }
            if (state.volOpen === open) return;
            state.volOpen = open;
            if (open) placeRail();
            host.classList.toggle('md-vopen', open);
            el.vrail.setAttribute('aria-hidden', String(!open));
            el.vrail.tabIndex = open ? 0 : -1;
            el.volSlot.setAttribute('aria-expanded', String(open));
            fluid?.setVolumeOpen(open);
        };
        const scheduleVolumeClose = () => {
            if (volCloseTimer || state.volDrag) return;
            volCloseTimer = later(() => { volCloseTimer = null; setVolumeOpen(false); }, 600);
        };
        listen(el.volSlot, 'pointerenter', (event) => {
            if (event.pointerType === 'touch') return;
            cancel(volCloseTimer); volCloseTimer = null;
            if (!state.volOpen && !volOpenTimer) volOpenTimer = later(() => setVolumeOpen(true), 280);
        });
        listen(el.volSlot, 'pointerleave', () => { cancel(volOpenTimer); volOpenTimer = null; if (state.volOpen) scheduleVolumeClose(); });
        listen(el.vrail, 'pointerenter', () => { cancel(volCloseTimer); volCloseTimer = null; });
        listen(el.vrail, 'pointerleave', () => scheduleVolumeClose());
        const volumeFromRail = (clientY) => {
            const rect = el.vrail.getBoundingClientRect();
            if (!(rect.height > 0)) return readVolume();
            return Math.round(Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height)) * 100) / 100;
        };
        listen(el.vrail, 'pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            el.vrail.setPointerCapture?.(event.pointerId);
            state.volDrag = true;
            setVolume(volumeFromRail(event.clientY));
            flashVolume();
        });
        listen(el.vrail, 'pointermove', (event) => {
            if (!state.volDrag) return;
            setVolume(volumeFromRail(event.clientY));
            flashVolume();
        });
        const endVolDrag = (event) => {
            if (!state.volDrag) return;
            state.volDrag = false;
            el.vrail.releasePointerCapture?.(event.pointerId);
            if (!el.vrail.matches(':hover') && !el.volSlot.matches(':hover')) scheduleVolumeClose();
        };
        listen(el.vrail, 'pointerup', endVolDrag);
        listen(el.vrail, 'pointercancel', endVolDrag);
        listen(el.vrail, 'keydown', (event) => {
            const delta = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 0.05 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -0.05 : 0;
            if (event.key === 'Escape') { setVolumeOpen(false); el.volSlot.focus(); event.stopPropagation(); return; }
            if (!delta) return;
            event.preventDefault();
            event.stopPropagation();
            setVolume(Math.round((readVolume() + delta) * 100) / 100);
            flashVolume();
        });
        listen(el.vrail, 'click', (event) => event.stopPropagation());
        listen(el.volSlot, 'wheel', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setVolumeOpen(true);
            const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 400 : 1;
            wheelAcc += (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
            const steps = Math.trunc(wheelAcc / 100); // 鼠标滚轮一格约 100px
            if (!steps) return;
            wheelAcc -= steps * 100;
            setVolume(Math.round((readVolume() - steps * 0.05) * 100) / 100);
            flashVolume();
        }, { passive: false });

        const renderStage = () => {
            const inStage = stageActive();
            el.stageSlot.classList.toggle('md-on', inStage);
            el.stageSlot.setAttribute('aria-pressed', String(inStage));
            el.stageSlot.title = inStage ? '离开歌词舞台' : '歌词舞台';
            el.cap.title = inStage ? '左右拖动调进度' : '点一下进入歌词舞台，左右拖动调进度';
            syncGlow();
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
            el.artist.textContent = artist;
            el.pTitle.textContent = title;
            el.pArtist.textContent = artist;
            el.cap.classList.toggle('md-notrack', !track);
            const coverCss = cover ? `url("${cover.replace(/"/g, '%22')}")` : '';
            el.pCover.innerHTML = cover ? '' : icon('music', 18);
            el.pCover.style.backgroundImage = coverCss;
            if (key !== state.trackKey) {
                // 换歌：上一首像一滴水从右边分裂出去蒸发掉（第一次渲染不算）。
                if (state.trackKey) { fluid?.split(); fluid?.dropRing(); }
                state.trackKey = key;
                renderNext();
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
            if (el.vfill) {
                el.vfill.style.transform = `scaleY(${v.toFixed(3)})`;
                el.vrail.setAttribute('aria-valuenow', String(Math.round(v * 100)));
                el.vrail.setAttribute('aria-valuetext', v > 0.001 ? `${Math.round(v * 100)}%` : '已静音');
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

        // 歌词页顶上一行：翻译开关、偏移 −0.5 / 当前值（点一下归零）/ +0.5。
        const lyricOffsetText = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} 秒`;
        function lyricsBar(lines) {
            const hasTranslation = lines.some((line) => line && line.translation);
            const on = app.lyricsTranslation !== false;
            const offset = Number(app.lyricOffset) || 0;
            const offsetOk = typeof app.shiftLyrics === 'function';
            return `<div class="md-qh md-lyrh"><b>歌词</b><span class="md-g"></span>`
                + (typeof app.setLyricsTranslation === 'function'
                    ? `<button class="md-chip${on ? ' md-lit' : ''}" type="button" data-act="lyr-tr" aria-pressed="${on}"${hasTranslation ? '' : ' disabled'} title="${hasTranslation ? (on ? '隐藏翻译' : '显示翻译') : '这首歌没有翻译'}">${icon('languages', 14)}<span>翻译</span></button>`
                    : '')
                + (offsetOk
                    ? `<span class="md-off" role="group" aria-label="歌词偏移">`
                        + `<button class="md-ib md-s" type="button" data-act="lyr-off" data-d="-0.5" aria-label="歌词提前 0.5 秒" title="歌词提前 0.5 秒">${icon('minus', 14)}</button>`
                        + `<button class="md-offv${offset ? ' md-lit' : ''}" type="button" data-act="lyr-off0" title="${offset ? '点一下归零' : '歌词偏移'}" aria-label="歌词偏移 ${lyricOffsetText(offset)}${offset ? '，点一下归零' : ''}">${lyricOffsetText(offset)}</button>`
                        + `<button class="md-ib md-s" type="button" data-act="lyr-off" data-d="0.5" aria-label="歌词推后 0.5 秒" title="歌词推后 0.5 秒">${icon('plus', 14)}</button>`
                        + '</span>'
                    : '')
                + '</div>';
        }

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
                        + `<button class="md-mid" type="button" data-act="scene-pick" title="舞台调制：选舞台、演出阵列和模式调制"><span class="md-in"><span class="md-pic">${icon('clapperboard', 16)}</span>`
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
                html += lyricsBar(lines);
                html += lines.length
                    ? `<div class="md-lyrl">${lines.map((line, index) => `<p data-i="${index}" data-time="${Number(line.time) || 0}">${escapeHtml(line.text || line.original || '') || '&nbsp;'}`
                        + `${line.translation ? `<small class="md-tr">${escapeHtml(line.translation)}</small>` : ''}</p>`).join('')}</div>`
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
            else if (act === 'lyr-tr') { app.setLyricsTranslation?.(app.lyricsTranslation === false); renderBody(); }
            else if (act === 'lyr-off') { app.shiftLyrics?.(Number(target.dataset.d) || 0); renderBody(); }
            else if (act === 'lyr-off0') { app.setLyricOffset?.(0); renderBody(); }
            else if (act === 'shuffle') { app.setPlayMode?.(playMode() === 'shuffle' ? 'repeat' : 'shuffle'); }
            else if (act === 'mute') {
                toggleMute();
            } else if (act === 'scene-step') {
                const modes = stageModes();
                const cur = modes.indexOf(currentStageMode());
                const next = modes[(cur + Number(target.dataset.d) + modes.length) % modes.length];
                if (next) app.stageHost?.setMode?.(next.id);
                syncGlow();
                closePop();
                renderBody();
            } else if (act === 'scene-pick') {
                openStagePage();
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

        // 右侧抽屉打开时播放条往左让位，右边缘停在抽屉内容左边 24px；放得下就不动。窄窗口抽屉铺满，不让位。
        const DRAWER_W = 400;
        const syncShift = () => {
            const vw = global.innerWidth || 0;
            const barW = el.cap.offsetWidth || 0;
            const room = vw - DRAWER_W - 24;
            const right = vw / 2 + barW / 2;
            const shift = state.panelOpen && vw >= COMPACT_BELOW && barW ? Math.min(0, room - right) : 0;
            host.style.setProperty('--md-shift', `${Math.round(shift)}px`);
            host.classList.toggle('md-shifted', shift < 0);
        };
        function openPanel(tab) {
            if (tab) { state.tab = tab; closePop(); }
            if (!state.panelOpen) {
                state.panelOpen = true;
                el.pnl.classList.add('md-open');
                el.pnl.setAttribute('aria-hidden', 'false');
                el.hdl.classList.add('md-open');
                el.handle.setAttribute('aria-expanded', 'true');
                el.handle.setAttribute('aria-label', '关闭面板');
                fluid?.setRingDocked(false);
                syncShift();
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
            fluid?.setRingDocked(true);
            syncShift();
        }
        function togglePanel() { if (state.panelOpen) closePanel(); else openPanel(); }
        listen(el.handle, 'click', togglePanel);

        // ───────── 舞台调制子页 ─────────
        // 控制页「舞台」那一行点进来：当前舞台（三列缩略格）+ 原来舞台控制舱里的演出阵列、模式调制、全局输出和「恢复出厂编排」。
        // 控制舱的内容节点整块搬进这里（appendChild，不重建），舞台宿主绑在上面的事件和引用都还在；
        // 原来的抽屉外壳和舞台右上角的入口按钮由 CSS 隐藏。
        const stageSettingsBody = document.querySelector('#music-stage .music-stage-settings-body');
        const stageSettingsFooter = document.querySelector('#music-stage .music-stage-settings-footer');
        const stageSettingsHome = [stageSettingsBody, stageSettingsFooter].filter(Boolean)
            .map((node) => ({ node, parent: node.parentNode, next: node.nextSibling }));
        for (const { node } of stageSettingsHome) el.spScroll.appendChild(node);
        if (stageSettingsHome.length) document.body.classList.add('music-dock-stage-settings');
        cleanups.push(() => {
            for (const { node, parent, next } of stageSettingsHome.slice().reverse()) {
                if (parent?.isConnected) parent.insertBefore(node, next?.parentNode === parent ? next : null);
            }
            document.body.classList.remove('music-dock-stage-settings');
        });
        const renderStageModes = () => {
            const modes = stageModes();
            const current = currentStageMode();
            el.spModes.innerHTML = modes.map((mode) => (
                `<button class="md-op${mode === current ? ' md-on' : ''}" type="button" role="option" aria-selected="${mode === current}" data-mode="${mode.id}" title="${escapeHtml(mode.description || '')}">`
                + `<span class="md-th">${icon('clapperboard', 16)}</span>${escapeHtml(mode.label)}</button>`
            )).join('');
            el.spCur.textContent = current ? current.label : '';
        };
        function openStagePage() {
            if (!state.panelOpen) openPanel('控制');
            renderStageModes();
            state.subOpen = true;
            el.sp.hidden = false;
            el.pnl.classList.add('md-sub');
            el.spScroll.scrollTop = 0;
            el.pnl.scrollTop = 0;
            el.spBack.focus({ preventScroll: true });
        }
        // 关掉面板里的子页（舞台调制或音效设置），回到页签内容。
        function closePop() {
            closeSheet();
            if (!state.subOpen) return;
            state.subOpen = false;
            el.sp.hidden = true;
            el.pnl.classList.remove('md-sub');
        }
        listen(el.spBack, 'click', () => {
            closePop();
            renderBody();
            el.body.querySelector('[data-act="scene-pick"]')?.focus({ preventScroll: true });
        });
        listen(el.spModes, 'click', (event) => {
            const button = event.target.closest('[data-mode]');
            if (!button) return;
            app.stageHost?.setMode?.(button.dataset.mode);
            syncGlow();
            renderStageModes();
        });

        // 音效设置子页：控制页「音频效果器」或音质页的按钮点进来。原来的音效卡片整块搬进来（appendChild，不重建），
        // 回到页签或关掉面板时放回原处，事件和引用都不变。
        const dspCard = document.querySelector('.settings-container');
        const dspHome = dspCard ? { parent: dspCard.parentNode, next: dspCard.nextSibling } : null;
        let fxFrom = null;
        const fxSummary = () => {
            const text = dspCard?.querySelector('[data-acoustic-summary]')?.textContent?.trim();
            el.fxCur.textContent = text || '';
        };
        function openSheet() {
            if (!dspCard || state.sheetOpen) return;
            closePop();
            if (!state.panelOpen) openPanel();
            fxFrom = state.tab;
            state.sheetOpen = true;
            el.fxScroll.appendChild(dspCard);
            fxSummary();
            el.fx.hidden = false;
            el.pnl.classList.add('md-sub');
            el.fxScroll.scrollTop = 0;
            el.pnl.scrollTop = 0;
            document.body.classList.add('music-dock-sheet-open');
            el.fxBack.focus({ preventScroll: true });
        }
        function closeSheet() {
            if (!state.sheetOpen) return;
            state.sheetOpen = false;
            el.fx.hidden = true;
            if (!state.subOpen) el.pnl.classList.remove('md-sub');
            document.body.classList.remove('music-dock-sheet-open');
            if (dspHome?.parent) dspHome.parent.insertBefore(dspCard, dspHome.next && dspHome.next.parentNode === dspHome.parent ? dspHome.next : null);
        }
        const backFromFx = () => {
            closeSheet();
            if (fxFrom && fxFrom !== state.tab) { state.tab = fxFrom; renderTabs(); }
            renderBody();
            el.body.querySelector('[data-act="fx"]')?.focus({ preventScroll: true });
        };
        listen(el.fxBack, 'click', backFromFx);
        if (dspCard) listen(dspCard, 'change', () => { if (state.sheetOpen) fxSummary(); });

        listen(document, 'pointerdown', (event) => {
            const t = event.target;
            if (t.closest?.('.md-cmd')) return;
            if (state.panelOpen && !el.pnl.contains(t) && !el.hdl.contains(t)
                && !t.closest?.('.custom-select-dropdown, select, option, [data-q="fx"]')
                && !el.quick.contains(t) && !t.closest?.('.md-cap')) closePanel();
        }, true);
        listen(document, 'keydown', (event) => {
            if (event.key !== 'Escape' || event.target?.closest?.('.md-cmd') || palette?.isOpen) return;
            if (state.subOpen) { closePop(); renderBody(); el.body.querySelector('[data-act="scene-pick"]')?.focus({ preventScroll: true }); event.stopPropagation(); }
            else if (state.sheetOpen) { backFromFx(); event.stopPropagation(); }
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
        // 主题文件换了（样式表重新加载、换了 href）或舞台换了自定义主题：颜色跟着换。
        let glowTimer = 0;
        const queueGlow = () => { clearTimeout(glowTimer); glowTimer = setTimeout(syncGlow, 60); timers.add(glowTimer); };
        observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] }, queueGlow);
        listen(document, 'load', (event) => { if (event.target?.tagName === 'LINK') queueGlow(); }, true);
        const stageRootEl = document.getElementById('music-stage');
        if (stageRootEl) observe(stageRootEl, { attributes: true, attributeFilter: ['class'] }, queueGlow);
        // 舞台顶部的模式切换（不经过底栏）也要换色：跟着选中按钮的 aria-pressed 走。
        observe(stageRootEl?.querySelector('.music-stage-mode-switcher'), { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] }, queueGlow);
        observe(document.body, { attributes: true, attributeFilter: ['class'] }, () => {
            const playing = app.isPlaying === true;
            if (playing !== lastPlaying) { lastPlaying = playing; renderPlay(); kickProgress(); }
            const inStage = stageActive();
            if (inStage !== lastStage) { lastStage = inStage; renderStage(); }
            const light = document.body.classList.contains('light-theme');
            if (light !== lastTheme) { lastTheme = light; syncGlow(); if (state.panelOpen && state.tab === '控制') renderBody(); }
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
            syncShift();
            animateCapsule();
            if (state.volOpen) placeRail();
            if (state.panelOpen) placeMarks(el.pnl);
        });

        // ───────── 全窗口键位 ─────────
        // 在 document 的捕获阶段统一处理，处理了就 preventDefault，档案页等后面的监听看到就不再重复处理。
        // 焦点在输入框里时单键一律不管（打字优先）；有弹窗开着时也不管。
        // 档案页显示时方向键留给它选歌，快进快退只在舞台和经典视图里用 ←/→；
        // 档案页里直接打字就是检索，所以 M 和 ? 这类单字符也留给它。
        const KEYMAP = [
            ['空格', '播放 / 暂停（按住不会连续切换）'],
            ['← / →', '快退 / 快进 5 秒（档案页里方向键用来选歌）'],
            ['Shift + ← / →', '上一首 / 下一首'],
            ['Ctrl + ↑ / ↓', '音量 +5% / −5%'],
            ['M', '静音 / 恢复（档案页里是打字检索）'],
            ['Ctrl + K', '搜索：歌、歌单，也能输入操作'],
            ['Ctrl + L', '档案页里定位当前播放'],
            ['/', '档案页里打开检索'],
            ['字母 / 数字', '档案页里直接打字就是检索目录'],
            ['?', '打开这张快捷键表（档案页里用 Ctrl + K 搜「快捷键」）'],
            ['Esc', '关闭面板、搜索或这张表']
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
            if (key.length === 1 && archiveShown()) return; // 档案页里单字符是打字检索
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
        syncFluid();
        if (global.MusicStageConfig?.subscribe) cleanups.push(global.MusicStageConfig.subscribe(() => { syncFluid(); syncGlow(); }));
        // 字体和布局稳定后再量一次（流体层要对齐按钮的真实位置）。
        requestAnimationFrame(() => { if (!state.destroyed) animateCapsule(); });
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
            openStageSettings: () => openStagePage(),
            get stageSettingsOpen() { return state.subOpen; },
            get soundSettingsOpen() { return state.sheetOpen; },
            get tab() { return state.tab; },
            get glowColors() { return currentGlow(); },
            get ringMode() { return ringMode; },
            setRingMode(mode) {
                ringMode = RING_MODES.includes(mode) ? mode : 'fixed';
                try { global.localStorage?.setItem('musicDockRingMode', ringMode); } catch (e) { /* 只是记住选择 */ }
                syncRing();
            },
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
                fluid?.destroy();
                fluid = null;
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
