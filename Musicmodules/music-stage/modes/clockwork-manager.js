(function (global) {
    'use strict';

    /*
     * 时计：画面左边是一组咬合的齿轮，主齿轮的轴心在左侧，歌词像钟表的指针一样从轴心向右伸出，
     * 一句一根，排成一把扇子。每唱到下一句，整组齿轮带着歌词扇面往上转一格，咔哒一下停住；
     * 秒针跟着播放时间走，擒纵轮每秒跳一格。低音来时轴承宝石亮一下。
     *
     * 画法：一个全屏三角形。齿轮是极坐标下的距离场（齿形、辐条、轴心、刷纹、斜面高光、落影都在着色器里算），
     * 歌词扇面是一张七行的字图，按像素所在的角度查是第几行、按半径查是行里的第几个字。
     * 字图只在换句时重画一次，下一句的字图在空闲时提前备好。
     */
    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before clockwork-manager.js');
    const { clamp, createElement } = Utils;
    const { resolveSupplementalText, buildGlyphTimeline, readableText } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const PIXELS = Object.freeze({ 'energy-saving': 0.9e6, standard: 1.6e6, ultimate: 3.0e6 });
    const RATIO = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    const ROWS = 7; // 当前句上下各三句
    const ROW_PX = 128;
    const ATLAS_W = 2048;
    const STEP = 0.15; // 相邻两句的夹角（弧度）
    const TURN = 0.7; // 换句时转一格用的秒数

    const hexRgb = (hex, fallback) => {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return fallback;
        const n = parseInt(match[1], 16);
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const mixRgb = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

    /* ───────────────────────── 时间 ───────────────────────── */

    const sungLines = lines => (lines || []).filter(line => readableText(line.fullText));
    // 此刻是第几句（-1 表示还没开唱）
    const lineIndexAt = (sung, t) => {
        let low = 0, high = sung.length - 1, result = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (t >= sung[mid].startTime) { result = mid; low = mid + 1; } else high = mid - 1;
        }
        return result;
    };
    // 换句时的转动：略过头一点再回来，像齿轮咬住
    const settle = (x) => {
        if (x >= 1) return 1;
        if (x <= 0) return 0;
        const c = 1.9;
        const y = x - 1;
        return 1 + (c + 1) * y * y * y + c * y * y;
    };
    // 连续的「转到第几句」：整数部分是当前句，换句后 TURN 秒内从上一句转过来
    const wheelAt = (sung, t) => {
        const index = lineIndexAt(sung, t);
        if (index < 0) return { index, turned: -1 };
        const since = t - sung[index].startTime;
        return { index, turned: index - 1 + settle(since / TURN) };
    };
    // 擒纵：每秒跳一格，跳的那一下用 0.12 秒
    const escapement = t => Math.floor(t) + settle(clamp((t - Math.floor(t)) / 0.12, 0, 1));

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
uniform vec2 uRes;
uniform float uTime;
uniform float uTurn;      // 歌词扇面相对字图的转角
uniform float uGear;      // 主齿轮转角
uniform float uSecond;    // 秒针转角
uniform float uFont;      // 字高（屏幕高的比例）
uniform float uGlow;      // 低音
uniform float uLight;     // 浅色主题
uniform float uWaiting;
uniform float uSecondHand;
uniform vec3 uField;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform vec3 uBrass;
uniform vec3 uSteel;
uniform float uGrain;
uniform float uGrainStep;
uniform float uBeat;      // 鼓点（0..1，衰减）
uniform float uSmoke;     // 背景烟纹
uniform float uWire;      // 蓝图线稿层
uniform vec2 uShake;
uniform float uDrift;     // 视差：转过的句数
uniform vec2 uTilt;       // 表盘透视：绕竖轴、横轴的倾角
out vec4 outColor;

const float PI = 3.14159265;
const float STEP = ${STEP.toFixed(4)};
const float R0 = 0.42;        // 歌词从这个半径开始
const float ROWS = ${ROWS}.0;

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += vnoise(p) * a; p = p * 2.03 + 7.1; a *= 0.5; }
    return v;
}

// 一个齿轮：返回 (覆盖, 斜面, 刷纹坐标)。teeth 齿数，spokes 辐条数，ang 转角
vec3 gear(vec2 q, float R, float teeth, float spokes, float ang, float aa) {
    float r = length(q);
    if (r > R + 0.03) return vec3(0.0);
    float a = atan(q.y, q.x) - ang;
    float f = fract(a * teeth / (2.0 * PI));
    float tooth = smoothstep(0.16, 0.3, f) * smoothstep(0.84, 0.7, f);
    float h = 0.0125;
    float outer = R + h * (tooth - 0.5);
    float d = r - outer;
    float cover = 1.0 - smoothstep(-aa, aa, d);
    // 轮缘以内挖空，留辐条和轴心
    float rim = R - h - R * 0.12;
    float hub = R * 0.2;
    float sa = fract(a * spokes / (2.0 * PI)) - 0.5;
    float spokeW = (R * 0.07) / max(r, 0.001) * spokes / (2.0 * PI);
    float spoke = 1.0 - smoothstep(spokeW - aa / max(r, 0.01), spokeW + aa / max(r, 0.01), abs(sa));
    float window = smoothstep(hub, hub + aa, r) * (1.0 - smoothstep(rim - aa, rim, r));
    cover *= 1.0 - window * (1.0 - spoke);
    // 斜面：贴近边缘的地方亮或暗
    float edge = min(min(-d, abs(r - rim)), abs(r - hub));
    float bevel = 1.0 - smoothstep(0.0, 0.006, edge);
    return vec3(cover, bevel, r);
}

vec3 metal(vec3 base, vec2 q, vec3 g, float ang) {
    float a = atan(q.y, q.x);
    // 车削刷纹 + 斜上方来的高光（随角度变）
    float brushed = 0.92 + 0.08 * sin(g.z * 900.0 + hash12(vec2(floor(g.z * 900.0), 1.0)) * 6.0);
    float aniso = 0.55 + 0.45 * pow(abs(cos(a - 2.3)), 6.0);
    vec3 c = base * brushed * (0.55 + aniso * 0.6);
    c += vec3(1.0, 0.95, 0.85) * g.y * 0.22 * (0.4 + 0.6 * max(0.0, cos(a - 2.3)));
    c -= base * g.y * 0.25 * max(0.0, cos(a + 0.8));
    return c;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float aspect = uRes.x / uRes.y;
    vec2 p = vec2(uv.x * aspect, uv.y);
    float aa = 1.5 / uRes.y;
    vec2 hubC = vec2(min(0.3, aspect * 0.16), 0.5) + uShake;
    // 表盘透视：把屏幕点反投影回倾斜的表盘平面（先绕竖轴，再绕横轴）
    {
        const float D = 1.6;
        vec2 sp = p - vec2(aspect * 0.5, 0.5);
        float cy = cos(uTilt.x), sy = sin(uTilt.x);
        float X = sp.x * D / (D * cy - sp.x * sy);
        float Y = sp.y * (D + X * sy) / D;
        float cx = cos(uTilt.y), sx = sin(uTilt.y);
        float Y2 = Y * D / (D * cx - Y * sx);
        float X2 = X * (D + Y2 * sx) / D;
        p = vec2(X2, Y2) + vec2(aspect * 0.5, 0.5);
        aa *= 1.0 + abs(sp.x * sy) + abs(sp.y * sx);
    }

    // 两个小齿轮都咬着主齿轮：左下一个，左上一个。转角按齿数比算，齿正好错开半个齿
    const float PHI2 = 4.0, PHI3 = 2.1;
    vec2 C2 = hubC + vec2(cos(PHI2), sin(PHI2)) * (0.33 + 0.17);
    vec2 C3 = hubC + vec2(cos(PHI3), sin(PHI3)) * (0.33 + 0.095);
    float A2 = PHI2 + PI + ((PHI2 - uGear) * 72.0 - PI) / 37.0;
    float A3 = PHI3 + PI + ((PHI3 - uGear) * 72.0 - PI) / 20.0;

    // 底：一点从左上来的光
    vec3 col = uField * (0.82 + 0.3 * smoothstep(1.4, 0.0, length(p - vec2(0.2, 0.95))));

    // 背景：慢慢流动的大理石烟纹，亮的地方叠一层细网点
    if (uSmoke > 0.0) {
        vec2 sp = p * 1.3 + vec2(uTime * 0.012, uDrift * 0.05);
        vec2 w = vec2(fbm(sp + uTime * 0.02), fbm(sp + 5.2 - uTime * 0.015));
        float m = fbm(sp + w * 2.2);
        float vein = smoothstep(0.42, 0.75, m) * (0.6 + 0.4 * smoothstep(0.3, 1.2, p.x));
        vec3 tone = mix(uInk, uSteel, 0.4);
        col += tone * vein * mix(0.09, 0.05, uLight) * uSmoke;
        float ca = 0.7071;
        vec2 g = vec2(gl_FragCoord.x * ca + gl_FragCoord.y * ca, -gl_FragCoord.x * ca + gl_FragCoord.y * ca) / 4.0;
        float dots = 1.0 - smoothstep(0.18, 0.32, length(fract(g) - 0.5) / max(vein, 0.05) * 0.4);
        col = mix(col, tone * mix(0.32, 0.6, uLight), dots * vein * 0.18 * uSmoke);
    }

    // 蓝图线稿：主齿轮后面一层细线画的齿轮组和作图圆，转动时比主齿轮慢一拍（视差）
    if (uWire > 0.0) {
        vec2 off = vec2(0.0, -uDrift * 0.004);
        vec3 lineCol = mix(uInk, uSteel, 0.5);
        float wl = 0.0;
        for (int i = 0; i < 5; i++) {
            float fi = float(i);
            vec2 c = hubC + off + vec2(0.62 + fi * 0.31 + sin(fi * 3.1) * 0.08, sin(fi * 2.3) * 0.36);
            if (i == 4) c = hubC + off + vec2(-0.05, 0.0);
            float R = i == 4 ? 0.46 : 0.07 + fract(fi * 0.618) * 0.09;
            float teeth = i == 4 ? 96.0 : floor(R * 220.0);
            float ang = uGear * (i == 4 ? -0.75 : (mod(fi, 2.0) < 1.0 ? 1.0 : -1.0) * 72.0 / teeth * 0.3);
            vec3 gw = gear(p - c, R, teeth, i == 4 ? 7.0 : 3.0 + mod(fi, 3.0), ang, aa * 1.2);
            wl = max(wl, gw.x * (1.0 - gw.x) * 4.0);
            float r = length(p - c);
            wl = max(wl, (1.0 - smoothstep(0.0, aa * 1.2, abs(r - R * 0.55))) * 0.6);
        }
        // 作图线：过主轴的几条放射线和同心圆
        vec2 q = p - hubC - off;
        float r = length(q), a = atan(q.y, q.x);
        float rad = (1.0 - smoothstep(0.0, aa * 1.2, abs(fract(a * 8.0 / (2.0 * PI) + 0.5) - 0.5) * 2.0 * PI * r / 8.0)) * step(0.4, r) * step(r, 0.62);
        float circ = (1.0 - smoothstep(0.0, aa * 1.2, abs(r - 0.52))) + (1.0 - smoothstep(0.0, aa * 1.2, abs(r - 0.6))) * 0.6;
        wl = max(wl, max(rad * 0.5, circ * 0.7));
        col = mix(col, lineCol, wl * mix(0.16, 0.22, uLight) * uWire * (1.0 + uBeat * 0.6));
    }

    // 刻度环：固定不转，60 格，指针位置（三点钟）那格是强调色
    {
        vec2 q = p - hubC;
        float r = length(q);
        float a = atan(q.y, q.x);
        float ringIn = 0.355, ringOut = 0.385;
        float inRing = smoothstep(ringIn - aa, ringIn, r) * (1.0 - smoothstep(ringOut, ringOut + aa, r));
        float tick = abs(fract(a * 60.0 / (2.0 * PI) + 0.5) - 0.5) * 2.0 * PI * r / 60.0;
        float major = step(abs(fract(a * 12.0 / (2.0 * PI) + 0.5) - 0.5), 0.02);
        float tw = mix(0.0012, 0.0024, major);
        float len = mix(0.37, 0.358, major);
        float mark = (1.0 - smoothstep(tw, tw + aa, tick)) * smoothstep(len - aa, len, r) * inRing;
        float line = (1.0 - smoothstep(0.0012, 0.0012 + aa, abs(r - ringOut + 0.002)));
        float here = 1.0 - smoothstep(0.03, 0.05, abs(a));
        vec3 ink = mix(uInk, uAccent, here);
        col = mix(col, ink, (mark + line * 0.8) * min(1.0, 0.55 + uBeat * 0.45));
        // 鼓点：刻度一圈亮起来，再从轴心推出一道冲击波
        float wave = 0.39 + (1.0 - uBeat) * 0.55;
        float shock = exp(-pow((r - wave) / 0.006, 2.0)) * uBeat * uBeat;
        col += mix(uInk, uAccent, 0.4) * shock * 0.35;
    }

    // 落影
    {
        vec2 s = vec2(0.012, -0.016);
        vec3 g1 = gear(p - hubC - s, 0.33, 72.0, 5.0, uGear, aa * 6.0);
        vec3 g2 = gear(p - C2 - s, 0.17, 37.0, 4.0, A2, aa * 6.0);
        vec3 g3 = gear(p - C3 - s, 0.095, 20.0, 3.0, A3, aa * 6.0);
        float shadow = max(max(g1.x, g2.x), g3.x);
        col *= 1.0 - shadow * mix(0.45, 0.18, uLight);
    }

    // 擒纵轮（小、钢色）、副齿轮、主齿轮。主齿轮在最前
    vec2 c2 = C2, c3 = C3;
    float a2 = A2, a3 = A3;
    vec3 g3 = gear(p - c3, 0.095, 20.0, 3.0, a3, aa);
    if (g3.x > 0.0) col = mix(col, metal(uSteel, p - c3, g3, a3), g3.x);
    vec3 g2 = gear(p - c2, 0.17, 37.0, 4.0, a2, aa);
    if (g2.x > 0.0) col = mix(col, metal(uBrass * 0.92, p - c2, g2, a2), g2.x);
    vec3 g1 = gear(p - hubC, 0.33, 72.0, 5.0, uGear, aa);
    if (g1.x > 0.0) col = mix(col, metal(uBrass, p - hubC, g1, uGear), g1.x);

    // 轴心宝石：低音时亮
    for (int i = 0; i < 3; i++) {
        vec2 c = i == 0 ? hubC : (i == 1 ? c2 : c3);
        float rr = i == 0 ? 0.03 : 0.017;
        float d = length(p - c);
        vec3 ruby = vec3(0.62, 0.06, 0.1);
        float body = 1.0 - smoothstep(rr - aa, rr, d);
        col = mix(col, ruby * (0.7 + 0.6 * (1.0 - d / rr)) + vec3(1.0, 0.75, 0.7) * smoothstep(rr * 0.5, 0.0, length(p - c - vec2(-0.3, 0.35) * rr)) * 0.6, body);
        col += vec3(1.0, 0.25, 0.25) * uGlow * exp(-d * d / (rr * rr * 6.0)) * 0.35;
        if (i == 0 && uBeat > 0.01) {
            vec2 dq = (p - c) / rr;
            float star = exp(-abs(dq.x) * 3.0) * exp(-abs(dq.y) * 0.18) + exp(-abs(dq.y) * 3.0) * exp(-abs(dq.x) * 0.18);
            col += vec3(1.0, 0.55, 0.5) * (star * 0.5 + exp(-dot(dq, dq) * 0.4) * 0.8) * uBeat;
        }
    }

    // 摆轮：右下角一只钢摆轮来回摆，游丝跟着一松一紧（每秒擒纵两次）
    {
        vec2 bc = vec2(aspect - 0.22, 0.25);
        float swing = 1.25 * sin(uTime * 6.2832 * 1.25);
        vec2 q = p - bc;
        float r = length(q);
        float R = 0.085;
        float a = atan(q.y, q.x) - swing;
        if (r < R + 0.02) {
            float ring = 1.0 - smoothstep(0.0045, 0.0045 + aa, abs(r - R));
            float sa = abs(fract(a * 3.0 / (2.0 * PI) + 0.5) - 0.5) * 2.0 * PI / 3.0 * r;
            float spoke = (1.0 - smoothstep(0.0022, 0.0022 + aa, sa)) * step(r, R);
            // 游丝：阿基米德螺线，摆到一头时紧、另一头松
            float b = 0.0058 * (1.0 + 0.12 * sin(uTime * 6.2832 * 1.25));
            float phi = atan(q.y, q.x) - swing * 0.6;
            float turnK = floor((r - 0.008 - b * (phi + PI)) / (b * 2.0 * PI) + 0.5);
            float sr = 0.008 + b * (phi + PI + turnK * 2.0 * PI);
            float spring = (1.0 - smoothstep(0.0009, 0.0009 + aa, abs(r - sr))) * step(r, R * 0.72) * step(0.008, r);
            // 摆轮边上的螺钉
            float screws = (1.0 - smoothstep(0.0045, 0.0045 + aa, length(vec2(abs(fract(a * 8.0 / (2.0 * PI) + 0.5) - 0.5) * 2.0 * PI / 8.0 * R, r - R - 0.006)))) * step(R - 0.004, r);
            vec3 steel = metal(uSteel, q, vec3(1.0, 0.0, r), swing);
            col = mix(col, steel, clamp(ring + spoke * 0.9 + screws, 0.0, 1.0));
            col = mix(col, mix(uSteel, uAccent, 0.35) * 1.2, spring * 0.8);
            float jewel = 1.0 - smoothstep(0.006, 0.006 + aa, r);
            col = mix(col, vec3(0.62, 0.06, 0.1) * 1.2, jewel);
        }
    }

    // 秒针：从轴心伸到刻度环，跟播放时间走
    if (uSecondHand > 0.5) {
        vec2 q = p - hubC;
        vec2 dir = vec2(cos(uSecond), sin(uSecond));
        float along = dot(q, dir);
        float perp = abs(dir.x * q.y - dir.y * q.x);
        float hand = (1.0 - smoothstep(0.0016, 0.0016 + aa, perp)) * step(-0.04, along) * step(along, 0.36);
        col = mix(col, uAccent, hand * 0.9);
    }

    // 歌词扇面：每句一根，从 R0 向外；当前句在三点钟方向
    float lit = 0.0;
    {
        vec2 q = p - hubC;
        float r = length(q);
        float a = atan(q.y, q.x) - uTurn;
        float k = floor(-a / STEP + 0.5);
        if (abs(k) <= 3.0 && r > R0 - 0.02) {
            float la = a + k * STEP;
            float along = r * cos(la) - R0;
            float perp = r * sin(la);
            float rowH = uFont * ${(ROW_PX / 100).toFixed(2)};
            float L = rowH * ${(ATLAS_W / ROW_PX).toFixed(1)};
            vec2 tc = vec2(along / L, (k + 3.0 + 0.5 - perp / rowH) / ROWS);
            if (tc.x > 0.0 && tc.x < 1.0 && abs(perp) < rowH * 0.5) {
                vec4 tx = texture(uText, tc);
                int gid = int(texelFetch(uText, ivec2(tc * vec2(${ATLAS_W}.0, ROWS * ${ROW_PX}.0)), 0).g * 255.0 + 0.5);
                vec2 se = gid > 0 ? texelFetch(uGlyph, ivec2(gid, 0), 0).xy : vec2(-1e9);
                float rowAng = abs(-k * STEP + uTurn);
                float near = 1.0 - smoothstep(0.0, STEP * 1.2, rowAng);
                float fade = 1.0 - smoothstep(STEP * 1.6, STEP * 3.0, rowAng);
                float reveal = gid > 0 ? smoothstep(se.x - 0.1, se.x + 0.1, uTime) : 1.0;
                float singing = gid > 0 ? smoothstep(se.x - 0.08, se.x + 0.05, uTime) * (1.0 - smoothstep(se.y, se.y + 0.45, uTime)) : 0.0;
                float alpha = tx.r * fade * mix(uWaiting * 0.8, 1.0, near) * mix(uWaiting + 0.25, 1.0, reveal);
                vec3 ink = mix(uInk, uAccent, singing);
                col = mix(col, ink, clamp(alpha, 0.0, 1.0));
                lit = alpha * near;
            }
        }
        // 当前句的指针线：从刻度环到字的起点
        float a0 = atan(q.y, q.x) - uTurn;
        float pointer = (1.0 - smoothstep(0.0011, 0.0011 + aa, abs(r * sin(a0)))) * step(0.388, r) * step(r * cos(a0), R0 - 0.012) * step(0.0, cos(a0));
        col = mix(col, uAccent, pointer * 0.7);
    }

    vec2 v = uv - vec2(0.35, 0.5);
    col *= 1.0 - dot(v, v) * mix(0.55, 0.25, uLight);
    col += (hash12(floor(gl_FragCoord.xy / 1.5) + uGrainStep * 11.0) - 0.5) * 0.03 * uGrain;
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
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`[clockwork] shader: ${gl.getShaderInfoLog(shader)}`);
            return shader;
        };
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`[clockwork] link: ${gl.getProgramInfoLog(program)}`);
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
        const slots = Array.from({ length: 2 }, () => ({ text: texture(gl.LINEAR, true), glyph: texture(gl.NEAREST, false), key: null, used: 0 }));
        return { gl, program, uniforms, vao: gl.createVertexArray(), slots };
    };

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('clockwork', '时计', container, services);
        const canvas = createElement('canvas', 'clockwork-canvas');
        const kicker = createElement('div', 'clockwork-kicker', '时计');
        const translation = createElement('div', 'stage-translation clockwork-translation');
        const notice = createElement('div', 'clockwork-notice');
        notice.hidden = true;
        mode.root.append(canvas, kicker, translation, notice);
        const atlas = document.createElement('canvas');
        atlas.width = ATLAS_W;
        atlas.height = ROWS * ROW_PX;

        let glState = null;
        try { glState = createGl(canvas); } catch (error) { console.error(error); }
        if (!glState) {
            notice.hidden = false;
            notice.textContent = '这台电脑的显卡不支持 WebGL2，时计画不出来，请换一个舞台';
        }
        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        const still = Utils.createStillGate();
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
        let lastOnsets = -1;
        let beatTime = -Infinity;
        const stats = { builds: 0, buildMs: 0, draws: 0, index: -2 };

        const settings = () => {
            const tuning = mode.config.modes?.clockwork || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                waitingOpacity: clamp(tuning.waitingOpacity ?? 0.35, 0, 1),
                secondHand: tuning.secondHand !== false,
                smoke: clamp(tuning.smoke ?? 1, 0, 2),
                wireframe: tuning.wireframe !== false,
                tilt: tuning.perspective !== false,
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
                field: light ? mixRgb(bg, [0.93, 0.9, 0.83], 0.5) : mixRgb(bg, [0.05, 0.045, 0.04], 0.55),
                ink: hexRgb(p.ink, light ? [0.1, 0.12, 0.12] : [0.95, 0.94, 0.9]),
                accent: hexRgb(p.accent, [0.95, 0.66, 0]),
                brass: light ? [0.72, 0.55, 0.3] : [0.66, 0.5, 0.28],
                steel: light ? [0.6, 0.62, 0.64] : [0.5, 0.52, 0.55]
            };
            mode.root.style.setProperty('--clockwork-field', `rgb(${colours.field.map(v => Math.round(v * 255)).join(',')})`);
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

        // 以第 index 句为中心的七行字图；只有中间那行写字编号
        const slotFor = (index, build = true) => {
            if (!glState) return null;
            const key = `${index}|${sung.length}`;
            const hit = glState.slots.find(slot => slot.key === key);
            if (hit) { hit.used = performance.now(); return hit; }
            if (!build) return null;
            const started = performance.now();
            const ctx = atlas.getContext('2d', { alpha: false });
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, ATLAS_W, ROWS * ROW_PX);
            ctx.textBaseline = 'alphabetic';
            const data = new Float32Array(256 * 4);
            const base = 92;
            for (let row = 0; row < ROWS; row += 1) {
                const i = index + row - 3;
                let glyphs = null;
                if (i >= 0 && i < sung.length) glyphs = buildGlyphTimeline(sung[i]).map(g => g.text);
                else if (i === -1 && row === 3) {
                    const title = String(latestFrame?.track?.title || '').replace(/\.(mp3|flac|wav|m4a|ogg)$/i, '');
                    glyphs = title ? Array.from(title) : null;
                }
                if (!glyphs) continue;
                let size = base;
                ctx.font = `500 ${size}px ${family()}`;
                const width = ctx.measureText(glyphs.join('')).width;
                if (width > ATLAS_W - 24) { size = Math.floor(size * (ATLAS_W - 24) / width); ctx.font = `500 ${size}px ${family()}`; }
                const baseline = row * ROW_PX + ROW_PX * 0.5 + size * 0.36;
                let x = 4;
                let id = 0;
                const timeline = row === 3 && i >= 0 ? buildGlyphTimeline(sung[i]) : null;
                glyphs.forEach((text, gi) => {
                    const w = ctx.measureText(text).width;
                    if (timeline && text.trim()) {
                        id = Math.min(255, id + 1);
                        ctx.globalCompositeOperation = 'lighten';
                        ctx.fillStyle = `rgb(0,${id},0)`;
                        ctx.fillRect(Math.floor(x - 1), row * ROW_PX + 4, Math.ceil(w + 2), ROW_PX - 8);
                        data[id * 4] = timeline[gi].startTime;
                        data[id * 4 + 1] = timeline[gi].endTime;
                    }
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.fillStyle = 'rgb(255,0,0)';
                    ctx.fillText(text, x, baseline);
                    x += w;
                });
            }
            const { gl } = glState;
            const busy = `${stats.index}|${sung.length}`;
            const slot = glState.slots.filter(sl => sl.key !== busy).sort((a, b) => a.used - b.used)[0] || glState.slots[0];
            gl.bindTexture(gl.TEXTURE_2D, slot.text);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
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
            if (idleHandle || !glState || index + 1 >= sung.length || slotFor(index + 1, false)) return;
            const run = () => { idleHandle = 0; if (!mode.destroyed && !lostContext) slotFor(index + 1, true); };
            idleHandle = global.requestIdleCallback ? global.requestIdleCallback(run, { timeout: 700 }) : global.setTimeout(run, 120);
        };

        const draw = (frame) => {
            if (!glState || lostContext) return;
            const { gl, program, uniforms: u, vao } = glState;
            const s = settings();
            const t = frame.playbackTime;
            const wheel = wheelAt(sung, t);
            const index = wheel.index;
            const slot = slotFor(index, true);
            if (!slot) return;
            stats.index = index;
            const turned = s.reducedMotion ? Math.max(index, -1) : wheel.turned;
            const audio = frame.audio || {};
            const bass = clamp((audio.bass || 0) * s.audioReactivity, 0, 1.5);
            glow = frame.isPlaying ? Math.max(bass, glow * 0.86) : glow;
            const tick = s.reducedMotion ? Math.floor(t) : escapement(t);
            // 一句转 STEP 弧度；每秒的擒纵也让主齿轮挪一点
            const gearAngle = turned * STEP + tick * 0.004;
            if (Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets) {
                if (lastOnsets >= 0 && frame.isPlaying) beatTime = t;
                lastOnsets = audio.onsets;
            }
            const beat = !s.reducedMotion && t >= beatTime ? Math.exp(-(t - beatTime) * 5) * Math.min(1, s.audioReactivity) : 0;
            const shake = beat * 0.0025;

            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.useProgram(program);
            gl.bindVertexArray(vao);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, slot.text); gl.uniform1i(u.uText, 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, slot.glyph); gl.uniform1i(u.uGlyph, 1);
            gl.uniform2f(u.uRes, canvas.width, canvas.height);
            gl.uniform1f(u.uTime, t);
            gl.uniform1f(u.uTurn, (turned - Math.max(index, -1)) * STEP);
            gl.uniform1f(u.uGear, gearAngle);
            gl.uniform1f(u.uSecond, Math.PI / 2 - (tick % 60) / 60 * Math.PI * 2);
            gl.uniform1f(u.uFont, 0.052 * s.fontScale);
            gl.uniform1f(u.uGlow, glow);
            gl.uniform1f(u.uLight, colours.light ? 1 : 0);
            gl.uniform1f(u.uWaiting, s.waitingOpacity);
            gl.uniform1f(u.uSecondHand, s.secondHand ? 1 : 0);
            gl.uniform3fv(u.uField, colours.field);
            gl.uniform3fv(u.uInk, colours.ink);
            gl.uniform3fv(u.uAccent, colours.accent);
            gl.uniform3fv(u.uBrass, colours.brass);
            gl.uniform3fv(u.uSteel, colours.steel);
            gl.uniform1f(u.uGrain, s.grain);
            gl.uniform1f(u.uGrainStep, s.reducedMotion ? 0 : Math.floor(t * 6) % 64);
            gl.uniform1f(u.uBeat, beat);
            gl.uniform1f(u.uSmoke, s.smoke);
            gl.uniform1f(u.uWire, s.wireframe ? 1 : 0);
            gl.uniform2f(u.uShake, Math.sin(t * 91) * shake, Math.cos(t * 77) * shake);
            gl.uniform1f(u.uDrift, turned);
            // 镜头随歌慢慢换角度：每句转一格时表盘的倾角也跟着漂
            gl.uniform2f(u.uTilt, s.reducedMotion || !s.tilt ? 0 : 0.26 * Math.sin(turned * 0.42 + 0.6), s.reducedMotion || !s.tilt ? 0 : 0.12 * Math.sin(turned * 0.29 + 2.1));
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            stats.draws += 1;
            scheduleNext(index);
        };

        const updateOverlay = (frame) => {
            const next = `时计 · ${Utils.lineCounter(frame)}`;
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
        mode.updateConfig = (config) => { updateConfig(config); resize(); readColours(); glState?.slots.forEach((slot) => { slot.key = null; }); redraw(); };
        mode.resize = () => { resize(); redraw(); };
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); redraw(); };
        mode.updateTheme = () => { readColours(); redraw(); };
        mode.getDebugSnapshot = () => ({
            initialized: Boolean(glState), lines: sung.length, index: stats.index,
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

    global.MusicStageClockworkManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ lineIndexAt, wheelAt, escapement, settle })
    });
})(window);
