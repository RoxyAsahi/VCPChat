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
        const z = (parseInt(cs.zIndex, 10) || 1000);
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

    function cancel(el) {
        const stop = running.get(el);
        if (stop) stop();
    }

    global.MusicFluid = Object.freeze({ bud, cancel, enabled });
})(typeof window !== 'undefined' ? window : globalThis);
