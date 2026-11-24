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
    const MAX_BLOBS = 48;
    const MAX_RINGS = 4;
    const MAX_ACCENT = 5;
    const MAX_CLOUDS = 6;
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
        markKeywords(cues, sung);
        return cues;
    };

    // 关键词：在歌里不同的句子里反复出现的词（意象），每句最多挑两个上强调色；
    // 一句里没有这样的词时，有一半的机会挑这句最长的实词。
    const STOP = new Set(['的', '了', '着', '过', '是', '在', '有', '不', '也', '就', '都', '和', '与', '把', '被', '这', '那', '一个', '我们', '你们', '他们', '自己', '没有', '什么', '怎么', '还是', '只是', '就是', '可是', '如果', '因为', '所以', '已经', 'the', 'and', 'that', 'this', 'with', 'from', 'your', 'have', 'will', 'what', 'when', 'just', 'into', 'like', 'been', 'were', 'they', 'there', 'their', 'about', 'would', 'could']);
    const plainWord = text => String(text || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const wordsOf = (text) => {
        const raw = String(text || '');
        const list = wordSegmenter
            ? Array.from(wordSegmenter.segment(raw)).filter(seg => seg.isWordLike !== false).map(seg => seg.segment)
            : raw.split(/\s+/);
        return list.map(plainWord).filter(Boolean);
    };
    const contentWord = w => !STOP.has(w) && (CJK.test(w) ? Array.from(w).length >= 2 : w.length >= 4);
    const markKeywords = (cues, sung) => {
        const seen = new Set();
        const freq = new Map();
        sung.forEach((line) => {
            const k = plainWord(line.fullText);
            if (!k || seen.has(k)) return;
            seen.add(k);
            new Set(wordsOf(line.fullText).filter(contentWord)).forEach(w => freq.set(w, (freq.get(w) || 0) + 1));
        });
        cues.forEach((cue) => {
            if (cue.kind !== 'line') return;
            const words = Array.from(new Set(wordsOf(cue.line.fullText).filter(contentWord)));
            const ranked = words.map(w => ({ w, f: freq.get(w) || 0 })).sort((a, b) => b.f - a.f || b.w.length - a.w.length);
            const motif = ranked.filter(r => r.f >= 2).slice(0, 2).map(r => r.w);
            if (motif.length) cue.keys = motif;
            else if (ranked.length && seededRandom(`inkdraft:key:${plainWord(cue.line.fullText)}`)() < 0.5) {
                cue.keys = [ranked.slice().sort((a, b) => b.w.length - a.w.length)[0].w];
            } else cue.keys = [];
        });
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
        // 笔画密的字（汉字、假名、谚文）只用 500：墨是切阈值切出来的，比字形胖一圈，粗体的密字一胖就糊成一团；西文用 800
        const fontFor = (size, cjk) => `${cjk ? 500 : 800} ${size.toFixed(1)}px ${family}`;
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
            const fit = Math.min(1, (W * 0.62) / bw, (H * 0.56) / bh);
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
        const keys = new Set(cue.keys || []);
        placed.forEach((p, i) => {
            const id = Math.min(MAX_GLYPHS, i + 1);
            main.font = fontFor(p.size, CJK.test(p.g.text));
            // 字形先按字号的比例轻轻模糊一下：边缘变成一道和字号成比例的缓坡，
            // 着色器在坡上切阈值，大字小字的毛边才一样细，放大的特写也还是干净的边
            main.filter = `blur(${Math.max(0.8, p.size * 0.022).toFixed(2)}px)`;
            main.fillText(p.g.text, p.x, p.baseline);
            main.filter = 'none';
            glyphData[id * 4] = p.g.start;
            glyphData[id * 4 + 1] = p.g.end;
            glyphData[id * 4 + 2] = keys.size && keys.has(plainWord(p.unit?.glyphs.map(g => g.text).join(''))) ? 1 : 0;
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
            ? clamp(Math.max((textBox[3] - textBox[1]) / 0.8, (textBox[2] - textBox[0]) / aspect / 0.86), H * 0.4, H)
            : H * 0.92;
        const wideC = textBox ? [(textBox[0] + textBox[2]) / 2, (textBox[1] + textBox[3]) / 2] : [W / 2, H / 2];
        const wideRect = [wideC[0] - wideH * aspect / 2, wideC[1] - wideH / 2, wideC[0] + wideH * aspect / 2, wideC[1] + wideH / 2];

        // 空着的大格：线稿和墨团摆在这里。
        const cols = aspect > 1.4 ? 4 : 3;
        const rowsN = aspect > 1.4 ? 3 : 4;
        // 全景把字撑满了：线稿摆在全景的边上和外面（一半露在画里），拉远、留白远景时整个看得见
        const spill = [(wideRect[2] - wideRect[0]) * 0.28, (wideRect[3] - wideRect[1]) * 0.3];
        const region = cue.kind === 'rest' ? [W * 0.06, H * 0.06, W * 0.94, H * 0.94]
            : [Math.max(0, wideRect[0] - spill[0]), Math.max(0, wideRect[1] - spill[1]), Math.min(W, wideRect[2] + spill[0]), Math.min(H, wideRect[3] + spill[1])];
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
            const tonePen = Figures.createPen(main, null, ID_SCALE, { tone: true, lineWidth: H * 0.02, toneLevel: 0.4, soft: H * 0.004 });
            Figures.drawFigure(tonePen, Figures.KINDS[Math.floor(random() * Figures.KINDS.length)],
                wideC[0], wideC[1], H * (0.36 + random() * 0.1), (random() - 0.5) * 0.4, random);
        }

        // 版面零件（规线、裁切标记、行号、时间码）和线稿，一笔一笔冒出来。
        const pen = Figures.createPen(main, ids, ID_SCALE, { lineWidth: Math.max(2, H * 0.0068), soft: H * 0.002, fringe: H * 0.018, startOrder: 1 });
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
            // 时间轴括号：字块左边一道竖括号，每个词开唱的位置一格刻度，括号顶上记段号
            if (cue.kind === 'line' && unitBoxes.length > 1 && random() < 0.6) {
                const bx = x0 - pad * 0.9;
                const hook = pad * 0.5;
                pen.place(0, 0, 1, 0);
                pen.line([[bx + hook, y0], [bx, y0], [bx, y1], [bx + hook, y1]]);
                const span = Math.max(0.1, cue.end - cue.start);
                pen.segments(unitBoxes.map((u) => {
                    const y = y0 + (y1 - y0) * clamp((u.unit.start - cue.start) / span, 0, 1);
                    return [[bx - hook * 0.5, y], [bx + hook * 0.35, y]];
                }));
                pen.dot(bx, y0 + (y1 - y0) * (0.15 + random() * 0.5), pad * 0.32);
                pen.place(bx - hook * 0.6, y0 - H * 0.018, H, 0);
                pen.note(`${String(cue.number).padStart(2, '0')} / ${formatTime(cue.start).slice(0, 5)}`, 0, 0, 0.016, 'right');
            }
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
        // 字块的尺度：一个字高（em）和字块的半宽半高，下面几样墨都按它摆
        const tb = textBox || [W * 0.36, H * 0.4, W * 0.64, H * 0.6];
        const tcx = (tb[0] + tb[2]) / 2, tcy = (tb[1] + tb[3]) / 2;
        const halfW = (tb[2] - tb[0]) / 2, halfH = (tb[3] - tb[1]) / 2;
        const em = placed.length ? Math.max(...placed.map(p => p.size)) : H * 0.1;
        const reach = Math.max(halfW, halfH, em * 2);
        const drift = (ax, ay) => ({ ax, ay, w1: 0.06 + random() * 0.1, w2: 0.06 + random() * 0.1, p1: random() * TAU, p2: random() * TAU });
        // 第二个墨团（小一些，也带墨滴），摆在另一个空格里
        const massCell2 = freeCells[1];
        const mass2 = massCell2 && random() < 0.75 ? {
            x: (massCell2[0] + massCell2[2]) / 2, y: (massCell2[1] + massCell2[3]) / 2,
            r: Math.min(massCell2[2] - massCell2[0], massCell2[3] - massCell2[1]) * (0.07 + random() * 0.05),
            sats: Array.from({ length: 2 + Math.floor(random() * 2) }, () => ({
                orbit: 1.5 + random() * 0.8, speed: (0.1 + random() * 0.2) * (random() < 0.5 ? -1 : 1),
                phase: random() * TAU, size: 0.18 + random() * 0.14
            }))
        } : null;
        // 网点云：几团盖过小半个画面的灰，摆在字块四周、极慢地漂（只进网点，不是墨）
        const clouds = Array.from({ length: cue.kind === 'rest' ? 5 : 4 }, () => {
            const a = random() * TAU, d = reach * (0.35 + random() * 1.4);
            return {
                x: tcx + Math.cos(a) * d * (halfW / reach + 0.6), y: tcy + Math.sin(a) * d * (halfH / reach + 0.6),
                r: reach * (0.55 + random() * 0.85), level: 0.45 + random() * 0.45,
                ...drift(reach * (0.08 + random() * 0.25), reach * (0.08 + random() * 0.2))
            };
        });
        // 贴着字块四边的小墨滴：离字半个到一个字高，慢慢漂
        const drops = cue.kind === 'line' ? Array.from({ length: 3 + Math.floor(random() * 3) }, () => {
            const side = Math.floor(random() * 4), along = random() * 2 - 1, out = em * (0.35 + random() * 0.55);
            return {
                x: side < 2 ? tcx + along * halfW : tcx + (side === 2 ? -1 : 1) * (halfW + out),
                y: side < 2 ? tcy + (side === 0 ? -1 : 1) * (halfH + out) : tcy + along * halfH,
                r: em * (0.07 + random() * 0.13), ...drift(em * (0.1 + random() * 0.35), em * (0.1 + random() * 0.35))
            };
        }) : [];
        // 漂在字上的灰墨团：盖住一两个字的大小，在字块里慢慢游；显影时墨压在它上面，字照样读得出
        const drifters = Array.from({ length: (cue.kind === 'line' ? 1 : 2) + (random() < 0.55 ? 1 : 0) }, () => ({
            x: tcx + (random() * 1.8 - 0.9) * halfW, y: tcy + (random() * 1.8 - 0.9) * halfH,
            r: em * (0.55 + random() * 0.45) * (cue.kind === 'line' ? 1 : 1.6),
            ...drift(Math.min(halfW, em * 1.5) * (0.3 + random() * 0.6), Math.min(halfH, em * 1.2) * (0.2 + random() * 0.4))
        }));
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
        // 进这一段的转场：多数直接硬切；进副歌时多半漫墨或冲镜
        const intoChorus = cue.kind === 'line' && cue.line?.isChorus && !(ctx.prevCue?.kind === 'line' && ctx.prevCue.line?.isChorus);
        const transition = index > 0 ? pickWeighted(random, intoChorus
            ? [['flood', 3], ['smash', 3], ['ink', 1], ['cut', 1.5]]
            : [['cut', 4.5], ['ink', 1.4], ['flood', 1.2], ['smash', 1]]) : 'cut';
        const shots = planShots(cue, { placed, unitBoxes, wideH, wideC, textBox, figures, W, H, aspect }, random, settings, transition);
        return {
            index, cue, glyphData, shots, mass, mass2, clouds, drops, drifters, collisions, accents,
            strokeStart: cue.start + 0.12, strokeStep,
            transition,
            flood: [0.2 + random() * 0.6, 0.25 + random() * 0.5],
            sparks: placed.slice(0, MAX_GLYPHS).map((p, i) => ({
                t: p.g.start, x: (p.box[0] + p.box[2]) / 2, y: (p.box[1] + p.box[3]) / 2, s: p.size,
                a: random() * TAU, spin: (i % 2 ? 1 : -1) * (2.2 + random() * 1.4)
            })),
            beats: unitBoxes.map(u => ({ t: u.unit.start, x: (u.box[0] + u.box[2]) / 2, y: (u.box[1] + u.box[3]) / 2,
                r: Math.max(u.box[2] - u.box[0], u.box[3] - u.box[1]) * 0.62 })),
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

    // 每种机位自己的滚转和偏心范围：大特写斜得最狠（字斜着撑出画面），倾斜镜头次之，其余只歪一点点。
    const shotPose = (type, random) => {
        const span = (lo, hi) => lo + random() * (hi - lo);
        const sign = () => (random() < 0.5 ? -1 : 1);
        switch (type) {
            case 'macro': return { roll: sign() * span(0.25, 0.6), off: [span(-0.12, 0.12), span(-0.12, 0.12)] };
            case 'dutch': return { roll: sign() * span(0.2, 0.4), off: [span(-0.1, 0.1), 0] };
            case 'close': return { roll: span(-0.07, 0.07), off: [span(-0.08, 0.08), span(-0.05, 0.05)] };
            case 'far': return { roll: span(-0.04, 0.04), off: [sign() * span(0.18, 0.3), sign() * span(0.1, 0.22)] };
            case 'figure': return { roll: sign() * span(0.08, 0.3), off: [span(-0.1, 0.1), span(-0.1, 0.1)] };
            case 'follow': return { roll: span(-0.03, 0.03), off: [0, 0] };
            case 'pullback': return { roll: span(-0.1, 0.1), off: [0, 0] };
            case 'crash': return { roll: span(-0.12, 0.12), off: [0, 0] };
            default: return { roll: span(-0.05, 0.05), off: [0, 0] };
        }
    };
    const SCREEN_ANGLES = [0.26, 0.52, 0.79, 1.31];
    const FIRST_SHOT = [['wide', 3], ['close', 2], ['dutch', 1.5], ['far', 0.8], ['follow', 1.5]];
    const MIDDLE_SHOT = [['close', 3], ['follow', 2], ['macro', 2], ['dutch', 1.5], ['wide', 1], ['far', 0.6]];
    // 切点：按节奏均分（一句大约 2.6 秒一刀，副歌密一些），再吸到最近的词开唱时刻上
    const planCuts = (start, end, count, onsets) => {
        const cuts = [];
        const spacing = (end - start) / count;
        for (let i = 1; i < count; i += 1) {
            const ideal = start + spacing * i;
            const near = onsets.reduce((best, o) => (Math.abs(o - ideal) < Math.abs(best - ideal) ? o : best), Infinity);
            const at = Math.abs(near - ideal) <= spacing * 0.4 ? near : ideal;
            const previous = cuts.length ? cuts[cuts.length - 1] : start;
            if (at - previous >= 0.6 && end - at >= 0.6) cuts.push(at);
        }
        return cuts;
    };

    const planShots = (cue, scene, random, settings, transition = 'cut') => {
        const { placed, unitBoxes, wideH, wideC, figures, W, H, aspect } = scene;
        const maxSize = placed.length ? Math.max(...placed.map(p => p.size)) : H * 0.1;
        const closeH = clamp(maxSize * 2.5, H * 0.16, wideH * 0.72);
        const close = buildFrames(placed, closeH, aspect);
        // 跟词：一个词一框（大特写对准的词唱完以后也用它一个词一个词地跳）
        const words = unitBoxes.map((u) => {
            const w = u.box[2] - u.box[0], h = u.box[3] - u.box[1];
            return { start: u.unit.start, c: [(u.box[0] + u.box[2]) / 2, (u.box[1] + u.box[3]) / 2], h: clamp(Math.max(h * 1.45, w / aspect * 1.45), H * 0.1, wideH) };
        }).sort((x, y) => x.start - y.start);
        const shots = [];
        const length = cue.end - cue.start;
        const cuts = settings.cameraCuts && !settings.reducedMotion;
        const chorus = cue.kind === 'line' && Boolean(cue.line?.isChorus);
        const negChance = settings.negativeShots ? (chorus ? 0.34 : 0.2) : 0;
        let inverted = 0;
        let previous = '';
        const push = (start, type, first) => {
            // 先取随机数再判断：开关反相不改后面取到的数，机位不跟着变
            const roll = random();
            const neg = !first && inverted < 2 && roll < negChance;
            inverted = neg ? inverted + 1 : 0;
            const pose = shotPose(type, random);
            let angle = SCREEN_ANGLES[Math.floor(random() * SCREEN_ANGLES.length)];
            if (shots.length && angle === shots[shots.length - 1].angle) angle = SCREEN_ANGLES[(SCREEN_ANGLES.indexOf(angle) + 1) % SCREEN_ANGLES.length];
            const shot = { start, type, drift: [random() - 0.5, random() - 0.5], roll: pose.roll, off: pose.off, neg, angle };
            if (type === 'macro' && placed.length) {
                // 大特写只框住镜头开头正在唱的那个字的一部分：字斜着撑出画面
                let p = placed[0];
                placed.forEach((q) => { if (q.g.start <= start + 0.05 && q.g.start >= p.g.start) p = q; });
                shot.anchor = { start: p.unit?.start ?? p.g.start, c: [(p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2], h: p.size * 0.74 };
            }
            shots.push(shot);
            previous = type;
            return shot;
        };
        if (cue.kind === 'rest') {
            let t = cue.start;
            let k = 0;
            while (t < cue.end - 0.5) {
                const fig = figures.length && cuts && k % 2 === 1 ? figures[Math.floor(random() * figures.length)] : null;
                const shot = push(t, fig ? 'figure' : (k % 3 === 2 ? 'far' : 'wide'), k === 0);
                shot.fig = fig;
                t += 4.5 + random() * 3.5;
                k += 1;
                if (!cuts) break;
            }
        } else if (!cuts || !placed.length) {
            push(cue.start, 'wide', true);
        } else {
            const count = Math.max(1, Math.min(7, Math.round(length * (chorus ? 1.25 : 1) / 2.6)));
            const onsets = unitBoxes.map(u => u.unit.start).filter(o => o > cue.start + 0.6 && o < cue.end - 0.6);
            const edges = [cue.start, ...planCuts(cue.start, cue.end, count, onsets), cue.end];
            edges.slice(0, -1).forEach((start, i) => {
                const end = edges[i + 1];
                if (i === 0 && transition === 'smash') { push(start, 'crash', true); return; }
                let weights = i === 0 ? FIRST_SHOT : MIDDLE_SHOT;
                // 一句的最后一个镜头够长时多半拉远，把整句和周围的墨交代出来
                if (i > 0 && i === edges.length - 2 && end - start >= 1.4) weights = weights.concat([['pullback', 5]]);
                if (chorus) weights = weights.map(([n, w]) => [n, w + (n === 'macro' ? 1.5 : n === 'dutch' ? 1 : 0)]);
                const pool = weights.filter(([n]) => n !== previous);
                push(start, pickWeighted(random, pool.length ? pool : weights), i === 0);
            });
        }
        const starts = unitBoxes.map(u => u.unit.start).sort((x, y) => x - y);
        shots.forEach((shot, i) => {
            shot.end = shots[i + 1]?.start ?? cue.end;
            if (shot.type === 'pullback') {
                const inside = starts.filter(st => st > shot.start + 0.3 && st < shot.end - 0.3);
                shot.steps = inside.length >= 3 ? [shot.start, ...inside.slice(0, 2)] : [0, 1, 2].map(k => shot.start + (shot.end - shot.start) * k / 3);
            }
        });
        return { shots, closeH, close, words, wideH, wideC, W, H };
    };

    // 某一刻的机位：中心、取景高度（世界像素）、滚转。机位只在开唱、跳档的时刻上跳，镜头里只极慢地蠕动。
    const viewAt = (plan, t) => {
        const { shots, closeH, close, wideH, wideC, H } = plan;
        const words = plan.words || [];
        let shot = shots[0];
        for (const s of shots) { if (s.start <= t) shot = s; else break; }
        if (!shot) return { c: wideC, h: wideH, roll: 0, neg: false, shot: 'wide' };
        let c = wideC, h = wideH;
        let roll = shot.roll || 0;
        const u = clamp((t - shot.start) / Math.max(0.5, shot.end - shot.start), 0, 1);
        const closeFrame = close.length ? frameAt(close, t) : null;
        const word = words.length ? frameAt(words, t) : null;
        switch (shot.type) {
            case 'far': h = Math.min(wideH * 1.85, H * 1.15); break;
            case 'dutch': h = wideH * 1.04; break;
            case 'close': if (closeFrame) { c = closeFrame.c; h = closeH; } break;
            case 'follow': if (word) { c = word.c; h = word.h; } break;
            case 'macro': {
                const a = shot.anchor;
                if (word && a && word.start > a.start + 1e-3) {
                    // 对准的词唱完了：换成特写一个词一个词地跳，斜度收掉大半
                    c = word.c; h = word.h * 0.92; roll *= 0.12;
                } else if (a) { c = a.c; h = a.h; roll += 0.03 * (u - 0.5); } else if (closeFrame) { c = closeFrame.c; h = closeH; }
                break;
            }
            case 'pullback': {
                const step = (shot.steps || []).filter(st => st <= t).length;
                const k = clamp((step - 1) / 2, 0, 1);
                const from = closeFrame ? closeFrame.c : wideC;
                c = [from[0] + (wideC[0] - from[0]) * k, from[1] + (wideC[1] - from[1]) * k];
                h = closeH + (wideH * 1.25 - closeH) * k;
                break;
            }
            case 'crash': {
                // 冲镜：从很远处连跳三格，落到第一个词上
                const jumps = Math.min(3, Math.floor((t - shot.start) / 0.16));
                const k = jumps / 3;
                const to = closeFrame ? closeFrame.c : wideC;
                c = [wideC[0] + (to[0] - wideC[0]) * k, wideC[1] + (to[1] - wideC[1]) * k];
                h = wideH * 2.6 + (closeH - wideH * 2.6) * k;
                break;
            }
            case 'figure': if (shot.fig) { c = [shot.fig.x, shot.fig.y]; h = shot.fig.r * 2.6; } break;
            default: break;
        }
        // 一个镜头从头到尾只推近 3.5%
        h *= 1 - 0.035 * u;
        const off = shot.off || [0, 0];
        // 顶上是模式栏、底下是播放条：取景中心放在两者之间（比屏幕正中略高）
        c = [c[0] - off[0] * h + shot.drift[0] * h * 0.04 * u, c[1] - off[1] * h + shot.drift[1] * h * 0.04 * u + h * 0.035];
        return { c, h, roll, neg: shot.neg, shot: shot.type, angle: shot.angle };
    };

    // 某一刻的墨团（世界像素：x, y, 半径, 强度）和冲击环。
    const wander = (d, local) => [Math.sin(local * d.w1 + d.p1) * d.ax, Math.sin(local * d.w2 + d.p2) * d.ay];
    const blobsAt = (cue, t, out, rings, accentsOut, bass, beatAge = Infinity, cloudsOut = null) => {
        let n = 0;
        const push = (x, y, r, s = 1) => { if (n < MAX_BLOBS && r > 0.5) { out[n * 4] = x; out[n * 4 + 1] = y; out[n * 4 + 2] = r; out[n * 4 + 3] = s; n += 1; } };
        const local = t - cue.cue.start;
        const appear = smooth(0, 0.8, local);
        [cue.mass, cue.mass2].forEach((m, k) => {
            if (!m) return;
            const breath = 1 + 0.05 * Math.sin(local * 0.7 + k * 2.1) + bass * 0.06;
            push(m.x, m.y, m.r * breath * appear);
            m.sats.forEach((s) => {
                const a = s.phase + local * s.speed;
                push(m.x + Math.cos(a) * m.r * s.orbit, m.y + Math.sin(a) * m.r * s.orbit * 0.8, m.r * s.size * appear);
            });
        });
        (cue.drops || []).forEach((d) => {
            const [ox, oy] = wander(d, local);
            push(d.x + ox, d.y + oy, d.r * appear * (1 + bass * 0.08));
        });
        if (cloudsOut) {
            cloudsOut.fill(0);
            (cue.clouds || []).slice(0, MAX_CLOUDS).forEach((c, i) => {
                const [ox, oy] = wander(c, local);
                cloudsOut[i * 4] = c.x + ox; cloudsOut[i * 4 + 1] = c.y + oy;
                cloudsOut[i * 4 + 2] = c.r * (1 + bass * 0.05); cloudsOut[i * 4 + 3] = c.level * smooth(0, 1.2, local);
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
            if (ringCount < MAX_RINGS && tau < 1.6) {
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
        // 词开唱：字块外扩一道细墨环
        (cue.beats || []).forEach((b) => {
            const tau = t - b.t;
            if (ringCount >= MAX_RINGS || tau < 0 || tau > 0.9) return;
            rings[ringCount * 4] = b.x; rings[ringCount * 4 + 1] = b.y;
            rings[ringCount * 4 + 2] = b.r * (0.9 + 0.55 * (1 - Math.exp(-tau * 4)));
            rings[ringCount * 4 + 3] = b.r * 0.018 * (1 - tau / 0.9);
            ringCount += 1;
        });
        // 鼓点：墨团外一圈冲击环
        if (cue.mass && beatAge < 0.7 && ringCount < MAX_RINGS) {
            const m = cue.mass;
            rings[ringCount * 4] = m.x; rings[ringCount * 4 + 1] = m.y;
            rings[ringCount * 4 + 2] = m.r * (1.05 + beatAge * 1.6);
            rings[ringCount * 4 + 3] = m.r * 0.06 * (1 - beatAge / 0.7);
            ringCount += 1;
        }
        // 唱到的字甩出一对螺旋墨点，后面拖两颗小点
        (cue.sparks || []).forEach((sp) => {
            const tau = t - sp.t;
            if (tau < 0 || tau > 1.5 || n >= MAX_BLOBS - 6) return;
            for (let side = 0; side < 2; side += 1) {
                for (let k = 0; k < 3; k += 1) {
                    const tk = Math.max(0, tau - k * 0.07);
                    const reach = sp.s * (0.45 + 1.5 * (1 - Math.exp(-tk * 2.2)));
                    const ang = sp.a + side * Math.PI + sp.spin * tk;
                    const r = sp.s * (k ? 0.022 : 0.04) * (1 - tau / 1.5);
                    push(sp.x + Math.cos(ang) * reach, sp.y + Math.sin(ang) * reach * 0.8, r, 1.4);
                }
            }
        });
        let a = 0;
        accentsOut.fill(0);
        (cue.drifters || []).forEach((d) => {
            if (a >= MAX_ACCENT) return;
            const [ox, oy] = wander(d, local);
            accentsOut[a * 4] = d.x + ox; accentsOut[a * 4 + 1] = d.y + oy; accentsOut[a * 4 + 2] = d.r * appear * (1 + bass * 0.05); accentsOut[a * 4 + 3] = 1;
            a += 1;
        });
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
uniform float uKeywords;
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
uniform vec4 uRings[${MAX_RINGS}];
uniform vec4 uClouds[${MAX_CLOUDS}];
uniform vec3 uBlobCol;
uniform float uDotPx;
uniform float uDotAngle;
uniform vec4 uFlood;     // 屏幕 x, y, 半径, 0 = 不漫
uniform float uSmash;    // 0..1 上一段碎开
uniform float uCloud;    // 墨云浓度
uniform float uExit;     // 段尾：字向外散开
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
${Utils.NOISE_GLSL}
vec2 worldAt(vec4 view) {
    vec2 p = gl_FragCoord.xy / uRes - 0.5;
    vec2 q = vec2(p.x * uAspect, -p.y) * view.z;
    float c = cos(view.w), s = sin(view.w);
    return view.xy + vec2(q.x * c - q.y * s, q.x * s + q.y * c);
}
vec2 flowed(vec2 w) {
    float k = uWorld.y;
    // 手抖：一层大的慢慢推（整个字跟着弯）、一层小的抖（笔画边上起伏），每秒跳 8 格
    vec2 n = vec2(vnoise(w / (k * 0.31) + uFlow * 0.37), vnoise(w / (k * 0.31) + 17.0 - uFlow * 0.29)) - 0.5;
    vec2 m = vec2(vnoise(w / (k * 0.11) + uFlow * 1.3), vnoise(w / (k * 0.11) - 9.0 + uFlow)) - 0.5;
    return w + n * k * 0.02 + m * k * 0.007;
}

void main() {
    vec2 w = flowed(worldAt(uView));
    vec2 uv = w / uWorld;
    bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
    vec4 m = inside ? texture(uMain, uv) : vec4(0.0);
    vec2 haloRG = inside ? textureLod(uMain, uv, 4.0).rg : vec2(0.0);
    float halo = haloRG.r;
    vec4 idv = inside ? texelFetch(uIds, min(ivec2(uv * uIdSize), ivec2(uIdSize) - 1), 0) : vec4(0.0);
    int gid = int(idv.r * 255.0 + 0.5);
    float so = floor(idv.g * 255.0 + 0.5);

    float reveal = 0.0;
    float ghost = 0.0;
    float pre = 0.0;
    float swell = 0.0;
    float kw = 0.0;
    if (gid > 0) {
        vec3 se3 = texelFetch(uGlyph, ivec2(gid, 0), 0).xyz;
        vec2 se = se3.xy;
        kw = se3.z * uKeywords;
        reveal = smoothstep(se.x - 0.2, se.x + 0.1, uTime);
        // 开唱前 0.6 秒，字先以半调影子浮出来；唱到时字胀一下再收回
        pre = smoothstep(se.x - 0.7, se.x - 0.1, uTime) * (1.0 - reveal);
        float ds = uTime - se.x - 0.08;
        swell = exp(-ds * ds / 0.018);
    }
    float glyphInk = m.r * reveal;
    ghost = m.r * (1.0 - reveal) * uGhost;
    float lineOn = so > 0.5 ? smoothstep(0.0, 0.12, uTime - (uStroke.x + (so - 1.0) * uStroke.y)) : 0.0;
    float lineInk = m.g * lineOn;

    vec2 wp = w;
    float field = 0.0;
    for (int i = 0; i < ${MAX_BLOBS}; i++) {
        if (i >= uBlobCount) break;
        vec4 b = uBlobs[i];
        vec2 d = wp - b.xy;
        float dd = dot(d, d);
        // 远处的墨团贡献不到 0.2%，不算
        if (dd > b.z * b.z * 500.0) continue;
        field += b.z * b.z / (dd + 1.0) * b.w;
    }
    float ring = 0.0;
    for (int i = 0; i < ${MAX_RINGS}; i++) {
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
    // 阈值被噪点搅过：墨边像砂纸上蹭出来的，颗粒按屏幕像素算（不跟镜头放大，不会啃出大缺口），也不跟时间跳
    vec2 px = gl_FragCoord.xy / max(uRes.y / 900.0, 0.5);
    float rough = ((vnoise(px * 0.45) - 0.5) * 0.16 + (hash12(floor(px * 0.9)) - 0.5) * 0.08) * (0.5 + uGrain);
    // 字的墨只来自字形本身（不把大晕加进来，不然字会胖一圈、笔画糊在一起）；大晕只进网点的浓淡。
    // 唱到的那一下字胀一点点再收回。
    float F = glyphInk * (0.8 + swell * 0.22) + halo * reveal * swell * 0.2 + lineInk * 1.1 + field * 0.5 + ring;
    float thr = 0.5 + rough;
    // 段尾硬切之前，字从边上一块块散掉，散的方向朝外
    if (uExit > 0.0) thr += uExit * (0.25 + vnoise(wp / (k * 0.03)) * 0.9 + length(gl_FragCoord.xy / uRes - 0.5) * 0.8);
    // 边的软硬只有一个像素：按 F 在屏幕上的变化率算，大特写和小字都是干净的一刀
    float edgeW = max(fwidth(F), 0.0001) * 0.75;
    float a = smoothstep(thr - edgeW, thr + edgeW, F);
    float aA = smoothstep(0.42 + rough * 0.6, 0.52 + rough * 0.6, accent * 0.5);

    // 半调：网点格在世界里（跟着镜头放大），网点大小随浓淡
    vec2 sp = gl_FragCoord.xy / uRes - 0.5;
    // 墨云：大尺度的浓淡，每秒跳 8 格地翻涌；四角压暗；字周围的晕、墨团的场也算进浓淡
    float cl = vnoise(wp / (k * 0.42) + uFlow * 0.08) * 0.62 + vnoise(wp / (k * 0.17) - uFlow * 0.11) * 0.38;
    float cloud = smoothstep(0.5, 0.95, cl) * uCloud;
    float vig = smoothstep(0.4, 0.85, length(sp * vec2(1.0, 0.8)));
    float T = m.b * uTone + clamp(field * 0.18, 0.0, 0.35) * smoothstep(0.2, 0.0, a);
    // 网点云：几团大的灰慢慢漂，中间浓、边上平滑落到没有，挨近了连成一片
    float cloudT = 0.0;
    for (int i = 0; i < ${MAX_CLOUDS}; i++) {
        vec4 c = uClouds[i];
        if (c.w <= 0.0) continue;
        vec2 d = (wp - c.xy) / c.z;
        float q = max(0.0, 1.0 - dot(d, d));
        cloudT += q * q * c.w;
    }
    T = max(T, min(cloudT, 0.85) * uCloud);
    // 线稿两边一圈网点：线不是干干净净浮在纸上的，跟着这一笔一起出现
    T = max(T, clamp(haloRG.g * 2.6, 0.0, 0.6) * lineOn * smoothstep(0.3, 0.0, a));
    T = max(T, max(cloud * 0.72, vig * 0.6 * uCloud));
    // 字周围那团晕只取靠近笔画的那部分：编号框的边上晕已经很淡，不然框边会切出一块方的灰
    float haloNear = smoothstep(0.12, 0.6, halo);
    T = max(T, (haloNear * 1.1 + m.r * 0.5) * pre * uGhost / max(uGhost, 0.001) * 0.9);
    T = max(T, haloNear * reveal * 0.55 * uCloud);
    // 还没唱到的字只是一层网点的影子（不是一块平的灰）
    T = max(T, ghost / max(uGhost, 0.001) * 0.85 * min(1.0, uGhost * 3.0));
    // 网点格钉在屏幕上（7 个 CSS 像素一格，大特写也不会放出一颗颗大圆片），每个镜头换一个网角
    float ca = cos(uDotAngle), sa = sin(uDotAngle);
    vec2 sf = gl_FragCoord.xy / uDotPx;
    vec2 g = vec2(sf.x * ca - sf.y * sa, sf.x * sa + sf.y * ca) / 7.0;
    float dist = length(fract(g) - 0.5);
    // 最浓的地方圆点也只是刚好相连，留着格子间的纸
    float radius = sqrt(clamp(T, 0.0, 1.0)) * 0.6;
    float dots = (1.0 - smoothstep(radius - 0.13, radius + 0.13, dist)) * uHalftone * step(0.012, T);

    vec3 paper = mix(uPaper, uInk, uNeg);
    vec3 ink = mix(uInk, uPaper, uNeg);
    vec3 col = paper;
    col = mix(col, uDot, dots * 0.85);
    col = mix(col, uBlobCol, aA);
    // 灰墨团盖着还没唱到的字：字的网点影子压在它上面，照样看得见
    col = mix(col, mix(uBlobCol, ink, 0.45), dots * aA * smoothstep(0.02, 0.2, ghost + pre * (m.r + haloNear)));
    // 还没唱到的字：淡淡的墨，同样切阈值（毛边一致）
    float gF = ghost / max(uGhost, 0.001);
    float gW = max(fwidth(gF), 0.0001) * 0.75;
    float ga = smoothstep(thr - gW, thr + gW, gF) * uGhost;
    // 关键词的字身用强调色（字周围的晕仍是墨，像套色印刷压了一道黑边）
    vec3 inkK = mix(ink, uAccentCol, kw * smoothstep(0.3, 0.65, m.r));
    // 墨最后画：灰墨团漂到字上时，字压在它上面照样读得出来
    col = mix(col, inkK, max(a, ga * 0.18 * (1.0 - a)));

    if (uPrevFade > 0.0) {
        vec2 wq = flowed(worldAt(uPrevView));
        // 碎开：屏幕切成不规则的块，每块沿自己的方向飞散，一块块消失
        vec2 cell = floor(gl_FragCoord.xy / uRes.y * 5.0 + vnoise(gl_FragCoord.xy / uRes.y * 3.0) * 1.6);
        float h = hash12(cell);
        if (uSmash > 0.0) {
            vec2 dir = normalize(vec2(hash12(cell + 7.1), hash12(cell + 3.3)) - 0.5 + sp * 1.5);
            wq -= dir * uSmash * uSmash * k * (0.25 + h * 0.5);
        }
        vec2 uq = wq / uWorld;
        if (all(greaterThanEqual(uq, vec2(0.0))) && all(lessThanEqual(uq, vec2(1.0)))) {
            vec4 pm = texture(uPrev, uq);
            float ph = textureLod(uPrev, uq, 4.0).r;
            float Fp = pm.r + pm.g * 1.1;
            float breakUp = (vnoise(wq / (k * 0.05)) - 0.5) * 0.9;
            float tp = uSmash > 0.0 ? 0.5 + rough + step(1.0 - uSmash * 1.15, h) * 9.0
                                    : 0.5 + rough + uPrevFade * 1.1 + breakUp * uPrevFade;
            float pw = max(fwidth(Fp), 0.0001) * 0.75;
            float ap = smoothstep(tp - pw, tp + pw, Fp);
            col = mix(col, ink, ap * (1.0 - a));
        }
    }

    if (uFlood.w > 0.0) {
        // 墨漫：整屏是墨，从一点开一个毛边的口子，口子里是新的一段；口子边上一圈网点
        vec2 fp = (gl_FragCoord.xy / uRes - uFlood.xy) * vec2(uAspect, 1.0);
        float edge = length(fp) - uFlood.z + (vnoise(fp * 9.0 + uFlow) - 0.5) * 0.12 + (vnoise(fp * 40.0) - 0.5) * 0.03;
        float inked = smoothstep(-0.004, 0.004, edge);
        float band = (1.0 - smoothstep(0.0, 0.09, abs(edge + 0.05))) * (1.0 - inked);
        col = mix(col, ink, max(inked, band * dots));
    }
    float gr = hash12(floor(gl_FragCoord.xy / 1.5) + uGrainStep * 17.0) - 0.5;
    float fibre = vnoise(gl_FragCoord.xy / 3.0 + uGrainStep * 5.0) - 0.5;
    col *= 1.0 + (gr * 0.44 + fibre * 0.2) * uGrain;
    // 杂点：纸上是墨色的点，墨里是纸色的点（印刷没压实的地方）
    float speck = step(0.988, hash12(floor(gl_FragCoord.xy / 2.2) + uGrainStep * 3.7 + 0.5));
    col = mix(col, mix(ink, paper, a), speck * 0.55 * min(uGrain * 2.0, 1.0));
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
        const ringBuffer = new Float32Array(MAX_RINGS * 4);
        let lastOnsets = -1;
        let beatTime = -Infinity;
        const accentBuffer = new Float32Array(MAX_ACCENT * 4);
        const cloudBuffer = new Float32Array(MAX_CLOUDS * 4);
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
                cloud: clamp(tuning.cloud ?? 0.75, 0, 1),
                keywords: tuning.keywords !== false,
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
            // 漂在字上的墨团：纸和墨之间的一档灰（像印刷压的第二道专色）
            const blob = paper.map((v, i) => v + (ink[i] - v) * 0.36);
            palette = { paper, ink, accent, dot, blob };
            const css = (rgb, alpha = 1) => `rgba(${rgb.map(v => Math.round(v * 255)).join(',')},${alpha})`;
            mode.root.style.setProperty('--inkdraft-paper', css(paper));
            mode.root.style.setProperty('--inkdraft-mark', css(ink, 0.62));
        };

        const fontFamily = () => {
            const family = global.getComputedStyle?.(mode.root).fontFamily || '';
            return family || Utils.STAGE_FONT;
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
            // 字体分片还没下载完：下载完把字图作废重画（字宽变了，分镜也要重排）
            Utils.loadLyricFont(frame.lines, [500, 800], () => { glState?.slots.forEach((slot) => { slot.key = null; slot.data = null; }); redraw(); }, frame.track?.title || '');
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
                prevCue: cues[index - 1] || null,
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
            if (Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets) {
                if (lastOnsets >= 0 && frame.isPlaying && s.audioReactivity > 0) beatTime = t;
                lastOnsets = audio.onsets;
            }
            const beatAge = t >= beatTime ? t - beatTime : Infinity;
            const counts = blobsAt(data, t, blobBuffer, ringBuffer, accentBuffer, bass, s.reducedMotion ? Infinity : beatAge, cloudBuffer);

            let prevFade = 0;
            let prevSlot = null;
            let prevView = null;
            const since = t - data.cue.start;
            let smash = 0;
            if ((data.transition === 'ink' || data.transition === 'smash') && since < 0.5 && index > 0) {
                prevSlot = slotFor(index - 1, false);
                if (prevSlot) {
                    prevFade = smooth(0, 0.5, since) * 0.999 + 0.001;
                    prevView = viewAt(prevSlot.data.shots, data.cue.start - 0.001);
                    if (data.transition === 'smash') smash = clamp(since / 0.5, 0.001, 1);
                }
            }
            const flooding = data.transition === 'flood' && since >= 0 && since < 0.6 && !s.reducedMotion;
            const floodR = flooding ? 1.9 * (1 - Math.pow(1 - since / 0.6, 2.4)) : 0;

            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.useProgram(program);
            gl.bindVertexArray(vao);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.main); gl.uniform1i(u.uMain, 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, slot.ids); gl.uniform1i(u.uIds, 1);
            gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, slot.glyph); gl.uniform1i(u.uGlyph, 2);
            gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, (prevSlot || slot).main); gl.uniform1i(u.uPrev, 3);
            Utils.bindNoise(gl, u.uNoise, 4);
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
            gl.uniform4fv(u.uClouds, cloudBuffer);
            gl.uniform3fv(u.uBlobCol, palette.blob);
            gl.uniform1f(u.uDotPx, canvas.height / Math.max(1, size.h));
            gl.uniform1f(u.uDotAngle, view.angle ?? 0.26);
            gl.uniform4f(u.uFlood, data.flood[0], data.flood[1], floodR, flooding ? 1 : 0);
            gl.uniform1f(u.uSmash, smash);
            gl.uniform1f(u.uCloud, s.cloud);
            const nextSlotData = cues[index + 1] ? slotFor(index + 1, false)?.data : null;
            const exiting = !s.reducedMotion && (!nextSlotData || nextSlotData.transition === 'cut') && data.cue.kind === 'line';
            gl.uniform1f(u.uExit, exiting ? smooth(data.cue.end - 0.45, data.cue.end, t) : 0);
            // 流场每秒跳 8 格、颗粒每秒 6 格：手绘动画那种「沸腾」，不是连续流动
            const flowStep = s.reducedMotion ? 0 : Math.floor(t * 8);
            gl.uniform1f(u.uFlow, flowStep * 0.13);
            gl.uniform1f(u.uGrainStep, s.reducedMotion ? 0 : Math.floor(t * 6) % 64);
            gl.uniform3fv(u.uPaper, palette.paper);
            gl.uniform3fv(u.uInk, palette.ink);
            gl.uniform3fv(u.uAccentCol, palette.accent);
            gl.uniform1f(u.uKeywords, s.keywords ? 1 : 0);
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
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
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
