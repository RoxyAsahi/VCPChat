(function (global) {
    'use strict';
    const { clamp, seededRandom } = global.MusicStageRuntime;
    const smooth = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
    // A pole stands between the train and whatever it looks at. Each one goes
    // on the side away from the next roadside screen, so it never crosses a lyric.
    const poleSide = (track, address, fallback = -1) => {
        const encounters = track?.encounters || [];
        let lo = 0, hi = encounters.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (encounters[mid].address - 10 < address) lo = mid + 1;
            else hi = mid;
        }
        const next = encounters[lo];
        return next && next.address - address < 140 ? -next.side : fallback;
    };
    // Whether something `lateral` metres off the track at `address` comes
    // between the train and a lyric screen on that side while the screen is
    // being read. Screens are 16 m wide; the camera reads from startDistance
    // to endDistance.
    const inSight = (track, address, lateral, side, margin = 3) => {
        for (const screen of track?.encounters || []) {
            if (screen.side !== side || Math.abs(screen.address - address) > 160) continue;
            const k = lateral / screen.lateral;
            const first = (address - k * (screen.address + 9)) / (1 - k);
            const last = (address - k * (screen.address - 9)) / (1 - k);
            if (first - margin <= screen.endDistance + 2 && last + margin >= screen.startDistance - 2) return true;
        }
        return false;
    };
    // Anything lower than the sight line to a screen's bottom row is harmless.
    const SIGHT_FLOOR = 2.35;
    const LAMP_GAIN = 2.6;
    const POLE_OFFSET = 3.4, LAMP_OFFSET = 2.55, LAMP_Y = 5.8, CONTACT_Y = 5.72;
    // Scanned surfaces and models sit beside the modes, wherever the page that hosts them lives.
    const ASSETS = (() => {
        const here = global.document?.currentScript?.src;
        return here ? new URL('../assets/', here).href : 'music-stage/assets/';
    })();
    const SIGNAL_RED = '#ff3b2f';
    // Landmarks on the far shore, as bearings round the sky. The line runs towards -z.
    const ISLE = Object.freeze({ bearing: -1.3, reach: 0.2, radius: 520, crest: 34, height: 27, tower: 0.16 });
    const FUJI = Object.freeze({ bearing: -1.08, reach: 0.21, radius: 646, height: 62 });
    const create = (T, scene) => {
        const root = new T.Group();
        scene.add(root);
        const geometries = new Set(), materials = new Set();
        const geometry = g => { geometries.add(g); return g; };
        const material = m => { materials.add(m); return m; };
        const box = geometry(new T.BoxGeometry(1, 1, 1));
        const steel = material(new T.MeshStandardMaterial({ color: '#626b76', metalness: 0.8, roughness: 0.4 }));
        const timber = material(new T.MeshStandardMaterial({ color: '#292d32', roughness: 0.95 }));
        const concrete = material(new T.MeshStandardMaterial({ color: '#444852', roughness: 0.8 }));
        // Whatever gives off light, or is painted, is one mesh with a colour
        // per instance: warm lamps, cold lamps, a crossing's signal lamps, and
        // two paints that are simply a fixed tone.
        const lampMaterial = { color: new T.Color('#ffd994') }, coldLampMaterial = { color: new T.Color('#9fe6d6') };
        const warmPaint = new T.Color('#6b5326'), palePaint = new T.Color('#5d6468');
        const glowMaterial = material(new T.MeshBasicMaterial({ color: '#ffffff' }));
        /*
         * Scanned wood, gravel and rock are used for their light and dark
         * only. They break up a palette colour and roughen how it takes the
         * light; they never bring a hue of their own. Until a scan arrives,
         * and wherever it cannot be read, the plain material stands in.
         */
        let released = false;
        const scans = [];
        const scan = (file, arrived) => {
            const held = { map: { value: null }, ready: { value: 0 } };
            if (T.TextureLoader) new T.TextureLoader().load(ASSETS + file, texture => {
                if (released) { texture.dispose(); return; }
                texture.wrapS = texture.wrapT = T.RepeatWrapping;
                texture.anisotropy = 4;
                scans.push(texture);
                held.map.value = texture;
                held.ready.value = 1;
                arrived?.(texture);
            }, undefined, () => {});
            return held;
        };
        const planks = scan('planks.webp'), gravel = scan('ballast.webp');
        // Boards are laid along the longer side of whatever they clad, an
        // edge of the piece falling on a gap between two boards.
        const grained = bed => {
            const wood = material(new T.MeshStandardMaterial({ color: '#292d32', roughness: 0.95 }));
            if (bed) wood.defines = { TRACK_BED: '' };
            wood.onBeforeCompile = shader => {
                Object.assign(shader.uniforms, { planks: planks.map, planked: planks.ready,
                    gravel: gravel.map, gravelled: gravel.ready, stone: { value: concrete.color } });
                shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
                    attribute float bed;
                    varying vec3 vGrainAt, vGrainSize, vGrainFace, vGrainWorld;
                    varying float vBed, vGrainSeed;`).replace('#include <begin_vertex>', `#include <begin_vertex>
                    #ifdef USE_INSTANCING
                        mat4 grainMatrix = modelMatrix * instanceMatrix;
                        vGrainSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz),
                            length(instanceMatrix[2].xyz));
                        vGrainSeed = fract(sin(mod(float(gl_InstanceID), 289.0) * 12.9898) * 43758.5453);
                    #else
                        mat4 grainMatrix = modelMatrix;
                        vGrainSize = vec3(1.0);
                        vGrainSeed = 0.0;
                    #endif
                    vGrainAt = position * vGrainSize;
                    vGrainFace = normal;
                    vGrainWorld = (grainMatrix * vec4(position, 1.0)).xyz;
                    vBed = bed;`);
                shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
                    uniform sampler2D planks, gravel;
                    uniform float planked, gravelled;
                    uniform vec3 stone;
                    varying vec3 vGrainAt, vGrainSize, vGrainFace, vGrainWorld;
                    varying float vBed, vGrainSeed;
                    float grainRelief = 0.0, grainDepth = 0.0;`).replace('#include <color_fragment>', `#include <color_fragment>
                    #ifdef TRACK_BED
                    if (vBed > 0.5) {
                        float pebbles = texture2D(gravel, vGrainWorld.xz * 0.5).r;
                        diffuseColor.rgb = stone * mix(0.8, 0.4 + 1.45 * pebbles, gravelled);
                        grainRelief = pebbles * gravelled;
                        grainDepth = 0.018;
                    } else {
                        vec2 board = vec2(0.0586 + floor(vGrainSeed * 9.0) / 9.0 + (vGrainAt.z * 0.94 + 0.12) / 2.16,
                            vGrainAt.x / 2.16 + vGrainSeed);
                    #else
                    {
                        vec3 face = abs(vGrainFace);
                        vec2 at = face.x > face.y && face.x > face.z ? vGrainAt.zy
                            : face.y > face.z ? vGrainAt.xz : vGrainAt.xy;
                        vec2 extent = face.x > face.y && face.x > face.z ? vGrainSize.zy
                            : face.y > face.z ? vGrainSize.xz : vGrainSize.xy;
                        if (extent.y > extent.x) { at = at.yx; extent = extent.yx; }
                        vec2 board = vec2(0.0586 + floor(vGrainSeed * 9.0) / 9.0 + (at.y + extent.y * 0.5) / 1.62,
                            at.x / 1.62 + vGrainSeed);
                    #endif
                        float wood = texture2D(planks, board).r;
                        diffuseColor.rgb *= mix(1.0, min(0.2 + 2.3 * wood, 2.1), planked);
                        grainRelief = wood * planked;
                        grainDepth = 0.008;
                    }`).replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
                    {
                        // Relief from the scan's own light and dark, by screen-space derivatives.
                        vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
                        vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
                        float det = dot(dpdx, r1);
                        normal = normalize(abs(det) * normal - sign(det) * grainDepth
                            * (dFdx(grainRelief) * r1 + dFdy(grainRelief) * r2));
                    }`);
            };
            wood.customProgramCacheKey = () => (bed ? 'grained-bed' : 'grained');
            return wood;
        };
        const wood = grained(false), permanentWay = grained(true);
        // Shore rocks: a scanned pile, lit as stone in the palette's colour.
        const rockMaterial = material(new T.MeshStandardMaterial({ color: '#444852', roughness: 0.92 }));
        scan('coast-rock.webp', texture => {
            texture.flipY = false;
            rockMaterial.map = rockMaterial.bumpMap = texture;
            rockMaterial.bumpScale = 0.4;
            rockMaterial.needsUpdate = true;
        });
        // Several boxes fused into one shape, so a profile still costs one instance.
        const fused = parts => {
            const positions = [], normals = [], indices = [];
            for (const [sx, sy, sz, x, y, z] of parts) {
                const part = new T.BoxGeometry(sx, sy, sz).translate(x, y, z);
                const base = positions.length / 3;
                positions.push(...part.attributes.position.array);
                normals.push(...part.attributes.normal.array);
                for (const index of part.index.array) indices.push(index + base);
                part.dispose();
            }
            const shape = new T.BufferGeometry();
            shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            shape.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
            shape.setIndex(indices);
            return geometry(shape);
        };
        const instances = (mat, count, shape = box) => {
            const mesh = new T.InstancedMesh(shape, mat, count);
            mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
            mesh.frustumCulled = false;
            mesh.count = 0;
            root.add(mesh);
            return mesh;
        };
        // Flat-bottom rail: head, web and foot. Sleepers carry their tie plates.
        // A rail is rust everywhere but the band its wheels run on: only that
        // narrow strip along the crown is polished, and only it catches the lamps.
        const railMaterial = material(new T.MeshStandardMaterial({ color: '#626b76', metalness: 0.8, roughness: 0.4 }));
        railMaterial.onBeforeCompile = shader => {
            shader.vertexShader = shader.vertexShader.replace('#include <common>',
                '#include <common>\nvarying vec3 vRail;').replace('#include <begin_vertex>',
                '#include <begin_vertex>\nvRail = vec3(position.xy, normal.y);');
            shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
                varying vec3 vRail;
                float railCrown() {
                    return step(0.5, vRail.z) * step(0.07, vRail.y) * smoothstep(0.03, 0.021, abs(vRail.x));
                }`).replace('#include <color_fragment>', `#include <color_fragment>
                diffuseColor.rgb *= mix(0.34, 0.8, railCrown());`).replace('#include <roughnessmap_fragment>',
                `#include <roughnessmap_fragment>
                roughnessFactor = mix(0.92, 0.36, railCrown());`).replace('#include <metalnessmap_fragment>',
                `#include <metalnessmap_fragment>
                metalnessFactor = mix(0.3, 0.9, railCrown());`);
        };
        const rails = instances(railMaterial, 320, fused([
            [0.07, 0.05, 1, 0, 0.055, 0], [0.024, 0.09, 1, 0, 0, 0], [0.15, 0.024, 1, 0, -0.055, 0]]));
        // Each sleeper brings its own length of ballast: a crowned bed the
        // timbers sit in, its shoulders falling away into the shallows.
        const sleepers = instances(permanentWay, 400, (() => {
            const shape = fused([
                [2.4, 0.16, 0.24, 0, 0, 0], [0.34, 0.03, 0.2, -0.7175, 0.09, 0], [0.34, 0.03, 0.2, 0.7175, 0.09, 0],
                // Fastenings: a clip and its bolt head each side of each rail's foot.
                ...[-0.7175, 0.7175].flatMap(rail => [-0.115, 0.115].flatMap(clip => [
                    [0.05, 0.035, 0.11, rail + clip, 0.12, 0], [0.03, 0.03, 0.03, rail + clip * 1.12, 0.15, 0]]))]);
            const position = Array.from(shape.attributes.position.array);
            const normal = Array.from(shape.attributes.normal.array);
            const index = Array.from(shape.index.array);
            const bed = new Array(position.length / 3).fill(0);
            const profile = [[-2.3, -0.3], [-1.5, 0.03], [1.5, 0.03], [2.3, -0.3]], half = 0.39;
            for (let i = 0; i < 3; i++) {
                const [x0, y0] = profile[i], [x1, y1] = profile[i + 1];
                const length = Math.hypot(x1 - x0, y1 - y0), base = position.length / 3;
                position.push(x0, y0, -half, x1, y1, -half, x0, y0, half, x1, y1, half);
                for (let corner = 0; corner < 4; corner++) {
                    normal.push(-(y1 - y0) / length, (x1 - x0) / length, 0);
                    bed.push(1);
                }
                index.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
            }
            shape.setAttribute('position', new T.Float32BufferAttribute(position, 3));
            shape.setAttribute('normal', new T.Float32BufferAttribute(normal, 3));
            shape.setAttribute('bed', new T.Float32BufferAttribute(bed, 1));
            shape.setIndex(index);
            return shape;
        })());
        // Tapered octagonal column: catenary masts, lamp posts, signals.
        const masts = instances(steel, 72, geometry(new T.CylinderGeometry(0.065, 0.115, 1, 8)));
        // Everything else is drawn from one pool per material, whatever it
        // depicts, so richer scenery does not cost more draw calls.
        const steelParts = instances(steel, 960);
        const concreteParts = instances(concrete, 400);
        const timberParts = instances(wood, 240);
        const GLOW_CAPACITY = 288;
        const glow = instances(glowMaterial, GLOW_CAPACITY);
        const glowKinds = new Uint8Array(GLOW_CAPACITY);
        glow.setColorAt(0, lampMaterial.color);
        // Each kind writes into the shared mesh and remembers which colour it takes.
        const tinted = kind => ({
            instanceMatrix: glow.instanceMatrix,
            get count() { return glow.count; },
            set count(value) { glow.count = value; },
            setMatrixAt(index, matrix) { glowKinds[index] = kind; glow.setMatrixAt(index, matrix); }
        });
        const glowParts = tinted(0), coldGlowParts = tinted(1);
        // The pair of lamps at a level crossing, flashing in turn.
        const signalLamps = tinted(2);
        const warmMarks = tinted(3), paleMarks = tinted(4);
        // A lit room seen through its window: the lamp colour, well short of the lamp itself.
        const windowLight = tinted(5), roomGlow = new T.Color();
        // A ceiling with lamps under it: far dimmer than a lamp, and one even tone.
        const litSurface = tinted(6), ceilingGlow = new T.Color();
        const sceneryPools = [masts, steelParts, concreteParts, timberParts, glow];
        Object.entries({ rails, sleepers, masts, steelParts, concreteParts, timberParts, glow })
            .forEach(([name, mesh]) => { mesh.name = name; });
        // The rock pile is a data script of its own, fetched once the stage is up.
        let rocks = null, rocksArrived = false;
        const raiseRocks = () => {
            const data = global.MusicStageAssets?.coastRock;
            if (!data || released || rocks) return;
            const bytes = text => Uint8Array.from(global.atob(text), c => c.charCodeAt(0));
            const quantised = new Uint16Array(bytes(data.position).buffer);
            const position = new Float32Array(quantised.length);
            for (let i = 0; i < quantised.length; i++)
                position[i] = quantised[i] / 65535 * data.size[i % 3] + data.origin[i % 3];
            const shape = geometry(new T.BufferGeometry());
            shape.setAttribute('position', new T.BufferAttribute(position, 3));
            shape.setAttribute('normal', new T.BufferAttribute(new Int8Array(bytes(data.normal).buffer), 3, true));
            shape.setAttribute('uv', new T.BufferAttribute(new Uint16Array(bytes(data.uv).buffer), 2, true));
            shape.setIndex(new T.BufferAttribute(new Uint16Array(bytes(data.index).buffer), 1));
            rocks = instances(rockMaterial, 40, shape);
            rocks.name = 'rocks';
            sceneryPools.push(rocks);
            rocksArrived = true;
        };
        if (T.TextureLoader && global.document?.createElement) {
            if (global.MusicStageAssets?.coastRock) raiseRocks();
            else {
                const tag = global.document.createElement('script');
                tag.src = ASSETS + 'coast-rock.js';
                tag.onload = raiseRocks;
                global.document.head?.appendChild(tag);
            }
        }
        let stationTypes = [];
        const wirePositions = new Float32Array(40 * 20 * 6);
        const wireGeometry = geometry(new T.BufferGeometry());
        wireGeometry.setAttribute('position', new T.BufferAttribute(wirePositions, 3).setUsage(T.DynamicDrawUsage));
        const wireMaterial = material(new T.LineBasicMaterial({ color: '#60717d', transparent: true,
            opacity: 0.42, depthWrite: false }));
        const wires = new T.LineSegments(wireGeometry, wireMaterial);
        wires.frustumCulled = false;
        root.add(wires);
        const ridgePositions = [];
        for (let i = 0; i < 192; i++) {
            const a = i / 192 * Math.PI * 2, b = (i + 1) / 192 * Math.PI * 2;
            const elevation = angle => 4 + 9 * Math.pow(0.5 + 0.5 * Math.sin(angle * 7 + 1), 3)
                + 3 * Math.sin(angle * 19);
            const ax = Math.cos(a) * 650, az = Math.sin(a) * 650;
            const bx = Math.cos(b) * 650, bz = Math.sin(b) * 650;
            ridgePositions.push(ax, -2, az, bx, -2, bz, ax, elevation(a), az,
                bx, -2, bz, bx, elevation(b), bz, ax, elevation(a), az);
        }
        /*
         * The far shore is the Shonan coast. Off it lies Enoshima: a wooded
         * table of an island, its lighthouse tower standing on top, joined to
         * the land by a long bridge. Beyond and to the right, Mount Fuji. They
         * are part of the same silhouette as the ridge, a tone apart: the
         * island nearer and darker, the mountain hazed and capped with snow.
         */
        const ridgeTones = new Array(ridgePositions.length / 3).fill(1);
        const facet = (a0, a1, radius, low0, high0, low1, high1, tone) => {
            const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius;
            const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
            ridgePositions.push(x0, low0, z0, x1, low1, z1, x0, high0, z0, x1, low1, z1, x1, high1, z1, x0, high0, z0);
            for (let i = 0; i < 6; i++) ridgeTones.push(tone);
        };
        const isleCrest = u => ISLE.crest * Math.pow(Math.max(0, 1 - u * u), 0.55) * (0.86 + 0.14 * Math.cos(u * 2.2 - 0.5))
            + (Math.abs(u) < 0.97 ? 1.6 * Math.sin(u * 23) + 1.1 * Math.sin(u * 51 + 1) : 0);
        for (let i = 0; i < 56; i++) {
            const u0 = i / 28 - 1, u1 = (i + 1) / 28 - 1;
            facet(ISLE.bearing + u0 * ISLE.reach, ISLE.bearing + u1 * ISLE.reach, ISLE.radius,
                -2, Math.max(-2, isleCrest(u0)), -2, Math.max(-2, isleCrest(u1)), 0.72);
        }
        // The tower: a stem that opens out to the deck near its top, a lantern, a mast.
        const towerAt = ISLE.bearing + ISLE.tower * ISLE.reach, towerFoot = isleCrest(ISLE.tower) - 1;
        [[0, 0.8, 0.62, 1.1], [0.62, 1.1, 0.76, 2.7], [0.76, 2.7, 0.8, 2.7], [0.8, 1.7, 0.88, 1.3], [0.88, 0.22, 1, 0.14]]
            .forEach(([from, wide0, to, wide1]) => {
                const y0 = towerFoot + from * ISLE.height, y1 = towerFoot + to * ISLE.height;
                const split = (w0, w1) => {
                    const x0 = Math.cos(towerAt - w0 / ISLE.radius) * ISLE.radius, z0 = Math.sin(towerAt - w0 / ISLE.radius) * ISLE.radius;
                    const x1 = Math.cos(towerAt + w0 / ISLE.radius) * ISLE.radius, z1 = Math.sin(towerAt + w0 / ISLE.radius) * ISLE.radius;
                    const x2 = Math.cos(towerAt - w1 / ISLE.radius) * ISLE.radius, z2 = Math.sin(towerAt - w1 / ISLE.radius) * ISLE.radius;
                    const x3 = Math.cos(towerAt + w1 / ISLE.radius) * ISLE.radius, z3 = Math.sin(towerAt + w1 / ISLE.radius) * ISLE.radius;
                    ridgePositions.push(x0, y0, z0, x1, y0, z1, x2, y1, z2, x1, y0, z1, x3, y1, z3, x2, y1, z2);
                    for (let i = 0; i < 6; i++) ridgeTones.push(0.72);
                };
                split(wide0, wide1);
            });
        const fujiCrest = u => {
            const flank = Math.pow(Math.max(0, 1 - Math.abs(u)), 1.75);
            return FUJI.height * Math.min(flank, 0.93 + 0.02 * Math.sin(u * 90)) / 0.93;
        };
        const snowLine = u => FUJI.height * (0.62 + 0.05 * Math.sin(u * 37) + 0.03 * Math.sin(u * 83));
        for (let i = 0; i < 64; i++) {
            const u0 = i / 32 - 1, u1 = (i + 1) / 32 - 1;
            const a0 = FUJI.bearing + u0 * FUJI.reach, a1 = FUJI.bearing + u1 * FUJI.reach;
            const h0 = fujiCrest(u0), h1 = fujiCrest(u1), s0 = Math.min(h0, snowLine(u0)), s1 = Math.min(h1, snowLine(u1));
            facet(a0, a1, FUJI.radius, -2, s0, -2, s1, 1.22);
            if (h0 > s0 || h1 > s1) facet(a0, a1, FUJI.radius, s0, h0, s1, h1, 2.3);
        }
        const ridgeGeometry = geometry(new T.BufferGeometry());
        ridgeGeometry.setAttribute('position', new T.Float32BufferAttribute(ridgePositions, 3));
        ridgeGeometry.setAttribute('color', new T.Float32BufferAttribute(ridgeTones.flatMap(tone => [tone, tone, tone]), 3));
        const ridgeMaterial = material(new T.MeshBasicMaterial({ color: '#1c2935', side: T.DoubleSide, fog: false,
            vertexColors: true }));
        const ridge = new T.Mesh(ridgeGeometry, ridgeMaterial);
        root.add(ridge);
        const dummy = new T.Object3D();
        const scratch = new T.Color(), white = new T.Color('#ffffff');
        // Local axes: x across the track, y up, z along it. Roll leans a part
        // across the track, pitch tips it along the track.
        const place = (mesh, index, track, s, lateral, y, sx, sy, sz, roll = 0, pitch = 0) => {
            const f = track.at(s);
            dummy.position.set(f.position.x + f.right.x * lateral, y, f.position.z + f.right.z * lateral);
            dummy.rotation.set(pitch, -f.yaw, roll, 'YXZ');
            dummy.scale.set(sx, sy, sz);
            dummy.updateMatrix();
            mesh.setMatrixAt(index, dummy.matrix);
        };
        const hemisphere = new T.HemisphereLight('#819ab6', '#14191e', 0.65);
        const moonLight = new T.DirectionalLight('#b1cee9', 1.5);
        moonLight.position.set(-70, 100, -140);
        root.add(hemisphere, moonLight);
        const lights = Array.from({ length: 2 }, () => {
            const light = new T.PointLight('#ffd28c', 22, 22, 2);
            root.add(light);
            return light;
        });
        const headlight = new T.PointLight('#ffe9c4', 0, 16, 2);
        root.add(headlight);
        /*
         * The train is drawn after the Enoshima Electric Railway's 300 series:
         * short two-car articulated sets in a two-tone livery, a folded front
         * of three panes with a lamp on the roof, deep sash windows, one
         * lozenge pantograph to a set. From the cab it is all around the camera
         * and unseen; when the camera rises and swings out it is the subject of
         * the picture: two sets coupled, lit from inside, running over the water.
         */
        const CAR = Object.freeze({ length: 12.6, half: 1.3, sill: 1.22, floor: 1.36, waist: 2.16, cant: 3.2,
            crown: 3.85, bogie: 3.9, joint: 0.5, coupling: 0.9 });
        const CARS = 4, TIP = -CAR.length / 2;
        const SET_PITCH = CAR.length * 2 + CAR.joint + CAR.coupling;
        // The folded front in plan: distance behind the nose, half width, share of the roof's rise.
        const NOSE = [[0, 0.5, 0.5], [0.22, 1.18, 0.8], [0.4, 1.275, 0.94], [0.7, CAR.half, 1]];
        // Openings along a side, measured from the middle of the car towards its inner end.
        const DOORS = [-4.3, 3.55], WINDOWS = [-2.95, -1.7, -0.45, 0.8, 2.05, 4.95], WINDOW_PITCH = 1.25;
        // Shapes gathered into one geometry, each vertex remembering which paint it takes.
        const fuser = () => {
            const positions = [], normals = [], groups = [], indices = [];
            const add = (shape, group = 0) => {
                const flat = shape.index ? shape.toNonIndexed() : shape;
                const base = positions.length / 3;
                positions.push(...flat.attributes.position.array);
                normals.push(...flat.attributes.normal.array);
                for (let i = 0; i < flat.attributes.position.count; i++) { groups.push(group); indices.push(base + i); }
                if (flat !== shape) flat.dispose();
                shape.dispose();
            };
            const boxAt = (sx, sy, sz, x, y, z, group) => add(new T.BoxGeometry(sx, sy, sz).translate(x, y, z), group);
            const forward = new T.Vector3(0, 0, 1), along = new T.Vector3(), turn = new T.Quaternion();
            // A square bar from one point to another.
            const beam = (ax, ay, az, bx, by, bz, thickness, group) => {
                along.set(bx - ax, by - ay, bz - az);
                const bar = new T.BoxGeometry(thickness, thickness, along.length());
                bar.applyQuaternion(turn.setFromUnitVectors(forward, along.normalize()));
                add(bar.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), group);
            };
            // A sheet through rows of points, smooth along and across.
            const sheet = (rows, group) => {
                const points = [], index = [], n = rows[0].length;
                rows.forEach(row => row.forEach(point => points.push(...point)));
                for (let r = 0; r < rows.length - 1; r++) for (let i = 0; i < n - 1; i++) {
                    const a = r * n + i;
                    index.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
                }
                const shape = new T.BufferGeometry();
                shape.setAttribute('position', new T.Float32BufferAttribute(points, 3));
                shape.setIndex(index);
                shape.computeVertexNormals();
                add(shape, group);
            };
            // A bogie: side frames with their axle boxes, the bolster, two wheelsets.
            const bogie = (z, group) => {
                for (const side of [-1, 1]) {
                    boxAt(0.1, 0.2, 2.5, side * 0.87, 0.8, z, group);
                    boxAt(0.16, 0.28, 0.52, side * 0.91, 0.9, z, group);
                    for (const axle of [-0.95, 0.95]) {
                        add(new T.CylinderGeometry(0.4, 0.4, 0.12, 14).rotateZ(Math.PI / 2)
                            .translate(side * 0.7175, 0.79, z + axle), group);
                        boxAt(0.14, 0.2, 0.26, side * 0.91, 0.79, z + axle, group);
                    }
                }
                boxAt(1.72, 0.16, 0.38, 0, 0.92, z, group);
                for (const axle of [-0.95, 0.95]) {
                    add(new T.CylinderGeometry(0.07, 0.07, 1.44, 8).rotateZ(Math.PI / 2).translate(0, 0.79, z + axle), group);
                }
            };
            const finish = () => {
                const shape = new T.BufferGeometry();
                shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
                shape.setAttribute('normal', new T.Float32BufferAttribute(normals, 3));
                shape.setAttribute('color', new T.Float32BufferAttribute(new Float32Array(positions.length).fill(1), 3));
                shape.setIndex(indices);
                shape.userData.groups = groups;
                return geometry(shape);
            };
            return { add, boxAt, beam, sheet, bogie, finish };
        };
        // Paint groups: 0 upper body, 1 lower body, 2 running gear and trim, 3 roof.
        const carGeometry = (() => {
            const { add, boxAt, beam, sheet, bogie, finish } = fuser();
            // The cross-section, anticlockwise seen from behind. The upper body
            // turns into the roof without a gutter, as on the real cars.
            const corner = Array.from({ length: 7 }, (_, i) => {
                const a = i / 6 * 65 * Math.PI / 180;
                return [CAR.half - 0.42 + Math.cos(a) * 0.42, CAR.cant + Math.sin(a) * 0.4];
            });
            const [edgeX, edgeY] = corner.at(-1);
            const roof = Array.from({ length: 13 }, (_, i) => {
                const x = edgeX * (1 - i / 6);
                return [x, edgeY + (CAR.crown - edgeY) * (1 - (x / edgeX) ** 2)];
            });
            const mirror = points => points.map(([x, y]) => [-x, y]).reverse();
            const lower = [[CAR.half, CAR.sill], [CAR.half, CAR.waist]];
            const upper = [[CAR.half, CAR.waist], ...corner];
            const section = [[lower, 1], [upper, 0], [roof, 3], [mirror(upper), 0], [mirror(lower), 1],
                [[[-CAR.half, CAR.sill], [CAR.half, CAR.sill]], 2]];
            const stations = [...NOSE.map(([back, wide, rise]) => [TIP + back, wide / CAR.half, rise]), [CAR.length / 2, 1, 1]];
            const at = ([x, y], [z, wide, rise]) => [x * wide, y > CAR.cant ? CAR.cant + (y - CAR.cant) * rise : y, z];
            // Each span of the nose is its own sheet, so the folds stay crisp.
            for (let s = 0; s < stations.length - 1; s++) {
                for (const [points, group] of section) {
                    // Over the cab the body colour is carried up across the roof.
                    sheet([points.map(point => at(point, stations[s])), points.map(point => at(point, stations[s + 1]))],
                        group === 3 && s < NOSE.length - 1 ? 0 : group);
                }
            }
            // The two ends, closed in bands from one side across to the other.
            const half = roof.slice(0, 7);
            const cap = (station, front, groups) => [[lower, groups[0]], [upper, groups[1]], [half, groups[1]]].forEach(([points, group]) => {
                const right = points.map(point => at(point, station)), left = right.map(([x, y, z]) => [-x, y, z]);
                sheet(front ? [left, right] : [right, left], group);
            });
            cap(stations[0], true, [1, 0]);
            cap(stations.at(-1), false, [2, 2]);
            for (const side of [-1, 1]) {
                const x = side * (CAR.half + 0.008);
                for (const z of DOORS) {
                    // Door frame, the drip strip over it, and the step.
                    for (const edge of [-0.54, 0.54]) boxAt(0.03, 1.84, 0.045, x, 2.25, z + edge, 2);
                    boxAt(0.04, 0.045, 1.14, x, 3.17, z, 2);
                    boxAt(0.1, 0.05, 1.04, side * (CAR.half + 0.03), CAR.sill + 0.05, z, 2);
                    // The leaf's lower panel sits a little proud, with a kick plate.
                    boxAt(0.016, 0.62, 0.9, x, 1.72, z, 1);
                    boxAt(0.02, 0.1, 0.9, x, CAR.floor + 0.07, z, 2);
                }
                // Moulding along the waist between the doors, and the side sill.
                [[-5.55, -4.9], [-3.7, 2.95], [4.15, 6.2]].forEach(([from, to]) =>
                    boxAt(0.024, 0.04, to - from, x, CAR.waist, (from + to) / 2, 0));
                boxAt(0.03, 0.07, CAR.length - 1.1, x, CAR.sill + 0.02, 0.5, 2);
                // Hung under the floor: resistors, control gear, a reservoir.
                boxAt(0.6, 0.42, 1.9, side * 0.8, 0.84, 0.2, 2);
                boxAt(0.6, 0.34, 1.15, side * 0.8, 0.88, 2.2 + side * 0.25, 2);
                boxAt(0.5, 0.3, 0.85, side * 0.82, 0.9, 4.3, 2);
            }
            for (let rib = 0; rib < 7; rib++) boxAt(0.03, 0.34, 0.05, 1.115, 0.84, -0.55 + rib * 0.25, 3);
            add(new T.CylinderGeometry(0.17, 0.17, 1.5, 10).rotateX(Math.PI / 2).translate(-0.3, 0.88, -1.6), 2);
            boxAt(2.1, 0.2, CAR.length - 1.4, 0, CAR.sill - 0.08, 0.5, 2);
            bogie(-CAR.bogie, 2);
            // Cab end: buffer beam, coupler, lifeguard, and the lamp housing on the roof.
            boxAt(1.02, 0.15, 0.08, 0, CAR.sill + 0.04, TIP - 0.035, 2);
            boxAt(0.2, 0.18, 0.62, 0, 0.98, TIP - 0.1, 2);
            boxAt(0.3, 0.3, 0.16, 0, 0.98, TIP - 0.46, 2);
            boxAt(1.8, 0.07, 0.07, 0, 0.6, TIP + 0.3, 2);
            for (const side of [-1, 1]) beam(side * 0.6, 0.6, TIP + 0.3, side * 0.6, CAR.sill, TIP + 0.8, 0.06, 2);
            add(new T.CylinderGeometry(0.17, 0.2, 0.46, 16).rotateX(Math.PI / 2).translate(0, 3.63, TIP + 0.32), 0);
            // Roof: a cooler with its grille, two ventilators.
            boxAt(1.56, 0.1, 2.6, 0, 3.86, 1.0, 3);
            boxAt(1.4, 0.16, 2.44, 0, 3.97, 1.0, 3);
            for (let slat = 0; slat < 9; slat++) boxAt(1.1, 0.03, 0.09, 0, 4.06, 0.12 + slat * 0.22, 2);
            for (const z of [-3.5, -1.6]) {
                boxAt(0.5, 0.07, 0.86, 0, 3.87, z, 3);
                boxAt(0.36, 0.09, 0.7, 0, 3.94, z, 3);
            }
            // Boards to walk on beside where the pantograph stands.
            for (const side of [-1, 1]) boxAt(0.26, 0.03, 2.0, side * 0.74, 3.74, 3.9, 2);
            return finish();
        })();
        const carMaterial = material(new T.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.5 }));
        const cars = instances(carMaterial, CARS, carGeometry);
        cars.name = 'trainCars';
        // What a set has once: the bellows and shared bogie at its joint, and
        // the pantograph on the leading car's roof. Its nose points along -z.
        const kitGeometry = (() => {
            const { boxAt, beam, bogie, finish } = fuser();
            boxAt(1.86, 2.0, CAR.joint + 0.06, 0, 2.33, 0);
            for (const fold of [-0.16, 0, 0.16]) boxAt(1.96, 2.1, 0.035, 0, 2.33, fold);
            bogie(0);
            const centre = -2.6, base = CAR.crown + 0.13, knee = 4.84, top = CONTACT_Y - 0.03;
            for (const side of [-1, 1]) {
                const x = side * 0.42;
                boxAt(0.07, 0.06, 1.6, x, base, centre);
                for (const end of [-1, 1]) {
                    boxAt(0.1, 0.16, 0.1, x, base - 0.1, centre + end * 0.62);
                    beam(x, base, centre - end * 0.14, x * 0.9, knee, centre + end * 0.92, 0.05);
                    beam(x * 0.9, knee, centre + end * 0.92, x * 0.72, top, centre + end * 0.17, 0.04);
                }
            }
            for (const end of [-1, 1]) {
                boxAt(0.8, 0.045, 0.045, 0, knee, centre + end * 0.92);
                boxAt(1.2, 0.035, 0.07, 0, top, centre + end * 0.17);
                for (const side of [-1, 1]) {
                    beam(side * 0.6, top, centre + end * 0.17, side * 0.8, top - 0.17, centre + end * 0.17, 0.035);
                }
            }
            boxAt(0.05, 0.04, 0.34, 0, top - 0.03, centre);
            return finish();
        })();
        const kits = instances(timber, CARS / 2, kitGeometry);
        kits.name = 'trainKit';
        // Too dark to show in the water; layer 1 is drawn for the viewer only.
        kits.layers.set(1);
        // A window is one quad just proud of the shell. What shows in it is
        // worked out per pixel by following the line of sight into the saloon.
        const glassGeometry = (() => {
            const positions = [], uvs = [], panes = [], indices = [];
            const pane = (side, z, y, w, h, seed, kind) => {
                const base = positions.length / 3, x = side * (CAR.half + 0.012);
                // Wound so the pane faces outwards on either side.
                const z0 = z + side * w / 2, z1 = z - side * w / 2;
                positions.push(x, y - h / 2, z0, x, y - h / 2, z1, x, y + h / 2, z1, x, y + h / 2, z0);
                uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
                for (let i = 0; i < 4; i++) panes.push(seed, w, h, kind);
                indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            };
            for (const side of [-1, 1]) {
                WINDOWS.forEach((z, i) => pane(side, z, 2.63, 1.02, 0.86, i * 7 + (side > 0 ? 3 : 61), 0));
                DOORS.forEach((z, i) => pane(side, z, 2.6, 0.62, 0.86, 131 + i * 9 + side, 1));
                pane(side, -5.2, 2.66, 0.5, 0.74, 211 + side, 2);
            }
            const shape = new T.BufferGeometry();
            shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            shape.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
            shape.setAttribute('pane', new T.Float32BufferAttribute(panes, 4));
            shape.setIndex(indices);
            return geometry(shape);
        })();
        const glassMaterial = material(new T.ShaderMaterial({
            uniforms: { warm: { value: new T.Color('#ffd28c') }, seat: { value: new T.Color('#1d4a40') },
                night: { value: new T.Color('#05080f') }, power: { value: 1.3 } },
            vertexShader: `attribute vec4 pane;varying vec2 vUv;varying vec4 vPane;varying vec3 vPos,vEye;varying float car;
                void main(){vUv=uv;vPane=pane;vPos=position;
                    #ifdef USE_INSTANCING
                    mat4 m=modelMatrix*instanceMatrix;car=float(gl_InstanceID);
                    #else
                    mat4 m=modelMatrix;car=0.0;
                    #endif
                    vEye=(inverse(m)*vec4(cameraPosition,1.0)).xyz;
                    gl_Position=projectionMatrix*viewMatrix*m*vec4(position,1.0);
                }`,
            fragmentShader: `uniform vec3 warm,seat,night;uniform float power;
                varying vec2 vUv;varying vec4 vPane;varying vec3 vPos,vEye;varying float car;
                const float WIDE=1.24,FLOOR=${CAR.floor.toFixed(2)},CEIL=3.34,END=${(CAR.length / 2 - 0.12).toFixed(2)};
                float h(float n){return fract(sin(mod(n,289.0)*12.9898)*43758.5453);}
                // Head and shoulders, the neck at the origin.
                float figure(vec2 p){
                    return min(length(p-vec2(0.0,0.19))-0.11,length(max(abs(p+vec2(0.0,0.3))-vec2(0.13,0.3),0.0))-0.09);
                }
                // Whoever is in a row of places along the car, as coverage.
                float row(vec3 p,float pitch,float neck,float share,float salt){
                    float place=floor(p.z/pitch);
                    float who=place*1.7+floor(car+0.5)*37.0+salt;
                    float taken=step(1.0-share,h(who));
                    vec2 q=vec2((fract(p.z/pitch)-0.5)*pitch+(h(who+0.3)-0.5)*0.1,p.y-neck-(h(who+0.7)-0.5)*0.12);
                    return taken*smoothstep(0.012,-0.012,figure(q));
                }
                void main(){
                    float side=sign(vPos.x);
                    vec3 rd=normalize(vPos-vEye);
                    float inward=max(-rd.x*side,0.03);
                    rd.x=-side*inward;
                    // Follow the sight line to the far wall, the ceiling, the floor or a bulkhead.
                    float tWall=(abs(vPos.x)+WIDE)/inward;
                    float tLid=rd.y>0.0?(CEIL-vPos.y)/rd.y:1e4;
                    float tFloor=rd.y<0.0?(FLOOR-vPos.y)/rd.y:1e4;
                    float tEnd=abs(rd.z)>1e-4?(sign(rd.z)*END-vPos.z)/rd.z:1e4;
                    float t=min(min(tWall,tEnd),min(tLid,tFloor));
                    vec3 p=vPos+rd*t;
                    vec3 c;
                    if(t==tWall){
                        // Far side: cream panelling, its windows black with night, seat backs under them.
                        float w=abs(fract((p.z+${(-WINDOWS[0]).toFixed(2)})/${WINDOW_PITCH.toFixed(2)}+0.5)-0.5)*${WINDOW_PITCH.toFixed(2)};
                        float hole=smoothstep(0.5,0.47,w)*smoothstep(2.2,2.23,p.y)*smoothstep(3.06,3.03,p.y);
                        c=mix(warm*0.6,night,hole*0.94);
                        c=mix(c,warm*0.3,smoothstep(0.03,0.015,abs(p.y-2.14)));
                        c=mix(c,seat*(0.7+0.3*smoothstep(1.5,2.0,p.y)),step(p.y,2.02));
                    }else if(t==tEnd){
                        // Bulkhead with the doorway through to the next car.
                        c=mix(warm*0.5,warm*0.85,step(abs(p.x),0.42)*step(p.y,3.05));
                    }else if(t==tLid){
                        // Ceiling: a row of tubes down the middle, grab rails either side.
                        c=warm*0.72;
                        c+=vec3(1.0,0.97,0.9)*1.9*smoothstep(0.17,0.11,abs(p.x))*step(0.16,fract(p.z/${WINDOW_PITCH.toFixed(2)}));
                        c*=1.0-0.5*smoothstep(0.03,0.015,abs(abs(p.x)-0.62));
                    }else{
                        c=warm*0.14*(0.8+0.2*step(0.5,fract(p.z*1.6)));
                    }
                    c*=mix(1.0,0.7,clamp(t/9.0,0.0,1.0));
                    // People, far to near: facing us on the far bench, standing in the aisle, backs to this window.
                    float tFar=(abs(vPos.x)+0.92)/inward,tMid=abs(vPos.x)/inward,tNear=(abs(vPos.x)-0.98)/inward;
                    vec3 q=vPos+rd*tFar;
                    float open=smoothstep(0.1,0.32,inward);
                    float opposite=step(tFar,t)*open*row(q,0.56,2.32,0.42,side*5.0+1.0);
                    c=mix(c,mix(vec3(0.07,0.08,0.11),vec3(0.3,0.24,0.2),h(floor(q.z/0.56)+floor(car+0.5)*3.0))*(warm+0.3),opposite);
                    q=vPos+rd*tMid;
                    float aisle=step(tMid,t)*open*row(q,1.15,2.8,0.16,3.0);
                    c=mix(c,vec3(0.05,0.055,0.07)*(warm+0.4),aisle);
                    q=vPos+rd*tNear;
                    float beside=step(tNear,t)*row(q,0.56,2.34,0.38,side*9.0+2.0);
                    c=mix(c,vec3(0.02,0.022,0.03),beside);
                    // Hand straps swing in a row above the near bench.
                    q=vPos+rd*((abs(vPos.x)-0.72)/inward);
                    vec2 strap=vec2((fract(q.z/0.42)-0.5)*0.42,q.y-2.98);
                    c=mix(c,warm*0.25,smoothstep(0.012,0.0,abs(length(strap)-0.055))*step(abs(q.z),END));
                    if(vPane.w>1.5)c*=0.3;
                    // The glass itself: night on its face at a glancing view, the sash bar, the rubber round it.
                    c=mix(c,night*3.0+vec3(0.01,0.014,0.02),pow(1.0-inward,5.0)*0.6);
                    vec2 size=vPane.yz,g=(vUv-0.5)*size;
                    if(vPane.w<0.5)c=mix(c,warm*0.2,smoothstep(0.02,0.011,abs(g.y-size.y*0.14)));
                    float edge=length(max(abs(g)-size*0.5+0.085,0.0))-0.085;
                    c=mix(c,vec3(0.012),smoothstep(-0.034,-0.02,edge));
                    gl_FragColor=vec4(c*power,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const glass = instances(glassMaterial, CARS, glassGeometry);
        glass.name = 'trainWindows';
        // The two ends: three windscreen panes, the destination blind, the
        // roof lamp and the pair of lamps under the windows, with their glare.
        const endGeometry = (() => {
            const positions = [], uvs = [], kinds = [], indices = [];
            // From the corner with the larger x to the other, rising h about y.
            const quad = (ax, az, bx, bz, y, h, kind) => {
                const base = positions.length / 3;
                positions.push(ax, y - h / 2, az, bx, y - h / 2, bz, bx, y + h / 2, bz, ax, y + h / 2, az);
                uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
                for (let i = 0; i < 4; i++) kinds.push(kind);
                indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            };
            const face = TIP - 0.014;
            // A point on the right-hand folded panel, a hair in front of it.
            const fold = f => [0.5 + 0.68 * f + 0.0043, TIP + 0.22 * f - 0.0133];
            const folded = (from, to, y, h, kind) => {
                const [ix, iz] = fold(from), [ox, oz] = fold(to);
                quad(ox, oz, ix, iz, y, h, kind);
                quad(-ix, iz, -ox, oz, y, h, kind);
            };
            quad(0.43, face, -0.43, face, 2.63, 0.82, 0);
            folded(0.1, 0.92, 2.63, 0.82, 0);
            quad(0.34, face, -0.34, face, 3.115, 0.13, 1);
            folded(0.36, 0.68, 1.8, 0.22, 2);
            for (const side of [-1, 1]) quad(side * 0.85 + 0.55, TIP - 0.04, side * 0.85 - 0.55, TIP - 0.04, 1.8, 1.1, 3);
            quad(0.19, TIP + 0.078, -0.19, TIP + 0.078, 3.63, 0.38, 4);
            quad(1.2, TIP + 0.06, -1.2, TIP + 0.06, 3.63, 2.4, 5);
            const shape = new T.BufferGeometry();
            shape.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
            shape.setAttribute('uv', new T.Float32BufferAttribute(uvs, 2));
            shape.setAttribute('kind', new T.Float32BufferAttribute(kinds, 1));
            shape.setIndex(indices);
            return geometry(shape);
        })();
        const endMaterial = tail => material(new T.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: { warm: { value: new T.Color('#ffd28c') }, head: { value: new T.Color('#fff3d6') },
                red: { value: new T.Color('#ff3b2f') }, tail: { value: tail } },
            vertexShader: `attribute float kind;varying vec2 vUv;varying float vKind;
                void main(){vUv=uv;vKind=kind;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `uniform vec3 warm,head,red;uniform float tail;varying vec2 vUv;varying float vKind;
                void main(){
                    vec3 c;float a=1.0;
                    vec2 p=vUv*2.0-1.0;float r=dot(p,p);
                    if(vKind<0.5){
                        // Windscreen: the cab is dim, the saloon behind it glows through.
                        c=warm*0.07;
                        float through=smoothstep(0.78,0.7,abs(p.x))*smoothstep(-0.28,-0.2,p.y)*smoothstep(0.84,0.74,p.y);
                        c=mix(c,warm*(0.34+0.3*smoothstep(0.1,0.7,p.y)),through);
                        c+=vec3(1.0,0.97,0.9)*0.5*through*smoothstep(0.06,0.02,abs(p.y-0.6));
                        c*=1.0-0.8*smoothstep(-0.5,-0.58,p.y);
                        vec2 g=abs(p);
                        c=mix(c,vec3(0.012),smoothstep(0.86,0.93,max(g.x,g.y)));
                    }else if(vKind<1.5){
                        c=warm*1.5*(0.45+0.55*step(0.42,fract(vUv.x*6.0)))*step(abs(p.y),0.7)+vec3(0.01);
                    }else if(vKind<2.5){
                        // A lamp in its bezel: red at the tail, unlit at the head.
                        a=smoothstep(1.0,0.86,r);
                        c=mix(vec3(0.02),mix(warm*0.08,red*3.2,tail),smoothstep(0.62,0.5,r));
                    }else if(vKind<3.5){
                        a=exp(-r*7.0)*0.34*tail;c=red*1.2;
                    }else if(vKind<4.5){
                        a=smoothstep(1.0,0.86,r);
                        c=mix(vec3(0.03),mix(head*6.0,vec3(0.04),tail),smoothstep(0.72,0.6,r));
                    }else{
                        a=exp(-r*6.5)*0.6*(1.0-tail);c=head*2.2;
                    }
                    gl_FragColor=vec4(c,a);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const trainEnds = [0, 1].map(tail => {
            const mesh = new T.Mesh(endGeometry, endMaterial(tail));
            mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.name = tail ? 'trainTail' : 'trainFront';
            root.add(mesh);
            return mesh;
        });
        const cabinGlow = new T.PointLight('#ffd28c', 0, 15, 2);
        root.add(cabinGlow);
        const trainParts = [cars, glass, kits, ...trainEnds];
        const paintTrain = (upper, lower, gear, roof) => {
            const colours = [upper, lower, gear, roof], attribute = carGeometry.attributes.color;
            carGeometry.userData.groups.forEach((group, i) => attribute.setXYZ(i, colours[group].r, colours[group].g, colours[group].b));
            attribute.needsUpdate = true;
        };
        const placeTrain = (track, front, visible) => {
            trainParts.forEach(mesh => { mesh.visible = visible; });
            if (!visible) { cars.count = glass.count = kits.count = 0; return; }
            cars.count = glass.count = CARS;
            kits.count = CARS / 2;
            const reach = (CAR.length + CAR.joint) / 2;
            for (let i = 0; i < CARS; i++) {
                // A car rides on its own bogie and on the one it shares at the
                // joint, so it follows the curve as a chord. The second car of
                // a set faces backwards.
                const set = i >> 1, second = i % 2 === 1;
                const joint = front - set * SET_PITCH - CAR.length - CAR.joint / 2;
                const j = track.at(joint).position;
                const own = track.at(joint + (second ? -1 : 1) * (reach + CAR.bogie)).position;
                const dx = own.x - j.x, dz = own.z - j.z, span = Math.hypot(dx, dz) || 1;
                dummy.position.set(j.x + dx / span * reach, 0, j.z + dz / span * reach);
                dummy.rotation.set(0, Math.atan2(-dx, -dz), 0);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                cars.setMatrixAt(i, dummy.matrix);
                glass.setMatrixAt(i, dummy.matrix);
                if (i === 0 || i === CARS - 1) {
                    const end = trainEnds[i === 0 ? 0 : 1];
                    end.position.copy(dummy.position); end.rotation.copy(dummy.rotation);
                }
                if (i === 1) cabinGlow.position.set(dummy.position.x, 2.4, dummy.position.z);
                if (!second) {
                    const a = track.at(joint + 1).position, b = track.at(joint - 1).position;
                    dummy.position.set(j.x, 0, j.z);
                    dummy.rotation.set(0, Math.atan2(-(a.x - b.x), -(a.z - b.z)), 0);
                    dummy.updateMatrix();
                    kits.setMatrixAt(set, dummy.matrix);
                }
            }
            cars.instanceMatrix.needsUpdate = glass.instanceMatrix.needsUpdate = kits.instanceMatrix.needsUpdate = true;
        };
        const skyMat = material(new T.ShaderMaterial({
            side: T.BackSide, depthWrite: false,
            uniforms: {
                night: { value: new T.Color('#080f20') },
                horizon: { value: new T.Color('#415266') },
                cold: { value: new T.Color('#8bbfc8') },
                open: { value: 0 },
                // Fixed celestial moon direction, identical to the moon mesh offset.
                moonDir: { value: new T.Vector3(-210, 300, -420).normalize() },
                moonTint: { value: new T.Color('#cbdde8') },
                glowTint: { value: new T.Color('#415266') },
                moonGlow: { value: 1 },
                horizonGlow: { value: 1 },
                accent: { value: 0 },
                auroraActive: { value: 1.0 },
                auroraTime: { value: 0.0 },
                auroraRhythm: { value: 0.0 },
                auroraHeading: { value: 0.0 },
                auroraGreen: { value: new T.Color('#22f09d') },
                auroraViolet: { value: new T.Color('#9d4edd') }
            },
            vertexShader: `varying vec3 ray;
                void main(){ray=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `varying vec3 ray;uniform vec3 night,horizon,cold;uniform float open;
                uniform vec3 moonDir,moonTint,glowTint;uniform float moonGlow,horizonGlow,accent;
                uniform float auroraActive, auroraTime, auroraRhythm, auroraHeading;
                uniform vec3 auroraGreen, auroraViolet;
                float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
                float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),
                    mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                    mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                    mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
                void main(){
                    vec3 d=normalize(ray);
                    float h=pow(max(d.y,0.0),0.45);
                    vec3 c=mix(horizon,night,clamp(h*1.7,0.0,1.0));
                    float band=exp(-pow(dot(d,normalize(vec3(0.35,0.8,0.48)))-0.18,2.0)*90.0);
                    float cloud=noise(d*12.0)*0.6+noise(d*33.0)*0.3+noise(d*91.0)*0.1;
                    c+=cold*band*pow(cloud,3.0)*(0.12+open*0.22);
                    // Moonlight scattering: a tight corona plus a wide, faint veil.
                    float md=max(dot(d,moonDir),0.0);
                    float corona=pow(md,220.0)*0.55+pow(md,48.0)*0.16+pow(md,7.0)*0.05;
                    c+=moonTint*corona*moonGlow*(0.85+cloud*0.3)*(1.0+accent*0.4);
                    // Residual light pooled at the horizon (distant towns, last dusk).
                    float rim=exp(-abs(d.y)*16.0)*(0.6+0.4*noise(vec3(d.xz*4.0,1.0)));
                    c+=glowTint*rim*horizonGlow*(0.1+open*0.08);
                    // Angular curtains share the same coordinates as their visibility mask.
                    // Fixed celestial heading, calibrated once to the opening shot, not a HUD.
                    if (auroraActive > 0.001 && d.y > 0.02) {
                        float angle = atan(d.x, -d.z) - auroraHeading;
                        float u = atan(sin(angle), cos(angle));
                        float elevation = asin(clamp(d.y, -1.0, 1.0));
                        float sector = smoothstep(-0.85, -0.48, u)
                                     * (1.0 - smoothstep(0.16, 0.48, u));
                        float drift = auroraTime * 0.065;
                        vec3 emission = vec3(0.0);
                        for (int layer = 0; layer < 3; layer++) {
                            float k = float(layer);
                            float fold = sin(u * 8.0 + drift + k * 1.7)
                                       + 0.35 * sin(u * 19.0 - drift * 0.7 + k);
                            float base = 0.13 + k * 0.045 + fold * 0.025;
                            float altitude = elevation - base;
                            float height = 0.17 + 0.045 * sin(u * 6.0 + k + drift * 0.4);
                            float v = max(0.0, altitude) / height;
                            float filament = noise(vec3(u * 95.0 + fold * 1.4,
                                drift * 0.4 + k * 5.0, v * 0.18));
                            float fine = pow(0.5 + 0.5 * sin(u * 310.0 + fold * 6.0
                                + drift * 1.2 + v * 0.7), 6.0);
                            float veil = smoothstep(-0.012, 0.015, altitude)
                                * exp(-v * 2.7) * (0.22 + filament * 0.65 + fine * 0.28);
                            float hem = exp(-pow(altitude / 0.012, 2.0)) * 0.22;
                            vec3 spectral = mix(auroraGreen, auroraViolet,
                                smoothstep(0.25, 1.1, v));
                            emission += spectral * (veil + hem) / (1.0 + k * 0.65);
                        }
                        c += emission * sector * auroraActive
                            * (0.75 + auroraRhythm * 0.2 + accent * 0.55);
                    }
                    gl_FragColor=vec4(c,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const sky = new T.Mesh(geometry(new T.SphereGeometry(850, 32, 20)), skyMat);
        sky.renderOrder = -100;
        root.add(sky);
        const random = seededRandom('last-train-fixed-sky');
        const positions = [], colors = [], sizes = [], phases = [];
        // Lights of towns on the far shore come first in the buffer, so every
        // quality level keeps them. They sit in front of the ridge, low enough
        // to lay their own reflections on the water.
        const shore = seededRandom('last-train-far-shore');
        for (let town = 0; town < 7; town++) {
            const bearing = shore() * Math.PI * 2, spread = 0.05 + shore() * 0.09;
            for (let i = 0, count = 18 + Math.floor(shore() * 30); i < count; i++) {
                const angle = bearing + (shore() + shore() - 1) * spread;
                const radius = 600 + shore() * 30, tall = shore() > 0.93;
                positions.push(Math.cos(angle) * radius, tall ? 9 + shore() * 9 : 0.8 + shore() * shore() * 5,
                    Math.sin(angle) * radius);
                const brightness = 0.45 + shore() * 0.55, warm = shore();
                colors.push(brightness, brightness * (0.7 + warm * 0.2), brightness * (0.34 + warm * 0.4));
                sizes.push(1.5 + shore() * 1.5);
                phases.push(shore());
            }
        }
        const light = (bearing, radius, y, brightness, warm, size) => {
            positions.push(Math.cos(bearing) * radius, y, Math.sin(bearing) * radius);
            colors.push(brightness, brightness * (0.7 + warm * 0.2), brightness * (0.34 + warm * 0.4));
            sizes.push(size);
            phases.push(shore());
        };
        // The island: the harbour and the shrine town at its foot, a few lights up the slope.
        for (let i = 0; i < 70; i++) {
            const u = 0.1 + shore() * 0.85, climb = shore() * shore();
            light(ISLE.bearing + u * ISLE.reach, ISLE.radius - 2, 1 + climb * 18 * Math.sqrt(Math.max(0, 1 - u * u)),
                0.5 + shore() * 0.5, shore(), 1.8 + shore() * 1.4);
        }
        // Its bridge: a string of lamps from the island across to the land.
        for (let i = 0; i <= 30; i++) {
            light(ISLE.bearing + ISLE.reach * (0.96 + i / 30 * 1.5), ISLE.radius + i / 30 * 90, 3.2, 1, 0.75, 2.6);
        }
        // The tower: lit windows round the deck, the lantern, and the stem picked out below.
        const beaconAt = ISLE.bearing + ISLE.tower * ISLE.reach;
        const beaconFoot = ISLE.crest * Math.pow(1 - ISLE.tower * ISLE.tower, 0.55) * 0.9;
        for (let i = -3; i <= 3; i++) light(beaconAt + i * 0.75 / ISLE.radius, ISLE.radius - 3, beaconFoot + ISLE.height * 0.78, 1.2, 0.9, 2.2);
        for (let i = 1; i <= 6; i++) light(beaconAt, ISLE.radius - 3, beaconFoot + ISLE.height * 0.1 * i, 0.6, 1, 1.7);
        light(beaconAt, ISLE.radius - 3, beaconFoot + ISLE.height * 0.9, 1.8, 1, 5);
        const townLights = positions.length / 3;
        for (let i = 0; i < 8000; i++) {
            const y = random(), angle = random() * Math.PI * 2;
            const r = Math.sqrt(1 - y * y);
            positions.push(Math.cos(angle) * r * 780, y * 780, Math.sin(angle) * r * 780);
            const magnitude = Math.pow(random(), 5);
            const brightness = 0.25 + magnitude * 0.75;
            // Stellar temperature: most white-blue, a few warm giants.
            const warm = random() > 0.9 ? 1 : 0;
            colors.push(brightness * (0.86 + warm * 0.14), brightness * (0.93 - warm * 0.05),
                brightness * (1 - warm * 0.22));
            sizes.push(1.1 + magnitude * 2.8);
            phases.push(random());
        }
        const starGeo = geometry(new T.BufferGeometry());
        starGeo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
        starGeo.setAttribute('starColor', new T.Float32BufferAttribute(colors, 3));
        starGeo.setAttribute('starSize', new T.Float32BufferAttribute(sizes, 1));
        starGeo.setAttribute('phase', new T.Float32BufferAttribute(phases, 1));
        // Soft round stars; twinkle is a pure function of the playback clock.
        const starMat = material(new T.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: {
                time: { value: 0 }, opacity: { value: 0.8 }, twinkle: { value: 1 }, accent: { value: 0 },
                pixelRatio: { value: 1 }, tint: { value: new T.Color('#ffffff') }
            },
            vertexShader: `attribute vec3 starColor;attribute float starSize,phase;
                uniform float time,opacity,twinkle,pixelRatio,accent;
                varying vec3 vColor;varying float vAlpha;
                void main(){
                    gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
                    float tw=0.5+0.5*sin(time*(0.6+phase*2.1)+phase*43.0);
                    float slow=0.5+0.5*sin(time*0.23+phase*17.0);
                    vColor=starColor*mix(1.0,0.5+0.5*tw*slow+0.25,twinkle);
                    // Chapter accent: stars surge in as a chorus opens.
                    vAlpha=opacity*(1.0+accent*0.45);
                    gl_PointSize=starSize*pixelRatio*(0.9+0.25*tw*twinkle);
                }`,
            fragmentShader: `uniform vec3 tint;varying vec3 vColor;varying float vAlpha;
                void main(){
                    vec2 p=gl_PointCoord*2.0-1.0;float r=dot(p,p);
                    if(r>1.0)discard;
                    float core=exp(-r*7.0);float halo=exp(-r*2.4)*0.32;
                    float a=(core+halo)*vAlpha;
                    gl_FragColor=vec4(vColor*tint*(core*1.25+halo),a);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        starMat.opacity = 0.8;
        const stars = new T.Points(starGeo, starMat);
        root.add(stars);
        // A gibbous moon with maria, a few ray craters and limb darkening. It
        // travels with the camera, so the viewing direction is a constant.
        const moonMat = material(new T.ShaderMaterial({
            uniforms: { color: { value: new T.Color('#cbdde8') },
                toViewer: { value: new T.Vector3(210, -300, 420).normalize() },
                sun: { value: new T.Vector3(210, -300, 420).normalize()
                    .add(new T.Vector3(0.62, 0.34, -0.2)).normalize() } },
            vertexShader: `varying vec3 surface;
                void main(){surface=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            fragmentShader: `varying vec3 surface;uniform vec3 color,toViewer,sun;
                float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
                float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                    return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),
                    mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                    mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                    mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
                float crater(vec3 p,vec3 at,float size){
                    float d=distance(p,normalize(at))/size;
                    return smoothstep(1.0,0.75,d)*-0.16+exp(-pow((d-1.0)*5.0,2.0))*0.2
                        +exp(-d*0.9)*0.12*step(1.0,d);}
                void main(){
                    vec3 p=normalize(surface);
                    float seas=smoothstep(0.46,0.66,noise(p*2.1+3.7)*0.62+noise(p*4.6)*0.38);
                    float albedo=0.96-seas*0.34+(noise(p*11.0)-0.5)*0.14+(noise(p*27.0)-0.5)*0.07;
                    albedo+=crater(p,vec3(0.25,-0.55,0.8),0.12)+crater(p,vec3(-0.2,0.1,0.95),0.08)
                        +crater(p,vec3(0.55,0.2,0.75),0.06)+crater(p,vec3(-0.5,-0.4,0.7),0.1)
                        +crater(p,vec3(0.1,0.6,0.7),0.07);
                    float limb=0.66+0.34*pow(max(dot(p,toViewer),0.0),0.55);
                    float lit=smoothstep(-0.12,0.26,dot(p,sun));
                    gl_FragColor=vec4(color*albedo*limb*mix(0.05,1.0,lit),1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const moonColor = moonMat.uniforms.color.value;
        const moon = new T.Mesh(geometry(new T.SphereGeometry(20, 32, 24)), moonMat);
        root.add(moon);
        const target = new T.WebGLRenderTarget(512, 320, { depthBuffer: true, type: T.HalfFloatType });
        const mirror = new T.PerspectiveCamera();
        const textureMatrix = new T.Matrix4();
        const waterMat = material(new T.ShaderMaterial({
            depthWrite: true, transparent: false,
            uniforms: { reflection: { value: target.texture }, textureMatrix: { value: textureMatrix },
                time: { value: 0 }, strength: { value: 1 }, tint: { value: new T.Color('#10212d') },
                energy: { value: 0 },
                moonDir: { value: new T.Vector3(-210, 300, -420).normalize() },
                moonTint: { value: new T.Color('#cbdde8') }, glitter: { value: 1 },
                fogTint: { value: new T.Color('#415266') }, fogDensity: { value: 0.008 },
                lampTint: { value: new T.Color('#ffd28c') },
                lampPos: { value: Array.from({ length: 4 }, () => new T.Vector3()) },
                lampPower: { value: new Float32Array(4) } },
            vertexShader: `uniform mat4 textureMatrix;varying vec4 reflected;varying vec3 world;
                void main(){vec4 p=modelMatrix*vec4(position,1.0);world=p.xyz;reflected=textureMatrix*p;
                    gl_Position=projectionMatrix*viewMatrix*p;}`,
            fragmentShader: `uniform sampler2D reflection;uniform float time,strength,energy,glitter,fogDensity;
                uniform vec3 tint,moonDir,moonTint,fogTint,lampTint;
                uniform vec3 lampPos[4];uniform float lampPower[4];
                varying vec4 reflected;varying vec3 world;
                float h21(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*43758.5453);}
                float n21(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
                    return mix(mix(h21(i),h21(i+vec2(1.0,0.0)),f.x),mix(h21(i+vec2(0.0,1.0)),h21(i+vec2(1.0,1.0)),f.x),f.y);}
                void main(){
                    vec3 toCam=cameraPosition-world;float dist=length(toCam);vec3 v=toCam/max(dist,0.001);
                    // Analytic ripple normal: two swells and fine chop, damped with distance.
                    float damp=1.0/(1.0+dist*0.02);
                    vec2 g=vec2(0.0);
                    g+=vec2(0.65,0.0)*cos(world.z*0.65+world.x*0.12+time*0.45)*0.05;
                    g+=vec2(0.0,0.48)*-sin(world.x*0.48-time*0.32)*0.05;
                    g+=vec2(1.9,1.3)*cos(world.x*1.9+world.z*1.3+time*1.1)*0.018;
                    g+=vec2(-1.4,2.3)*cos(-world.x*1.4+world.z*2.3-time*0.9)*0.014;
                    g*=damp*(1.0+energy*0.6);
                    vec3 n=normalize(vec3(-g.x,1.0,-g.y));
                    vec2 uv=reflected.xy/max(reflected.w,0.001)+n.xz*(0.018+energy*0.008);
                    float valid=step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0)*step(0.0,reflected.w);
                    vec3 r=texture2D(reflection,clamp(uv,0.001,0.999)).rgb;
                    // Schlick Fresnel for water (F0 ~ 0.02), lifted so the mirror reads at night.
                    float cosT=clamp(dot(n,v),0.0,1.0);
                    float f=0.1+0.9*(0.02+0.98*pow(1.0-cosT,5.0));
                    f=max(f,0.12+0.75*pow(1.0-abs(v.y),3.0));
                    vec3 c=mix(tint,r,clamp(f*strength*valid,0.0,0.94));
                    // Broken moon path: tight specular lobe sparked by a flickering facet grid.
                    vec3 refl=reflect(-v,n);
                    float lobe=pow(max(dot(refl,moonDir),0.0),260.0);
                    float wide=pow(max(dot(refl,moonDir),0.0),28.0)*0.08;
                    // Glints come and go as smooth patches, never as squares, and
                    // thin out right under the camera where each would fill the view.
                    float spark=smoothstep(0.55,0.9,n21(world.xz*vec2(9.0,4.6)+vec2(time*0.8,-time*0.5))
                        *n21(world.xz*vec2(2.1,1.1)-vec2(time*0.22))*2.0);
                    c+=moonTint*(lobe*(0.14+spark*1.0)*mix(0.1,1.0,smoothstep(8.0,40.0,dist))+wide)*glitter*strength;
                    // Vertical lamp streaks along the camera-lamp bearing.
                    for(int i=0;i<4;i++){
                        if(lampPower[i]<=0.0)continue;
                        vec2 cam=cameraPosition.xz;vec2 L=lampPos[i].xz-cam;float ld=length(L);
                        if(ld<0.5)continue;
                        vec2 dir=L/ld;vec2 rel=world.xz-cam;
                        float along=dot(rel,dir);float across=abs(rel.x*dir.y-rel.y*dir.x);
                        float width=0.18+ld*0.012;
                        float band=exp(-across*across/(width*width))
                            *smoothstep(ld*0.35,ld*0.8,along)*(1.0-smoothstep(ld*0.98,ld*1.08,along));
                        float shimmer=0.55+0.45*sin(along*5.0-time*2.2+n.x*20.0);
                        c+=lampTint*band*shimmer*lampPower[i]*0.55*strength;
                    }
                    // Match scene FogExp2 so the far plane melts into the horizon.
                    float fog=1.0-exp(-fogDensity*fogDensity*dist*dist);
                    c=mix(c,fogTint,clamp(fog,0.0,1.0));
                    gl_FragColor=vec4(c,1.0);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const water = new T.Mesh(geometry(new T.PlaneGeometry(1800, 1800)), waterMat);
        water.rotation.x = -Math.PI / 2;
        root.add(water);
        // Additive lamp halos: one soft point per lit lamp, reflected by the mirror pass too.
        const haloPositions = new Float32Array(48 * 3);
        const haloGeometry = geometry(new T.BufferGeometry());
        haloGeometry.setAttribute('position', new T.BufferAttribute(haloPositions, 3).setUsage(T.DynamicDrawUsage));
        haloGeometry.setDrawRange(0, 0);
        const haloMat = material(new T.ShaderMaterial({
            transparent: true, depthWrite: false, blending: T.AdditiveBlending,
            uniforms: { color: { value: new T.Color('#ffd28c') }, intensity: { value: 1 },
                size: { value: 1.6 }, pixelRatio: { value: 1 } },
            vertexShader: `uniform float size,pixelRatio;varying float vFade;
                void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);gl_Position=projectionMatrix*mv;
                    float d=max(1.0,-mv.z);
                    gl_PointSize=clamp(size*pixelRatio*300.0/d,2.0,180.0);
                    vFade=1.0-smoothstep(70.0,150.0,d);}`,
            fragmentShader: `uniform vec3 color;uniform float intensity;varying float vFade;
                void main(){vec2 p=gl_PointCoord*2.0-1.0;float r=dot(p,p);
                    if(r>1.0)discard;
                    float core=exp(-r*22.0);float glow=exp(-r*4.5)*0.32;
                    float a=(core+glow)*intensity*vFade;
                    gl_FragColor=vec4(color*a,a);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`
        }));
        const halos = new T.Points(haloGeometry, haloMat);
        halos.frustumCulled = false;
        root.add(halos);
        // Cabin window foreground (layer 1: viewer only, never mirrored).
        const cabin = new T.Group();
        cabin.renderOrder = 1000;
        const panel = geometry(new T.PlaneGeometry(1, 1));
        const frameMat = material(new T.MeshBasicMaterial({ color: '#07090c', transparent: true,
            depthTest: false, depthWrite: false, fog: false }));
        const rimMat = material(new T.MeshBasicMaterial({ color: '#ffd28c', transparent: true,
            depthTest: false, depthWrite: false, fog: false, blending: T.AdditiveBlending }));
        const sheenMat = material(new T.ShaderMaterial({
            transparent: true, depthTest: false, depthWrite: false, blending: T.AdditiveBlending,
            uniforms: { color: { value: new T.Color('#ffd28c') }, opacity: { value: 0 } },
            vertexShader: `varying vec2 vUv;void main(){vUv=uv;
                gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
            // Faint reflection of the lit carriage in the glass, pooled at the sill.
            fragmentShader: `uniform vec3 color;uniform float opacity;varying vec2 vUv;
                void main(){float a=(pow(1.0-vUv.y,3.0)*0.8+pow(abs(vUv.x-0.5)*2.0,4.0)*0.3)*opacity;
                    gl_FragColor=vec4(color*a,a);}`
        }));
        const cabinPart = mat => {
            const mesh = new T.Mesh(panel, mat);
            mesh.layers.set(1);
            mesh.renderOrder = 1000 + (mat === frameMat ? 2 : mat === rimMat ? 3 : 1);
            mesh.frustumCulled = false;
            cabin.add(mesh);
            return mesh;
        };
        const sheen = cabinPart(sheenMat);
        const pillars = [cabinPart(frameMat), cabinPart(frameMat)];
        const header = cabinPart(frameMat), sill = cabinPart(frameMat);
        const rims = [cabinPart(rimMat), cabinPart(rimMat)];
        root.add(cabin);
        let cabinWeight = 0;
        const updateCabin = (camera, pose, track, aspect, config) => {
            const tuning = config.modes?.diorama || {};
            const f = track.at(pose.distance);
            const delta = Math.abs(Math.atan2(Math.sin(pose.yaw - f.yaw), Math.cos(pose.yaw - f.yaw)));
            const gaze = smooth((delta - 0.22) / 0.4);
            const inside = 1 - smooth((pose.state.openness - 0.45) / 0.3);
            cabinWeight = tuning.cabinFrame === false ? 0
                : gaze * inside * (1 - clamp(pose.finale ?? 0)) * (1 - clamp(pose.eventFocus?.weight ?? 0));
            cabin.visible = cabinWeight > 0.002;
            if (!cabin.visible) return;
            cabin.position.copy(camera.position);
            cabin.quaternion.copy(camera.quaternion);
            const z = -0.5;
            const h = Math.tan(camera.fov * Math.PI / 360) * -z, w = h * Math.max(0.35, aspect);
            // Slide in from beyond the frame edges; the reading centre stays clear.
            const pw = Math.min(w * 0.12, h * 0.16), bh = h * 0.1;
            const e = smooth(cabinWeight);
            pillars.forEach((mesh, i) => {
                const s = i ? 1 : -1;
                mesh.scale.set(pw, h * 2.4, 1);
                mesh.position.set(s * (w + pw / 2 - pw * e), 0, z);
                rims[i].scale.set(pw * 0.06, h * 2.2, 1);
                rims[i].position.set(s * (w - pw * e + pw * 0.03), 0, z);
            });
            header.scale.set(w * 2.4, bh, 1);
            header.position.set(0, h + bh / 2 - bh * e, z);
            sill.scale.set(w * 2.4, bh * 1.3, 1);
            sill.position.set(0, -h - bh * 0.65 + bh * 1.3 * e, z);
            sheen.scale.set(w * 2, h * 2, 1);
            sheen.position.set(0, 0, z);
            frameMat.opacity = e;
            rimMat.opacity = e * 0.35;
            rimMat.color.copy(haloMat.uniforms.color.value);
            sheenMat.uniforms.color.value.copy(haloMat.uniforms.color.value);
            sheenMat.uniforms.opacity.value = e * (palBase?.light ? 0.03 : 0.07);
        };
        let dead = false, reflectionEnabled = true, liveStations = 0, quality = 'standard';
        let trackKey = '', sceneryKey = '', instanceTrack = null, lightAnchors = [], instanceRebuilds = 0;
        let stationInstances = 0;
        let auroraTrack = null;
        let baseStarOpacity = 0.8;
        // Palette-derived baselines; chapter warmth modulates around them each frame.
        let palBase = null, liveWarmth = 0.5, liveAccent = 0, haloBase = 1;
        // The lamps of a crossing light in turn, a little faster than once a second.
        const signalLit = new T.Color(SIGNAL_RED).multiplyScalar(3.2), signalDark = new T.Color(SIGNAL_RED).multiplyScalar(0.06);
        const tintGlow = time => {
            const turn = Math.floor(time * 2.2) & 1;
            // By day a window is only a little warmer than the wall it is in.
            if (palBase?.light) roomGlow.copy(lampMaterial.color).multiplyScalar(0.3 / LAMP_GAIN).lerp(palePaint, 0.7);
            else roomGlow.copy(lampMaterial.color).multiplyScalar(0.34);
            if (palBase?.light) ceilingGlow.copy(palePaint).multiplyScalar(0.82);
            else ceilingGlow.copy(lampMaterial.color).multiplyScalar(0.04).lerp(timber.color, 0.3);
            let signal = 0;
            for (let i = 0; i < glow.count; i++) {
                const kind = glowKinds[i];
                if (kind === 2) {
                    // Every third is the lamp on a barrier arm, lit with whichever is nearer.
                    glow.setColorAt(i, signal % 3 === 2 || signal % 3 === turn ? signalLit : signalDark);
                    signal++;
                } else glow.setColorAt(i, kind === 0 ? lampMaterial.color : kind === 1 ? coldLampMaterial.color
                    : kind === 3 ? warmPaint : kind === 4 ? palePaint : kind === 5 ? roomGlow : ceilingGlow);
            }
            glow.instanceColor.needsUpdate = true;
        };
        const updateLights = (track, s, saving, audio) => {
            lightAnchors.sort((a, b) => Math.abs(a.address - s) - Math.abs(b.address - s));
            for (let i = 0; i < lights.length; i++) {
                const anchor = lightAnchors[i];
                const f = track.at(anchor?.address ?? s);
                const side = anchor?.side ?? -1;
                lights[i].position.set(f.position.x + f.right.x * LAMP_OFFSET * side, (anchor?.y ?? LAMP_Y) - 0.2,
                    f.position.z + f.right.z * LAMP_OFFSET * side);
                lights[i].intensity = anchor && !saving ? 24 * (1 + clamp(audio.impact) * 0.12) : 0;
            }
            // Water streaks only for lamps still ahead of the camera.
            const ahead = lightAnchors.filter(a => a.address > s + 2);
            for (let i = 0; i < 4; i++) {
                const anchor = ahead[i];
                const power = anchor ? Math.exp(-(anchor.address - s) / 70) : 0;
                if (anchor) {
                    const f = track.at(anchor.address);
                    waterMat.uniforms.lampPos.value[i].set(f.position.x + f.right.x * LAMP_OFFSET * anchor.side, anchor.y,
                        f.position.z + f.right.z * LAMP_OFFSET * anchor.side);
                }
                waterMat.uniforms.lampPower.value[i] = saving ? 0 : power;
            }
        };
        const setPalette = (palette = {}) => {
            const light = Boolean(palette.light);
            const background = new T.Color(palette.background || '#171a1d');
            const surface = new T.Color(palette.surface || palette.background || '#20252a');
            const deep = new T.Color(palette.deep || palette.background || '#171a1d');
            const ink = new T.Color(palette.ink || '#f2f0e9');
            const muted = new T.Color(palette.muted || '#a7afb1');
            const secondary = new T.Color(palette.secondary || '#76bfae');
            const tertiary = new T.Color(palette.tertiary || palette.secondary || '#76bfae');
            const emission = new T.Color(palette.emission || palette.accent || '#f2a900');
            const structure = new T.Color(palette.material || palette.surface || '#2a3035');
            const border = new T.Color(palette.border || palette.muted || '#3b4449');
            // Separate substrate, atmospheric fill and luminous accents.
            skyMat.uniforms.night.value.copy(deep).lerp(tertiary, light ? 0.025 : 0.045)
                .multiplyScalar(light ? 0.85 : 0.42);
            skyMat.uniforms.horizon.value.copy(background).lerp(muted, light ? 0.08 : 0.2)
                .lerp(tertiary, light ? 0.035 : 0.06);
            skyMat.uniforms.cold.value.copy(tertiary);
            // Theme-native spectral pair; keep luminance bounded, retaining hue.
            const luminous = color => {
                const hsl = color.getHSL({});
                return color.setHSL(hsl.h, clamp(hsl.s, 0.25, 0.88), clamp(hsl.l, 0.42, 0.66));
            };
            skyMat.uniforms.auroraGreen.value.copy(luminous(secondary.clone()));
            skyMat.uniforms.auroraViolet.value.copy(luminous(emission.clone().lerp(tertiary, 0.12)));
            waterMat.uniforms.tint.value.copy(deep).lerp(secondary, light ? 0.04 : 0.025)
                .multiplyScalar(light ? 0.78 : 0.48);
            scene.fog = new T.FogExp2(skyMat.uniforms.horizon.value, 0.008);
            waterMat.uniforms.fogTint.value.copy(skyMat.uniforms.horizon.value);
            waterMat.uniforms.moonTint.value.copy(light ? surface : ink).lerp(emission, 0.08);
            waterMat.uniforms.glitter.value = light ? 0.25 : 1;
            waterMat.uniforms.lampTint.value.copy(emission);
            steel.color.copy(structure).lerp(muted, light ? 0.3 : 0.5);
            concrete.color.copy(surface).lerp(border, light ? 0.2 : 0.45);
            timber.color.copy(deep).lerp(structure, 0.55).lerp(emission, 0.025);
            // Rust takes a little of the lamp colour.
            railMaterial.color.copy(steel.color).lerp(emission, light ? 0.04 : 0.1);
            wood.color.copy(timber.color);
            permanentWay.color.copy(timber.color);
            rockMaterial.color.copy(concrete.color).multiplyScalar(rockMaterial.map ? 1.7 : 0.8);
            hemisphere.color.copy(light ? surface : muted).lerp(tertiary, 0.12);
            hemisphere.groundColor.copy(deep);
            hemisphere.intensity = light ? 1.8 : 0.65;
            moonLight.color.copy(light ? surface : ink).lerp(tertiary, 0.12);
            moonColor.copy(light ? surface : ink).lerp(emission, 0.08);
            // Lamps are brighter than white, so the lens has something to spread.
            lampMaterial.color.copy(emission).multiplyScalar(LAMP_GAIN);
            coldLampMaterial.color.copy(luminous(secondary.clone())).multiplyScalar(1.7);
            // Paint does not shine: a marking is a little lighter than what it is painted on.
            warmPaint.copy(emission).lerp(concrete.color, 0.4).multiplyScalar(light ? 0.8 : 0.2);
            palePaint.copy(light ? surface : ink).lerp(concrete.color, 0.3).multiplyScalar(light ? 0.95 : 0.3);
            lights.forEach(l => l.color.copy(emission));
            // Livery: cream above the waist, the theme's colour below it.
            paintTrain((light ? surface : ink).clone().lerp(emission, light ? 0.1 : 0.22),
                luminous(secondary.clone()).multiplyScalar(0.8),
                deep.clone().lerp(structure, 0.4).multiplyScalar(0.6), structure.clone().lerp(muted, 0.12));
            glassMaterial.uniforms.warm.value.copy(emission).lerp(white, 0.18);
            glassMaterial.uniforms.seat.value.copy(secondary).multiplyScalar(0.3);
            glassMaterial.uniforms.night.value.copy(deep).multiplyScalar(0.5);
            trainEnds.forEach(mesh => mesh.material.uniforms.warm.value.copy(emission).lerp(white, 0.18));
            cabinGlow.color.copy(emission);
            starMat.uniforms.tint.value.copy(light ? surface : ink).lerp(tertiary, 0.08);
            baseStarOpacity = light ? 0.15 : 0.8;
            starMat.opacity = baseStarOpacity;
            starMat.uniforms.opacity.value = baseStarOpacity;
            skyMat.uniforms.moonTint.value.copy(moonColor);
            skyMat.uniforms.moonGlow.value = light ? 0.3 : 1;
            skyMat.uniforms.glowTint.value.copy(emission).lerp(tertiary, 0.5);
            skyMat.uniforms.horizonGlow.value = light ? 0.35 : 1;
            ridgeMaterial.color.copy(skyMat.uniforms.horizon.value).lerp(deep, 0.35)
                .multiplyScalar(light ? 0.8 : 0.55);
            wireMaterial.color.copy(border).lerp(secondary, 0.25);
            haloBase = light ? 0.35 : 1;
            frameMat.color.copy(deep).lerp(structure, 0.35).multiplyScalar(light ? 0.55 : 0.4);
            haloMat.uniforms.color.value.copy(emission);
            palBase = {
                light,
                horizon: skyMat.uniforms.horizon.value.clone(),
                night: skyMat.uniforms.night.value.clone(),
                hemi: hemisphere.color.clone(), hemiIntensity: hemisphere.intensity,
                lamp: emission.clone(), warm: emission.clone(), cold: tertiary.clone()
            };
        };
        // Warmth 0..1 → bias -1 (cold, open chorus) .. +1 (warm, tightening pre-chorus).
        // Everything is re-derived from the palette baseline, so no state accumulates.
        const applyWarmth = (warmth, openness, energy) => {
            if (!palBase) return;
            liveWarmth = warmth;
            const bias = (clamp(warmth) - 0.5) * 2;
            const toward = bias > 0 ? palBase.warm : palBase.cold;
            const amount = Math.abs(bias);
            const k = palBase.light ? 0.5 : 1;
            scratch.copy(palBase.horizon).lerp(toward, amount * 0.12 * k);
            skyMat.uniforms.horizon.value.copy(scratch);
            waterMat.uniforms.fogTint.value.copy(scratch);
            if (scene.fog) {
                scene.fog.color.copy(scratch);
                // Warm passages close in; open chapters and loud passages thin the haze.
                scene.fog.density = 0.008 * (1 + Math.max(0, bias) * 0.18)
                    * (1 - clamp(openness) * 0.18) * (1 - clamp(energy) * 0.06);
                waterMat.uniforms.fogDensity.value = scene.fog.density;
            }
            skyMat.uniforms.night.value.copy(palBase.night).lerp(palBase.cold, Math.max(0, -bias) * 0.05 * k);
            hemisphere.color.copy(palBase.hemi).lerp(toward, amount * 0.16 * k);
            hemisphere.intensity = palBase.hemiIntensity * (1 + Math.max(0, -bias) * 0.12);
            // Warm chapters deepen lamps toward amber, cold ones bleach them slightly.
            scratch.copy(palBase.lamp).lerp(white, Math.max(0, -bias) * 0.22);
            lights.forEach(l => l.color.copy(scratch));
            waterMat.uniforms.lampTint.value.copy(scratch);
            haloMat.uniforms.color.value.copy(scratch);
            lampMaterial.color.copy(scratch).multiplyScalar(LAMP_GAIN * (1 + Math.max(0, bias) * 0.15));
        };
        const update = (timeline, track, pose, time, config, audio = {}) => {
            if (dead) return;
            const tuning = config.modes?.diorama || {};
            quality = config.quality || 'standard';
            const saving = quality === 'energy-saving';
            const s = pose.distance;
            sky.position.set(pose.position.x, 0, pose.position.z);
            stars.position.copy(sky.position);
            ridge.position.copy(sky.position);
            moon.position.set(sky.position.x - 210, 300, sky.position.z - 420);
            water.position.set(pose.position.x, 0, pose.position.z);
            stars.visible = tuning.showParticles !== false;
            starMat.opacity = baseStarOpacity * (1 - clamp(pose.finale ?? 0));
            starMat.uniforms.opacity.value = starMat.opacity;
            starMat.uniforms.time.value = time;
            starGeo.setDrawRange(0, townLights + (saving ? 1500 : quality === 'ultimate' ? 8000 : 4000));
            skyMat.uniforms.open.value = pose.state.openness;
            const auroraEnabled = tuning.aurora !== false;
            skyMat.uniforms.auroraActive.value = auroraEnabled ? 1.0 : 0.0;
            if (auroraTrack !== track) {
                const opening = global.MusicStageDioramaCamera.pose(timeline, track, 0, tuning);
                skyMat.uniforms.auroraHeading.value = opening.yaw - 0.34;
                auroraTrack = track;
            }
            const motion = clamp(tuning.motionAmount ?? 1, 0, 2) * clamp(config.animationIntensity ?? 1, 0, 2);
            skyMat.uniforms.auroraTime.value = time * motion;
            starMat.uniforms.twinkle.value = clamp(motion);
            // A phrase-length beat envelope, not the fast onset impulse (which flickers).
            const beats = timeline.beats || [];
            const index = global.MusicStageDioramaDirector.upperBound(beats, time) - 1;
            const next = beats[index + 1] ?? ((beats[index] ?? 0) + 0.9);
            const phase = Math.max(0, index) + clamp((time - (beats[index] ?? 0))
                / Math.max(0.08, next - (beats[index] ?? 0)));
            const gain = clamp(tuning.audioReactivity ?? 1, 0, 2);
            skyMat.uniforms.auroraRhythm.value = time === 0 || motion === 0 ? 0
                : (0.5 - 0.5 * Math.cos(phase * Math.PI / 8)) * gain;
            waterMat.uniforms.time.value = time;
            waterMat.uniforms.energy.value = clamp(audio.energy);
            // Analytic chapter swell (seek-exact) plus frozen-on-pause audio response.
            const accent = motion ? (timeline.accentAt?.(time) ?? 0) : 0;
            liveAccent = accent;
            skyMat.uniforms.accent.value = accent;
            starMat.uniforms.accent.value = accent;
            applyWarmth(pose.state.warmth ?? 0.5, pose.state.openness, audio.energy);
            haloMat.uniforms.intensity.value = haloBase * (1 + clamp(audio.impact) * 0.35 + accent * 0.25);
            reflectionEnabled = tuning.waterReflection !== false && (tuning.waterStrength ?? 1) > 0;
            waterMat.uniforms.strength.value = reflectionEnabled ? clamp(tuning.waterStrength ?? 1, 0, 2) : 0;
            const spacing = 16 / clamp(tuning.stationIntensity ?? 1, 0.5, 2);
            headlight.color.copy(palBase?.lamp || white).lerp(white, 0.45);
            headlight.intensity = saving ? 0 : 3 * (palBase?.light ? 0.4 : 1);
            const front = pose.trainFront ?? s - 0.4;
            const ahead = track.at(front + 7.5);
            headlight.position.set(ahead.position.x, 0.7, ahead.position.z);
            // From the cab the train is all behind the lens: nothing of it to draw.
            placeTrain(track, front, tuning.showTrain !== false && (pose.chase ?? 0) > 0.002);
            cabinGlow.intensity = saving || tuning.showTrain === false ? 0 : 4.5 * (palBase?.light ? 0.4 : 1) * clamp(pose.chase ?? 0);
            // The permanent way slides forward in long strides; scenery is laid
            // out again only when a new pole or station comes into range.
            const nextTrackKey = [Math.floor(s / 12), quality].join(':');
            const nextSceneryKey = [Math.floor(s / spacing), Math.floor(s / 110), quality,
                tuning.narrativeStations, tuning.stationIntensity, tuning.cameraSpeed].join(':');
            if (instanceTrack !== track || nextTrackKey !== trackKey) {
                trackKey = nextTrackKey;
                const stride = Math.floor(s / 12) * 12;
                rails.count = (saving ? 90 : 160) * 2;
                for (let i = 0; i < rails.count / 2; i++) {
                    for (let side = 0; side < 2; side++) {
                        place(rails, i * 2 + side, track, stride - 30 + i * 2, (side ? 1 : -1) * 0.7175,
                            0.335, 1, 1, 2.04);
                    }
                }
                sleepers.count = saving ? 200 : 400;
                for (let i = 0; i < sleepers.count; i++) place(sleepers, i, track, stride - 24 + i * 0.75, 0, 0.18, 1, 1, 1);
                rails.instanceMatrix.needsUpdate = sleepers.instanceMatrix.needsUpdate = true;
            }
            if (rocksArrived) { rocksArrived = false; sceneryKey = ''; }
            if (instanceTrack === track && nextSceneryKey === sceneryKey) {
                tintGlow(time);
                updateLights(track, s, saving, audio);
                return;
            }
            instanceTrack = track; sceneryKey = nextSceneryKey; instanceRebuilds++;
            const enabled = tuning.narrativeStations !== false && (tuning.stationIntensity ?? 1) > 0;
            sceneryPools.forEach(mesh => { mesh.count = 0; });
            const part = (mesh, address, lateral, y, sx, sy, sz, roll = 0, pitch = 0) => {
                if (mesh.count >= mesh.instanceMatrix.count) return;
                place(mesh, mesh.count++, track, address, lateral, y, sx, sy, sz, roll, pitch);
            };
            // A straight member between two points of the cross-section at one address.
            const span = (mesh, address, l0, y0, l1, y1, thick, depth = thick) => part(mesh, address,
                (l0 + l1) / 2, (y0 + y1) / 2, Math.hypot(l1 - l0, y1 - y0), thick, depth, Math.atan2(y1 - y0, l1 - l0));
            const rawPart = part, rawSpan = span;
            // A pile of shore rocks, turned and sized so no two read as the same one.
            const rock = (address, lateral, size, turn, sunk = 0.12) => {
                if (!rocks || rocks.count >= rocks.instanceMatrix.count) return;
                const f = track.at(address);
                dummy.position.set(f.position.x + f.right.x * lateral, -sunk * size, f.position.z + f.right.z * lateral);
                dummy.rotation.set(0, turn, 0);
                dummy.scale.set(size, size * (0.85 + 0.3 * Math.abs(Math.sin(turn * 3.1))), size);
                dummy.updateMatrix();
                rocks.setMatrixAt(rocks.count++, dummy.matrix);
            };
            const speed = tuning.cameraSpeed ?? 1;
            // When the train reaches an address along the line.
            const timeAt = address => {
                let lo = 0, hi = timeline.duration;
                for (let j = 0; j < 18; j++) {
                    const mid = (lo + hi) * 0.5;
                    if (timeline.distanceAt(mid, speed) < address) lo = mid;
                    else hi = mid;
                }
                return (lo + hi) * 0.5;
            };
            const stateAt = address => timeline.sample(timeAt(address));
            // With no screen ahead the camera may still be turned to a line on the
            // sky: a pole then takes the side the camera faces away from as it
            // comes up to and passes that pole.
            const awayFromGaze = address => {
                for (const lead of [0, 16, 32]) {
                    const view = global.MusicStageDioramaCamera.pose(timeline, track, timeAt(address - lead), tuning);
                    const heading = track.at(address - lead).yaw;
                    const turn = Math.atan2(Math.sin(view.yaw - heading), Math.cos(view.yaw - heading));
                    if (Math.abs(turn) > 0.08) return turn > 0 ? -1 : 1;
                }
                return -1;
            };
            // Stations are laid out first: poles and props keep out of them.
            const stations = [];
            const stationStart = Math.floor(s / 110) - 1;
            for (let i = 0; i < 4 && enabled; i++) {
                const id = stationStart + i;
                if (id < 0) continue;
                const address = id * 110 + 38;
                // Prefer the side where fewer of its bays stand in a screen's sight line.
                const exposure = side => [-11, -5.5, 0, 5.5, 11].filter(bay =>
                    inSight(track, address + bay, 7, side)).length;
                const preferred = id % 2 ? 1 : -1;
                stations.push({ id, address, open: stateAt(address).density < 0.4,
                    side: exposure(-preferred) < exposure(preferred) ? -preferred : preferred });
            }
            const atStation = (address, side, margin) => stations.some(station =>
                station.side === side && Math.abs(station.address - address) < 14 + margin);

            // --- Catenary masts, lamp posts and the overhead line ---
            let haloCount = 0, wireVertex = 0;
            lightAnchors = [];
            const poleStart = Math.floor(s / spacing) - 3;
            const polePlan = [];
            for (let i = 0; i <= (enabled ? (saving ? 16 : 32) : -1); i++) {
                const id = poleStart + i;
                const address = id * spacing;
                const state = stateAt(address);
                const present = state.density >= 0.4 || id % 4 === 0;
                // The line is electrified wherever the train rides low; over open
                // water the camera climbs above bare lamp posts instead.
                let side = poleSide(track, address, awayFromGaze(address));
                if (inSight(track, address, POLE_OFFSET, side)) side = -side;
                const clear = !inSight(track, address, POLE_OFFSET, side);
                // A high camera also sees the masts ahead of it, so the wire only
                // starts a few spans after the train has come down.
                polePlan.push({ id, address, present: present && clear, side,
                    wired: present && clear && state.density >= 0.4 && !saving
                        && [0, 24, 48, 72].every(back => stateAt(address - back).height < 4.2) });
            }
            const wire = (a0, l0, y0, a1, l1, y1) => {
                if (wireVertex + 6 > wirePositions.length) return;
                for (const [address, lateral, y] of [[a0, l0, y0], [a1, l1, y1]]) {
                    const f = track.at(address);
                    wirePositions[wireVertex++] = f.position.x + f.right.x * lateral;
                    wirePositions[wireVertex++] = y;
                    wirePositions[wireVertex++] = f.position.z + f.right.z * lateral;
                }
            };
            polePlan.slice(0, -1).forEach((pole, index) => {
                if (!pole.present) return;
                const { id, address, side } = pole;
                const L = value => side * value;
                const stagger = id % 2 ? 0.18 : -0.18;
                part(concreteParts, address, L(POLE_OFFSET), 0.3, 0.6, 0.6, 0.6);
                if (!saving) {
                    // Base flange, the switch box on the far side, and the pole's number plate.
                    part(steelParts, address, L(POLE_OFFSET), 0.63, 0.32, 0.06, 0.32);
                    part(steelParts, address, L(POLE_OFFSET + 0.17), 1.45, 0.14, 0.42, 0.24);
                    part(paleMarks, address, L(POLE_OFFSET - 0.115), 2.0, 0.012, 0.24, 0.1);
                }
                if (pole.wired) {
                    part(masts, address, L(POLE_OFFSET), 4.3, 1, 7.4, 1);
                    // Cantilever: top tube, tie rod, bracket tube and steady arm.
                    span(steelParts, address, L(POLE_OFFSET), 7.25, L(0.2), 7.0, 0.07);
                    span(steelParts, address, L(POLE_OFFSET), 7.85, L(1.4), 7.13, 0.03);
                    span(steelParts, address, L(POLE_OFFSET), 6.25, L(0.6), 6.95, 0.07);
                    span(steelParts, address, L(1.9), 6.6, stagger, CONTACT_Y + 0.05, 0.04);
                    for (const y of [7.22, 6.3]) part(concreteParts, address, L(POLE_OFFSET - 0.42), y, 0.34, 0.15, 0.15);
                    part(steelParts, address, L(POLE_OFFSET), 7.93, 0.5, 0.05, 0.05);
                } else part(masts, address, L(POLE_OFFSET), 2.55, 0.85, 3.9, 0.85);
                // Over open water the camera flies at 5 to 7 m and the line is
                // written on the sky: bare posts stay below that eye line.
                const lampY = pole.wired ? LAMP_Y : 4.2;
                if (id % 7 !== 3) {
                    // Luminaire: bracket, hooded housing and the lit diffuser below it.
                    span(steelParts, address, L(POLE_OFFSET), lampY + 0.02, L(LAMP_OFFSET - 0.2), lampY + 0.2, 0.05);
                    if (!saving) {
                        // A stay under the bracket and the clamp that holds both to the pole.
                        span(steelParts, address, L(POLE_OFFSET), lampY - 0.4, L(LAMP_OFFSET + 0.3), lampY + 0.12, 0.025);
                        part(steelParts, address, L(POLE_OFFSET), lampY - 0.19, 0.2, 0.5, 0.2);
                    }
                    part(steelParts, address, L(LAMP_OFFSET), lampY + 0.17, 0.82, 0.09, 0.3);
                    part(glowParts, address, L(LAMP_OFFSET), lampY + 0.105, 0.66, 0.04, 0.2);
                    const hf = track.at(address);
                    haloPositions[haloCount * 3] = hf.position.x + hf.right.x * L(LAMP_OFFSET);
                    haloPositions[haloCount * 3 + 1] = lampY;
                    haloPositions[haloCount * 3 + 2] = hf.position.z + hf.right.z * L(LAMP_OFFSET);
                    haloCount++;
                    lightAnchors.push({ address, side, y: lampY, distance: Math.abs(address - s) });
                }
                // A block signal on every eleventh pole, its lamp in the cold palette colour.
                if (id % 11 === 5 && !saving && !atStation(address, side, 2) && !inSight(track, address, 2.3, side)) {
                    part(masts, address + 1.2, L(2.3), 1.9, 0.7, 3.8, 0.7);
                    part(steelParts, address + 1.2, L(2.3), 3.55, 0.36, 1.0, 0.16);
                    part(steelParts, address + 1.08, L(2.3), 3.86, 0.3, 0.04, 0.22);
                    part(coldGlowParts, address + 1.1, L(2.3), 3.72, 0.15, 0.15, 0.03);
                    part(steelParts, address + 1.08, L(2.3), 3.5, 0.3, 0.04, 0.22);
                    part(glowParts, address + 1.1, L(2.3), 3.36, 0.11, 0.11, 0.03);
                }
                const next = polePlan[index + 1];
                if (!pole.wired || !next.wired) return;
                const nextStagger = next.id % 2 ? 0.18 : -0.18;
                for (let segment = 0; segment < 8; segment++) {
                    const u0 = segment / 8, u1 = (segment + 1) / 8;
                    const sag = u => 7.0 - Math.sin(u * Math.PI) * 0.72;
                    const lateral = u => L(0.2) + (next.side * 0.2 - L(0.2)) * u;
                    wire(address + u0 * spacing, lateral(u0), sag(u0), address + u1 * spacing, lateral(u1), sag(u1));
                    // Feeder along the mast tops.
                    const feeder = u => L(POLE_OFFSET) + (next.side - side) * POLE_OFFSET * u;
                    const droop = u => 7.95 - Math.sin(u * Math.PI) * 0.3;
                    if (side === next.side) wire(address + u0 * spacing, feeder(u0), droop(u0),
                        address + u1 * spacing, feeder(u1), droop(u1));
                    // Droppers hang the level contact wire from the sagging messenger.
                    if (segment % 2 === 1) wire(address + u1 * spacing, lateral(u1), sag(u1), address + u1 * spacing,
                        stagger + (nextStagger - stagger) * u1, CONTACT_Y);
                }
                for (let half = 0; half < 2; half++) wire(address + half * spacing / 2,
                    stagger + (nextStagger - stagger) * half / 2, CONTACT_Y, address + (half + 1) * spacing / 2,
                    stagger + (nextStagger - stagger) * (half + 1) / 2, CONTACT_Y);
            });
            wireGeometry.setDrawRange(0, wireVertex / 3);
            wireGeometry.attributes.position.needsUpdate = true;
            wires.visible = enabled;
            haloGeometry.setDrawRange(0, haloCount);
            haloGeometry.attributes.position.needsUpdate = true;
            halos.visible = enabled && !saving;
            lightAnchors.sort((a, b) => a.distance - b.distance);

            // --- Stations ---
            liveStations = 0;
            stationTypes = [];
            const motifNames = ['sheltered-platform', 'waiting-shelters', 'water-stairs', 'station-house'];
            const beforeStations = sceneryPools.reduce((sum, mesh) => sum + mesh.count, 0);
            for (const { id, address, open, side } of stations) {
                // The steps belong to open water; lit stations rotate through the other three.
                const type = open ? 2 : [0, 1, 3][id % 3];
                const lateral = value => side * value;
                // Whatever would stand between the train and a line being sung is
                // left out, bay by bay: the station keeps an opening there.
                const clear = (at, offset, top) => top < SIGHT_FLOOR || !inSight(track, at, Math.abs(offset), side);
                const part = (mesh, at, offset, y, sx, sy, sz, roll = 0, pitch = 0) => {
                    const pieces = y + sy / 2 < SIGHT_FLOOR ? 1 : Math.max(1, Math.round(sz / 5.5));
                    for (let i = 0; i < pieces; i++) {
                        const z = at - sz / 2 + (i + 0.5) * sz / pieces;
                        if (clear(z, offset, y + sy / 2)) rawPart(mesh, z, offset, y, sx, sy, sz / pieces, roll, pitch);
                    }
                };
                const span = (mesh, at, l0, y0, l1, y1, thick, depth = thick) => {
                    const pieces = Math.max(1, Math.round(depth / 5.5));
                    for (let i = 0; i < pieces; i++) {
                        const z = at - depth / 2 + (i + 0.5) * depth / pieces;
                        if (clear(z, (l0 + l1) / 2, Math.max(y0, y1))) rawSpan(mesh, z, l0, y0, l1, y1, thick, depth / pieces);
                    }
                };
                // All objects remain below/away from the lyric viewing zone:
                // lyric signs stand at +/-18m; shelters stay within +/-10m and
                // take the side with no screen nearby.
                // The platform is a deck on cross walls standing in the water, its
                // edge carried out past them on a beam: coping stones, the white line,
                // and the band of tactile paving a pace back from the edge.
                part(concreteParts, address, lateral(6.5), 0.97, 5, 0.26, 28);
                part(concreteParts, address, lateral(4.3), 0.9, 0.32, 0.36, 28);
                for (let pier = 0; pier < (saving ? 4 : 8); pier++) {
                    part(concreteParts, address - 13.3 + pier * (saving ? 8.87 : 3.8), lateral(6.75), 0.42, 4.3, 0.86, 0.55);
                }
                part(concreteParts, address, lateral(4.2), 1.13, 0.7, 0.08, 28.2);
                part(glowParts, address, lateral(3.84), 1.12, 0.045, 0.035, 28);
                part(paleMarks, address, lateral(4.5), 1.174, 0.07, 0.012, 27.6);
                part(warmMarks, address, lateral(4.95), 1.108, 0.3, 0.016, 27.6);
                part(concreteParts, address, lateral(8.8), 1.25, 0.18, 0.3, 28);
                // Steps run down into the shallows at both ends.
                for (let step = 0; step < 4; step++) {
                    const height = 1.1 - (step + 1) * 0.22;
                    for (const end of [-1, 1]) part(concreteParts, address + end * (14.45 + step * 0.9),
                        lateral(6.5), height / 2, 5, height, 0.9);
                }
                if (!saving && !open) {
                    // A station name board with nothing written on it.
                    for (const post of [-1.35, 1.35])
                        part(steelParts, address + 9.5 + post, lateral(8.45), 2.2, 0.08, 2.2, 0.08);
                    part(timberParts, address + 9.5, lateral(8.45), 2.75, 0.07, 0.85, 3.1);
                    part(concreteParts, address + 9.5, lateral(8.4), 2.48, 0.05, 0.12, 3.1);
                    part(glowParts, address + 9.5, lateral(8.4), 3.21, 0.05, 0.04, 3.1);
                }
                if (!saving && !open) {
                    // A drinks machine, its window the brightest thing on the platform,
                    // and the card reader on its post by the steps.
                    // It stands taller than the sight line allows, so it is all there or not at all.
                    const machine = address - 9.5;
                    if (clear(machine, 8.22, 2.93)) {
                        rawPart(steelParts, machine, lateral(8.22), 2.015, 0.7, 1.83, 1.02);
                        rawPart(coldGlowParts, machine, lateral(7.86), 2.33, 0.02, 0.8, 0.88);
                        rawPart(paleMarks, machine, lateral(7.862), 1.58, 0.02, 0.42, 0.88);
                        rawPart(glowParts, machine + 0.3, lateral(7.855), 1.82, 0.02, 0.05, 0.16);
                        rawPart(steelParts, machine, lateral(7.84), 1.3, 0.05, 0.14, 0.7);
                    }
                    part(steelParts, address + 12.4, lateral(5.5), 1.62, 0.1, 1.04, 0.1);
                    part(steelParts, address + 12.4, lateral(5.5), 2.2, 0.2, 0.14, 0.26, side * 0.5);
                    part(coldGlowParts, address + 12.4, lateral(5.46), 2.275, 0.1, 0.012, 0.12, side * 0.5);
                }
                if (type === 0) {
                    // Butterfly canopy on a single row of Y columns: two roof
                    // planes fold down to a valley gutter over the column line.
                    // Under the sheeting the boards of the ceiling catch the tube
                    // lamps, and the purlins cross them as dark lines.
                    span(steelParts, address, lateral(4.1), 5.62, lateral(7), 5.16, 0.1, 26);
                    span(steelParts, address, lateral(7), 5.16, lateral(9.5), 5.5, 0.1, 26);
                    span(litSurface, address, lateral(4.18), 5.542, lateral(6.86), 5.117, 0.02, 25.9);
                    span(litSurface, address, lateral(7.14), 5.114, lateral(9.42), 5.424, 0.02, 25.9);
                    for (const [offset, y] of [[4.9, 5.37], [6.0, 5.2], [7.9, 5.16], [8.8, 5.28]])
                        part(steelParts, address, lateral(offset), y, 0.07, 0.1, 26);
                    part(steelParts, address, lateral(7), 5.02, 0.32, 0.24, 26);
                    part(steelParts, address, lateral(4.12), 5.56, 0.07, 0.24, 26.1);
                    part(steelParts, address, lateral(9.48), 5.44, 0.07, 0.22, 26.1);
                    for (let bay = 0; bay < 5; bay++) {
                        const z = address - 11 + bay * 5.5;
                        part(steelParts, z, lateral(7), 3.0, 0.22, 3.8, 0.22);
                        part(concreteParts, z, lateral(7), 1.2, 0.42, 0.2, 0.42);
                        span(steelParts, z, lateral(7), 4.15, lateral(4.9), 5.38, 0.1);
                        span(steelParts, z, lateral(7), 4.15, lateral(9.0), 5.33, 0.1);
                        if ((id + bay) % 7 !== 3) {
                            part(glowParts, z + 2.75, lateral(5.5), 5.3, 0.1, 0.04, 2.3);
                            // The batten the tube is fixed to, and its two drops.
                            if (!saving) part(steelParts, z + 2.75, lateral(5.5), 5.345, 0.16, 0.05, 2.5);
                        }
                        // The valley gutter drains down the end columns.
                        if (!saving && (bay === 0 || bay === 4)) {
                            part(steelParts, z + (bay ? 0.17 : -0.17), lateral(7), 3.05, 0.08, 3.7, 0.08);
                            part(steelParts, z + (bay ? 0.17 : -0.17), lateral(7), 1.34, 0.12, 0.08, 0.14);
                        }
                        // Timetable and fare table on the middle columns.
                        if (!saving && (bay === 1 || bay === 3)) {
                            part(steelParts, z, lateral(6.86), 2.45, 0.03, 1.0, 0.74);
                            part(paleMarks, z, lateral(6.84), 2.45, 0.012, 0.9, 0.64);
                        }
                    }
                    if (!saving) {
                        // Hanging platform sign and a back rail.
                        for (const hanger of [-0.8, 0.8])
                            part(steelParts, address - 2.75, lateral(5.6 + hanger), 4.9, 0.03, 0.75, 0.03);
                        part(timberParts, address - 2.75, lateral(5.6), 4.3, 2.1, 0.5, 0.09);
                        part(glowParts, address - 2.75, lateral(5.6), 4.02, 2.1, 0.03, 0.1);
                        for (const y of [1.65, 2.15]) part(steelParts, address, lateral(9.15), y, 0.05, 0.05, 26);
                        for (let post = 0; post <= 8; post++)
                            part(steelParts, address - 13 + post * 3.25, lateral(9.15), 1.65, 0.06, 1.1, 0.06);
                        // The station nameboard stands at the back of the platform
                        // facing the track: a pale panel on two posts with the
                        // line's band across it. It goes up whole or not at all.
                        const board = address + 8.25;
                        if (clear(board, 8.85, 3.2)) {
                            for (const post of [-0.95, 0.95])
                                rawPart(steelParts, board + post, lateral(8.85), 2.1, 0.07, 2.0, 0.07);
                            rawPart(steelParts, board, lateral(8.85), 3.08, 0.12, 0.05, 2.1);
                            rawPart(paleMarks, board, lateral(8.83), 2.55, 0.05, 0.9, 1.84);
                            rawPart(warmMarks, board, lateral(8.8), 2.3, 0.012, 0.1, 1.84);
                        }
                        // A clock hangs from the canopy beside the platform sign.
                        const clock = address + 2.75;
                        if (clear(clock, 5.6, 5)) {
                            rawPart(steelParts, clock, lateral(5.6), 4.86, 0.03, 0.62, 0.03);
                            rawPart(steelParts, clock, lateral(5.6), 4.3, 0.18, 0.54, 0.54);
                            for (const face of [-0.095, 0.095])
                                rawPart(windowLight, clock, lateral(5.6 + face), 4.3, 0.012, 0.44, 0.44);
                        }
                    }
                } else if (type === 1) {
                    // Timber waiting shelters, as on the small platforms along the
                    // bay: a back of upright boards between cheek walls, a lean-to
                    // roof on two posts, one tube lamp under it, a bench and the
                    // timetable inside. Between them the platform is open to the water.
                    // A shelter that would stand in a sight line leaves only its bench.
                    [-4.6, 2.6].forEach((centre, index) => {
                        const z = address + centre;
                        part(timberParts, z, lateral(8.2), 1.56, 0.42, 0.06, 3.2);
                        part(timberParts, z, lateral(8.46), 1.9, 0.05, 0.36, 3.2, side * -0.1);
                        for (const leg of [-1.3, 0, 1.3]) part(steelParts, z + leg, lateral(8.22), 1.33, 0.38, 0.4, 0.05);
                        if (![-2.1, 0, 2.1].every(at => clear(z + at, 7.6, 3.8))) return;
                        rawPart(timberParts, z, lateral(8.62), 2.3, 0.08, 2.4, 4.2);
                        for (const cheek of [-2.1, 2.1]) {
                            rawPart(timberParts, z + cheek, lateral(7.95), 2.3, 1.3, 2.4, 0.08);
                            rawPart(steelParts, z + cheek, lateral(6.75), 2.42, 0.09, 2.6, 0.09);
                            rawPart(concreteParts, z + cheek, lateral(6.75), 1.16, 0.2, 0.12, 0.2);
                        }
                        rawSpan(concreteParts, z, lateral(6.4), 3.8, lateral(8.9), 3.5, 0.06, 4.7);
                        // The lamp's light on the boards behind the bench.
                        if ((id + index) % 5 !== 3) rawPart(windowLight, z, lateral(8.575), 2.85, 0.012, 1.2, 4.0);
                        rawPart(steelParts, z, lateral(6.42), 3.72, 0.05, 0.16, 4.7);
                        rawPart(steelParts, z, lateral(8.62), 3.5, 0.12, 0.1, 4.2);
                        rawPart(steelParts, z, lateral(7.5), 3.6, 0.14, 0.05, 1.5);
                        if ((id + index) % 5 !== 3) rawPart(glowParts, z, lateral(7.5), 3.55, 0.07, 0.04, 1.3);
                        rawPart(steelParts, z - 1.0, lateral(8.555), 2.6, 0.03, 0.7, 1.0);
                        rawPart(paleMarks, z - 1.0, lateral(8.535), 2.6, 0.02, 0.6, 0.9);
                    });
                } else if (type === 2) {
                    // Broad steps descend toward the water, not into the sky.
                    // In open acts they replace dense station silhouettes.
                    for (let step = 0; step < 7; step++) {
                        const height = 1.05 - step * 0.14;
                        part(concreteParts, address, lateral(9.2 + step * 0.65),
                            height * 0.5, 0.7, height, 13 - step * 0.65);
                    }
                    for (const z of [-10, 10]) {
                        part(masts, address + z, lateral(10), 2.5, 0.75, 3.0, 0.75);
                        part(steelParts, address + z, lateral(10), 4.42, 0.56, 0.06, 0.56);
                        part(glowParts, address + z, lateral(10), 4.2, 0.34, 0.38, 0.34);
                    }
                    if (!saving) {
                        // A torii standing alone in the shallows beyond the steps, after
                        // the bronze one on the approach to Enoshima: round columns
                        // leaning in on stone footings, a tie beam run through them and
                        // wedged, a strut carrying the tablet, and a lintel that lifts
                        // towards its ends.
                        const gate = lateral(15.5);
                        for (const z of [-2.9, 2.9]) {
                            part(masts, address + z * 0.975, gate, 3.0, 3.1, 5.9, 3.1, 0, z > 0 ? 0.045 : -0.045);
                            part(concreteParts, address + z, gate, 0.16, 1.05, 0.5, 1.05);
                            part(concreteParts, address + z, gate, 0.5, 0.82, 0.18, 0.82);
                            part(steelParts, address + z * 0.96, gate, 4.92, 0.6, 0.05, 0.16);
                        }
                        part(steelParts, address, gate, 4.7, 0.22, 0.38, 7.5);
                        part(steelParts, address, gate, 5.27, 0.18, 0.76, 0.3);
                        part(timberParts, address, lateral(15.36), 5.27, 0.05, 0.84, 0.58);
                        part(steelParts, address, gate, 5.8, 0.36, 0.3, 6.9);
                        part(steelParts, address, gate, 6.08, 0.54, 0.2, 4.4);
                        for (const end of [-1, 1]) {
                            part(steelParts, address + end * 3.3, gate, 6.17, 0.54, 0.2, 2.3, 0, end * 0.08);
                            part(steelParts, address + end * 3.3, gate, 6.3, 0.62, 0.05, 2.34, 0, end * 0.08);
                        }
                        part(steelParts, address, gate, 6.2, 0.62, 0.05, 4.44);
                        part(coldGlowParts, address, gate, 4.3, 0.2, 0.3, 0.2);
                        part(steelParts, address, gate, 4.47, 0.26, 0.04, 0.26);
                    }
                    // Rocks gathered against the ends of the steps and out past the gate.
                    const pile = seededRandom(`rocks:${id}`);
                    for (const [along, out, size] of [[-8.6, 11.2, 1.25], [-10.9, 13.4, 0.8], [8.2, 12.2, 1.45],
                        [10.8, 10.6, 0.7], [6.4, 17.6, 1.0], [-5.6, 18.4, 0.6]]) {
                        rock(address + along + (pile() - 0.5) * 1.2, lateral(out + (pile() - 0.5) * 1.2),
                            size * (0.85 + pile() * 0.35), pile() * 6.28);
                    }
                } else {
                    // A timber station house along the back of the platform, after
                    // the old ones on the line: boarded walls on a concrete base, a
                    // row of sash windows lit from inside, the ticket window and the
                    // way through beside it, and a tin gable roof whose eaves come out
                    // over the platform. Where it would stand in a sight line only
                    // the boarded fence at its foot is built.
                    const HOUSE = 13, wall = lateral(8.36), face = lateral(8.3);
                    part(concreteParts, address, lateral(9.6), 0.55, 2.4, 1.1, HOUSE);
                    part(timberParts, address, wall, 1.72, 0.1, 1.2, HOUSE);
                    part(steelParts, address, wall, 2.34, 0.16, 0.05, HOUSE + 0.1);
                    if ([-6, -3, 0, 3, 6].every(at => clear(address + at, 9.3, 4.6))) {
                        rawPart(timberParts, address, wall, 2.95, 0.1, 1.2, HOUSE);
                        for (const end of [-1, 1]) {
                            rawPart(timberParts, address + end * HOUSE / 2, lateral(9.4), 2.35, 2.1, 2.5, 0.1);
                            rawPart(steelParts, address + end * HOUSE / 2, lateral(8.36), 2.35, 0.14, 2.5, 0.14);
                            // The gable closes up to the ridge in two steps of boarding.
                            rawPart(timberParts, address + end * HOUSE / 2, lateral(9.4), 3.83, 1.9, 0.46, 0.1);
                            rawPart(timberParts, address + end * HOUSE / 2, lateral(9.4), 4.22, 0.8, 0.32, 0.1);
                        }
                        // Sash windows: a lit pane, its cross of glazing bars, sill and head.
                        [-5.2, -3.2, -1.2, 5.2].forEach((at, index) => {
                            const z = address + at;
                            rawPart((id + index) % 4 === 1 ? warmMarks : windowLight, z, face, 2.6, 0.02, 0.95, 1.3);
                            rawPart(steelParts, z, lateral(8.285), 2.6, 0.03, 0.95, 0.045);
                            rawPart(steelParts, z, lateral(8.285), 2.6, 0.03, 0.045, 1.3);
                            rawPart(steelParts, z, lateral(8.26), 2.1, 0.12, 0.05, 1.44);
                            rawPart(steelParts, z, lateral(8.28), 3.1, 0.05, 0.07, 1.44);
                        });
                        // The ticket window with its counter, and the open way through.
                        rawPart(glowParts, address + 1.0, face, 2.42, 0.02, 0.5, 0.82);
                        rawPart(timberParts, address + 1.0, lateral(8.18), 2.1, 0.34, 0.05, 1.06);
                        rawPart(steelParts, address + 1.0, lateral(8.2), 2.78, 0.26, 0.04, 1.06, side * 0.25);
                        rawPart(windowLight, address + 3.2, face, 2.2, 0.02, 2.0, 1.12);
                        for (const jamb of [-0.6, 0.6]) rawPart(steelParts, address + 3.2 + jamb, lateral(8.28), 2.2, 0.06, 2.06, 0.08);
                        rawPart(steelParts, address + 3.2, lateral(8.28), 3.24, 0.06, 0.08, 1.28);
                        rawPart(paleMarks, address + 2.1, lateral(8.29), 3.02, 0.02, 0.34, 0.34);
                        // Roof: two slopes, the ridge cap, the gutter, and bulbs under the eaves.
                        rawSpan(concreteParts, address, lateral(7.35), 3.42, lateral(9.4), 4.5, 0.07, HOUSE + 1.2);
                        rawSpan(concreteParts, address, lateral(9.4), 4.5, lateral(11.2), 3.55, 0.07, HOUSE + 1.2);
                        rawPart(steelParts, address, lateral(9.4), 4.56, 0.22, 0.1, HOUSE + 1.3);
                        rawPart(steelParts, address, lateral(7.37), 3.36, 0.07, 0.12, HOUSE + 1.2);
                        for (const at of [-4.2, 0, 4.2]) {
                            rawPart(steelParts, address + at, lateral(7.8), 3.5, 0.3, 0.04, 0.3);
                            rawPart(glowParts, address + at, lateral(7.8), 3.42, 0.12, 0.1, 0.12);
                        }
                    }
                }
                for (let seat = 0; seat < (saving ? 1 : 3); seat++) {
                    if ((id + seat) % 4 === 2 || type === 1) continue;
                    const z = address - 7 + seat * 7 + (type === 0 ? 2.75 : type === 3 ? 0.6 - seat * 1.6 : 0);
                    const back = type === 0 ? 8.2 : type === 3 ? 8.2 : 7.25;
                    part(timberParts, z, lateral(back - 0.25), 1.58, 0.5, 0.07, 1.8);
                    part(timberParts, z, lateral(back), 1.95, 0.07, 0.5, 1.8, side * -0.12);
                    for (const leg of [-0.75, 0.75])
                        part(steelParts, z + leg, lateral(back - 0.22), 1.33, 0.46, 0.46, 0.05);
                }
                stationTypes.push(motifNames[type]);
                liveStations++;
            }
            stationInstances = sceneryPools.reduce((sum, mesh) => sum + mesh.count, 0) - beforeStations;

            // --- Level crossings ---
            // A road comes up out of the shallows, crosses the line and goes down
            // again, as the coast road does at every other station along the bay.
            // The train is always passing, so the arms are down and the lamps flash.
            const crossings = [];
            const ROAD = 2.3, crossingPitch = spacing * 11;
            for (let cell = Math.floor((s - 80) / crossingPitch); cell <= Math.floor((s + 260) / crossingPitch)
                && enabled; cell++) {
                if (cell < 0) continue;
                // Midway between two poles, so neither stands in the road.
                const address = cell * crossingPitch + spacing * 5.5;
                if ([-1, 1].some(side => atStation(address, side, 10))) continue;
                crossings.push(address);
                part(timberParts, address, 0, 0.3, 1.26, 0.2, ROAD * 2);
                for (const side of [-1, 1]) {
                    const L = value => side * value;
                    part(concreteParts, address, L(2.0), 0.3, 2.4, 0.2, ROAD * 2);
                    span(concreteParts, address, L(3.2), 0.3, L(8.2), -0.22, 0.2, ROAD * 2);
                    for (const edge of [-1, 1]) {
                        part(concreteParts, address + edge * (ROAD + 0.1), L(4.3), 0.32, 2.2, 0.34, 0.2);
                        // The road's edge line, and a guard rail down the ramp.
                        part(paleMarks, address + edge * (ROAD - 0.22), L(2.0), 0.406, 2.4, 0.012, 0.1);
                        span(steelParts, address + edge * (ROAD + 0.1), L(5.5), 0.86, L(8.1), 0.36, 0.05, 0.05);
                        for (const post of [5.6, 6.8, 8.0])
                            part(steelParts, address + edge * (ROAD + 0.1), L(post), 0.5 - (post - 5.6) * 0.19, 0.06, 0.7, 0.06);
                    }
                    // The stop line.
                    part(paleMarks, address, L(3.05), 0.406, 0.28, 0.012, ROAD * 2 - 0.5);
                    // The signal stands on the left of the road as it comes up to the line.
                    const post = address - side * (ROAD + 0.55), at = L(3.3);
                    const tall = !inSight(track, post, 3.3, side, 4);
                    part(concreteParts, post, at, 0.34, 0.5, 0.5, 0.5);
                    part(masts, post, at, tall ? 2.0 : 1.4, 0.95, tall ? 2.9 : 1.7, 0.95);
                    for (const band of [0.85, 1.25]) part(concreteParts, post, at, band, 0.2, 0.2, 0.2);
                    // Two lamps side by side on a dark board, each under its hood.
                    part(steelParts, post, at, 1.95, 0.07, 0.38, 0.98);
                    for (const lamp of [-0.27, 0.27]) {
                        part(signalLamps, post + lamp, at, 1.95, 0.13, 0.21, 0.21);
                        part(steelParts, post + lamp, at, 2.09, 0.3, 0.03, 0.27);
                    }
                    if (tall) {
                        // The crossed boards, and the bell on top.
                        for (const lean of [-0.6, 0.6]) part(concreteParts, post, at, 2.72, 0.045, 0.15, 1.28, 0, lean);
                        part(steelParts, post, at, 3.5, 0.24, 0.16, 0.24);
                    }
                    // The barrier machine and its arm, down across the road in bands of light and dark.
                    part(steelParts, post, L(3.85), 0.78, 0.34, 0.8, 0.5);
                    for (let band = 0; band < 6; band++) {
                        part(band % 2 ? concreteParts : steelParts, post + side * (0.45 + band * 0.85), L(3.85),
                            1.08, 0.07, 0.07, 0.85);
                    }
                    part(signalLamps, post + side * 3.0, L(3.85), 0.98, 0.07, 0.09, 0.09);
                    rock(address - side * (ROAD + 1.6), L(7.4), 0.75, cell * 2.4 + side);
                    rock(address + side * (ROAD + 1.1), L(6.1), 0.5, cell * 1.3 - side);
                }
            }
            // --- Remains of old piers: weathered posts standing in the shallows ---
            for (let cell = Math.floor((s - 60) / 34); cell <= Math.floor((s + 240) / 34) && enabled && !saving; cell++) {
                if (cell < 0) continue;
                const random = seededRandom(`mooring:${cell}`);
                if (random() > 0.62) continue;
                const address = cell * 34 + random() * 18;
                // Only where no screen stands within reading distance on that side.
                const side = poleSide(track, address);
                const count = 3 + Math.floor(random() * 5), outward = random() > 0.45;
                const reach = 8.5 + random() * 5, lantern = random() > 0.5;
                if (atStation(address, side, 12) || crossings.some(at => Math.abs(at - address) < 14)) continue;
                if (random() > 0.6) rock(address - 1.5, side * (reach + 1.4), 0.55 + random() * 0.5, random() * 6.28, 0.2);
                for (let post = 0; post < count; post++) {
                    const height = 0.9 + random() * 1.7;
                    const at = address + (outward ? (random() - 0.5) * 0.5 : post * 1.9);
                    const lateral = side * (reach + (outward ? post * 1.7 : (random() - 0.5) * 0.5));
                    const lean = [(random() - 0.5) * 0.2, (random() - 0.5) * 0.16];
                    const tall = height + (lantern && post === count - 1 ? 0.35 : 0);
                    // Even a low post is in the way when it stands under a screen being read.
                    if (inSight(track, at, Math.abs(lateral), side, tall > SIGHT_FLOOR ? 3 : 1)) continue;
                    part(timberParts, at, lateral, height / 2 - 0.3, 0.22, height + 0.6, 0.22, lean[0], lean[1]);
                    if (lantern && post === count - 1) {
                        part(steelParts, at, lateral, height + 0.06, 0.2, 0.05, 0.2);
                        part(coldGlowParts, at, lateral, height + 0.2, 0.13, 0.22, 0.13);
                    }
                }
            }
            tintGlow(time);
            updateLights(track, s, saving, audio);
            sceneryPools.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; });
        };
        const renderReflection = (renderer, camera) => {
            if (dead || !reflectionEnabled) return;
            camera.updateMatrixWorld();
            mirror.position.copy(camera.position);
            mirror.position.y *= -1;
            const direction = camera.getWorldDirection(new T.Vector3());
            direction.y *= -1;
            mirror.up.set(0, 1, 0).transformDirection(camera.matrixWorld);
            mirror.up.y *= -1;
            mirror.lookAt(direction.add(mirror.position));
            mirror.near = camera.near;
            mirror.far = camera.far;
            mirror.projectionMatrix.copy(camera.projectionMatrix);
            mirror.updateMatrixWorld();
            textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
                .multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
            const plane = new T.Plane(new T.Vector3(0, 1, 0), 0).applyMatrix4(mirror.matrixWorldInverse);
            const clip = new T.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
            const e = mirror.projectionMatrix.elements;
            const q = new T.Vector4((Math.sign(clip.x) + e[8]) / e[0],
                (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
            const dot = clip.dot(q);
            if (Math.abs(dot) < 0.00001) return;
            clip.multiplyScalar(2 / dot);
            e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1 - 0.001; e[14] = clip.w;
            mirror.projectionMatrixInverse.copy(mirror.projectionMatrix).invert();
            mirror.layers.enable(2);
            const size = renderer.getSize(new T.Vector2());
            // Half the picture's own resolution, within a ceiling per tier.
            const buffer = size.x * renderer.getPixelRatio();
            // The ripples blur the mirror image anyway; below the top tier it
            // is drawn at a sixth of the picture's pixels rather than a quarter.
            const width = Math.round(Math.min(buffer * (quality === 'ultimate' ? 0.5 : 0.4),
                quality === 'ultimate' ? 1440 : quality === 'energy-saving' ? 384 : 960));
            const height = Math.max(1, Math.round(width * size.y / Math.max(1, size.x)));
            if (target.width !== width || target.height !== height) target.setSize(width, height);
            const oldTarget = renderer.getRenderTarget(), oldAutoClear = renderer.autoClear;
            const oldXr = renderer.xr.enabled;
            water.visible = false;
            try {
                renderer.xr.enabled = false;
                renderer.autoClear = true;
                renderer.setRenderTarget(target);
                renderer.clear();
                renderer.render(scene, mirror);
            } finally {
                renderer.setRenderTarget(oldTarget);
                renderer.autoClear = oldAutoClear;
                renderer.xr.enabled = oldXr;
                water.visible = true;
            }
        };
        setPalette();
        return {
            update, setPalette, renderReflection, updateCabin,
            setPixelRatio(ratio) {
                starMat.uniforms.pixelRatio.value = Math.max(0.5, ratio || 1);
                haloMat.uniforms.pixelRatio.value = Math.max(0.5, ratio || 1);
            },
            snapshot: () => ({ liveStations, stationTypes, waterVisible: water.visible, reflectionEnabled,
                warmth: liveWarmth, accent: liveAccent, fogDensity: scene.fog?.density ?? 0,
                lampHalos: halos.visible ? haloGeometry.drawRange.count : 0,
                cabinWeight: cabin.visible ? cabinWeight : 0,
                auroraVisible: Boolean(skyMat.uniforms.auroraActive.value > 0.5),
                starOpacity: starMat.opacity, moonRadius: 20,
                instanceRebuilds, reflectionSize: [target.width, target.height],
                architecturalInstances: stationInstances,
                poolFill: sceneryPools.map(mesh => [mesh.count, mesh.instanceMatrix.count]),
                worldInstances: rails.count + sleepers.count
                    + sceneryPools.reduce((sum, mesh) => sum + mesh.count, 0) }),
            destroy() {
                if (dead) return;
                dead = true;
                scene.remove(root);
                root.traverse(object => { if (object.isInstancedMesh) object.dispose(); });
                released = true;
                scans.forEach(texture => texture.dispose());
                geometries.forEach(g => g.dispose());
                materials.forEach(m => m.dispose());
                target.dispose();
            }
        };
    };
    global.MusicStageDioramaWorld = Object.freeze({ create, poleSide, inSight });
})(window);