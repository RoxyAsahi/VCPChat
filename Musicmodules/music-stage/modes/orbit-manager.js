(function (global) {
    'use strict';

    /*
     * 回环：一圈斜着的椭圆轨道，歌词一字一字排在轨道上。唱到的字总是转到最前面（椭圆下沿），
     * 最大、最亮；唱过的字往左转到后面去，没唱的字从右边转过来。后半圈的字小而淡，像隔着轨道看过去。
     * 换句时上一句往外散开淡出。
     *
     * 画法：一个全屏三角形画底色、轨道线和轴线；字是一批四边形（每字六个顶点），位置在 CPU 上按
     * 椭圆算好、按远近排序后用 uniform 数组传进去，字形来自一张 16×16 格的字图（每句画一次）。
     */
    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before orbit-manager.js');
    const { clamp, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const RATIO = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    const MAX_GLYPHS = 64;
    const CELL = 128;
    const GRID = 16;
    const FRONT = -Math.PI / 2;
    const SPAN = 0.84; // 一句最多占轨道的多少
    const FADE = 0.6;

    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

    /* ───────────────────────── 轨道 ───────────────────────── */

    const sungLines = lines => (lines || []).filter(line => readableText(line.fullText));
    const lineIndexAt = (sung, t) => {
        let low = 0, high = sung.length - 1, result = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (t >= sung[mid].startTime) { result = mid; low = mid + 1; } else high = mid - 1;
        }
        return result;
    };

    // 每个字中心在这句里的位置（字图像素，沿轨道量）
    const arcLayout = (advances) => {
        const centres = [];
        let at = 0;
        advances.forEach((a, i) => {
            if (i > 0) at += a / 2;
            centres.push(at);
            at += a / 2;
        });
        return { centres, span: at };
    };

    // 椭圆按屏幕上的弧长（再除以透视缩放）查角度：两头不挤，前排的大字也不挤
    const TABLE = 360;
    const ellipseTable = (A, B, out) => {
        let length = 0;
        out[0] = 0;
        for (let i = 1; i <= TABLE; i += 1) {
            const a0 = FRONT + ((i - 1) / TABLE) * Math.PI * 2;
            const a1 = FRONT + (i / TABLE) * Math.PI * 2;
            const m = (a0 + a1) / 2;
            // 按透视缩放折算：前排的字大，走同样的「字数」要多走一段
            length += Math.hypot(A * Math.sin(m), B * Math.cos(m)) * (1 + 0.36 * Math.sin(m)) * (a1 - a0);
            out[i] = length;
        }
        return length;
    };
    // 从最前点沿轨道走 d（可正可负）到的角度
    const thetaAlong = (table, perimeter, d) => {
        let x = d % perimeter;
        if (x < 0) x += perimeter;
        let low = 0, high = TABLE;
        while (high - low > 1) { const mid = (low + high) >> 1; if (table[mid] <= x) low = mid; else high = mid; }
        const f = (x - table[low]) / Math.max(1e-9, table[high] - table[low]);
        return FRONT + ((low + f) / TABLE) * Math.PI * 2;
    };

    // 此刻唱到第几个字（带小数）：字开始时为 i，字结束时为 i+1；还没开唱时为负
    const singingPosition = (glyphs, t) => {
        if (!glyphs.length) return 0;
        if (t < glyphs[0].start) return -clamp((glyphs[0].start - t) / 0.6, 0, 1) * 0.6;
        for (let i = 0; i < glyphs.length; i += 1) {
            const g = glyphs[i];
            const end = Math.max(g.end, g.start + 0.05);
            if (t < end) return i + clamp((t - g.start) / (end - g.start), 0, 1);
            const next = glyphs[i + 1];
            if (next && t < next.start) return i + 1;
        }
        return glyphs.length;
    };
    // 唱到第 g 个字时，轨道转了多少：让第 g 个字的位置正好在最前
    const arcAt = (centres, g) => {
        if (!centres.length) return 0;
        if (g <= 0) return centres[0] + g * (centres[1] !== undefined ? centres[1] - centres[0] : 0.2);
        const i = Math.min(centres.length - 1, Math.floor(g));
        const next = centres[i + 1] ?? centres[i] + (centres[i] - (centres[i - 1] ?? centres[i] - 0.2));
        return centres[i] + (next - centres[i]) * (g - i);
    };
    // 轨道上角度 θ 的点：屏幕坐标（相对圆心，单位是屏幕高）、远近 z（-1 最近，1 最远）、透视缩放
    const project = (theta, A, B, roll) => {
        const x = Math.cos(theta) * A;
        const y = Math.sin(theta) * B;
        const z = Math.sin(theta);
        const s = 1 / (1 + 0.36 * z);
        const c = Math.cos(roll), sn = Math.sin(roll);
        return { x: x * c - y * sn, y: x * sn + y * c, z, s };
    };

    /* ───────────────────────── GL ───────────────────────── */

    const FIELD_VERT = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
    const FIELD_FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uCentre;
uniform vec2 uAxes;      // 椭圆半轴（屏幕高）
uniform float uRoll;
uniform float uSpin;
uniform float uAxis;
uniform float uGlow;
uniform float uLight;
uniform vec3 uField;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uGrain;
uniform float uGrainStep;
out vec4 outColor;

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float aspect = uRes.x / uRes.y;
    vec2 p = vec2(uv.x * aspect, uv.y);
    float aa = 1.5 / uRes.y;

    // 底：中间稍亮，带一点强调色的雾
    vec2 d0 = p - uCentre;
    vec3 col = uField * (1.0 + mix(0.35, 0.06, uLight) * exp(-dot(d0, d0) * 3.0));
    col += uAccent * mix(0.05, 0.03, uLight) * exp(-dot(d0 - vec2(0.0, -0.1), d0 - vec2(0.0, -0.1)) * 6.0);

    // 转回轨道自己的坐标
    float c = cos(-uRoll), s = sin(-uRoll);
    vec2 q = vec2(d0.x * c - d0.y * s, d0.x * s + d0.y * c);
    float theta = atan(q.y / uAxes.y, q.x / uAxes.x);
    float depth = sin(theta);
    float front = 0.5 - depth * 0.5;
    for (int k = 0; k < 2; k++) {
        float scale = k == 0 ? 1.0 : 0.82;
        float e = length(q / (uAxes * scale));
        float dist = abs(e - 1.0) * uAxes.y * scale;
        float w = (k == 0 ? 0.0014 : 0.0008) * (0.6 + front * 0.8);
        float line = 1.0 - smoothstep(w, w + aa, dist);
        float glow = exp(-dist * dist / (0.0004 + uGlow * 0.0006));
        float strength = (k == 0 ? 1.0 : 0.45) * (0.18 + front * 0.6);
        col = mix(col, uInk, line * strength * 0.7);
        col += uAccent * glow * strength * (0.06 + uGlow * 0.12) * (1.0 - uLight * 0.5);
        // 轨道上几颗慢慢转的点
        if (k == 0) {
            float a = theta - uSpin;
            float bead = abs(fract(a / 6.2832 * 7.0 + 0.5) - 0.5) * 6.2832 / 7.0 * length(uAxes);
            col = mix(col, uAccent, (1.0 - smoothstep(0.003, 0.003 + aa, length(vec2(bead, dist)))) * (0.35 + front * 0.55));
        }
    }
    // 轴线：穿过圆心的一根竖线，两头淡出
    if (uAxis > 0.5) {
        vec2 dir = vec2(-sin(uRoll), cos(uRoll));
        float along = dot(d0, dir);
        float perp = abs(dir.x * d0.y - dir.y * d0.x);
        float line = (1.0 - smoothstep(0.0008, 0.0008 + aa, perp)) * (1.0 - smoothstep(0.1, 0.46, abs(along)));
        col = mix(col, uInk, line * 0.35);
    }

    vec2 v = uv - 0.5;
    col *= 1.0 - dot(v, v) * mix(0.6, 0.2, uLight);
    col += (hash12(floor(gl_FragCoord.xy / 1.5) + uGrainStep * 11.0) - 0.5) * 0.025 * uGrain;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // 每个字一个四边形：uA = (x, y, 字高, 旋转)，uB = (格子编号, 不透明度, 正在唱, 已唱)
    const GLYPH_VERT = `#version 300 es
precision highp float;
uniform vec4 uA[${MAX_GLYPHS}];
uniform vec4 uB[${MAX_GLYPHS}];
uniform int uCount;
uniform vec2 uRes;
out vec2 vTex;
out vec3 vInfo;
void main() {
    int g = gl_VertexID / 6;
    int k = gl_VertexID - g * 6;
    if (g >= uCount) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vTex = vec2(0.0); vInfo = vec3(0.0); return; }
    vec2 corner = vec2(k == 1 || k == 2 || k == 4 ? 1.0 : 0.0, k == 2 || k == 4 || k == 5 ? 1.0 : 0.0);
    vec4 a = uA[g];
    vec4 b = uB[g];
    vec2 local = (corner - 0.5) * a.z * 1.3;
    float c = cos(a.w), s = sin(a.w);
    vec2 pos = a.xy + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
    float aspect = uRes.x / uRes.y;
    gl_Position = vec4(pos.x / aspect * 2.0 - 1.0, pos.y * 2.0 - 1.0, 0.0, 1.0);
    float cell = b.x;
    vec2 cellXY = vec2(mod(cell, ${GRID}.0), floor(cell / ${GRID}.0));
    vec2 inCell = vec2(corner.x, 1.0 - corner.y);
    vTex = (cellXY + inCell) / ${GRID}.0;
    vInfo = b.yzw;
}`;
    const GLYPH_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uWaiting;
in vec2 vTex;
in vec3 vInfo;
out vec4 outColor;
void main() {
    float alpha = vInfo.x;
    float singing = vInfo.y;
    float sung = vInfo.z;
    float m = texture(uAtlas, vTex).r;
    float halo = textureLod(uAtlas, vTex, 3.0).r;
    vec3 col = mix(uInk, uAccent, singing);
    float body = m * mix(uWaiting, 1.0, max(sung, singing));
    float a = clamp(body + halo * singing * 0.6, 0.0, 1.0) * alpha;
    vec3 c = mix(col, uAccent, (1.0 - step(0.02, m)) * singing);
    outColor = vec4(c * a, a);
}`;

    const createGl = (canvas) => {
        const gl = canvas.getContext('webgl2', {
            alpha: false, antialias: false, depth: false, stencil: false,
            premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'default'
        });
        if (!gl) return null;
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`[orbit] shader: ${gl.getShaderInfoLog(shader)}`);
            return shader;
        };
        const link = (vs, fs) => {
            const program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`[orbit] link: ${gl.getProgramInfoLog(program)}`);
            const uniforms = {};
            const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < count; i += 1) {
                const info = gl.getActiveUniform(program, i);
                uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
            }
            return { program, uniforms };
        };
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        const texture = () => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const slots = Array.from({ length: 3 }, () => ({ atlas: texture(), key: null, used: 0, line: null }));
        return {
            gl, field: link(FIELD_VERT, FIELD_FRAG), glyph: link(GLYPH_VERT, GLYPH_FRAG),
            vao: gl.createVertexArray(), slots
        };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('orbit', '回环', container, services);
        const canvas = createElement('canvas', 'orbit-canvas');
        const kicker = createElement('div', 'orbit-kicker', '回环');
        const translation = createElement('div', 'stage-translation orbit-translation');
        const notice = createElement('div', 'orbit-notice');
        notice.hidden = true;
        mode.root.append(canvas, kicker, translation, notice);
        const atlas = document.createElement('canvas');
        atlas.width = CELL * GRID;
        atlas.height = CELL * GRID;

        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，回环画不出来，请换一个舞台';
        }
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        const bufA = new Float32Array(MAX_GLYPHS * 4);
        const bufB = new Float32Array(MAX_GLYPHS * 4);
        const arcTable = new Float32Array(TABLE + 1);
        let sung = [];
        let sungFor = null;
        let paused = false;
        let latestFrame = null;
        let lastDraw = -Infinity;
        let colours = null;
        let caption = '';
        let lastTranslation = '';
        let lostContext = false;
        let idleHandle = 0;
        let glow = 0;
        const stats = { builds: 0, buildMs: 0, draws: 0, index: -2, glyphs: 0 };

        const settings = () => {
            const tuning = mode.config.modes?.orbit || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                tilt: clamp(tuning.tilt ?? 0.3, 0.15, 0.6),
                roll: clamp(tuning.roll ?? -12, -30, 30),
                axisLine: tuning.axisLine !== false,
                waitingOpacity: clamp(tuning.waitingOpacity ?? 0.3, 0, 1),
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                grain: clamp(tuning.grain ?? 0.3, 0, 1),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: Boolean(reducedMotion?.matches)
            };
        };

        const readColours = () => {
            const p = services?.app?.stagePalette || {};
            const light = Boolean(p.light);
            const bg = hexRgb(p.background, light ? [0.95, 0.94, 0.9] : [0.09, 0.1, 0.11]);
            colours = {
                light,
                field: light ? mixRgb(bg, [0.96, 0.95, 0.92], 0.3) : mixRgb(bg, [0.03, 0.035, 0.05], 0.6),
                ink: hexRgb(p.ink, light ? [0.1, 0.12, 0.12] : [0.95, 0.94, 0.9]),
                accent: hexRgb(p.accent, [0.95, 0.66, 0])
            };
            mode.root.style.setProperty('--orbit-field', `rgb(${colours.field.map(v => Math.round(v * 255)).join(',')})`);
        };

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const quality = mode.config.quality || 'standard';
            const dpr = Math.min(RATIO[quality] || 1.5, global.devicePixelRatio || 1);
            const scale = Math.min(dpr, Math.sqrt((PIXELS[quality] || PIXELS.standard) / (w * h)));
            const bw = Math.max(1, Math.round(w * scale)), bh = Math.max(1, Math.round(h * scale));
            if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; still.invalidate(); }
        };

        const ensureLines = (frame) => {
            if (sungFor === frame.lines) return;
            sung = sungLines(frame.lines);
            sungFor = frame.lines;
            glState?.slots.forEach((slot) => { slot.key = null; });
        };

        const family = () => global.getComputedStyle?.(mode.root).fontFamily || 'system-ui, sans-serif';

        // 一句的字图：每格一个字；记下每个字的宽度和时刻
        const slotFor = (index, build = true) => {
            if (!glState) return null;
            const key = `${index}|${sung.length}`;
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            let glyphs;
            if (index >= 0 && index < sung.length) {
                glyphs = buildGlyphTimeline(sung[index]).map(g => ({ text: g.text, start: g.startTime, end: g.endTime }));
            } else {
                const title = String(latestFrame?.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '');
                glyphs = Array.from(title).map((text, i) => ({ text, start: 0.4 + i * 0.08, end: 0.5 + i * 0.08 }));
            }
            // 空格并进前一个字的宽度，不占格子
            const ctx = atlas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, atlas.width, atlas.height);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const size = 88;
            ctx.font = `500 ${size}px ${family()}`;
            const items = [];
            glyphs.forEach((g) => {
                const width = ctx.measureText(g.text).width;
                if (!g.text.trim()) { if (items.length) items[items.length - 1].advance += width; return; }
                if (items.length >= Math.min(MAX_GLYPHS, GRID * GRID)) return;
                const cell = items.length;
                const cx = (cell % GRID) * CELL + CELL / 2;
                const cy = Math.floor(cell / GRID) * CELL + CELL / 2;
                ctx.fillText(g.text, cx, cy + size * 0.04);
                items.push({ cell, advance: Math.max(width, size * 0.42) + size * 0.12, start: g.start, end: g.end });
            });
            const layout = arcLayout(items.map(item => item.advance));
            const { gl } = glState;
            const busy = new Set([stats.index, stats.index - 1].map(i => `${i}|${sung.length}`));
            const slot = glState.slots.filter(sl => !busy.has(sl.key)).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            gl.bindTexture(gl.TEXTURE_2D, slot.atlas);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
            gl.generateMipmap(gl.TEXTURE_2D);
            slot.key = key;
            slot.used = performance.now();
            slot.line = { items, centres: layout.centres };
            stats.builds += 1;
            stats.buildMs = Math.round(performance.now() - started);
            return slot;
        };

        const scheduleNext = (index) => {
            if (idleHandle || !glState || index + 1 >= sung.length || slotFor(index + 1, false)) return;
            const run = () => { idleHandle = 0; if (!mode.destroyed && !lostContext) slotFor(index + 1, true); };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        // 把一句的字排上轨道，写进 bufA/bufB 的 [from, …)，返回写了几个
        const place = (line, t, geo, fade, from, rest) => {
            const { items, centres } = line;
            const g = rest ? items.length : singingPosition(items, t);
            const turn = arcAt(centres, g - 0.5);
            const span = items.length ? centres.at(-1) - centres[0] + items[0].advance : 1;
            // 字图像素换成轨道长度（已按透视折算）；太长的句子整体收紧
            const unit = Math.min(geo.size * 1.06 / 88, geo.perimeter * SPAN / span);
            const list = [];
            items.forEach((item, i) => {
                const theta = thetaAlong(geo.table, geo.perimeter, (centres[i] - turn) * unit) + (rest ? -0.25 * (1 - fade) : 0);
                const pt = project(theta, geo.A, geo.B, geo.roll);
                const singing = !rest && t >= item.start - 0.05 && t < Math.max(item.end, item.start + 0.2) + 0.3 ? 1 - smooth(item.end, item.end + 0.3, t) : 0;
                const sungAmount = t >= item.start ? 1 : 0;
                const back = smooth(-0.2, 1, pt.z);
                const alpha = fade * (1 - back * 0.72);
                // 字跟着轨道的切线稍微转一点，最多 ±15°
                const tangent = Math.atan2(Math.cos(theta) * geo.B, -Math.sin(theta) * geo.A) + geo.roll;
                let rot = tangent;
                while (rot > Math.PI / 2) rot -= Math.PI;
                while (rot < -Math.PI / 2) rot += Math.PI;
                rot = clamp(rot, -0.26, 0.26);
                const outward = rest ? (1 - fade) * 0.06 : 0;
                list.push({
                    z: pt.z,
                    a: [geo.cx + pt.x * (1 + outward), geo.cy + pt.y * (1 + outward), geo.size * pt.s * (1 + singing * 0.12), rot],
                    b: [item.cell, alpha, singing, sungAmount]
                });
            });
            list.sort((p, q) => q.z - p.z);
            let n = 0;
            list.forEach((entry) => {
                const k = from + n;
                if (k >= MAX_GLYPHS) return;
                bufA.set(entry.a, k * 4);
                bufB.set(entry.b, k * 4);
                n += 1;
            });
            return n;
        };

        const drawGlyphs = (slot, count) => {
            if (!count) return;
            const { gl, glyph } = glState;
            const u = glyph.uniforms;
            gl.useProgram(glyph.program);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.atlas); gl.uniform1i(u.uAtlas, 0);
            gl.uniform4fv(u.uA, bufA);
            gl.uniform4fv(u.uB, bufB);
            gl.uniform1i(u.uCount, count);
            gl.uniform2f(u.uRes, canvas.width, canvas.height);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            gl.uniform1f(u.uWaiting, settings().waitingOpacity);
            gl.drawArrays(gl.TRIANGLES, 0, count * 6);
        };

        const draw = (frame) => {
            if (!glState || lostContext) return;
            const { gl, field, vao } = glState;
            const s = settings();
            const t = frame.playbackTime;
            const index = lineIndexAt(sung, t);
            const slot = slotFor(index, true);
            if (!slot) return;
            stats.index = index;
            const startedAt = index >= 0 ? sung[index].startTime : 0;
            const since = t - startedAt;
            const prev = index >= 0 && since < FADE ? slotFor(index - 1, false) : null;
            const aspect = canvas.width / canvas.height;
            const A = Math.min(0.62 * aspect, 0.78) * 0.62;
            const geo = {
                cx: aspect / 2, cy: 0.53, A, B: A * s.tilt, roll: s.roll * Math.PI / 180,
                size: 0.06 * s.fontScale
            };
            geo.table = arcTable;
            geo.perimeter = ellipseTable(geo.A, geo.B, arcTable);
            const audio = frame.audio || {};
            const bass = clamp((audio.bass || 0) * s.audioReactivity, 0, 1.5);
            glow = frame.isPlaying ? Math.max(bass, glow * 0.86) : glow;

            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.bindVertexArray(vao);
            gl.disable(gl.BLEND);
            const u = field.uniforms;
            gl.useProgram(field.program);
            gl.uniform2f(u.uRes, canvas.width, canvas.height);
            gl.uniform2f(u.uCentre, geo.cx, geo.cy);
            gl.uniform2f(u.uAxes, geo.A, geo.B);
            gl.uniform1f(u.uRoll, geo.roll);
            gl.uniform1f(u.uSpin, s.reducedMotion ? 0 : t * 0.12);
            gl.uniform1f(u.uAxis, s.axisLine ? 1 : 0);
            gl.uniform1f(u.uGlow, glow);
            gl.uniform1f(u.uLight, colours.light ? 1 : 0);
            gl.uniform3fv(u.uField, colours.field);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            gl.uniform1f(u.uGrain, s.grain);
            gl.uniform1f(u.uGrainStep, s.reducedMotion ? 0 : Math.floor(t * 6) % 64);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            if (prev?.line) drawGlyphs(prev, place(prev.line, t, geo, 1 - smooth(0, FADE, since), 0, true));
            const fadeIn = index >= 0 ? smooth(-0.1, 0.35, since) : smooth(0, 0.8, t);
            const n = place(slot.line, t, geo, fadeIn, 0, false);
            stats.glyphs = n;
            drawGlyphs(slot, n);
            gl.disable(gl.BLEND);
            stats.draws += 1;
            scheduleNext(index);
        };

        const updateOverlay = (frame) => {
            const next = `回环 · ${Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const text = settings().showTranslation ? resolveSupplementalText(frame.activeLine) : '';
            if (text !== lastTranslation) { lastTranslation = text; translation.textContent = text; translation.hidden = !text; }
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            latestFrame = frame;
            if (!colours) readColours();
            ensureLines(frame);
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

        const redraw = () => { still.invalidate(); lastDraw = -Infinity; if (latestFrame) mode.updateFrame(latestFrame); };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); resize(); readColours(); redraw(); };
        mode.resize = () => { resize(); redraw(); };
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { readColours(); redraw(); };
        mode.getDebugSnapshot = () => ({
            initialized: Boolean(glState), lines: sung.length, index: stats.index, glyphs: stats.glyphs,
            builds: stats.builds, buildMs: stats.buildMs, draws: stats.draws, buffer: `${canvas.width}x${canvas.height}`
        });

        const onLost = (event) => { event.preventDefault(); lostContext = true; };
        const onRestored = () => { try { glState = createGl(canvas); lostContext = false; redraw(); } catch (error) { console.error(error); } };
        canvas.addEventListener('webglcontextlost', onLost);
        canvas.addEventListener('webglcontextrestored', onRestored);
        mode.scope.add(() => {
            canvas.removeEventListener('webglcontextlost', onLost);
            canvas.removeEventListener('webglcontextrestored', onRestored);
            if (idleHandle) (global.cancelIdleCallback || global.clearTimeout)(idleHandle);
            if (glState) {
                const { gl } = glState;
                glState.slots.forEach((slot) => gl.deleteTexture(slot.atlas));
                gl.deleteProgram(glState.field.program);
                gl.deleteProgram(glState.glyph.program);
                gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
            glState = null;
        });

        resize();
        return mode;
    };

    global.MusicStageOrbitManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ arcLayout, singingPosition, arcAt, project, lineIndexAt, ellipseTable, thetaAlong, TABLE })
    });
})(window);
