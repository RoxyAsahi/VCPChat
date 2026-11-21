// 音乐窗口里「手碰得到的东西」共用的一套流体动作。
//
//   MusicFluid.bud(el, origin)      弹出层从触发的那一点长出来：先是一滴，拉出细颈，再鼓成整块，内容随后显现
//   MusicFluid.enabled()            降低动态、节能档时为 false（只淡入，不画液体）
//
// 外观在 music-fluid-kit.css：.mf-glass 是奶白（深色下烟灰）的厚玻璃，颜色从里面透出来，发光不投硬影，没有描边。
// 液体只在长出来的那 0.45 秒里画（一层临时 SVG，结束就拿掉），平时一帧都不画。
(function (global) {
    'use strict';
    const NS = 'http://www.w3.org/2000/svg';
    const DURATION = 460;
    const running = new WeakMap();

    const enabled = () => {
        const doc = global.document;
        if (!doc?.body) return false;
        if (doc.body.classList.contains('music-reduce-motion')) return false;
        if (doc.getElementById('music-dock-root')?.classList.contains('md-fl-low')) return false;
        return typeof global.requestAnimationFrame === 'function';
    };

    // 快速起、软着陆，末尾略微回弹一点点，像液体鼓满
    const ease = (t) => {
        const c = 1 - Math.pow(1 - t, 3);
        return c + Math.sin(Math.PI * t) * 0.06 * (1 - t);
    };
    const lerp = (a, b, t) => a + (b - a) * t;

    const pointOf = (origin) => {
        if (!origin) return null;
        if (typeof origin.getBoundingClientRect === 'function') origin = origin.getBoundingClientRect();
        if (typeof origin.width === 'number' && typeof origin.left === 'number') {
            return { x: origin.left + origin.width / 2, y: origin.top + origin.height / 2 };
        }
        if (typeof origin.x === 'number' && typeof origin.y === 'number') return { x: origin.x, y: origin.y };
        return null;
    };

    let seq = 0;
    const overlay = (doc, z) => {
        const id = `mfk${++seq}`;
        const svg = doc.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'mf-goo');
        svg.setAttribute('aria-hidden', 'true');
        svg.style.zIndex = String(z);
        svg.innerHTML = `<defs><filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">`
            + '<feGaussianBlur in="SourceGraphic" stdDeviation="9" result="b"/>'
            + '<feColorMatrix in="b" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10" result="g"/>'
            + '<feGaussianBlur in="g" stdDeviation="1.2"/>'
            + `</filter></defs><g filter="url(#${id})"><circle/><rect/></g>`;
        doc.body.appendChild(svg);
        return { svg, drop: svg.querySelector('circle'), body: svg.querySelector('rect') };
    };

    // 弹出层 el 此时已经放好位置、可见（display 不为 none）。
    function bud(el, origin, { duration = DURATION } = {}) {
        if (!el || !el.isConnected) return Promise.resolve();
        cancel(el);
        const doc = el.ownerDocument;
        const from = pointOf(origin);
        if (!enabled() || !from) {
            el.classList.remove('mf-budding');
            return Promise.resolve();
        }
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return Promise.resolve();
        const cs = global.getComputedStyle(el);
        const radius = Math.min(rect.height / 2, parseFloat(cs.borderTopLeftRadius) || 16);
        const fill = cs.getPropertyValue('--mf-fill').trim() || cs.backgroundColor || 'rgba(128,128,128,.9)';
        // 液体要画在弹出层所在那一层上面：取它自己和外层里最大的 z-index
        let z = parseInt(cs.zIndex, 10) || 0;
        for (let node = el.parentElement; node && node !== doc.body; node = node.parentElement) {
            z = Math.max(z, parseInt(global.getComputedStyle(node).zIndex, 10) || 0);
        }
        z = z || 1000;
        const layer = overlay(doc, z);
        layer.drop.setAttribute('fill', fill);
        layer.body.setAttribute('fill', fill);
        el.classList.add('mf-budding');
        // 起点那一滴贴着触发点；整块从起点附近一个小圆角块长到目标大小
        const start = { x: from.x - 14, y: from.y - 14, w: 28, h: 28 };
        let frame = 0;
        let revealed = false;
        return new Promise((resolve) => {
            const clock = () => global.performance?.now?.() ?? Date.now();
            const t0 = clock();
            const done = () => {
                global.cancelAnimationFrame(frame);
                layer.svg.remove();
                el.classList.remove('mf-budding');
                running.delete(el);
                resolve();
            };
            running.set(el, done);
            const step = () => {
                const t = Math.min(1, (clock() - t0) / duration);
                // 横竖不同步：沿离起点远的方向先流过去，另一个方向稍晚才铺开，像倒出来的液体
                const e = ease(t);
                const lagX = Math.abs(rect.left + rect.width / 2 - from.x) < Math.abs(rect.top + rect.height / 2 - from.y);
                const eLag = ease(Math.max(0, (t - 0.1) / 0.9));
                const ex = lagX ? eLag : e, ey = lagX ? e : eLag;
                const x = lerp(start.x, rect.left, ex), y = lerp(start.y, rect.top, ey);
                const w = lerp(start.w, rect.width, ex), h = lerp(start.h, rect.height, ey);
                const b = layer.body;
                b.setAttribute('x', x.toFixed(1)); b.setAttribute('y', y.toFixed(1));
                b.setAttribute('width', Math.max(0, w).toFixed(1)); b.setAttribute('height', Math.max(0, h).toFixed(1));
                // 刚长出来时是圆滚滚的一团，鼓满时才收成面板的圆角
                const round = Math.min(w, h) / 2;
                b.setAttribute('rx', Math.min(lerp(round, radius, e * e), h / 2, w / 2).toFixed(1));
                // 起点那一滴先鼓一下再缩回去，和整块之间由滤镜自己拉出细颈
                const d = layer.drop;
                d.setAttribute('cx', from.x.toFixed(1)); d.setAttribute('cy', from.y.toFixed(1));
                d.setAttribute('r', Math.max(0, 15 * Math.sin(Math.PI * Math.min(1, t * 1.25))).toFixed(1));
                layer.svg.style.opacity = t < 0.72 ? '1' : String(Math.max(0, 1 - (t - 0.72) / 0.28));
                if (!revealed && t >= 0.55) { revealed = true; el.classList.remove('mf-budding'); }
                if (t >= 1) { done(); return; }
                frame = global.requestAnimationFrame(step);
            };
            step();
        });
    }

    // 选中标记（分段开关里那块、页签下那条）换位置时像一滴液体流过去：
    // 前沿先到，后沿慢半拍才跟上，中途被拉长，到了再收成原来的宽度。
    // 位置是相对父元素的 left/width（像素）。第一次放、降低动态时直接落位。
    // 标记所在的那一排每次都会重画（新的元素）时，传同一个 key，就能接着上一次的位置流过去。
    const slides = new Map();
    // axis: 'x'（默认，用 left/width）或 'y'（用 top/height，比如歌词里当前那一行背后的那滴）
    function slide(el, to, { lead = 220, trail = 380, key = null, axis = 'x' } = {}) {
        if (!el || !to) return;
        const [P, S] = axis === 'y' ? ['top', 'height'] : ['left', 'width'];
        const goal = { pos: Number(to[P]), size: Number(to[S]) };
        if (!Number.isFinite(goal.pos) || !Number.isFinite(goal.size)) return;
        const id = key || el;
        const prev = slides.get(id);
        if (prev?.frame) global.cancelAnimationFrame(prev.frame);
        const place = (pos, size) => { el.style[P] = `${pos.toFixed(1)}px`; el.style[S] = `${Math.max(0, size).toFixed(1)}px`; };
        const from = prev?.at;
        const motion = Boolean(global.document?.body) && !global.document.body.classList.contains('music-reduce-motion') && typeof global.requestAnimationFrame === 'function';
        if (!from || !motion || (Math.abs(from.pos - goal.pos) < 0.5 && Math.abs(from.size - goal.size) < 0.5)) {
            place(goal.pos, goal.size);
            slides.set(id, { at: { ...goal }, frame: 0 });
            return;
        }
        el.style.transition = 'none';
        const forward = goal.pos > from.pos;
        const s0 = from.pos, e0 = from.pos + from.size;
        const s1 = goal.pos, e1 = goal.pos + goal.size;
        const clock = () => global.performance?.now?.() ?? Date.now();
        const t0 = clock();
        const out = (t) => 1 - Math.pow(1 - t, 3);
        const state = { at: { pos: s0, size: from.size }, frame: 0 };
        slides.set(id, state);
        const step = () => {
            const ms = clock() - t0;
            const a = out(Math.min(1, ms / lead));
            const b = out(Math.min(1, ms / trail));
            // 往前（右、下）走：后面那条边是前沿；往回走：前面那条边是前沿
            const start = lerp(s0, s1, forward ? b : a);
            const end = lerp(e0, e1, forward ? a : b);
            state.at = { pos: start, size: end - start };
            place(start, end - start);
            if (ms >= trail) { state.frame = 0; state.at = { ...goal }; place(goal.pos, goal.size); return; }
            state.frame = global.requestAnimationFrame(step);
        };
        step();
    }

    function cancel(el) {
        const stop = running.get(el);
        if (stop) stop();
    }

    // ───────── 弹窗：从最后一次按下的地方长出来 ─────────
    // 各处弹窗（歌词获取、WebDAV、歌单对话框……）打开时都是给遮罩层加 visible / active 类。
    // 这里统一看着这些遮罩层，打开时把里面的面板从最后一次按下指针的那一点长出来，各处代码不用改。
    let lastPress = null;
    const OVERLAYS = '.music-modal-overlay, .dialog-overlay';
    const PANEL = '.music-modal, .dialog';
    const watchDialogs = () => {
        const doc = global.document;
        if (!doc?.body || typeof global.MutationObserver !== 'function') return;
        doc.addEventListener('pointerdown', (event) => { lastPress = { x: event.clientX, y: event.clientY, at: Date.now() }; }, true);
        const isOpen = (node) => node.classList.contains('visible') || node.classList.contains('active');
        const seen = new WeakMap();
        const check = (node) => {
            const open = isOpen(node);
            if (open && !seen.get(node)) {
                const panel = node.querySelector(PANEL);
                // 键盘打开（没有最近的按下）就从窗口底部中间、播放条的位置长出来
                const fresh = lastPress && Date.now() - lastPress.at < 1500;
                const from = fresh ? lastPress : { x: global.innerWidth / 2, y: global.innerHeight - 60 };
                if (panel) global.requestAnimationFrame?.(() => bud(panel, from, { duration: 520 }));
            }
            seen.set(node, open);
        };
        const observer = new global.MutationObserver((records) => {
            for (const r of records) if (r.target.matches?.(OVERLAYS)) check(r.target);
        });
        for (const node of doc.querySelectorAll(OVERLAYS)) {
            seen.set(node, isOpen(node));
            observer.observe(node, { attributes: true, attributeFilter: ['class'] });
        }
    };
    if (global.document?.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', watchDialogs, { once: true });
    else watchDialogs();

    // 最近 1.5 秒内按下指针的那一点；键盘打开的东西拿不到时返回 null，由调用方决定从哪里长
    const recentPress = () => (lastPress && Date.now() - lastPress.at < 1500 ? { x: lastPress.x, y: lastPress.y } : null);

    global.MusicFluid = Object.freeze({ bud, slide, cancel, enabled, recentPress });
})(typeof window !== 'undefined' ? window : globalThis);
