(function (global) {
    'use strict';

    const Runtime = global.MusicStageRuntime;
    if (!Runtime) throw new Error('MusicStageRuntime must load before stage-mode-utils.js');

    const { clamp, hashString, seededRandom, splitGraphemes, DisposableScope } = Runtime;

    const createElement = (tag, className = '', text = undefined) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };

    const getLineKey = (line) => line
        ? `${line.index}:${line.startTime}:${line.endTime}:${line.fullText}`
        : 'empty';

    const createWord = (state, index, className = '') => {
        const element = createElement('span', `stage-word ${className}`.trim(), state?.text || '');
        element.dataset.wordIndex = String(index);
        updateWord(element, state, index);
        return element;
    };

    const updateWord = (element, state, index) => {
        if (!element) return;
        const progress = clamp(Number(state?.progress) || 0);
        element.dataset.text = state?.text || element.textContent || '';
        element.style.setProperty('--stage-word-progress', `${(progress * 100).toFixed(2)}%`);
        element.style.setProperty('--stage-word-order', String(index));
        element.classList.toggle('is-active', state?.status === 'active');
        element.classList.toggle('is-passed', state?.status === 'passed');
        element.classList.toggle('is-waiting', state?.status === 'waiting');
    };

    const renderWords = (container, frame, className = '') => {
        const elements = (frame.wordStates || []).map((state, index) => createWord(state, index, className));
        container.replaceChildren(...elements);
        return elements;
    };

    const updateWords = (elements, states) => {
        elements.forEach((element, index) => updateWord(element, states?.[index], index));
    };

    // Resolve CSS colors once per theme change, never in the animation loop.
    // The browser handles variables, named colors, hsl and color-mix for us.
    const refreshTheme = (app, root = document.body) => {
        // Custom stage palettes carry their own light/dark state. In global
        // mode, retain the application's authoritative theme state.
        const stage = root?.closest?.('.music-stage');
        const custom = stage?.classList.contains('stage-theme-custom');
        const light = custom ? stage.classList.contains('stage-theme-light')
            : app?.currentTheme === 'light' || document.body.classList.contains('light-theme');
        const defaults = light
            ? ['#f2efe7', '#fcfaf4', '#1b211f', '#626a66', '#b94832', '#21675c', '#21675c']
            : ['#171a1d', '#20252a', '#f2f0e9', '#a7afb1', '#f2a900', '#76bfae', '#76bfae'];
        defaults.push(...(light
            ? ['#f2efe7', '#e7e1d5', '#d2cbc0', '#b94832']
            : ['#171a1d', '#2a3035', '#3b4449', '#f2a900']));
        const names = ['background', 'surface', 'ink', 'muted', 'accent', 'secondary', 'tertiary',
            'deep', 'material', 'border', 'emission'];
        const variables = ['--primary-bg', '--secondary-bg', '--primary-text', '--secondary-text',
            '--highlight-text', '--success-color', '--quoted-text',
            '--tertiary-bg', '--accent-bg', '--border-color', '--button-bg'];
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
        root.appendChild(probe);
        const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        const palette = { light };
        try {
            names.forEach((name, index) => {
                probe.style.color = `var(${variables[index]}, ${defaults[index]})`;
                let hex = defaults[index];
                if (context?.getImageData) {
                    context.clearRect(0, 0, 1, 1);
                    context.fillStyle = defaults[index];
                    context.fillStyle = global.getComputedStyle(probe).color;
                    context.fillRect(0, 0, 1, 1);
                    const data = context.getImageData(0, 0, 1, 1).data;
                    hex = '#' + Array.from(data).slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
                }
                palette[name] = hex;
            });
        } finally {
            probe.remove();
        }
        const n = parseInt(palette.accent.slice(1), 16);
        palette.accentRgb = Object.freeze({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 });
        app.stagePalette = Object.freeze(palette);
        return app.stagePalette;
    };

    const resolveAccent = (app) => {
        const color = app?.stagePalette?.accentRgb || app?.visualizerColor || { r: 121, g: 216, b: 255 };
        return {
            r: clamp(Number.isFinite(color.r) ? color.r : 121, 0, 255),
            g: clamp(Number.isFinite(color.g) ? color.g : 216, 0, 255),
            b: clamp(Number.isFinite(color.b) ? color.b : 255, 0, 255)
        };
    };

    const makeModeBase = (id, label, container, services) => {
        const scope = new DisposableScope();
        const root = createElement('section', `music-stage-mode music-stage-mode-${id}`);
        root.dataset.mode = id;
        container.appendChild(root);
        let config = services?.config || global.MusicStageConfig?.get?.() || {};
        let destroyed = false;
        let suspended = false;

        return {
            id,
            label,
            root,
            scope,
            services,
            get config() { return config; },
            get suspended() { return suspended; },
            get destroyed() { return destroyed; },
            updateConfig(next) { config = next || config; },
            activate() { suspended = false; },
            suspend() { suspended = true; },
            resume() { suspended = false; },
            updateTheme() {},
            resize() {},
            updateTrack() {},
            updateLyrics() {},
            destroy() {
                if (destroyed) return;
                destroyed = true;
                scope.destroy();
                root.replaceChildren();
                root.remove();
            }
        };
    };

    /*
     * How large a 3D mode draws. A device pixel ratio cap alone lets a
     * maximised window on a 4K screen shade eight million pixels a frame,
     * several times over once reflections and post-processing are added; the
     * drawing buffer is held to a pixel budget instead, and steps down further
     * while the frame rate is not being held.
     */
    const PIXEL_BUDGET = Object.freeze({ 'energy-saving': 1.0e6, standard: 2.4e6, ultimate: 4.2e6 });
    const RATIO_CAP = Object.freeze({ 'energy-saving': 1, standard: 1.5, ultimate: 2 });
    /*
     * When the frame rate is not being held, a 3D mode steps down a rung at a
     * time: first fewer pixels, then the next lower tier (ultimate drops its
     * multisampling; standard drops the lens and caps at 30 frames), then
     * fewer pixels again. The lyrics are in the scene, so the picture is not
     * shrunk all the way before the effects go. Pixels come back, one rung at
     * a time, after a long steady stretch, waiting twice as long each time.
     */
    const TIER_ORDER = ['ultimate', 'standard', 'energy-saving'];
    const LADDER = ['scale', 'scale', 'tier', 'scale', 'scale', 'tier'];
    const SCALE_STEP = 0.84;
    const createRenderScale = () => {
        let rung = 0;
        let last = 0;
        let average = 0;
        let frames = 0;
        let steady = 0;
        let patience = 900;
        let longRun = 0, strikes = 0;
        let derivedFrom = null, derived = null, derivedDrop = 0;
        const taken = () => LADDER.slice(0, rung);
        const scaleSteps = () => taken().filter(step => step === 'scale').length;
        const tierDrops = () => taken().filter(step => step === 'tier').length;
        return {
            get factor() { return Math.max(0.55, SCALE_STEP ** scaleSteps()); },
            // How many rungs down the ladder this mode has gone, for the settings.
            get steps() { return rung; },
            // The tier this mode draws at: the chosen one, less what it had to drop.
            quality(quality) {
                const drops = tierDrops();
                if (!drops) return quality;
                const from = Math.max(0, TIER_ORDER.indexOf(quality));
                return TIER_ORDER[Math.min(TIER_ORDER.length - 1, from + drops)];
            },
            // The configuration with that tier, the same object while nothing changes.
            config(config) {
                const drops = tierDrops();
                if (!drops || !config) return config;
                if (derivedFrom !== config || derivedDrop !== drops) {
                    derivedFrom = config; derivedDrop = drops;
                    derived = { ...config, quality: this.quality(config.quality) };
                }
                return derived;
            },
            ratio(quality, width, height) {
                const budget = PIXEL_BUDGET[quality] || PIXEL_BUDGET.standard;
                const cap = RATIO_CAP[quality] || RATIO_CAP.standard;
                const fit = Math.sqrt(budget / Math.max(1, width * height));
                return Math.max(0.5, Math.min(cap, global.devicePixelRatio || 1, fit) * this.factor);
            },
            // Start again from the top, e.g. after the listener chose a tier.
            reset() { rung = 0; frames = 0; steady = 0; patience = 900; strikes = 0; },
            // Feed the time of every drawn frame, and the interval the frame
            // cap aims for. Returns true when the drawing changed.
            tick(now, aim = 0) {
                let interval = now - last;
                last = now;
                if (!(interval > 0) || interval > 2000) { frames = 0; longRun = 0; return false; }
                // One long frame is a seek or a rebuild, not a slow renderer;
                // several in a row (a machine managing a few frames a second) are.
                if (interval > 250) {
                    longRun += 1;
                    if (longRun < 3) { frames = 0; return false; }
                    interval = 250;
                } else longRun = 0;
                average = frames ? average * 0.92 + interval * 0.08 : interval;
                frames += 1;
                // Enough frames to judge: 45, or one and a half seconds at a few a second.
                if (frames < 45 && frames * average < 1500) return false;
                // Slow means well behind the cap, or under about 43 frames a second without one.
                const slow = Math.max(23, aim * 1.3);
                const fast = Math.max(17.6, aim * 1.08);
                if (average > slow && rung < LADDER.length) {
                    frames = 0; steady = 0;
                    // A tier drop does not come back by itself, so a moment of
                    // load (a song change, another app busy) must not cause it:
                    // it takes two slow judgements in a row.
                    if (LADDER[rung] === 'tier' && ++strikes < 2) return false;
                    strikes = 0;
                    rung += 1;
                    return true;
                }
                strikes = 0;
                // A dropped tier caps the frame rate lower, so the frame times can no
                // longer show whether it would cope: it stays down until the
                // listener picks a tier again (reset).
                if (rung > 0 && LADDER[rung - 1] === 'scale' && average < fast) {
                    steady += 1;
                    if (steady > patience) {
                        // Try the rung above again, and wait longer before the next try.
                        rung -= 1;
                        patience *= 2; frames = 0; steady = 0;
                        return true;
                    }
                } else steady = 0;
                return false;
            }
        };
    };

    /*
     * What each quality tier asks of the GPU, in one place so both 3D modes
     * agree. The canvas itself is only antialiased when nothing is drawn over
     * it afterwards: with the lens on, the scene is drawn into its own target
     * and the canvas's multisampled buffer would only cost memory and a resolve.
     */
    const TIERS = Object.freeze({
        'energy-saving': Object.freeze({ fps: 30, lens: false, samples: 0 }),
        standard: Object.freeze({ fps: 60, lens: true, samples: 0 }),
        ultimate: Object.freeze({ fps: 0, lens: true, samples: 4 })
    });
    const tier = (quality) => TIERS[quality] || TIERS.standard;

    /*
     * Draws at most the tier's frame rate. A 120 or 144 Hz display would
     * otherwise have the stage drawn twice as often as anyone can follow a
     * camera move, at twice the power. Returns true when this frame is drawn.
     */
    // The player's duration comes from polling and can wobble by a few
    // milliseconds; only a real change is worth rebuilding the whole song for.
    const durationChanged = (compiled, next) =>
        Number.isFinite(compiled) && Number.isFinite(next) ? Math.abs(compiled - next) > 0.5 : !Object.is(compiled, next);

    const createFrameCap = () => {
        let last = -Infinity;
        return {
            aim(quality) { const fps = tier(quality).fps; return fps ? 1000 / fps : 0; },
            take(now, quality) {
                const aim = this.aim(quality);
                // A little early is still this frame: display intervals jitter.
                if (aim && now - last < aim - 3) return false;
                last = aim && now - last < aim * 2 ? last + aim : now;
                return true;
            },
            reset() { last = -Infinity; }
        };
    };

    /*
     * Compile every material in the scene, visible or not, before the first
     * frame. Otherwise each effect compiles its shaders the first time it
     * appears, and on Windows that stalls the frame for tens to hundreds of
     * milliseconds right at the chorus. A material drawn into an offscreen
     * target (the lens, the water) compiles differently from one drawn to the
     * canvas, so it is compiled for each place the frame will draw it.
     */
    /*
     * Compile what the scene draws and wait until the driver has linked it.
     * The renderer's own wait throws from a timer once the renderer has been
     * disposed (a stage left before its warm-up finished); this one just stops.
     */
    const compileReady = (renderer, scene, camera) => {
        if (!renderer.compileAsync || !renderer.properties) {
            renderer.compile(scene, camera);
            return Promise.resolve();
        }
        const waiting = renderer.compile(scene, camera);
        return new Promise((resolve) => {
            const check = () => {
                try {
                    for (const material of waiting) {
                        const program = renderer.properties.get(material)?.currentProgram;
                        if (!program || program.isReady()) waiting.delete(material);
                    }
                } catch {
                    waiting.clear();
                }
                if (!waiting.size) resolve();
                else setTimeout(check, 10);
            };
            check();
        });
    };

    const precompile = async (T, renderer, scene, camera, { canvas = true, offscreen = true, report = true } = {}) => {
        const previous = renderer.getRenderTarget();
        const probe = offscreen ? new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType }) : null;
        try {
            for (const target of [canvas ? null : undefined, probe || undefined]) {
                if (target === undefined) continue;
                renderer.setRenderTarget(target);
                await compileReady(renderer, scene, camera);
            }
        } catch (error) {
            console.warn('[MusicStage] shader warm-up skipped:', error);
        } finally {
            renderer.setRenderTarget(previous);
            probe?.dispose();
        }
        if (report) await settlePrograms(renderer);
    };

    /*
     * Shader errors are not checked per program (that waits on the GPU
     * process every time), so look once, after the warm-up, and say which
     * program the driver refused and why.
     *
     * A driver without background compiling links a program the first time
     * anything asks about it: here, or else in the first frame, which then
     * asks about every program at once and stalls for the whole lot. So each
     * program is asked here, and its uniform table read the way the first
     * draw would, a slice at a time with a frame in between. With background
     * compiling every program is ready by now and this costs nothing.
     */
    const settlePrograms = async (renderer, alive = () => true, budget = 24) => {
        let started = global.performance?.now?.() ?? Date.now();
        const seen = new Set();
        try {
            for (const entry of [...(renderer.info?.programs || [])]) {
                if (!alive()) return;
                const gl = renderer.getContext?.();
                if (!gl || gl.isContextLost()) {
                    console.warn('[MusicStage] WebGL context lost during shader warm-up');
                    return;
                }
                const program = entry.program;
                if (!program || seen.has(program)) continue;
                seen.add(program);
                if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                    const shaderLog = (shader) => (shader && gl.getShaderInfoLog(shader)) || '';
                    console.error('[MusicStage] shader program failed:', entry.name || entry.type || '',
                        '\nprogram:', gl.getProgramInfoLog(program) || '',
                        '\nvertex:', shaderLog(entry.vertexShader),
                        '\nfragment:', shaderLog(entry.fragmentShader));
                    continue;
                }
                entry.getUniforms?.();
                entry.getAttributes?.();
                const now = global.performance?.now?.() ?? Date.now();
                if (now - started > budget) {
                    await breathe();
                    started = global.performance?.now?.() ?? Date.now();
                }
            }
        } catch (error) {
            console.warn('[MusicStage] shader check skipped:', error);
        }
    };

    /*
     * Once a mode starts down the ladder, its next tier drop may turn the lens
     * off, and every material drawn straight to the canvas is a program of its
     * own. Compile those in the background while the scale rungs are taken,
     * or the drop links them all in one frame, on a machine already behind.
     * Returns true once it has started.
     */
    const warmLensless = (T, renderer, scene, camera, scaler, quality) => {
        if (!renderer || scaler.steps < 1) return false;
        const at = Math.max(0, TIER_ORDER.indexOf(quality));
        const next = TIER_ORDER[Math.min(TIER_ORDER.length - 1, at + 1)];
        if (!tier(quality).lens || tier(next).lens) return false;
        // Without background compiling the driver links them right here, all
        // at once, which is a longer stall than the drop itself would cause.
        if (!renderer.extensions?.has?.('KHR_parallel_shader_compile')) return true;
        precompile(T, renderer, scene, camera, { canvas: true, offscreen: false, report: false });
        return true;
    };

    /*
     * A dissolve for a 3D mode handing over to the next song. The scene can
     * only be read back right after it is drawn, so `capture` is called after
     * each frame drawn while the old song is going; `reveal` then puts the
     * last of those over the new scene and lets it dissolve. One 2D canvas at
     * drawing-buffer size, emptied again once it has faded.
     */
    const createHandoverVeil = (root) => {
        const veil = createElement('canvas', 'stage-handover-veil');
        veil.setAttribute('aria-hidden', 'true');
        veil.width = 1; veil.height = 1;
        root.appendChild(veil);
        let context = null, captured = false, timer = 0, takenAt = -Infinity;
        const empty = () => { veil.width = 1; veil.height = 1; captured = false; takenAt = -Infinity; };
        return {
            get captured() { return captured; },
            // Reading the 3D picture back stalls until the GPU has drawn it, so
            // while a mode is waiting on the next song it keeps one picture a
            // quarter of a second rather than every frame: on the slow sky it
            // looks at by then, nobody can tell the difference.
            capture(source, { every = 250 } = {}) {
                if (!source || !source.width) return;
                const now = global.performance?.now?.() ?? Date.now();
                if (captured && now - takenAt < every
                    && veil.width === source.width && veil.height === source.height) return;
                takenAt = now;
                if (veil.width !== source.width || veil.height !== source.height) {
                    veil.width = source.width; veil.height = source.height;
                    context = null;
                }
                context = context || veil.getContext('2d', { alpha: false });
                if (!context) return;
                try { context.drawImage(source, 0, 0); captured = true; } catch { captured = false; }
            },
            reveal(duration = 900) {
                global.clearTimeout(timer);
                if (!captured) return;
                veil.style.transition = 'none';
                veil.style.opacity = '1';
                veil.classList.add('is-showing');
                void veil.offsetWidth;
                veil.style.transition = `opacity ${duration}ms cubic-bezier(0.33, 0, 0.2, 1)`;
                veil.style.opacity = '0';
                timer = global.setTimeout(() => { veil.classList.remove('is-showing'); empty(); }, duration + 60);
            },
            cancel() { global.clearTimeout(timer); veil.classList.remove('is-showing'); empty(); },
            destroy() { global.clearTimeout(timer); empty(); veil.remove(); }
        };
    };

    /*
     * The stage's track card sits over the top-left of the picture. Where a
     * mode is free to move its words, it keeps them out from under the card.
     * The card's box is read only when it or the stage changes size, never
     * per frame, and handed out in the picture's own -1..1 units (y up).
     */
    const watchOverlay = (root, selector = '.music-stage-id3') => {
        const card = root?.closest?.('.music-stage')?.querySelector?.(selector) || null;
        let box = null;
        const measure = () => {
            box = null;
            if (!card || !root.isConnected) return;
            const view = root.getBoundingClientRect(), r = card.getBoundingClientRect();
            if (!view.width || !view.height || !r.width || !r.height) return;
            if (global.getComputedStyle?.(card)?.display === 'none') return;
            const x = px => (px - view.left) / view.width * 2 - 1;
            const y = px => 1 - (px - view.top) / view.height * 2;
            box = { left: x(r.left), right: x(r.right), top: y(r.top), bottom: y(r.bottom) };
            if (box.right <= -1 || box.left >= 1 || box.bottom >= 1 || box.top <= -1) box = null;
        };
        const observer = card && global.ResizeObserver ? new global.ResizeObserver(measure) : null;
        observer?.observe(card);
        observer?.observe(root);
        return {
            get box() { return box; },
            measure,
            destroy() { observer?.disconnect(); box = null; }
        };
    };

    // The faces a 3D stage can write its lyrics in. Each list starts with the
    // face Windows ships, then the usual macOS and open-source equivalents.
    const LYRIC_FONTS = Object.freeze({
        sans: '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Segoe UI",sans-serif',
        serif: '"SimSun","Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif',
        kai: '"KaiTi","STKaiti","Kaiti SC","AR PL UKai CN",serif'
    });
    const lyricFont = key => LYRIC_FONTS[key] || LYRIC_FONTS.sans;

    // The colour a cover is "about": the hue with the most vivid area,
    // averaged over the pixels of that hue. A grey, black or white cover has
    // no such colour and gives null, so the stage keeps its theme's sky.
    const coverColour = (image) => {
        if (!image) return null;
        const size = 32;
        let data;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(image, 0, 0, size, size);
            data = context.getImageData(0, 0, size, size).data;
        } catch (_) { return null; }
        return dominantHue(data);
    };
    const dominantHue = (data) => {
        const BINS = 18;
        const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
        let total = 0, count = 0;
        for (let i = 0; i + 2 < data.length; i += 4) {
            const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const l = (max + min) / 2, d = max - min;
            count++;
            if (d < 0.08) continue;
            const s = d / (1 - Math.abs(2 * l - 1) || 1);
            let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            h = (h * 60 + 360) % 360;
            // Vivid and mid-tone counts; near-black and near-white hardly do.
            const w = s * s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.6);
            const bin = bins[Math.floor(h / (360 / BINS)) % BINS];
            bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
            total += w;
        }
        // Spread each bin over its neighbours so a hue on a bin edge is not split.
        let best = -1, bestW = 0;
        bins.forEach((bin, i) => {
            const w = bin.w + 0.5 * (bins[(i + 1) % BINS].w + bins[(i + BINS - 1) % BINS].w);
            if (w > bestW) { bestW = w; best = i; }
        });
        if (best < 0 || !count || total / count < 0.03) return null;
        const bin = bins[best];
        if (!bin.w) return null;
        const hex = [bin.r, bin.g, bin.b]
            .map(v => Math.round(Math.min(1, v / bin.w) * 255).toString(16).padStart(2, '0')).join('');
        return '#' + hex;
    };

    // A 3D stage's hold on the cover's colour: set() it whenever the song
    // may have changed, settle() it once a drawn frame, and towardHue() any
    // colour to lean it to the cover's hue by the eased weight, keeping
    // that colour's own lightness. Weight and hue both ease over about two
    // seconds of wall-clock time, so a song change glides, never cuts.
    const createCoverTint = (THREE) => {
        const state = { target: null, colour: new THREE.Color(), next: null, weight: 0, aim: 0, at: 0 };
        const coverHsl = {}, toneHsl = {}, scratch = new THREE.Color();
        const close = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 0.003;
        return {
            get weight() { return state.weight; },
            get target() { return state.target; },
            set(hex) {
                const next = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
                if (next === state.target) return;
                state.target = next;
                if (!next) return;
                state.next = new THREE.Color(next);
                // Coming from no colour: start from this one, just faded in.
                if (state.weight < 0.01) state.colour.copy(state.next);
            },
            settle(amount, now) {
                const dt = state.at ? Math.min(0.25, Math.max(0, (now - state.at) / 1000)) : 1;
                state.at = now;
                const k = 1 - Math.exp(-dt * 1.6);
                state.aim = state.target ? clamp(Number(amount) || 0, 0, 1) : 0;
                state.weight += (state.aim - state.weight) * k;
                if (Math.abs(state.aim - state.weight) < 0.002) state.weight = state.aim;
                if (state.target && state.next) {
                    state.colour.lerp(state.next, k);
                    if (close(state.colour, state.next)) state.colour.copy(state.next);
                }
                state.colour.getHSL(coverHsl);
                return state.weight;
            },
            settling: () => Math.abs(state.aim - state.weight) > 0.002
                || Boolean(state.target && state.next && !close(state.colour, state.next)),
            // Mixed straight across, not round the colour wheel: a partial
            // turn from teal toward red would land on green, a hue in
            // neither. Weights near 1 are for what should wear the cover's
            // hue; small ones only warm or cool a colour.
            towardHue(colour, weight, satFloor = 0) {
                if (!(weight > 0)) return colour;
                colour.getHSL(toneHsl);
                scratch.setHSL(coverHsl.h, Math.max(toneHsl.s, coverHsl.s * satFloor), toneHsl.l);
                return colour.lerp(scratch, Math.min(1, weight));
            }
        };
    };

    // Hand the main thread back for a frame between the steps of building a
    // 3D stage, so the curtain's animation keeps moving while it is built.
    // A hidden window has no frames; the timer stands in for one.
    const breathe = () => new Promise((resolve) => {
        let done = false;
        const go = () => { if (!done) { done = true; resolve(); } };
        global.requestAnimationFrame?.(() => global.setTimeout(go, 0));
        global.setTimeout(go, 50);
    });

    // Where the song is, for a stage's small running caption: "03 / 32",
    // or what the stage is waiting through when no line is up yet.
    const lineCounter = (frame, digits = 2) => {
        const count = frame?.lines?.length || 0;
        const index = Number(frame?.currentLineIndex);
        if (!count) return '暂无歌词';
        if (!(index >= 0)) return '前奏';
        const pad = value => String(value).padStart(digits, '0');
        return `${pad(Math.min(count, index + 1))} / ${pad(count)}`;
    };

    global.MusicStageModeUtils = Object.freeze({
        lineCounter,
        watchOverlay, breathe, settlePrograms,
        coverColour, dominantHue, createCoverTint,
        lyricFont,
        createRenderScale,
        createHandoverVeil,
        createFrameCap, durationChanged,
        precompile,
        compileReady,
        warmLensless,
        tier,
        clamp,
        hashString,
        seededRandom,
        splitGraphemes,
        createElement,
        getLineKey,
        createWord,
        updateWord,
        renderWords,
        updateWords,
        resolveAccent,
        refreshTheme,
        makeModeBase
    });
})(window);