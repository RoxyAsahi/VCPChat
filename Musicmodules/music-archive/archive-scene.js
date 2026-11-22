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
        // 卡身、圆点、浅槽的颜色放在每个实例上（材质本身取白），换主题时可以一张张翻过去
        polymer.color.set('#ffffff'); ringMat.color.set('#ffffff'); grooveMat.color.set('#ffffff');
        const TINTED = [[cards, 'card'], [rings, 'badge'], [grooves, 'groove'], [grooves2, 'groove']];
        const tint = { card: new THREE.Color('#3b4448'), badge: new THREE.Color('#5d676b'), groove: new THREE.Color('#4a5559') };
        const paintUniform = () => {
            for (const [mesh, part] of TINTED) {
                for (let i = 0; i < POOL; i++) mesh.setColorAt(i, tint[part]);
                mesh.instanceColor.needsUpdate = true;
            }
        };
        paintUniform();
        /* 选中卡卡身往强调色偏一点、圆点换成强调色：浏览时一眼能看出选的是哪张（实例下标随镜头变，每帧对一次） */
        const accent = new THREE.Color('#c8a15a');
        let accentIdx = -1;
        let ACCENT_MIX = 0.1, accentMix = -1; const accentTmp = new THREE.Color();

        // ---- 卡面标题：只给相机附近几列看得见的卡贴，贴片池循环复用 ----
        // 每张贴片一块小画布，换卡时只重画这一块；一帧最多重画几块，避免滚动时卡顿。
        // 字色压得比 HUD 淡，免得和浮在上面的说明文字抢
        const LABEL_LANES = tier.shadows ? 1 : 0;          // 省电档只贴当前这一列
        const LABEL_ROWS = [-8, 10];
        const LABEL_POOL = (LABEL_LANES * 2 + 1) * (LABEL_ROWS[1] - LABEL_ROWS[0] + 1);
        const LABEL_DRAWS_PER_FRAME = 8;
        const LABEL_W = 3.5, LABEL_H = 0.26;
        const labelGeo = new THREE.PlaneGeometry(LABEL_W, LABEL_H);
        labelGeo.translate(0.2, 3.5, 0.197);
        const labelInk = { ink: 'rgba(224,227,220,.86)', muted: 'rgba(166,176,177,.8)' };
        const labels = Array.from({ length: LABEL_POOL }, () => {
            const c = document.createElement('canvas');
            c.width = 768; c.height = 58;
            const tex = new THREE.CanvasTexture(c);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
            const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });
            const mesh = new THREE.Mesh(labelGeo, mat);
            mesh.visible = false;
            mesh.receiveShadow = tier.shadows;
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
            projA.set(w.x + 0.2 - LABEL_W / 2, w.y + 3.5, w.z + 0.197).project(camera);
            projB.set(w.x + 0.2 + LABEL_W / 2, w.y + 3.5, w.z + 0.197).project(camera);
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
            // 空白标签：两道细线代替文字（卡上的曲名另有贴片，这里不再印无意义的字）
            g.fillStyle = lighting.tagRing;
            g.fillRect(72, 36, 140, 3);
            g.fillRect(72, 56, 96, 3);
            tagTex.needsUpdate = true;
        };

        /*
         * 主题翻色。整体（背景、雾、地面、灯光）用 0.85 秒缓动过去；卡片按到原点的距离依次翻，
         * 每张 0.58 秒，最远的晚 0.6 秒起步，1.18 秒后全部落定。中途再换一次，每张卡从它当时的颜色接着翻。
         */
        const GLOBAL_DUR = 0.85, CARD_DUR = 0.58, MAX_DELAY = 0.6, WAVE_TOTAL = 1.18;
        const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
        const nowS = () => performance.now() / 1000;
        const lookOf = (colors, l) => ({
            bg: new THREE.Color(colors.paper), floor: new THREE.Color(colors.floor),
            hemiSky: new THREE.Color(l.hemiSky), hemiGround: new THREE.Color(l.hemiGround), sheenColor: new THREE.Color(l.sheenColor),
            hemi: l.hemi, key: l.key, fill: l.fill, exposure: l.exposure, sheen: l.sheen, clearcoat: l.clearcoat, fogNear: l.fogNear, fogFar: l.fogFar
        });
        const COLOR_KEYS = ['bg', 'floor', 'hemiSky', 'hemiGround', 'sheenColor'];
        const NUM_KEYS = ['hemi', 'key', 'fill', 'exposure', 'sheen', 'clearcoat', 'fogNear', 'fogFar'];
        const look = lookOf({ paper: '#11181b', floor: '#192125' }, LIGHTING.dark);
        let lookFade = null;   // { from, to, t0 }
        const fogBase = { near: look.fogNear, far: look.fogFar };
        scene.background = look.bg.clone();
        scene.fog = new THREE.Fog(look.bg.clone(), DIST + look.fogNear, DIST + look.fogFar);
        const applyLook = (L) => {
            scene.background.copy(L.bg);
            scene.fog.color.copy(L.bg);
            fogBase.near = L.fogNear; fogBase.far = L.fogFar;
            scene.fog.near = DIST + L.fogNear; scene.fog.far = DIST + L.fogFar;
            floorMat.color.copy(L.floor);
            polymer.sheen = L.sheen; polymer.sheenColor.copy(L.sheenColor); polymer.clearcoat = L.clearcoat;
            hemi.color.copy(L.hemiSky); hemi.groundColor.copy(L.hemiGround); hemi.intensity = L.hemi;
            key.intensity = L.key; fill.intensity = L.fill;
            renderer.toneMappingExposure = L.exposure;
        };
        const lookAt = (fade, T) => {
            const k = smooth((T - fade.t0) / GLOBAL_DUR);
            const out = {};
            for (const c of COLOR_KEYS) out[c] = fade.from[c].clone().lerp(fade.to[c], k);
            for (const n of NUM_KEYS) out[n] = fade.from[n] + (fade.to[n] - fade.from[n]) * k;
            return out;
        };

        let waves = [];        // { to: {card,badge,groove}, lane, row, t0 }
        let tagPending = 0;    // 卡面小标签在波纹过半时换
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

        /* colors: { paper, card, floor, badge, groove, font }，dark: 是否深色，wave: { lane, row } 翻色原点 */
        const setTheme = (colors, dark, { wave = null } = {}) => {
            lighting = dark ? LIGHTING.dark : LIGHTING.light;
            fontStack = colors.font || fontStack;
            labelInk.ink = colors.labelInk || (dark ? 'rgba(224,227,220,.62)' : 'rgba(8,10,8,.58)');
            labelInk.muted = colors.labelMuted || (dark ? 'rgba(166,176,177,.55)' : 'rgba(98,95,88,.6)');
            labelEpoch++;
            for (const m of [polymer, floorMat, tagMat, ringMat, grooveMat]) m.envMapIntensity = lighting.env;
            const to = lookOf(colors, lighting);
            if (colors.accent) accent.set(colors.accent);
            ACCENT_MIX = dark ? 0.1 : 0.42;
            accentIdx = -1;
            const parts = { card: new THREE.Color(colors.card), badge: new THREE.Color(colors.badge), groove: new THREE.Color(colors.groove) };
            const T = nowS();
            if (!wave || reducedMotion()) {
                lookFade = null; waves = []; tagPending = 0;
                Object.assign(look, to);
                applyLook(look);
                Object.assign(tint, parts);
                paintUniform();
                accentIdx = -1;
                paintTag();
            } else {
                const from = lookFade ? lookAt(lookFade, T) : { ...look };
                lookFade = { from, to, t0: T };
                if (waves.length >= 3) { Object.assign(tint, waves[0].to); waves.shift(); }
                waves.push({ to: parts, lane: wave.lane, row: wave.row, t0: T });
                tagPending = T + 0.3;
            }
            invalidate();
        };
        const stepTheme = (T) => {
            if (lookFade) {
                if (T - lookFade.t0 >= GLOBAL_DUR) { Object.assign(look, lookFade.to); lookFade = null; applyLook(look); }
                else applyLook(lookAt(lookFade, T));
            }
            if (tagPending && T >= tagPending) { tagPending = 0; paintTag(); }
            if (waves.length && T - waves[waves.length - 1].t0 >= WAVE_TOTAL) {
                Object.assign(tint, waves[waves.length - 1].to);
                waves = [];
                paintUniform();
            }
        };

        // ---- 取出卡的卡面：封面与标题随卡片升起淡入 ----
        const COVER_SIZE = 2.9;
        const coverGeo = new THREE.PlaneGeometry(COVER_SIZE, COVER_SIZE);
        coverGeo.translate(0.78, 1.86, CARD_D / 2 + 0.024);
        const frameGeo = new THREE.PlaneGeometry(COVER_SIZE + 0.16, COVER_SIZE + 0.16);
        frameGeo.translate(0.78, 1.86, CARD_D / 2 + 0.021);
        const coverMat = (extra) => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, ...extra });
        const frameMat = coverMat({ color: '#000000' });
        const artMat = coverMat({});
        const captionGeo = new THREE.PlaneGeometry(1.54, 2.32);
        captionGeo.translate(-1.54, 1.36, CARD_D / 2 + 0.025);
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
        coverGroup.add(frameMesh, artMesh, captionMesh);
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
            if (lift.v > 0.5 && !reducedMotion()) returning.set(target.lane + ':' + target.row, { v: lift.v, vel: lift.vel });
            returning.delete(lane + ':' + row);
            target.lane = lane; target.row = row;
            lift.v = 0; lift.vel = 0;
            inspect.v = inspect.vel = inspect.goal = 0;
            lastInput = performance.now();
            idleGain = 0;
            invalidate();
        };
        /* 不带动画直接跳到某格（第一次打开、数据重建） */
        const jump = (lane, row) => {
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
            frameMat.opacity = 0.16 * appear;
            artMat.opacity = appear;
            captionMat.opacity = appear;
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
            else { inspect.goal = Math.max(-1.2, Math.min(1.2, inspect.goal + delta)); inspect.v = inspect.goal; inspect.vel = 0; }
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
            damp(camLane, target.lane, rate, dt);
            damp(camRow, target.row, rate, dt);
            damp(shoulder, target.row, rate, dt);
            damp(focus, target.lane, rate, dt);
            // 取出用慢一点的弹簧（约一秒到位），平时的选中抬起保持干脆
            damp(lift, detailOn ? DETAIL_LIFT : liftGoal, reduced ? 40 : detailOn || lift.v > 1 ? 4.2 : 8, dt);   // 浏览时 8：比镜头（3.7）快一点先探出来，但不再「啪」地弹起
            for (const [k, r] of returning) {
                damp(r, 0, reduced ? 40 : 4.2, dt);
                if (Math.abs(r.v) < 0.002 && Math.abs(r.vel) < 0.01) returning.delete(k);
            }
            {
                // 镜头进度跟着抬起高度走；取出期间换卡（新卡从低处升起）镜头不退回去
                const fromLift = detailOn ? smooth((lift.v - 0.8) / 2.4) : smooth((lift.v - 0.7) / (DETAIL_LIFT - 0.7));
                const goal = detailOn ? Math.max(fromLift, Math.min(detailK, 1)) : fromLift;
                detailK = reduced ? goal : detailK + (goal - detailK) * (1 - Math.exp(-dt * 5));
                if (Math.abs(detailK - goal) < 0.0005) detailK = goal;
                if (!detailOn && detailK < 0.001) detailK = 0;
                damp(inspect, inspect.goal, reduced ? 40 : 7, dt);
            }
            stepTheme(T);
            const tinting = waves.length > 0;
            const tmpC = tinting ? (stepTheme.c || (stepTheme.c = new THREE.Color())) : null;
            // 静止后的缓慢起伏只在播放时才有：暂停时没有东西在动，画面停住，外面的帧循环也就不再排下一帧
            const idleTarget = !reduced && isPlaying && now - lastInput > 2500 ? 1 : 0;
            idleGain += (idleTarget - idleGain) * Math.min(1, dt * (idleTarget ? 1.2 : 3));
            if (!idleTarget && idleGain < 0.002) idleGain = 0;
            for (let k = pulses.length - 1; k >= 0; k--) if (T - pulses[k].t > 3.3) pulses.splice(k, 1);

            const baseLane = Math.round(camLane.v);
            const baseRow = Math.round(camRow.v);
            labelWanted.clear();
            let i = 0, targetIdx = -1;
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
                    const isTarget = lane === target.lane && row === target.row;
                    if (isTarget) y += lift.v;
                    else if (returning.size) { const r = returning.get(lane + ':' + row); if (r) y += r.v; }
                    dummy.position.set((lane - camLane.v) * COLUMN_SPACING, y, (row - camRow.v) * ROW_SPACING - 2.17);
                    dummy.rotation.y = isTarget ? inspect.v : 0;
                    if (isTarget) { targetPos.copy(dummy.position); targetIdx = i; }
                    // 贴标题的范围按选中格算（不按还在飞的相机），当前列就是选中的那一列
                    const dl = lane - target.lane, dr = row - target.row;
                    if (labelFor && dl >= -LABEL_LANES && dl <= LABEL_LANES && dr >= LABEL_ROWS[0] && dr <= LABEL_ROWS[1]) {
                        const info = labelFor(lane, row);
                        if (info) labelWanted.set(lane + ':' + row, { info, li: dl, x: dummy.position.x, y, z: dummy.position.z });
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
                const goal = hovered === k ? 0.24 : 0;   // 悬停的卡稍微探出来一点，能看出鼠标指着哪张
                const nv = v + (goal - v) * Math.min(1, dt * 10);
                if (Math.abs(nv) < 0.001 && goal === 0) hoverLifts.delete(k); else hoverLifts.set(k, nv);
            }
            if (hovered && !hoverLifts.has(hovered)) hoverLifts.set(hovered, 0.0001);
            for (const layer of layers) layer.instanceMatrix.needsUpdate = true;
            if (tinting) for (const [mesh] of TINTED) mesh.instanceColor.needsUpdate = true;
            // 取出详情时卡身回到原色（封面卡不染色），跟着取出进度淡掉
            const mix = ACCENT_MIX * (1 - detailK);
            if (tinting || targetIdx !== accentIdx || Math.abs(mix - accentMix) > 0.002) {
                if (accentIdx >= 0 && accentIdx !== targetIdx && !tinting) { cards.setColorAt(accentIdx, tint.card); rings.setColorAt(accentIdx, tint.badge); }
                if (targetIdx >= 0) {
                    if (tinting) cards.getColorAt(targetIdx, accentTmp); else accentTmp.copy(tint.card);
                    cards.setColorAt(targetIdx, accentTmp.lerp(accent, mix));
                    rings.setColorAt(targetIdx, accent);
                }
                accentIdx = targetIdx;
                accentMix = mix;
                cards.instanceColor.needsUpdate = rings.instanceColor.needsUpdate = true;
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
            renderer.render(scene, camera);
            dirty = false;
            frames++;

            const aimMoving = detailK > 0.001 && targetVisible && cardAim.distanceToSquared(targetPos) > 0.000004;
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
            for (const m of [polymer, floorMat, tagMat, ringMat, grooveMat, frameMat, artMat, captionMat]) m.dispose();
            freeCoverTex(); coverGeo.dispose(); frameGeo.dispose(); captionGeo.dispose(); captionMap.dispose();
            for (const L of labels) { L.tex.dispose(); L.mat.dispose(); }
            labelGeo.dispose();
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
            resize, setTheme, select, jump, step, pick, setHover, setPointer, setPlaying, touch, raise, setLabeler, setLabelMask, refreshLabels, dispose,
            setDetail, setDetailRoom, setCover, turn, detailRect,
            get detail() { return detailOn; },
            get dirty() { return dirty; },
            get target() { return { ...target }; },
            get themeBusy() { return themeBusy(); },
            debug: () => ({ cam: { lane: Math.round(camLane.v * 1000) / 1000, row: Math.round(camRow.v * 1000) / 1000 }, target: { ...target }, frames, dpr: renderer.getPixelRatio(), labels: labels.filter((L) => L.mesh.visible).length, labelLanes: [...new Set(labels.filter((L) => L.mesh.visible).map((L) => Number(L.cell.split(':')[0])))].sort((x, y) => x - y), waves: waves.length, fading: Boolean(lookFade), bg: scene.background.getHexString(), lift: Math.round(lift.v * 100) / 100, detail: Math.round(detailK * 1000) / 1000, returning: returning.size, pool: POOL, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs?.length || 0 })
        };
    };

    const api = Object.freeze({ create, TIERS, IDLE_AFTER, tierOf, POOL, settlingWave, selectionWave });
    global.MusicArchiveScene = api;
})(typeof window !== 'undefined' ? window : globalThis);
