/*
 * 雾笺（fogpane）：雨夜公交车起雾的车窗。手指一笔一笔在雾上写歌词，写过的地方透出窗外的
 * 雨夜街景（楼群、霓虹、路灯、车灯、积水倒影，跟着车往前走），过一会儿雾重新漫回来；
 * 玻璃上有雨点、挂着的水珠和往下淌的水痕，淌过的地方也清出一道。
 *
 * 全部在 GPU 上按播放时间算：
 *   - 窗外：一个小程序在 1/3 分辨率的离屏图上画，生成 mipmap（雾里看到的是它的模糊档）；
 *   - 主画面：一个全屏三角形。每句歌词准备一次「指痕图」（半分辨率画布：字按手指粗细描出来）
 *     和编号图，每个字的书写时刻、字框放进一张小浮点纹理；着色器按时刻沿书写方向把字一笔扫出来，
 *     到点再按噪点让雾漫回来。每帧不往显卡传图。
 * 负载：默认每秒 30 帧（节能 24、极致 60），暂停且输入不变时不画。
 */
(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before fogpane-manager.js');

    const { clamp, seededRandom, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const RATIO = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    const ATLAS_SCALE = 0.5;
    const LINE_SLOTS = 3;
    const MAX_GLYPHS = 255;
    const FOG_HOLD = 4.5;
    const FOG_RETURN = 3.2;
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    const HAND_CJK = '"KaiTi", "STKaiti", "Kaiti SC", "BiauKai", "AR PL UKai CN", serif';
    const HAND_LATIN = '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';

    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const luminance = c => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

    /* ───────────────────────── 排版：每句写在窗上的位置 ───────────────────────── */

    const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

    // 整首一次排好（只用 measureText），和准备顺序无关：拖进度到哪都一样。
    const planSong = (lines, W, H, fontScale, measure, seedKey) => {
        const sung = lines.filter(line => readableText(line.fullText));
        const placed = [];
        sung.forEach((line, index) => {
            const random = seededRandom(`fogpane:${seedKey}:${index}`);
            const glyphs = buildGlyphTimeline(line)
                .map(g => ({ text: g.text, start: g.startTime, end: g.endTime }));
            const visible = glyphs.filter(g => g.text.trim());
            if (!visible.length) return;
            const cjk = visible.filter(g => CJK.test(g.text)).length / visible.length > 0.5;
            const n = visible.length;
            const perRow = cjk ? 9 : 20;
            const rows = Math.min(3, Math.max(1, Math.ceil(n / perRow)));
            // 字号：一行占窗宽六成上下，手写的字不会太整齐
            const base = clamp((W * (0.4 + random() * 0.14)) / Math.ceil(n / rows) / (cjk ? 1 : 0.55), H * 0.055, H * 0.13) * fontScale;
            // 按行切开（拉丁字母在空格处换行）
            const rowsOf = [];
            let row = [];
            glyphs.forEach((g, i) => {
                row.push(g);
                const count = row.filter(x => x.text.trim()).length;
                const target = Math.ceil(n / rows);
                const breakable = cjk || !g.text.trim();
                if (rowsOf.length < rows - 1 && count >= target && breakable) { rowsOf.push(row); row = []; }
                else if (i === glyphs.length - 1) rowsOf.push(row);
            });
            if (row.length && !rowsOf.includes(row)) rowsOf.push(row);
            const items = [];
            let width = 0;
            // 三种写法：一两行；大小不一（有的词写得大）；竖着一列列往下写（从右往左）
            const style = cjk && n <= 14 && random() < 0.28 ? 'vertical' : random() < 0.42 ? 'mixed' : 'rows';
            if (style === 'vertical') {
                const cols = n > 7 ? 2 : 1;
                const perCol = Math.ceil(n / cols);
                const size = clamp(H * 0.5 / perCol, H * 0.05, H * 0.11) * fontScale;
                let k = 0;
                visible.forEach((g) => {
                    const col = Math.floor(k / perCol), row = k % perCol;
                    const w = measure(g.text, size, CJK.test(g.text));
                    items.push({ g, x: (cols - 1 - col) * size * 1.45 + (size - w) / 2 + (random() - 0.5) * size * 0.1, row: 0, w,
                        size: size * (0.92 + random() * 0.16), rot: (random() - 0.5) * 0.1, dy: 0,
                        by: (row + 0.85) * size * 1.08 + col * size * 0.5 });
                    k += 1;
                });
                width = cols * size * 1.45;
            }
            const sizes = style === 'mixed' ? rowsOf.map(r => r.map(() => 1)) : null;
            if (sizes) {
                // 每 1~3 个字一个词块，词块放大或缩小
                rowsOf.forEach((r, ri) => {
                    let left = 0, k = 1;
                    r.forEach((g, gi) => {
                        if (left <= 0) { left = 1 + Math.floor(random() * 3); k = random() < 0.35 ? 1.35 + random() * 0.2 : 0.72 + random() * 0.2; }
                        sizes[ri][gi] = k;
                        left -= 1;
                    });
                });
            }
            if (style !== 'vertical') rowsOf.forEach((r, ri) => {
                let x = (random() - 0.5) * base * 0.6 + ri * base * (random() * 0.5);
                r.forEach((g, gi) => {
                    const k = sizes ? sizes[ri][gi] : 1;
                    const w = g.text.trim() ? measure(g.text, base * k, CJK.test(g.text)) : base * (cjk ? 0.5 : 0.32);
                    if (g.text.trim()) {
                        items.push({ g, x, row: ri, w, size: base * k * (0.92 + random() * 0.16),
                            rot: (random() - 0.5) * 0.12, dy: (random() - 0.5) * base * 0.12 + (k - 1) * base * 0.3 });
                    }
                    x += w * (cjk ? 1.02 : 1);
                });
                width = Math.max(width, x);
            });
            const height = style === 'vertical' ? Math.max(...items.map(it => it.by + it.size * 0.3)) : rowsOf.length * base * 1.25 * (sizes ? 1.2 : 1);
            // 找一个和前两句重叠最少的地方（窗的安全区里）
            const safe = [W * 0.08, H * 0.16, W * 0.92, H * 0.76];
            let best = null;
            for (let k = 0; k < 16; k += 1) {
                const x0 = safe[0] + random() * Math.max(1, safe[2] - safe[0] - width);
                const y0 = safe[1] + random() * Math.max(1, safe[3] - safe[1] - height);
                const box = [x0, y0, x0 + width, y0 + height];
                const cost = placed.slice(-2).reduce((s, p, j) => s + overlap(box, p.box) * (j === placed.slice(-2).length - 1 ? 2 : 1), 0);
                if (!best || cost < best.cost) best = { box, cost };
            }
            const [bx, by] = best.box;
            items.forEach((it) => {
                it.x += bx;
                it.baseline = it.by !== undefined ? by + it.by : by + (it.row + 0.85) * base * 1.25 * (sizes ? 1.2 : 1) + it.dy;
                it.box = [it.x - it.size * 0.08, it.baseline - it.size * 0.9, it.x + it.w + it.size * 0.08, it.baseline + it.size * 0.18];
            });
            const end = Math.max(line.endTime, line.vocalEndTime || 0, ...items.map(it => it.g.end));
            placed.push({ index, line, items, box: best.box, start: line.startTime, end, cjk });
        });
        // 雾什么时候漫回来：唱完后停一会儿；后面的句子要写到它的位置上时提前漫（让位），
        // 第三句开写时最晚也要开始漫。
        placed.forEach((p, i) => {
            let back = p.end + FOG_HOLD;
            const third = placed[i + 3];
            if (third) back = Math.min(back, third.start - FOG_RETURN * 0.5);
            for (const q of placed.slice(i + 1, i + 3)) {
                if (overlap(p.box, q.box) > 0) back = Math.min(back, q.start - FOG_RETURN * 0.6);
            }
            p.fogBack = Math.max(back, p.end + 0.3);
        });
        return placed;
    };

    /* ───────────────────────── GL ───────────────────────── */

    const VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    const COMMON = `
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}
${Utils.NOISE_GLSL}`;

    // 窗外：x 按窗宽高比，y 朝上 0..1。车往前开，近处的东西走得快。
    const SCENE_FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uAspect;
uniform float uT;
uniform float uBump;
uniform vec3 uSky;
uniform vec3 uBld;
uniform vec3 uWin;
uniform vec3 uNeon;
uniform vec3 uNeon2;
uniform vec3 uLamp;
uniform float uRain;
uniform float uSnow;
uniform float uAqua;
out vec4 outColor;
${COMMON}
float disc(vec2 p, vec2 c, float r) {
    float d = length(p - c) / r;
    return smoothstep(1.0, 0.7, d) * (0.75 + 0.25 * smoothstep(0.6, 1.0, d));
}
vec3 lights(vec2 p, float horizonY) {
    vec3 col = vec3(0.0);
    // 霓虹招牌的光斑（中景）
    float x = p.x + uT * 0.16;
    float cw = 0.34;
    float c = floor(x / cw);
    for (int k = -1; k <= 1; k++) {
        float id = c + float(k);
        vec2 h = hash22(vec2(id, 3.0));
        if (h.x < 0.25) continue;
        vec2 center = vec2((id + 0.2 + h.y * 0.6) * cw - uT * 0.16, horizonY + 0.14 + h.x * 0.32);
        float r = 0.032 + 0.04 * hash12(vec2(id, 9.0));
        vec3 tint = hash12(vec2(id, 5.0)) < 0.55 ? uNeon : uNeon2;
        col += tint * disc(p, center, r) * 1.1;
    }
    // 路灯（近处，走得快，大光斑）
    x = p.x + uT * 0.7;
    cw = 0.95;
    c = floor(x / cw);
    for (int k = -1; k <= 1; k++) {
        float id = c + float(k);
        vec2 center = vec2((id + 0.5) * cw - uT * 0.7, 0.8 + hash12(vec2(id, 1.0)) * 0.06);
        col += uLamp * disc(p, center, 0.095) * 1.05;
    }
    // 对面车道的车灯（往反方向走）和同向的尾灯
    x = p.x - uT * 0.42;
    cw = 0.55;
    c = floor(x / cw);
    for (int k = -1; k <= 1; k++) {
        float id = c + float(k);
        if (hash12(vec2(id, 7.0)) < 0.4) continue;
        float cx = (id + 0.3) * cw + uT * 0.42;
        col += vec3(1.0, 0.95, 0.85) * (disc(p, vec2(cx, horizonY - 0.03), 0.018) + disc(p, vec2(cx + 0.06, horizonY - 0.03), 0.018)) * 0.9;
    }
    x = p.x + uT * 0.09;
    cw = 0.7;
    c = floor(x / cw);
    for (int k = -1; k <= 1; k++) {
        float id = c + float(k);
        if (hash12(vec2(id, 11.0)) < 0.5) continue;
        float cx = (id + 0.4) * cw - uT * 0.09;
        col += vec3(1.0, 0.15, 0.1) * (disc(p, vec2(cx, horizonY - 0.07), 0.013) + disc(p, vec2(cx + 0.09, horizonY - 0.07), 0.013)) * 0.85;
    }
    return col;
}
vec3 street(vec2 p) {
    float horizonY = 0.26;
    // 天：城市的光把低处的云照亮
    vec3 col = mix(uSky * 1.7 + vec3(0.07, 0.05, 0.04), uSky * 0.7, smoothstep(0.25, 1.0, p.y));
    // 远处楼群（慢）和近一层楼（快一点），亮着的窗
    for (int layer = 0; layer < 2; layer++) {
        float speed = layer == 0 ? 0.035 : 0.1;
        float cw = layer == 0 ? 0.16 : 0.27;
        float x = p.x + uT * speed;
        float c = floor(x / cw);
        float h = horizonY + (layer == 0 ? 0.3 : 0.18) + hash12(vec2(c, float(layer) * 13.0)) * (layer == 0 ? 0.4 : 0.36);
        if (p.y < h) {
            vec2 local = vec2(fract(x / cw), (p.y - horizonY) / (h - horizonY));
            vec3 b = uBld * (layer == 0 ? 0.75 : 1.0);
            vec2 w = floor(local * vec2(5.0, 14.0));
            float lit = step(0.8, hash12(w + c * 7.0 + float(layer) * 31.0));
            vec2 f = fract(local * vec2(5.0, 14.0));
            float pane = step(0.3, f.x) * step(f.x, 0.7) * step(0.3, f.y) * step(f.y, 0.7);
            col = b + uWin * lit * pane * (layer == 0 ? 0.55 : 0.8);
        }
    }
    // 马路：湿的，倒着映出灯
    if (p.y < horizonY) {
        col = uBld * 0.5;
        vec2 q = vec2(p.x, horizonY * 2.0 - p.y);
        float fade = smoothstep(0.0, horizonY, p.y);
        col += lights(q + vec2(sin(p.y * 90.0 + uT * 2.0) * 0.004, 0.0), horizonY) * 0.35 * (0.4 + 0.6 * fade);
    }
    col += lights(p, horizonY);
    // 窗外的雨丝
    float rx = floor(p.x * 140.0);
    float ry = fract(p.y * 1.6 + uT * (1.4 + hash12(vec2(rx, 2.0))) + hash12(vec2(rx, 4.0)));
    col += vec3(0.6, 0.65, 0.75) * step(0.93, hash12(vec2(rx, 8.0))) * smoothstep(0.08, 0.0, ry) * 0.18 * uRain;
    // 下雪：三层雪片，近的大、快、斜着飘
    if (uSnow > 0.0) {
        for (int L = 0; L < 3; L++) {
            float fl = float(L);
            float scale = 18.0 + fl * 14.0;
            vec2 sp = p * scale + vec2(uT * (2.0 - fl * 0.5) + sin(p.y * 3.0 + uT * 0.7 + fl) * 0.6, uT * (3.4 - fl * 0.9));
            vec2 cell = floor(sp);
            vec2 h = hash22(cell + fl * 19.0);
            vec2 f = fract(sp) - (0.25 + h * 0.5);
            float flake = smoothstep(0.12 - fl * 0.03, 0.0, length(f)) * step(0.55, h.x);
            col += vec3(0.85, 0.88, 0.95) * flake * (0.55 - fl * 0.12) * uSnow;
        }
        col = mix(col, vec3(0.75, 0.78, 0.85), smoothstep(0.26, 0.0, p.y) * 0.35 * uSnow);
    }
    return col;
}
// 水族馆：车停在一面大鱼缸前。顶上漏下来的光柱、水母、气泡、远处的鱼群、水草和沙底
vec3 aquarium(vec2 p) {
    float t = uT * 0.35;
    vec3 deep = vec3(0.005, 0.02, 0.05) + uSky * 0.15;
    vec3 shallow = vec3(0.03, 0.2, 0.3) + uNeon2 * 0.06;
    vec3 col = mix(deep, shallow, smoothstep(0.0, 1.05, p.y));
    // 光柱：斜着从水面落下，慢慢晃
    float rays = 0.0;
    for (int k = 0; k < 3; k++) {
        float fk = float(k);
        float x = (p.x + p.y * (0.32 + fk * 0.05)) * (5.0 + fk * 3.0) + sin(p.x * 1.7 + t * (0.4 + fk * 0.13) + fk) * 1.4 + t * 0.2;
        rays += pow(0.5 + 0.5 * sin(x), 8.0 + fk * 4.0) * (0.5 - fk * 0.12);
    }
    col += vec3(0.35, 0.62, 0.7) * rays * smoothstep(0.05, 1.0, p.y) * 0.6;
    // 缸顶的灯：水面上一团亮
    vec2 ld = (p - vec2(uAspect * 0.62, 1.08)) * vec2(0.6, 1.0);
    col += vec3(0.55, 0.85, 0.9) * exp(-dot(ld, ld) * 7.0) * 0.55;
    // 水面的亮纹
    float surf = smoothstep(0.86, 1.0, p.y) * (0.5 + 0.5 * sin(p.x * 22.0 + sin(p.x * 7.0 + t * 1.3) * 2.0 + t));
    col += vec3(0.4, 0.75, 0.8) * surf * 0.18;
    // 远处的鱼群：一小片暗影，整群慢慢游过去
    for (int L = 0; L < 2; L++) {
        float fl = float(L);
        float speed = 0.05 + fl * 0.04;
        vec2 sp = vec2((p.x + uT * speed) * (26.0 - fl * 8.0), (p.y - 0.42 - fl * 0.12 + sin(p.x * 2.0 + t) * 0.03) * (26.0 - fl * 8.0));
        vec2 cell = floor(sp);
        float school = smoothstep(0.55, 0.75, vnoise(vec2(cell.x * 0.12 + fl * 7.0, cell.y * 0.4)));
        vec2 f = fract(sp) - 0.5;
        f.y += (hash12(cell + fl) - 0.5) * 0.3;
        float body = smoothstep(0.08, 0.0, length(f * vec2(0.9, 2.6)) - 0.12);
        float tail = step(f.x, -0.2) * step(abs(f.y), (-0.2 - f.x) * 0.9) * step(-0.38, f.x);
        float fish = max(body, tail) * school * step(abs(sp.y), 3.0);
        col = mix(col, deep * (0.7 + fl * 0.4) + uNeon2 * 0.03, fish * (0.55 + fl * 0.2));
    }
    // 水草：几簇深色的带子，随水摆
    for (int k = 0; k < 6; k++) {
        float fk = float(k);
        float bx = (hash12(vec2(fk, 41.0)) * 1.1 - 0.05) * uAspect;
        float hgt = 0.28 + hash12(vec2(fk, 43.0)) * 0.32;
        float sway = sin(p.y * 6.0 + t * 1.4 + fk * 1.7) * 0.03 * p.y / hgt;
        float w = 0.012 * (1.0 - p.y / hgt * 0.7);
        float blade = smoothstep(w, w * 0.4, abs(p.x - bx - sway)) * step(p.y, hgt);
        col = mix(col, vec3(0.02, 0.09, 0.07), blade * 0.85);
    }
    // 沙底和岩：沙上一层晃动的焦散网
    float ground = 0.09 + vnoise(vec2(p.x * 3.0, 1.0)) * 0.06 + vnoise(vec2(p.x * 11.0, 2.0)) * 0.02;
    if (p.y < ground) {
        vec2 cq = p * 9.0;
        float c1 = abs(vnoise(cq + vec2(t * 0.6, t * 0.3)) - 0.5);
        float c2 = abs(vnoise(cq * 1.7 - vec2(t * 0.4, -t * 0.5)) - 0.5);
        float caust = pow(1.0 - min(c1, c2) * 2.0, 10.0);
        col = mix(vec3(0.07, 0.11, 0.13), vec3(0.16, 0.22, 0.24), smoothstep(0.0, ground, p.y)) + vec3(0.4, 0.7, 0.75) * caust * 0.3;
    }
    // 水母：伞盖一张一缩往上漂，触须拖在后面
    for (int i = 0; i < 5; i++) {
        float fi = float(i);
        vec2 h = hash22(vec2(fi, 17.0));
        float size = 0.07 + h.y * 0.08;
        float rise = 0.015 + h.x * 0.012;
        vec2 c = vec2(fract(h.x * 3.1 + sin(uT * 0.05 + fi) * 0.04) * uAspect,
                      fract(h.y + uT * rise) * 1.5 - 0.2);
        float pulse = sin(uT * (1.4 + h.x * 0.6) + fi * 2.3);
        vec2 q = (p - c) / size;
        q.x *= 1.0 + pulse * 0.1;
        q.y *= 1.0 - pulse * 0.08;
        vec3 tint = mix(vec3(1.0, 0.5, 0.82), vec3(0.4, 0.85, 1.0), step(0.5, hash12(vec2(fi, 23.0))));
        tint = mix(tint, uNeon2, 0.2);
        // 伞盖：半个椭圆，边上亮
        float d = length(q * vec2(1.0, 1.3));
        float bell = smoothstep(1.0, 0.85, d) * smoothstep(-0.25, 0.05, q.y);
        float rim = smoothstep(0.7, 1.0, d) * bell;
        float glow = exp(-d * d * 1.2) * 0.35;
        // 触须
        float tent = 0.0;
        for (int k = 0; k < 4; k++) {
            float ox = (float(k) - 1.5) * 0.32;
            float tx = q.x - ox - sin(q.y * 2.2 - uT * 2.0 + fi + float(k)) * 0.18 * (-q.y) * 0.4;
            tent += smoothstep(0.06, 0.0, abs(tx)) * smoothstep(-3.2 - h.x, -0.2, q.y) * step(q.y, -0.1);
        }
        float a = bell * 0.55 + rim * 0.9 + tent * 0.5;
        col += tint * (a * 1.3 + glow * 1.6 + exp(-d * d * 0.18) * 0.18);
    }
    // 气泡：三串，从底下冒上来，越往上越大
    for (int sIdx = 0; sIdx < 3; sIdx++) {
        float fs = float(sIdx);
        float sx = (0.18 + hash12(vec2(fs, 61.0)) * 0.7) * uAspect;
        for (int b = 0; b < 8; b++) {
            float fb = float(b);
            float y = fract(fb * 0.137 + hash12(vec2(fs, fb)) * 0.3 + uT * (0.09 + fs * 0.02));
            vec2 c = vec2(sx + sin(y * 12.0 + fb * 2.0 + uT) * 0.015, y * 1.1 - 0.05);
            float r = 0.004 + y * 0.008 + hash12(vec2(fb, fs + 5.0)) * 0.004;
            float dd = length(p - c);
            float ring = smoothstep(r * 0.35, 0.0, abs(dd - r)) * 0.6 + smoothstep(r * 0.5, 0.0, length(p - c - vec2(-r, r) * 0.4)) * 0.6;
            col += vec3(0.75, 0.92, 1.0) * ring * 0.5;
        }
    }
    // 缸里浮着的微尘
    vec2 dp = p * 60.0 + vec2(uT * 0.3, uT * 0.5);
    float dust = step(0.985, hash12(floor(dp))) * smoothstep(0.35, 0.0, length(fract(dp) - 0.5));
    col += vec3(0.6, 0.8, 0.85) * dust * 0.25;
    return col;
}
void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    vec2 p = vec2(uv.x * uAspect, uv.y + uBump);
    vec3 col = vec3(0.0);
    if (uAqua < 1.0) col = street(p);
    if (uAqua > 0.0) col = mix(col, aquarium(vec2(uv.x * uAspect, uv.y)), uAqua);
    outColor = vec4(col, 1.0);
}`;

    const MAIN_FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uScene;
uniform sampler2D uAtlas0;
uniform sampler2D uAtlas1;
uniform sampler2D uAtlas2;
uniform sampler2D uData0;
uniform sampler2D uData1;
uniform sampler2D uData2;
uniform vec4 uLine[${LINE_SLOTS}];   // fogBack, 有效, 种子, 0
uniform vec2 uRes;
uniform vec2 uAtlasSize;
uniform float uTime;
uniform vec4 uDrips[6];   // x, 开始时刻, 速度, 种子
uniform float uDripTop[6]; // 从哪儿开始淌（字底下的积水，或窗顶）
uniform vec4 uSpot;      // 正在写的字：x, y, 半径, 强度
uniform vec3 uBreath;    // 停唱时对着窗呵一口气：x, y, 浓度
uniform float uFireflies;
uniform float uFrost;
uniform float uAquaMain;
uniform int uDripCount;
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform float uDrops;
uniform float uGrain;
uniform float uGrainStep;
out vec4 outColor;
${COMMON}

// 一句歌词在这个像素擦掉了多少雾
float written(sampler2D atlas, sampler2D data, vec4 info, vec2 uv) {
    if (info.y < 0.5) return 0.0;
    vec2 au = vec2(uv.x, 1.0 - uv.y);
    float cov = texture(atlas, au).r;
    if (cov < 0.01) return 0.0;
    int id = int(texelFetch(atlas, min(ivec2(au * uAtlasSize), ivec2(uAtlasSize) - 1), 0).g * 255.0 + 0.5);
    if (id <= 0) return 0.0;
    vec4 tw = texelFetch(data, ivec2(id, 0), 0);
    vec4 box = texelFetch(data, ivec2(id, 1), 0);
    // 书写方向：从左上往右下扫（大多数字的笔顺大致如此）
    vec2 local = (au - box.xy) / max(box.zw - box.xy, vec2(1e-4));
    float s = clamp(dot(local, vec2(0.42, 0.58)) + (vnoise(local * 6.0 + info.z) - 0.5) * 0.18, 0.0, 1.0);
    float prog = clamp((uTime - tw.x) / max(tw.y, 0.05), 0.0, 1.0) * 1.12;
    float w = cov * smoothstep(s - 0.08, s, prog);
    // 雾漫回来：边上先回，一块一块地
    float n = vnoise(uv * vec2(9.0, 6.0) + info.z) * 0.6 + vnoise(uv * 40.0) * 0.4;
    float back = smoothstep(info.x, info.x + ${FOG_RETURN.toFixed(1)}, uTime + (n - 0.5) * 2.2 + (1.0 - cov) * 0.8);
    return w * (1.0 - back);
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    // 玻璃上的水珠：一格一颗，过一阵换个地方
    vec2 grid = vec2(uRes.x / uRes.y * 26.0, 26.0);
    vec2 cell = floor(uv * grid);
    float period = 14.0;
    float phase = hash12(cell) * period;
    float round_ = floor((uTime + phase) / period);
    vec2 jitter = hash22(cell + round_ * 17.0);
    vec2 centre = (cell + 0.2 + jitter * 0.6) / grid;
    float life = fract((uTime + phase) / period);
    float big = step(0.93, hash12(cell + round_ * 5.0));
    float radius = (0.0022 + hash12(cell + round_ * 3.0) * 0.005 + big * 0.007) * step(0.62, hash12(cell + round_)) * smoothstep(0.0, 0.03, life) * (1.0 - smoothstep(0.85, 1.0, life));
    vec2 d = (uv - centre) * vec2(uRes.x / uRes.y, 1.0);
    float dl = length(d);
    float drop = radius > 0.0 ? smoothstep(radius, radius * 0.8, dl) * uDrops : 0.0;
    vec2 refract = drop > 0.0 ? -d / max(radius, 1e-4) * 0.035 : vec2(0.0);

    // 往下淌的水：走过的地方清出一道，慢慢又起雾
    float trail = 0.0;
    float bead = 0.0;
    for (int i = 0; i < 6; i++) {
        if (i >= uDripCount) break;
        vec4 dr = uDrips[i];
        // 离这道水痕横向超过 0.03 屏宽的像素，水痕和水头都碰不到
        if (abs(uv.x - dr.x) > 0.03) continue;
        float x = dr.x + sin(uv.y * 23.0 + dr.w * 6.0) * 0.004 + sin(uv.y * 61.0 + dr.w) * 0.0015;
        float top = uDripTop[i];
        float headY = top - (uTime - dr.y) * dr.z;
        float dx = abs(uv.x - x) * uRes.x / uRes.y;
        if (uv.y >= headY && uv.y <= top) {
            float passed = uTime - (dr.y + (top - uv.y) / dr.z);
            trail = max(trail, smoothstep(0.0032, 0.0012, dx) * exp(-passed / 7.0));
        }
        float hb = length(vec2(dx, (uv.y - headY) * 0.8));
        bead = max(bead, smoothstep(0.006, 0.004, hb));
    }

    float wipe = max(max(written(uAtlas0, uData0, uLine[0], uv), written(uAtlas1, uData1, uLine[1], uv)), written(uAtlas2, uData2, uLine[2], uv));
    wipe = max(wipe, trail * 0.85);

    vec3 blurred = textureLod(uScene, uv + refract * 0.4, 4.2).rgb;
    float grainy = vnoise(uv * vec2(uRes.x / uRes.y, 1.0) * 180.0) - 0.5;
    float clumps = vnoise(uv * vec2(uRes.x / uRes.y, 1.0) * 7.0);
    // 雾里的灯：除了透过来的模糊光斑，再往外晕开一大圈
    vec3 wide = textureLod(uScene, uv, 6.2).rgb;
    vec3 fog = mix(blurred * 1.15, uFogCol, uFogDensity * (0.78 + clumps * 0.22)) + grainy * 0.025 + blurred * 0.25 + max(wide - uFogCol * 0.6, 0.0) * 0.45;
    vec3 clear = textureLod(uScene, uv + refract, 0.4).rgb * 1.3;
    vec3 col = mix(fog, clear, wipe);
    // 指痕边上积着一圈水，亮一点
    float rim = wipe * (1.0 - wipe) * 4.0;
    col += rim * 0.06 + rim * blurred * 0.25;
    // 水珠：透过它看到的窗外是倒着、清楚的，带一个高光
    col = mix(col, clear * 1.2 + fog * 0.45, drop * 0.8);
    col += drop * smoothstep(radius * 0.5, 0.0, length(d + vec2(radius * 0.35, -radius * 0.35))) * 0.35;
    col = mix(col, clear * 1.2 + fog * 0.5, bead * 0.9);
    // 呵气：一团白雾慢慢晕开，把附近写过的字也蒙上
    if (uBreath.z > 0.0) {
        vec2 bd = (uv - uBreath.xy) * vec2(uRes.x / uRes.y * 0.75, 1.0);
        float edge = vnoise(uv * 7.0 + uTime * 0.2) * 0.12;
        float b = smoothstep(0.34 + edge, 0.05, length(bd)) * uBreath.z;
        col = mix(col, uFogCol * 1.22 + blurred * 0.3, b * 0.75);
    }
    // 窗外飘着几只萤火（透过写开的地方看得更清楚）
    if (uFireflies > 0.0) {
        for (int i = 0; i < 7; i++) {
            float fi = float(i);
            vec2 c = vec2(fract(0.13 + fi * 0.37 + sin(uTime * 0.07 + fi * 2.1) * 0.08 + uTime * 0.004),
                          0.25 + fract(fi * 0.53) * 0.5 + sin(uTime * 0.31 + fi * 4.0) * 0.05);
            vec2 fd = (uv - c) * vec2(uRes.x / uRes.y, 1.0);
            float blink = smoothstep(0.2, 1.0, sin(uTime * (0.9 + fract(fi * 0.71)) + fi * 3.0));
            float g = exp(-dot(fd, fd) * mix(9000.0, 60000.0, wipe)) * blink;
            col += mix(vec3(1.0, 0.86, 0.4), vec3(0.45, 0.9, 1.0), uAquaMain) * g * mix(0.35, 1.1, wipe) * uFireflies;
        }
    }
    // 结霜：窗四角长出冰花，冰花上写不开
    if (uFrost > 0.0) {
        vec2 e = min(uv, 1.0 - uv) * vec2(uRes.x / uRes.y, 1.0);
        float edge = min(e.x, e.y);
        float n = vnoise(uv * 14.0) * 0.6 + vnoise(uv * 60.0) * 0.4;
        float hf = vnoise(gl_FragCoord.xy / 1.6) * 0.5 + vnoise(gl_FragCoord.xy / 5.0) * 0.5;
        float band = smoothstep(0.16 + n * 0.12, 0.0, edge) * uFrost;
        col = mix(col, vec3(0.82, 0.86, 0.93) * (0.72 + hf * 0.32), band * 0.62);
        float glint = step(0.996, hash12(floor(gl_FragCoord.xy / 2.0))) * band;
        col += vec3(0.9, 0.95, 1.0) * glint * 0.5;
    }
    // 大水珠边上一圈暗边（折射把背景压进去）
    col *= 1.0 - big * drop * smoothstep(radius * 0.55, radius, dl) * 0.45;
    // 正在写的那个字：指尖那一带的雾被呵暖，透出一点窗外的光
    if (uSpot.w > 0.0) {
        vec2 sd = (uv - uSpot.xy) * vec2(uRes.x / uRes.y, 1.0);
        float spot = exp(-dot(sd, sd) / (uSpot.z * uSpot.z)) * uSpot.w;
        col += (clear * 0.22 + vec3(1.0, 0.86, 0.66) * 0.05) * spot;
    }
    col += (hash12(floor(gl_FragCoord.xy / 1.5) + uGrainStep * 13.0) - 0.5) * 0.03 * uGrain;
    // 窗框四周暗一点
    vec2 v = uv - 0.5;
    col *= 1.0 - dot(v, v) * 0.55;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    const compile = (gl, type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`[fogpane] shader: ${gl.getShaderInfoLog(shader)}`);
        return shader;
    };
    const link = (gl, frag) => {
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
        gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`[fogpane] link: ${gl.getProgramInfoLog(program)}`);
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i += 1) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
        }
        return { program, uniforms };
    };
    const createGl = (canvas) => {
        const gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default'
        });
        if (!gl) return null;
        const scene = link(gl, SCENE_FRAG);
        const main = link(gl, MAIN_FRAG);
        const vao = gl.createVertexArray();
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        const texture = (filter, mip = false) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const sceneTex = texture(gl.LINEAR, true);
        const fbo = gl.createFramebuffer();
        // 一个空槽：没有句子时绑它
        const blank = texture(gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        const blankData = texture(gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 2, 0, gl.RGBA, gl.FLOAT, new Float32Array(8));
        const slots = Array.from({ length: LINE_SLOTS + 1 }, () => ({ atlas: texture(gl.LINEAR), data: texture(gl.NEAREST), key: null, used: 0 }));
        return { gl, scene, main, vao, sceneTex, fbo, sceneSize: [0, 0], blank, blankData, slots };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('fogpane', '雾笺', container, services);
        const canvas = createElement('canvas', 'fogpane-canvas');
        const kicker = createElement('div', 'fogpane-kicker', '雾笺');
        const translation = createElement('div', 'stage-translation fogpane-translation');
        const notice = createElement('div', 'fogpane-notice');
        notice.hidden = true;
        mode.root.append(canvas, kicker, translation, notice);

        const atlasCanvas = document.createElement('canvas');
        const measureCtx = document.createElement('canvas').getContext('2d');
        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，雾笺画不出来，请换一个舞台';
        }

        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        let plan = [];
        let planFor = null;
        let world = { W: 0, H: 0 };
        let paused = false;
        let latestFrame = null;
        let lastDraw = -Infinity;
        let colours = null;
        let caption = '';
        let lastTranslation = '';
        let lostContext = false;
        let idleHandle = 0;
        const stats = { builds: 0, buildMs: 0, draws: 0, visible: 0 };
        const dripBuffer = new Float32Array(24);
        const dripTop = new Float32Array(6);

        const settings = () => {
            const tuning = mode.config.modes?.fogpane || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                fog: clamp(tuning.fog ?? 1, 0.5, 1.5),
                drops: tuning.drops !== false,
                fireflies: clamp(tuning.fireflies ?? 1, 0, 2),
                drips: tuning.drips !== false,
                rain: tuning.rain || 'light',
                view: ['street', 'aquarium', 'alternate'].includes(tuning.view) ? tuning.view : 'alternate',
                cameraSpeed: clamp(tuning.cameraSpeed ?? 1, 0.55, 1.85),
                grain: clamp(tuning.grain ?? 0.4, 0, 1),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: Boolean(reducedMotion?.matches),
                quality: mode.config.quality || 'standard'
            };
        };

        // 主题 → 窗外夜色：背景压暗当天空和楼，强调色当霓虹
        const readColours = () => {
            const p = services?.app?.stagePalette || {};
            const light = Boolean(p.light);
            const bg = hexRgb(p.background, light ? [0.95, 0.94, 0.9] : [0.09, 0.1, 0.11]);
            const accent = hexRgb(p.accent, [0.95, 0.66, 0]);
            const secondary = hexRgb(p.secondary, [0.46, 0.75, 0.68]);
            const night = luminance(bg) > 0.4 ? mixRgb(bg, [0.05, 0.06, 0.1], 0.86) : mixRgb(bg, [0.04, 0.05, 0.09], 0.4);
            colours = {
                sky: mixRgb(night, [0.12, 0.13, 0.2], 0.4),
                bld: mixRgb(night, [0.07, 0.08, 0.11], 0.4),
                win: [1.0, 0.82, 0.55],
                neon: accent,
                neon2: secondary,
                lamp: [1.0, 0.78, 0.5],
                // 雾：浅色主题是白雾，深色主题是被车里灯光照着的灰雾
                fog: light ? mixRgb(bg, [0.86, 0.88, 0.9], 0.5) : mixRgb([0.36, 0.39, 0.43], night, 0.25),
                light
            };
            const css = (rgb, a = 1) => `rgba(${rgb.map(v => Math.round(v * 255)).join(',')},${a})`;
            mode.root.style.setProperty('--fogpane-mark', light ? 'rgba(30,34,40,0.62)' : 'rgba(236,240,245,0.66)');
            mode.root.style.setProperty('--fogpane-bg', css(colours.fog));
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
            if (glState) {
                const sw = Math.max(16, Math.round(bw / 3)), sh = Math.max(16, Math.round(bh / 3));
                if (glState.sceneSize[0] !== sw || glState.sceneSize[1] !== sh) {
                    const { gl } = glState;
                    gl.bindTexture(gl.TEXTURE_2D, glState.sceneTex);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                    gl.generateMipmap(gl.TEXTURE_2D);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, glState.fbo);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, glState.sceneTex, 0);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    glState.sceneSize = [sw, sh];
                }
            }
            // 指痕图按 CSS 像素的一半，宽高比跟窗口；比例变了才整首重排
            const W = Math.round(Math.min(1600, w) * ATLAS_SCALE * 2) / 2 | 0;
            const H = Math.round(W * h / w);
            if (Math.abs(W - world.W) > 8 || Math.abs(H - world.H) > 8) {
                world = { W: Math.max(64, W), H: Math.max(36, H) };
                atlasCanvas.width = world.W; atlasCanvas.height = world.H;
                planFor = null;
                glState?.slots.forEach((slot) => { slot.key = null; });
            }
        };

        const fontFor = (size, cjk) => `400 ${size.toFixed(1)}px ${cjk ? HAND_CJK : HAND_LATIN}`;
        const measure = (text, size, cjk) => { measureCtx.font = fontFor(size, cjk); return measureCtx.measureText(text).width; };

        const ensurePlan = (frame) => {
            const s = settings();
            const key = `${frame.track?.path || frame.track?.title || ''}|${world.W}x${world.H}|${s.fontScale}`;
            if (planFor && planFor.lines === frame.lines && planFor.key === key) return;
            plan = planSong(frame.lines || [], world.W, world.H, s.fontScale, measure, key);
            planFor = { lines: frame.lines, key };
            glState?.slots.forEach((slot) => { slot.key = null; });
        };

        // 一句的指痕图：G 通道是字的编号，R 通道是手指擦过的形状（字描粗、圆头）。
        const slotFor = (entry, build = true) => {
            if (!glState) return null;
            const key = `${planFor?.key}|${entry.index}`;
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            const ctx = atlasCanvas.getContext('2d', { alpha: false });
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, world.W, world.H);
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.textBaseline = 'alphabetic';
            const data = new Float32Array(256 * 2 * 4);
            // 编号：字框填进 G（着色器按纹素取，不插值；重叠处取后写的字）
            ctx.globalCompositeOperation = 'lighten';
            entry.items.forEach((it, i) => {
                const id = Math.min(MAX_GLYPHS, i + 1);
                ctx.fillStyle = `rgb(0,${id},0)`;
                ctx.fillRect(Math.floor(it.box[0]), Math.floor(it.box[1]), Math.ceil(it.box[2] - it.box[0]), Math.ceil(it.box[3] - it.box[1]));
            });
            // 手指擦过的形状：字描粗、圆头，只加进 R
            ctx.globalCompositeOperation = 'lighter';
            entry.items.forEach((it, i) => {
                const id = Math.min(MAX_GLYPHS, i + 1);
                const cjk = CJK.test(it.g.text);
                ctx.save();
                ctx.translate(it.x + it.w / 2, it.baseline - it.size * 0.35);
                ctx.rotate(it.rot);
                ctx.translate(-(it.x + it.w / 2), -(it.baseline - it.size * 0.35));
                ctx.font = fontFor(it.size, cjk);
                const colour = 'rgb(255,0,0)';
                ctx.strokeStyle = colour;
                ctx.fillStyle = colour;
                ctx.lineWidth = Math.max(2, it.size * (cjk ? 0.075 : 0.06));
                ctx.strokeText(it.g.text, it.x, it.baseline);
                ctx.fillText(it.g.text, it.x, it.baseline);
                ctx.restore();
                const dur = clamp(it.g.end - it.g.start, 0.22, 0.85);
                data[id * 4] = it.g.start;
                data[id * 4 + 1] = dur;
                const o = (256 + id) * 4;
                data[o] = it.box[0] / world.W; data[o + 1] = it.box[1] / world.H;
                data[o + 2] = it.box[2] / world.W; data[o + 3] = it.box[3] / world.H;
            });
            const { gl } = glState;
            const busy = new Set(stats.visibleKeys || []);
            const slot = glState.slots.filter(s => !busy.has(s.key)).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            gl.bindTexture(gl.TEXTURE_2D, slot.atlas);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
            gl.bindTexture(gl.TEXTURE_2D, slot.data);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 2, 0, gl.RGBA, gl.FLOAT, data);
            slot.key = key;
            slot.used = performance.now();
            stats.builds += 1;
            stats.buildMs = Math.round(performance.now() - started);
            return slot;
        };

        // 这一刻窗上还看得见的句子（最多三句，最新的优先）
        const visibleAt = (t) => {
            const out = [];
            for (let i = plan.length - 1; i >= 0 && out.length < LINE_SLOTS; i -= 1) {
                const p = plan[i];
                if (p.start - 0.3 > t) continue;
                if (p.fogBack + FOG_RETURN + 1.2 < t) break;
                out.push(p);
            }
            return out;
        };

        const scheduleNext = (t) => {
            if (idleHandle || !glState) return;
            const next = plan.find(p => p.start > t);
            if (!next || slotFor(next, false)) return;
            const run = () => { idleHandle = 0; if (!mode.destroyed && !lostContext) slotFor(next, true); };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        // 窗外换景：间奏（两句之间空了 4.5 秒以上）处换一次，街景和水族馆轮流；
        // 换的时刻只由歌词时间决定，拖动进度条也对得上。
        let aquaPlan = null;
        const aquaAt = (t, view) => {
            if (view === 'street') return 0;
            if (view === 'aquarium') return 1;
            if (!aquaPlan || aquaPlan.plan !== plan) {
                const cuts = [];
                for (let i = 1; i < plan.length; i += 1) {
                    const gap = plan[i].start - plan[i - 1].end;
                    if (gap > 4.5) cuts.push((plan[i - 1].end + plan[i].start) / 2);
                }
                aquaPlan = { plan, cuts };
            }
            let state = 0;
            let value = 0;
            for (const at of aquaPlan.cuts) {
                if (t < at - 1.1) break;
                const next = 1 - state;
                value = state + (next - state) * smooth(at - 1.1, at + 1.1, t);
                if (t >= at + 1.1) state = next;
            }
            return value;
        };

        // 往下淌的水：每隔七八秒从窗顶淌下来一道，时刻、位置只由歌和序号决定
        const dripsAt = (t, seedKey, lines) => {
            let n = 0;
            dripTop.fill(1.02);
            // 写过的字底下积了水，有的会淌下来
            for (const p of lines) {
                for (const it of p.items) {
                    if (n >= 4) break;
                    const r = seededRandom(`${seedKey}:gdrip:${p.index}:${it.g.start.toFixed(2)}`);
                    if (r() > 0.22) continue;
                    const start = it.g.end + 0.4 + r() * 1.2;
                    const speed = 0.03 + r() * 0.035;
                    const top = 1 - it.box[3] / world.H;
                    if (start > t || top - (t - start) * speed < -0.3) continue;
                    dripBuffer.set([(it.x + it.w * (0.3 + r() * 0.4)) / world.W, start, speed, r() * 10], n * 4);
                    dripTop[n] = top;
                    n += 1;
                }
            }
            const period = 7.5;
            const k0 = Math.floor(t / period);
            for (let k = k0; k > k0 - 6 && n < 6; k -= 1) {
                dripTop[n] = 1.02;
                if (k < 0) break;
                const r = seededRandom(`${seedKey}:drip:${k}`);
                const start = k * period + r() * period;
                const speed = 0.035 + r() * 0.05;
                if (start > t || 1.02 - (t - start) * speed < -0.3) continue;
                dripBuffer[n * 4] = 0.05 + r() * 0.9;
                dripBuffer[n * 4 + 1] = start;
                dripBuffer[n * 4 + 2] = speed;
                dripBuffer[n * 4 + 3] = r() * 10;
                n += 1;
            }
            return n;
        };

        const draw = (frame) => {
            if (!glState || lostContext) return;
            const { gl, scene, main, vao } = glState;
            const s = settings();
            const t = frame.playbackTime;
            const visible = visibleAt(t);
            stats.visibleKeys = visible.map(p => `${planFor?.key}|${p.index}`);
            const slots = visible.map(p => slotFor(p, true));
            stats.visible = visible.length;

            // 1) 窗外
            const [sw, sh] = glState.sceneSize;
            gl.bindVertexArray(vao);
            gl.bindFramebuffer(gl.FRAMEBUFFER, glState.fbo);
            gl.viewport(0, 0, sw, sh);
            gl.useProgram(scene.program);
            Utils.bindNoise(gl, scene.uniforms.uNoise, 0);
            const su = scene.uniforms;
            const clock = t * s.cameraSpeed;
            // 车偶尔颠一下
            const bumpK = Math.floor(clock / 2.7);
            const br = seededRandom(`bump:${bumpK}`);
            const bt = clock - bumpK * 2.7 - br() * 2;
            const bump = s.reducedMotion ? 0 : (bt > 0 && bt < 0.5 ? Math.sin(bt * 18) * Math.exp(-bt * 7) * 0.012 * (br() < 0.6 ? 1 : 0) : 0);
            gl.uniform2f(su.uRes, sw, sh);
            gl.uniform1f(su.uAspect, sw / sh);
            gl.uniform1f(su.uT, clock);
            gl.uniform1f(su.uBump, bump);
            gl.uniform3fv(su.uSky, colours.sky);
            gl.uniform3fv(su.uBld, colours.bld);
            gl.uniform3fv(su.uWin, colours.win);
            gl.uniform3fv(su.uNeon, colours.neon);
            gl.uniform3fv(su.uNeon2, colours.neon2);
            gl.uniform3fv(su.uLamp, colours.lamp);
            const aqua = aquaAt(t, s.view);
            gl.uniform1f(su.uAqua, aqua);
            gl.uniform1f(su.uRain, s.rain === 'off' || s.rain === 'snow' ? 0 : s.rain === 'heavy' ? 1.8 : 1);
            gl.uniform1f(su.uSnow, s.rain === 'snow' ? 1 : 0);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.bindTexture(gl.TEXTURE_2D, glState.sceneTex);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            // 2) 车窗
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.useProgram(main.program);
            const u = main.uniforms;
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, glState.sceneTex); gl.uniform1i(u.uScene, 0);
            Utils.bindNoise(gl, u.uNoise, 7);
            const lineInfo = new Float32Array(LINE_SLOTS * 4);
            for (let i = 0; i < LINE_SLOTS; i += 1) {
                const slot = slots[i];
                gl.activeTexture(gl.TEXTURE1 + i); gl.bindTexture(gl.TEXTURE_2D, slot ? slot.atlas : glState.blank); gl.uniform1i(u[`uAtlas${i}`], 1 + i);
                gl.activeTexture(gl.TEXTURE4 + i); gl.bindTexture(gl.TEXTURE_2D, slot ? slot.data : glState.blankData); gl.uniform1i(u[`uData${i}`], 4 + i);
                if (slot) {
                    lineInfo[i * 4] = visible[i].fogBack;
                    lineInfo[i * 4 + 1] = 1;
                    lineInfo[i * 4 + 2] = (visible[i].index * 7.31) % 50;
                }
            }
            gl.uniform4fv(u.uLine, lineInfo);
            gl.uniform2f(u.uRes, canvas.width, canvas.height);
            gl.uniform2f(u.uAtlasSize, world.W, world.H);
            gl.uniform1f(u.uTime, t);
            const drips = s.drips && !s.reducedMotion ? dripsAt(t, planFor?.key || '', visible) : 0;
            gl.uniform4fv(u.uDrips, dripBuffer);
            gl.uniform1fv(u.uDripTop, dripTop);
            // 指尖：正在写的字
            let spot = [0, 0, 0, 0];
            for (const p of visible) {
                for (const it of p.items) {
                    if (t >= it.g.start - 0.05 && t < it.g.end + 0.25) {
                        spot = [(it.x + it.w / 2) / world.W, 1 - (it.baseline - it.size * 0.4) / world.H, it.size / world.H * 1.4, 1 - smooth(it.g.end, it.g.end + 0.25, t)];
                    }
                }
            }
            gl.uniform4f(u.uSpot, spot[0], spot[1], spot[2], s.reducedMotion ? 0 : spot[3]);
            // 呵气：一句唱完、下一句还没开始（空当超过 2 秒）时
            let breath = 0;
            let bx = 0.5, by = 0.35;
            if (!s.reducedMotion && plan?.length) {
                let last = null, next = null;
                for (const p of plan) { if (p.end <= t) last = p; else if (p.start > t) { next = p; break; } else { last = null; next = null; break; } }
                if (last && (!next || next.start - last.end > 2)) {
                    const gapEnd = next ? next.start : last.end + 20;
                    breath = smooth(last.end + 0.4, last.end + 1.6, t) * (1 - smooth(gapEnd - 1.4, gapEnd - 0.3, t)) * 0.85;
                    const r = seededRandom(`breath:${last.index}`);
                    bx = 0.3 + r() * 0.4; by = 0.3 + r() * 0.3;
                }
            }
            gl.uniform3f(u.uBreath, bx, by, breath);
            gl.uniform1f(u.uFireflies, s.reducedMotion || (s.rain === 'snow' && aqua < 0.5) ? 0 : s.fireflies);
            gl.uniform1f(u.uFrost, s.rain === 'snow' ? 1 - aqua : 0);
            gl.uniform1f(u.uAquaMain, aqua);
            gl.uniform1i(u.uDripCount, drips);
            gl.uniform3fv(u.uFogCol, colours.fog);
            gl.uniform1f(u.uFogDensity, clamp(0.62 * s.fog, 0.2, 0.92));
            gl.uniform1f(u.uDrops, s.drops ? 1 : 0);
            gl.uniform1f(u.uGrain, s.grain);
            gl.uniform1f(u.uGrainStep, s.reducedMotion ? 0 : Math.floor(t * 6) % 64);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            stats.draws += 1;
            scheduleNext(t);
        };

        const updateOverlay = (frame) => {
            const next = `雾笺 · ${Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const text = settings().showTranslation ? resolveSupplementalText(frame.activeLine) : '';
            if (text !== lastTranslation) { lastTranslation = text; translation.textContent = text; translation.hidden = !text; }
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            latestFrame = frame;
            if (!colours) readColours();
            ensurePlan(frame);
            updateOverlay(frame);
            if (!glState) return;
            const aim = 1000 / (FPS[mode.config.quality || 'standard'] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (still.same(frame, `${canvas.width}x${canvas.height}|${stats.builds}`)) return;
            lastDraw = now - lastDraw < aim * 2 ? lastDraw + aim : now;
            draw(frame);
        };

        const redraw = () => {
            still.invalidate();
            lastDraw = -Infinity;
            if (latestFrame) mode.updateFrame(latestFrame);
        };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); resize(); readColours(); redraw(); };
        mode.resize = () => { resize(); redraw(); };
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { readColours(); redraw(); };
        mode.getDebugSnapshot = () => ({
            initialized: Boolean(glState), lines: plan.length, visible: stats.visible,
            builds: stats.builds, buildMs: stats.buildMs, draws: stats.draws, buffer: `${canvas.width}x${canvas.height}`
        });

        const onLost = (event) => { event.preventDefault(); lostContext = true; };
        const onRestored = () => {
            try { glState = createGl(canvas); lostContext = false; resize(); redraw(); } catch (error) { console.error(error); }
        };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        mode.scope.add(() => {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            if (idleHandle) (global.cancelIdleCallback || global.clearTimeout)(idleHandle);
            if (glState) {
                const { gl } = glState;
                glState.slots.forEach((slot) => { gl.deleteTexture(slot.atlas); gl.deleteTexture(slot.data); });
                [glState.sceneTex, glState.blank, glState.blankData].forEach(t => gl.deleteTexture(t));
                gl.deleteFramebuffer(glState.fbo);
                gl.deleteProgram(glState.scene.program);
                gl.deleteProgram(glState.main.program);
                gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
            glState = null;
        });

        resize();
        return mode;
    };

    global.MusicStageFogpaneManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ planSong })
    });
})(window);
