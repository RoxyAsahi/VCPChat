/*
 * 墨痕（inkdraft）的线稿：像演算纸、论文插图上的那种细线图——轨道、星图、晶格、
 * 分子、探测器截面、粒子图、演算草稿、能谱、势能曲线、气泡室、企鹅图、箱图……
 *
 * 每张图在半径 1 的坐标里用 Pen 画。Pen 每调用一次算「一笔」，笔序写进编号画布的
 * G 通道，着色器按笔序一笔一笔把它显出来。同一套图也可以用粗线画进 B 通道，当作垫在
 * 字后面的半调大图（tone 模式，不记笔序，随整段一起出现）。
 *
 * 纯 2D 画布绘制，只在准备一段（一句歌词或一段间奏）时跑一次，不进每帧循环。
 */
(function (global) {
    'use strict';

    const TAU = Math.PI * 2;
    // 注记：演算纸上的衬线斜体（数学字体优先），和歌词的黑体分开
    const NOTE_FONT = '"Cambria Math", "STIX Two Math", Cambria, Georgia, "Times New Roman", "Noto Serif", "Source Han Serif SC", "Songti SC", serif';

    /*
     * 一支笔：main 是主画布（R 字、G 线稿、B 半调），ids 是编号画布（缩小 idScale 倍，
     * R 字的编号、G 笔序）。transform 把半径 1 的坐标放到世界像素：中心 x,y、半径 r、旋转 rot。
     */
    const createPen = (main, ids, idScale, options = {}) => {
        const tone = Boolean(options.tone);
        let order = options.startOrder || 1;
        let x0 = 0, y0 = 0, radius = 1, cos = 1, sin = 0;
        const width = options.lineWidth || 2;
        const toneLevel = options.toneLevel ?? 0.32;
        // 线的边是一道缓坡（不是一刀切）：着色器切阈值时被噪点搅过，切出来的边才是毛的
        const soft = options.soft || 0;
        // 编号图上的笔比线宽出一圈：线两边那圈网点也按这一笔的笔序出现
        const fringe = options.fringe || 0;

        const map = (x, y) => [x0 + (x * cos - y * sin) * radius, y0 + (x * sin + y * cos) * radius];

        const begin = () => {
            main.save();
            main.globalCompositeOperation = 'lighter';
            main.lineCap = 'round';
            main.lineJoin = 'round';
            if (tone) {
                const level = Math.round(255 * toneLevel);
                main.strokeStyle = `rgb(0,0,${level})`;
                main.fillStyle = `rgb(0,0,${level})`;
            } else {
                main.strokeStyle = 'rgb(0,255,0)';
                main.fillStyle = 'rgb(0,255,0)';
            }
            main.lineWidth = width;
            if (soft > 0) main.filter = `blur(${soft.toFixed(2)}px)`;
            if (ids && !tone) {
                ids.save();
                ids.globalCompositeOperation = 'lighten';
                const value = Math.min(255, order);
                ids.strokeStyle = `rgb(0,${value},0)`;
                ids.fillStyle = `rgb(0,${value},0)`;
                ids.lineCap = 'round';
                ids.lineJoin = 'round';
                ids.lineWidth = Math.max(2, (width + fringe * 2) * idScale + 2);
            }
        };
        const end = (fill = false) => {
            if (fill) main.fill(); else main.stroke();
            main.restore();
            if (ids && !tone) {
                if (fill) ids.fill(); else ids.stroke();
                ids.restore();
            }
            if (!tone) order = Math.min(255, order + 1);
        };
        // Both canvases trace the same path; the ids canvas at its own scale.
        const path = (points, closed = false) => {
            if (points.length < 2) return;
            main.beginPath();
            points.forEach(([x, y], index) => {
                const [px, py] = map(x, y);
                if (index) main.lineTo(px, py); else main.moveTo(px, py);
            });
            if (closed) main.closePath();
            if (ids && !tone) {
                ids.beginPath();
                points.forEach(([x, y], index) => {
                    const [px, py] = map(x, y);
                    if (index) ids.lineTo(px * idScale, py * idScale); else ids.moveTo(px * idScale, py * idScale);
                });
                if (closed) ids.closePath();
            }
        };
        const segments = (pairs) => {
            main.beginPath();
            if (ids && !tone) ids.beginPath();
            pairs.forEach(([a, b]) => {
                const [ax, ay] = map(a[0], a[1]);
                const [bx, by] = map(b[0], b[1]);
                main.moveTo(ax, ay); main.lineTo(bx, by);
                if (ids && !tone) { ids.moveTo(ax * idScale, ay * idScale); ids.lineTo(bx * idScale, by * idScale); }
            });
        };

        const pen = {
            get order() { return order; },
            place(x, y, r, rot = 0) { x0 = x; y0 = y; radius = r; cos = Math.cos(rot); sin = Math.sin(rot); },
            line(points, closed = false) { begin(); path(points, closed); end(); },
            segments(pairs) { if (!pairs.length) return; begin(); segments(pairs); end(); },
            dashed(a, b, dash = 0.05) {
                const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
                const count = Math.max(1, Math.floor(length / (dash * 2)));
                const pairs = [];
                for (let i = 0; i < count; i += 1) {
                    const t0 = i / count, t1 = (i + 0.5) / count;
                    pairs.push([[a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]]);
                }
                pen.segments(pairs);
            },
            ellipse(cx, cy, rx, ry, rot = 0, from = 0, to = TAU, steps = 64) {
                const points = [];
                const c = Math.cos(rot), s = Math.sin(rot);
                for (let i = 0; i <= steps; i += 1) {
                    const a = from + (to - from) * i / steps;
                    const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
                    points.push([cx + ex * c - ey * s, cy + ex * s + ey * c]);
                }
                pen.line(points, false);
            },
            circle(cx, cy, r, from = 0, to = TAU) { pen.ellipse(cx, cy, r, r, 0, from, to, Math.max(16, Math.round(48 * (to - from) / TAU))); },
            wave(a, b, waves = 5, amp = 0.04) {
                const dx = b[0] - a[0], dy = b[1] - a[1];
                const length = Math.hypot(dx, dy) || 1;
                const nx = -dy / length, ny = dx / length;
                const steps = waves * 12;
                const points = [];
                for (let i = 0; i <= steps; i += 1) {
                    const t = i / steps;
                    const o = Math.sin(t * waves * TAU) * amp;
                    points.push([a[0] + dx * t + nx * o, a[1] + dy * t + ny * o]);
                }
                pen.line(points);
            },
            arrow(a, b, head = 0.06) {
                const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
                pen.segments([[a, b],
                    [b, [b[0] - Math.cos(angle - 0.45) * head, b[1] - Math.sin(angle - 0.45) * head]],
                    [b, [b[0] - Math.cos(angle + 0.45) * head, b[1] - Math.sin(angle + 0.45) * head]]]);
            },
            dot(cx, cy, r = 0.025) {
                begin();
                const [px, py] = map(cx, cy);
                const pr = Math.max(1, r * radius);
                main.beginPath(); main.arc(px, py, pr, 0, TAU);
                if (ids && !tone) { ids.beginPath(); ids.arc(px * idScale, py * idScale, (pr + fringe) * idScale + 1, 0, TAU); }
                end(true);
            },
            note(text, x, y, size = 0.09, align = 'center') {
                if (tone) return;
                const [px, py] = map(x, y);
                const px2 = Math.max(9, size * radius);
                // 交给逐字层：注记的字和歌词一样按屏幕像素画（推近也不糊），这里只记下位置和笔序
                if (options.notes) {
                    options.notes.push({ text: String(text), x: px, y: py, size: px2, align, order, rot: Math.atan2(sin, cos) });
                    order = Math.min(255, order + 1);
                    return;
                }
                main.save();
                main.globalCompositeOperation = 'lighter';
                main.fillStyle = 'rgb(0,255,0)';
                main.font = `italic 400 ${px2.toFixed(1)}px ${NOTE_FONT}`;
                main.textAlign = align;
                main.textBaseline = 'middle';
                main.fillText(text, px, py);
                const width = main.measureText(text).width;
                main.restore();
                if (ids) {
                    ids.save();
                    ids.globalCompositeOperation = 'lighten';
                    ids.fillStyle = `rgb(0,${Math.min(255, order)},0)`;
                    const left = align === 'center' ? px - width / 2 : align === 'right' ? px - width : px;
                    ids.fillRect((left - 2) * idScale, (py - px2 * 0.7) * idScale, (width + 4) * idScale + 1, px2 * 1.4 * idScale + 1);
                    ids.restore();
                }
                order = Math.min(255, order + 1);
            }
        };
        return pen;
    };

    const pick = (random, list) => list[Math.floor(random() * list.length) % list.length];

    const EQUATIONS = [
        'E = mc²', '∇·E = ρ/ε₀', 'ψ(x, t)', '∂ₜρ + ∇·j = 0', 'H|ψ⟩ = E|ψ⟩', 'Γ = 2π|M|²ρ',
        'Δx Δp ≥ ħ/2', 'S = ∫ L dt', 'σ ∝ 1/s', 'ℒ = −¼ F²', 'Rμν − ½Rgμν', 'λ = h/p',
        'dN/dE', 'e^{iπ} + 1 = 0', '∮ B·dl = μ₀I', 'k_B T ln 2', 'v = H₀ d', 'ω² = k/m'
    ];

    const DRAW = {
        orbit(pen, random) {
            pen.dot(0, 0, 0.07);
            const rings = 3 + Math.floor(random() * 2);
            for (let i = 0; i < rings; i += 1) {
                const rx = 0.3 + i * 0.22;
                const ry = rx * (0.45 + random() * 0.4);
                const rot = random() * 0.6 - 0.3;
                pen.ellipse(0, 0, rx, ry, rot);
                const a = random() * TAU;
                pen.dot(Math.cos(a) * rx * Math.cos(rot) - Math.sin(a) * ry * Math.sin(rot),
                    Math.cos(a) * rx * Math.sin(rot) + Math.sin(a) * ry * Math.cos(rot), 0.03);
            }
            pen.note(`a = ${(0.4 + random() * 4).toFixed(2)} AU`, 0.55, -0.82, 0.09, 'left');
        },
        starmap(pen, random) {
            pen.circle(0, 0, 0.95, -0.2, Math.PI + 0.2);
            pen.circle(0, 0, 0.6, -0.1, Math.PI + 0.1);
            const stars = Array.from({ length: 9 }, () => [random() * 1.6 - 0.8, random() * 1.2 - 0.7]);
            stars.forEach(([x, y]) => pen.dot(x, y, 0.015 + random() * 0.03));
            const chain = stars.slice(0, 5 + Math.floor(random() * 3)).sort((a, b) => a[0] - b[0]);
            pen.line(chain);
            pen.note(pick(random, ['α Ori', 'β Lyr', 'γ Cyg', 'δ Cep', 'M42', 'NGC 1977']), chain[0][0], chain[0][1] - 0.12, 0.09);
            pen.note('RA 05ʰ35ᵐ', -0.9, 0.86, 0.075, 'left');
        },
        lattice(pen, random) {
            const ax = [0.36, 0.06 * (random() - 0.5)], ay = [0.14 * (random() - 0.5), 0.32];
            const n = 2;
            const at = (i, j) => [i * ax[0] + j * ay[0], i * ax[1] + j * ay[1]];
            for (let j = -n; j <= n; j += 1) pen.line([at(-n, j), at(n, j)]);
            for (let i = -n; i <= n; i += 1) pen.line([at(i, -n), at(i, n)]);
            for (let i = -n; i <= n; i += 1) for (let j = -n; j <= n; j += 1) if ((i + j) % 2 === 0) pen.dot(...at(i, j), 0.035);
            pen.arrow(at(0, 0), at(1, 0)); pen.note('a₁', at(1, 0)[0], at(1, 0)[1] + 0.1, 0.08);
            pen.arrow(at(0, 0), at(0, 1)); pen.note('a₂', at(0, 1)[0] - 0.1, at(0, 1)[1], 0.08);
        },
        cell(pen, random) {
            const s = 0.5, dx = 0.28, dy = -0.22;
            const f = [[-s, -s], [s, -s], [s, s], [-s, s]];
            const b = f.map(([x, y]) => [x + dx, y + dy]);
            pen.line(f, true);
            pen.line(b, true);
            pen.segments(f.map((p, i) => [p, b[i]]));
            [...f, ...b].forEach(([x, y]) => pen.dot(x, y, 0.04));
            pen.dot(dx / 2, dy / 2, 0.06);
            if (random() < 0.6) pen.dashed([-s, s], [s + dx, -s + dy], 0.04);
            pen.note('a', 0, s + 0.12, 0.09); pen.note('c', -s - 0.12, 0, 0.09);
        },
        molecule(pen, random) {
            const ring = Array.from({ length: 6 }, (_, i) => [Math.cos(i / 6 * TAU + Math.PI / 6) * 0.42, Math.sin(i / 6 * TAU + Math.PI / 6) * 0.42]);
            pen.line(ring, true);
            for (let i = 0; i < 6; i += 2) {
                const a = ring[i], c = ring[(i + 1) % 6];
                pen.line([[a[0] * 0.78, a[1] * 0.78], [c[0] * 0.78, c[1] * 0.78]]);
            }
            const labels = ['OH', 'CH₃', 'NH₂', 'O', 'Cl', 'COOH'];
            [0, 2 + Math.floor(random() * 2), 4].forEach((i) => {
                const [x, y] = ring[i];
                pen.line([[x, y], [x * 1.7, y * 1.7]]);
                pen.note(pick(random, labels), x * 2.05, y * 2.05, 0.1);
            });
        },
        detector(pen, random) {
            [0.18, 0.4, 0.62, 0.9].forEach((r) => pen.circle(0, 0, r));
            const ticks = [];
            for (let i = 0; i < 32; i += 1) {
                const a = i / 32 * TAU;
                ticks.push([[Math.cos(a) * 0.62, Math.sin(a) * 0.62], [Math.cos(a) * 0.9, Math.sin(a) * 0.9]]);
            }
            pen.segments(ticks);
            const tracks = 4 + Math.floor(random() * 4);
            for (let i = 0; i < tracks; i += 1) {
                const a = random() * TAU, bend = (random() - 0.5) * 1.2;
                const points = [];
                for (let k = 0; k <= 12; k += 1) {
                    const r = k / 12 * (0.5 + random() * 0.4);
                    points.push([Math.cos(a + bend * r) * r, Math.sin(a + bend * r) * r]);
                }
                pen.line(points);
            }
            pen.note('ECAL', 0.68, -0.98, 0.08, 'left');
            pen.note('HCAL', 0.95, 0.85, 0.08, 'left');
        },
        feynman(pen, random) {
            const v1 = [-0.3, 0], v2 = [0.3, 0];
            pen.arrow([-0.95, -0.6], v1, 0.07);
            pen.arrow(v1, [-0.95, 0.6], 0.07);
            if (random() < 0.5) pen.wave(v1, v2, 6, 0.05);
            else pen.ellipse(0, 0, 0.3, 0.16);
            pen.arrow(v2, [0.95, -0.6], 0.07);
            pen.arrow([0.95, 0.6], v2, 0.07);
            pen.dot(...v1, 0.03); pen.dot(...v2, 0.03);
            pen.note('e⁻', -1.02, -0.72, 0.1); pen.note('e⁺', -1.02, 0.72, 0.1);
            pen.note('γ', 0, -0.2, 0.1);
            pen.note(pick(random, ['μ⁻', 'q', 'τ⁻']), 1.02, -0.72, 0.1); pen.note(pick(random, ['μ⁺', 'q̄', 'τ⁺']), 1.02, 0.72, 0.1);
        },
        paths(pen, random) {
            const a = [-0.85, 0.3], b = [0.85, -0.3];
            pen.dot(...a, 0.04); pen.dot(...b, 0.04);
            for (let i = 0; i < 5; i += 1) {
                const points = [];
                const k1 = (random() - 0.5) * 1.2, k2 = (random() - 0.5) * 0.8;
                for (let s = 0; s <= 24; s += 1) {
                    const t = s / 24;
                    const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
                    const o = Math.sin(t * Math.PI) * k1 + Math.sin(t * Math.PI * 3) * k2 * 0.3;
                    points.push([x + o * 0.2, y + o * 0.6]);
                }
                pen.line(points);
            }
            pen.note('∫𝒟x e^{iS/ħ}', 0, 0.9, 0.11);
        },
        draft(pen, random) {
            const lines = 3 + Math.floor(random() * 2);
            for (let i = 0; i < lines; i += 1) {
                const y = -0.6 + i * 0.42;
                pen.note(pick(random, EQUATIONS), -0.9 + random() * 0.2, y, 0.16, 'left');
                if (random() < 0.4) pen.line([[-0.9, y + 0.12], [0.2 + random() * 0.6, y + 0.13]]);
            }
            if (random() < 0.6) pen.line([[-0.98, 0.3], [0.9, 0.3], [0.9, 0.62], [-0.98, 0.62]], true);
            pen.arrow([0.5, -0.8], [0.85, -0.45], 0.06);
        },
        shower(pen, random) {
            const segs = [];
            const grow = (x, y, a, len, depth) => {
                const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
                segs.push([[x, y], [x2, y2]]);
                if (depth <= 0) return;
                const spread = 0.25 + random() * 0.25;
                grow(x2, y2, a - spread, len * 0.78, depth - 1);
                grow(x2, y2, a + spread, len * 0.78, depth - 1);
            };
            grow(0, -0.95, Math.PI / 2, 0.34, 4);
            for (let i = 0; i < segs.length; i += 6) pen.segments(segs.slice(i, i + 6));
            pen.note('γ', 0.12, -0.9, 0.1);
            pen.note('e⁺e⁻', 0.6, 0.15, 0.09, 'left');
        },
        decay(pen, random) {
            const chain = pick(random, [['K⁺', 'π⁺', 'π⁰', 'γγ'], ['Λ', 'p', 'π⁻', 'μ⁻ν̄'], ['B⁰', 'D⁻', 'K⁺', 'π⁻π⁻'], ['τ⁻', 'ρ⁻', 'π⁰', 'ν']]);
            const pts = [[-0.8, -0.55], [-0.15, -0.1], [0.45, -0.5], [0.55, 0.5]];
            pen.note(chain[0], pts[0][0] - 0.12, pts[0][1] - 0.12, 0.13);
            pen.arrow(pts[0], pts[1], 0.07); pen.note(chain[1], pts[1][0] - 0.05, pts[1][1] + 0.16, 0.13);
            pen.arrow(pts[1], pts[2], 0.07); pen.note(chain[2], pts[2][0] + 0.12, pts[2][1] - 0.1, 0.13);
            pen.dashed(pts[1], pts[3], 0.04); pen.note(chain[3], pts[3][0] + 0.1, pts[3][1] + 0.12, 0.13);
        },
        spectrum(pen, random) {
            pen.line([[-0.9, -0.85], [-0.9, 0.7], [0.95, 0.7]]);
            const ticks = [];
            for (let i = 0; i <= 8; i += 1) ticks.push([[-0.9 + i * 0.23, 0.7], [-0.9 + i * 0.23, 0.76]]);
            pen.segments(ticks);
            const peak = 0.1 + (random() - 0.5) * 0.5;
            const hist = [];
            for (let i = 0; i < 30; i += 1) {
                const x = -0.88 + i * 0.061;
                const bg = 0.55 * Math.exp(-(x + 0.9) * 1.4);
                const sig = 0.75 * Math.exp(-((x - peak) ** 2) / 0.006);
                const y = 0.7 - Math.min(1.45, bg + sig + random() * 0.06);
                hist.push([x, y], [x + 0.061, y]);
            }
            pen.line(hist);
            pen.dashed([-0.9, 0.7 - 0.55], [0.95, 0.7 - 0.55 * Math.exp(-1.85 * 1.4)], 0.03);
            pen.note('m (GeV)', 0.7, 0.88, 0.08); pen.note(String(100 + Math.round(random() * 60)), peak, -0.85, 0.09);
        },
        potential(pen, random) {
            pen.line([[-0.95, 0.6], [0.95, 0.6]]); pen.line([[0, 0.95], [0, -0.95]]);
            const curve = [];
            for (let i = 0; i <= 60; i += 1) {
                const x = -0.9 + i / 60 * 1.8;
                const p = x / 0.6;
                curve.push([x, 0.25 + (p ** 4 - 2 * p * p) * 0.32]);
            }
            pen.line(curve);
            pen.dot(0.6, 0.25 - 0.32, 0.05);
            pen.note('V(φ)', 0.1, -0.9, 0.1, 'left'); pen.note('φ', 0.95, 0.72, 0.1);
            if (random() < 0.6) pen.arrow([0.05, -0.2], [0.5, 0.0], 0.06);
        },
        running(pen, random) {
            pen.line([[-0.9, -0.85], [-0.9, 0.75], [0.95, 0.75]]);
            const band = (shift) => Array.from({ length: 40 }, (_, i) => {
                const x = -0.85 + i / 39 * 1.75;
                return [x, -0.7 + 1.25 * (1 - 1 / (1 + (x + 0.95) * 1.6)) + shift];
            });
            pen.line(band(-0.05)); pen.line(band(0.05));
            for (let i = 0; i < 6; i += 1) {
                const x = -0.7 + i * 0.3;
                const y = -0.7 + 1.25 * (1 - 1 / (1 + (x + 0.95) * 1.6)) + (random() - 0.5) * 0.06;
                pen.dot(x, y, 0.025);
            }
            pen.note('αₛ(Q)', -0.75, -0.92, 0.1, 'left'); pen.note('Q', 0.95, 0.9, 0.1);
        },
        cherenkov(pen, random) {
            const apex = [0.85, 0];
            pen.line([[-0.95, 0], apex]);
            pen.line([apex, [-0.55, -0.7]]); pen.line([apex, [-0.55, 0.7]]);
            pen.ellipse(-0.55, 0, 0.14, 0.7);
            pen.note('θc', 0.42, -0.18, 0.1);
            pen.note('cos θ = 1/nβ', -0.2, 0.9, 0.09);
        },
        collider(pen, random) {
            pen.circle(0, 0, 0.82);
            pen.circle(-0.45, 0.42, 0.24);
            pen.line([[-0.45, 0.66], [-0.45, 0.98]]);
            const dots = [];
            for (let i = 0; i < 4; i += 1) dots.push(random() * TAU);
            dots.forEach((a) => pen.dot(Math.cos(a) * 0.82, Math.sin(a) * 0.82, 0.04));
            pen.note(pick(random, ['ATLAS', 'CMS', 'ALICE', 'LHCb']), 0.6, 0.72, 0.09, 'left');
            pen.note('√s = 13.6 TeV', 0, 0, 0.1);
        },
        // 气泡室照片：一束入射线打到顶点，一对正负电子在磁场里朝两边卷成螺旋，几条直的径迹，一串越来越密的气泡
        bubble(pen, random) {
            const vx = (random() - 0.5) * 0.3, vy = -(random() * 0.3 - 0.25);
            pen.line([[-1.05, vy + 0.25], [vx, vy]]);
            pen.dot(vx, vy, 0.03);
            const spiral = (r0, turn, sign) => {
                const pts = [];
                for (let i = 0; i <= 90; i += 1) {
                    const a = i / 90 * TAU * 2.2;
                    const r = r0 * Math.exp(-a * turn);
                    pts.push([vx + sign * (Math.sin(a) * r), vy - sign * (r0 - Math.cos(a) * r) * 0.9]);
                }
                pen.line(pts);
            };
            spiral(0.3 + random() * 0.12, 0.07, -1);
            spiral(0.36 + random() * 0.14, 0.085, 1);
            for (let n = 2 + Math.floor(random() * 2); n > 0; n -= 1) {
                const a = (random() - 0.5);
                pen.line([[vx, vy], [vx + Math.cos(a) * 1.05, vy - Math.sin(a) * 1.05]]);
            }
            for (let i = 0; i < 7; i += 1) pen.dot(-0.95 + i * (0.2 - i * 0.012), -0.75 - i * 0.03, 0.02);
            [[-0.85, 0.85], [0.85, -0.8]].forEach(([cx, cy]) => pen.segments([[[cx - 0.1, cy], [cx + 0.1, cy]], [[cx, cy - 0.1], [cx, cy + 0.1]]]));
            pen.note('γ → e⁺e⁻', vx - 0.5, vy + 0.62, 0.1);
            pen.note(pick(random, ['B = 2 T', 'p = 0.3 B r', 'Λ → p π⁻']), 0.3, 0.98, 0.09);
        },
        // 企鹅图：一条夸克线上开一个圈，圈底下甩出一根胶子，再分成一对夸克
        penguin(pen, random) {
            pen.arrow([-1.05, -0.15], [-0.45, -0.15]);
            pen.line([[-0.45, -0.15], [0.45, -0.15]]);
            pen.arrow([0.45, -0.15], [1.05, -0.15]);
            pen.circle(0, -0.15, 0.45, Math.PI, TAU);
            [[-0.45, -0.15], [0.45, -0.15], [0, -0.15]].forEach(([x, y]) => pen.dot(x, y, 0.035));
            pen.wave([0, -0.15], [0, 0.5], 9, 0.05);
            pen.dot(0, 0.5, 0.035);
            pen.arrow([0, 0.5], [0.75, 0.3]);
            pen.arrow([0.75, 0.8], [0, 0.5]);
            pen.note('b', -1.05, -0.33, 0.12); pen.note('s', 1.05, -0.33, 0.12); pen.note('W', 0, -0.76, 0.12);
            pen.note(pick(random, ['t', 'u, c, t']), -0.22, -0.02, 0.1);
            pen.note('g', 0.18, 0.2, 0.11);
            pen.note(pick(random, ['b → s g', 'Vtb V*ts', 'O(GF αs)']), -1, 0.95, 0.09, 'left');
        },
        // 箱图：上下两条夸克线，中间两根 W 波浪线连成一个方框
        box(pen, random) {
            const [meson, upper, lower] = pick(random, [['K⁰', 's', 'd'], ['B⁰', 'b', 'd'], ['D⁰', 'c', 'u']]);
            pen.arrow([-1.05, -0.38], [-0.42, -0.38]); pen.arrow([-0.42, -0.38], [0.42, -0.38]); pen.arrow([0.42, -0.38], [1.05, -0.38]);
            pen.arrow([1.05, 0.38], [0.42, 0.38]); pen.arrow([0.42, 0.38], [-0.42, 0.38]); pen.arrow([-0.42, 0.38], [-1.05, 0.38]);
            pen.wave([-0.42, -0.38], [-0.42, 0.38], 7, 0.05);
            pen.wave([0.42, -0.38], [0.42, 0.38], 7, 0.05);
            [-0.42, 0.42].forEach((x) => { pen.dot(x, -0.38, 0.035); pen.dot(x, 0.38, 0.035); });
            pen.note(upper, -0.75, -0.56, 0.11); pen.note(lower, -0.75, 0.58, 0.11);
            pen.note(lower, 0.75, -0.56, 0.11); pen.note(upper, 0.75, 0.58, 0.11);
            pen.note('u, c, t', 0, -0.56, 0.09); pen.note('W', -0.62, 0, 0.11); pen.note('W', 0.62, 0, 0.11);
            pen.note(meson, -1.25, 0, 0.12);
            pen.note(pick(random, ['Δm', 'ΔF = 2', 'ε ≈ 2.2×10⁻³']), -0.3, 1, 0.1);
        },
        // 配线图（歌词里有车、站、轨道时优先用）：上下行两股道、一组渡线道岔、一座站台、公里标和信号机
        rail(pen, random) {
            const y1 = -0.16, y2 = 0.16;
            pen.line([[-1.05, y1], [1.05, y1]]);
            pen.line([[-1.05, y2], [1.05, y2]]);
            const sx = -0.55 + random() * 0.3;
            pen.line([[sx, y2], [sx + 0.42, y1]]);
            pen.line([[sx + 0.5, y1], [sx + 0.92, y2]]);
            const px = 0.15 + random() * 0.3;
            pen.line([[px, y1 - 0.12], [px + 0.62, y1 - 0.12], [px + 0.62, y1 - 0.34], [px, y1 - 0.34]], true);
            for (let i = 0; i < 3; i += 1) pen.line([[px + 0.1 + i * 0.2, y1 - 0.34], [px + 0.2 + i * 0.2, y1 - 0.12]]);
            const k = 10 + Math.floor(random() * 30);
            [-0.9, -0.3, 0.3, 0.9].forEach((x, i) => {
                pen.line([[x, y2 + 0.04], [x, y2 + 0.14]]);
                pen.note(`K${k + i}+${pick(random, ['000', '200', '400', '600', '800'])}`, x, y2 + 0.24, 0.07);
            });
            const gx = sx - 0.25;
            pen.line([[gx, y2], [gx, y2 + 0.36]]);
            pen.circle(gx + 0.07, y2 + 0.36, 0.06);
            pen.note(pick(random, ['上行', '下行', 'Up', 'Down']), -1.0, y1 - 0.1, 0.08, 'left');
            pen.note(pick(random, ['第 1 站台', '1 番線', 'Pl. 2']), px + 0.31, y1 - 0.47, 0.08);
            pen.note(pick(random, ['R = 400 m', 'i = 2.5‰', 'v ≤ 45 km/h']), 0.4, 0.75, 0.09);
        },
        // 潮汐曲线（歌词里有海、浪、潮时优先用）：两个半日潮，高低潮标时刻和潮高，平均海面虚线，角上一个月相
        tide(pen, random) {
            pen.line([[-1, 0.62], [1, 0.62]]);
            pen.line([[-1, 0.62], [-1, -0.7]]);
            const phase = random() * TAU, amp = 0.38 + random() * 0.1;
            const at = x => -Math.sin((x + 1) * Math.PI * 2 + phase) * amp;
            const pts = [];
            for (let i = 0; i <= 80; i += 1) { const x = -1 + i / 40; pts.push([x, at(x)]); }
            pen.line(pts);
            pen.dashed([-1, 0], [1, 0], 0.05);
            pen.note('MSL', 1.02, -0.06, 0.07, 'left');
            for (let i = 0; i < 4; i += 1) {
                const x = -1 + ((i / 2 + 0.25 - phase / TAU) % 1 + 1) % 1 * 2;
                const high = Math.sin((x + 1) * Math.PI * 2 + phase) < 0;
                const y = at(x);
                pen.dot(x, y, 0.025);
                const h = (high ? 1.6 + random() * 0.8 : 0.2 + random() * 0.4).toFixed(1);
                const hh = String(Math.floor(random() * 24)).padStart(2, '0'), mm = String(Math.floor(random() * 60)).padStart(2, '0');
                pen.note(`${high ? 'HW' : 'LW'} ${hh}:${mm}  ${h} m`, x, y + (high ? -0.12 : 0.12), 0.065);
            }
            [-1, -0.5, 0, 0.5, 1].forEach((x, i) => { pen.line([[x, 0.62], [x, 0.68]]); pen.note(`${i * 6}h`, x, 0.76, 0.06); });
            pen.circle(0.82, -0.78, 0.09);
            pen.ellipse(0.82, -0.78, 0.045, 0.09, 0, -Math.PI / 2, Math.PI / 2);
        }
    };

    const KINDS = Object.freeze(Object.keys(DRAW));

    // 画一张图：kind、世界中心、半径、旋转。返回画完后的下一个笔序。
    const drawFigure = (pen, kind, x, y, r, rot, random) => {
        pen.place(x, y, r, rot);
        (DRAW[kind] || DRAW.orbit)(pen, random);
        return pen.order;
    };

    global.MusicStageInkFigures = Object.freeze({ createPen, drawFigure, KINDS, NOTE_FONT });
})(window);
