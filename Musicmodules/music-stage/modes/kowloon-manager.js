/*
 * 町景：雨夜里的城寨叠楼。管渲染器、档位、镜头导演和歌词状态；
 * 楼体、招牌与歌词屏、巷道与雨夜分别在 kowloon-city / kowloon-signs /
 * kowloon-alley 里，接口见各文件头。
 */
(function (global) {
    'use strict';
    const U = global.MusicStageModeUtils;
    const R = global.MusicStageRuntime;

    const ease = (t) => t * t * (3 - 2 * t);
    const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

    /*
     * 镜头：每段歌词选一个机位，机位内是慢速运动（绕、推、移），机位之间用
     * 1.4 秒缓动过渡，不硬切。唱着的时候只选能看清主屏的机位；间奏和
     * 句与句之间留白长的时候才去巷子和屋顶。
     */
    const createDirector = (layout) => {
        const C = layout.CAMERA;
        const screen = layout.SCREENS.find(s => s.primary);
        const rigs = {
            iso: (t, seed) => {
                const a = (seed - 0.5) * 0.5 + (t - 0.5) * (C.iso.orbit * Math.PI / 180) * 0.6;
                const base = C.iso.position, target = C.iso.target;
                const dx = base[0] - target[0], dz = base[2] - target[2];
                const r = Math.hypot(dx, dz), a0 = Math.atan2(dx, dz) + a;
                const zoom = 1 - t * 0.08;
                return { position: [target[0] + Math.sin(a0) * r * zoom, base[1] * zoom, target[2] + Math.cos(a0) * r * zoom], look: target, fov: C.iso.fov };
            },
            street: (t, seed) => {
                const dir = seed < 0.5 ? 1 : -1;
                const k = dir > 0 ? t : 1 - t;
                const p = lerp3(C.street.from, C.street.to, 0.15 + k * 0.7);
                const look = [screen.center[0] + (p[0] - screen.center[0]) * 0.45, C.street.target[1], screen.center[2]];
                return { position: p, look, fov: C.street.fov };
            },
            screen: (t) => {
                const p = C.screen.position;
                const z = p[2] - t * 4;
                return { position: [p[0] - 6 + t * 3, p[1] - 3 + t * 1.5, z], look: C.screen.target, fov: C.screen.fov };
            },
            // 固定斜俯视：几道周期互不成倍数的慢正弦，绕、俯仰、推拉都很轻。
            diorama: (t, seed, time = 0) => {
                const wave = (period, phase) => Math.sin(time / period * Math.PI * 2 + phase);
                const base = C.iso.position, target = C.iso.target;
                const dx = base[0] - target[0], dz = base[2] - target[2];
                const r = Math.hypot(dx, dz, base[1] - target[1]);
                const az = Math.atan2(dx, dz) + (15 * wave(67, 0) + 5 * wave(29, 1.3)) * Math.PI / 180;
                const el = Math.asin((base[1] - target[1]) / r) + 4 * wave(47, 0.7) * Math.PI / 180;
                const k = r * Math.exp(0.06 * wave(41, 2.1));
                return {
                    position: [target[0] + Math.sin(az) * Math.cos(el) * k, target[1] + Math.sin(el) * k, target[2] + Math.cos(az) * Math.cos(el) * k],
                    look: target, fov: C.iso.fov
                };
            },
            roof: (t, seed) => {
                const from = seed < 0.5 ? C.roof.from : C.roof.to, to = seed < 0.5 ? C.roof.to : C.roof.from;
                const p = lerp3(from, to, 0.1 + t * 0.35);
                const ahead = lerp3(from, to, 0.6 + t * 0.35);
                return { position: p, look: [ahead[0], ahead[1] - 20, ahead[2]], fov: C.roof.fov };
            }
        };
        let extra = [];
        let current = null, previous = null;
        const pick = (frame, key, segStart, segEnd) => {
            const seed = (L().hash(key) % 1000) / 1000;
            const singing = Boolean(frame.activeLine);
            const pool = singing ? ['iso', 'street', 'screen', 'iso'] : ['roof', 'iso', ...extra.map(r => r.id)];
            const last = current?.id;
            let id = pool[Math.floor(seed * pool.length)];
            if (id === last && pool.length > 1) id = pool[(pool.indexOf(id) + 1) % pool.length];
            return { id, seed, start: segStart, end: Math.max(segStart + 4, segEnd), key };
        };
        const L = () => global.MusicStageKowloonLayout;
        const evalRig = (shot, time) => {
            const t = Math.min(1, Math.max(0, (time - shot.start) / Math.max(0.1, shot.end - shot.start)));
            if (rigs[shot.id]) return rigs[shot.id](t, shot.seed, time);
            const rig = extra.find(r => r.id === shot.id);
            if (rig) {
                const f = t * (rig.points.length - 1);
                const i = Math.min(rig.points.length - 2, Math.floor(f));
                const k = f - i;
                return { position: lerp3(rig.points[i], rig.points[i + 1], k), look: lerp3(rig.look[i], rig.look[i + 1], k), fov: rig.fov || 55 };
            }
            return rigs.iso(t, shot.seed);
        };
        const director = {
            force: null,
            setExtraRigs(list) { extra = Array.isArray(list) ? list.filter(r => r?.points?.length >= 2) : []; },
            mode: 'auto',
            pose(frame, time) {
                if (director.mode === 'diorama' && !director.force) return { id: 'diorama', ...rigs.diorama(0, 0, time) };
                if (director.force) {
                    const { id, t } = director.force;
                    return { id, ...evalRig({ id, seed: 0.3, start: 0, end: 1 }, t) };
                }
                const line = frame.activeLine;
                const key = line ? `l:${line.startTime}` : `gap:${Math.floor(time / 9)}`;
                if (!current || !director.hold && current.key !== key && time - current.start > 5.5 || time < current.start - 0.5) {
                    const start = line ? line.startTime : Math.floor(time / 9) * 9;
                    const end = line ? (frame.nextLines?.[0]?.startTime ?? line.endTime + 2) : start + 9;
                    previous = current && time >= current.start ? { shot: current, at: time } : null;
                    current = pick(frame, key, Math.min(start, time), end);
                }
                const now = evalRig(current, time);
                if (previous && time - previous.at < 1.4) {
                    const before = evalRig(previous.shot, time);
                    const k = ease((time - previous.at) / 1.4);
                    return { id: current.id, position: lerp3(before.position, now.position, k), look: lerp3(before.look, now.look, k), fov: before.fov + (now.fov - before.fov) * k };
                }
                return { id: current.id, ...now };
            },
            reset() { current = previous = null; }
        };
        return director;
    };

    // 截图脚本用：拿到最近一个实例，固定机位。
    let lastInstance = null;
    /*
     * 拖拽看景：按住拖动绕着当前机位的注视点转、滚轮推拉；松手 8 秒后慢慢
     * 回到导演给的机位。只是叠在机位上的偏移，不改导演的安排。
     */
    const createOrbit = () => {
        const view = { az: 0, el: 0, zoom: 1 };
        let dragging = null, idleSince = -Infinity, wake = () => {};
        const LIMIT = { az: 75 * Math.PI / 180, elMin: -25 * Math.PI / 180, elMax: 30 * Math.PI / 180, zMin: 0.35, zMax: 2.2 };
        const clampView = () => {
            view.az = Math.max(-LIMIT.az, Math.min(LIMIT.az, view.az));
            view.el = Math.max(LIMIT.elMin, Math.min(LIMIT.elMax, view.el));
            view.zoom = Math.max(LIMIT.zMin, Math.min(LIMIT.zMax, view.zoom));
        };
        return {
            attach(scope, element, onWake) {
                wake = onWake;
                scope.listen(element, 'pointerdown', event => {
                    if (event.button !== 0) return;
                    dragging = { x: event.clientX, y: event.clientY, id: event.pointerId };
                    element.setPointerCapture?.(event.pointerId);
                    element.style.cursor = 'grabbing';
                });
                scope.listen(element, 'pointermove', event => {
                    if (!dragging || event.pointerId !== dragging.id) return;
                    view.az -= (event.clientX - dragging.x) * 0.005;
                    view.el += (event.clientY - dragging.y) * 0.004;
                    dragging.x = event.clientX; dragging.y = event.clientY;
                    clampView(); idleSince = performance.now(); wake();
                });
                const end = event => {
                    if (!dragging || event.pointerId !== dragging.id) return;
                    dragging = null; idleSince = performance.now(); element.style.cursor = '';
                };
                scope.listen(element, 'pointerup', end);
                scope.listen(element, 'pointercancel', end);
                scope.listen(element, 'wheel', event => {
                    event.preventDefault();
                    view.zoom *= Math.exp(event.deltaY * 0.0012);
                    clampView(); idleSince = performance.now(); wake();
                }, { passive: false });
                scope.listen(element, 'dblclick', () => { view.az = view.el = 0; view.zoom = 1; wake(); });
            },
            get active() { return Boolean(dragging) || performance.now() - idleSince < 8000 || Math.abs(view.az) + Math.abs(view.el) + Math.abs(view.zoom - 1) > 0.002; },
            // 每帧：闲着够久就往回收；返回叠加了偏移的机位。
            apply(pose, dt) {
                if (!dragging && performance.now() - idleSince > 8000) {
                    const k = 1 - Math.exp(-Math.max(0, dt) * 1.2);
                    view.az -= view.az * k; view.el -= view.el * k; view.zoom += (1 - view.zoom) * k;
                }
                if (Math.abs(view.az) + Math.abs(view.el) + Math.abs(view.zoom - 1) < 1e-4) return pose;
                const [px, py, pz] = pose.position, [lx, ly, lz] = pose.look;
                const dx = px - lx, dy = py - ly, dz = pz - lz;
                const r = Math.hypot(dx, dy, dz);
                const az = Math.atan2(dx, dz) + view.az;
                const el = Math.max(-0.2, Math.min(1.45, Math.asin(dy / r) + view.el));
                const k = r * view.zoom;
                return { ...pose, position: [lx + Math.sin(az) * Math.cos(el) * k, Math.max(0.8, ly + Math.sin(el) * k), lz + Math.cos(az) * Math.cos(el) * k] };
            }
        };
    };

    const create = (container, services) => {
        const mode = U.makeModeBase('kowloon', '町景', container, services);
        const fallback = U.createElement('div', 'kowloon-fallback diorama-fallback');
        const fallbackLine = U.createElement('div', 'diorama-fallback-line');
        const translation = U.createElement('div', 'stage-translation diorama-fallback-translation');
        fallback.append(fallbackLine, translation);
        mode.root.append(fallback);
        const reduced = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let T, scene, camera, renderer, layout, city, signs, alley, optics, director, shared, placeholderLights = [];
        let initialized = false, fallbackMode = false, initializing = null;
        let latest = null, lastTime = null, width = 1, height = 1, shotId = '';
        let dirty = true, lastWall = 0;
        const orbit = createOrbit();
        const cap = U.createFrameCap();
        const onset = R.createAudioOnset();
        const audio = { energy: 0, bass: 0, vocal: 0, impact: 0 };
        const palette = () => services?.app?.stagePalette || {};
        const options = () => ({ ...(mode.config.modes?.kowloon || {}), reducedMotion: Boolean(reduced?.matches), quality: mode.config.quality });
        const renderScale = U.createRenderScale();
        const showCaption = () => !signs;

        const renderFallback = frame => {
            const key = U.getLineKey(frame.activeLine);
            if (fallbackLine.dataset.key !== key) {
                fallbackLine.dataset.key = key;
                if (frame.activeLine) U.renderWords(fallbackLine, frame, 'diorama-word');
                else fallbackLine.textContent = frame.track?.title || '等待音乐';
                translation.textContent = R.resolveSupplementalText(frame.activeLine);
            }
            U.updateWords(Array.from(fallbackLine.children), frame.wordStates || []);
        };
        const resize = () => {
            width = Math.max(1, mode.root.clientWidth || global.innerWidth || 1);
            height = Math.max(1, mode.root.clientHeight || global.innerHeight || 1);
            if (!renderer) return;
            renderer.setPixelRatio(renderScale.ratio(mode.config.quality, width, height));
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
        };
        const modules = () => [alley, city, signs].filter(Boolean);
        const disposeGraphics = () => {
            modules().forEach(m => { try { m.dispose(); } catch (error) { console.warn('[MusicStage:Kowloon] dispose', error); } });
            optics?.destroy();
            city = signs = alley = optics = null;
            renderer?.dispose();
            renderer?.forceContextLoss();
            renderer?.domElement.remove();
            renderer = camera = scene = null;
            initialized = false;
            dirty = true;
        };

        const lyricState = (frame, time) => {
            const line = frame.activeLine;
            if (!line) return { key: '', line: null, words: [], progress: 0, translation: '', next: frame.nextLines?.[0] ? { text: frame.nextLines[0].fullText } : null, prev: frame.previousLine ? { text: frame.previousLine.fullText } : null };
            const words = (frame.wordStates || []).map(w => ({ text: w.text, start: w.startTime, end: w.endTime, progress: w.progress, status: w.status }));
            return {
                key: U.getLineKey(line), line: line.fullText, words, progress: frame.lineProgress || 0,
                start: line.startTime, end: line.endTime, isChorus: Boolean(line.isChorus),
                translation: R.resolveSupplementalText(line),
                next: frame.nextLines?.[0] ? { text: frame.nextLines[0].fullText } : null,
                prev: frame.previousLine ? { text: frame.previousLine.fullText } : null,
                time
            };
        };

        const update = (frame, force = false) => {
            if (mode.destroyed || mode.suspended) return;
            latest = frame;
            if (!initialized) {
                renderFallback(frame);
                if (!fallbackMode) void initialize();
                return;
            }
            const still = !frame.isPlaying && lastTime !== null && R.finiteNumber(frame.playbackTime) === lastTime;
            if (!force && !dirty && (still || !cap.take(performance.now(), mode.config.quality))) return;
            dirty = false;
            const time = R.finiteNumber(frame.playbackTime);
            const dt = lastTime === null ? 0 : Math.max(0, Math.min(0.25, time - lastTime));
            const live = onset.update(frame);
            const gain = R.clamp((mode.config.modes?.kowloon?.audioReactivity) ?? 1, 0, 2);
            audio.energy = live.energy * gain;
            audio.impact = live.impact * gain;
            audio.bass = R.clamp(frame.audio?.bass) * gain;
            audio.vocal = R.clamp(frame.audio?.vocal) * gain;

            const settings = options();
            director.mode = settings.cameraMode === 'diorama' ? 'diorama' : 'auto';
            // 看景时导演不换机位，免得手里的画面被切走。
            director.hold = orbit.active;
            const pose = orbit.apply(director.pose(frame, time), performance.now() / 1000 - (lastWall || performance.now() / 1000));
            lastWall = performance.now() / 1000;
            if (pose.id !== shotId) shotId = pose.id;
            camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
            camera.lookAt(pose.look[0], pose.look[1], pose.look[2]);
            if (camera.fov !== pose.fov) { camera.fov = pose.fov; camera.updateProjectionMatrix(); }
            camera.updateMatrixWorld();

            const state = {
                time: settings.reducedMotion ? 0 : time, dt, playbackTime: time, isPlaying: frame.isPlaying,
                audio, lyric: lyricState(frame, time), camera, shot: pose.id, options: settings,
                lines: frame.lines || [],
                track: { title: services?.app?.stripAudioExtension?.(frame.track?.title) || frame.track?.title || '', artist: frame.track?.artist || '' }
            };
            state.song = state.track;
            shared.uTime.value = state.time;
            // 渲染顺序：巷道先（它要画积水反射），再楼体、招牌。
            modules().forEach(m => m.update(state));
            global.MusicStageKowloonShared.gatherLights(shared, modules().map(m => m.lights?.()).concat([signs ? [] : placeholderLights]), camera);

            if (showCaption()) { fallback.hidden = false; renderFallback(frame); }
            else fallback.hidden = true;
            if (frame.isPlaying && renderScale.tick(performance.now(), cap.aim(mode.config.quality))) resize();
            renderer.info.reset();
            const tuned = mode.config.modes?.kowloon || {};
            const lens = { ...tuned, threshold: tuned.threshold ?? 0.95, glow: tuned.glow ?? 1.1, grain: tuned.grain ?? 0.06, vignette: tuned.vignette ?? 0.28 };
            if (optics) optics.render(renderer, scene, camera, settings.reducedMotion ? 0 : time, mode.config, lens);
            else renderer.render(scene, camera);
            lastTime = time;
        };

        const initialize = () => {
            if (initializing) return initializing;
            initializing = Promise.resolve().then(async () => {
                if (!global.MusicStageKowloonLayout || !global.MusicStageKowloonCity || !global.MusicStageKowloonShared) {
                    throw new Error('Kowloon modules are unavailable');
                }
                T = global.THREE || await import('../../../vendor/three.module.js');
                if (mode.destroyed) return;
                scene = new T.Scene();
                scene.background = new T.Color(0x0b1018);
                scene.fog = new T.FogExp2(0x101822, 0.0042);
                camera = new T.PerspectiveCamera(32, 1, 0.3, 2400);
                const lensOn = global.MusicStageDioramaOptics?.active(mode.config, mode.config.modes?.kowloon || {}) ?? false;
                renderer = new T.WebGLRenderer({ antialias: !lensOn, alpha: false, powerPreference: 'high-performance' });
                renderer.debug.checkShaderErrors = false;
                renderer.outputColorSpace = T.SRGBColorSpace;
                renderer.toneMapping = T.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.1;
                renderer.info.autoReset = false;
                renderer.domElement.className = 'diorama-canvas kowloon-canvas';
                mode.root.insertBefore(renderer.domElement, fallback);
                const canvas = renderer.domElement;
                canvas.style.touchAction = 'none';
                orbit.attach(mode.scope, canvas, () => { dirty = true; if (latest && !latest.isPlaying) update(latest, true); });
                mode.scope.listen(canvas, 'webglcontextlost', event => {
                    event.preventDefault();
                    if (renderer?.domElement !== canvas) return;
                    fallbackMode = true;
                    disposeGraphics();
                    if (latest) renderFallback(latest);
                });
                layout = global.MusicStageKowloonLayout.build('kowloon');
                shared = global.MusicStageKowloonShared.createLightUniforms(T);
                const tier = { name: mode.config.quality || 'standard', ...U.tier(mode.config.quality) };
                const ctx = { scene, renderer, camera, layout, palette: palette(), tier, options: options(), lightUniforms: shared, rand: s => global.MusicStageKowloonLayout.rng(s) };
                // 巷道先建：它定雾、天空和湿度。
                if (global.MusicStageKowloonAlley?.create) alley = global.MusicStageKowloonAlley.create(T, ctx);
                city = global.MusicStageKowloonCity.create(T, ctx);
                ctx.city = city;
                if (global.MusicStageKowloonSigns?.create) signs = global.MusicStageKowloonSigns.create(T, ctx);
                if (!alley) {
                    // 巷道模块还没并进来：先铺一块湿地面，好看楼体落地。
                    shared.uWet.value = 0.7;
                    const ground = new T.Mesh(new T.PlaneGeometry(1200, 1200), new T.MeshBasicMaterial({ color: 0x07090c }));
                    ground.rotation.x = -Math.PI / 2;
                    ground.name = 'kowloon-placeholder-ground';
                    scene.add(ground);
                }
                // 招牌模块还没并进来时，用一组占位霓虹光看楼体受光。
                placeholderLights = signs ? [] : layout.slots(sl => sl.use === 'sign' && sl.floor <= 4)
                    .filter((_, i) => i % 7 === 0).map((sl, i) => ({
                        position: [sl.pos[0] + sl.normal[0] * 1.2, sl.pos[1], sl.pos[2] + sl.normal[2] * 1.2],
                        color: [[1, 0.2, 0.55], [0.2, 0.9, 1], [1, 0.55, 0.15], [0.4, 1, 0.5], [0.7, 0.3, 1]][i % 5],
                        intensity: 1.6, radius: 9
                    }));
                director = createDirector(layout);
                director.setExtraRigs(alley?.cameraRigs?.());
                modules().forEach(m => m.setTier?.(tier));
                optics = global.MusicStageDioramaOptics?.create(T);
                resize();
                await U.precompile(T, renderer, scene, camera, { canvas: !lensOn, offscreen: true });
                if (mode.destroyed || !renderer) return;
                initialized = true;
                dirty = true;
                if (latest) update(latest, true);
            }).catch(error => {
                disposeGraphics();
                fallbackMode = true;
                if (!mode.destroyed) {
                    console.warn('[MusicStage:Kowloon] 使用文字降级：', error);
                    if (latest) renderFallback(latest);
                }
            });
            return initializing;
        };

        mode.updateFrame = frame => update(frame);
        mode.resize = () => { resize(); if (latest && initialized) update(latest, true); };
        const baseConfig = mode.updateConfig;
        mode.updateConfig = config => {
            baseConfig(config);
            if (initialized) {
                const tier = { name: mode.config.quality || 'standard', ...U.tier(mode.config.quality) };
                modules().forEach(m => { m.setTier?.(tier); m.setOptions?.(options()); });
            }
            resize();
            if (latest) update(latest, true);
        };
        mode.updateTheme = () => {
            if (initialized) modules().forEach(m => m.setPalette?.(palette()));
            if (latest) update(latest, true);
        };
        const resume = mode.resume;
        mode.resume = () => { resume(); cap.reset(); if (latest) update(latest, true); };
        mode.getDebugSnapshot = () => ({
            initialized, fallbackMode, shot: shotId,
            camera: camera?.position.toArray(),
            drawCalls: renderer?.info.render.calls, triangles: renderer?.info.render.triangles,
            geometries: renderer?.info.memory.geometries, textures: renderer?.info.memory.textures,
            programs: renderer?.info.programs?.length,
            lights: shared?.uLightCount.value,
            ...(initialized ? Object.assign({}, ...modules().map(m => m.stats?.() || {})) : null)
        });
        // harness 用：固定机位截图。
        mode.debugScene = () => ({ scene, camera, renderer, T });
        mode.debugSetShot = (id, t = 0.5) => { if (director) director.force = id ? { id, t } : null; dirty = true; if (latest) update(latest, true); };
        mode.scope.add(() => { disposeGraphics(); latest = null; });
        resize();
        void initialize();
        lastInstance = mode;
        return mode;
    };

    global.MusicStageKowloonManager = Object.freeze({ create, createDirector, debugInstance: () => lastInstance });
})(window);
