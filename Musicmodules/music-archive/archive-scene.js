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

    /* 画质档位，和歌词舞台的三档对齐：帧率上限、阴影、抗锯齿、像素比上限。 */
    const TIERS = Object.freeze({
        'energy-saving': Object.freeze({ fps: 30, idleFps: 15, shadows: false, shadowSize: 0, antialias: false, maxDpr: 1 }),
        standard: Object.freeze({ fps: 60, idleFps: 30, shadows: true, shadowSize: 1024, antialias: true, maxDpr: 1.5 }),
        ultimate: Object.freeze({ fps: 0, idleFps: 60, shadows: true, shadowSize: 2048, antialias: true, maxDpr: 2 })
    });
    const tierOf = (quality) => TIERS[quality] || TIERS.standard;

    /* 场景灯光两套（浅色、深色）；底色、卡片、地面等颜色从设计令牌读。 */
    const LIGHTING = Object.freeze({
        light: { hemiSky: '#fffaf5', hemiGround: '#b4a18c', hemi: 0.42, key: 1.9, fill: 0.45, env: 1, exposure: 0.93, sheen: 0.3, clearcoat: 0.15, sheenColor: '#f6d9b8', fogNear: 5, fogFar: 25, tag: '#ece6dc', tagInk: 'rgba(40,38,34,.7)', tagRing: 'rgba(60,55,48,.55)' },
        dark: { hemiSky: '#9aa8ad', hemiGround: '#0e1416', hemi: 0.27, key: 0.95, fill: 0.25, env: 1, exposure: 0.87, sheen: 0, clearcoat: 0.06, sheenColor: '#6f7a7e', fogNear: 1, fogFar: 16, tag: '#2c363b', tagInk: 'rgba(224,227,220,.75)', tagRing: 'rgba(220,226,222,.45)' }
    });

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

    /* 室内环境光照：白色房间、一盏顶灯和几块发光板，只在创建时烘一次。 */
    const bakeEnvironment = (THREE, renderer) => {
        const room = new THREE.Scene();
        const unit = new THREE.BoxGeometry();
        unit.deleteAttribute('uv');
        const roomMat = new THREE.MeshStandardMaterial({ side: THREE.BackSide });
        const boxMat = new THREE.MeshStandardMaterial();
        const lamp = new THREE.PointLight(0xffffff, 900, 28, 2);
        lamp.position.set(0.418, 16.199, 0.3);
        room.add(lamp);
        const place = (mat, p, s, r = 0) => {
            const m = new THREE.Mesh(unit, mat);
            m.position.set(p[0], p[1], p[2]);
            m.scale.set(s[0], s[1], s[2]);
            m.rotation.y = r;
            room.add(m);
        };
        place(roomMat, [-0.757, 13.219, 0.717], [31.713, 28.305, 28.591]);
        place(boxMat, [-10.906, 2.009, 1.846], [2.328, 7.905, 4.651], -1.977);
        place(boxMat, [-5.607, -0.754, -0.758], [1.97, 1.534, 3.955], -0.448);
        place(boxMat, [6.167, 0.857, 7.803], [3.927, 6.285, 3.687], -0.193);
        place(boxMat, [-2.017, 0.018, 6.124], [2.393, 1.522, 2.4]);
        place(boxMat, [2.291, -0.756, -2.621], [1.5, 1.5, 1.5], -0.4);
        place(boxMat, [-2.193, -0.369, -5.547], [1.5, 1.5, 1.5]);
        const glow = (k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k) });
        const glows = [glow(50), glow(43), glow(5), glow(20), glow(100)];
        place(glows[0], [-16.116, 14.37, 8.208], [0.1, 2.428, 2.739]);
        place(glows[1], [-16.109, 18.021, -8.207], [0.1, 2.425, 2.751]);
        place(glows[2], [14.904, 12.198, -1.832], [0.15, 4.265, 6.331]);
        place(glows[3], [-0.462, 8.89, 14.52], [4.38, 5.441, 0.088]);
        place(glows[0], [3.235, 11.486, -12.541], [2.5, 2.0, 0.1]);
        place(glows[4], [0.0, 20.0, 0.0], [1.0, 0.1, 1.0]);
        const pmrem = new THREE.PMREMGenerator(renderer);
        const target = pmrem.fromScene(room, 0.04);
        pmrem.dispose();
        unit.dispose();
        for (const m of [roomMat, boxMat, ...glows]) m.dispose();
        return target;
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
        renderer.shadowMap.enabled = tier.shadows;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        const scene = new THREE.Scene();
        const envTarget = bakeEnvironment(THREE, renderer);
        scene.environment = envTarget.texture;

        const hemi = new THREE.HemisphereLight('#fffaf5', '#b4a18c', 0.42);
        const key = new THREE.DirectionalLight('#fff7ed', 1.9);
        key.position.set(-6, 14, -5);
        key.castShadow = tier.shadows;
        if (tier.shadows) {
            Object.assign(key.shadow.camera, { left: -16, right: 16, top: 15, bottom: -15, near: 0.1, far: 45 });
            key.shadow.mapSize.set(tier.shadowSize, tier.shadowSize);
            key.shadow.normalBias = 0.035;
            key.shadow.bias = -0.0003;
            key.shadow.radius = 4;
        }
        const fill = new THREE.DirectionalLight('#ffffff', 0.45);
        fill.position.set(7, 8, -10);
        scene.add(hemi, key, fill);

        const floorMat = new THREE.MeshStandardMaterial({ color: '#d8c9b9', roughness: 0.95 });
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -4.63;
        floor.receiveShadow = tier.shadows;
        scene.add(floor);

        const camera = new THREE.PerspectiveCamera(3, 16 / 9, 5, 300);

        // 卡身：原点在底边；顶点色做行间缝隙的遮蔽，越往下越暗
        const bodyGeo = roundedBox(THREE, CARD_W, CARD_H, CARD_D, 3, 0.045);
        bodyGeo.translate(0, CARD_H / 2, 0.02);
        {
            const P = bodyGeo.attributes.position;
            const C = new Float32Array(P.count * 3);
            for (let i = 0; i < P.count; i++) {
                const t = Math.min(1, Math.max(0, (P.getY(i) - 1.2) / 2.5));
                const k = 0.62 + 0.38 * t * t * (3 - 2 * t);
                C[i * 3] = k; C[i * 3 + 1] = k * 0.985; C[i * 3 + 2] = k * 0.955;
            }
            bodyGeo.setAttribute('color', new THREE.BufferAttribute(C, 3));
        }
        const polymer = new THREE.MeshPhysicalMaterial({ roughness: 0.36, metalness: 0, clearcoat: 0.15, clearcoatRoughness: 0.4, sheen: 0.3, sheenRoughness: 0.8, vertexColors: true });
        const cards = new THREE.InstancedMesh(bodyGeo, polymer, POOL);
        cards.castShadow = tier.shadows;
        cards.receiveShadow = tier.shadows;
        cards.frustumCulled = false;
        scene.add(cards);

        // 卡面左上角的自绘小标签
        const tagGeo = new THREE.PlaneGeometry(0.95, 0.34);
        tagGeo.translate(-1.35, 3.06, 0.194);
        const tagCanvas = document.createElement('canvas');
        tagCanvas.width = 256; tagCanvas.height = 92;
        const tagTex = new THREE.CanvasTexture(tagCanvas);
        tagTex.colorSpace = THREE.SRGBColorSpace;
        tagTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        const tagMat = new THREE.MeshStandardMaterial({ map: tagTex, roughness: 0.6, transparent: true });
        const tags = new THREE.InstancedMesh(tagGeo, tagMat, POOL);
        tags.receiveShadow = tier.shadows;
        tags.frustumCulled = false;
        // 顶边的素色小圆点
        const ringGeo = new THREE.CircleGeometry(0.06, 24);
        ringGeo.translate(2.2, 3.5, 0.198);
        const ringMat = new THREE.MeshStandardMaterial({ color: '#8e8981', roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2 });
        const rings = new THREE.InstancedMesh(ringGeo, ringMat, POOL);
        rings.frustumCulled = false;
        // 靠近端头的浅槽：顶面一道 + 正面一小段
        const grooveTop = new THREE.PlaneGeometry(0.035, 0.34);
        grooveTop.rotateX(-Math.PI / 2);
        grooveTop.translate(-1.72, 3.702, 0.02);
        const grooveFront = new THREE.PlaneGeometry(0.035, 0.55);
        grooveFront.translate(-1.72, 3.42, 0.197);
        const grooveMat = new THREE.MeshStandardMaterial({ color: '#b9ab9a', roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 });
        const grooves = new THREE.InstancedMesh(grooveTop, grooveMat, POOL);
        const grooves2 = new THREE.InstancedMesh(grooveFront, grooveMat, POOL);
        grooves.frustumCulled = false; grooves2.frustumCulled = false;
        scene.add(tags, rings, grooves, grooves2);
        const layers = [cards, tags, rings, grooves, grooves2];

        let lighting = LIGHTING.dark;
        let fontStack = 'sans-serif';
        const paintTag = () => {
            const g = tagCanvas.getContext('2d');
            g.clearRect(0, 0, 256, 92);
            g.fillStyle = lighting.tag;
            g.beginPath();
            if (g.roundRect) g.roundRect(2, 2, 252, 88, 10); else g.rect(2, 2, 252, 88);
            g.fill();
            g.strokeStyle = lighting.tagRing;
            g.lineWidth = 3;
            g.beginPath();
            g.arc(40, 46, 18, 0, Math.PI * 2);
            g.stroke();
            g.fillStyle = lighting.tagInk;
            g.font = '600 22px ' + fontStack;
            g.fillText('VCP · AUDIO', 72, 40);
            g.font = '500 16px ' + fontStack;
            g.fillText('ARCHIVE FILE', 72, 66);
            tagTex.needsUpdate = true;
        };

        /* colors: { paper, card, floor, badge, groove, font }，dark: 是否深色 */
        const setTheme = (colors, dark) => {
            lighting = dark ? LIGHTING.dark : LIGHTING.light;
            fontStack = colors.font || fontStack;
            const bg = new THREE.Color(colors.paper);
            scene.background = bg;
            scene.fog = new THREE.Fog(bg, DIST + lighting.fogNear, DIST + lighting.fogFar);
            floorMat.color.set(colors.floor);
            polymer.color.set(colors.card);
            polymer.sheen = lighting.sheen;
            polymer.sheenColor.set(lighting.sheenColor);
            polymer.clearcoat = lighting.clearcoat;
            ringMat.color.set(colors.badge);
            grooveMat.color.set(colors.groove);
            hemi.color.set(lighting.hemiSky);
            hemi.groundColor.set(lighting.hemiGround);
            hemi.intensity = lighting.hemi;
            key.intensity = lighting.key;
            fill.intensity = lighting.fill;
            for (const m of [polymer, floorMat, tagMat, ringMat, grooveMat]) m.envMapIntensity = lighting.env;
            renderer.toneMappingExposure = lighting.exposure;
            paintTag();
            invalidate();
        };

        // ---- 状态 ----
        const target = { lane: 0, row: 0 };
        const camLane = { v: 0, vel: 0 }, camRow = { v: 0, vel: 0 }, shoulder = { v: 0, vel: 0 }, focus = { v: 0, vel: 0 }, lift = { v: 0.4, vel: 0 };
        const pulses = [];
        const hoverLifts = new Map();
        let hovered = null;
        let playing = null;          // { lane, row } 正在播放那张卡（同列轻微跳动）
        let isPlaying = false;
        let idleGain = 0;
        let lastInput = performance.now();
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
            target.lane = lane; target.row = row;
            lift.v = 0;
            lastInput = performance.now();
            idleGain = 0;
            invalidate();
        };
        /* 不带动画直接跳到某格（第一次打开、数据重建） */
        const jump = (lane, row) => {
            target.lane = lane; target.row = row;
            camLane.v = focus.v = lane; camRow.v = shoulder.v = row;
            camLane.vel = camRow.vel = shoulder.vel = focus.vel = 0;
            lift.v = 0.4; lift.vel = 0;
            pulses.length = 0;
            invalidate();
        };

        let lastStep = performance.now();
        /* 推进一帧。返回这帧是否还在动（给外面决定要不要降帧/停画）。 */
        const step = (now) => {
            const dt = Math.min((now - lastStep) / 1000, 0.05);
            lastStep = now;
            const T = now / 1000;
            const reduced = reducedMotion();
            const rate = reduced ? 9 : 3.7;
            damp(camLane, target.lane, rate, dt);
            damp(camRow, target.row, rate, dt);
            damp(shoulder, target.row, rate, dt);
            damp(focus, target.lane, rate, dt);
            damp(lift, 0.4, 26, dt);
            const idleTarget = !reduced && now - lastInput > 2500 ? 1 : 0;
            idleGain += (idleTarget - idleGain) * Math.min(1, dt * 1.2);
            for (let k = pulses.length - 1; k >= 0; k--) if (T - pulses[k].t > 3.3) pulses.splice(k, 1);

            const baseLane = Math.round(camLane.v);
            const baseRow = Math.round(camRow.v);
            let i = 0;
            for (let li = -LANES_HALF; li <= LANES_HALF; li++) {
                for (let ri = -ROWS_BEFORE; ri < ROWS_AFTER; ri++) {
                    const lane = baseLane + li;
                    const row = baseRow + ri;
                    let f = settlingWave(row - shoulder.v) * columnStrength(lane, focus.v);
                    if (idleGain > 0.001) f += idleWave(row, lane, T) * idleGain;
                    if (pulses.length) {
                        let rip = 0;
                        for (const p of pulses) rip += selectionWave(Math.hypot(row - p.row, (lane - p.lane) * 2.2), T - p.t);
                        f += Math.max(-0.6, Math.min(0.6, rip));
                    }
                    if (isPlaying && playing && !reduced && lane === playing.lane) {
                        const dd = Math.abs(row - playing.row);
                        if (dd < 8) f += 0.06 * Math.abs(Math.sin(T * 6.1 + row * 1.3)) * (1 - dd / 8);
                    }
                    const hl = hoverLifts.get(lane + ':' + row) || 0;
                    let y = BASE_Y + f + hl;
                    if (lane === target.lane && row === target.row) y += lift.v;
                    dummy.position.set((lane - camLane.v) * COLUMN_SPACING, y, (row - camRow.v) * ROW_SPACING - 2.17);
                    dummy.updateMatrix();
                    for (const layer of layers) layer.setMatrixAt(i, dummy.matrix);
                    cellAt[i * 2] = lane;
                    cellAt[i * 2 + 1] = row;
                    i++;
                }
            }
            for (const [k, v] of hoverLifts) {
                const goal = hovered === k ? 0.12 : 0;
                const nv = v + (goal - v) * Math.min(1, dt * 10);
                if (Math.abs(nv) < 0.001 && goal === 0) hoverLifts.delete(k); else hoverLifts.set(k, nv);
            }
            if (hovered && !hoverLifts.has(hovered)) hoverLifts.set(hovered, 0.0001);
            for (const layer of layers) layer.instanceMatrix.needsUpdate = true;

            camera.position.copy(aim).addScaledVector(view, DIST);
            if (!reduced) { camera.position.x += pointer.x * 0.12; camera.position.y -= pointer.y * 0.12; }
            camera.lookAt(aim);
            renderer.render(scene, camera);
            dirty = false;

            const settled = Math.abs(camLane.v - target.lane) < 0.001 && Math.abs(camRow.v - target.row) < 0.001
                && Math.abs(lift.v - 0.4) < 0.001 && Math.abs(camLane.vel) + Math.abs(camRow.vel) < 0.001
                && !pulses.length && hoverLifts.size <= (hovered ? 1 : 0);
            return {
                moving: !settled,
                idle: now - lastInput > 8000,
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
        const setPointer = (x, y) => { pointer.x = x; pointer.y = y; if (!reducedMotion()) invalidate(); };
        const setPlaying = (cell, playingNow) => {
            const same = (cell && playing && cell.lane === playing.lane && cell.row === playing.row) || (!cell && !playing);
            if (same && playingNow === isPlaying) return;
            playing = cell; isPlaying = Boolean(playingNow);
            invalidate();
        };
        const touch = () => { lastInput = performance.now(); idleGain = 0; };

        const dispose = () => {
            for (const layer of layers) { layer.geometry.dispose(); layer.dispose?.(); }
            for (const m of [polymer, floorMat, tagMat, ringMat, grooveMat]) m.dispose();
            floor.geometry.dispose();
            tagTex.dispose();
            envTarget.dispose();
            renderer.dispose();
            renderer.forceContextLoss?.();
            canvas.remove();
        };

        return {
            canvas,
            tier,
            resize, setTheme, select, jump, step, pick, setHover, setPointer, setPlaying, touch, dispose,
            get dirty() { return dirty; },
            get target() { return { ...target }; },
            debug: () => ({ pool: POOL, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs?.length || 0 })
        };
    };

    const api = Object.freeze({ create, TIERS, tierOf, POOL, settlingWave, selectionWave });
    global.MusicArchiveScene = api;
})(typeof window !== 'undefined' ? window : globalThis);
