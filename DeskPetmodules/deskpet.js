/* global PIXI */
// VCPChat 桌宠页面。三种后端按可用资源依次降级：
//   Live2D（agent 的 deskpet/ 里有 .model3.json，且用户放了 5.x 的 Cubism Core）
//   → 差分立绘（portrait.<情绪>.png，PR #31 的命名约定）
//   → 头像加情绪色环。
// 主进程只发 EmotionFrame（state + emotion），这里决定怎么演。
(() => {
    'use strict';

    const api = window.deskPetAPI;
    const FPS_ACTIVE = 30;
    const FPS_IDLE = 15;
    const IDLE_AFTER_MS = 30000;
    const HIT_ALPHA = 24;
    const CORE_V6 = 0x06000000;

    const EMOTION_LABEL = {
        calm: '平静', focused: '专注', happy: '开心', shy: '害羞',
        surprised: '惊讶', sleepy: '困倦', sad: '难过', annoyed: '生气',
    };
    const EMOTION_EMOJI = {
        calm: '🙂', focused: '🤔', happy: '😊', shy: '😳',
        surprised: '😮', sleepy: '😪', sad: '😢', annoyed: '😠',
    };
    const EMOTION_RING = {
        calm: '#9aa4b2', focused: '#6b8cff', happy: '#ffb648', shy: '#ff8fb1',
        surprised: '#59d0ff', sleepy: '#a58cff', sad: '#6c8fb3', annoyed: '#ff5f57',
    };
    const STATE_BUBBLE = { thinking: '思考中…', tool: '调用工具中…', error: '出错了' };
    // 状态覆盖情绪：思考和调工具时显示专注，出错时显示难过。
    const STATE_EMOTION = { thinking: 'focused', tool: 'focused', error: 'sad' };
    // 立绘缺图时，按相近情绪回退，最后用默认立绘。
    const PORTRAIT_FALLBACK = {
        shy: ['happy'], surprised: ['happy'], annoyed: ['sad'], sleepy: ['calm'],
        focused: ['calm'], sad: ['calm'], happy: ['calm'], calm: [],
    };

    const $ = (id) => document.getElementById(id);
    let backend = null;
    let frame = { state: 'idle', emotion: 'calm', intensity: 0.5 };
    let lastActivity = Date.now();
    let bubbleOverride = null;

    function effectiveEmotion(f) {
        return STATE_EMOTION[f.state] || f.emotion || 'calm';
    }

    // ---- 气泡与情绪角标 ------------------------------------------------------

    function showBubble(text, { error = false } = {}) {
        const el = $('bubble');
        el.textContent = text || '';
        el.hidden = !text;
        el.classList.toggle('is-error', error);
    }

    function refreshBubble() {
        if (bubbleOverride) return showBubble(bubbleOverride.text, bubbleOverride);
        showBubble(STATE_BUBBLE[frame.state] || '');
    }

    let badgeTimer = 0;
    function flashEmotionBadge(emotion, source) {
        const el = $('emotionBadge');
        el.textContent = `${EMOTION_EMOJI[emotion] || ''} ${EMOTION_LABEL[emotion] || emotion}${source === 'rule' ? '（推测）' : ''}`;
        el.hidden = false;
        el.classList.remove('is-fading');
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => el.classList.add('is-fading'), 2500);
    }

    // ---- 拖动、点击、右键 -----------------------------------------------------

    function bindPointer(onTap) {
        let down = null;
        window.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            down = { x: e.screenX, y: e.screenY, dragging: false };
        });
        window.addEventListener('pointermove', (e) => {
            lastActivity = Date.now();
            if (!down || down.dragging) return;
            if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
                down.dragging = true;
                api.dragStart({ x: down.x, y: down.y });
            }
        });
        window.addEventListener('pointerup', (e) => {
            if (!down) return;
            if (down.dragging) api.dragEnd();
            else onTap(e.clientX, e.clientY);
            down = null;
        });
        window.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            api.openContextMenu();
        });
    }

    // ---- Live2D 后端 ----------------------------------------------------------

    // 情绪 → 叠加到标准参数上的增量（乘以强度）。模型没有的参数自动跳过，
    // 所以没有 exp3 表情文件的模型（例如 Hiyori）也能看出情绪。
    const EMOTION_PARAMS = {
        calm: {},
        focused: { ParamBrowLY: -0.4, ParamBrowRY: -0.4, ParamEyeLOpen: -0.15, ParamEyeROpen: -0.15, ParamEyeBallY: -0.3, ParamAngleY: -6 },
        happy: { ParamMouthForm: 1, ParamEyeLSmile: 0.9, ParamEyeRSmile: 0.9, ParamCheek: 0.6, ParamBrowLY: 0.3, ParamBrowRY: 0.3 },
        shy: { ParamCheek: 1, ParamMouthForm: 0.4, ParamEyeLOpen: -0.25, ParamEyeROpen: -0.25, ParamAngleY: -10, ParamAngleX: 8, ParamEyeBallX: -0.4 },
        surprised: { ParamEyeLOpen: 0.35, ParamEyeROpen: 0.35, ParamBrowLY: 0.9, ParamBrowRY: 0.9, ParamMouthOpenY: 0.5, ParamMouthForm: -0.2 },
        sleepy: { ParamEyeLOpen: -0.65, ParamEyeROpen: -0.65, ParamAngleZ: 8, ParamBrowLY: -0.2, ParamBrowRY: -0.2 },
        sad: { ParamMouthForm: -0.9, ParamBrowLY: -0.5, ParamBrowRY: -0.5, ParamBrowLAngle: 0.6, ParamBrowRAngle: 0.6, ParamAngleY: -8, ParamEyeLOpen: -0.15, ParamEyeROpen: -0.15 },
        annoyed: { ParamMouthForm: -0.7, ParamBrowLY: -0.4, ParamBrowRY: -0.4, ParamBrowLAngle: -0.9, ParamBrowRAngle: -0.9, ParamAngleX: -6 },
    };
    // 换情绪时随机点缀一个动作；组不存在就跳过。
    const EMOTION_MOTIONS = {
        happy: ['Tap', 'TapBody', 'Tap@Body'],
        shy: ['Tap@Body', 'Tap', 'TapBody'],
        surprised: ['Flick', 'FlickUp'],
        sad: ['FlickDown'],
        annoyed: ['Flick@Body', 'Flick'],
    };
    // 模型自带 exp3 时，按名字猜一个；猜不到可在 deskpet.json 里手动指定。
    const EXPRESSION_HINTS = {
        happy: ['happy', 'smile', 'joy', 'fun', '开心', '笑'],
        shy: ['shy', 'blush', 'embarrass', '害羞', '脸红'],
        surprised: ['surprise', 'shock', '惊'],
        sad: ['sad', 'cry', 'tear', '哭', '难过'],
        annoyed: ['angry', 'anger', 'annoy', 'mad', '生气', '怒'],
        sleepy: ['sleep', 'tired', '困'],
        focused: ['serious', 'focus', 'think', '认真'],
        calm: ['normal', 'neutral', 'default', 'idle', '默认'],
    };

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.onload = resolve;
            el.onerror = () => reject(new Error(`加载失败: ${src}`));
            document.head.appendChild(el);
        });
    }

    async function fetchJson(url) {
        try {
            const res = await fetch(url);
            return res.ok ? res.json() : null;
        } catch {
            return null;
        }
    }

    function hasWebGL() {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2') || probe.getContext('webgl');
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        return Boolean(gl);
    }

    async function createLive2DBackend(assets) {
        // 渲染引擎只认 WebGL；显卡被禁用时 Pixi 会退到 Canvas，模型画不出来。
        if (!hasWebGL()) {
            const err = new Error('当前环境没有 WebGL（显卡加速被禁用？），Live2D 画不出来，先用立绘代替。');
            err.userFacing = true;
            throw err;
        }
        await loadScript(assets.coreUrl);
        const coreVersion = window.Live2DCubismCore?.Version?.csmGetVersion?.() || 0;
        if (coreVersion >= CORE_V6) {
            const err = new Error('Cubism Core 是 6.x，当前渲染引擎只支持 5.x。请换一份 5.x 的 live2dcubismcore.min.js。');
            err.userFacing = true;
            throw err;
        }
        await loadScript('vcp-deskpet://pet/vendor/live2d/untitled-pixi-live2d-engine.cubism.min.js');
        const { Live2DModel, Live2DPlugin } = PIXI.live2d;
        PIXI.extensions.add(Live2DPlugin);

        const canvas = $('live2dCanvas');
        canvas.hidden = false;
        const app = new PIXI.Application();
        await app.init({
            canvas,
            resizeTo: window,
            preference: 'webgl',
            backgroundAlpha: 0,
            antialias: true,
            autoDensity: true,
            resolution: window.devicePixelRatio || 1,
            preserveDrawingBuffer: false,
            powerPreference: 'low-power',
        });
        app.ticker.maxFPS = FPS_ACTIVE;

        const model = await Live2DModel.from(assets.live2d.modelUrl, {
            ticker: app.ticker,
            autoHitTest: false,
            autoFocus: false,
            // 画出来只有几百像素高，不必上传整张 2048 图集的 mip 链。
            textureOptions: { lod: 'single-auto' },
        });
        app.stage.addChild(model);
        const layout = () => {
            const scale = Math.min(window.innerWidth / model.internalModel.width, (window.innerHeight - 36) / model.internalModel.height) * 0.98;
            model.scale.set(scale);
            model.anchor.set(0.5, 1);
            model.position.set(window.innerWidth / 2, window.innerHeight);
        };
        layout();
        window.addEventListener('resize', layout);

        // 可选的模型配置：<model 同目录>/deskpet.json
        //   { "expressions": { "happy": "exp_02" }, "motions": { "happy": "Tap" } }
        const profile = (await fetchJson(new URL('deskpet.json', assets.live2d.modelUrl).href)) || {};
        const internal = model.internalModel;
        const coreModel = internal.coreModel;
        const paramIds = new Set(coreModel?._model?.parameters?.ids || coreModel?.getModel?.()?.parameters?.ids || []);
        const expressionNames = (internal.motionManager?.expressionManager?.definitions || [])
            .map((d) => d.Name || d.name).filter(Boolean);
        const motionGroups = Object.keys(internal.motionManager?.definitions || {});

        function pickExpression(emotion) {
            if (profile.expressions && emotion in profile.expressions) return profile.expressions[emotion];
            const hints = EXPRESSION_HINTS[emotion] || [];
            return expressionNames.find((n) => hints.some((h) => n.toLowerCase().includes(h))) || null;
        }
        function pickMotion(emotion) {
            const configured = profile.motions?.[emotion];
            if (configured && motionGroups.includes(configured)) return configured;
            return (EMOTION_MOTIONS[emotion] || []).find((g) => motionGroups.includes(g)) || null;
        }

        // 每帧在物理和 pose 之后、model.update 之前叠加情绪参数，平滑逼近目标。
        const current = {};
        let target = {};
        let speaking = false;
        let mouthPhase = 0;
        internal.on('beforeModelUpdate', () => {
            const keys = new Set([...Object.keys(current), ...Object.keys(target)]);
            for (const id of keys) {
                const goal = target[id] || 0;
                current[id] = (current[id] || 0) + (goal - (current[id] || 0)) * 0.12;
                if (Math.abs(current[id]) < 0.001 && !goal) { delete current[id]; continue; }
                if (paramIds.has(id)) coreModel.addParameterValueById(internal.getIdSafe(id), current[id]);
            }
            if (speaking && paramIds.has('ParamMouthOpenY')) {
                mouthPhase += 0.55 + Math.random() * 0.35;
                const open = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(mouthPhase));
                coreModel.addParameterValueById(internal.getIdSafe('ParamMouthOpenY'), open);
            }
        });

        // ---- 按像素命中（在当帧渲染之后读 alpha） ----
        const gl = app.renderer.gl;
        const pixel = new Uint8Array(4);
        let pendingProbe = null;
        let lastHit = false;
        const readAlpha = (x, y) => {
            const r = app.renderer.resolution;
            gl.readPixels(Math.floor(x * r), Math.floor(gl.drawingBufferHeight - y * r - 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            return pixel[3];
        };
        const report = (hit) => { if (hit !== lastHit) { lastHit = hit; api.setHit(hit); } };
        app.ticker.add(() => {
            if (!pendingProbe) return;
            const { x, y } = pendingProbe;
            pendingProbe = null;
            report(readAlpha(x, y) >= HIT_ALPHA);
        }, null, PIXI.UPDATE_PRIORITY.UTILITY);

        let lastEmotion = null;
        return {
            kind: 'live2d',
            probe(x, y) {
                if (app.ticker.started) { pendingProbe = { x, y }; return; }
                app.render();
                report(readAlpha(x, y) >= HIT_ALPHA);
            },
            focus(x, y) { model.focus(x, y); },
            bounds() { const b = model.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height }; },
            tap(x, y) {
                const group = pickMotion('happy') || motionGroups.find((g) => /tap/i.test(g));
                if (group) model.motion(group);
                return model.hitTest(x, y);
            },
            apply(f) {
                const emotion = effectiveEmotion(f);
                const intensity = Math.max(0.3, Math.min(1, f.intensity ?? 0.7));
                speaking = f.state === 'speaking';
                target = {};
                for (const [id, v] of Object.entries(EMOTION_PARAMS[emotion] || {})) target[id] = v * intensity;
                if (emotion === lastEmotion) return;
                lastEmotion = emotion;
                const expression = pickExpression(emotion);
                if (expression) model.expression(expression);
                else if (expressionNames.length && emotion === 'calm') internal.motionManager?.expressionManager?.resetExpression?.();
                if (f.state !== 'thinking' && f.state !== 'tool') {
                    const group = pickMotion(emotion);
                    if (group) model.motion(group);
                }
            },
            setFps(fps) { app.ticker.maxFPS = fps; },
            info: { coreVersion, expressions: expressionNames, motionGroups },
        };
    }

    // ---- 差分立绘 / 头像后端 ---------------------------------------------------

    function createImageBackend(assets) {
        const portraits = assets.portraits || {};
        const usePortrait = Boolean(assets.defaultPortrait || Object.keys(portraits).length);
        const sampler = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        let activeImg = null;

        function portraitFor(emotion) {
            for (const key of [emotion, ...(PORTRAIT_FALLBACK[emotion] || [])]) {
                if (portraits[key]) return portraits[key];
            }
            return assets.defaultPortrait || Object.values(portraits)[0] || null;
        }

        // object-fit: contain 之后图片实际画在哪里。
        function drawnRect(img) {
            const box = img.getBoundingClientRect();
            if (!img.naturalWidth || !box.width) return null;
            const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
            const w = img.naturalWidth * scale;
            const h = img.naturalHeight * scale;
            return { x: box.x + (box.width - w) / 2, y: box.y + box.height - h, width: w, height: h, scale };
        }

        let lastHit = false;
        const report = (hit) => { if (hit !== lastHit) { lastHit = hit; api.setHit(hit); } };

        if (usePortrait) {
            $('portrait').hidden = false;
            const layers = [$('portraitA'), $('portraitB')];
            let front = 0;
            let currentSrc = null;
            const show = async (src, pop) => {
                if (!src || src === currentSrc) return;
                currentSrc = src;
                const next = layers[1 - front];
                next.src = src;
                try { await next.decode(); } catch { /* 解码失败也照样切 */ }
                if (src !== currentSrc) return;
                next.classList.add('is-active');
                layers[front].classList.remove('is-active');
                front = 1 - front;
                activeImg = next;
                sampler.canvas.width = next.naturalWidth;
                sampler.canvas.height = next.naturalHeight;
                sampler.clearRect(0, 0, next.naturalWidth, next.naturalHeight);
                sampler.drawImage(next, 0, 0);
                if (pop) {
                    const el = $('portrait');
                    el.classList.remove('is-pop');
                    void el.offsetWidth;
                    el.classList.add('is-pop');
                }
            };
            show(portraitFor('calm'), false);
            return {
                kind: 'portrait',
                probe(x, y) {
                    const r = activeImg && drawnRect(activeImg);
                    if (!r || x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height) return report(false);
                    const a = sampler.getImageData(Math.floor((x - r.x) / r.scale), Math.floor((y - r.y) / r.scale), 1, 1).data[3];
                    report(a >= HIT_ALPHA);
                },
                focus() {},
                bounds() { return activeImg ? drawnRect(activeImg) : null; },
                tap() { show(currentSrc, true); },
                apply(f) { show(portraitFor(effectiveEmotion(f)), true); },
                setFps() {},
            };
        }

        $('avatar').hidden = false;
        const img = $('avatarImg');
        // 没有头像就只显示情绪圆环和表情符号。
        if (assets.avatar) img.src = assets.avatar;
        else img.hidden = true;
        return {
            kind: 'avatar',
            probe(x, y) {
                const b = $('avatar').getBoundingClientRect();
                const cx = b.x + b.width / 2;
                const cy = b.y + b.height / 2;
                report(Math.hypot(x - cx, y - cy) <= b.width / 2 + 4);
            },
            focus() {},
            bounds() { const b = $('avatar').getBoundingClientRect(); return { x: b.x - 6, y: b.y - 6, width: b.width + 12, height: b.height + 12 }; },
            tap() {},
            apply(f) {
                const emotion = effectiveEmotion(f);
                $('avatar').style.setProperty('--deskpet-ring', EMOTION_RING[emotion] || EMOTION_RING.calm);
                $('avatarBadge').textContent = EMOTION_EMOJI[emotion] || '';
            },
            setFps() {},
        };
    }

    // ---- 启动 --------------------------------------------------------------------

    function applyFrame(f) {
        const prevEmotion = frame.emotion;
        frame = { ...frame, ...f };
        lastActivity = Date.now();
        backend?.setFps(FPS_ACTIVE);
        backend?.apply(frame);
        refreshBubble();
        if (f.reason === 'emotion' && frame.emotion !== prevEmotion || f.reason === 'emotion' && f.source === 'tag') {
            flashEmotionBadge(frame.emotion, frame.source);
        }
    }

    async function start() {
        const assets = await api.getAssets();
        if (!assets) return;
        document.title = `${assets.name} · 桌宠`;

        if (assets.live2d && assets.coreUrl) {
            try {
                backend = await createLive2DBackend(assets);
            } catch (error) {
                console.error('[DeskPet] Live2D 加载失败，改用立绘：', error);
                $('live2dCanvas').hidden = true;
                bubbleOverride = { text: error.userFacing ? error.message : `Live2D 加载失败：${error.message}`, error: true };
                setTimeout(() => { bubbleOverride = null; refreshBubble(); }, 8000);
            }
        } else if (assets.live2d && !assets.coreUrl) {
            bubbleOverride = { text: `找到了 Live2D 模型，但缺少 Cubism Core：请把 5.x 的 live2dcubismcore.min.js 放到 ${assets.corePath}`, error: true };
            setTimeout(() => { bubbleOverride = null; refreshBubble(); }, 12000);
        }
        if (!backend) backend = createImageBackend(assets);
        document.body.dataset.backend = backend.kind;

        api.onCursor(({ x, y }) => {
            backend.probe(x, y);
            backend.focus(x, y);
        });
        bindPointer((x, y) => backend.tap(x, y));
        // Linux 用输入区代替整窗穿透（见主进程注释），定期把内容包围盒报上去。
        setInterval(() => {
            const b = backend.bounds();
            if (b) api.setContentBounds({ x: Math.max(0, b.x), y: Math.max(0, b.y), width: b.width, height: b.height });
            if (Date.now() - lastActivity > IDLE_AFTER_MS && frame.state === 'idle') backend.setFps(FPS_IDLE);
        }, 250);

        api.onFrame(applyFrame);
        const snapshot = await api.getFrame();
        if (snapshot) applyFrame(snapshot);
        refreshBubble();
        window.__deskPetReady = { backend: backend.kind, info: backend.info || null };
        console.log('[DeskPet] ready', JSON.stringify(window.__deskPetReady));
    }

    start().catch((error) => {
        console.error('[DeskPet] 启动失败', error);
        showBubble(`桌宠启动失败：${error.message}`, { error: true });
    });
})();
