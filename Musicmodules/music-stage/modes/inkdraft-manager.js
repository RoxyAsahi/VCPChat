/*
 * 墨痕（inkdraft）：概念化的实验歌词动画。歌词是墨——字形、字周围的晕和墨团画进同一张场里，
 * 切阈值显影，所以字和墨团挨近了会连起来；纸面有半调网点和砂纸颗粒，字外面一笔一笔冒出演算纸
 * 上的线稿（轨道、晶格、粒子图、演算草稿……）。画面靠剪辑动：一句歌词编成几个镜头，切点卡在词
 * 开唱上（全景、特写、跟字、微距、倾斜、留白远景、拉远、冲镜），镜头永远正对纸面，镜头里只极慢
 * 地蠕动。墨团不往下滴，像对撞实验那样撞开，碎片沿螺旋甩出去。
 *
 * 画面只由播放时间决定（不积分），拖进度、暂停都对。每段（一句歌词或一段间奏）准备一次：
 * 两张 2D 画布（主图：R 字形、G 线稿、B 半调层；编号图：R 字的编号、G 线稿笔序）传成纹理，
 * 之后每帧只画一个全屏三角形。
 *
 * 负载：默认每秒 30 帧（节能 24、极致 60），绘制缓冲按像素预算，暂停且输入不变时不画。
 */
(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    const Figures = global.MusicStageInkFigures;
    if (!Utils || !Runtime || !Figures) throw new Error('MusicStageModeUtils, MusicStageRuntime and MusicStageInkFigures must load before inkdraft-manager.js');

    const { clamp, seededRandom, splitGraphemes, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText } = Runtime;

    const ID_SCALE = 0.5;
    const MAX_BLOBS = 24;
    const MAX_ACCENT = 3;
    const MAX_GLYPHS = 255;
    const TAU = Math.PI * 2;
    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const RATIO = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    const REST_PART = 20;
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    const wordSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
        ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

    const smooth = (a, b, x) => {
        const t = clamp((x - a) / (b - a), 0, 1);
        return t * t * (3 - 2 * t);
    };
    const hexRgb = (hex, fallback) => {
        const value = String(hex || '').trim();
        const match = /^#?([0-9a-f]{6})$/i.exec(value);
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const pickWeighted = (random, entries) => {
        const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
        let roll = random() * total;
        for (const [value, weight] of entries) {
            roll -= weight;
            if (roll <= 0) return value;
        }
        return entries[entries.length - 1][0];
    };
    const formatTime = (seconds) => {
        const s = Math.max(0, seconds || 0);
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
    };

    /* ───────────────────────── 段落（cue） ───────────────────────── */

    // 一首歌编成首尾相接的段：每句歌词一段；句间超过 4 秒的空当、前奏、尾奏是间奏段，
    // 长间奏切成二十来秒一段。没有歌词的整首都是间奏段，曲名在第一段上。
    const buildCues = (lines, duration) => {
        const cues = [];
        const pushRest = (start, end, title = false) => {
            if (!(end > start + 0.05)) return;
            const length = end - start;
            const parts = length > 36 ? Math.max(2, Math.round(length / REST_PART)) : 1;
            for (let i = 0; i < parts; i += 1) {
                cues.push({ kind: 'rest', start: start + length * i / parts, end: start + length * (i + 1) / parts, title: title && i === 0 });
            }
        };
        const sung = lines.filter(line => readableText(line.fullText));
        const tail = Math.max(Number(duration) || 0, 0);
        if (!sung.length) {
            pushRest(0, Math.max(tail, 720), true);
            return cues;
        }
        if (sung[0].startTime > 3) pushRest(0, sung[0].startTime, true);
        sung.forEach((line, i) => {
            const next = sung[i + 1];
            const lineEnd = Math.max(line.endTime, line.vocalEndTime || 0);
            const nextStart = next ? next.startTime : Infinity;
            const start = line.startTime;
            if (nextStart - lineEnd > 4) {
                cues.push({ kind: 'line', start, end: lineEnd + 1.2, line, number: i + 1 });
                if (next) pushRest(lineEnd + 1.2, nextStart, false);
                else pushRest(lineEnd + 1.2, Math.max(tail, lineEnd + 1.2 + REST_PART), false);
            } else {
                cues.push({ kind: 'line', start, end: nextStart, line, number: i + 1 });
            }
        });
        if (cues.length && cues[0].start > 0) cues[0].start = 0;
        return cues;
    };
    const findCue = (cues, time) => {
        let low = 0, high = cues.length - 1, result = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (time >= cues[mid].start) { result = mid; low = mid + 1; } else high = mid - 1;
        }
        return result;
    };

    /* ───────────────────────── 排版 ───────────────────────── */

    // 一句歌词的字（带演唱时刻），按词切成单元（空格是分隔，标点粘在前一个词后面）。
    const glyphUnits = (cue, title) => {
        let glyphs;
        if (cue.kind === 'line') {
            glyphs = buildGlyphTimeline(cue.line).map(g => ({ text: g.text, start: g.startTime, end: g.endTime }));
        } else if (cue.title && title) {
            glyphs = splitGraphemes(title).map((text, i) => ({ text, start: cue.start + 0.4 + i * 0.06, end: cue.start + 0.7 + i * 0.06 }));
        } else glyphs = [];
        const text = glyphs.map(g => g.text).join('');
        const breaks = new Set();
        const wordLike = new Map();
        if (wordSegmenter && text) {
            for (const seg of wordSegmenter.segment(text)) {
                breaks.add(seg.index);
                wordLike.set(seg.index, seg.isWordLike !== false);
            }
        }
        const units = [];
        let offset = 0;
        let current = null;
        glyphs.forEach((g) => {
            const space = !g.text.trim();
            if (space) { current = null; offset += g.text.length; return; }
            // 标点（不像词的段）粘在前一个词后面
            if (!current || (breaks.has(offset) && wordLike.get(offset) !== false)) {
                current = { glyphs: [], start: g.start, end: g.end };
                units.push(current);
            }
            current.glyphs.push(g);
            current.end = Math.max(current.end, g.end);
            offset += g.text.length;
        });
        return units;
    };

    // 量一个单元在 100px 字号下的宽度。
    const measureUnits = (ctx, units, fontFor) => {
        units.forEach((unit) => {
            unit.cjk = unit.glyphs.some(g => CJK.test(g.text));
            ctx.font = fontFor(100, unit.cjk);
            unit.glyphs.forEach((g) => { g.w100 = ctx.measureText(g.text).width; });
            unit.w100 = unit.glyphs.reduce((sum, g) => sum + g.w100, 0);
        });
    };

    // 把单元排进若干行，每行字数尽量均匀。
    const splitRows = (units, rows) => {
        const total = units.reduce((sum, u) => sum + u.glyphs.length, 0);
        const result = [];
        let row = [];
        let count = 0;
        units.forEach((unit, i) => {
            const target = total * (result.length + 1) / rows;
            row.push(unit);
            count += unit.glyphs.length;
            const remainingRows = rows - result.length - 1;
            const remainingUnits = units.length - i - 1;
            if (remainingRows > 0 && count >= target - unit.glyphs.length / 2 && remainingUnits >= remainingRows) {
                result.push(row); row = [];
            }
        });
        if (row.length) result.push(row);
        return result;
    };

    // 构图：齐行（每行放大到一样宽，海报排法）、阶梯、主词、竖排、散置。返回字在世界坐标里的位置。
    const composeText = (units, W, H, random, fontScale, cjkShare) => {
        const n = units.reduce((sum, u) => sum + u.glyphs.length, 0);
        if (!n) return { style: 'none', placed: [] };
        const longest = units.reduce((best, u) => (u.glyphs.length > best.glyphs.length ? u : best), units[0]);
        const choices = [['rows', 0.34], ['stair', 0.2]];
        if (units.length >= 2 && longest.glyphs.length >= 2) choices.push(['hero', 0.2]);
        if (cjkShare > 0.6 && n <= 16 && n >= 3) choices.push(['column', 0.16]);
        if (units.length >= 3) choices.push(['scatter', 0.1]);
        const style = pickWeighted(random, choices);
        const lineH = (cjk) => (cjk ? 1.14 : 1.06);
        const placed = [];
        const place = (unit, x, baseline, size) => {
            let cursor = x;
            unit.glyphs.forEach((g) => {
                const w = g.w100 * size / 100;
                placed.push({ g, unit, x: cursor, baseline, size, w });
                cursor += w;
            });
            return cursor;
        };
        const gap = 0.28;
        const rowWidth100 = row => row.reduce((sum, u) => sum + u.w100, 0) + Math.max(0, row.length - 1) * (row.some(u => !u.cjk) ? gap * 100 : 0.12 * 100);
        const maxSize = H * 0.3 * fontScale;
        const minSize = H * 0.05;

        if (style === 'column') {
            const glyphs = units.flatMap(u => u.glyphs.map(g => ({ g, unit: u })));
            const cols = Math.max(1, Math.ceil(n / (n > 10 ? 6 : 5)));
            const perCol = Math.ceil(n / cols);
            const size = clamp(Math.min(H * 0.6 / perCol, W * 0.5 / cols / 1.25) * fontScale, minSize, maxSize);
            glyphs.forEach(({ g, unit }, i) => {
                const col = Math.floor(i / perCol);
                const row = i % perCol;
                const x = (cols - 1 - col) * size * 1.3 + (size - g.w100 * size / 100) / 2;
                placed.push({ g, unit, x, baseline: (row + 0.88) * size * 1.08, size, w: g.w100 * size / 100 });
            });
            return { style, placed };
        }
        if (style === 'hero') {
            const heroIndex = units.indexOf(longest);
            const heroSize = clamp(W * 0.52 / longest.w100 * 100 * fontScale, minSize, H * 0.34 * fontScale);
            const small = clamp(heroSize * 0.3, minSize * 0.7, heroSize * 0.5);
            let baseline = 0;
            const before = units.slice(0, heroIndex);
            const after = units.slice(heroIndex + 1);
            if (before.length) {
                splitRows(before, Math.max(1, Math.ceil(before.reduce((s, u) => s + u.glyphs.length, 0) / 14))).forEach((row) => {
                    baseline += small * lineH(row[0].cjk);
                    let x = 0;
                    row.forEach((u) => { x = place(u, x, baseline, small) + small * (u.cjk ? 0.12 : gap); });
                });
                baseline += small * 0.3;
            }
            baseline += heroSize * 0.92;
            place(longest, 0, baseline, heroSize);
            baseline += heroSize * 0.12;
            if (after.length) {
                splitRows(after, Math.max(1, Math.ceil(after.reduce((s, u) => s + u.glyphs.length, 0) / 14))).forEach((row) => {
                    baseline += small * lineH(row[0].cjk);
                    let x = heroSize * 0.04;
                    row.forEach((u) => { x = place(u, x, baseline, small) + small * (u.cjk ? 0.12 : gap); });
                });
            }
            return { style, placed };
        }
        const target = cjkShare > 0.5 ? (n <= 6 ? n : 5 + random() * 2) : (n <= 12 ? n : 11 + random() * 5);
        const rowsCount = clamp(Math.round(n / target), 1, 4);
        const rows = splitRows(units, rowsCount);
        const widthTarget = W * (0.5 + random() * 0.12);
        const sizes = rows.map(row => clamp(widthTarget / rowWidth100(row) * 100 * fontScale, minSize, maxSize));
        if (style === 'stair' || style === 'scatter') {
            const common = Math.min(...sizes) * (style === 'scatter' ? 1 : 0.96);
            let baseline = 0;
            const step = rows.length > 1 ? Math.max(common * 0.8, (widthTarget - Math.max(...rows.map(r => rowWidth100(r) * common / 100))) / (rows.length - 1)) : 0;
            rows.forEach((row, r) => {
                const size = style === 'scatter' ? common * (0.7 + random() * 0.6) : common;
                baseline += size * lineH(row[0].cjk);
                let x = style === 'scatter' ? random() * widthTarget * 0.35 : r * step;
                row.forEach((u) => { x = place(u, x, baseline, size) + size * (u.cjk ? 0.12 : gap); });
            });
            return { style, placed };
        }
        let baseline = 0;
        rows.forEach((row, r) => {
            const size = sizes[r];
            baseline += size * (r ? lineH(row[0].cjk) : 0.9);
            const width = rowWidth100(row) * size / 100;
            let x = (widthTarget - width) / 2;
            row.forEach((u) => { x = place(u, x, baseline, size) + size * (u.cjk ? 0.12 : gap); });
            baseline += size * 0.08;
        });
        return { style: 'rows', placed };
    };

    /* ───────────────────────── 一段的准备 ───────────────────────── */

    const rectsOverlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    const unionBox = (boxes) => boxes.reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])],
        [Infinity, Infinity, -Infinity, -Infinity]);

    const prepareCue = (cue, index, ctx) => {
        const { W, H, aspect, family, settings, trackKey, title, mainCanvas, idsCanvas } = ctx;
        const random = seededRandom(`inkdraft:${trackKey}:${index}:${cue.kind}:${cue.start.toFixed(2)}`);
        const fontFor = (size, cjk) => `${cjk ? 400 : 300} ${size.toFixed(1)}px ${family}`;
        const main = mainCanvas.getContext('2d', { alpha: false });
        const ids = idsCanvas.getContext('2d', { alpha: false });
        main.globalCompositeOperation = 'source-over';
        ids.globalCompositeOperation = 'source-over';
        main.fillStyle = '#000'; main.fillRect(0, 0, W, H);
        ids.fillStyle = '#000'; ids.fillRect(0, 0, idsCanvas.width, idsCanvas.height);

        // 字
        const units = glyphUnits(cue, title);
        measureUnits(main, units, fontFor);
        const total = units.reduce((s, u) => s + u.glyphs.length, 0);
        const cjkShare = total ? units.reduce((s, u) => s + u.glyphs.filter(g => CJK.test(g.text)).length, 0) / total : 0;
        const composed = composeText(units, W, H, random, settings.fontScale, cjkShare);
        let placed = composed.placed;
        let textBox = null;
        if (placed.length) {
            const raw = unionBox(placed.map(p => [p.x, p.baseline - p.size * 0.88, p.x + p.w, p.baseline + p.size * 0.2]));
            const bw = raw[2] - raw[0], bh = raw[3] - raw[1];
            const fit = Math.min(1, (W * 0.66) / bw, (H * 0.6) / bh);
            const cx = W * (0.5 + (random() - 0.5) * 0.12);
            const cy = H * (0.5 + (random() - 0.5) * 0.1);
            placed = placed.map(p => ({
                ...p,
                x: cx + (p.x - (raw[0] + bw / 2)) * fit,
                baseline: cy + (p.baseline - (raw[1] + bh / 2)) * fit,
                size: p.size * fit,
                w: p.w * fit
            }));
            placed.forEach((p) => { p.box = [p.x, p.baseline - p.size * 0.88, p.x + p.w, p.baseline + p.size * 0.2]; });
            textBox = unionBox(placed.map(p => p.box));
        }
        // 字形进 R 通道，编号（1..255）进编号图的 R 通道；编号框比字大一圈，盖住字周围的晕。
        const glyphData = new Float32Array(256 * 4);
        main.textBaseline = 'alphabetic';
        main.fillStyle = 'rgb(255,0,0)';
        main.globalCompositeOperation = 'lighter';
        placed.forEach((p, i) => {
            const id = Math.min(MAX_GLYPHS, i + 1);
            main.font = fontFor(p.size, CJK.test(p.g.text));
            main.fillText(p.g.text, p.x, p.baseline);
            glyphData[id * 4] = p.g.start;
            glyphData[id * 4 + 1] = p.g.end;
            ids.fillStyle = `rgb(${id},0,0)`;
            const pad = p.size * 0.2;
            ids.fillRect(Math.floor((p.box[0] - pad) * ID_SCALE), Math.floor((p.box[1] - pad) * ID_SCALE),
                Math.ceil((p.box[2] - p.box[0] + pad * 2) * ID_SCALE), Math.ceil((p.box[3] - p.box[1] + pad * 2) * ID_SCALE));
        });
        main.globalCompositeOperation = 'source-over';

        // 单元的框（镜头、强调色墨团用）
        const unitBoxes = units.map((unit) => {
            const boxes = placed.filter(p => p.unit === unit).map(p => p.box);
            return boxes.length ? { unit, box: unionBox(boxes), size: Math.max(...placed.filter(p => p.unit === unit).map(p => p.size)) } : null;
        }).filter(Boolean);

        // 全景：把字框进画面，字周围留白。
        const wideH = textBox
            ? clamp(Math.max((textBox[3] - textBox[1]) / 0.6, (textBox[2] - textBox[0]) / aspect / 0.74), H * 0.45, H)
            : H * 0.92;
        const wideC = textBox ? [(textBox[0] + textBox[2]) / 2, (textBox[1] + textBox[3]) / 2] : [W / 2, H / 2];
        const wideRect = [wideC[0] - wideH * aspect / 2, wideC[1] - wideH / 2, wideC[0] + wideH * aspect / 2, wideC[1] + wideH / 2];

        // 空着的大格：线稿和墨团摆在这里。
        const cols = aspect > 1.4 ? 4 : 3;
        const rowsN = aspect > 1.4 ? 3 : 4;
        const region = cue.kind === 'rest' ? [W * 0.06, H * 0.06, W * 0.94, H * 0.94] : wideRect;
        const cw = (region[2] - region[0]) / cols, ch = (region[3] - region[1]) / rowsN;
        const inflated = textBox ? [textBox[0] - H * 0.03, textBox[1] - H * 0.03, textBox[2] + H * 0.03, textBox[3] + H * 0.03] : null;
        const cells = [];
        for (let r = 0; r < rowsN; r += 1) for (let c = 0; c < cols; c += 1) {
            const rect = [region[0] + c * cw, region[1] + r * ch, region[0] + (c + 1) * cw, region[1] + (r + 1) * ch];
            if (rect[0] < 0 || rect[1] < 0 || rect[2] > W || rect[3] > H) continue;
            if (inflated && rectsOverlap(rect, inflated)) continue;
            cells.push(rect);
        }
        for (let i = cells.length - 1; i > 0; i -= 1) {
            const j = Math.floor(random() * (i + 1));
            [cells[i], cells[j]] = [cells[j], cells[i]];
        }

        // 半调层：背景纹样 + 垫在字后面的一张大图（粗线，只进网点）。
        const backdrop = pickWeighted(random, [['band', 0.3], ['graph', 0.25], ['arcs', 0.25], ['none', 0.2]]);
        main.globalCompositeOperation = 'lighter';
        if (backdrop === 'band') {
            const y = (textBox ? (textBox[1] + textBox[3]) / 2 : H / 2) + (random() - 0.5) * H * 0.2;
            const g = main.createLinearGradient(0, y - H * 0.18, 0, y + H * 0.18);
            g.addColorStop(0, 'rgb(0,0,0)'); g.addColorStop(0.5, 'rgb(0,0,46)'); g.addColorStop(1, 'rgb(0,0,0)');
            main.fillStyle = g; main.fillRect(0, y - H * 0.18, W, H * 0.36);
        } else if (backdrop === 'graph') {
            main.strokeStyle = 'rgb(0,0,40)';
            main.lineWidth = Math.max(1, H * 0.0015);
            const step = H / 18;
            main.beginPath();
            for (let x = (W % step) / 2; x < W; x += step) { main.moveTo(x, 0); main.lineTo(x, H); }
            for (let y = (H % step) / 2; y < H; y += step) { main.moveTo(0, y); main.lineTo(W, y); }
            main.stroke();
        } else if (backdrop === 'arcs') {
            main.strokeStyle = 'rgb(0,0,54)';
            main.lineWidth = H * 0.006;
            const ox = random() < 0.5 ? 0 : W, oy = random() < 0.5 ? 0 : H;
            main.beginPath();
            for (let r = H * 0.2; r < W * 1.2; r += H * 0.07) { main.moveTo(ox + r, oy); main.arc(ox, oy, r, 0, TAU); }
            main.stroke();
        }
        main.globalCompositeOperation = 'source-over';
        if (settings.figures) {
            const tonePen = Figures.createPen(main, null, ID_SCALE, { tone: true, lineWidth: H * 0.011, toneLevel: 0.34 });
            Figures.drawFigure(tonePen, Figures.KINDS[Math.floor(random() * Figures.KINDS.length)],
                wideC[0], wideC[1], H * (0.36 + random() * 0.1), (random() - 0.5) * 0.4, random);
        }

        // 版面零件（规线、裁切标记、行号、时间码）和线稿，一笔一笔冒出来。
        const pen = Figures.createPen(main, ids, ID_SCALE, { lineWidth: Math.max(1.2, H * 0.0021), startOrder: 1 });
        if (textBox) {
            const pad = H * 0.035;
            const [x0, y0, x1, y1] = [textBox[0] - pad, textBox[1] - pad, textBox[2] + pad, textBox[3] + pad];
            pen.place(0, 0, 1, 0);
            const mark = H * 0.022;
            pen.segments([[[x0 - mark, y0], [x0 - mark * 0.3, y0]], [[x0, y0 - mark], [x0, y0 - mark * 0.3]],
                [[x1 + mark * 0.3, y1], [x1 + mark, y1]], [[x1, y1 + mark * 0.3], [x1, y1 + mark]]]);
            if (random() < 0.7) pen.line([[x0, y1 + pad * 0.6], [x0 + (x1 - x0) * (0.4 + random() * 0.6), y1 + pad * 0.6]]);
            pen.place(x0, y0 - H * 0.03, H, 0);
            pen.note(cue.kind === 'line' ? `L.${String(cue.number).padStart(2, '0')}` : 'INTERLUDE', 0, 0, 0.018, 'left');
            pen.place(x1, y1 + H * 0.045, H, 0);
            pen.note(formatTime(cue.start), 0, 0, 0.016, 'right');
        }
        const figures = [];
        if (settings.figures) {
            const want = cue.kind === 'rest' ? 4 + Math.floor(random() * 3) : Math.min(4, Math.max(1, Math.round(cells.length * (0.35 + random() * 0.2))));
            cells.slice(0, want).forEach((rect) => {
                const r = Math.min(rect[2] - rect[0], rect[3] - rect[1]) * (0.3 + random() * 0.08) * settings.figureScale;
                const kind = Figures.KINDS[Math.floor(random() * Figures.KINDS.length)];
                const fx = (rect[0] + rect[2]) / 2 + (random() - 0.5) * (rect[2] - rect[0]) * 0.15;
                const fy = (rect[1] + rect[3]) / 2 + (random() - 0.5) * (rect[3] - rect[1]) * 0.15;
                Figures.drawFigure(pen, kind, fx, fy, r, (random() - 0.5) * 0.35, random);
                figures.push({ x: fx, y: fy, r });
            });
        }
        const strokes = Math.max(1, pen.order - 1);
        const length = cue.end - cue.start;
        const strokeStep = clamp(length * 0.6 / strokes, 0.04, 0.2);

        // 墨团：一个大墨团带几颗小墨滴，摆在空格里（线稿没占的那些）；对撞；压在词上的强调色墨团。
        const freeCells = cells.slice(figures.length);
        const massCell = freeCells[0] || cells[0];
        const mass = massCell ? {
            x: (massCell[0] + massCell[2]) / 2, y: (massCell[1] + massCell[3]) / 2,
            r: Math.min(massCell[2] - massCell[0], massCell[3] - massCell[1]) * (0.12 + random() * 0.05),
            sats: Array.from({ length: 3 + Math.floor(random() * 2) }, () => ({
                orbit: 1.6 + random() * 0.9, speed: (0.12 + random() * 0.22) * (random() < 0.5 ? -1 : 1),
                phase: random() * TAU, size: 0.16 + random() * 0.16
            }))
        } : null;
        const collisions = [];
        if (settings.collisions) {
            const spots = freeCells.slice(1).concat(cells);
            const times = [];
            if (cue.kind === 'line') {
                const candidates = unitBoxes.map(u => u.unit.start).filter(t => t > cue.start + 1 && t < cue.end - 1.2);
                if (candidates.length) times.push(candidates[Math.floor(random() * candidates.length)]);
                if (length > 9 && candidates.length > 3) times.push(candidates[candidates.length - 1]);
            } else {
                for (let t = cue.start + 2 + random() * 2; t < cue.end - 1.5; t += 4 + random() * 3) times.push(t);
            }
            times.forEach((t, i) => {
                const spot = spots[i % Math.max(1, spots.length)];
                if (!spot) return;
                const size = Math.min(spot[2] - spot[0], spot[3] - spot[1]);
                collisions.push({
                    t, x: (spot[0] + spot[2]) / 2, y: (spot[1] + spot[3]) / 2,
                    angle: random() * TAU, dist: size * 0.42, r: size * 0.07, spin: random() < 0.5 ? -1.7 : 1.7,
                    fragments: 6 + Math.floor(random() * 3)
                });
            });
        }
        const accents = [];
        unitBoxes.forEach((u) => {
            if (accents.length >= 3 || u.unit.end - u.unit.start < 0.45 || random() > 0.36) return;
            const w = u.box[2] - u.box[0], h = u.box[3] - u.box[1];
            accents.push({ start: u.unit.start, end: u.unit.end, x: (u.box[0] + u.box[2]) / 2 + (random() - 0.5) * w * 0.2,
                y: (u.box[1] + u.box[3]) / 2 + (random() - 0.5) * h * 0.15, r: Math.max(w, h) * 0.42 });
        });

        // 镜头的取景表
        const shots = planShots(cue, { placed, unitBoxes, wideH, wideC, textBox, figures, W, H, aspect }, random, settings);
        return {
            index, cue, glyphData, shots, mass, collisions, accents,
            strokeStart: cue.start + 0.12, strokeStep,
            transition: index > 0 && random() < 0.42 ? 'ink' : 'cut',
            style: composed.style, backdrop
        };
    };

    /* ───────────────────────── 分镜 ───────────────────────── */

    // 跟字的取景：从一个字开始，把后面装得下的字一起框进来；正在唱的字跑出这一框就硬切到下一框。
    const buildFrames = (placed, viewH, aspect) => {
        const frames = [];
        const viewW = viewH * aspect;
        let current = null;
        placed.forEach((p) => {
            if (current) {
                const u = unionBox([current.box, p.box]);
                if (u[2] - u[0] <= viewW * 0.84 && u[3] - u[1] <= viewH * 0.8) { current.box = u; return; }
            }
            current = { start: p.g.start, box: p.box.slice() };
            frames.push(current);
        });
        frames.forEach((f) => { f.c = [(f.box[0] + f.box[2]) / 2, (f.box[1] + f.box[3]) / 2]; });
        return frames;
    };
    const frameAt = (frames, t) => {
        let pick = frames[0];
        for (const f of frames) { if (f.start <= t) pick = f; else break; }
        return pick;
    };

    const planShots = (cue, scene, random, settings) => {
        const { placed, unitBoxes, wideH, wideC, figures, W, H, aspect } = scene;
        const maxSize = placed.length ? Math.max(...placed.map(p => p.size)) : H * 0.1;
        const closeH = clamp(maxSize * 2.5, H * 0.16, wideH * 0.72);
        const close = buildFrames(placed, closeH, aspect);
        const macro = unitBoxes.map((u) => {
            const w = u.box[2] - u.box[0], h = u.box[3] - u.box[1];
            return { start: u.unit.start, c: [(u.box[0] + u.box[2]) / 2, (u.box[1] + u.box[3]) / 2], h: clamp(Math.max(h * 1.8, w / aspect * 1.25), H * 0.08, closeH * 0.85) };
        });
        const starts = unitBoxes.map(u => u.unit.start).sort((a, b) => a - b);
        const shots = [];
        const length = cue.end - cue.start;
        const cuts = settings.cameraCuts && !settings.reducedMotion;
        if (cue.kind === 'rest') {
            let t = cue.start;
            let k = 0;
            while (t < cue.end - 0.5) {
                const fig = figures.length && cuts && k % 2 === 1 ? figures[Math.floor(random() * figures.length)] : null;
                shots.push({ start: t, type: fig ? 'figure' : (k % 3 === 2 ? 'far' : 'wide'), fig, drift: [random() - 0.5, random() - 0.5], neg: false, roll: 0 });
                t += 4 + random() * 2.5;
                k += 1;
                if (!cuts) break;
            }
        } else {
            let t = cue.start;
            let previous = '';
            while (t < cue.end - 0.3) {
                const first = !shots.length;
                let type;
                if (!cuts || !placed.length) type = 'wide';
                else if (first) type = pickWeighted(random, length > 2.2 ? [['wide', 0.45], ['close', 0.25], ['crash', 0.15], ['far', 0.15]] : [['wide', 0.6], ['close', 0.4]]);
                else {
                    const options = [['wide', 0.22], ['close', 0.24], ['macro', 0.12], ['dutch', 0.12], ['far', 0.08], ['pullback', 0.12], ['crash', 0.06]]
                        .filter(([name]) => name !== previous);
                    type = pickWeighted(random, options);
                }
                const shot = {
                    start: t, type, drift: [random() - 0.5, random() - 0.5],
                    roll: type === 'dutch' ? (random() < 0.5 ? -1 : 1) * (0.09 + random() * 0.07) : 0,
                    neg: settings.negativeShots && !first && random() < 0.14
                };
                shots.push(shot);
                previous = type;
                if (!cuts) break;
                const want = 2 + random() * 1.6;
                const next = starts.find(s => s >= t + want && s < cue.end - 0.6);
                if (!next) break;
                t = next;
            }
        }
        shots.forEach((shot, i) => {
            shot.end = shots[i + 1]?.start ?? cue.end;
            if (shot.type === 'pullback') {
                const inside = starts.filter(s => s >= shot.start && s < shot.end);
                shot.steps = inside.length >= 3 ? inside.slice(0, 3) : [0, 1, 2].map(k => shot.start + (shot.end - shot.start) * k / 3);
            }
        });
        return { shots, closeH, close, macro, wideH, wideC, W, H };
    };

    // 某一刻的机位：中心、取景高度（世界像素）、滚转。
    const viewAt = (plan, t) => {
        const { shots, closeH, close, macro, wideH, wideC, W, H } = plan;
        let shot = shots[0];
        for (const s of shots) { if (s.start <= t) shot = s; else break; }
        if (!shot) return { c: wideC, h: wideH, roll: 0, neg: false, shot: 'wide' };
        let c = wideC, h = wideH;
        const closeFrame = close.length ? frameAt(close, t) : null;
        switch (shot.type) {
            case 'far': c = [wideC[0] * 0.7 + W * 0.15, wideC[1] * 0.7 + H * 0.15]; h = Math.min(wideH * 1.4, H * 1.02); break;
            case 'close': case 'dutch': if (closeFrame) { c = closeFrame.c; h = closeH; } break;
            case 'macro': {
                const m = macro.length ? frameAt(macro, t) : null;
                if (m) { c = m.c; h = m.h; }
                break;
            }
            case 'pullback': {
                const step = shot.steps.filter(s => s <= t).length;
                const k = clamp((step - 1) / 2, 0, 1);
                const from = closeFrame ? closeFrame.c : wideC;
                c = [from[0] + (wideC[0] - from[0]) * k, from[1] + (wideC[1] - from[1]) * k];
                h = closeH + (wideH * 1.08 - closeH) * k;
                break;
            }
            case 'crash': {
                const jumps = Math.min(3, Math.floor((t - shot.start) / 0.16) + 1);
                const k = jumps / 3;
                const to = closeFrame ? closeFrame.c : wideC;
                c = [wideC[0] + (to[0] - wideC[0]) * k, wideC[1] + (to[1] - wideC[1]) * k];
                h = wideH + (closeH - wideH) * k;
                break;
            }
            case 'figure': if (shot.fig) { c = [shot.fig.x, shot.fig.y]; h = shot.fig.r * 3.1; } break;
            default: break;
        }
        // 镜头里只极慢地蠕动：推近 3.5%，挪 2%。
        const u = clamp((t - shot.start) / Math.max(0.5, shot.end - shot.start), 0, 1);
        h *= 1 - 0.035 * u;
        c = [c[0] + shot.drift[0] * h * 0.04 * u, c[1] + shot.drift[1] * h * 0.04 * u];
        return { c, h, roll: shot.roll, neg: shot.neg, shot: shot.type };
    };

    // 某一刻的墨团（世界像素：x, y, 半径, 强度）和冲击环。
    const blobsAt = (cue, t, out, rings, accentsOut, bass) => {
        let n = 0;
        const push = (x, y, r, s = 1) => { if (n < MAX_BLOBS && r > 0.5) { out[n * 4] = x; out[n * 4 + 1] = y; out[n * 4 + 2] = r; out[n * 4 + 3] = s; n += 1; } };
        const local = t - cue.cue.start;
        const appear = smooth(0, 0.8, local);
        if (cue.mass) {
            const m = cue.mass;
            const breath = 1 + 0.05 * Math.sin(local * 0.7) + bass * 0.06;
            push(m.x, m.y, m.r * breath * appear);
            m.sats.forEach((s) => {
                const a = s.phase + local * s.speed;
                push(m.x + Math.cos(a) * m.r * s.orbit, m.y + Math.sin(a) * m.r * s.orbit * 0.8, m.r * s.size * appear);
            });
        }
        rings.fill(0);
        let ringCount = 0;
        cue.collisions.forEach((c) => {
            const tau = t - c.t;
            if (tau < -1.6 || tau > 2.6) return;
            const dx = Math.cos(c.angle), dy = Math.sin(c.angle);
            if (tau < 0) {
                const d = c.dist * (tau / -1.6) ** 2;
                push(c.x - dx * d, c.y - dy * d, c.r);
                push(c.x + dx * d, c.y + dy * d, c.r);
                return;
            }
            if (tau < 0.9) push(c.x, c.y, c.r * 1.5 * (1 - tau / 0.9));
            if (ringCount < 2 && tau < 1.6) {
                rings[ringCount * 4] = c.x; rings[ringCount * 4 + 1] = c.y;
                rings[ringCount * 4 + 2] = c.dist * 1.05 * (1 - Math.exp(-tau * 2.4));
                rings[ringCount * 4 + 3] = c.r * 0.22 * (1 - tau / 1.6);
                ringCount += 1;
            }
            const spread = 1 - Math.exp(-tau * 1.8);
            const fade = 1 - tau / 2.6;
            for (let k = 0; k < c.fragments; k += 1) {
                const a = c.angle + k * TAU / c.fragments + c.spin * spread;
                const rr = c.dist * 1.15 * spread;
                push(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr, c.r * 0.34 * fade);
                const back = 1 - Math.exp(-Math.max(0, tau - 0.2) * 1.8);
                const ab = c.angle + k * TAU / c.fragments + c.spin * back;
                push(c.x + Math.cos(ab) * c.dist * 1.15 * back, c.y + Math.sin(ab) * c.dist * 1.15 * back, c.r * 0.14 * fade);
            }
        });
        let a = 0;
        accentsOut.fill(0);
        cue.accents.forEach((acc) => {
            if (a >= MAX_ACCENT) return;
            const grow = smooth(acc.start - 0.05, acc.start + 0.3, t) * (1 - smooth(acc.end + 0.2, acc.end + 0.8, t));
            if (grow <= 0.001) return;
            accentsOut[a * 4] = acc.x; accentsOut[a * 4 + 1] = acc.y; accentsOut[a * 4 + 2] = acc.r * grow; accentsOut[a * 4 + 3] = 1;
            a += 1;
        });
        return { blobs: n, accents: a };
    };

    /* ───────────────────────── GL ───────────────────────── */

    const VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
    const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uMain;
uniform sampler2D uIds;
uniform sampler2D uGlyph;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform vec2 uWorld;
uniform vec2 uIdSize;
uniform vec4 uView;      // cx, cy, h, roll
uniform vec4 uPrevView;  // cx, cy, h, roll
uniform float uPrevFade; // 0 = 不画上一段
uniform float uAspect;
uniform float uTime;
uniform vec2 uStroke;    // 第一笔的时刻、笔间隔
uniform float uGhost;
uniform float uTone;
uniform vec4 uBlobs[${MAX_BLOBS}];
uniform int uBlobCount;
uniform vec4 uAccent[${MAX_ACCENT}];
uniform int uAccentCount;
uniform vec4 uRings[2];
uniform float uFlow;
uniform float uGrainStep;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform vec3 uAccentCol;
uniform vec3 uDot;
uniform float uNeg;
uniform float uHalftone;
uniform float uGrain;
uniform float uHalo;
out vec4 outColor;

// 不带 sin 的散列（在大整数坐标上也不出条纹）
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec2 worldAt(vec4 view) {
    vec2 p = gl_FragCoord.xy / uRes - 0.5;
    vec2 q = vec2(p.x * uAspect, -p.y) * view.z;
    float c = cos(view.w), s = sin(view.w);
    return view.xy + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
}
vec2 flowed(vec2 w) {
    float k = uWorld.y;
    vec2 n = vec2(vnoise(w / (k * 0.16) + uFlow * 0.37), vnoise(w / (k * 0.16) + 17.0 - uFlow * 0.29)) - 0.5;
    vec2 m = vec2(vnoise(w / (k * 0.025) + uFlow * 1.3), vnoise(w / (k * 0.025) - 9.0 + uFlow)) - 0.5;
    return w + n * k * 0.006 + m * k * 0.0016;
}

void main() {
    vec2 w = flowed(worldAt(uView));
    vec2 uv = w / uWorld;
    bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
    // 取样偏软一档：边缘的坡更宽，阈值噪点切出来的毛边才明显
    vec4 m = inside ? texture(uMain, uv, 0.8) : vec4(0.0);
    float halo = inside ? textureLod(uMain, uv, 4.0).r : 0.0;
    vec4 idv = inside ? texelFetch(uIds, min(ivec2(uv * uIdSize), ivec2(uIdSize) - 1), 0) : vec4(0.0);
    int gid = int(idv.r * 255.0 + 0.5);
    float so = floor(idv.g * 255.0 + 0.5);

    float reveal = 0.0;
    float ghost = 0.0;
    if (gid > 0) {
        vec2 se = texelFetch(uGlyph, ivec2(gid, 0), 0).xy;
        reveal = smoothstep(se.x - 0.2, se.x + 0.1, uTime);
    }
    float glyphInk = m.r * reveal;
    ghost = m.r * (1.0 - reveal) * uGhost;
    float lineInk = so > 0.5 ? m.g * smoothstep(0.0, 0.12, uTime - (uStroke.x + (so - 1.0) * uStroke.y)) : 0.0;

    vec2 wp = w;
    float field = 0.0;
    for (int i = 0; i < ${MAX_BLOBS}; i++) {
        if (i >= uBlobCount) break;
        vec4 b = uBlobs[i];
        vec2 d = wp - b.xy;
        field += b.z * b.z / (dot(d, d) + 1.0) * b.w;
    }
    float ring = 0.0;
    for (int i = 0; i < 2; i++) {
        vec4 r = uRings[i];
        if (r.w <= 0.0) continue;
        float d = (length(wp - r.xy) - r.z) / r.w;
        ring += exp(-d * d) * 0.9;
    }
    float accent = 0.0;
    for (int i = 0; i < ${MAX_ACCENT}; i++) {
        if (i >= uAccentCount) break;
        vec4 b = uAccent[i];
        vec2 d = wp - b.xy;
        accent += b.z * b.z / (dot(d, d) + 1.0);
    }

    float k = uWorld.y;
    float rough = (vnoise(wp / (k * 0.006) + uFlow * 1.7) - 0.5) * 0.3 + (hash12(floor(gl_FragCoord.xy / 2.0) + uFlow * 7.0) - 0.5) * 0.08;
    float F = glyphInk * 1.25 + halo * reveal * uHalo + lineInk * 1.1 + field * 0.5 + ring;
    float thr = 0.5 + rough;
    float a = smoothstep(thr - 0.05, thr + 0.05, F);
    float aA = smoothstep(0.42 + rough * 0.6, 0.52 + rough * 0.6, accent * 0.5);

    // 半调：网点格在世界里（跟着镜头放大），网点大小随浓淡
    float T = m.b * uTone + clamp(field * 0.18, 0.0, 0.35) * smoothstep(0.2, 0.0, a);
    float ca = 0.2588, sa = 0.9659;
    vec2 g = vec2(wp.x * sa + wp.y * ca, -wp.x * ca + wp.y * sa) / (k / 150.0);
    float dist = length(fract(g) - 0.5);
    float radius = sqrt(clamp(T, 0.0, 1.0)) * 0.62;
    float dots = (1.0 - smoothstep(radius - 0.09, radius + 0.09, dist)) * uHalftone * step(0.01, T);

    vec3 paper = mix(uPaper, uInk, uNeg);
    vec3 ink = mix(uInk, uPaper, uNeg);
    vec3 col = paper;
    col = mix(col, uDot, dots * 0.85);
    col = mix(col, uAccentCol, aA);
    // 还没唱到的字：淡淡的墨，同样切阈值（毛边一致）
    float ga = smoothstep(thr - 0.05, thr + 0.05, ghost * 1.25 / max(uGhost, 0.001)) * uGhost;
    col = mix(col, mix(ink, paper, aA), max(a, ga * 0.6 * (1.0 - a)));

    if (uPrevFade > 0.0) {
        vec2 wq = flowed(worldAt(uPrevView));
        vec2 uq = wq / uWorld;
        if (all(greaterThanEqual(uq, vec2(0.0))) && all(lessThanEqual(uq, vec2(1.0)))) {
            vec4 pm = texture(uPrev, uq);
            float ph = textureLod(uPrev, uq, 4.0).r;
            float Fp = pm.r * 1.25 + ph * uHalo + pm.g * 1.1;
            float breakUp = (vnoise(wq / (k * 0.05)) - 0.5) * 0.9;
            float tp = 0.5 + rough + uPrevFade * 1.1 + breakUp * uPrevFade;
            float ap = smoothstep(tp - 0.05, tp + 0.05, Fp);
            col = mix(col, ink, ap * (1.0 - a));
        }
    }

    float gr = hash12(floor(gl_FragCoord.xy / 1.5) + uGrainStep * 17.0) - 0.5;
    float fibre = vnoise(gl_FragCoord.xy / 3.0 + uGrainStep * 5.0) - 0.5;
    col += (gr * 0.07 + fibre * 0.04) * uGrain;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    const compile = (gl, type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`[inkdraft] shader: ${log}`);
        }
        return shader;
    };

    const createGl = (canvas) => {
        const gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default'
        });
        if (!gl) return null;
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`[inkdraft] link: ${gl.getProgramInfoLog(program)}`);
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i += 1) {
            const info = gl.getActiveUniform(program, i);
            const name = info.name.replace(/\[0\]$/, '');
            uniforms[name] = gl.getUniformLocation(program, info.name);
        }
        const vao = gl.createVertexArray();
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const makeTexture = (filter, mip = false) => {
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return texture;
        };
        const slots = Array.from({ length: 3 }, () => ({
            main: makeTexture(gl.LINEAR, true), ids: makeTexture(gl.NEAREST), glyph: makeTexture(gl.NEAREST), key: null, data: null, used: 0
        }));
        return { gl, program, uniforms, vao, slots };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('inkdraft', '墨痕', container, services);
        const canvas = createElement('canvas', 'inkdraft-canvas');
        const crop = createElement('div', 'inkdraft-crop');
        crop.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < 4; i += 1) crop.append(createElement('i'));
        const kicker = createElement('div', 'inkdraft-kicker', '墨痕');
        const timecode = createElement('div', 'inkdraft-timecode', '00:00');
        const translation = createElement('div', 'stage-translation inkdraft-translation');
        const notice = createElement('div', 'inkdraft-notice');
        notice.hidden = true;
        mode.root.append(canvas, crop, kicker, timecode, translation, notice);

        const mainCanvas = document.createElement('canvas');
        const idsCanvas = document.createElement('canvas');
        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); glState = null; }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，墨痕画不出来，请换一个舞台';
        }

        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        const blobBuffer = new Float32Array(MAX_BLOBS * 4);
        const ringBuffer = new Float32Array(8);
        const accentBuffer = new Float32Array(MAX_ACCENT * 4);
        let cues = [];
        let cuesFor = null;
        let world = { W: 0, H: 0, aspect: 0 };
        let size = { w: 0, h: 0 };
        let paused = false;
        let latestFrame = null;
        let lastDraw = -Infinity;
        let idleHandle = 0;
        let palette = null;
        let caption = '';
        let lastTimecode = '';
        let lastTranslation = '';
        let lostContext = false;
        const stats = { builds: 0, buildMs: 0, draws: 0, lastShot: '', cue: -1 };

        const settings = () => {
            const tuning = mode.config.modes?.inkdraft || {};
            return {
                cameraCuts: tuning.cameraCuts !== false,
                figures: tuning.figures !== false,
                collisions: tuning.collisions !== false,
                inkFlip: Boolean(tuning.inkFlip),
                negativeShots: tuning.negativeShots !== false,
                halftone: clamp(tuning.halftone ?? 0.8, 0, 1),
                grain: clamp(tuning.grain ?? 0.5, 0, 1),
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                waitingOpacity: clamp(tuning.waitingOpacity ?? 0.35, 0, 1),
                showTranslation: tuning.showTranslation !== false,
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                figureScale: clamp(tuning.objectDensity ?? 1, 0.25, 2) > 1 ? 1.1 : 1,
                reducedMotion: Boolean(reducedMotion?.matches),
                quality: mode.config.quality || 'standard'
            };
        };

        const readPalette = () => {
            const p = services?.app?.stagePalette || {};
            const light = Boolean(p.light);
            let paper = hexRgb(p.background, light ? [0.95, 0.94, 0.9] : [0.09, 0.1, 0.11]);
            let ink = hexRgb(p.ink, light ? [0.1, 0.12, 0.12] : [0.95, 0.94, 0.91]);
            const accent = hexRgb(p.accent, [0.95, 0.66, 0]);
            if (settings().inkFlip) [paper, ink] = [ink, paper];
            // 网点：纸和墨之间偏纸的一档，和墨分得开
            const dot = paper.map((v, i) => v + (ink[i] - v) * 0.42);
            palette = { paper, ink, accent, dot };
            const css = (rgb, alpha = 1) => `rgba(${rgb.map(v => Math.round(v * 255)).join(',')},${alpha})`;
            mode.root.style.setProperty('--inkdraft-paper', css(paper));
            mode.root.style.setProperty('--inkdraft-mark', css(ink, 0.62));
        };

        const fontFamily = () => {
            const family = global.getComputedStyle?.(mode.root).fontFamily || '';
            return family || '"Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif';
        };

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const quality = mode.config.quality || 'standard';
            const dpr = Math.min(RATIO[quality] || 1.5, global.devicePixelRatio || 1);
            const scale = Math.min(dpr, Math.sqrt((PIXELS[quality] || PIXELS.standard) / (w * h)));
            const bw = Math.max(1, Math.round(w * scale));
            const bh = Math.max(1, Math.round(h * scale));
            if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; still.invalidate(); }
            size = { w, h };
            const aspect = w / h;
            if (!world.aspect || Math.abs(aspect / world.aspect - 1) > 0.04) {
                const W = aspect >= 1 ? 2048 : Math.round(2048 * aspect);
                const H = Math.min(2048, Math.round(W / aspect));
                world = { W, H, aspect: W / H };
                mainCanvas.width = W; mainCanvas.height = H;
                idsCanvas.width = Math.ceil(W * ID_SCALE); idsCanvas.height = Math.ceil(H * ID_SCALE);
                glState?.slots.forEach((slot) => { slot.key = null; slot.data = null; });
            }
        };

        const trackKey = frame => frame.track?.path || frame.track?.title || '';
        const ensureCues = (frame) => {
            const key = `${trackKey(frame)}|${Math.round(frame.duration || 0)}`;
            if (cuesFor && cuesFor.lines === frame.lines && cuesFor.key === key) return;
            cues = buildCues(frame.lines || [], frame.duration);
            cuesFor = { lines: frame.lines, key };
            glState?.slots.forEach((slot) => { slot.key = null; slot.data = null; });
        };

        // 只有会改变纹理和分镜的设置进键；网点、颗粒、配色这些只是着色器参数。
        const slotKey = (index) => {
            const s = settings();
            return `${cuesFor?.key}|${index}|${world.W}x${world.H}|${s.fontScale}|${s.figures}|${s.collisions}|${s.cameraCuts}|${s.negativeShots}|${s.figureScale}|${s.reducedMotion}`;
        };
        const slotFor = (index, build = true) => {
            if (!glState || index < 0 || index >= cues.length) return null;
            const key = slotKey(index);
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            const current = latestFrame;
            const data = prepareCue(cues[index], index, {
                W: world.W, H: world.H, aspect: world.aspect, family: fontFamily(), settings: settings(),
                trackKey: trackKey(current || {}), title: current?.track?.title || '',
                mainCanvas, idsCanvas
            });
            const { gl } = glState;
            // 最久没用的槽，但不动正在画的这一段和上一段
            const busy = new Set([stats.cue, stats.cue - 1].map(i => (i >= 0 ? slotKey(i) : '')));
            const slot = glState.slots.filter(s => !busy.has(s.key)).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            gl.bindTexture(gl.TEXTURE_2D, slot.main);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mainCanvas);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.bindTexture(gl.TEXTURE_2D, slot.ids);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, idsCanvas);
            gl.bindTexture(gl.TEXTURE_2D, slot.glyph);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, data.glyphData);
            slot.key = key;
            slot.data = data;
            slot.used = performance.now();
            stats.builds += 1;
            stats.buildMs = Math.round(performance.now() - started);
            return slot;
        };

        // 下一段在空闲时备好，换句时不卡。
        const scheduleNext = (index) => {
            if (idleHandle || !glState || index + 1 >= cues.length || slotFor(index + 1, false)) return;
            const run = () => {
                idleHandle = 0;
                if (!mode.destroyed && !lostContext) slotFor(index + 1, true);
            };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        const draw = (frame) => {
            if (!glState || lostContext) return;
            const { gl, program, uniforms: u, vao } = glState;
            const t = frame.playbackTime;
            const index = findCue(cues, t);
            const slot = slotFor(index, true);
            if (!slot) return;
            const data = slot.data;
            stats.cue = index;
            const view = viewAt(data.shots, t);
            stats.lastShot = view.shot;
            const s = settings();
            const audio = frame.audio || {};
            const bass = clamp((audio.bass || 0) * s.audioReactivity, 0, 1.5);
            const counts = blobsAt(data, t, blobBuffer, ringBuffer, accentBuffer, bass);

            let prevFade = 0;
            let prevSlot = null;
            let prevView = null;
            if (data.transition === 'ink' && t - data.cue.start < 0.5 && index > 0) {
                prevSlot = slotFor(index - 1, false);
                if (prevSlot) {
                    prevFade = smooth(0, 0.5, t - data.cue.start) * 0.999 + 0.001;
                    prevView = viewAt(prevSlot.data.shots, data.cue.start - 0.001);
                }
            }

            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.useProgram(program);
            gl.bindVertexArray(vao);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.main); gl.uniform1i(u.uMain, 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, slot.ids); gl.uniform1i(u.uIds, 1);
            gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, slot.glyph); gl.uniform1i(u.uGlyph, 2);
            gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, (prevSlot || slot).main); gl.uniform1i(u.uPrev, 3);
            gl.uniform2f(u.uRes, canvas.width, canvas.height);
            gl.uniform2f(u.uWorld, world.W, world.H);
            gl.uniform2f(u.uIdSize, idsCanvas.width, idsCanvas.height);
            gl.uniform4f(u.uView, view.c[0], view.c[1], view.h, view.roll);
            if (prevView) gl.uniform4f(u.uPrevView, prevView.c[0], prevView.c[1], prevView.h, prevView.roll);
            gl.uniform1f(u.uPrevFade, prevSlot ? prevFade : 0);
            gl.uniform1f(u.uAspect, canvas.width / canvas.height);
            gl.uniform1f(u.uTime, t);
            gl.uniform2f(u.uStroke, data.strokeStart, data.strokeStep);
            const local = t - data.cue.start;
            gl.uniform1f(u.uGhost, s.waitingOpacity * smooth(0, 0.35, local));
            gl.uniform1f(u.uTone, smooth(0.05, 0.9, local));
            gl.uniform4fv(u.uBlobs, blobBuffer);
            gl.uniform1i(u.uBlobCount, counts.blobs);
            gl.uniform4fv(u.uAccent, accentBuffer);
            gl.uniform1i(u.uAccentCount, counts.accents);
            gl.uniform4fv(u.uRings, ringBuffer);
            // 流场每秒跳 8 格、颗粒每秒 6 格：手绘动画那种「沸腾」，不是连续流动
            const flowStep = s.reducedMotion ? 0 : Math.floor(t * 8);
            gl.uniform1f(u.uFlow, flowStep * 0.13);
            gl.uniform1f(u.uGrainStep, s.reducedMotion ? 0 : Math.floor(t * 6) % 64);
            gl.uniform3fv(u.uPaper, palette.paper);
            gl.uniform3fv(u.uInk, palette.ink);
            gl.uniform3fv(u.uAccentCol, palette.accent);
            gl.uniform3fv(u.uDot, palette.dot);
            gl.uniform1f(u.uNeg, view.neg ? 1 : 0);
            gl.uniform1f(u.uHalftone, s.halftone);
            gl.uniform1f(u.uGrain, s.grain);
            gl.uniform1f(u.uHalo, 0.5 + (audio.vocal || 0) * 0.15 * s.audioReactivity);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            stats.draws += 1;
            scheduleNext(index);
        };

        const updateOverlay = (frame) => {
            const next = `墨痕 · ${Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const tc = formatTime(frame.playbackTime).slice(0, 5);
            if (tc !== lastTimecode) { lastTimecode = tc; timecode.textContent = tc; }
            const text = settings().showTranslation ? resolveSupplementalText(frame.activeLine) : '';
            if (text !== lastTranslation) { lastTranslation = text; translation.textContent = text; translation.hidden = !text; }
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            latestFrame = frame;
            if (!palette) readPalette();
            ensureCues(frame);
            updateOverlay(frame);
            if (!glState) return;
            const quality = mode.config.quality || 'standard';
            const aim = 1000 / (FPS[quality] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (still.same(frame, `${canvas.width}x${canvas.height}|${stats.builds}`)) return;
            lastDraw = aim && now - lastDraw < aim * 2 ? lastDraw + aim : now;
            draw(frame);
        };

        const redraw = () => {
            still.invalidate();
            lastDraw = -Infinity;
            if (latestFrame) mode.updateFrame(latestFrame);
        };

        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => {
            updateConfig(config);
            resize();
            readPalette();
            redraw();
        };
        mode.resize = () => { resize(); redraw(); };
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { readPalette(); redraw(); };
        mode.getDebugSnapshot = () => ({
            initialized: Boolean(glState), cues: cues.length, cue: stats.cue, shot: stats.lastShot,
            builds: stats.builds, buildMs: stats.buildMs, draws: stats.draws,
            buffer: `${canvas.width}x${canvas.height}`, world: `${world.W}x${world.H}`,
            style: glState?.slots.find(s => s.data?.index === stats.cue)?.data?.style
        });

        const onLost = (event) => { event.preventDefault(); lostContext = true; };
        const onRestored = () => {
            try { glState = createGl(canvas); lostContext = false; redraw(); } catch (error) { console.error(error); }
        };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        mode.scope.add(() => {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            if (idleHandle) (global.cancelIdleCallback || global.clearTimeout)(idleHandle);
            if (glState) {
                const { gl } = glState;
                glState.slots.forEach((slot) => { gl.deleteTexture(slot.main); gl.deleteTexture(slot.ids); gl.deleteTexture(slot.glyph); });
                gl.deleteProgram(glState.program);
                gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
            glState = null;
        });

        resize();
        return mode;
    };

    global.MusicStageInkdraftManager = Object.freeze({
        create: createManager,
        // 给测试用的纯函数
        _test: Object.freeze({ buildCues, findCue, glyphUnits, composeText, viewAt, blobsAt })
    });
})(window);
