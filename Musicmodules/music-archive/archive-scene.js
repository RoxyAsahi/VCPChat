/*
 * 曲目档案阵列的 3D 场景：一排排立着的档案卡，选中的那张抬起，同一列跟着起伏。
 * 只画视野里的 9 列 × 32 行，卡片用实例化网格一次画完，滚到哪里就把这一池卡片
 * 重新摆到哪里（阵列在两个方向循环），所以曲库有几千首也只有这 288 张卡。
 *
 * 依赖全局 THREE（vendor/three.min.js）。不读播放器状态，由 archive-view.js 驱动。
 */
(function (global) {
    'use strict';

    const LANES_HALF = 4;          // 视野里左右各 4 列
    const ROWS_BEFORE = 16;        // 选中行前后共 32 行
    const ROWS_AFTER = 16;
    const POOL = (LANES_HALF * 2 + 1) * (ROWS_BEFORE + ROWS_AFTER);
    const COLUMN_SPACING = 5.2;
    const ROW_SPACING = 0.62;
    const CARD_W = 5, CARD_H = 3.7, CARD_D = 0.34;
    const BASE_Y = -4.6;
    const DIST = 140;
    const AIM = Object.freeze([-1.091, -0.045, 0.481]);
    const YAW = 59 * Math.PI / 180;
    const ELEV = 19 * Math.PI / 180;

    /*
     * 画质档位，和歌词舞台的三档对齐：帧率上限、阴影、抗锯齿、像素比上限。
     * 静止（2 秒没有操作、相机停稳）后只剩待机起伏和正在播放的轻跳，三档都降到 12 帧；
     * 像素比最高 1.5（高分屏上 2 倍像素要多画 78% 的像素，卡片边缘看不出区别）。
     */
    const IDLE_AFTER = 2000;
    const TIERS = Object.freeze({
        'energy-saving': Object.freeze({ fps: 30, idleFps: 12, shadows: false, shadowSize: 0, antialias: false, maxDpr: 1 }),
        standard: Object.freeze({ fps: 60, idleFps: 12, shadows: true, shadowSize: 1024, antialias: true, maxDpr: 1.5 }),
        ultimate: Object.freeze({ fps: 0, idleFps: 12, shadows: true, shadowSize: 2048, antialias: true, maxDpr: 1.5 })
    });
    const tierOf = (quality) => TIERS[quality] || TIERS.standard;

    /*
     * 两套主题的整体外观，数值照参考播放器：底色、远处淡进去的雾色、色调映射的曝光、雾的起止（相对镜头距离）。
     * 雾色按原样当作线性值用（参考实现就是这么混的）；底色是纸色（#eae5e1 / #11181b）按各自曝光反算回
     * 色调映射前的值，取出卡片、镜头抬高露出背景时，背景正好是页面的纸色。
     * tag / tagInk / tagRing 是取出卡片时卡面说明文字用的。
     */
    const LIGHTING = Object.freeze({
        light: { bg: [1.7461, 1.4294, 1.231], fog: [0.918, 0.898, 0.882], exposure: 0.76, theme: 0, fogNear: 5, fogFar: 25, tag: '#ece6dc', tagInk: 'rgba(52,54,54,.78)', tagRing: 'rgba(60,55,48,.55)', etch: 'rgba(110,104,96,.6)', mat: ['#ffffff', 0.5] },
        dark: { bg: [0.017, 0.0237, 0.0269], fog: [0.06, 0.075, 0.08], exposure: 0.98, theme: 1, fogNear: 1, fogFar: 16, tag: '#2c363b', tagInk: 'rgba(224,227,220,.75)', tagRing: 'rgba(220,226,222,.45)', etch: 'rgba(214,220,218,.3)', mat: ['#c9cfcf', 0.18] }
    });

    /* ACES 色调映射曲线部分的反函数：给定映射后的值，求映射前的值（和 three 的 ACESFilmicToneMapping 同一组系数） */
    const rrtInverse = (y) => {
        y = Math.min(0.995, Math.max(0, y));
        const qa = 1 - 0.983729 * y, qb = 0.0245786 - 0.4329510 * y, qc = -(0.000090537 + 0.238081 * y);
        return (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
    };
    /* 六个朝向（+x +y +z -x -y -z）各自正中的底色亮度，浅色六个在前、深色六个在后；着色器里给倒角混色用 */
    const toLinear = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    const radianceOf = (c) => c.map((v) => rrtInverse(toLinear(v)) * 0.6 / 1.02);
    const FACE_CENTERS = (() => {
        const side = [0.9275, 0.9075, 0.8675], top = [0.965, 0.95, 0.925], wide = [0.78, 0.695, 0.58];
        const nSide = [0.285, 0.295, 0.295], nTop = [0.36, 0.37, 0.37], nWide = [0.2, 0.211, 0.214];
        return [side, top, wide, side, side, wide, nSide, nTop, nWide, nSide, nSide, nWide].map(radianceOf);
    })();

    /*
     * 卡盒着色不用实时灯光。参考播放器把卡盒的明暗离线烘成贴图：端面乳白、宽面从下往上由暖棕过渡到
     * 象牙白、四边一圈提亮，再加选中卡里五个暖光点照到自己和周围几排卡的光。这里按同一组公式
     * 直接在着色器里算，省掉贴图。颜色先给「最终显示出来的 sRGB 值」，再反算回色调映射前的亮度，
     * 所以屏幕上看到的就是这里写的颜色（浅色主题的曝光 0.76 再统一压一点）。
     * 局部坐标：原点在卡底边中点，宽 5、高 3.7，面板正面 z = 0.206。
     */
    const CARD_VERT = `
#include <common>
#include <fog_pars_vertex>
uniform mat4 uGlowInv;
varying vec3 vLocal;
varying vec3 vObjN;
varying vec3 vEmit;
varying vec3 vEmitN;
varying vec3 vWorld;
varying vec3 vWorldN;
varying vec2 vState;
void main() {
    mat4 m = modelMatrix;
#ifdef USE_INSTANCING
    m = m * instanceMatrix;
#endif
    vec4 world = m * vec4(position, 1.0);
    vec3 wn = normalize(mat3(m) * normal);
    vLocal = position;
    vObjN = normal;
    vEmit = (uGlowInv * world).xyz;
    vEmitN = mat3(uGlowInv) * wn;
    vWorld = world.xyz;
    vWorldN = wn;
#ifdef USE_INSTANCING_COLOR
    vState = instanceColor.rg;
#else
    vState = vec2(0.0);
#endif
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
#include <fog_vertex>
}`;
    const CARD_FRAG = `
#include <common>
#include <fog_pars_fragment>
// 取出端详用象牙白方案（B）；去掉这一行就是照参考的玻璃 + 暖棕内衬（A）
#define HERO_IVORY
uniform float uLightOn;
uniform float uHero;
uniform float uSeeThrough;
uniform vec3 uCenter[12];
varying vec3 vLocal;
varying vec3 vObjN;
varying vec3 vEmit;
varying vec3 vEmitN;
varying vec3 vWorld;
varying vec3 vWorldN;
varying vec2 vState;
const vec3 WARM = vec3(1.0, 0.72, 0.38);
float toLinear(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
// 目标显示值 → 色调映射前的亮度（只反算 ACES 的曲线部分，和参考实现的烘焙一致，按曝光 1.02 算）
vec3 radiance(vec3 c) {
    vec3 y = min(vec3(toLinear(c.r), toLinear(c.g), toLinear(c.b)), 0.995);
    vec3 qa = 1.0 - 0.983729 * y, qb = 0.0245786 - 0.4329510 * y, qc = -(0.000090537 + 0.238081 * y);
    return (-qb + sqrt(qb * qb - 4.0 * qa * qc)) / (2.0 * qa) * (0.6 / 1.02);
}
// 0 +x、1 +y、2 +z、3 -x、4 -y、5 -z
int faceOf(vec3 d) {
    vec3 a = abs(d);
    if (a.x > a.z) return a.x > a.y ? (d.x > 0.0 ? 0 : 3) : (d.y > 0.0 ? 1 : 4);
    return a.z > a.y ? (d.z > 0.0 ? 2 : 5) : (d.y > 0.0 ? 1 : 4);
}
vec3 faceAxis(int f) {
    return f == 0 ? vec3(1.0, 0.0, 0.0) : f == 1 ? vec3(0.0, 1.0, 0.0) : f == 2 ? vec3(0.0, 0.0, 1.0)
        : f == 3 ? vec3(-1.0, 0.0, 0.0) : f == 4 ? vec3(0.0, -1.0, 0.0) : vec3(0.0, 0.0, -1.0);
}
vec2 surfaceUv(int face, vec3 p) {
    vec2 uv = vec2((p.x + 2.5) / 5.0, p.y / 3.7);
    if (face == 0 || face == 3) uv.x = (p.z + 0.25) / 0.5;
    else if (face == 1 || face == 4) uv.y = (p.z + 0.25) / 0.5;
    return clamp(uv, 0.0, 1.0);
}
// rgb：这一面的底色（亮度）；a：选中时左侧那条柔光的强度
vec4 faceSample(int face, vec2 uv, float dark) {
    float x = uv.x * 5.0 - 2.5, y = uv.y * 3.7;
    if (face == 0 || face == 3) x = face == 0 ? 2.5 : -2.5;
    else if (face == 1 || face == 4) y = face == 1 ? 3.7 : 0.0;
    float border = exp(-min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) / 0.025);
    vec3 day;
    if (face == 2 || face == 5) day = mix(vec3(0.70, 0.60, 0.46) + uv.y * vec3(0.16, 0.19, 0.24), vec3(0.94, 0.91, 0.85), border * 0.65);
    else if (face == 1) day = vec3(0.965, 0.95, 0.925);
    else day = vec3(0.90, 0.875, 0.825) + uv.y * vec3(0.055, 0.065, 0.085);
    // 深色不照搬参考的青灰：中性石墨灰，宽面下深上浅，端面和顶面亮一档，四边一圈细亮边
    vec3 night;
    if (face == 2 || face == 5) night = mix(vec3(0.165, 0.175, 0.178) + uv.y * vec3(0.07, 0.072, 0.072), vec3(0.33, 0.34, 0.34), border * 0.6);
    else if (face == 1) night = vec3(0.36, 0.37, 0.37);
    else night = vec3(0.27, 0.28, 0.28) + uv.y * vec3(0.03, 0.03, 0.03);
    float band = smoothstep(0.08, 0.5, y) * (1.0 - smoothstep(3.25, 3.67, y));
    float glow = (0.55 * exp(-abs(x + 2.22) / 0.48) + 0.05) * band;
    vec3 c = dark <= 0.0 ? radiance(day) : dark >= 1.0 ? radiance(night) : mix(radiance(day), radiance(night), dark);
    return vec4(c, glow);
}
// 倒角的朝向：按法线在三个面之间混色，再加一处很窄的柔和高光（左上前方）
vec4 normalResponse(vec3 n, float dark) {
    vec3 a = abs(n);
    int fx = n.x >= 0.0 ? 0 : 3, fy = n.y >= 0.0 ? 1 : 4, fz = n.z >= 0.0 ? 2 : 5;
    int primary = a.x >= a.y && a.x >= a.z ? fx : a.y >= a.z ? fy : fz;
    vec3 w = n * n;
    w /= w.x + w.y + w.z;
    vec3 blended = w.x * mix(uCenter[fx], uCenter[fx + 6], dark) + w.y * mix(uCenter[fy], uCenter[fy + 6], dark)
        + w.z * mix(uCenter[fz], uCenter[fz + 6], dark);
    vec3 response = min(vec3(4.0), blended / max(mix(uCenter[primary], uCenter[primary + 6], dark), vec3(0.0001)));
    float highlight = 0.18 * pow(max(0.0, dot(n, vec3(-0.48, 0.80, 0.36))), 24.0) * mix(1.0, 0.25, dark);
    return vec4(response, highlight);
}
// 选中卡里的五个暖光点（左侧竖排三个强、中间两个弱）照到 p 点（选中卡局部坐标）的光，
// 每隔一张卡衰减 22%，朝背光一侧也透一些（磨砂散射）。参考实现里这是一张低分辨率的三维光场贴图。
vec3 field(vec3 p, vec3 n, float soft) {
    if (abs(p.x) > 9.0 || abs(p.z) > 7.0) return vec3(0.0);
    p.y = clamp(p.y, -0.4, 4.8);
    float layer = pow(0.78, min(max(abs(p.z) / 0.62 - 0.35, 0.0), 12.0));
    // 先估上限：五个光点合起来最多 3.44 / (0.30 + 到光点包围盒距离²)，乘层衰减后小于 0.0015 就不算了
    // （0.0015 的线性亮度经过色调映射不到 1/255，画面上看不出差别）。阵列远处的大部分像素在这里就退出了
    vec3 q = p - clamp(p, vec3(-2.22, 0.60, 0.08), vec3(1.10, 2.75, 0.08));
    if (3.44 * layer / (0.30 + soft + dot(q, q)) < 0.0015) return vec3(0.0);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 5; i++) {
        vec3 e = i == 0 ? vec3(-2.22, 0.60, 0.08) : i == 1 ? vec3(-2.22, 1.65, 0.08) : i == 2 ? vec3(-2.22, 2.75, 0.08)
            : i == 3 ? vec3(-0.9, 1.8, 0.08) : vec3(1.1, 1.8, 0.08);
        vec3 o = e - p;
        float d2 = dot(o, o);
        float c = dot(n, o * inversesqrt(max(d2, 0.04)));
        float scatter = 0.82 * (0.26 + 0.74 * pow(max(-c, 0.0), 0.65));
        float power = i < 3 ? 0.85 : 0.28;
        float I = power * (max(c, 0.0) * 0.28 + scatter) / (0.30 + soft + d2);
        sum += I * WARM * exp(-vec3(0.32, 0.90, 2.5) * 0.12 / max(abs(c), 0.22));
    }
    return min(sum * layer, vec3(4.0));
}
void main() {
    float dark = vState.x;
    float selected = step(0.5, vState.y);
    float hero = selected * uHero;          // 取出端详的进度，只在选中卡上非零
    vec3 n = normalize(vObjN);
    int face = faceOf(n);
    vec4 baked = faceSample(face, surfaceUv(face, vLocal), dark);
    // 托盘正面只在面板的圆孔、缺口里露出来：浏览时按顶面亮色画（孔看着是浅色小圆点），
    // 端详时换成固定螺丝的钛灰（参考 RhiScene.cpp musicDraws：Titanium_Fasteners 固定成暗色）
    bool socket = face == 2 && vLocal.z < 0.2;
    if (socket) baked.rgb = mix(mix(uCenter[1], uCenter[7], dark), radiance(mix(vec3(0.43, 0.45, 0.46), vec3(0.55, 0.57, 0.58), dark)), hero);
    vec4 nr = normalResponse(n, dark);
    // 深色里暖光只留三分之一（不照搬参考：参考深色下光场和浅色同强度，大片琥珀色压在暗底上显脏）
    float glowGain = mix(1.0, 0.32, dark);
    // 端详时镜头贴得很近：光场放散，免得卡面上一颗颗光斑（参考是低分辨率三维光场三线性采样，本身就是糊的）
    float soft = hero * 0.45;
    vec3 fieldHere = field(vEmit, faceAxis(faceOf(normalize(vEmitN))), soft) * uLightOn * glowGain;
    // opticalSurface.frag 壳体分支：baked * normalResponse + highlight + 光场 + 选中自发光
    vec3 shell = baked.rgb * nr.rgb + nr.a + fieldHere + WARM * baked.a * selected * uLightOn * glowGain;
    vec3 color = shell;
    bool plateFront = face == 2 && vLocal.z > 0.15;
    if (selected > 0.5 && plateFront) {
        // 选中卡的面板半透，透出后面贴着光源的内衬板（Optical_Diffuser，z = -0.038）。
        // 浏览：面板不透明度 0.62（RhiScene.cpp musicDraws opacity），透 38%；
        vec4 inner = faceSample(2, surfaceUv(2, vec3(vLocal.xy, -0.038)), dark);
        vec3 innerColor = inner.rgb + (field(vec3(vEmit.xy, -0.038), vec3(0.0, 0.0, 1.0), soft) + WARM * inner.a) * uLightOn * glowGain;
        color = mix(shell, innerColor, uSeeThrough);
#ifdef HERO_IVORY
        // 端详（方案 B）：内衬换成干净的象牙白，光场只留一成五
        vec3 ivory = mix(uCenter[1], uCenter[7], dark) * mix(0.97, 0.8, dark);
        vec3 heroFront = ivory + (innerColor - inner.rgb) * 0.15;
#else
        // 端详（方案 A，照参考）：面板走玻璃分支（opticalSurface.frag flags 3 + hero），
        // 几乎全透，看到的是内衬板；玻璃只加掠射角反光、轮廓亮边和一条主光高光
        vec3 heroFront = innerColor;
#endif
        color = mix(color, heroFront, hero);
    } else if (selected > 0.5 && !socket) {
        // 端详时托盘（Ivory_Edges，flags 4 + hero）：材料色 + 光场，不用烘焙图集
        vec3 edgeColor = mix(vec3(0.941, 0.906, 0.875), vec3(0.408, 0.447, 0.467) * 0.75, dark) + fieldHere;
        color = mix(color, edgeColor, hero);
    }
    if (hero > 0.0) {
        // keyLight()：正上方略偏前一束主光，漫反射 0.55 + 0.45·N·L，高光指数 mix(20, 90, gloss)
        vec3 wn = normalize(vWorldN);
        const vec3 KEY = vec3(0.0, 0.5477, 0.8367);
        vec3 v = normalize(cameraPosition - vWorld);
        float ndl = max(dot(wn, KEY), 0.0);
        float gloss = plateFront ? 0.6 : 0.35;
        float spec = pow(max(dot(wn, normalize(KEY + v)), 0.0), mix(20.0, 90.0, gloss)) * mix(0.18, 0.85, gloss);
        vec3 lit = color * (0.55 + 0.45 * ndl) + spec;
        if (plateFront) {
            // 玻璃层：clearGlass = tint·0.06 + 雾色·(0.04 + 0.95·fresnel) + 高光 + sheen·0.85 + 亮边·0.55，
            // 不透明度 0.06 + rim·1.3 + fresnel·0.35
            float ndv = clamp(dot(wn, v), 0.0, 1.0);
            float fresnel = pow(1.0 - ndv, 5.0);
            float rim = pow(1.0 - ndv, 2.2);
            vec3 tint = mix(vec3(1.0, 0.992, 0.98), vec3(0.384, 0.42, 0.439), dark);
            float gspec = pow(max(dot(wn, normalize(KEY + v)), 0.0), 90.0) * 1.2;
            vec3 glass = tint * 0.06 + fogColor * (0.04 + 0.95 * fresnel) + gspec + mix(tint, vec3(1.0), 0.3) * (0.10 + 1.15 * rim) * 0.85
                + smoothstep(0.55, 0.98, rim) * 0.55;
            lit = mix(lit, glass, clamp(0.06 + rim * 1.3 + fresnel * 0.35, 0.0, 0.92));
        }
        color = mix(color, lit, hero);
    }
    gl_FragColor = vec4(color, 1.0);
#include <fog_fragment>
}`;

    const smoother = (t) => { t = Math.max(0, Math.min(1, t)); return t * t * t * (10 + t * (-15 + 6 * t)); };
    const bell = (x, w) => Math.exp(-0.5 * (x / w) * (x / w));

    /* 选中行两侧的隆起：越靠近选中行越高，远处略低于基线。形状固定，不随时间变。 */
    const settlingWave = (d) => {
        const age = 1.51 - Math.abs(d) * 0.065;
        const env = Math.max(-0.42, 2.15 - 0.17 * (Math.sqrt(d * d + 1) - 1));
        const rise = smoother(age / 0.62);
        const ring = age > 0 ? Math.sin(age * 5.1) * Math.exp(-age * 1.3) : 0;
        return env * (rise + 0.18 * ring * smoother(age / 0.16));
    };
    const columnStrength = (lane, focus) => 0.25 + 0.75 * bell(lane - focus, 0.55);
    const idleWave = (row, lane, t) => 0.075 * Math.sin(t * Math.PI * 2 / 8 + row * 0.3 - lane * 0.45)
        + 0.027 * Math.sin(t * Math.PI * 2 / 13 - row * 0.17 + lane * 0.3);
    /* 换选中时从新位置荡开的一圈波纹 */
    const selectionWave = (distance, age) => {
        if (age < 0 || age > 3.2) return 0;
        return 0.8 * smoother(age / 0.2) * Math.exp(-age * 1.15) * Math.cos((distance - age * 8) * 0.58) * bell(distance - age * 8, 3.4);
    };
    /* 临界阻尼弹簧，rate 越大越快到位 */
    const damp = (s, target, rate, dt) => {
        const d = s.v - target;
        const imp = s.vel + rate * d;
        const dec = Math.exp(-rate * dt);
        s.v = target + (d + imp * dt) * dec;
        s.vel = (s.vel - rate * imp * dt) * dec;
    };

    /* 圆角盒：细分的盒子把每个顶点推到圆角上。法线顺带算好，不需要 uv。 */
    const roundedBox = (THREE, width, height, depth, segments, radius) => {
        const seg = segments * 2 + 1;
        radius = Math.min(width / 2, height / 2, depth / 2, radius);
        const box = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg).toNonIndexed();
        box.deleteAttribute('uv');
        const pos = box.attributes.position.array;
        const nor = box.attributes.normal.array;
        const half = [width / 2 - radius, height / 2 - radius, depth / 2 - radius];
        const halfSeg = 0.5 / seg;
        for (let i = 0; i < pos.length; i += 3) {
            let nx = pos[i], ny = pos[i + 1], nz = pos[i + 2];
            const sx = Math.sign(nx), sy = Math.sign(ny), sz = Math.sign(nz);
            nx -= sx * halfSeg; ny -= sy * halfSeg; nz -= sz * halfSeg;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len; ny /= len; nz /= len;
            pos[i] = half[0] * sx + nx * radius;
            pos[i + 1] = half[1] * sy + ny * radius;
            pos[i + 2] = half[2] * sz + nz * radius;
            nor[i] = nx; nor[i + 1] = ny; nor[i + 2] = nz;
        }
        box.attributes.position.needsUpdate = true;
        box.attributes.normal.needsUpdate = true;
        return box;
    };

    /*
     * 卡盒模型，尺寸照参考播放器的卡盒量的：后面一个象牙色托盘，正面压一块 0.032 厚的面板，
     * 面板四边一道小倒角，左上角缺一个口（插索引卡的槽），右上和左下各开一个小圆孔（固定扣的位置）。
     * 两块合成一个几何体，只有位置和法线。
     */
    const cassetteGeometry = (THREE) => {
        const tray = roundedBox(THREE, 4.986, 3.68, 0.32, 2, 0.03);
        tray.translate(0, 1.85, 0.03);            // z -0.13 … 0.19
        const B = 0.012;                          // 面板倒角
        const shape = new THREE.Shape();
        const x0 = -2.5 + B, x1 = 2.5 - B, y0 = B, y1 = 3.7 - B;
        const n0 = -2.284 - B, n1 = -2.034 + B, ny = 3.475 - B;
        shape.moveTo(x0, y0); shape.lineTo(x1, y0); shape.lineTo(x1, y1); shape.lineTo(n1, y1);
        shape.lineTo(n1, ny); shape.lineTo(n0, ny); shape.lineTo(n0, y1); shape.lineTo(x0, y1); shape.closePath();
        for (const [cx, cy] of [[2.389, 3.526], [-2.335, 0.14]]) {
            const hole = new THREE.Path();
            hole.absarc(cx, cy, 0.082 + B, 0, Math.PI * 2, true);
            shape.holes.push(hole);
        }
        const plate = new THREE.ExtrudeGeometry(shape, { depth: 0.032 - 2 * B, bevelEnabled: true, bevelThickness: B, bevelSize: B, bevelSegments: 2, curveSegments: 14 });
        plate.translate(0, 0, 0.174 + B);         // z 0.174 … 0.206
        const parts = [tray, plate.index ? plate.toNonIndexed() : plate];
        const count = parts.reduce((n, g) => n + g.attributes.position.count, 0);
        const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
        let o = 0;
        for (const g of parts) {
            pos.set(g.attributes.position.array, o);
            nor.set(g.attributes.normal.array, o);
            o += g.attributes.position.count * 3;
        }
        tray.dispose(); plate.dispose(); parts[1].dispose();
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        return geo;
    };

    const create = (options) => {
        const THREE = global.THREE;
        if (!THREE) throw new Error('THREE is not loaded');
        const host = options.host;
        const tier = tierOf(options.quality);
        const reducedMotion = () => Boolean(options.reducedMotion && options.reducedMotion());

        const canvas = document.createElement('canvas');
        canvas.className = 'archive-canvas';
        host.appendChild(canvas);

        const renderer = new THREE.WebGLRenderer({ canvas, antialias: tier.antialias, powerPreference: 'high-performance', alpha: false });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;

        const scene = new THREE.Scene();

        const camera = new THREE.PerspectiveCamera(3, 16 / 9, 5, 300);

        /*
         * 卡盒：一个实例化网格画完全部卡。每张卡的实例颜色只当参数用：r = 主题（0 浅 1 深，翻主题时逐张过渡），
         * g = 是否选中（选中卡里的暖光、半透面板只在这张上算）。
         */
        const glowUniforms = {
            uGlowInv: { value: new THREE.Matrix4() },
            uLightOn: { value: 0 },
            uHero: { value: 0 },
            uSeeThrough: { value: 0.38 },
            uCenter: { value: FACE_CENTERS.map((c) => new THREE.Vector3(c[0], c[1], c[2])) }
        };
        const FRONT = 0.206;           // 面板正面的 z
        const cassetteMat = new THREE.ShaderMaterial({
            uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
            vertexShader: CARD_VERT,
            fragmentShader: CARD_FRAG,
            fog: true
        });
        Object.assign(cassetteMat.uniforms, glowUniforms);
        const cards = new THREE.InstancedMesh(cassetteGeometry(THREE), cassetteMat, POOL);
        cards.frustumCulled = false;
        scene.add(cards);
        const layers = [cards];
        const TINTED = [[cards, 'card']];
        const tint = { card: new THREE.Color(1, 0, 0) };
        const paintUniform = () => {
            for (const [mesh, part] of TINTED) {
                for (let i = 0; i < POOL; i++) mesh.setColorAt(i, tint[part]);
                mesh.instanceColor.needsUpdate = true;
            }
        };
        paintUniform();
        let accentIdx = -1;
        const accentTmp = new THREE.Color();

        // ---- 卡面标题：只给相机附近几列看得见的卡贴，贴片池循环复用 ----
        // 每张贴片一块小画布，换卡时只重画这一块；一帧最多重画几块，避免滚动时卡顿。
        // 字色压得比 HUD 淡，免得和浮在上面的说明文字抢
        const LABEL_LANES = tier.shadows ? 1 : 0;          // 省电档只贴当前这一列
        const LABEL_ROWS = [-8, 10];
        const LABEL_POOL = (LABEL_LANES * 2 + 1) * (LABEL_ROWS[1] - LABEL_ROWS[0] + 1);
        const LABEL_DRAWS_PER_FRAME = 8;
        const LABEL_W = 3.5, LABEL_H = 0.26;
        const labelGeo = new THREE.PlaneGeometry(LABEL_W, LABEL_H);
        labelGeo.translate(0.2, 3.5, FRONT + 0.004);
        const labelInk = { ink: 'rgba(224,227,220,.86)', muted: 'rgba(166,176,177,.8)' };
        const labels = Array.from({ length: LABEL_POOL }, () => {
            const c = document.createElement('canvas');
            c.width = 768; c.height = 58;
            const tex = new THREE.CanvasTexture(c);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
            const mesh = new THREE.Mesh(labelGeo, mat);
            mesh.visible = false;
            scene.add(mesh);
            return { mesh, canvas: c, tex, mat, cell: null, drawn: null };
        });
        let labelFor = null;                 // (lane, row) => { key, title, code } | null
        let labelEpoch = 0;                  // 主题、字体、数据变了就加一，旧的画面全部作废
        const drawLabel = (L, info) => {
            const g = L.canvas.getContext('2d');
            g.clearRect(0, 0, 768, 58);
            g.textBaseline = 'middle';
            g.font = '500 20px ' + fontStack;
            const code = String(info.code || '');
            const codeW = code ? g.measureText(code).width : 0;
            g.fillStyle = labelInk.muted;
            if (code) g.fillText(code, 768 - 8 - codeW, 30);
            g.font = '500 30px ' + fontStack;
            g.fillStyle = labelInk.ink;
            let title = String(info.title || '');
            const room = 768 - 16 - codeW - 36;
            if (g.measureText(title).width > room) {
                while (title.length > 1 && g.measureText(title + '…').width > room) title = title.slice(0, -1);
                title += '…';
            }
            g.fillText(title, 8, 31);
            L.tex.needsUpdate = true;
            L.drawn = info.key + '#' + labelEpoch;
        };
        const labelWanted = new Map();
        let labelsPending = false;
        const placeLabels = () => {
            labelsPending = false;
            const free = [];
            for (const L of labels) {
                if (L.cell && labelWanted.has(L.cell)) continue;
                L.cell = null;
                free.push(L);
            }
            const taken = new Set(labels.filter((L) => L.cell).map((L) => L.cell));
            for (const [cell] of labelWanted) {
                if (taken.has(cell)) continue;
                // 优先用之前就画着这张卡的贴片，省得重画
                const want = labelWanted.get(cell).info;
                let k = free.findIndex((L) => L.drawn === want.key + '#' + labelEpoch);
                if (k === -1) k = free.length - 1;
                if (k < 0) break;
                const L = free.splice(k, 1)[0];
                L.cell = cell;
            }
            let draws = 0;
            for (const L of labels) {
                const w = L.cell ? labelWanted.get(L.cell) : null;
                if (!w || (detailOn && artMat.map && L.cell === target.lane + ':' + target.row)) { L.mesh.visible = false; continue; }
                if (L.drawn !== w.info.key + '#' + labelEpoch) {
                    if (draws >= LABEL_DRAWS_PER_FRAME) { L.mesh.visible = false; labelsPending = true; continue; }
                    drawLabel(L, w.info);
                    draws++;
                }
                L.mesh.position.set(w.x, w.y, w.z);
                L.mesh.rotation.set(w.tilt || 0, w.turn || 0, 0);   // 跟卡一起顺着坡度微倾、一起转回正面
                if (underMask(w)) { L.mesh.visible = false; continue; }
                // 当前列的标题实一些，左右邻列淡一些（邻列离相机更近，不压低会比当前列还显眼）
                L.mat.opacity = w.li === 0 ? 1 : 0.5;
                L.mesh.visible = true;
            }
        };
        // 目录和歌词投在画面上的区域：落在里面的卡不贴标题，免得和浮字叠在一起
        let labelMasks = [];
        const projA = new THREE.Vector3(), projB = new THREE.Vector3();
        const underMask = (w) => {
            if (!labelMasks.length) return false;
            projA.set(w.x + 0.2 - LABEL_W / 2, w.y + 3.5, w.z + FRONT).project(camera);
            projB.set(w.x + 0.2 + LABEL_W / 2, w.y + 3.5, w.z + FRONT).project(camera);
            const x0 = (Math.min(projA.x, projB.x) + 1) / 2 * W, x1 = (Math.max(projA.x, projB.x) + 1) / 2 * W;
            const y0 = (1 - Math.max(projA.y, projB.y)) / 2 * H, y1 = (1 - Math.min(projA.y, projB.y)) / 2 * H;
            return labelMasks.some((r) => x1 > r.left && x0 < r.right && y1 > r.top && y0 < r.bottom);
        };
        /* rects：画布像素坐标 { left, top, right, bottom } */
        const setLabelMask = (rects) => { labelMasks = Array.isArray(rects) ? rects : []; invalidate(); };
        const setLabeler = (fn) => { labelFor = typeof fn === 'function' ? fn : null; labelEpoch++; invalidate(); };
        const refreshLabels = () => { labelEpoch++; invalidate(); };

        let lighting = LIGHTING.dark;
        let fontStack = 'sans-serif';

        /*
         * 主题翻色。整体（背景、雾、地面、灯光）用 0.85 秒缓动过去；卡片按到原点的距离依次翻，
         * 每张 0.58 秒，最远的晚 0.6 秒起步，1.18 秒后全部落定。中途再换一次，每张卡从它当时的颜色接着翻。
         */
        const GLOBAL_DUR = 0.85, CARD_DUR = 0.58, MAX_DELAY = 0.6, WAVE_TOTAL = 1.18;
        const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
        const nowS = () => performance.now() / 1000;
        const rawColor = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
        const lookOf = (l) => ({ bg: rawColor(l.bg), fog: rawColor(l.fog), exposure: l.exposure, theme: l.theme, fogNear: l.fogNear, fogFar: l.fogFar });
        const COLOR_KEYS = ['bg', 'fog'];
        const NUM_KEYS = ['exposure', 'theme', 'fogNear', 'fogFar'];
        /*
         * 后期，照参考播放器的最后一步：场景先画进一张半浮点的离屏图，再用一个全屏三角形做
         * 「离焦柔化 → 色调映射 → 纸色压边」。柔化是 3×3 二项核（中心 4、上下左右 2、对角 1），
         * 采样半径随离画面 52% 高度那条带的距离从 1 像素加到 7 像素，越往上下越虚；
         * 之后上半截、下沿、四角往纸色压（浅色、深色各一套比例）。取出详情时柔化和压边都收掉。
         * 省电档不走这一步，直接画到屏幕。
         */
        const post = { on: tier.antialias && typeof renderer.setRenderTarget === 'function', rt: null, scene: null, camera: null, mat: null, exposure: { value: 1 } };
        if (post.on) {
            post.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
            post.mat = new THREE.ShaderMaterial({
                uniforms: {
                    tColor: { value: post.rt.texture },
                    uTexel: { value: new THREE.Vector2(1, 1) },
                    uTheme: { value: 1 },
                    uShade: { value: 0 },
                    uScale: { value: new THREE.Vector2(1, 1) }
                },
                vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
                fragmentShader: `uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uTheme;
uniform float uShade;
uniform vec2 uScale;
varying vec2 vUv;
// 镜头快速移动时场景只画到渲染目标左下角一块（见 render 处），这里按比例取样，并且不读出那块范围
vec3 tap(vec2 uv) { return texture2D(tColor, clamp(uv, vec2(0.0), uScale - 0.5 * uTexel)).rgb; }
void main() {
    float down = 1.0 - vUv.y;   // 从画面顶边往下量
    float keep = 1.0 - uShade;
    float away = smoothstep(0.05, 0.48, abs(down - 0.52));
    vec2 t = uTexel * (1.0 + 6.0 * away * keep) * uScale;
    vec2 uv = vUv * uScale;
    vec3 c = tap(uv) * 4.0;
    c += 2.0 * (tap(uv + vec2(t.x, 0.0)) + tap(uv - vec2(t.x, 0.0)) + tap(uv + vec2(0.0, t.y)) + tap(uv - vec2(0.0, t.y)));
    c += tap(uv + t) + tap(uv - t) + tap(uv + vec2(t.x, -t.y)) + tap(uv + vec2(-t.x, t.y));
    gl_FragColor = vec4(c / 16.0, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    vec3 paper = mix(vec3(222.0, 219.0, 215.0), vec3(17.0, 24.0, 27.0), uTheme) / 255.0;
    float top = mix(0.72 * (1.0 - clamp(down / 0.5, 0.0, 1.0)), 0.82 * (1.0 - clamp(down / 0.36, 0.0, 1.0)), uTheme);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(vec3(224.0, 221.0, 216.0) / 255.0, paper, uTheme), top * keep);
    float bottom = mix(0.72, 0.84, uTheme) * (1.0 - clamp((1.0 - down) / 0.35, 0.0, 1.0));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, paper, bottom * keep);
    vec2 p = vec2(vUv.x, down);
    float radius = length((p - vec2(0.42, 0.47)) / vec2(0.58, 0.53)) * 0.70711;
    float darkRadius = length((p - vec2(0.48, 0.48)) / vec2(0.58, 0.53)) * 0.70711;
    float edge = mix(0.19 * clamp((radius - 0.32) / 0.53, 0.0, 1.0), 0.48 * clamp((darkRadius - 0.42) / 0.48, 0.0, 1.0), uTheme);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, paper, edge * keep);
}`,
                depthTest: false,
                depthWrite: false
            });
            const tri = new THREE.BufferGeometry();
            tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
            tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
            const quad = new THREE.Mesh(tri, post.mat);
            quad.frustumCulled = false;
            post.scene = new THREE.Scene();
            post.scene.add(quad);
            post.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
            host.classList.add('archive-post-atmos');   // 压边在着色器里做了，页面上那层 CSS 渐变就不用再盖
        }
        /* 封面贴片不该被色调映射改色：走后期时先把颜色反算回去，映射之后正好是原图 */
        const keepColors = (mat) => {
            if (!post.on) return mat;
            mat.onBeforeCompile = (sh) => {
                sh.uniforms.uKeepExposure = post.exposure;
                sh.fragmentShader = `uniform float uKeepExposure;
vec3 archiveUntone(vec3 y) {
    // ACES 输入、输出矩阵的逆，事先算好（逐像素调用 inverse() 太贵）
    const mat3 IN_INV = mat3(vec3(1.764741, -0.147028, -0.036337), vec3(-0.675778, 1.160252, -0.162436), vec3(-0.088963, -0.013224, 1.198773));
    const mat3 OUT_INV = mat3(vec3(0.643038, 0.059269, 0.005962), vec3(0.311187, 0.931436, 0.063929), vec3(0.045775, 0.009295, 0.930118));
    vec3 v = clamp(OUT_INV * y, 0.0, 0.995);
    vec3 qa = 1.0 - 0.983729 * v, qb = 0.0245786 - 0.4329510 * v, qc = -(0.000090537 + 0.238081 * v);
    v = (-qb + sqrt(qb * qb - 4.0 * qa * qc)) / (2.0 * qa);
    return max(IN_INV * v, 0.0) * 0.6 / max(uKeepExposure, 0.01);
}
` + sh.fragmentShader.replace('#include <colorspace_fragment>', 'gl_FragColor.rgb = archiveUntone(gl_FragColor.rgb);\n#include <colorspace_fragment>');
            };
            mat.customProgramCacheKey = () => 'archive-keep-colors';
            return mat;
        };
        for (const L of labels) keepColors(L.mat);
        const look = lookOf(LIGHTING.dark);
        let lookFade = null;   // { from, to, t0 }
        const fogBase = { near: look.fogNear, far: look.fogFar };
        scene.background = look.bg.clone();
        scene.fog = new THREE.Fog(look.fog.clone(), DIST + look.fogNear, DIST + look.fogFar);
        const applyLook = (L) => {
            scene.background.copy(L.bg);
            scene.fog.color.copy(L.fog);
            fogBase.near = L.fogNear; fogBase.far = L.fogFar;
            scene.fog.near = DIST + L.fogNear; scene.fog.far = DIST + L.fogFar;
            post.exposure.value = L.exposure;
            if (post.on) post.mat.uniforms.uTheme.value = L.theme;
            renderer.toneMappingExposure = L.exposure;
        };
        const lookAt = (fade, T) => {
            const k = smooth((T - fade.t0) / GLOBAL_DUR);
            const out = {};
            for (const c of COLOR_KEYS) out[c] = fade.from[c].clone().lerp(fade.to[c], k);
            for (const n of NUM_KEYS) out[n] = fade.from[n] + (fade.to[n] - fade.from[n]) * k;
            return out;
        };

        let waves = [];        // { to: { card }, lane, row, t0 }
        const waveK = (w, lane, row, T) => smooth((T - w.t0 - Math.min(MAX_DELAY, Math.abs(row - w.row) * 0.034 + Math.abs(lane - w.lane) * 0.11)) / CARD_DUR);
        const colorAt = (part, lane, row, T, k, out) => {
            if (k < 0) return out.copy(tint[part]);
            const w = waves[k];
            const s = waveK(w, lane, row, T);
            if (s >= 1) return out.copy(w.to[part]);
            colorAt(part, lane, row, w.t0, k - 1, out);   // 这一波开始时它是什么颜色
            return s > 0 ? out.lerp(w.to[part], s) : out;
        };
        const themeBusy = () => Boolean(lookFade || waves.length);

        /* colors: { font, labelInk, labelMuted }（卡盒和底色按参考播放器固定，不读颜色令牌），dark: 是否深色，wave: { lane, row } 翻色原点 */
        const setTheme = (colors, dark, { wave = null } = {}) => {
            lighting = dark ? LIGHTING.dark : LIGHTING.light;
            fontStack = colors.font || fontStack;
            labelInk.ink = colors.labelInk || (dark ? 'rgba(224,227,220,.62)' : 'rgba(8,10,8,.58)');
            labelInk.muted = colors.labelMuted || (dark ? 'rgba(166,176,177,.55)' : 'rgba(98,95,88,.6)');
            labelEpoch++;
            drawEtch();
            frameMat.color.set(lighting.mat[0]);
            const to = lookOf(lighting);
            accentIdx = -1;
            const parts = { card: new THREE.Color(lighting.theme, 0, 0) };
            const T = nowS();
            if (!wave || reducedMotion()) {
                lookFade = null; waves = [];
                Object.assign(look, to);
                applyLook(look);
                Object.assign(tint, parts);
                paintUniform();
            } else {
                const from = lookFade ? lookAt(lookFade, T) : { ...look };
                lookFade = { from, to, t0: T };
                if (waves.length >= 3) { Object.assign(tint, waves[0].to); waves.shift(); }
                waves.push({ to: parts, lane: wave.lane, row: wave.row, t0: T });
            }
            invalidate();
        };
        const stepTheme = (T) => {
            if (lookFade) {
                if (T - lookFade.t0 >= GLOBAL_DUR) { Object.assign(look, lookFade.to); lookFade = null; applyLook(look); }
                else applyLook(lookAt(lookFade, T));
            }
            if (waves.length && T - waves[waves.length - 1].t0 >= WAVE_TOTAL) {
                Object.assign(tint, waves[waves.length - 1].to);
                waves = [];
                paintUniform();
            }
        };

        // ---- 取出卡的卡面：封面与标题随卡片升起淡入 ----
        const COVER_SIZE = 2.9;
        const coverGeo = new THREE.PlaneGeometry(COVER_SIZE, COVER_SIZE);
        coverGeo.translate(0.78, 1.86, FRONT + 0.008);
        const frameGeo = new THREE.PlaneGeometry(COVER_SIZE + 0.12, COVER_SIZE + 0.12);
        frameGeo.translate(0.78, 1.86, FRONT + 0.005);
        const coverMat = (extra) => keepColors(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, ...extra }));
        const frameMat = coverMat({ color: '#ffffff' });
        const artMat = coverMat({});
        const captionGeo = new THREE.PlaneGeometry(1.54, 2.32);
        captionGeo.translate(-1.54, 1.36, FRONT + 0.009);
        const captionCanvas = document.createElement('canvas');
        captionCanvas.width = 256;
        captionCanvas.height = 386;
        const captionMap = new THREE.CanvasTexture(captionCanvas);
        captionMap.colorSpace = THREE.SRGBColorSpace;
        const captionMat = coverMat({ map: captionMap });
        const captionMesh = new THREE.Mesh(captionGeo, captionMat);
        const coverGroup = new THREE.Group();
        const frameMesh = new THREE.Mesh(frameGeo, frameMat);
        const artMesh = new THREE.Mesh(coverGeo, artMat);
        artMesh.renderOrder = 2;
        /*
         * 取出时卡面上的细线：沿四边一圈带折角的走线、角上的十字定位标、右下一个小地球和短横、
         * 底边一行小字。颜色很淡，只在卡片升起后和封面一起淡入；换主题时重画。
         */
        const etchGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
        etchGeo.translate(0, CARD_H / 2, FRONT + 0.003);
        const etchCanvas = document.createElement('canvas');
        etchCanvas.width = 1280;
        etchCanvas.height = 948;
        const etchMap = new THREE.CanvasTexture(etchCanvas);
        etchMap.colorSpace = THREE.SRGBColorSpace;
        etchMap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        const etchMat = coverMat({ map: etchMap });
        const etchMesh = new THREE.Mesh(etchGeo, etchMat);
        const drawEtch = () => {
            const g = etchCanvas.getContext('2d');
            const S = 256;
            const X = (u) => (u + CARD_W / 2) * S, Y = (v) => (CARD_H - v) * S;
            g.clearRect(0, 0, etchCanvas.width, etchCanvas.height);
            g.strokeStyle = lighting.etch;
            g.fillStyle = lighting.etch;
            g.lineWidth = 2.6;
            g.lineJoin = 'round';
            const path = (pts) => { g.beginPath(); pts.forEach(([u, v], i) => (i ? g.lineTo(X(u), Y(v)) : g.moveTo(X(u), Y(v)))); g.stroke(); };
            // 外圈：四角斜切，上边和左边各有一处台阶
            path([[-2.2, 3.5], [-0.4, 3.5], [-0.3, 3.4], [0.5, 3.4], [0.6, 3.5], [2.2, 3.5], [2.32, 3.38], [2.32, 0.32], [2.2, 0.2], [-2.2, 0.2], [-2.32, 0.32], [-2.32, 1.2], [-2.24, 1.28], [-2.24, 2.6], [-2.32, 2.68], [-2.32, 3.38], [-2.2, 3.5]]);
            // 内圈的半截走线：从左上沿左边下来，转到底边
            path([[-1.98, 3.26], [-2.1, 3.14], [-2.1, 0.55], [-1.95, 0.4], [-1.2, 0.4]]);
            path([[1.6, 3.26], [2.1, 3.26], [2.1, 2.7]]);
            const cross = (u, v) => { path([[u - 0.07, v], [u + 0.07, v]]); path([[u, v - 0.07], [u, v + 0.07]]); };
            cross(2.05, 3.05); cross(-1.95, 3.05); cross(2.05, 0.42); cross(-1.75, 0.6);
            // 右下的小地球和短横
            const cx = X(1.98), cy = Y(0.92), r = 0.15 * S;
            g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
            g.beginPath(); g.ellipse(cx, cy, r * 0.45, r, 0, 0, Math.PI * 2); g.stroke();
            path([[1.83, 0.92], [2.13, 0.92]]);
            g.fillRect(X(1.9), Y(0.62), 0.16 * S, 4);
            g.font = `400 26px ${fontStack}`;
            g.textBaseline = 'alphabetic';
            g.fillText('MUSIC ARCHIVE', X(-1.15), Y(0.27));
            etchMap.needsUpdate = true;
        };
        coverGroup.add(frameMesh, artMesh, captionMesh, etchMesh);
        coverGroup.visible = false;
        scene.add(coverGroup);
        let coverKey = '';
        const freeCoverTex = () => {
            artMat.map?.dispose();
            artMat.map = null;
        };
        const drawCaption = ({ title = '', artist = '', format = '', bitrate = '' }, showTitle) => {
            const ctx = captionCanvas.getContext('2d');
            ctx.clearRect(0, 0, captionCanvas.width, captionCanvas.height);
            ctx.fillStyle = lighting.tagInk;
            const fields = [['格式', format], ['码率', bitrate]].filter(([, value]) => value);
            fields.forEach(([label, value], i) => {
                const x = 6 + i * 126;
                ctx.font = `400 20px ${fontStack}`;
                ctx.globalAlpha = 0.78;
                ctx.fillText(label, x, 46);
                ctx.globalAlpha = 1;
                ctx.font = `600 23px ${fontStack}`;
                ctx.fillText(value, x, 79, fields.length === 1 ? 244 : 116);
            });
            if (showTitle) {
                ctx.font = `700 33px ${fontStack}`;
                const letters = Array.from(title.trim());
                for (let y = 166; y <= 250 && letters.length; y += 42) {
                    let end = 1;
                    while (end < letters.length && ctx.measureText(letters.slice(0, end + 1).join('')).width <= 236) end++;
                    if (end < letters.length && y < 250) {
                        const space = letters.slice(0, end).lastIndexOf(' ');
                        if (space > 0) end = space + 1;
                    }
                    const line = letters.splice(0, end).join('').trim();
                    ctx.fillText(line + (y === 250 && letters.length ? '…' : ''), 6, y, 244);
                }
                ctx.font = `500 22px ${fontStack}`;
                ctx.fillText(artist, 6, 306, 244);
            }
            captionMap.needsUpdate = true;
        };
        // 还没有可用的封面时，用写有曲名和歌手的卡面。
        const setCover = (key, source, info = {}) => {
            if (key === coverKey && artMat.map) return;
            coverKey = key;
            freeCoverTex();
            captionMesh.visible = Boolean(source || info.format || info.bitrate);
            if (captionMesh.visible) drawCaption(info, Boolean(source));
            let img = source;
            if (!img) {
                const c = document.createElement('canvas');
                c.width = c.height = 512;
                const g = c.getContext('2d');
                g.fillStyle = lighting.tag;
                g.fillRect(0, 0, 512, 512);
                g.strokeStyle = lighting.tagRing;
                g.lineWidth = 2;
                g.strokeRect(28, 28, 456, 456);
                g.fillStyle = lighting.tagInk;
                g.textBaseline = 'alphabetic';
                const fit = (text, size, weight, maxW) => {
                    g.font = `${weight} ${size}px ${fontStack}`;
                    let s = String(text || '');
                    if (g.measureText(s).width <= maxW) return s;
                    while (s.length > 1 && g.measureText(s + '…').width > maxW) s = s.slice(0, -1);
                    return s + '…';
                };
                g.fillText(fit(info.title || '', 46, 700, 420), 52, 400);
                g.fillText(fit(info.artist || '', 24, 500, 420), 52, 446);
                g.beginPath(); g.arc(436, 82, 14, 0, Math.PI * 2); g.stroke();
                img = c;
            }
            const texture = img instanceof HTMLCanvasElement ? new THREE.CanvasTexture(img) : new THREE.Texture(img);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
            texture.needsUpdate = true;
            artMat.map = texture;
            artMat.needsUpdate = true;
            invalidate();
        };

        // ---- 状态 ----
        const target = { lane: 0, row: 0 };
        const camLane = { v: 0, vel: 0 }, camRow = { v: 0, vel: 0 }, shoulder = { v: 0, vel: 0 }, focus = { v: 0, vel: 0 }, lift = { v: 0.4, vel: 0 };
        let liftGoal = 0.4;   // 选中卡抬起的高度；进播放页前会再抬高一些
        /*
         * 取出：选中卡从列里抬到 DETAIL_LIFT，镜头推近到它正面、把它放进目录与歌词之间，卡面上显出封面。
         * 镜头推近的进度直接由抬起高度算（卡升到哪，镜头推到哪），这样中途收回也不会两边脱节。
         */
        const DETAIL_LIFT = 4.05;
        const DETAIL_DIR = new THREE.Vector3(-0.277, 0.238, 0.931).normalize();
        let detailOn = false;
        let detailK = 0;               // 0 浏览 → 1 取出（镜头）
        const inspect = { v: 0, vel: 0, goal: 0 };   // 取出后拖动转卡（绕竖轴），松手转回正面
        const returning = new Map();   // 'lane:row' → { v, vel }，换选中时旧卡从当时的高度落回去，一格只留一份
        const pulses = [];
        const hoverLifts = new Map();
        let hovered = null;
        let playing = null;          // { lane, row } 正在播放那张卡（同列轻微跳动）
        let isPlaying = false;
        let idleGain = 0;
        let lastInput = performance.now();
        let lastPointer = 0;          // 鼠标移动带视差，也算没静止（但不打断待机起伏）
        let frames = 0;
        const pointer = { x: 0, y: 0 };
        const cellAt = new Int32Array(POOL * 2);
        const dummy = new THREE.Object3D();
        const view = new THREE.Vector3(-Math.sin(YAW) * Math.cos(ELEV), Math.sin(ELEV), Math.cos(YAW) * Math.cos(ELEV));
        const aim = new THREE.Vector3(AIM[0], AIM[1], AIM[2]);
        let W = 1, H = 1;
        let dirty = true;
        const invalidate = () => { dirty = true; };

        const resize = (width, height) => {
            W = Math.max(1, width); H = Math.max(1, height);
            renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, tier.maxDpr));
            renderer.setSize(W, H, false);
            if (post.on) {
                const dpr = renderer.getPixelRatio();
                const px = { x: Math.max(1, Math.floor(W * dpr)), y: Math.max(1, Math.floor(H * dpr)) };
                post.rt.setSize(px.x, px.y);
                post.px = px;
                post.mat.uniforms.uTexel.value.set(1 / px.x, 1 / px.y);
            }
            camera.aspect = W / H;
            // 高度方向固定看到 7.33 个单位；窗口比 16:9 窄时改为保宽度
            const span = Math.max(7.33, 7.33 * (16 / 9) / camera.aspect);
            camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(span / (2 * DIST)));
            camera.updateProjectionMatrix();
            invalidate();
        };

        const select = (lane, row, { pulse = true } = {}) => {
            if (lane === target.lane && row === target.row) return;
            if (pulse && !reducedMotion()) pulses.push({ lane, row, t: performance.now() / 1000 });
            // 旧卡抬得明显时（取出中、展开中）从当时的高度落回去，不瞬间掉下
            if (lift.v > 0.5 && !reducedMotion()) returning.set(target.lane + ':' + target.row, { v: lift.v, vel: lift.vel, rot: inspect.v });
            returning.delete(lane + ':' + row);
            target.lane = lane; target.row = row;
            lift.v = 0; lift.vel = 0;
            inspect.v = inspect.vel = inspect.goal = 0;
            lastInput = performance.now();
            idleGain = 0;
            invalidate();
        };
        /*
         * 拖动整片档案：参考播放器 NativeSceneInput.cpp 的 moveArchive / dragProjection。
         * hold() 直接把镜头放在给定的（可带小数的）格坐标上，unhold() 交回弹簧，从当时的位置和速度接着走。
         * dragAxes() 给出选中卡中心附近「卡片整体移动一列 / 一行」在画布上对应的像素向量，外面据此把指针位移反解成格数。
         */
        let held = null;
        const hold = (lane, row, vl = 0, vr = 0) => {
            held = { lane, row, vl, vr };
            lastInput = performance.now();
            idleGain = 0;
            invalidate();
        };
        const unhold = () => { if (held) { held = null; invalidate(); } };
        const camAt = () => ({ lane: camLane.v, row: camRow.v });
        const dragAxes = () => {
            const c = new THREE.Vector3((target.lane - camLane.v) * COLUMN_SPACING, BASE_Y + 1.85, (target.row - camRow.v) * ROW_SPACING - 2.17);
            const px = (v) => { v.project(camera); return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H }; };
            const o = px(c.clone());
            const l = px(c.clone().add(new THREE.Vector3(COLUMN_SPACING, 0, 0)));
            const r = px(c.clone().add(new THREE.Vector3(0, 0, ROW_SPACING)));
            return { lane: { x: l.x - o.x, y: l.y - o.y }, row: { x: r.x - o.x, y: r.y - o.y } };
        };
        /* 不带动画直接跳到某格（第一次打开、数据重建） */
        const jump = (lane, row) => {
            held = null;
            target.lane = lane; target.row = row;
            camLane.v = focus.v = lane; camRow.v = shoulder.v = row;
            camLane.vel = camRow.vel = shoulder.vel = focus.vel = 0;
            lift.v = detailOn ? DETAIL_LIFT : liftGoal; lift.vel = 0;
            pulses.length = 0;
            returning.clear();
            snapCardAim = true;
            invalidate();
        };

        const targetPos = new THREE.Vector3();
        const glowMat4 = new THREE.Matrix4();
        const cardAim = new THREE.Vector3();
        let snapCardAim = true;
        const camDir = new THREE.Vector3(), camRight = new THREE.Vector3(), camUp = new THREE.Vector3(), detailAim = new THREE.Vector3(), camAim = new THREE.Vector3();
        const WORLD_UP = new THREE.Vector3(0, 1, 0);
        const lerp = (a, b, k) => a + (b - a) * k;
        /* 把卡片放进 HUD 留出的矩形，以宽高较紧的一边决定取景。 */
        let detailRoom = null;
        let targetRoom = null;
        const placeCamera = (reduced) => {
            const k = detailK;
            const aspect = W / H;
            const room = detailRoom || { left: 0, right: W, top: 0, bottom: H };
            const roomWidth = Math.max(1, room.right - room.left);
            const roomHeight = Math.max(1, room.bottom - room.top);
            const browseSpan = Math.max(7.33, 7.33 * (16 / 9) / aspect);
            const detailSpan = Math.max(6.8, CARD_W * 1.14 * H / roomWidth, CARD_H * 1.24 * H / roomHeight);
            const viewSpan = lerp(browseSpan, detailSpan, k);
            const distance = lerp(DIST, 72, k);
            camDir.copy(view).lerp(DETAIL_DIR, k).normalize();
            camAim.copy(aim);
            if (k > 0) {
                camRight.crossVectors(WORLD_UP, camDir).normalize();
                camUp.crossVectors(camDir, camRight).normalize();
                const anchorX = (room.left + room.right) / (2 * W);
                const anchorY = (room.top + room.bottom) / (2 * H);
                const pixelScale = H / viewSpan;
                detailAim.copy(cardAim);
                detailAim.y += CARD_H / 2;
                detailAim.addScaledVector(camRight, (0.5 - anchorX) * W / pixelScale);
                detailAim.addScaledVector(camUp, (anchorY - 0.5) * H / pixelScale);
                camAim.lerp(detailAim, k);
            }
            camera.position.copy(camAim).addScaledVector(camDir, distance);
            if (!reduced) {
                const par = 0.12 * (1 - 0.75 * k);
                camera.position.x += pointer.x * par; camera.position.y -= pointer.y * par;
            }
            camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(viewSpan / (2 * distance)));
            camera.updateProjectionMatrix();
            camera.lookAt(camAim);
            camera.updateMatrixWorld();
            scene.fog.near = distance + lerp(fogBase.near, -1, k);
            scene.fog.far = distance + lerp(fogBase.far, 12, k);
        };
        const placeCover = (targetVisible) => {
            const appear = targetVisible && artMat.map ? smooth((lift.v - 1.2) / 1.6) : 0;
            const show = appear > 0.001;
            coverGroup.visible = show;
            if (!show) return;
            coverGroup.position.copy(targetPos);
            coverGroup.rotation.set(0, inspect.v, 0);
            frameMat.opacity = lighting.mat[1] * appear;
            artMat.opacity = appear;
            captionMat.opacity = appear;
            etchMat.opacity = appear;
        };
        const setDetailRoom = (bounds) => {
            if (targetRoom && Object.keys(bounds).every((edge) => Math.abs(bounds[edge] - targetRoom[edge]) < 0.5)) return;
            targetRoom = bounds;
            detailRoom ??= { ...bounds };
            invalidate();
        };
        const setDetail = (on) => {
            on = Boolean(on);
            if (on === detailOn) return;
            detailOn = on;
            if (!on) inspect.goal = 0;
            lastInput = performance.now();
            idleGain = 0;
            invalidate();
        };
        /* 取出后拖动转卡：delta 是弧度；release 后转回正面 */
        const turn = (delta, release = false) => {
            if (!detailOn) return;
            if (release) inspect.goal = 0;
            else inspect.goal = Math.max(-0.8, Math.min(0.8, inspect.goal + delta));   // 参考播放器：±0.8 弧度
            invalidate();
        };
        /* 取出的卡在画面上的范围（画布像素），给 HUD 判断点没点在卡上 */
        const detailRect = () => {
            if (!detailOn) return null;
            const pts = [[-CARD_W / 2, 0], [CARD_W / 2, 0], [-CARD_W / 2, CARD_H], [CARD_W / 2, CARD_H]].map(([x, y]) => {
                projA.set(targetPos.x + x, targetPos.y + y, targetPos.z + CARD_D / 2).project(camera);
                return [(projA.x + 1) / 2 * W, (1 - projA.y) / 2 * H];
            });
            const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
            return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
        };

        let lastStep = performance.now();
        /* 推进一帧。返回这帧是否还在动（给外面决定要不要降帧/停画）。 */
        const step = (now) => {
            const dt = Math.min((now - lastStep) / 1000, 0.05);
            lastStep = now;
            const T = now / 1000;
            const reduced = reducedMotion();
            let roomMoving = false;
            if (targetRoom) {
                const mix = reduced ? 1 : 1 - Math.exp(-dt * 10);
                for (const edge of Object.keys(targetRoom)) {
                    const to = targetRoom[edge];
                    if (Math.abs(detailRoom[edge] - to) < 0.5) detailRoom[edge] = to;
                    else {
                        detailRoom[edge] = lerp(detailRoom[edge], to, mix);
                        roomMoving = !reduced;
                    }
                }
            }
            const rate = reduced ? 9 : 3.7;
            if (held) {
                // 按住拖动或松手滑行时镜头位置由外面给（参考播放器 m_dragTrack / m_momentum）
                camLane.v = held.lane; camRow.v = held.row; camLane.vel = held.vl; camRow.vel = held.vr;
            } else {
                damp(camLane, target.lane, rate, dt);
                damp(camRow, target.row, rate, dt);
            }
            // 参考播放器 NativeSceneUpdate.cpp：肩部隆起 5、列聚焦 4，都比镜头（3.7）先到位一点
            damp(shoulder, target.row, reduced ? rate : 5, dt);
            damp(focus, target.lane, reduced ? rate : 4, dt);
            // 取出用慢一点的弹簧（约一秒到位），平时的选中抬起保持干脆
            damp(lift, detailOn ? DETAIL_LIFT : liftGoal, reduced ? 40 : detailOn || lift.v > 1 ? 4.2 : 8, dt);   // 浏览时 8：比镜头（3.7）快一点先探出来，但不再「啪」地弹起
            for (const [k, r] of returning) {
                // 落回原位用与帧率无关的指数衰减（参考播放器 SceneLifetimePolicy.h returningLiftStep，速率 4.5）
                r.v *= Math.exp(-dt * (reduced ? 35 : 4.5)); r.vel = 0;
                // 转着看的卡被换下时边落边转回正面（参考播放器 returning actor 的 returnStep，速率 7）
                r.rot = Math.abs(r.rot || 0) <= 0.001 ? 0 : r.rot * Math.exp(-dt * (reduced ? 35 : 7));
                if (Math.abs(r.v) < 0.002 && !r.rot) returning.delete(k);
            }
            {
                // 镜头进度跟着抬起高度走；取出期间换卡（新卡从低处升起）镜头不退回去
                const fromLift = detailOn ? smooth((lift.v - 0.8) / 2.4) : smooth((lift.v - 0.7) / (DETAIL_LIFT - 0.7));
                const goal = detailOn ? Math.max(fromLift, Math.min(detailK, 1)) : fromLift;
                detailK = reduced ? goal : detailK + (goal - detailK) * (1 - Math.exp(-dt * 2.8));   // 镜头推近的跟随速度，参考播放器 blend 2.8
                if (Math.abs(detailK - goal) < 0.0005) detailK = goal;
                if (!detailOn && detailK < 0.001) detailK = 0;
                // 转卡：按住时朝目标角按 2.8 跟过去，松手后按 7 指数回正（参考播放器 m_rotation / returnAngleStep）
                if (inspect.goal !== 0) inspect.v += (inspect.goal - inspect.v) * (1 - Math.exp(-dt * (reduced ? 35 : 2.8)));
                else { inspect.v *= Math.exp(-dt * (reduced ? 35 : 7)); if (Math.abs(inspect.v) <= 0.001) inspect.v = 0; }
                inspect.vel = 0;
            }
            stepTheme(T);
            const tinting = waves.length > 0;
            const tmpC = tinting ? (stepTheme.c || (stepTheme.c = new THREE.Color())) : null;
            // 静止后的缓慢起伏只在播放时才有：暂停时没有东西在动，画面停住，外面的帧循环也就不再排下一帧
            const idleTarget = !reduced && isPlaying && now - lastInput > 2500 ? 1 : 0;
            idleGain += (idleTarget - idleGain) * Math.min(1, dt * (idleTarget ? 0.8 : 4));   // 参考播放器：起伏 0.8 慢慢起、4 快速收
            if (!idleTarget && idleGain < 0.002) idleGain = 0;
            for (let k = pulses.length - 1; k >= 0; k--) if (T - pulses[k].t > 3.3) pulses.splice(k, 1);

            // 整片档案的起伏高度：肩部隆起 × 列聚焦 + 待机起伏 + 换选中的波纹（参考播放器 ArchiveField::sample）
            const fieldAt = (row, lane) => {
                let h = settlingWave(row - shoulder.v) * columnStrength(lane, focus.v);
                if (idleGain > 0.001) h += idleWave(row, lane, T) * idleGain;
                if (pulses.length) {
                    let rip = 0;
                    for (const p of pulses) rip += selectionWave(Math.hypot(row - p.row, (lane - p.lane) * 2.2), T - p.t);
                    h += Math.max(-0.6, Math.min(0.6, rip));
                }
                return h;
            };
            const baseLane = Math.round(camLane.v);
            const baseRow = Math.round(camRow.v);
            labelWanted.clear();
            let i = 0, targetIdx = -1;
            for (let li = -LANES_HALF; li <= LANES_HALF; li++) {
                for (let ri = ROWS_AFTER - 1; ri >= -ROWS_BEFORE; ri--) {   // 近处的行先画：深度测试挡掉后面被遮住的像素，复杂的卡盒着色只算看得见的
                    const lane = baseLane + li;
                    const row = baseRow + ri;
                    let f = fieldAt(row, lane);
                    // 卡顺着起伏的坡度前后微倾（参考播放器 NativeSceneUpdate.cpp：slope × 0.024 × (1 − 取出进度)）
                    const tilt = (fieldAt(row + 0.5, lane) - fieldAt(row - 0.5, lane)) * 0.024 * (1 - detailK);
                    if (isPlaying && playing && !reduced && lane === playing.lane) {
                        const dd = Math.abs(row - playing.row);
                        if (dd < 8) f += 0.06 * Math.abs(Math.sin(T * 6.1 + row * 1.3)) * (1 - dd / 8);
                    }
                    const hl = hoverLifts.get(lane + ':' + row) || 0;
                    let y = BASE_Y + f + hl;
                    const isTarget = lane === target.lane && row === target.row;
                    if (isTarget) y += lift.v;
                    let backRot = 0;
                    if (!isTarget && returning.size) { const r = returning.get(lane + ':' + row); if (r) { y += r.v; backRot = r.rot || 0; } }
                    dummy.position.set((lane - camLane.v) * COLUMN_SPACING, y, (row - camRow.v) * ROW_SPACING - 2.17);
                    // 选中卡抬起后不再跟着坡度倾斜（× (1 − smoother(lift / 0.4))），取出时可以转着看
                    dummy.rotation.x = isTarget ? tilt * (1 - smoother(lift.v / 0.4)) : tilt;
                    dummy.rotation.y = isTarget ? inspect.v : backRot;
                    if (isTarget) { targetPos.copy(dummy.position); targetIdx = i; }
                    // 贴标题的范围按选中格算（不按还在飞的相机），当前列就是选中的那一列
                    const dl = lane - target.lane, dr = row - target.row;
                    if (labelFor && dl >= -LABEL_LANES && dl <= LABEL_LANES && dr >= LABEL_ROWS[0] && dr <= LABEL_ROWS[1]) {
                        const info = labelFor(lane, row);
                        if (info) labelWanted.set(lane + ':' + row, { info, li: dl, x: dummy.position.x, y, z: dummy.position.z, tilt: dummy.rotation.x, turn: dummy.rotation.y });
                    }
                    dummy.updateMatrix();
                    for (const layer of layers) layer.setMatrixAt(i, dummy.matrix);
                    if (tinting) {
                        for (const [mesh, part] of TINTED) mesh.setColorAt(i, colorAt(part, lane, row, T, waves.length - 1, tmpC));
                    }
                    cellAt[i * 2] = lane;
                    cellAt[i * 2 + 1] = row;
                    i++;
                }
            }
            for (const [k, v] of hoverLifts) {
                const goal = hovered === k ? 0.28 : 0;   // 悬停的卡探出 0.28，按 14 的指数趋近（参考播放器同值）
                const nv = v + (goal - v) * (reduced ? 1 : 1 - Math.exp(-dt * 14));
                if (Math.abs(nv) < 0.001 && goal === 0) hoverLifts.delete(k); else hoverLifts.set(k, nv);
            }
            if (hovered && !hoverLifts.has(hovered)) hoverLifts.set(hovered, 0.0001);
            for (const layer of layers) layer.instanceMatrix.needsUpdate = true;
            if (tinting) for (const [mesh] of TINTED) mesh.instanceColor.needsUpdate = true;
            // 选中卡在实例参数里打个记号（g = 1），着色器只在这张卡上算内部暖光和半透面板
            if (tinting || targetIdx !== accentIdx) {
                if (accentIdx >= 0 && accentIdx !== targetIdx && !tinting) cards.setColorAt(accentIdx, tint.card);
                if (targetIdx >= 0) {
                    if (tinting) cards.getColorAt(targetIdx, accentTmp); else accentTmp.copy(tint.card);
                    accentTmp.g = 1;
                    cards.setColorAt(targetIdx, accentTmp);
                }
                accentIdx = targetIdx;
                cards.instanceColor.needsUpdate = true;
            }

            // 选中格可以一帧跳过好几张卡，镜头的瞄准点随画面平滑移动。
            const targetVisible = targetIdx >= 0;
            if (targetVisible) {
                if (snapCardAim || reduced || detailK < 0.001) cardAim.copy(targetPos);
                else cardAim.lerp(targetPos, 1 - Math.exp(-dt * 10));
                snapCardAim = false;
            }
            placeCamera(reduced);
            placeCover(targetVisible);
            placeLabels();
            // 选中卡的暖光跟着卡走；看不到选中卡时关掉
            if (targetVisible) {
                glowMat4.makeRotationY(inspect.v).setPosition(targetPos);
                glowUniforms.uGlowInv.value.copy(glowMat4).invert();
            }
            glowUniforms.uLightOn.value = targetVisible ? 1 : 0;
            glowUniforms.uHero.value = detailK;
            // 取出端详时面板透得少一些：卡面上压着封面，内衬的光斑透出来会显脏
            glowUniforms.uSeeThrough.value = 0.38;
            if (post.on) {
                post.mat.uniforms.uShade.value = detailK;
                /*
                 * 镜头在两列/两行之间滑得快的那一段，画面本来就在动、看不清细节，场景只按 0.67 倍边长画
                 * （约一半像素），由后期放大。滑到慢下来（速度低于 0.25 格/秒）就回到全分辨率，
                 * 停稳的那一帧和之后的静止画面都是全分辨率，和原来一样。
                 * 取出/收回时卡飞得最快、镜头推进还不到一半的那一段也这样画；推进过半以后封面变大、
                 * 柔化收掉，就回到全分辨率，端详时的封面一直是清晰的。
                 * 参考播放器同样是降渲染比例再放大（RenderModePolicy.h 的 renderPercent 50–200%）。
                 */
                const speed = Math.abs(camLane.vel) + Math.abs(camRow.vel);
                const gliding = detailK < 0.001 && !detailOn && speed > 0.25;
                const flying = detailK < 0.5 && Math.abs(lift.vel) > 1.5;
                const s = !reduced && post.px && (gliding || flying) ? 0.67 : 1;
                const px = post.px || { x: 1, y: 1 };
                const vw = Math.max(1, Math.round(px.x * s)), vh = Math.max(1, Math.round(px.y * s));
                post.rt.viewport.set(0, 0, vw, vh);
                post.rt.scissor.set(0, 0, vw, vh);
                post.rt.scissorTest = s < 1;
                post.mat.uniforms.uScale.value.set(vw / px.x, vh / px.y);
                post.lowRes = s < 1;
                renderer.setRenderTarget(post.rt);
                renderer.render(scene, camera);
                renderer.setRenderTarget(null);
                renderer.render(post.scene, post.camera);
            } else {
                renderer.render(scene, camera);
            }
            dirty = false;
            frames++;

            // 播放时的缓慢起伏、轻跳让选中卡一直在小幅移动，镜头瞄准点永远差一点点；
            // 差得很少（不到 0.05）就算到位，不然静止画面会一直按满帧画。
            const aimMoving = detailK > 0.001 && targetVisible && cardAim.distanceToSquared(targetPos) > 0.0025;
            const settled = !roomMoving && !aimMoving && Math.abs(camLane.v - target.lane) < 0.001 && Math.abs(camRow.v - target.row) < 0.001
                && Math.abs(lift.v - (detailOn ? DETAIL_LIFT : liftGoal)) < 0.001 && !returning.size
                && Math.abs(detailK - (detailOn ? 1 : 0)) < 0.001 && Math.abs(inspect.v - inspect.goal) < 0.001
                && !themeBusy() && Math.abs(camLane.vel) + Math.abs(camRow.vel) < 0.001
                && !pulses.length && hoverLifts.size <= (hovered ? 1 : 0) && !labelsPending;
            return {
                moving: !settled,
                idle: now - Math.max(lastInput, lastPointer) > IDLE_AFTER,
                animated: !settled || idleGain > 0.001 || (isPlaying && playing && !reduced)
            };
        };

        // ---- 拾取：每张卡当作轴对齐的盒子求交，比逐三角形快得多 ----
        const ray = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const boxMin = new THREE.Vector3(), boxMax = new THREE.Vector3(), hit = new THREE.Vector3();
        const tmpBox = new THREE.Box3();
        const m4 = new THREE.Matrix4();
        const pick = (clientX, clientY, rect) => {
            ndc.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
            ray.setFromCamera(ndc, camera);
            let best = null;
            let bestDist = Infinity;
            for (let i = 0; i < POOL; i++) {
                cards.getMatrixAt(i, m4);
                const x = m4.elements[12], y = m4.elements[13], z = m4.elements[14];
                boxMin.set(x - CARD_W / 2, y, z - CARD_D / 2 + 0.02);
                boxMax.set(x + CARD_W / 2, y + CARD_H, z + CARD_D / 2 + 0.02);
                tmpBox.set(boxMin, boxMax);
                if (ray.ray.intersectBox(tmpBox, hit)) {
                    const d = hit.distanceToSquared(ray.ray.origin);
                    if (d < bestDist) { bestDist = d; best = i; }
                }
            }
            return best === null ? null : { lane: cellAt[best * 2], row: cellAt[best * 2 + 1] };
        };

        const setHover = (cell) => {
            const k = cell ? cell.lane + ':' + cell.row : null;
            if (k === hovered) return;
            hovered = reducedMotion() ? null : k;
            invalidate();
        };
        const setPointer = (x, y) => { pointer.x = x; pointer.y = y; lastPointer = performance.now(); if (!reducedMotion()) invalidate(); };
        const setPlaying = (cell, playingNow) => {
            const same = (cell && playing && cell.lane === playing.lane && cell.row === playing.row) || (!cell && !playing);
            if (same && playingNow === isPlaying) return;
            playing = cell; isPlaying = Boolean(playingNow);
            invalidate();
        };
        const touch = () => { lastInput = performance.now(); idleGain = 0; };
        /* 选中卡的抬起高度，不传回到默认 0.4 */
        const raise = (amount) => {
            const goal = Number.isFinite(amount) ? amount : 0.4;
            if (goal === liftGoal) return;
            liftGoal = goal;
            invalidate();
        };

        const dispose = () => {
            for (const layer of layers) { layer.geometry.dispose(); layer.dispose?.(); }
            for (const m of [cassetteMat, frameMat, artMat, captionMat, etchMat]) m.dispose();
            if (post.on) { post.rt.dispose(); post.mat.dispose(); post.scene.children[0].geometry.dispose(); host.classList.remove('archive-post-atmos'); }
            freeCoverTex(); coverGeo.dispose(); frameGeo.dispose(); captionGeo.dispose(); captionMap.dispose(); etchGeo.dispose(); etchMap.dispose();
            for (const L of labels) { L.tex.dispose(); L.mat.dispose(); }
            labelGeo.dispose();
            renderer.dispose();
            renderer.forceContextLoss?.();
            canvas.remove();
        };

        return {
            canvas,
            tier,
            resize, setTheme, select, jump, step, pick, setHover, setPointer, setPlaying, touch, raise, setLabeler, setLabelMask, refreshLabels, dispose,
            setDetail, setDetailRoom, setCover, turn, detailRect, hold, unhold, camAt, dragAxes,
            get detail() { return detailOn; },
            get dirty() { return dirty; },
            get target() { return { ...target }; },
            get themeBusy() { return themeBusy(); },
            debug: () => ({ cam: { lane: Math.round(camLane.v * 1000) / 1000, row: Math.round(camRow.v * 1000) / 1000 }, target: { ...target }, frames, dpr: renderer.getPixelRatio(), labels: labels.filter((L) => L.mesh.visible).length, labelLanes: [...new Set(labels.filter((L) => L.mesh.visible).map((L) => Number(L.cell.split(':')[0])))].sort((x, y) => x - y), waves: waves.length, fading: Boolean(lookFade), bg: scene.background.getHexString(), lift: Math.round(lift.v * 100) / 100, liftVel: Math.round(lift.vel * 100) / 100, lowRes: Boolean(post.lowRes), detail: Math.round(detailK * 1000) / 1000, returning: returning.size, pool: POOL, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs?.length || 0 })
        };
    };

    const api = Object.freeze({ create, TIERS, IDLE_AFTER, tierOf, POOL, settlingWave, selectionWave });
    global.MusicArchiveScene = api;
})(typeof window !== 'undefined' ? window : globalThis);
