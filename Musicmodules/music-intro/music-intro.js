// 音乐窗口过场动画：开场（首次/手动重放是完整版，平时是短版）和进出舞台的过场。
// 全部画在一层临时 SVG 上，放完就把节点整个移除；任意键或点击跳过；减少动态时只做一次淡出。
// 时间轴按秒写，离散的「剪辑点」按 25 帧对齐，和参考分镜的节奏一致。
(function (global) {
    'use strict';

    const SEEN_KEY = 'musicIntroFullSeen';
    const NS = 'http://www.w3.org/2000/svg';
    const W = 1000, H = 600, CX = 500, CY = 300;

    // ---------- 时间工具 ----------
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const progress = (t, a, b) => clamp01((t - a) / (b - a));
    const smooth = (p) => p * p * (3 - 2 * p);
    const easeOut = (p) => 1 - Math.pow(1 - p, 3);
    const frameOf = (t) => Math.floor(t * 25 + 1e-6);
    // 分段线性关键帧，段内再做 smoothstep，速度在关键帧处不突变太多即可。
    const keys = (list, t) => {
        if (t <= list[0][0]) return list[0][1];
        for (let i = 0; i < list.length - 1; i++) {
            const [t0, v0] = list[i], [t1, v1] = list[i + 1];
            if (t <= t1) return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
        }
        return list[list.length - 1][1];
    };
    // 打字：不是匀速，按字符给一点固定的快慢，像真人敲出来的。
    const typed = (text, t, a, b) => {
        if (t < a || !text) return '';
        const p = clamp01((t - a) / (b - a));
        const jitter = p < 1 ? 0.07 * Math.sin(p * 23.7) + 0.04 * Math.sin(p * 61.3) : 0;
        return text.slice(0, Math.max(1, Math.min(text.length, Math.ceil(clamp01(p + jitter) * text.length))));
    };
    const pad4 = (n) => String(Math.max(0, Math.min(9999, Math.round(n)))).padStart(4, '0');
    const arc = (r, start, sweep, x = CX, y = CY) => {
        if (r <= 0 || sweep <= 0) return '';
        const pt = (a) => `${(x + Math.cos(a) * r).toFixed(2)},${(y + Math.sin(a) * r).toFixed(2)}`;
        if (sweep >= Math.PI * 1.999) return `M${pt(start)}A${r},${r} 0 1 1 ${pt(start + Math.PI)}A${r},${r} 0 1 1 ${pt(start + Math.PI * 2)}`;
        return `M${pt(start)}A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${pt(start + sweep)}`;
    };
    const DEG = Math.PI / 180;

    const reducedMotion = () => global.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // ---------- 节点 ----------
    const el = (tag, attrs = {}, parent) => {
        const node = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        if (parent) parent.appendChild(node);
        return node;
    };

    const buildScene = (root) => {
        const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' }, root);
        const n = { svg };
        n.veil = el('rect', { class: 'mi-veil', x: -2000, y: -2000, width: W + 4000, height: H + 4000, opacity: 0 }, svg);

        // 开场第一段：访问请求
        n.access = el('g', { opacity: 0 }, svg);
        n.accessText = el('text', { x: 392, y: 306, 'font-size': 15, 'font-weight': 500, 'letter-spacing': '1.2' }, n.access);
        n.accessCursor = el('rect', { x: 392, y: 293, width: 2.5, height: 16, class: 'mi-block' }, n.access);

        // 第二段：我们自己的记号（细圆 + 五根音轨竖条）和身份核验
        n.mark = el('g', { opacity: 0, transform: 'translate(0 0)' }, svg);
        n.markRing = el('circle', { cx: 330, cy: 300, r: 46, class: 'mi-stroke', 'stroke-width': 2.2, pathLength: 1, 'stroke-dasharray': '0 1', transform: 'rotate(-90 330 300)' }, n.mark);
        n.markBars = [-2, -1, 0, 1, 2].map((i) => el('rect', { x: 330 + i * 11 - 2, y: 300, width: 4, height: 0, class: 'mi-block' }, n.mark));
        n.markWord = el('text', { x: 262, y: 382, 'font-size': 17, 'font-weight': 700, 'letter-spacing': '3' }, n.mark);
        n.brand = [
            el('text', { x: 262, y: 404, 'font-size': 9, 'letter-spacing': '2.2', class: 'mi-muted', opacity: 0 }, n.mark),
            el('text', { x: 262, y: 418, 'font-size': 9, 'letter-spacing': '2.2', class: 'mi-muted', opacity: 0 }, n.mark)
        ];
        n.brand[0].textContent = 'ACOUSTIC INFORMATION';
        n.brand[1].textContent = 'ARCHIVE SYSTEM';
        n.auth = el('g', { opacity: 0 }, svg);
        n.authLabel = el('text', { x: 410, y: 292, 'font-size': 9, 'letter-spacing': '2.4', class: 'mi-muted' }, n.auth);
        n.authLabel.textContent = 'AUTHORIZATION';
        n.authText = el('text', { x: 410, y: 314, 'font-size': 18, 'font-weight': 600, 'letter-spacing': '1' }, n.auth);
        n.authCursor = el('rect', { x: 410, y: 300, width: 2.5, height: 17, class: 'mi-block' }, n.auth);

        // 第三段：扫描圆环
        n.scan = el('g', { opacity: 0 }, svg);
        n.scanRings = el('g', {}, n.scan);
        n.outer = el('path', { class: 'mi-stroke', 'stroke-width': 1.6 }, n.scanRings);
        n.white = el('path', { class: 'mi-ring-soft', 'stroke-width': 3 }, n.scanRings);
        n.innerA = el('path', { class: 'mi-stroke', 'stroke-width': 1 }, n.scanRings);
        n.innerB = el('path', { class: 'mi-stroke', 'stroke-width': 1 }, n.scanRings);
        n.dots = [0, 1].map(() => el('circle', { r: 2.6, class: 'mi-block' }, n.scanRings));
        n.cap = el('circle', { r: 3, class: 'mi-block' }, n.scanRings);
        // 核心点放在字的上方，不压字。
        n.core = el('circle', { cx: CX, cy: CY - 30, r: 0, class: 'mi-block' }, n.scan);
        n.scanText = el('text', { x: CX, y: CY + 6, 'text-anchor': 'middle', 'font-size': 17, 'font-weight': 600 }, n.scan);
        n.scanSub = el('text', { x: CX, y: CY + 30, 'text-anchor': 'middle', 'font-size': 9, 'letter-spacing': '2.4', class: 'mi-muted' }, n.scan);

        // 第四段：欢迎面板
        n.welcome = el('g', { opacity: 0 }, svg);
        n.welcomeInner = el('g', {}, n.welcome);
        n.welcomeHead = el('text', { x: CX, y: 262, 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 700, 'letter-spacing': '1' }, n.welcomeInner);
        n.welcomeHead.textContent = 'WELCOME TO';
        n.welcomeBlock = el('rect', { x: CX - 128, y: 276, width: 256, height: 46, class: 'mi-block' }, n.welcomeInner);
        n.welcomeName = el('text', { x: CX, y: 310, 'text-anchor': 'middle', 'font-size': 30, 'font-weight': 700, 'letter-spacing': '2', class: 'mi-on-block' }, n.welcomeInner);
        n.welcomeName.textContent = 'VCP MUSIC';
        n.welcomeRule = el('rect', { x: CX - 128, y: 330, width: 0, height: 2, class: 'mi-block' }, n.welcomeInner);
        n.welcomeSub = el('text', { x: CX, y: 352, 'text-anchor': 'middle', 'font-size': 10, 'letter-spacing': '2.6', class: 'mi-muted' }, n.welcomeInner);
        n.welcomeMark = el('g', { transform: `translate(${CX} 392) scale(.38)` }, n.welcomeInner);
        el('circle', { cx: 0, cy: 0, r: 46, class: 'mi-stroke', 'stroke-width': 5 }, n.welcomeMark);
        [-2, -1, 0, 1, 2].forEach((i) => {
            const h = [24, 44, 62, 40, 20][i + 2];
            el('rect', { x: i * 11 - 2, y: -h / 2, width: 4, height: h, class: 'mi-block' }, n.welcomeMark);
        });

        // 进出舞台：档案号
        n.file = el('g', { opacity: 0 }, svg);
        n.fileLabel = el('text', { x: CX, y: CY - 8, 'text-anchor': 'middle', 'font-size': 9, 'letter-spacing': '2.4', class: 'mi-muted' }, n.file);
        n.fileText = el('text', { x: CX, y: CY + 14, 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 700, 'letter-spacing': '.5' }, n.file);

        n.flash = document.createElement('div');
        n.flash.className = 'mi-flash';
        root.appendChild(n.flash);
        return n;
    };

    // 光标跟在已打出的字后面；字宽随字体变，直接量。
    const textWidth = (node) => {
        if (!node.textContent) return 0;
        try { return node.getComputedTextLength(); } catch (e) { return node.textContent.length * 9; }
    };

    // ---------- 扫描环（开场与短版共用） ----------
    // local 是扫描段内的秒数；speed 把同一条轨迹压快（短版 1.5 倍）。
    const renderScan = (n, local, { speed = 1, count = 0, label = 'INDEXING', sub = '' } = {}) => {
        const t = local * speed;
        const r = keys([[0, 1500], [0.2, 900], [0.4, 520], [0.6, 330], [0.8, 274], [1.0, 258], [1.9, 246]], t);
        const outerStart = keys([[0, 470], [0.4, 230], [0.8, 20], [1.2, -70], [1.9, -90]], t) * DEG;
        const outerSweep = keys([[0, 30], [0.4, 190], [0.8, 300], [1.2, 352], [1.6, 360]], t) * DEG;
        const whiteStart = keys([[0, -100], [0.5, 120], [1.0, 230], [1.9, 270]], t) * DEG;
        const whiteSweep = keys([[0, 18], [0.6, 70], [1.2, 40], [1.9, 28]], t) * DEG;
        const innerR = r * 0.78;
        const innerStart = (-40 + t * 140) * DEG;
        const innerSweep = keys([[0, 0], [0.5, 60], [1.0, 120], [1.9, 140]], t) * DEG;
        n.outer.setAttribute('d', arc(r, outerStart, outerSweep));
        n.white.setAttribute('d', arc(r * 0.91, whiteStart, whiteSweep));
        n.innerA.setAttribute('d', arc(innerR, innerStart, innerSweep));
        n.innerB.setAttribute('d', arc(innerR, innerStart + Math.PI, innerSweep));
        const orbit = (t * 210) * DEG;
        n.dots.forEach((dot, i) => {
            dot.setAttribute('cx', (CX + Math.cos(orbit + i * Math.PI) * innerR * 0.86).toFixed(2));
            dot.setAttribute('cy', (CY + Math.sin(orbit + i * Math.PI) * innerR * 0.86).toFixed(2));
        });
        const capA = outerStart + outerSweep;
        n.cap.setAttribute('cx', (CX + Math.cos(capA) * r).toFixed(2));
        n.cap.setAttribute('cy', (CY + Math.sin(capA) * r).toFixed(2));

        // 两帧频闪：圆环突然放大变淡，像信号没对上。
        const f = frameOf(t);
        const glitch = f === 19 || f === 20 || f === 22;
        n.scanRings.setAttribute('transform', glitch ? `translate(${CX} ${CY}) scale(1.9) translate(${-CX} ${-CY})` : '');
        n.scanRings.style.opacity = glitch ? '0.32' : String(keys([[0, 0], [0.04, 0.2], [0.12, 0.65], [0.2, 1]], t));
        n.scanRings.style.filter = glitch ? 'blur(1.4px)' : '';

        // 字距从很散收拢到正常
        const tracking = keys([[0, 26], [0.2, 12], [0.4, 5], [0.6, 1.6], [0.8, 0]], t);
        n.scanText.setAttribute('letter-spacing', tracking.toFixed(2));
        n.scanText.textContent = `${label} ${pad4(count)} FILES`;
        n.scanText.style.opacity = String(keys([[0, 0], [0.16, 1]], t));
        n.scanSub.textContent = sub;
        n.scanSub.style.opacity = String(progress(t, 0.5, 0.7));
        n.core.setAttribute('r', String(keys([[1.2, 0], [1.35, 5], [1.5, 3.2]], t)));
    };

    // ---------- 开场 ----------
    const FULL = { scan: 6.2, welcome: 8.0, exit: 9.0, end: 9.75 };
    const SHORT = { end: 2.5 };

    const renderFull = (n, t, ctx) => {
        const f = frameOf(t);
        // 访问请求
        n.access.style.opacity = t < 0.35 || t >= 2.1 ? '0' : f === frameOf(2.0) ? '0.25' : '1';
        n.accessText.textContent = typed('AUDIO ARCHIVE / ACCESS REQUEST', t, 0.4, 1.35);
        n.accessCursor.setAttribute('x', String(392 + textWidth(n.accessText) + 4));
        n.accessCursor.style.opacity = Math.floor(t * 2.5) % 2 ? '0' : '1';

        // 记号描线、音轨竖条升起、文字
        n.mark.style.opacity = t >= 2.2 && t < FULL.scan ? '1' : '0';
        const draw = easeOut(progress(t, 2.2, 2.9));
        n.markRing.setAttribute('stroke-dasharray', `${draw.toFixed(4)} ${(1 - draw + 0.0001).toFixed(4)}`);
        const heights = [24, 44, 62, 40, 20];
        n.markBars.forEach((bar, i) => {
            const h = heights[i] * easeOut(progress(t, 2.7 + i * 0.07, 3.1 + i * 0.07));
            bar.setAttribute('height', h.toFixed(2));
            bar.setAttribute('y', (300 - h / 2).toFixed(2));
        });
        n.markWord.textContent = typed('VCP · MUSIC', t, 3.0, 3.45);
        n.brand.forEach((line, i) => {
            const p = easeOut(progress(t, 3.3 + i * 0.08, 3.85 + i * 0.08));
            line.setAttribute('opacity', String(clamp01(p * 3)));
            line.setAttribute('transform', `translate(${(1 - p) * 60} 0)`);
        });
        n.mark.setAttribute('transform', `translate(${keys([[2.2, 70], [3.4, 70], [3.9, 0]], t)} 0)`);

        // 身份核验
        n.auth.style.opacity = t >= 3.6 && t < 6.2 ? '1' : '0';
        let auth = '';
        if (t < 4.75) {
            auth = typed('ID CONFIRMED', t, 3.6, 3.95);
            if (t >= 4.12) auth += ' : ' + typed(ctx.name, t, 4.15, 4.5);
        } else if (t < 5.35) auth = typed('REQUEST RECEIVED', t, 4.8, 5.15);
        else {
            auth = typed('START PROCESSING', t, 5.4, 5.72);
            if (t >= 5.78) auth += '.'.repeat(Math.min(3, 1 + Math.floor((t - 5.78) / 0.12)));
            if (f === frameOf(6.04) || f === frameOf(6.12)) auth = '            SING...';
        }
        n.authText.textContent = auth;
        n.authCursor.setAttribute('x', String(410 + textWidth(n.authText) + 4));
        n.authCursor.style.opacity = Math.floor(t * 2.5) % 2 ? '0' : '1';

        // 扫描环：曲库计数跟着环收拢一起数上来
        const scanOn = t >= FULL.scan && t < FULL.welcome;
        n.scan.style.opacity = scanOn ? String(f >= frameOf(7.75) ? keys([[7.75, 1], [7.9, 0.1]], t) : 1) : '0';
        if (scanOn) {
            const local = t - FULL.scan;
            renderScan(n, local, {
                count: ctx.count() * easeOut(progress(local, 0.1, 1.2)),
                sub: progress(local, 0.5, 0.7) > 0 ? `ID : ${ctx.name}` : ''
            });
        }

        // 欢迎面板：开头几帧面板和字一起闪，像信号接通
        const welcomeOn = t >= FULL.welcome && t < FULL.end;
        n.welcome.style.opacity = welcomeOn ? '1' : '0';
        if (welcomeOn) {
            const k = f - frameOf(FULL.welcome);
            const panel = k >= 0 && k < 7 ? [1, 0, 0.28, 0, 1, 1, 1][k] : 1;
            const ink = k >= 0 && k < 7 ? [0, 0, 0.2, 1, 0, 0.25, 1][k] : 1;
            n.welcomeBlock.style.opacity = String(panel);
            n.welcomeName.style.opacity = String(panel);
            n.welcomeHead.style.opacity = String(ink);
            n.welcomeRule.setAttribute('width', String(256 * easeOut(progress(t, 8.3, 8.7))));
            const subOn = t >= 8.55 && !(f === frameOf(8.63) || f === frameOf(8.71));
            n.welcomeSub.style.opacity = subOn ? '1' : '0';
            n.welcomeSub.textContent = `AUDIO ARCHIVE · ${pad4(ctx.count())} FILES`;
            n.welcomeMark.style.opacity = t >= 8.4 ? '1' : '0';
            const exit = smooth(progress(t, FULL.exit, FULL.exit + 0.36));
            n.welcomeInner.setAttribute('transform', `translate(${CX} ${CY}) scale(${1 - 0.46 * exit}) translate(${-CX} ${-CY})`);
            n.welcome.style.opacity = String(1 - Math.pow(exit, 3));
            n.welcome.style.filter = exit > 0 ? `blur(${(8 * exit).toFixed(2)}px)` : '';
        }
        // 白场，然后整层淡出露出主界面
        const white = smooth(progress(t, FULL.exit - 0.05, FULL.exit + 0.35));
        n.flash.style.opacity = String(white * ctx.flashPeak);
        return 1 - smooth(progress(t, FULL.exit + 0.35, FULL.end));
    };

    const renderShort = (n, t, ctx) => {
        n.scan.style.opacity = String(1 - smooth(progress(t, 1.45, 1.75)));
        renderScan(n, t, {
            speed: 1.5,
            count: ctx.count() * easeOut(progress(t, 0.1, 1.0)),
            sub: `ID : ${ctx.name}`
        });
        const white = smooth(progress(t, 1.35, 1.8));
        n.flash.style.opacity = String(white * ctx.flashPeak);
        return 1 - smooth(progress(t, 1.8, SHORT.end));
    };

    // ---------- 进出舞台 ----------
    // 进：第一帧还是档案页（舞台被按住不显示），圆环收拢、打出档案号，白场在 0.58 秒到不透明，
    //     这一刻才放开舞台，白场退去时下面已经是舞台。
    // 退：舞台先被按住不消失，白场 0.2 秒到不透明时放开，白场退去露出档案页，圆环张开。
    const TRANSIT = { enter: 1.1, exit: 0.8, enterRelease: 0.58, exitRelease: 0.2 };
    const renderTransit = (n, t, ctx) => {
        const entering = ctx.direction === 'enter';
        const releaseAt = entering ? TRANSIT.enterRelease : TRANSIT.exitRelease;
        if (!ctx.released && t >= releaseAt) { ctx.released = true; ctx.release?.(); }
        n.innerA.setAttribute('d', ''); n.innerB.setAttribute('d', '');
        let r, sweep, start;
        if (entering) {
            n.veil.setAttribute('opacity', String(0.38 * smooth(progress(t, 0, 0.15))));
            r = keys([[0, 640], [0.2, 300], [0.45, 168], [0.7, 160]], t);
            sweep = keys([[0, 30], [0.25, 220], [0.5, 360]], t) * DEG;
            start = keys([[0, 200], [0.5, -90]], t) * DEG;
            n.white.setAttribute('d', arc(r * 0.9, start + Math.PI * 0.8, 50 * DEG));
            n.scan.style.opacity = String(smooth(progress(t, 0, 0.08)));
            n.fileLabel.textContent = 'TRACK DATABASE';
            n.fileText.textContent = typed(ctx.file, t, 0.04, 0.34);
            n.flash.style.opacity = String(smooth(progress(t, 0.34, releaseAt)) * (1 - smooth(progress(t, releaseAt + 0.08, TRANSIT.enter))));
            // 白场盖严之后，遮罩和圆环一起撤掉，白场退去时只剩舞台。
            if (t >= releaseAt) { n.veil.setAttribute('opacity', '0'); n.scan.style.opacity = '0'; }
        } else {
            n.flash.style.opacity = String(smooth(progress(t, 0, releaseAt)) * (1 - smooth(progress(t, releaseAt + 0.04, 0.6))));
            n.veil.setAttribute('opacity', String(t < releaseAt ? 0 : 0.3 * (1 - smooth(progress(t, 0.4, 0.75)))));
            r = keys([[releaseAt, 160], [0.62, 520]], t);
            sweep = keys([[releaseAt, 360], [0.62, 40]], t) * DEG;
            start = keys([[releaseAt, -90], [0.62, 160]], t) * DEG;
            n.white.setAttribute('d', '');
            n.scan.style.opacity = String(t < releaseAt ? 0 : 1 - smooth(progress(t, 0.42, 0.7)));
            n.fileLabel.textContent = 'RETURN';
            n.fileText.textContent = typed('ARCHIVE', t, releaseAt, releaseAt + 0.16);
        }
        n.outer.setAttribute('d', arc(r, start, sweep));
        n.cap.setAttribute('cx', (CX + Math.cos(start + sweep) * r).toFixed(2));
        n.cap.setAttribute('cy', (CY + Math.sin(start + sweep) * r).toFixed(2));
        n.file.style.opacity = n.scan.style.opacity;
        return 1;
    };

    // music.html 里一开始就有一层底色盖着，等脚本接手；接手后把它换掉。
    const dropCover = () => document.getElementById('music-intro-cover')?.remove();

    // ---------- 播放器 ----------
    const init = (app) => {
        let current = null;
        let userName = 'GUEST';

        const loadName = async () => {
            try {
                const api = global.utilityAPI?.loadSettings ? global.utilityAPI : app?.api || global.electronAPI;
                const settings = await api?.loadSettings?.();
                const name = String(settings?.userName || '').trim();
                if (name) userName = name.toUpperCase().slice(0, 24);
            } catch (e) { /* 取不到设置就用 GUEST */ }
        };
        const namePromise = loadName();

        // 调试用：?introSlow=10 让过场慢 10 倍，方便逐帧看舞台什么时候露出来。
        let timeScale = 1;
        try { timeScale = 1 / Math.max(1, Number(new URLSearchParams(global.location.search).get('introSlow')) || 1); } catch (e) { /* 正常速度 */ }

        const count = () => (Array.isArray(app?.playlist) ? app.playlist.length : 0);
        const flashPeak = () => parseFloat(getComputedStyle(document.body).getPropertyValue('--mi-flash-peak')) || 1;

        // 舞台「按住」：进场时舞台先不显示，退场时舞台先不消失，等白场盖严再放开。
        const HOLD = ['mi-stage-hold-enter', 'mi-stage-hold-exit'];
        const releaseStage = () => {
            if (!HOLD.some((c) => document.body.classList.contains(c))) return;
            // 放开的那一下不要再走舞台自己的 0.38 秒淡入淡出，白场后面直接换好。
            document.body.classList.add('mi-stage-snap');
            document.body.classList.remove(...HOLD);
            requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('mi-stage-snap')));
        };

        const stop = (instant = false) => {
            if (!current) return;
            const run = current;
            current = null;
            releaseStage();
            cancelAnimationFrame(run.raf);
            run.detach();
            document.body.classList.remove('music-intro-playing');
            if (instant || reducedMotion()) { run.root.remove(); run.done?.(); return; }
            const fade = run.root.animate([{ opacity: getComputedStyle(run.root).opacity }, { opacity: 0 }], { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' });
            fade.finished.catch(() => {}).then(() => { run.root.remove(); run.done?.(); });
        };

        const start = (kind, extra = {}) => {
            stop(true);
            const root = document.createElement('div');
            root.className = 'music-intro' + (kind === 'enter' || kind === 'exit' ? ' is-transit' : '');
            root.dataset.intro = kind;
            const transit = root.classList.contains('is-transit');
            if (!transit) {
                root.setAttribute('role', 'presentation');
                const skip = document.createElement('div');
                skip.className = 'mi-skip';
                skip.textContent = 'PRESS ANY KEY TO SKIP';
                root.appendChild(skip);
            }
            document.body.appendChild(root);
            if (!transit) dropCover();
            const nodes = buildScene(root);
            const ctx = { name: userName, count, flashPeak: flashPeak(), direction: kind, file: extra.file || '', release: releaseStage, released: false };
            const render = kind === 'full' ? renderFull : kind === 'short' ? renderShort : renderTransit;
            const length = kind === 'full' ? FULL.end : kind === 'short' ? SHORT.end : TRANSIT[kind];

            const onKey = (event) => { event.preventDefault(); event.stopPropagation(); stop(); };
            const onPointer = (event) => { event.stopPropagation(); stop(); };
            if (!transit) {
                global.addEventListener('keydown', onKey, true);
                root.addEventListener('pointerdown', onPointer);
                document.body.classList.add('music-intro-playing');
            }
            const run = {
                root,
                raf: 0,
                done: extra.done,
                detach: () => {
                    global.removeEventListener('keydown', onKey, true);
                    root.removeEventListener('pointerdown', onPointer);
                }
            };
            current = run;
            namePromise.then(() => { ctx.name = userName; });

            // 预览/截图用：?introAt=秒 固定在某一帧。
            const fixed = extra.at;
            const t0 = performance.now();
            const tick = (now) => {
                if (current !== run) return;
                const t = fixed ?? (now - t0) / 1000 * timeScale;
                const opacity = render(nodes, t, ctx);
                root.style.opacity = String(opacity);
                if (fixed == null && t >= length) { current = null; releaseStage(); run.detach(); document.body.classList.remove('music-intro-playing'); root.remove(); run.done?.(); return; }
                run.raf = requestAnimationFrame(tick);
            };
            run.raf = requestAnimationFrame(tick);
            if (fixed != null) tick(t0);
            return run;
        };

        // 减少动态：开场只是一层底色淡出；舞台进出不加过场。
        const fadeOnly = () => {
            const root = document.createElement('div');
            root.className = 'music-intro';
            document.body.appendChild(root);
            dropCover();
            root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-out', fill: 'forwards' })
                .finished.catch(() => {}).then(() => root.remove());
        };

        const playIntro = (kind) => {
            if (reducedMotion()) { fadeOnly(); return; }
            if (kind === 'full') { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* 只是记住看过 */ } }
            start(kind);
        };

        // ---------- 进出舞台：只看 body 上的类，不碰舞台代码 ----------
        let wasStage = document.body.classList.contains('music-stage-active');
        let enteringTimer = 0;
        const transit = (direction) => {
            if (reducedMotion()) return null;
            if (current && !current.root.classList.contains('is-transit')) return null; // 开场还没放完就不叠过场
            if (direction === 'enter') {
                // 档案页据此把选中卡抬起来并继续画；舞台照常加载，只是先不露出来。
                document.body.classList.add('music-stage-entering');
                clearTimeout(enteringTimer);
                enteringTimer = setTimeout(() => document.body.classList.remove('music-stage-entering'), TRANSIT.enter * 1000 / timeScale);
                const track = app?.playlist?.[app.currentTrackIndex];
                const file = global.MusicTrackSpecs?.fileNumber?.(track) || 'TRK-0000';
                const run = start('enter', { file: `FILE NUMBER: ${file}` });
                document.body.classList.remove('mi-stage-hold-exit');
                document.body.classList.add('mi-stage-hold-enter');
                return run;
            }
            document.body.classList.remove('music-stage-entering');
            const run = start('exit');
            document.body.classList.remove('mi-stage-hold-enter');
            document.body.classList.add('mi-stage-hold-exit');
            return run;
        };
        // 舞台的 enter()/exit() 是同步改 body 类的；MutationObserver 在同一轮里、首帧绘制之前回调，
        // 所以在这里按住舞台，第一帧画出来的仍是档案页（退场时仍是舞台）。
        const onBody = () => {
            const isStage = document.body.classList.contains('music-stage-active');
            if (isStage === wasStage) return;
            wasStage = isStage;
            transit(isStage ? 'enter' : 'exit');
        };
        const bodyObserver = new MutationObserver(onBody);
        bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

        const api = {
            /** 重新放一遍完整开场（设置里「播放完整开场」调用这个）。 */
            replay: () => playIntro('full'),
            playShort: () => playIntro('short'),
            skip: () => stop(),
            /** 进出舞台过场；舞台进出时会自动调用，一般不需要手动调。 */
            transit,
            /** 截图/调试：把某一段固定在第 t 秒。 */
            freeze: (kind, t, extra = {}) => start(kind, { ...extra, at: t }),
            get playing() { return current ? current.root.dataset.intro : null; }
        };
        app && (app.musicIntro = api);
        global.MusicIntro = api;

        // 开窗即放：第一次是完整版，之后是短版。?intro=full|short|off 可以强制。
        let forced = null;
        try { forced = new URLSearchParams(global.location.search).get('intro'); } catch (e) { /* 没有查询串 */ }
        // 自动化测试（webdriver）不放开场，免得挡住界面；要看就显式带 ?intro=。
        if (!forced && global.navigator?.webdriver) forced = 'off';
        if (forced === 'off') dropCover();
        else {
            let seen = false;
            try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { /* 当作没看过 */ }
            playIntro(forced === 'full' || forced === 'short' ? forced : (seen ? 'short' : 'full'));
        }
        return api;
    };

    global.MusicIntroLib = { init };
})(window);
