/*
 * 绘光（lumiere）：舞台光式的歌词 PV。暗场里有体积光束、烟雾和浮尘，歌词被光照到才亮；
 * 唱到的字点亮，光扫过时字边泛出光晕。每段（约四句）换一套光位：顶光、百叶窗隙、棱镜分光、
 * 双追光、水波焦散、萤尘，段与段之间熄灯再亮。
 *
 * 和墨痕、雾笺一样：每句准备一次字形纹理（R 字形、G 字编号），每帧一个全屏三角形，
 * 光、烟、尘都是着色器按时间算的。默认每秒 30 帧（节能 24、极致 60），暂停且输入不变时不画。
 */
(function (global) {
    'use strict';

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before lumiere-manager.js');

    const { clamp, seededRandom, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const RATIO = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    const MAX_BEAMS = 5;
    const RIGS = Object.freeze(['zenith', 'lattice', 'prism', 'stage', 'caustic', 'motes']);
    const RIG_ID = Object.freeze({ zenith: 0, lattice: 1, prism: 2, stage: 3, caustic: 4, motes: 5 });
    const SECTION_LINES = 4;
    const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const hsl = (h, s, l) => {
        const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
        return [f(0), f(8), f(4)];
    };

    /* ───────────────────────── 段落：每句一段，每四句换一套光位 ───────────────────────── */

    const buildCues = (lines, duration, seedKey) => {
        const sung = lines.filter(line => readableText(line.fullText));
        const cues = [];
        const rest = (start, end, title) => { if (end > start + 0.05) cues.push({ kind: 'rest', start, end, title }); };
        if (!sung.length) { rest(0, Math.max(Number(duration) || 0, 720), true); }
        else {
            if (sung[0].startTime > 2) rest(0, sung[0].startTime, true);
            sung.forEach((line, i) => {
                const next = sung[i + 1];
                const lineEnd = Math.max(line.endTime, line.vocalEndTime || 0);
                const nextStart = next ? next.startTime : Infinity;
                if (nextStart - lineEnd > 4) {
                    cues.push({ kind: 'line', start: line.startTime, end: lineEnd + 1.2, line, number: i + 1 });
                    rest(lineEnd + 1.2, next ? nextStart : Math.max(Number(duration) || 0, lineEnd + 30), false);
                } else cues.push({ kind: 'line', start: line.startTime, end: nextStart, line, number: i + 1 });
            });
            cues[0].start = 0;
        }
        // 光位：间奏自成一段；歌词每四句一段（遇到间奏重新数）
        let section = -1;
        let count = SECTION_LINES;
        let previousRig = '';
        cues.forEach((cue, i) => {
            if (cue.kind === 'rest' || count >= SECTION_LINES) {
                section += 1;
                count = 0;
                const random = seededRandom(`lumiere:${seedKey}:section:${section}`);
                const options = cue.kind === 'rest' ? ['motes', 'zenith', 'caustic'] : RIGS.filter(r => r !== previousRig);
                cue.rig = options[Math.floor(random() * options.length)];
                cue.sectionStart = true;
                cue.seed = random() * 100;
                previousRig = cue.rig;
            } else {
                cue.rig = cues[i - 1].rig;
                cue.seed = cues[i - 1].seed;
            }
            cue.section = section;
            if (cue.kind === 'line') count += 1;
        });
        return cues;
    };
    const findCue = (cues, t) => {
        let low = 0, high = cues.length - 1, result = 0;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (t >= cues[mid].start) { result = mid; low = mid + 1; } else high = mid - 1;
        }
        return result;
    };

    // 某一刻某套光位的光束：起点（屏幕 0..1，y 朝上）、方向角、半角、强度、颜色。全由时间算。
    const beamsAt = (rig, seed, t, colours, out, colourOut) => {
        let n = 0;
        const push = (x, y, angle, half, power, colour) => {
            if (n >= MAX_BEAMS) return;
            out[n * 4] = x; out[n * 4 + 1] = y; out[n * 4 + 2] = angle; out[n * 4 + 3] = half;
            colourOut[n * 4] = colour[0] * power; colourOut[n * 4 + 1] = colour[1] * power; colourOut[n * 4 + 2] = colour[2] * power; colourOut[n * 4 + 3] = power;
            n += 1;
        };
        const r = seededRandom(`beams:${rig}:${seed.toFixed(3)}`);
        const sway = (k, speed = 0.11, amp = 0.05) => Math.sin(t * speed + seed + k * 1.7) * amp;
        const down = -Math.PI / 2;
        switch (rig) {
            case 'zenith': {
                const count = 1 + Math.floor(r() * 3);
                for (let k = 0; k < count; k += 1) {
                    const x = count === 1 ? 0.5 : 0.25 + k * 0.5 / (count - 1);
                    push(x + sway(k, 0.07, 0.03), 1.25, down + (x - 0.5) * 0.25 + sway(k + 3, 0.09, 0.04), 0.12 + r() * 0.05, k === Math.floor(count / 2) ? 1.1 : 0.75, colours.warm);
                }
                break;
            }
            case 'lattice': {
                const fromLeft = r() < 0.5;
                push(fromLeft ? -0.25 : 1.25, 1.15, (fromLeft ? -0.62 : -2.52) + sway(0, 0.05, 0.03), 0.24, 1.0, colours.warm);
                break;
            }
            case 'prism': {
                const ox = 0.5 + sway(0, 0.06, 0.08);
                for (let k = 0; k < 5; k += 1) {
                    const h = (0.98 + k * 0.17 + t * 0.004) % 1;
                    push(ox, 1.2, down + (k - 2) * 0.2 + sway(k, 0.08, 0.03), 0.05, 0.85, hsl(h, 0.85, 0.62));
                }
                break;
            }
            case 'stage': {
                push(-0.05, 1.12, -0.95 + sway(0, 0.23, 0.22), 0.1, 1.1, colours.accent);
                push(1.05, 1.12, -2.19 + sway(2, 0.19, 0.22), 0.1, 1.1, colours.cool);
                push(0.5, 1.3, down + sway(4, 0.13, 0.12), 0.08, 0.6, colours.warm);
                break;
            }
            case 'caustic':
                push(0.5 + sway(0, 0.05, 0.05), 1.3, down, 0.3, 0.75, colours.cool);
                break;
            default:
                push(0.5 + sway(0, 0.04, 0.1), 1.3, down + sway(1, 0.05, 0.08), 0.22, 0.55, colours.warm);
                break;
        }
        return n;
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
uniform sampler2D uText;
uniform sampler2D uGlyph;
uniform sampler2D uPrevText;
uniform vec2 uRes;
uniform vec2 uTextSize;
uniform float uTime;
uniform float uLocal;
uniform float uPrevFade;
uniform float uZoom;
uniform float uPrevZoom;
uniform int uRig;
uniform float uSeed;
uniform vec4 uBeam[${MAX_BEAMS}];
uniform vec4 uBeamCol[${MAX_BEAMS}];
uniform int uBeamCount;
uniform float uLights;     // 熄灯、亮灯（0..1）
uniform float uSmoke;
uniform float uDust;
uniform float uPower;
uniform vec3 uField;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uWaiting;
uniform float uGrain;
uniform float uGrainStep;
out vec4 outColor;

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
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

// 光照：每束光是一个锥，越远越散越暗；百叶窗把锥切成条，焦散在光里织网
vec3 lightAt(vec2 p, float aspect, out float total) {
    vec3 col = vec3(0.0);
    total = 0.0;
    for (int i = 0; i < ${MAX_BEAMS}; i++) {
        if (i >= uBeamCount) break;
        vec4 b = uBeam[i];
        vec2 o = vec2(b.x * aspect, b.y);
        vec2 d = vec2(cos(b.z), sin(b.z));
        vec2 v = p - o;
        float along = dot(v, d);
        if (along <= 0.0) continue;
        float perp = d.x * v.y - d.y * v.x;
        float ang = abs(atan(perp, along));
        float cone = smoothstep(b.w, b.w * 0.35, ang);
        float fall = 1.0 / (1.0 + along * along * 0.35);
        float k = cone * fall;
        if (uRig == 1) {
            // 百叶：沿光束横向切成条，条随距离变宽
            float stripes = smoothstep(0.35, 0.55, fract(perp / (along * 0.06 + 0.02) + uSeed));
            k *= 0.25 + stripes * 0.95;
        }
        col += uBeamCol[i].rgb * k;
        total += uBeamCol[i].a * k;
    }
    if (uRig == 4) {
        // 焦散：两层扭过的网格，亮的地方是细线
        vec2 q = p * 3.2 + vec2(uTime * 0.05, uTime * 0.03);
        vec2 w = vec2(vnoise(q + uSeed), vnoise(q * 1.3 - uSeed)) * 1.8;
        float c1 = abs(sin((q.x + w.x) * 3.1) * sin((q.y + w.y) * 2.7));
        float caustic = pow(1.0 - c1, 6.0);
        col *= 0.55 + caustic * 1.4;
        total *= 0.55 + caustic * 1.4;
    }
    return col;
}

float glyphReveal(int gid) {
    if (gid <= 0) return 0.0;
    vec2 se = texelFetch(uGlyph, ivec2(gid, 0), 0).xy;
    return smoothstep(se.x - 0.12, se.x + 0.12, uTime);
}
float glyphSinging(int gid) {
    if (gid <= 0) return 0.0;
    vec2 se = texelFetch(uGlyph, ivec2(gid, 0), 0).xy;
    return smoothstep(se.x - 0.1, se.x + 0.05, uTime) * (1.0 - smoothstep(se.y, se.y + 0.5, uTime));
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float aspect = uRes.x / uRes.y;
    vec2 p = vec2(uv.x * aspect, uv.y);

    float total;
    vec3 light = lightAt(p, aspect, total) * uLights * (0.85 + uPower * 0.3);
    // 烟：慢慢翻滚的两层噪点，只有被光照到才看得见
    vec2 sp = p * 2.2 + vec2(uTime * 0.03, -uTime * 0.012);
    float smoke = vnoise(sp) * 0.65 + vnoise(sp * 2.7 + 5.0) * 0.35;
    vec3 air = light * (0.18 + smoke * 0.55 * uSmoke);
    // 浮尘：一格一粒，慢慢飘，只在光里亮
    vec2 grid = vec2(aspect * 44.0, 44.0);
    vec2 dp = uv + vec2(uTime * 0.004, uTime * 0.007);
    vec2 cell = floor(dp * grid);
    vec2 h = hash22(cell);
    vec2 centre = (cell + 0.5 + (h - 0.5) * 0.8 + vec2(sin(uTime * 0.5 + h.x * 6.3), cos(uTime * 0.4 + h.y * 6.3)) * 0.12) / grid;
    float dist = length((dp - centre) * vec2(aspect, 1.0)) * 44.0;
    float mote = smoothstep(0.08 + h.y * 0.06, 0.0, dist) * step(0.7, h.x);
    air += light * mote * 1.6 * uDust;

    vec3 col = uField + air;

    // 字：纹理坐标（y 朝下），整句慢慢推近
    vec2 tc = vec2(uv.x, 1.0 - uv.y);
    vec2 t1 = (tc - 0.5) / uZoom + 0.5;
    float lit = clamp(total, 0.0, 1.6);
    {
        vec4 tx = texture(uText, t1);
        float halo = textureLod(uText, t1, 3.5).r;
        int gid = int(texelFetch(uText, clamp(ivec2(t1 * uTextSize), ivec2(0), ivec2(uTextSize) - 1), 0).g * 255.0 + 0.5);
        float reveal = glyphReveal(gid);
        float singing = glyphSinging(gid);
        float body = tx.r * (uWaiting * (1.0 - reveal) + reveal * (0.66 + lit * 0.5));
        vec3 ink = mix(uInk, mix(uInk, light / max(total, 0.001), 0.45), clamp(lit, 0.0, 1.0));
        col = mix(col, ink * (0.74 + lit * 0.6), clamp(body, 0.0, 1.0));
        col += uAccent * tx.r * singing * 0.35;
        col += (light * 0.9 + uAccent * singing * 0.3) * halo * reveal * 0.55;
    }
    if (uPrevFade > 0.0) {
        vec2 t0 = (tc - 0.5) / uPrevZoom + 0.5;
        float r0 = texture(uPrevText, t0).r;
        float h0 = textureLod(uPrevText, t0, 3.5).r;
        vec3 ink = uInk * (0.6 + lit * 0.7);
        // 旧句化成光散开：往上飘一点、变淡
        col = mix(col, ink, r0 * uPrevFade * (0.42 + lit * 0.75));
        col += light * h0 * uPrevFade * 0.8;
    }
    vec2 v = uv - 0.5;
    col *= 1.0 - dot(v, v) * 0.8;
    col += (hash12(floor(gl_FragCoord.xy / 1.5) + uGrainStep * 11.0) - 0.5) * 0.025 * uGrain;
    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
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
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`[lumiere] shader: ${gl.getShaderInfoLog(shader)}`);
            return shader;
        };
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`[lumiere] link: ${gl.getProgramInfoLog(program)}`);
        const uniforms = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i += 1) {
            const info = gl.getActiveUniform(program, i);
            uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
        }
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        const texture = (filter, mip) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            return t;
        };
        const slots = Array.from({ length: 3 }, () => ({ text: texture(gl.LINEAR, true), glyph: texture(gl.NEAREST, false), key: null, used: 0 }));
        return { gl, program, uniforms, vao: gl.createVertexArray(), slots };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('lumiere', '绘光', container, services);
        const canvas = createElement('canvas', 'lumiere-canvas');
        const kicker = createElement('div', 'lumiere-kicker', '绘光');
        const translation = createElement('div', 'stage-translation lumiere-translation');
        const notice = createElement('div', 'lumiere-notice');
        notice.hidden = true;
        mode.root.append(canvas, kicker, translation, notice);
        const textCanvas = document.createElement('canvas');

        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，绘光画不出来，请换一个舞台';
        }
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
        const beamBuffer = new Float32Array(MAX_BEAMS * 4);
        const beamColours = new Float32Array(MAX_BEAMS * 4);
        let cues = [];
        let cuesFor = null;
        let world = { W: 0, H: 0 };
        let paused = false;
        let latestFrame = null;
        let lastDraw = -Infinity;
        let colours = null;
        let caption = '';
        let lastTranslation = '';
        let lostContext = false;
        let idleHandle = 0;
        const stats = { builds: 0, buildMs: 0, draws: 0, cue: -1, rig: '' };

        const settings = () => {
            const tuning = mode.config.modes?.lumiere || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                smoke: clamp(tuning.smoke ?? 1, 0, 2),
                dust: clamp(tuning.dust ?? 1, 0, 2),
                waitingOpacity: clamp(tuning.waitingOpacity ?? 0.22, 0, 1),
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                grain: clamp(tuning.grain ?? 0.4, 0, 1),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: Boolean(reducedMotion?.matches)
            };
        };

        // 暗场。浅色主题也是暗场（光要在暗处才看得见），只把底色往主题那边带一点。
        const readColours = () => {
            const p = services?.app?.stagePalette || {};
            const bg = hexRgb(p.background, [0.09, 0.1, 0.11]);
            const accent = hexRgb(p.accent, [0.95, 0.66, 0]);
            const secondary = hexRgb(p.secondary, [0.46, 0.75, 0.68]);
            const light = Boolean(p.light);
            colours = {
                field: light ? mixRgb(bg, [0.06, 0.06, 0.07], 0.86) : mixRgb(bg, [0.02, 0.02, 0.03], 0.6),
                ink: [0.96, 0.94, 0.9],
                accent,
                warm: [1.0, 0.9, 0.74],
                cool: mixRgb(secondary, [0.8, 0.9, 1.0], 0.35)
            };
            mode.root.style.setProperty('--lumiere-field', `rgb(${colours.field.map(v => Math.round(v * 255)).join(',')})`);
        };

        const resize = () => {
            const w = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            const h = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            const quality = mode.config.quality || 'standard';
            const dpr = Math.min(RATIO[quality] || 1.5, global.devicePixelRatio || 1);
            const scale = Math.min(dpr, Math.sqrt((PIXELS[quality] || PIXELS.standard) / (w * h)));
            const bw = Math.max(1, Math.round(w * scale)), bh = Math.max(1, Math.round(h * scale));
            if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; still.invalidate(); }
            const W = 1600;
            const H = Math.round(W * h / w);
            if (Math.abs(H - world.H) > 8) {
                world = { W, H: Math.min(2048, H) };
                textCanvas.width = world.W; textCanvas.height = world.H;
                glState?.slots.forEach((slot) => { slot.key = null; });
            }
        };

        const trackKey = frame => frame.track?.path || frame.track?.title || '';
        const ensureCues = (frame) => {
            const key = `${trackKey(frame)}|${Math.round(frame.duration || 0)}`;
            if (cuesFor && cuesFor.lines === frame.lines && cuesFor.key === key) return;
            cues = buildCues(frame.lines || [], frame.duration, key);
            cuesFor = { lines: frame.lines, key };
            glState?.slots.forEach((slot) => { slot.key = null; });
        };

        const family = () => global.getComputedStyle?.(mode.root).fontFamily || 'system-ui, sans-serif';

        // 一句的字形图：居中成几行，同一个字号；G 是字编号（字框）
        const slotFor = (index, build = true) => {
            if (!glState || index < 0 || index >= cues.length) return null;
            const s = settings();
            const key = `${cuesFor?.key}|${index}|${world.W}x${world.H}|${s.fontScale}`;
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            const cue = cues[index];
            const { W, H } = world;
            const ctx = textCanvas.getContext('2d', { alpha: false });
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, W, H);
            let glyphs = [];
            if (cue.kind === 'line') glyphs = buildGlyphTimeline(cue.line).map(g => ({ text: g.text, start: g.startTime, end: g.endTime }));
            else if (cue.title) {
                const title = String(latestFrame?.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '');
                glyphs = Array.from(title).map((text, i) => ({ text, start: cue.start + 0.8 + i * 0.07, end: cue.start + 1.2 + i * 0.07 }));
            }
            const data = new Float32Array(256 * 4);
            if (glyphs.length) {
                const visible = glyphs.filter(g => g.text.trim()).length;
                const cjk = glyphs.filter(g => CJK.test(g.text)).length > visible / 2;
                const rows = [];
                const perRow = cjk ? 10 : 22;
                let row = [];
                glyphs.forEach((g, i) => {
                    row.push(g);
                    const filled = row.filter(x => x.text.trim()).length;
                    const target = Math.ceil(visible / Math.ceil(visible / perRow));
                    if (filled >= target && (cjk || !g.text.trim() || i === glyphs.length - 1)) { rows.push(row); row = []; }
                });
                if (row.length) rows.push(row);
                const font = size => `${cjk ? 400 : 300} ${size.toFixed(1)}px ${family()}`;
                ctx.font = font(100);
                const widest = Math.max(...rows.map(r => ctx.measureText(r.map(g => g.text).join('').trim()).width));
                const size = clamp(W * 0.64 / widest * 100, H * 0.05, H * (cue.kind === 'rest' ? 0.1 : 0.12)) * s.fontScale;
                ctx.font = font(size);
                const lineH = size * 1.32;
                const top = H * 0.5 - rows.length * lineH / 2 + size * 0.95;
                let id = 0;
                rows.forEach((r, ri) => {
                    const text = r.map(g => g.text).join('');
                    const trimmed = text.replace(/\s+$/, '');
                    let x = (W - ctx.measureText(trimmed).width) / 2;
                    const baseline = top + ri * lineH;
                    r.forEach((g) => {
                        const w = ctx.measureText(g.text).width;
                        if (g.text.trim()) {
                            id = Math.min(255, id + 1);
                            ctx.globalCompositeOperation = 'lighten';
                            ctx.fillStyle = `rgb(0,${id},0)`;
                            ctx.fillRect(Math.floor(x - 2), Math.floor(baseline - size * 0.95), Math.ceil(w + 4), Math.ceil(size * 1.2));
                            ctx.globalCompositeOperation = 'lighter';
                            ctx.fillStyle = 'rgb(255,0,0)';
                            ctx.fillText(g.text, x, baseline);
                            data[id * 4] = g.start;
                            data[id * 4 + 1] = g.end;
                        }
                        x += w;
                    });
                });
            }
            const { gl } = glState;
            const busy = new Set([stats.cue, stats.cue - 1].map(i => `${cuesFor?.key}|${i}|${world.W}x${world.H}|${s.fontScale}`));
            const slot = glState.slots.filter(sl => !busy.has(sl.key)).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            gl.bindTexture(gl.TEXTURE_2D, slot.text);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.bindTexture(gl.TEXTURE_2D, slot.glyph);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, 1, 0, gl.RGBA, gl.FLOAT, data);
            slot.key = key;
            slot.used = performance.now();
            stats.builds += 1;
            stats.buildMs = Math.round(performance.now() - started);
            return slot;
        };

        const scheduleNext = (index) => {
            if (idleHandle || !glState || index + 1 >= cues.length || slotFor(index + 1, false)) return;
            const run = () => { idleHandle = 0; if (!mode.destroyed && !lostContext) slotFor(index + 1, true); };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        const draw = (frame) => {
            if (!glState || lostContext) return;
            const { gl, program, uniforms: u, vao } = glState;
            const s = settings();
            const t = frame.playbackTime;
            const index = findCue(cues, t);
            const cue = cues[index];
            const slot = slotFor(index, true);
            if (!cue || !slot) return;
            stats.cue = index;
            stats.rig = cue.rig;
            const local = t - cue.start;
            // 换光位时熄灯再亮：段首 0.5 秒亮起，段尾 0.35 秒熄
            const nextCue = cues[index + 1];
            const sectionEnds = !nextCue || nextCue.sectionStart;
            const lights = (cue.sectionStart ? smooth(0, 0.6, local) : 1) * (sectionEnds ? 1 - smooth(cue.end - 0.4, cue.end, t) * 0.85 : 1);
            const beams = beamsAt(cue.rig, cue.seed, t, colours, beamBuffer, beamColours);
            const prev = index > 0 && local < 0.6 ? slotFor(index - 1, false) : null;
            const prevFade = prev ? 1 - smooth(0, 0.6, local) : 0;
            const zoom = 1 + clamp(local / Math.max(1, cue.end - cue.start), 0, 1) * 0.045;
            const prevCue = cues[index - 1];
            const prevZoom = prevCue ? 1.045 + local * 0.06 : 1;
            const audio = frame.audio || {};

            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.useProgram(program);
            gl.bindVertexArray(vao);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.text); gl.uniform1i(u.uText, 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, slot.glyph); gl.uniform1i(u.uGlyph, 1);
            gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, (prev || slot).text); gl.uniform1i(u.uPrevText, 2);
            gl.uniform2f(u.uRes, canvas.width, canvas.height);
            gl.uniform2f(u.uTextSize, world.W, world.H);
            gl.uniform1f(u.uTime, t);
            gl.uniform1f(u.uLocal, local);
            gl.uniform1f(u.uPrevFade, prevFade);
            gl.uniform1f(u.uZoom, s.reducedMotion ? 1 : zoom);
            gl.uniform1f(u.uPrevZoom, s.reducedMotion ? 1 : prevZoom);
            gl.uniform1i(u.uRig, RIG_ID[cue.rig] ?? 0);
            gl.uniform1f(u.uSeed, cue.seed % 10);
            gl.uniform4fv(u.uBeam, beamBuffer);
            gl.uniform4fv(u.uBeamCol, beamColours);
            gl.uniform1i(u.uBeamCount, beams);
            gl.uniform1f(u.uLights, lights);
            gl.uniform1f(u.uSmoke, s.smoke);
            gl.uniform1f(u.uDust, s.dust);
            gl.uniform1f(u.uPower, clamp(((audio.power || 0) * 0.6 + (audio.bass || 0) * 0.4) * s.audioReactivity, 0, 1.5));
            gl.uniform3fv(u.uField, colours.field);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            gl.uniform1f(u.uWaiting, s.waitingOpacity);
            gl.uniform1f(u.uGrain, s.grain);
            gl.uniform1f(u.uGrainStep, s.reducedMotion ? 0 : Math.floor(t * 6) % 64);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            stats.draws += 1;
            scheduleNext(index);
        };

        const updateOverlay = (frame) => {
            const next = `绘光 · ${Utils.lineCounter(frame)}`;
            if (next !== caption) { caption = next; kicker.textContent = next; }
            const text = settings().showTranslation ? resolveSupplementalText(frame.activeLine) : '';
            if (text !== lastTranslation) { lastTranslation = text; translation.textContent = text; translation.hidden = !text; }
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            latestFrame = frame;
            if (!colours) readColours();
            ensureCues(frame);
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
            initialized: Boolean(glState), cues: cues.length, cue: stats.cue, rig: stats.rig,
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
                glState.slots.forEach((slot) => { gl.deleteTexture(slot.text); gl.deleteTexture(slot.glyph); });
                gl.deleteProgram(glState.program);
                gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
            glState = null;
        });

        resize();
        return mode;
    };

    global.MusicStageLumiereManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ buildCues, findCue, beamsAt })
    });
})(window);
