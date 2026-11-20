/*
 * 町景：城寨楼体。
 *
 * 楼壳全部并成一个网格，窗、窗灯、屋里的纵深、污渍和雨痕都在立面着色器
 * 里按「层 × 开间」画出来，几乎不花三角面；伸出立面的东西（铁窗笼、
 * 空调外机、屋顶加建、水箱、天线、落水管、雨棚、晾衣竹竿）用实例化，
 * 每类一个绘制调用。挂点和用途都来自 kowloon-layout.js。
 */
(function (global) {
    'use strict';

    const KIND = Object.freeze({ street: 0, alley: 1, well: 2, upper: 3, roof: 4, outer: 5, bridge: 6, far: 7 });

    const create = (T, ctx) => {
        const S = global.MusicStageKowloonShared;
        const { scene, layout } = ctx;
        const L = global.MusicStageKowloonLayout;
        const FLOOR = layout.FLOOR;
        const rand = L.rng('city:' + (ctx.seed || 'kowloon'));
        const shared = ctx.lightUniforms || S.createLightUniforms(T);
        const disposables = [];
        const group = new T.Group();
        group.name = 'kowloon-city';
        scene.add(group);

        // ---------- 楼壳 ----------
        const pos = [], nor = [], face = [], info = [], idx = [];
        // 一个竖直面：p0→p1 沿立面，y0→y1 高度。face = (u, v, 面长, 开间宽)。
        const wall = (p0, p1, y0, y1, n, kind, seed, bay, vBase = 0) => {
            const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
            if (len < 0.05 || y1 - y0 < 0.05) return;
            const cols = Math.max(1, Math.round(len / (bay || layout.BAY)));
            const bw = Math.round(len / cols * 256) / 256;
            const base = pos.length / 3;
            const corners = [[p0, y0, 0], [p1, y0, len], [p1, y1, len], [p0, y1, 0]];
            corners.forEach(([p, y, u]) => {
                pos.push(p[0], y, p[1]);
                nor.push(n[0], n[1], n[2]);
                face.push(u, y - vBase, len, bw);
                info.push(seed, kind, vBase, y1 - vBase);
            });
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        const roof = (b, y, kind, seed) => {
            const base = pos.length / 3;
            [[b.x0, b.z1], [b.x1, b.z1], [b.x1, b.z0], [b.x0, b.z0]].forEach(([x, z]) => {
                pos.push(x, y, z);
                nor.push(0, 1, 0);
                face.push(x, z, 0, 0);
                info.push(seed, KIND.roof, 0, 0);
            });
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        const box = (b, y0, y1, kind, seed, bay, vBase = 0, bottom = false) => {
            wall([b.x0, b.z1], [b.x1, b.z1], y0, y1, [0, 0, 1], kind, seed, bay, vBase);
            wall([b.x1, b.z0], [b.x0, b.z0], y0, y1, [0, 0, -1], kind, seed, bay, vBase);
            wall([b.x1, b.z1], [b.x1, b.z0], y0, y1, [1, 0, 0], kind, seed, bay, vBase);
            wall([b.x0, b.z0], [b.x0, b.z1], y0, y1, [-1, 0, 0], kind, seed, bay, vBase);
            roof(b, y1, kind, seed);
            if (bottom) {
                const base = pos.length / 3;
                [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]].forEach(([x, z]) => {
                    pos.push(x, y0, z); nor.push(0, -1, 0); face.push(x, z, 0, 0); info.push(seed, KIND.roof, 0, 0);
                });
                idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
            }
        };
        const seedOf = (n) => (n % 9973) / 9973;

        // 立面按 layout 的立面分类画（对外/对巷/天井/高出邻楼的山墙）。
        const lotKindBySide = new Map();
        layout.facades.forEach(f => {
            const k = f.kind === 'street' ? KIND.street : f.kind.startsWith('alley') ? KIND.alley
                : f.kind === 'well' ? KIND.well : KIND.upper;
            lotKindBySide.set(`${f.lot}:${f.side}`, k);
        });
        layout.lots.forEach(lot => {
            if (lot.height <= 0) return;
            const s = seedOf(lot.seed);
            const k = side => lotKindBySide.has(`${lot.id}:${side}`) ? lotKindBySide.get(`${lot.id}:${side}`) : KIND.upper;
            wall([lot.x0, lot.z1], [lot.x1, lot.z1], 0, lot.height, [0, 0, 1], k('south'), s);
            wall([lot.x1, lot.z0], [lot.x0, lot.z0], 0, lot.height, [0, 0, -1], k('north'), s);
            wall([lot.x1, lot.z1], [lot.x1, lot.z0], 0, lot.height, [1, 0, 0], k('east'), s);
            wall([lot.x0, lot.z0], [lot.x0, lot.z1], 0, lot.height, [-1, 0, 0], k('west'), s);
            roof(lot, lot.height, KIND.roof, s);
        });
        layout.bridges.forEach((b, i) => box(b, b.y0, b.y1, KIND.bridge, seedOf(L.hash(`bridge:${i}`)), 2.0, 0, true));
        layout.outer.forEach(o => box(o, 0, o.height, KIND.outer, seedOf(o.seed), 3.0));

        // 远景：九龙一带更高的楼群，只是带窗格的剪影，在雾里渐隐。
        const far = [];
        for (let i = 0; i < 140; i += 1) {
            const a = rand() * Math.PI * 2;
            const r = 230 + rand() * 420;
            const x = Math.cos(a) * r * 1.3, z = Math.sin(a) * r;
            // 北面是山，留出一块空。
            if (z < -150 && Math.abs(x) < 260) continue;
            const w = 14 + rand() * 26, d = 12 + rand() * 20;
            const h = (12 + Math.floor(rand() * 26)) * FLOOR;
            far.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, height: h });
        }
        far.forEach((b, i) => box(b, 0, b.height, KIND.far, seedOf(L.hash(`far:${i}`)), 3.2));

        const shellGeometry = new T.BufferGeometry();
        shellGeometry.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
        shellGeometry.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
        shellGeometry.setAttribute('aFace', new T.Float32BufferAttribute(face, 4));
        shellGeometry.setAttribute('aInfo', new T.Float32BufferAttribute(info, 4));
        shellGeometry.setIndex(idx);
        shellGeometry.computeBoundingSphere();
        disposables.push(shellGeometry);

        const fogUniforms = T.UniformsUtils.clone(T.UniformsLib.fog);
        const shellUniforms = Object.assign(fogUniforms, shared, {
            uFloor: { value: FLOOR },
            uLitBias: { value: 0 },
            // 远景机位压低窗灯，让霓虹招牌出来。
            uWindowGain: { value: 1 },
            uDetail: { value: 1 }
        });

        const shellMaterial = new T.ShaderMaterial({
            fog: true,
            uniforms: shellUniforms,
            vertexShader: /* glsl */`
                attribute vec4 aFace;
                attribute vec4 aInfo;
                varying vec4 vFace;
                varying vec4 vInfo;
                varying vec3 vWorld;
                varying vec3 vNormal;
                #include <fog_pars_vertex>
                void main(){
                    vFace = aFace; vInfo = aInfo;
                    vec4 world = modelMatrix * vec4(position, 1.0);
                    vWorld = world.xyz;
                    vNormal = normal;
                    vec4 mvPosition = viewMatrix * world;
                    gl_Position = projectionMatrix * mvPosition;
                    #include <fog_vertex>
                }`,
            fragmentShader: /* glsl */`
                ${S.GLSL_COMMON}
                ${S.GLSL_LIGHTS}
                uniform float uFloor;
                uniform float uLitBias;
                uniform float uDetail;
                uniform float uWindowGain;
                varying vec4 vFace;
                varying vec4 vInfo;
                varying vec3 vWorld;
                varying vec3 vNormal;
                #include <fog_pars_fragment>

                // 楼的底色：脏混凝土、米黄批荡、褪色的马赛克瓷砖、灰绿油漆。
                vec3 wallTone(float s){
                    float k = fract(s * 7.13);
                    if (k < 0.34) return vec3(0.30, 0.29, 0.27);
                    if (k < 0.55) return vec3(0.36, 0.32, 0.26);
                    if (k < 0.70) return vec3(0.24, 0.31, 0.29);
                    if (k < 0.82) return vec3(0.35, 0.27, 0.27);
                    if (k < 0.92) return vec3(0.22, 0.22, 0.23);
                    return vec3(0.33, 0.33, 0.30);
                }
                // 屋里的灯色：钨丝暖光、日光灯冷白、偏绿的旧灯管、红窗帘、电视蓝。
                vec3 roomTone(float h){
                    if (h < 0.40) return vec3(1.00, 0.66, 0.36);
                    if (h < 0.66) return vec3(0.78, 0.92, 1.00);
                    if (h < 0.76) return vec3(0.72, 1.00, 0.80);
                    if (h < 0.84) return vec3(1.00, 0.45, 0.42);
                    if (h < 0.90) return vec3(1.00, 0.85, 0.60);
                    return vec3(0.42, 0.55, 1.00);
                }
                // 窗洞里的房间：沿视线在一个 1×1×深 的盒子里求交，背墙、侧墙、天花、地板分别着色。
                vec3 room(vec2 cell, vec3 v, vec3 tone, float h, float depth){
                    vec3 o = vec3(cell, 0.0);
                    vec3 d = vec3(v.x, v.y, max(v.z, 1e-3) / depth);
                    vec3 t3 = (step(0.0, d) - o) / d;
                    float t = min(min(t3.x, t3.y), t3.z);
                    vec3 hit = o + d * t;
                    vec3 c;
                    if (t3.z <= t3.x && t3.z <= t3.y) {
                        c = tone * 0.55;
                        // 背墙上的柜子、海报、晾着的衣服剪影。
                        float shelf = step(0.35, hit.y) * step(hit.y, 0.7) * step(fract(h * 31.0) * 0.6, hit.x) * step(hit.x, fract(h * 31.0) * 0.6 + 0.35);
                        c *= 1.0 - shelf * 0.55;
                        float poster = step(abs(hit.x - fract(h * 17.0)), 0.08) * step(abs(hit.y - 0.62), 0.12);
                        c = mix(c, tone.bgr * 0.8, poster * 0.6);
                    } else if (t3.y <= t3.x) {
                        c = d.y > 0.0 ? tone * (0.95 + 0.5 * exp(-dot(hit.xz - vec2(0.5, 0.5), hit.xz - vec2(0.5, 0.5)) * 18.0)) : tone * 0.22;
                    } else {
                        c = tone * 0.4;
                    }
                    // 越往里越暗一点，像有纵深。
                    return c * mix(1.0, 0.65, clamp(hit.z, 0.0, 1.0));
                }

                void main(){
                    // 插值出来的常量也会有末位抖动，散列会把它放大成雪花点：先取整。
                    float seed = floor(vInfo.x * 9973.0 + 0.5) / 9973.0;
                    float kind = floor(vInfo.y + 0.5);
                    vec3 n = normalize(vNormal);
                    vec3 V = normalize(vWorld - cameraPosition);
                    float wet = uWet;

                    // ---------- 屋顶 ----------
                    if (kind > 3.5 && kind < 4.5) {
                        vec2 p = vFace.xy;
                        vec3 alb = vec3(0.17, 0.17, 0.18) * (0.7 + 0.6 * kwFbm(p * 0.35 + seed * 40.0));
                        float tar = smoothstep(0.55, 0.6, kwFbm(p * 0.18 + seed * 13.0));
                        alb = mix(alb, vec3(0.06), tar * 0.8);
                        vec3 col = kwLight(vWorld, n, alb, 0.8);
                        // 积水的屋顶反一点天光。
                        float puddle = smoothstep(0.62, 0.66, kwFbm(p * 0.25 + seed * 91.0)) * wet;
                        float fresR = pow(1.0 - max(0.0, -V.y), 4.0);
                        col = mix(col, uSky * (0.18 + 0.5 * fresR) + kwLight(vWorld, n, vec3(0.5), 0.1) * 0.4, puddle * 0.75);
                        gl_FragColor = vec4(col, 1.0);
                        #include <tonemapping_fragment>
                        #include <colorspace_fragment>
                        #include <fog_fragment>
                        return;
                    }

                    float u = vFace.x, v = vFace.y, len = vFace.z, bay = floor(vFace.w * 256.0 + 0.5) / 256.0;
                    float fl = floor(v / uFloor);
                    vec2 cell = vec2(fract(u / bay), fract(v / uFloor));
                    float col_ = floor(u / bay);
                    float h = kwHash(vec2(col_ + seed * 811.0, fl + seed * 173.0));
                    float h2 = kwHash(vec2(fl * 3.1 + seed * 59.0, col_ * 1.7 + 4.0));

                    // 底色、污渍、雨痕。
                    vec3 alb = wallTone(seed + floor(fl / 40.0));
                    if (kind > 4.5 && kind < 5.5) alb = vec3(0.25, 0.25, 0.26);
                    if (kind > 6.5) alb = vec3(0.10, 0.11, 0.13);
                    // 大块水渍：从楼顶和每层楼板往下挂的深色长条，宽窄不一。
                    float grime = kwFbm(vec2(u * 0.6, v * 0.12) + seed * 30.0);
                    float stainCol = kwNoise(vec2(u * 0.9 + seed * 17.0, 3.0));
                    float stain = smoothstep(0.45, 0.85, stainCol) * (0.4 + 0.6 * kwFbm(vec2(u * 1.7, v * 0.05) + seed * 3.0));
                    float streak = kwNoise(vec2(u * 2.3 + seed * 9.0, v * 0.04)) * smoothstep(0.0, 1.0, 1.0 - cell.y);
                    // 批荡上的补丁：一块块颜色略不同的新补的灰。
                    vec2 patchCell = floor(vec2(u / 1.7, v / 1.3));
                    float patchy = step(0.8, kwHash(patchCell + seed * 41.0));
                    alb *= 0.55 + 0.6 * grime;
                    alb *= 1.0 - (0.45 * stain + 0.3 * streak) * uDetail;
                    alb = mix(alb, alb * vec3(1.18, 1.14, 1.08), patchy * 0.6 * uDetail);
                    // 墙面细裂纹和颗粒：近处看不是一块平板。
                    float grain = kwNoise(vec2(u, v) * 9.0 + seed);
                    alb *= 0.9 + 0.2 * grain * uDetail;
                    // 瓷砖：细格子，个别掉了露出灰底。
                    if (fract(seed * 7.13) > 0.55 && fract(seed * 7.13) < 0.82 && kind < 1.5) {
                        vec2 tc = vec2(u, v) * 6.0;
                        vec2 tile = fract(tc);
                        vec2 tfw = fwidth(tc) * 1.2;
                        float grout = max(1.0 - smoothstep(0.0, 0.08 + tfw.x, tile.x), 1.0 - smoothstep(0.0, 0.08 + tfw.y, tile.y));
                        float lost = step(0.93, kwHash(floor(tc) + seed));
                        alb *= 1.0 - grout * 0.25 * uDetail * (1.0 - min(1.0, length(tfw) * 2.0));
                        alb = mix(alb, vec3(0.2, 0.2, 0.19), lost * 0.7 * uDetail);
                    }
                    // 楼板线：一道凸出的混凝土檐，顶面亮、底下一道阴影。
                    float slabTop = 1.0 - smoothstep(0.0, 0.035, cell.y);
                    float slabShadow = smoothstep(0.92, 1.0, cell.y);
                    alb *= 1.0 + slabTop * 0.22 - slabShadow * 0.35;
                    // 空调滴水留下的锈痕。
                    float rust = step(0.86, kwHash(vec2(col_ * 5.0 + seed, floor(v / uFloor / 2.0)))) * smoothstep(0.55, 0.0, cell.y) * step(abs(cell.x - 0.5), 0.12);
                    alb = mix(alb, vec3(0.30, 0.17, 0.09), rust * 0.6 * uDetail);
                    alb *= 1.0 - wet * 0.35;

                    // 窗。山墙（高出邻楼的部分）大多是实墙，只有零星小窗。
                    float hasWindow = 1.0;
                    if (kind > 2.5 && kind < 3.5) hasWindow = step(0.82, h2);
                    if (kind > 6.5) hasWindow = step(0.25, h2);
                    // 地面层是店铺，窗由店面和卷闸代替（巷道模块画）。
                    if (fl < 0.5 && kind < 1.5) hasWindow = 0.0;
                    // 每栋楼一种窗型：横长推拉窗、方窗、窄高窗、带气窗的、满开间的。
                    float type = fract(seed * 3.7);
                    vec2 wMin, wMax;
                    if (type < 0.25) { wMin = vec2(0.10, 0.32); wMax = vec2(0.90, 0.80); }
                    else if (type < 0.45) { wMin = vec2(0.22, 0.28); wMax = vec2(0.78, 0.84); }
                    else if (type < 0.6) { wMin = vec2(0.32, 0.2); wMax = vec2(0.68, 0.88); }
                    else if (type < 0.8) { wMin = vec2(0.14, 0.24); wMax = vec2(0.86, 0.9); }
                    else { wMin = vec2(0.04, 0.3); wMax = vec2(0.96, 0.84); }
                    // 个别人家改过窗：更小或封掉一半。
                    float reno = kwHash(vec2(h * 19.0, seed * 7.0));
                    if (reno < 0.12) { wMin.x += 0.18; wMax.x -= 0.18; }
                    else if (reno < 0.18) { wMax.y = mix(wMin.y, wMax.y, 0.5); }
                    else if (reno < 0.22) hasWindow = 0.0;
                    if (kind > 2.5 && kind < 3.5) { wMin = vec2(0.32, 0.45); wMax = vec2(0.68, 0.75); }
                    vec2 fw = fwidth(cell) * 1.5;
                    vec2 inA = smoothstep(wMin - fw, wMin + fw, cell) * (1.0 - smoothstep(wMax - fw, wMax + fw, cell));
                    float inWin = inA.x * inA.y * hasWindow;
                    vec3 col = kwLight(vWorld, n, alb, 0.9);

                    if (inWin > 0.001) {
                        vec2 wc = (cell - wMin) / (wMax - wMin);
                        // 每扇窗亮不亮会慢慢变：有人回家开灯、有人关灯睡觉。
                        float epoch = floor(uTime / 41.0 + h * 9.0);
                        float litRoll = kwHash(vec2(h * 97.0 + epoch, seed * 13.0));
                        float litP = (kind > 6.5 ? 0.2 : kind > 4.5 ? 0.24 : 0.3) + uLitBias;
                        float lit = step(litRoll, litP);
                        vec3 tone = roomTone(fract(h * 5.31 + seed));
                        // 电视：蓝光随时间抖。
                        float tv = step(0.88, fract(h * 5.31 + seed));
                        float tvFlick = 0.7 + 0.3 * sin(uTime * 7.0 + h * 50.0) * sin(uTime * 2.3 + h * 20.0);
                        vec3 t = normalize(vec3(n.z, 0.0, -n.x));
                        vec3 lv = vec3(dot(V, t), V.y, -dot(V, n));
                        vec3 inside = room(wc, vec3(lv.x / (bay * (wMax.x - wMin.x)), lv.y / (uFloor * (wMax.y - wMin.y)), lv.z / 3.0), tone, h, 1.0);
                        inside *= lit * uWindowGain * (kind > 6.5 ? 0.9 : 0.6 + 0.6 * fract(h * 13.7)) * mix(1.0, tvFlick, tv);
                        // 窗帘：一半拉上，透着色。
                        float curtain = step(0.55, h2) * step(wc.x, fract(h2 * 7.0) * 0.8 + 0.1);
                        inside = mix(inside, tone * lit * 0.55 * vec3(1.0, 0.85, 0.8), curtain * 0.75);
                        // 不亮的窗：暗玻璃反着天光和远处的霓虹。
                        float fres = pow(1.0 - max(0.0, dot(-V, n)), 3.0);
                        vec3 glass = uSky * (0.25 + 0.8 * fres) + kwLight(vWorld, n, vec3(0.25), 0.1) * 0.6;
                        vec3 win = mix(glass, inside + glass * 0.15, lit);
                        // 窗框和中间的横档、竖档。
                        vec2 fwc = fwidth(wc) * 1.2;
                        float frame = max(max(1.0 - smoothstep(0.0, 0.06 + fwc.x, wc.x), smoothstep(0.94 - fwc.x, 1.0, wc.x)),
                            max(1.0 - smoothstep(0.0, 0.07 + fwc.y, wc.y), smoothstep(0.93 - fwc.y, 1.0, wc.y)));
                        float mull = (1.0 - smoothstep(0.02, 0.03 + fwc.x, abs(wc.x - 0.5))) + (1.0 - smoothstep(0.02, 0.03 + fwc.y, abs(wc.y - 0.62))) * step(0.5, type);
                        frame = clamp(max(frame, mull) * uDetail, 0.0, 1.0);
                        // 窗洞有进深：靠边一圈是墙的侧面，顶上一道阴影。
                        float reveal = min(min(wc.x, 1.0 - wc.x) * bay * (wMax.x - wMin.x), min(wc.y, 1.0 - wc.y) * uFloor * (wMax.y - wMin.y));
                        float ao = smoothstep(0.0, 0.18, reveal) * (1.0 - 0.35 * smoothstep(0.75, 1.0, wc.y));
                        win *= 0.55 + 0.45 * ao;
                        win = mix(win, kwLight(vWorld, n, vec3(0.45, 0.46, 0.44), 0.5), frame);
                        col = mix(col, win, inWin);
                    }
                    // 窗台：窗下一道浅色的台，台下有水痕。
                    float sill = hasWindow * step(wMin.x - 0.03, cell.x) * step(cell.x, wMax.x + 0.03)
                        * smoothstep(wMin.y - 0.06, wMin.y - 0.045, cell.y) * (1.0 - smoothstep(wMin.y - 0.005, wMin.y, cell.y));
                    col = mix(col, kwLight(vWorld, n, vec3(0.42, 0.41, 0.38), 0.6), sill * 0.8 * uDetail);
                    gl_FragColor = vec4(col, 1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                    #include <fog_fragment>
                }`
        });
        disposables.push(shellMaterial);
        const shell = new T.Mesh(shellGeometry, shellMaterial);
        shell.name = 'kowloon-shells';
        shell.frustumCulled = false;
        group.add(shell);

        // ---------- 实例化的外挂物 ----------
        // 一个通用的道具材质：按 uPattern 画铁栏、空调格栅、波纹铁皮、竹竿。
        const propMaterial = (pattern, extra = {}) => {
            const uniforms = Object.assign(T.UniformsUtils.clone(T.UniformsLib.fog), shared, {
                uPattern: { value: pattern }, uDetail: shellUniforms.uDetail
            });
            const material = new T.ShaderMaterial({
                fog: true,
                side: extra.side ?? T.FrontSide,
                uniforms,
                vertexShader: /* glsl */`
                    varying vec3 vWorld;
                    varying vec3 vNormal;
                    varying vec3 vLocal;
                    varying vec3 vColor;
                    varying float vSeedRaw;
                    #include <fog_pars_vertex>
                    void main(){
                        mat4 im = mat4(1.0);
                        #ifdef USE_INSTANCING
                            im = instanceMatrix;
                        #endif
                        vColor = vec3(1.0);
                        #ifdef USE_INSTANCING_COLOR
                            vColor = instanceColor;
                        #endif
                        vLocal = position;
                        vec4 world = modelMatrix * im * vec4(position, 1.0);
                        vWorld = world.xyz;
                        vNormal = normalize(mat3(modelMatrix * im) * normal);
                        vSeedRaw = fract(dot(im[3].xyz, vec3(0.137, 0.731, 0.519)));
                        vec4 mvPosition = viewMatrix * world;
                        gl_Position = projectionMatrix * mvPosition;
                        #include <fog_vertex>
                    }`,
                fragmentShader: /* glsl */`
                    ${S.GLSL_COMMON}
                    ${S.GLSL_LIGHTS}
                    uniform float uPattern;
                    uniform float uDetail;
                    varying vec3 vWorld;
                    varying vec3 vNormal;
                    varying vec3 vLocal;
                    varying vec3 vColor;
                    varying float vSeedRaw;
                    #include <fog_pars_fragment>
                    void main(){
                        vec3 n = normalize(vNormal);
                        // 每个实例的常量经插值会有末位抖动，取整后再拿去散列。
                        float vSeed = floor(vSeedRaw * 997.0 + 0.5) / 997.0;
                        vec3 alb = vColor;
                        vec3 emit = vec3(0.0);
                        float grime = kwFbm(vLocal.xy * 3.0 + vSeed * 50.0);
                        alb *= 0.6 + 0.6 * grime;
                        if (uPattern < 0.5) {
                            // 铁窗笼：单位盒子，前面和两侧是竖栏加两道横档，顶是铁皮，底是实板。
                            vec3 p = vLocal + 0.5;
                            bool top = abs(n.y) > 0.5;
                            if (!top) {
                                float along = abs(n.x) > 0.5 ? p.z : p.x;
                                float bars = step(0.78, fract(along * 9.0));
                                float rails = step(abs(p.y - 0.08), 0.05) + step(abs(p.y - 0.55), 0.03) + step(0.94, p.y);
                                float edge = step(along, 0.04) + step(0.96, along);
                                float solid = clamp(bars + rails + edge + step(p.y, 0.12), 0.0, 1.0);
                                if (solid < 0.5) discard;
                                alb = mix(alb, vec3(0.32, 0.18, 0.1), grime * 0.5);
                            } else if (n.y > 0.5) {
                                alb *= 0.75 + 0.25 * step(0.5, fract(p.x * 14.0));
                            }
                        } else if (uPattern < 1.5) {
                            // 空调外机：正面一个圆形风扇格栅，侧面散热片。
                            vec3 p = vLocal + 0.5;
                            if (n.z > 0.5) {
                                vec2 q = vec2((p.x - 0.62) * 1.45, p.y - 0.5);
                                float r = length(q);
                                float grill = step(r, 0.36) * (0.55 + 0.45 * step(0.5, fract(r * 22.0)));
                                alb *= 1.0 - grill * 0.6;
                                float vent = step(p.x, 0.25) * step(0.5, fract(p.y * 14.0));
                                alb *= 1.0 - vent * 0.3;
                            }
                            alb = mix(alb, vec3(0.28, 0.2, 0.12), smoothstep(0.55, 0.9, grime) * 0.5);
                        } else if (uPattern < 2.5) {
                            // 屋顶加建：波纹铁皮墙，偶尔一扇小窗亮着。
                            vec3 p = vLocal + 0.5;
                            float along = abs(n.x) > 0.5 ? p.z : p.x;
                            if (abs(n.y) < 0.5) {
                                alb *= 0.8 + 0.25 * sin(along * 60.0);
                                // 每一面自己决定开不开窗、窗在哪、亮不亮，免得一排排像人脸。
                                float faceId = dot(floor(n + 0.5), vec3(1.0, 0.0, 3.0)) + vSeed * 17.0;
                                float hf = fract(sin(faceId * 12.9898) * 43758.5453);
                                float hg = fract(sin(faceId * 78.233) * 12543.123);
                                float cx = 0.2 + 0.6 * hf, wwid = 0.08 + 0.12 * hg;
                                float win = step(0.35, hg) * step(abs(along - cx), wwid) * step(abs(p.y - 0.58), 0.12 + 0.06 * hf);
                                float door = step(hg, 0.2) * step(abs(along - (1.0 - cx)), 0.11) * step(p.y, 0.8);
                                float lit = step(0.5, fract(hf * 7.0 + vSeed * 3.0));
                                vec3 lampTone = hf > 0.7 ? vec3(0.7, 0.9, 1.0) : vec3(1.0, 0.62, 0.3);
                                emit = lampTone * win * lit * (0.6 + 0.6 * hg);
                                alb *= 1.0 - win * 0.8 - door * 0.6;
                            } else {
                                alb *= 0.7 + 0.3 * sin(p.x * 40.0);
                            }
                            alb = mix(alb, vec3(0.35, 0.18, 0.08), smoothstep(0.6, 0.85, grime) * 0.6);
                        } else if (uPattern < 3.5) {
                            // 水箱、管子、天线：金属，按色。
                            alb *= 0.9;
                        } else {
                            // 雨棚：塑料或铁皮，底面被下面店铺灯照。
                            alb *= 0.8 + 0.2 * step(0.5, fract(vLocal.x * 6.0));
                        }
                        alb *= 1.0 - uWet * 0.25;
                        vec3 col = kwLight(vWorld, n, alb, 0.6) + emit;
                        // 湿金属的高光：对着天空反一点。
                        float fres = pow(1.0 - max(0.0, dot(normalize(cameraPosition - vWorld), n)), 4.0);
                        col += uSky * fres * uWet * 0.6;
                        gl_FragColor = vec4(col, 1.0);
                        #include <tonemapping_fragment>
                        #include <colorspace_fragment>
                        #include <fog_fragment>
                    }`
            });
            disposables.push(material);
            return material;
        };

        const tmpM = new T.Matrix4(), tmpQ = new T.Quaternion(), tmpS = new T.Vector3(), tmpP = new T.Vector3();
        const up = new T.Vector3(0, 1, 0);
        const xAxis = new T.Vector3(1, 0, 0), tmpQ2 = new T.Quaternion();
        const instanced = (name, geometry, material, items) => {
            if (!items.length) return null;
            disposables.push(geometry);
            const mesh = new T.InstancedMesh(geometry, material, items.length);
            mesh.name = name;
            const color = new T.Color();
            items.forEach((it, i) => {
                tmpP.set(it.p[0], it.p[1], it.p[2]);
                tmpQ.setFromAxisAngle(up, it.yaw || 0);
                if (it.tilt) tmpQ.multiply(tmpQ2.setFromAxisAngle(xAxis, it.tilt));
                tmpS.set(it.s[0], it.s[1], it.s[2]);
                tmpM.compose(tmpP, tmpQ, tmpS);
                mesh.setMatrixAt(i, tmpM);
                color.setRGB(it.c[0], it.c[1], it.c[2]);
                mesh.setColorAt(i, color);
            });
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
            mesh.frustumCulled = false;
            group.add(mesh);
            return mesh;
        };
        // 立面法线 → 让局部 +z 朝外的偏航角。
        const yawOf = (n) => Math.atan2(n[0], n[2]);
        const out = (s, d) => [s.pos[0] + s.normal[0] * d, s.pos[1], s.pos[2] + s.normal[2] * d];

        const cages = [], acs = [], awnings = [], poles = [], clothes = [];
        const metal = () => { const g = 0.28 + rand() * 0.18; return rand() < 0.25 ? [0.2, 0.3, 0.27] : [g, g * 0.96, g * 0.9]; };
        layout.slots().forEach(s => {
            const yaw = yawOf(s.normal);
            if (s.use === 'cage') {
                // 铁窗笼：比窗宽一点，伸出 0.45–0.75 m，偶尔两层连在一起。
                const depth = 0.45 + rand() * 0.3;
                const tall = rand() < 0.12 ? 2 : 1;
                const h = 1.75 + (tall - 1) * FLOOR;
                const p = out(s, depth / 2);
                p[1] = s.pos[1] - 0.72 + h / 2;
                cages.push({ p, s: [s.width * (0.72 + rand() * 0.2), h, depth], yaw, c: metal() });
                // 有的窗笼上再挂空调或伸出晾衣竹竿。
                if (rand() < 0.22) acs.push({ p: [p[0] + s.normal[0] * (depth / 2 + 0.17), s.pos[1] - 0.8, p[2] + s.normal[2] * (depth / 2 + 0.17)], s: [0.78, 0.52, 0.32], yaw, c: [0.62, 0.61, 0.57] });
                if (rand() < 0.3) poles.push(s);
            } else if (s.use === 'ac') {
                const p = out(s, 0.2);
                p[1] = s.pos[1] - 1.05 + (rand() < 0.3 ? 1.3 : 0);
                const shift = (rand() - 0.5) * s.width * 0.4;
                p[0] += s.tangent[0] * shift; p[2] += s.tangent[2] * shift;
                const g = 0.5 + rand() * 0.18;
                acs.push({ p, s: [0.72 + rand() * 0.18, 0.5 + rand() * 0.08, 0.3], yaw, c: [g, g * 0.98, g * 0.92] });
                if (rand() < 0.35) {
                    // 两台叠在一起，很常见。
                    acs.push({ p: [p[0], p[1] - 0.58, p[2]], s: [0.72, 0.5, 0.3], yaw, c: [g * 0.9, g * 0.88, g * 0.82] });
                }
            } else if (s.use === 'free' && s.floor > 0 && rand() < 0.1) {
                poles.push(s);
            }
            if (s.kind === 'shop' && rand() < 0.65) {
                // 店铺雨棚。
                const depth = 1.0 + rand() * 0.9;
                const p = out(s, depth / 2);
                p[1] = FLOOR - 0.35 + rand() * 0.2;
                const tint = rand();
                const c = tint < 0.3 ? [0.42, 0.14, 0.12] : tint < 0.55 ? [0.16, 0.3, 0.26] : tint < 0.7 ? [0.4, 0.34, 0.18] : [0.32, 0.32, 0.33];
                awnings.push({ p, s: [s.width * 1.02, 0.08, depth], yaw, c });
            }
        });
        // 晾衣竹竿：从窗口斜伸出去 1.5–2.5 m，挂几件衣服。
        const poleItems = [];
        poles.forEach(s => {
            const yaw = yawOf(s.normal);
            const len = 1.6 + rand() * 1.0;
            const p = out(s, len / 2);
            p[1] = s.pos[1] + 0.35;
            poleItems.push({ p, s: [0.045, 0.045, len], yaw, c: [0.55, 0.48, 0.3] });
            const n = 1 + Math.floor(rand() * 3);
            for (let i = 0; i < n; i += 1) {
                const d = 0.4 + (i + rand() * 0.5) * (len - 0.5) / n;
                const q = out(s, d);
                const hue = rand();
                const c = hue < 0.25 ? [0.62, 0.6, 0.55] : hue < 0.45 ? [0.18, 0.24, 0.42] : hue < 0.6 ? [0.5, 0.16, 0.18]
                    : hue < 0.75 ? [0.22, 0.36, 0.3] : hue < 0.88 ? [0.5, 0.42, 0.2] : [0.12, 0.12, 0.14];
                clothes.push({ p: [q[0], s.pos[1] + 0.35 - 0.34, q[2]], s: [0.03, 0.62 + rand() * 0.3, 0.42 + rand() * 0.25], yaw: yaw, c });
            }
        });

        const boxGeo = () => new T.BoxGeometry(1, 1, 1);
        // 窗笼几何不要底面朝下的那块被剔掉：双面。
        const cageMesh = instanced('kowloon-cages', boxGeo(), propMaterial(0, { side: T.DoubleSide }), cages);
        const acMesh = instanced('kowloon-ac', boxGeo(), propMaterial(1), acs);
        const awningMesh = instanced('kowloon-awnings', boxGeo(), propMaterial(4), awnings);
        const poleGeo = new T.CylinderGeometry(0.5, 0.5, 1, 5, 1, true);
        poleGeo.rotateX(Math.PI / 2);
        const poleMesh = instanced('kowloon-poles', poleGeo, propMaterial(3), poleItems);
        const clothMesh = instanced('kowloon-clothes', boxGeo(), propMaterial(3), clothes);

        // ---------- 屋顶：加建铁皮屋、水箱、天线林、围栏 ----------
        const shacks = [], tanks = [], antennas = [], rails = [], dishes = [], crates = [];
        layout.lots.forEach(lot => {
            if (lot.height <= 0) return;
            const w = lot.x1 - lot.x0, d = lot.z1 - lot.z0;
            const y = lot.height;
            const nShack = rand() < 0.75 ? 1 + Math.floor(rand() * 2) : 0;
            for (let i = 0; i < nShack; i += 1) {
                const sw = Math.min(w - 0.4, 2.2 + rand() * 3.5), sd = Math.min(d - 0.4, 2 + rand() * 3);
                if (sw < 1.2 || sd < 1.2) continue;
                const sh = 2.2 + rand() * 0.6;
                const cx = lot.x0 + 0.2 + sw / 2 + rand() * (w - 0.4 - sw);
                const cz = lot.z0 + 0.2 + sd / 2 + rand() * (d - 0.4 - sd);
                const g = 0.3 + rand() * 0.2;
                shacks.push({ p: [cx, y + sh / 2, cz], s: [sw, sh, sd], yaw: 0, c: rand() < 0.2 ? [0.25, 0.32, 0.36] : [g, g * 0.95, g * 0.88] });
                // 有的加建再叠一层。
                if (rand() < 0.2) shacks.push({ p: [cx, y + sh + 1.1, cz], s: [sw * 0.7, 2.2, sd * 0.7], yaw: 0, c: [g * 0.9, g * 0.86, g * 0.8] });
            }
            if (rand() < 0.55) {
                const r = 0.6 + rand() * 0.5, h = 1.2 + rand() * 0.8;
                const tx = lot.x0 + r + 0.2 + rand() * Math.max(0, w - 2 * r - 0.4);
                const tz = lot.z0 + r + 0.2 + rand() * Math.max(0, d - 2 * r - 0.4);
                const stand = rand() < 0.5 ? 1.2 : 0;
                tanks.push({ p: [tx, y + stand + h / 2, tz], s: [r, h, r], yaw: 0, c: rand() < 0.5 ? [0.28, 0.36, 0.42] : [0.44, 0.42, 0.38] });
            }
            // 天线林是城寨屋顶最认得出来的东西：高楼上一丛，矮楼上也有几根。
            const nAnt = 1 + Math.floor(rand() * (lot.floors > 12 ? 8 : 4));
            for (let i = 0; i < nAnt; i += 1) {
                const ah = 3 + rand() * 5;
                antennas.push({ p: [lot.x0 + 0.3 + rand() * (w - 0.6), y, lot.z0 + 0.3 + rand() * (d - 0.6)], s: [1 + rand() * 0.6, ah, 1], yaw: rand() * Math.PI, c: [0.17, 0.17, 0.18] });
            }
            // 高杆天线：细长，十来米。
            if (rand() < 0.22) antennas.push({ p: [lot.x0 + 0.5 + rand() * (w - 1), y, lot.z0 + 0.5 + rand() * (d - 1)], s: [1.4, 9 + rand() * 5, 1.2], yaw: rand() * Math.PI, c: [0.15, 0.15, 0.16] });
            // 锅盖天线：朝南斜着。
            if (rand() < 0.3) {
                const r = 0.35 + rand() * 0.4;
                dishes.push({ p: [lot.x0 + 0.5 + rand() * (w - 1), y + 0.4 + rand() * 0.6, lot.z0 + 0.5 + rand() * (d - 1)], s: [r, 0.12, r], yaw: rand() * 0.8 - 0.4, tilt: 1.0 + rand() * 0.3, c: [0.36, 0.36, 0.35] });
            }
            // 屋顶杂物：木箱、油桶、旧家具堆。
            const nCrate = Math.floor(rand() * 4);
            for (let i = 0; i < nCrate; i += 1) {
                const cs = 0.5 + rand() * 0.9;
                const g = 0.2 + rand() * 0.2;
                crates.push({ p: [lot.x0 + 0.4 + rand() * (w - 0.8), y + cs * 0.35, lot.z0 + 0.4 + rand() * (d - 0.8)], s: [cs, cs * 0.7, cs * (0.6 + rand() * 0.6)], yaw: rand() * Math.PI, c: [g * 1.1, g, g * 0.85] });
            }
            // 女儿墙上的铁栏只给对外的边。
            if (rand() < 0.6) rails.push({ p: [(lot.x0 + lot.x1) / 2, y + 0.55, lot.z1 - 0.05], s: [w, 1.1, 0.06], yaw: 0, c: [0.3, 0.29, 0.27] });
        });
        const shackMesh = instanced('kowloon-shacks', boxGeo(), propMaterial(2), shacks);
        const tankGeo = new T.CylinderGeometry(1, 1, 1, 12, 1);
        const tankMesh = instanced('kowloon-tanks', tankGeo, propMaterial(3), tanks);
        // 鱼骨天线：一根竖杆，上半截几道横杆。并成一个几何，原点在杆底。
        const antennaGeo = (() => {
            // 杆是两片十字交叉的面，横杆是竖着的细面：远看是线，三角面只有箱子的六分之一。
            const parts = [];
            const quad = (w, h, x, y, z, rotY) => {
                const g = new T.PlaneGeometry(w, h);
                if (rotY) g.rotateY(rotY);
                g.translate(x, y, z);
                parts.push(g);
            };
            quad(0.06, 1, 0, 0.5, 0, 0);
            quad(0.06, 1, 0, 0.5, 0, Math.PI / 2);
            for (let i = 0; i < 6; i += 1) quad(0.6 - i * 0.07, 0.03, 0, 0.62 + i * 0.065, 0, 0);
            quad(0.5, 0.03, 0, 0.94, 0.1, Math.PI / 2);
            const merged = mergeGeometries(T, parts);
            parts.forEach(p => p.dispose());
            return merged;
        })();
        const antennaMesh = instanced('kowloon-antennas', antennaGeo, propMaterial(3, { side: T.DoubleSide }), antennas);
        const railMesh = instanced('kowloon-rails', boxGeo(), propMaterial(0, { side: T.DoubleSide }), rails);
        const dishGeo = new T.SphereGeometry(1, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2);
        const dishMesh = instanced('kowloon-dishes', dishGeo, propMaterial(3, { side: T.DoubleSide }), dishes);
        const crateMesh = instanced('kowloon-crates', boxGeo(), propMaterial(2), crates);

        // ---------- 落水管与电缆束：沿立面竖着走 ----------
        const pipes = [];
        layout.facades.forEach(f => {
            if (f.kind === 'upper') return;
            const n = Math.floor(f.length / 6 + rand() * 1.5);
            for (let i = 0; i < n; i += 1) {
                const t = rand() * f.length;
                const r = 0.05 + rand() * 0.05;
                const x = f.p0[0] + f.tangent[0] * t + f.normal[0] * (0.08 + r);
                const z = f.p0[1] + f.tangent[2] * t + f.normal[2] * (0.08 + r);
                const h = f.y1 - f.y0;
                const g = rand() < 0.5 ? 0.22 : 0.4;
                pipes.push({ p: [x, f.y0 + h / 2, z], s: [r, h, r], yaw: 0, c: [g, g * 0.95, g * 0.9] });
            }
        });
        const pipeGeo = new T.CylinderGeometry(1, 1, 1, 6, 1, true);
        const pipeMesh = instanced('kowloon-pipes', pipeGeo, propMaterial(3), pipes);

        const meshes = [shell, cageMesh, acMesh, awningMesh, poleMesh, clothMesh, shackMesh, tankMesh, antennaMesh, railMesh, pipeMesh, dishMesh, crateMesh].filter(Boolean);

        // ---------- 天上：低飞进场的客机、远处高楼顶的航空障碍灯 ----------
        // 客机从西北压低高度飞过屋顶，起落架灯照亮天线林，大约每 80 秒一架。
        const plane = new T.Group();
        plane.name = 'kowloon-plane';
        const planeMat = propMaterial(3);
        const fuselage = new T.CylinderGeometry(1.9, 1.6, 38, 12, 1);
        fuselage.rotateX(Math.PI / 2);
        const wing = new T.BoxGeometry(34, 0.5, 5.5);
        const tailFin = new T.BoxGeometry(0.4, 6.5, 4.5);
        tailFin.translate(0, 4, -16.5);
        const tailWing = new T.BoxGeometry(12, 0.35, 3);
        tailWing.translate(0, 1, -17);
        const engine = new T.CylinderGeometry(0.95, 0.95, 3.6, 10, 1);
        engine.rotateX(Math.PI / 2);
        const planeGeo = mergeGeometries(T, [fuselage, wing, tailFin, tailWing,
            engine.clone().translate(-6.5, -1.2, 1.5), engine.clone().translate(6.5, -1.2, 1.5)]);
        [fuselage, wing, tailFin, tailWing, engine].forEach(g => g.dispose());
        disposables.push(planeGeo);
        // 道具材质的颜色来自 instanceColor，所以机身也用单实例的 InstancedMesh。
        const planeInst = new T.InstancedMesh(planeGeo, planeMat, 1);
        planeInst.setMatrixAt(0, new T.Matrix4());
        planeInst.setColorAt(0, new T.Color(0.55, 0.56, 0.58));
        planeInst.frustumCulled = false;
        plane.add(planeInst);
        const blinkGeo = new T.BufferGeometry();
        const blinkPos = [0, -2.1, 14, -17, 0.2, 0, 17, 0.2, 0, 0, 7.4, -18, 0, 2.1, 0];
        blinkGeo.setAttribute('position', new T.Float32BufferAttribute(blinkPos, 3));
        blinkGeo.setAttribute('color', new T.Float32BufferAttribute([3, 3, 2.6, 3, 0.3, 0.2, 0.3, 3, 0.6, 3, 3, 3, 3, 0.25, 0.2], 3));
        disposables.push(blinkGeo);
        const blinkMat = new T.PointsMaterial({ size: 3.2, vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true, fog: false });
        disposables.push(blinkMat);
        const planeLights = new T.Points(blinkGeo, blinkMat);
        plane.add(planeLights);
        plane.visible = false;
        group.add(plane);
        const PLANE_PERIOD = 80, PLANE_SPAN = 26;
        const planeFrom = new T.Vector3(-420, 118, -260), planeTo = new T.Vector3(380, 34, 230);
        const planeState = { light: null };

        // 远处高楼顶的红色障碍灯，慢慢明灭。
        const beaconPos = [], beaconPhase = [];
        far.forEach(b => {
            if (b.height < 60) return;
            beaconPos.push((b.x0 + b.x1) / 2, b.height + 1, (b.z0 + b.z1) / 2);
            beaconPhase.push(rand());
        });
        const beaconGeo = new T.BufferGeometry();
        beaconGeo.setAttribute('position', new T.Float32BufferAttribute(beaconPos, 3));
        beaconGeo.setAttribute('aPhase', new T.Float32BufferAttribute(beaconPhase, 1));
        disposables.push(beaconGeo);
        const beaconMat = new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending,
            uniforms: { uTime: shared.uTime },
            vertexShader: `attribute float aPhase; uniform float uTime; varying float vOn;
                void main(){ vOn = pow(max(0.0, sin((uTime * 0.9 + aPhase * 6.28))), 6.0);
                vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(900.0 / -mv.z, 2.0, 7.0); gl_Position = projectionMatrix * mv; }`,
            fragmentShader: `varying float vOn; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
                gl_FragColor = vec4(vec3(2.6, 0.25, 0.15) * a * (0.15 + vOn), 1.0); }`
        });
        disposables.push(beaconMat);
        const beacons = new T.Points(beaconGeo, beaconMat);
        beacons.frustumCulled = false;
        group.add(beacons);

        // 给巷道线程滴水用：空调机的位置。
        const acPositions = acs.map(a => a.p);

        return {
            group,
            acPositions,
            update(state) {
                shared.uTime.value = state.time || 0;
                const far = state.shot === 'iso' || state.shot === 'diorama' || state.shot === 'roof';
                const target = far ? 0.5 : 0.85;
                const g = shellUniforms.uWindowGain;
                g.value += (target - g.value) * Math.min(1, (state.dt || 0.016) * 2 + (g.init ? 0 : 1));
                g.init = true;
                const t = (state.time || 0) % PLANE_PERIOD;
                plane.visible = t < PLANE_SPAN;
                planeState.light = null;
                if (plane.visible) {
                    const k = t / PLANE_SPAN;
                    plane.position.lerpVectors(planeFrom, planeTo, k);
                    plane.lookAt(planeTo.x * 2 - planeFrom.x, planeTo.y * 2 - planeFrom.y, planeTo.z * 2 - planeFrom.z);
                    const blink = Math.floor((state.time || 0) * 1.3) % 2;
                    blinkMat.size = 3.2 + blink * 1.6;
                    // 起落架灯打在屋顶上的光。
                    const ahead = new T.Vector3(0, -2.5, 16).applyQuaternion(plane.quaternion).add(plane.position);
                    planeState.light = { position: [ahead.x, ahead.y - 12, ahead.z], color: [1, 0.95, 0.85], intensity: 2.2, radius: 55 };
                }
            },
            setPalette() {},
            setTier(tier) {
                shellUniforms.uDetail.value = tier?.name === 'energy-saving' ? 0.6 : 1;
            },
            setOptions() {},
            lights() { return planeState.light ? [planeState.light] : []; },
            stats() {
                return {
                    cityMeshes: meshes.length,
                    cityInstances: { cages: cages.length, ac: acs.length, awnings: awnings.length, poles: poleItems.length, clothes: clothes.length, shacks: shacks.length, tanks: tanks.length, antennas: antennas.length, pipes: pipes.length, dishes: dishes.length, crates: crates.length, beacons: beaconPhase.length }
                };
            },
            dispose() {
                scene.remove(group);
                disposables.forEach(d => d.dispose());
            }
        };
    };

    // 只合并位置、法线（BoxGeometry 的 uv 我们不用）。
    function mergeGeometries(T, parts) {
        const pos = [], nor = [], idx = [];
        let offset = 0;
        parts.forEach(g => {
            const geo = g.index ? g : g;
            const p = geo.attributes.position.array, n = geo.attributes.normal.array;
            for (let i = 0; i < p.length; i += 1) { pos.push(p[i]); nor.push(n[i]); }
            const ix = geo.index ? geo.index.array : Array.from({ length: p.length / 3 }, (_, i) => i);
            for (let i = 0; i < ix.length; i += 1) idx.push(ix[i] + offset);
            offset += p.length / 3;
        });
        const out = new T.BufferGeometry();
        out.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
        out.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
        out.setIndex(idx);
        return out;
    }

    global.MusicStageKowloonCity = Object.freeze({ create, KIND });
})(typeof window !== 'undefined' ? window : globalThis);
