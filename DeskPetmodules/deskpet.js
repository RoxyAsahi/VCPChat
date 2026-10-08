/* global PIXI */
// VCPChat 桌宠页面。
//   形象：Live2D（agent 的 deskpet/ 里有 .model3.json，且用户放了 5.x 的 Cubism Core）
//        → 差分立绘（portrait.<情绪>.png，与侧栏首页立绘同一套约定）→ 头像加情绪色环。
//   表情：主进程把这个 agent 的回复流原样转过来，交给与侧栏立绘共用的情绪导演
//        （modules/emotion），导演给出 { state, emotion, intensity } 帧。
//   对话：双击角色或右键「和 TA 说话」弹出输入框；话经主窗口按正常流程发送，回复显示在气泡里。
import { createEmotionDirector } from 'vcp-deskpet://pet/emotion/emotionDirector.js';
import { createEmotionTagScanner } from 'vcp-deskpet://pet/emotion/emotionTags.js';
import { resolvePortrait } from 'vcp-deskpet://pet/emotion/portraitVariants.js';
import { toBubbleText } from 'vcp-deskpet://pet/app/bubbleText.js';

const api = window.deskPetAPI;
// 帧率：有回复、刚被碰过时用 active，空闲一会儿降到 idle；没有显卡、用软件渲染时整体再降一档。
const FPS = { active: 30, idle: 15 };
const FPS_SOFTWARE = { active: 20, idle: 8 };
const IDLE_AFTER_MS = 30000;
const HIT_ALPHA = 24;
const CORE_V6 = 0x06000000;
// 回复结束后气泡停留多久：按字数给时间读完，鼠标停在气泡上时不收
const REPLY_HOLD_MIN_MS = 8000;
const REPLY_HOLD_MAX_MS = 30000;
const REPLY_HOLD_PER_CHAR_MS = 60;
const REPLY_HOLD_AFTER_HOVER_MS = 4000;
const BUBBLE_MAX_CHARS = 600;  // 气泡只留最后这么多字，完整内容在主窗口
const DOUBLE_TAP_MS = 300;     // 这么短内的第二下算双击；单击的反应等这段时间过了再做
const TOP_RESERVE = 150;       // 窗口上方留给气泡和输入框的高度（与样式一致）
const COMPOSER_ROOM = 280;     // 头顶到窗口顶至少这么高，输入框才和气泡一起排在头顶上
const CONTEXT_LOST_RELOAD_MS = 250;
const CONTEXT_LOSS_WINDOW_MS = 120000;
const CONTEXT_LOSS_LIMIT = 3;
const CONTEXT_LOSS_KEY = 'deskpet:webgl-losses';

const EMOTION_LABEL = {
    neutral: '平静', calm: '放松', happy: '开心', excited: '兴奋', shy: '害羞', affectionate: '温柔',
    curious: '好奇', surprised: '惊讶', concerned: '担心', sad: '难过', tired: '疲惫', angry: '生气',
};
const EMOTION_EMOJI = {
    neutral: '🙂', calm: '😌', happy: '😊', excited: '🤩', shy: '😳', affectionate: '🥰',
    curious: '🤔', surprised: '😮', concerned: '😟', sad: '😢', tired: '😪', angry: '😠',
};
const EMOTION_RING = {
    neutral: '#9aa4b2', calm: '#8fc7b8', happy: '#ffb648', excited: '#ff9f1c', shy: '#ff8fb1', affectionate: '#ff7eb6',
    curious: '#6b8cff', surprised: '#59d0ff', concerned: '#b39ddb', sad: '#6c8fb3', tired: '#a58cff', angry: '#ff5f57',
};
const STATE_LABEL = { thinking: '思考中…', tool: '调用工具中…', error: '出错了' };

const $ = (id) => document.getElementById(id);
let backend = null;
let frame = { state: null, emotion: 'neutral', intensity: 0, source: 'idle' };
let lastActivity = Date.now();

// ---- 气泡：状态、回复文字、提示 ----------------------------------------------

const bubble = {
    reply: '',          // 当前回复里可见的文字（还带着 Markdown 记号，显示前再整理）
    replyId: null,      // 正在流式的回复
    region: null,       // 回复正读到哪种区域（thought / tool / code），null 是正文
    notice: null,       // { text, error }，临时提示，优先显示
    hovered: false,
    hideTimer: 0,
    noticeTimer: 0,
    renderQueued: false,
};

// 状态写在回复下方的小字里：思考只在真的读到思维链时提示（刚开口那一下导演还停在「思考」上）
function replyStateLabel() {
    if (!frame.state) return '';
    if (frame.state === 'thinking') return bubble.replyId && bubble.region === 'thought' ? STATE_LABEL.thinking : '';
    return STATE_LABEL[frame.state] || '';
}

function renderBubble() {
    bubble.renderQueued = false;
    const el = $('bubble');
    const text = $('bubbleText');
    let content = '';
    let mode = '';
    const reply = bubble.reply.trim() ? toBubbleText(bubble.reply) : '';
    if (bubble.notice) {
        content = bubble.notice.text;
        mode = bubble.notice.error ? 'is-error' : 'is-notice';
    } else if (reply) {
        content = reply;
        mode = 'is-reply';
    } else if (frame.state && STATE_LABEL[frame.state]) {
        content = STATE_LABEL[frame.state];
        mode = 'is-state';
    }
    el.hidden = !content;
    el.className = `pet-ui ${mode}`;
    el.classList.toggle('is-streaming', mode === 'is-reply' && Boolean(bubble.replyId));
    const shown = content.length > BUBBLE_MAX_CHARS ? `…${content.slice(-BUBBLE_MAX_CHARS)}` : content;
    if (text.textContent !== shown) {
        text.textContent = shown;
        // 只有用户没往上翻时才跟到底部
        if (!bubble.hovered) text.scrollTop = text.scrollHeight;
    }
    // 排队等发的话写在小字里，不盖住正在说的回复
    const queued = composer.queued ? `说完就发：「${shorten(composer.queued)}」` : '';
    $('bubbleState').textContent = mode === 'is-reply' || mode === 'is-state'
        ? [mode === 'is-reply' ? replyStateLabel() : '', queued].filter(Boolean).join(' · ')
        : '';
}

// 流式片段很密，攒到下一帧一起画
function queueRenderBubble() {
    if (bubble.renderQueued) return;
    bubble.renderQueued = true;
    requestAnimationFrame(renderBubble);
}

function replyHoldMs() {
    const length = toBubbleText(bubble.reply).length;
    return Math.min(REPLY_HOLD_MAX_MS, Math.max(REPLY_HOLD_MIN_MS, length * REPLY_HOLD_PER_CHAR_MS));
}

function scheduleReplyHide(ms) {
    clearTimeout(bubble.hideTimer);
    bubble.hideTimer = setTimeout(() => {
        if (bubble.replyId || bubble.hovered) return;
        bubble.reply = '';
        renderBubble();
    }, ms);
}

function notice(text, { error = false, ms = 6000 } = {}) {
    bubble.notice = text ? { text, error } : null;
    clearTimeout(bubble.noticeTimer);
    if (text) bubble.noticeTimer = setTimeout(() => { bubble.notice = null; renderBubble(); }, ms);
    renderBubble();
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

// ---- 输入框 ---------------------------------------------------------------------

const composer = { open: false, sending: false, queued: null };

function openComposer() {
    composer.open = true;
    $('composer').hidden = false;
    api.setInteractive(true);
    setTimeout(() => $('composerInput').focus(), 30);
}

function closeComposer() {
    composer.open = false;
    $('composer').hidden = true;
    api.setInteractive(false);
}

function shorten(text, max = 16) {
    const flat = text.replace(/\s+/g, ' ');
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function sendText(text) {
    composer.sending = true;
    $('composerSend').disabled = true;
    try {
        const result = await api.send(text);
        if (result?.success) return true;
        notice(`没发出去：${result?.error || '未知原因'}`, { error: true });
    } catch (error) {
        notice(`没发出去：${error.message}`, { error: true });
    } finally {
        composer.sending = false;
        $('composerSend').disabled = false;
    }
    return false;
}

async function submitComposer() {
    const input = $('composerInput');
    const text = input.value.trim();
    if (!text || composer.sending) return;
    // TA 还在说话：先记下来，这条说完再发，不打断也不报错
    if (bubble.replyId) {
        // 连着说了几句就攒在一起，说完一次发出去
        composer.queued = composer.queued ? `${composer.queued}\n${text}` : text;
        input.value = '';
        closeComposer();
        renderBubble();
        return;
    }
    if (await sendText(text)) {
        input.value = '';
        closeComposer();
    }
}

// 回复结束后把排队的那句发出去；发不出去就放回输入框
async function flushQueued() {
    const text = composer.queued;
    if (!text || bubble.replyId || composer.sending) return;
    composer.queued = null;
    renderBubble();
    if (await sendText(text)) return;
    $('composerInput').value = text;
    openComposer();
}

function bindComposer() {
    const input = $('composerInput');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submitComposer();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeComposer();
        }
    });
    $('composerSend').addEventListener('click', submitComposer);
    $('composerClose').addEventListener('click', closeComposer);
    // 点气泡打开主窗口看完整回复；鼠标停在气泡上时先不收起，方便读完或往上翻。
    const bubbleEl = $('bubble');
    bubbleEl.addEventListener('click', () => api.openMainWindow());
    bubbleEl.addEventListener('mouseenter', () => {
        bubble.hovered = true;
        clearTimeout(bubble.hideTimer);
    });
    bubbleEl.addEventListener('mouseleave', () => {
        bubble.hovered = false;
        if (bubble.reply && !bubble.replyId) scheduleReplyHide(REPLY_HOLD_AFTER_HOVER_MS);
    });
    api.onOpenInput(openComposer);
    // 失焦（点到别的程序）且没写东西时自动收起，回到穿透状态。
    window.addEventListener('blur', () => {
        if (composer.open && !input.value.trim()) closeComposer();
    });
}

// 气泡、输入框这些界面元素也要能点到（按像素穿透只看角色本身）。
function uiAt(x, y) {
    return Boolean(document.elementFromPoint(x, y)?.closest('.pet-ui'));
}

function union(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function uiBounds() {
    let rect = null;
    for (const el of document.querySelectorAll('.pet-ui')) {
        if (el.hidden) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        rect = rect ? union(rect, r) : { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return rect;
}

// ---- 拖动、点击、双击、右键 -------------------------------------------------------

function bindPointer({ onTap, onDoubleTap }) {
    let down = null;
    let lastTap = 0;
    let tapTimer = 0;
    window.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target?.closest?.('.pet-ui')) return;
        // 上一次按下没收到 pointerup（被菜单、切窗口打断）时，先把它的拖动收尾。
        if (down?.dragging) api.dragEnd();
        down = { x: e.screenX, y: e.screenY, dragging: false };
        // 捕获指针：窗口跟着光标移动时 pointerup 也一定回到这里。
        try { e.target?.setPointerCapture?.(e.pointerId); } catch { /* 指针已经没了 */ }
    });
    window.addEventListener('pointermove', (e) => {
        lastActivity = Date.now();
        if (!down || down.dragging) return;
        if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
            down.dragging = true;
            api.dragStart({ x: down.x, y: down.y });
        }
    });
    window.addEventListener('pointerup', () => {
        if (!down) return;
        if (down.dragging) {
            api.dragEnd();
        } else if (Date.now() - lastTap < DOUBLE_TAP_MS) {
            // 双击只打开输入框，不先做一遍单击的开心动作
            clearTimeout(tapTimer);
            lastTap = 0;
            onDoubleTap();
        } else {
            lastTap = Date.now();
            clearTimeout(tapTimer);
            tapTimer = setTimeout(onTap, DOUBLE_TAP_MS);
        }
        down = null;
    });
    // 触屏手势被系统接管（pointercancel）、拖到一半切走窗口时收不到 pointerup，拖动必须在这里结束。
    const abort = () => {
        if (down?.dragging) api.dragEnd();
        down = null;
    };
    window.addEventListener('pointercancel', abort);
    window.addEventListener('blur', abort);
    window.addEventListener('contextmenu', (e) => {
        if (e.target?.closest?.('#composer')) return; // 输入框里保留系统的复制粘贴菜单
        e.preventDefault();
        abort(); // 菜单会拿走指针，拖到一半右键也要先停下
        api.openContextMenu();
    });
}

// ---- Live2D 后端 ----------------------------------------------------------

// 情绪 → 叠加到标准参数上的增量（乘以强度）。模型没有的参数自动跳过，
// 所以没有 exp3 表情文件的模型（例如 Hiyori）也能看出情绪。
const EMOTION_PARAMS = {
    neutral: {},
    calm: { ParamEyeLSmile: 0.3, ParamEyeRSmile: 0.3, ParamMouthForm: 0.3 },
    happy: { ParamMouthForm: 1, ParamEyeLSmile: 0.9, ParamEyeRSmile: 0.9, ParamCheek: 0.5, ParamBrowLY: 0.3, ParamBrowRY: 0.3 },
    excited: { ParamMouthForm: 1, ParamMouthOpenY: 0.4, ParamEyeLOpen: 0.25, ParamEyeROpen: 0.25, ParamBrowLY: 0.8, ParamBrowRY: 0.8, ParamCheek: 0.4 },
    shy: { ParamCheek: 1, ParamMouthForm: 0.4, ParamEyeLOpen: -0.25, ParamEyeROpen: -0.25, ParamAngleY: -10, ParamAngleX: 8, ParamEyeBallX: -0.4 },
    affectionate: { ParamCheek: 0.7, ParamMouthForm: 0.8, ParamEyeLSmile: 0.6, ParamEyeRSmile: 0.6, ParamAngleZ: 6 },
    curious: { ParamAngleZ: -10, ParamBrowLY: 0.5, ParamBrowRY: -0.1, ParamEyeBallX: 0.3, ParamEyeBallY: 0.2 },
    surprised: { ParamEyeLOpen: 0.35, ParamEyeROpen: 0.35, ParamBrowLY: 0.9, ParamBrowRY: 0.9, ParamMouthOpenY: 0.5, ParamMouthForm: -0.2 },
    concerned: { ParamBrowLY: -0.3, ParamBrowRY: -0.3, ParamBrowLAngle: 0.6, ParamBrowRAngle: 0.6, ParamMouthForm: -0.4 },
    sad: { ParamMouthForm: -0.9, ParamBrowLY: -0.5, ParamBrowRY: -0.5, ParamBrowLAngle: 0.6, ParamBrowRAngle: 0.6, ParamAngleY: -8, ParamEyeLOpen: -0.15, ParamEyeROpen: -0.15 },
    tired: { ParamEyeLOpen: -0.65, ParamEyeROpen: -0.65, ParamAngleZ: 8, ParamBrowLY: -0.2, ParamBrowRY: -0.2 },
    angry: { ParamMouthForm: -0.7, ParamBrowLY: -0.4, ParamBrowRY: -0.4, ParamBrowLAngle: -0.9, ParamBrowRAngle: -0.9, ParamAngleX: -6 },
};
// 状态叠在情绪上：思考时眼睛往上看、调工具时低头专注、出错时皱眉。
const STATE_PARAMS = {
    thinking: { ParamEyeBallY: 0.6, ParamEyeBallX: 0.3, ParamAngleZ: -6, ParamAngleY: 6 },
    tool: { ParamBrowLY: -0.4, ParamBrowRY: -0.4, ParamEyeBallY: -0.4, ParamAngleY: -8 },
    error: EMOTION_PARAMS.concerned,
};
// 换情绪时点缀一个动作；组不存在就跳过。
const EMOTION_MOTIONS = {
    happy: ['Tap', 'TapBody', 'Tap@Body'],
    excited: ['Tap', 'TapBody', 'Tap@Body'],
    shy: ['Tap@Body', 'Tap', 'TapBody'],
    affectionate: ['Tap@Body', 'TapBody'],
    surprised: ['Flick', 'FlickUp'],
    sad: ['FlickDown'],
    angry: ['Flick@Body', 'Flick'],
};
// 官方示例模型的表情映射（按模型文件名认）；其他模型可以在模型旁放 deskpet.json 自己指定。
const SAMPLE_EXPRESSIONS = {
    natori: { neutral: 'Normal', calm: 'Normal', happy: 'Smile', excited: 'exp_02', shy: 'Blushing', affectionate: 'Blushing', curious: 'exp_01', surprised: 'Surprised', concerned: 'exp_03', sad: 'Sad', tired: 'exp_05', angry: 'Angry' },
    mao: { neutral: 'exp_01', calm: 'exp_02', happy: 'exp_02', excited: 'exp_04', shy: 'exp_06', affectionate: 'exp_06', curious: 'exp_07', surprised: 'exp_07', concerned: 'exp_05', sad: 'exp_05', angry: 'exp_08' },
    haru: { neutral: 'F01', calm: 'F01', happy: 'F05', excited: 'F02', shy: 'F07', affectionate: 'F07', curious: 'F06', surprised: 'F06', concerned: 'F08', sad: 'F04', tired: 'F08', angry: 'F03' },
    ren: { neutral: 'exp_01', calm: 'exp_01', happy: 'exp_02', tired: 'exp_03', sad: 'exp_04', concerned: 'exp_05' },
};
// 其余模型按表情名猜。
const EXPRESSION_HINTS = {
    neutral: ['normal', 'neutral', 'default', 'idle', '默认'],
    calm: ['calm', 'relax'],
    happy: ['happy', 'smile', 'joy', 'fun', '开心', '笑'],
    excited: ['excite', 'star', '兴奋'],
    shy: ['shy', 'blush', 'embarrass', '害羞', '脸红'],
    affectionate: ['love', 'heart', 'blush', '喜欢'],
    curious: ['curious', 'question', 'think', '疑问'],
    surprised: ['surprise', 'shock', '惊'],
    concerned: ['worry', 'trouble', 'concern', '担心'],
    sad: ['sad', 'cry', 'tear', '哭', '难过'],
    tired: ['sleep', 'tired', '困'],
    angry: ['angry', 'anger', 'annoy', 'mad', '生气', '怒'],
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

// 有没有 WebGL，以及是不是软件渲染（没有显卡或显卡被禁用时 Chromium 用 SwiftShader）
function probeWebGL() {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { renderer, software: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer) };
}

function recentContextLosses() {
    try {
        const list = JSON.parse(sessionStorage.getItem(CONTEXT_LOSS_KEY) || '[]');
        return Array.isArray(list) ? list.filter((t) => Date.now() - t < CONTEXT_LOSS_WINDOW_MS) : [];
    } catch {
        return [];
    }
}

function recordContextLoss() {
    try {
        sessionStorage.setItem(CONTEXT_LOSS_KEY, JSON.stringify([...recentContextLosses(), Date.now()]));
    } catch { /* 存不了就只是不计数 */ }
}

function userFacing(message) {
    const err = new Error(message);
    err.userFacing = true;
    return err;
}

async function createLive2DBackend(assets) {
    // 渲染引擎只认 WebGL；显卡被禁用时 Pixi 会退到 Canvas，模型画不出来。
    const webgl = probeWebGL();
    if (!webgl) throw userFacing('当前环境没有 WebGL（显卡加速被禁用？），Live2D 画不出来，先用立绘代替。');
    const fps = webgl.software ? FPS_SOFTWARE : FPS;
    await loadScript(assets.coreUrl);
    // 文件损坏或放错了文件时脚本照样「加载成功」，只是没有定义 Core。
    const coreVersion = window.Live2DCubismCore?.Version?.csmGetVersion?.() || 0;
    if (!coreVersion) throw userFacing(`${assets.corePath} 不是可用的 Cubism Core（文件损坏或放错了文件），请换一份 5.x 的 live2dcubismcore.min.js。先用立绘代替。`);
    if (coreVersion >= CORE_V6) throw userFacing('Cubism Core 是 6.x，当前渲染引擎只支持 5.x。请换一份 5.x 的 live2dcubismcore.min.js。');
    await loadScript('vcp-deskpet://pet/vendor/live2d/untitled-pixi-live2d-engine.cubism.min.js');
    const { Live2DModel, Live2DPlugin } = PIXI.live2d;
    PIXI.extensions.add(Live2DPlugin);

    const canvas = $('live2dCanvas');
    canvas.hidden = false;
    // 显卡驱动重置、GPU 进程崩溃、睡眠唤醒都可能让 WebGL 上下文丢失；丢了以后模型不会自己画回来，
    // 角色既看不见也点不到（命中靠读像素）。整页重载重建渲染；短时间内反复丢就改用立绘。
    const onContextLost = (event) => {
        event.preventDefault();
        recordContextLoss();
        notice('显卡渲染中断，正在重新载入桌宠…', { ms: 4000 });
        setTimeout(() => window.location.reload(), CONTEXT_LOST_RELOAD_MS);
    };
    canvas.addEventListener('webglcontextlost', onContextLost, { once: true });
    const app = new PIXI.Application();
    await app.init({
        canvas,
        resizeTo: window,
        preference: 'webgl',
        backgroundAlpha: 0,
        // 软件渲染时多重采样很贵，人物边缘的锯齿在桌面上也不明显
        antialias: !webgl.software,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
    });
    app.ticker.maxFPS = fps.active;
    try {
        return await mountLive2DModel(app, canvas, assets, { Live2DModel, coreVersion, webgl, fps });
    } catch (error) {
        // 模型坏了：把已经建好的 WebGL 上下文和渲染循环一起收掉，不然它会一直空转。
        // 销毁会主动释放上下文，这不是意外丢失，不能触发重载。
        canvas.removeEventListener('webglcontextlost', onContextLost);
        app.destroy({ removeView: false }, { children: true });
        canvas.hidden = true;
        throw error;
    }
}

async function mountLive2DModel(app, canvas, assets, { Live2DModel, coreVersion, webgl, fps }) {
    const model = await Live2DModel.from(assets.live2d.modelUrl, {
        ticker: app.ticker,
        autoHitTest: false,
        autoFocus: false,
        // 画出来只有几百像素高，不必上传整张 2048 图集的 mip 链。
        textureOptions: { lod: 'single-auto' },
    });
    app.stage.addChild(model);
    // 角色画在下方，上面留给气泡和输入框。
    const layout = () => {
        const scale = Math.min(window.innerWidth / model.internalModel.width, (window.innerHeight - TOP_RESERVE) / model.internalModel.height) * 0.98;
        model.scale.set(scale);
        model.anchor.set(0.5, 1);
        model.position.set(window.innerWidth / 2, window.innerHeight);
    };
    layout();
    window.addEventListener('resize', layout);

    // 可选的模型配置：<model 同目录>/deskpet.json
    //   { "expressions": { "happy": "exp_02" }, "motions": { "happy": "Tap" } }
    const profile = (await fetchJson(new URL('deskpet.json', assets.live2d.modelUrl).href)) || {};
    const modelName = decodeURIComponent(assets.live2d.modelUrl.split('/').pop() || '').replace(/\.model3\.json$/i, '').toLowerCase();
    const sampleMap = SAMPLE_EXPRESSIONS[modelName] || {};
    const internal = model.internalModel;
    const coreModel = internal.coreModel;
    const paramIds = new Set(coreModel?._model?.parameters?.ids || coreModel?.getModel?.()?.parameters?.ids || []);
    const expressionNames = (internal.motionManager?.expressionManager?.definitions || [])
        .map((d) => d.Name || d.name).filter(Boolean);
    const motionGroups = Object.keys(internal.motionManager?.definitions || {});

    function pickExpression(emotion) {
        const configured = profile.expressions?.[emotion] ?? sampleMap[emotion];
        if (configured && expressionNames.includes(configured)) return configured;
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
    let mouthPhase = 0;
    internal.on('beforeModelUpdate', () => {
        const keys = new Set([...Object.keys(current), ...Object.keys(target)]);
        for (const id of keys) {
            const goal = target[id] || 0;
            current[id] = (current[id] || 0) + (goal - (current[id] || 0)) * 0.12;
            if (Math.abs(current[id]) < 0.001 && !goal) { delete current[id]; continue; }
            if (paramIds.has(id)) coreModel.addParameterValueById(internal.getIdSafe(id), current[id]);
        }
        // 回复正在流出、又不在思考或调工具时，假装在说话（还没有接 TTS 口型）。
        if (bubble.replyId && !frame.state && paramIds.has('ParamMouthOpenY')) {
            mouthPhase += 0.55 + Math.random() * 0.35;
            const open = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(mouthPhase));
            coreModel.addParameterValueById(internal.getIdSafe('ParamMouthOpenY'), open);
        }
    });

    // ---- 按像素命中（在当帧渲染之后读 alpha） ----
    const gl = app.renderer.gl;
    const pixel = new Uint8Array(4);
    let pendingProbe = null;
    const readAlpha = (x, y) => {
        const r = app.renderer.resolution;
        gl.readPixels(Math.floor(x * r), Math.floor(gl.drawingBufferHeight - y * r - 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return pixel[3];
    };
    app.ticker.add(() => {
        if (!pendingProbe) return;
        const { x, y } = pendingProbe;
        pendingProbe = null;
        reportHit(readAlpha(x, y) >= HIT_ALPHA);
    }, null, PIXI.UPDATE_PRIORITY.UTILITY);

    let lastExpression = null;
    return {
        kind: 'live2d',
        probe(x, y) {
            if (app.ticker.started) { pendingProbe = { x, y }; return; }
            app.render();
            reportHit(readAlpha(x, y) >= HIT_ALPHA);
        },
        focus(x, y) { model.focus(x, y); },
        bounds() { const b = model.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height }; },
        tap() {
            const group = pickMotion('happy') || motionGroups.find((g) => /tap/i.test(g));
            if (group) model.motion(group);
        },
        apply(f, { changed }) {
            const intensity = Math.max(0.3, Math.min(1, f.intensity || 0.6));
            target = {};
            for (const [id, v] of Object.entries(EMOTION_PARAMS[f.emotion] || {})) target[id] = v * intensity;
            for (const [id, v] of Object.entries(STATE_PARAMS[f.state] || {})) target[id] = (target[id] || 0) + v;
            if (!changed) return;
            const expression = pickExpression(f.emotion);
            if (expression && expression !== lastExpression) {
                model.expression(expression);
                lastExpression = expression;
            } else if (!expression && lastExpression) {
                internal.motionManager?.expressionManager?.resetExpression?.();
                lastExpression = null;
            }
            if (!f.state) {
                const group = pickMotion(f.emotion);
                if (group) model.motion(group);
            }
        },
        setActive(active) { app.ticker.maxFPS = active ? fps.active : fps.idle; },
        // 窗口藏起来时整个停掉（窗口关了后台节流，不停的话隐藏着也在一直画）
        setPaused(paused) {
            if (paused) app.ticker.stop();
            else if (!app.ticker.started) app.ticker.start();
        },
        info: { coreVersion, expressions: expressionNames, motionGroups, renderer: webgl.renderer, software: webgl.software },
    };
}

// ---- 差分立绘 / 头像后端 ---------------------------------------------------

let lastHit = false;
function reportHit(hit) {
    if (hit !== lastHit) {
        lastHit = hit;
        api.setHit(hit);
    }
}

function createImageBackend(assets) {
    const portraits = assets.portraits;
    const sampler = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    let activeImg = null;

    // object-fit: contain 之后图片实际画在哪里。
    function drawnRect(img) {
        const box = img.getBoundingClientRect();
        if (!img.naturalWidth || !box.width) return null;
        const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        return { x: box.x + (box.width - w) / 2, y: box.y + box.height - h, width: w, height: h, scale };
    }

    function pop() {
        const el = $('portrait');
        el.classList.remove('is-pop');
        void el.offsetWidth;
        el.classList.add('is-pop');
    }

    if (portraits) {
        const theme = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        $('portrait').hidden = false;
        const layers = [$('portraitA'), $('portraitB')];
        let front = 0;
        let currentSrc = null;
        const failed = new Set();
        const show = async (src, withPop) => {
            if (!src || src === currentSrc || failed.has(src)) return;
            currentSrc = src;
            const next = layers[1 - front];
            next.src = src;
            try {
                await next.decode();
            } catch {
                failed.add(src); // 坏图记住，不再尝试
                return;
            }
            if (src !== currentSrc) return;
            next.classList.add('is-active');
            layers[front].classList.remove('is-active');
            front = 1 - front;
            activeImg = next;
            sampler.canvas.width = next.naturalWidth;
            sampler.canvas.height = next.naturalHeight;
            sampler.clearRect(0, 0, next.naturalWidth, next.naturalHeight);
            sampler.drawImage(next, 0, 0);
            if (withPop) pop();
        };
        const urlFor = (f) => resolvePortrait(portraits, { state: f.state, emotion: f.emotion, theme })?.url;
        show(urlFor(frame), false);
        return {
            kind: 'portrait',
            probe(x, y) {
                const r = activeImg && drawnRect(activeImg);
                if (!r || x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height) return reportHit(false);
                const a = sampler.getImageData(Math.floor((x - r.x) / r.scale), Math.floor((y - r.y) / r.scale), 1, 1).data[3];
                reportHit(a >= HIT_ALPHA);
            },
            focus() {},
            bounds() { return activeImg ? drawnRect(activeImg) : null; },
            tap: pop,
            apply(f, { changed }) { if (changed) show(urlFor(f), true); },
            setActive() {},
            setPaused() {},
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
            reportHit(Math.hypot(x - (b.x + b.width / 2), y - (b.y + b.height / 2)) <= b.width / 2 + 4);
        },
        focus() {},
        bounds() { const b = $('avatar').getBoundingClientRect(); return { x: b.x - 6, y: b.y - 6, width: b.width + 12, height: b.height + 12 }; },
        tap() {},
        apply(f) {
            $('avatar').style.setProperty('--deskpet-ring', EMOTION_RING[f.emotion] || EMOTION_RING.neutral);
            $('avatarBadge').textContent = f.state === 'thinking' || f.state === 'tool' ? '💭' : (EMOTION_EMOJI[f.emotion] || '');
        },
        setActive() {},
        setPaused() {},
    };
}

// ---- 回复流 → 导演与气泡 ----------------------------------------------------------

function applyFrame(next) {
    const changed = next.emotion !== frame.emotion || next.state !== frame.state;
    const emotionChanged = next.emotion !== frame.emotion;
    frame = next;
    lastActivity = Date.now();
    backend?.setActive(true);
    backend?.apply(frame, { changed });
    if (emotionChanged && (next.source === 'tag' || next.source === 'rule')) flashEmotionBadge(next.emotion, next.source);
    renderBubble();
}

function bindStream(director) {
    let scanner = null;
    const startReply = (messageId) => {
        clearTimeout(bubble.hideTimer);
        bubble.replyId = messageId;
        bubble.reply = '';
        bubble.region = null;
        scanner = createEmotionTagScanner();
    };
    api.onStream((event) => {
        if (!event?.messageId) return;
        lastActivity = Date.now();
        if (event.type === 'start') {
            director.begin(event.messageId);
            startReply(event.messageId);
        } else if (event.type === 'data') {
            if (bubble.replyId !== event.messageId) startReply(event.messageId);
            director.append(event.messageId, event.text);
            // 气泡只显示正文：情绪标签、思维链、工具调用和结果都不显示，代码块写成 [代码]。
            for (const item of scanner.push(event.text)) {
                if (item.type === 'text') bubble.reply += item.text;
                else if (item.type === 'enter' && item.region === 'code') bubble.reply += '\n[代码]\n';
            }
            bubble.region = scanner.region;
            queueRenderBubble();
            return;
        } else if (event.type === 'end' || event.type === 'error') {
            if (event.type === 'end') director.end(event.messageId);
            else director.fail(event.messageId);
            if (scanner && bubble.replyId === event.messageId) {
                for (const item of scanner.finish()) if (item.type === 'text') bubble.reply += item.text;
            }
            scanner = null;
            bubble.replyId = null;
            bubble.region = null;
            scheduleReplyHide(replyHoldMs());
            // 排队的话等气泡画完这一帧再发，免得和刚结束的回复挤在一起
            if (composer.queued) setTimeout(flushQueued, 400);
        }
        renderBubble();
    });
}

// ---- 启动 --------------------------------------------------------------------

async function start() {
    const assets = await api.getAssets();
    if (!assets) return;
    document.title = `${assets.name} · 桌宠`;
    $('composerInput').placeholder = `和 ${assets.name} 说点什么…（Enter 发送，Esc 收起）`;

    if (assets.live2d && assets.coreUrl && recentContextLosses().length >= CONTEXT_LOSS_LIMIT) {
        notice('显卡渲染反复中断，这次先用立绘代替 Live2D。重新打开桌宠会再试。', { error: true, ms: 10000 });
    } else if (assets.live2d && assets.coreUrl) {
        try {
            backend = await createLive2DBackend(assets);
        } catch (error) {
            console.error('[DeskPet] Live2D 加载失败，改用立绘：', error);
            $('live2dCanvas').hidden = true;
            notice(error.userFacing ? error.message : `Live2D 加载失败：${error.message}`, { error: true, ms: 8000 });
        }
    } else if (assets.live2d && !assets.coreUrl) {
        notice(`找到了 Live2D 模型，但缺少 Cubism Core：请把 5.x 的 live2dcubismcore.min.js 放到 ${assets.corePath}`, { error: true, ms: 12000 });
    }
    if (!backend) backend = createImageBackend(assets);
    document.body.dataset.backend = backend.kind;

    const director = createEmotionDirector({ onFrame: applyFrame });
    bindStream(director);
    bindComposer();
    api.onCursor(({ x, y }) => {
        if (uiAt(x, y)) reportHit(true);
        else backend.probe(x, y);
        backend.focus(x, y);
    });
    bindPointer({
        onTap: () => {
            backend.tap();
            director.nudge({ emotion: 'happy', intensity: 0.6, source: 'tap' });
        },
        onDoubleTap: openComposer,
    });
    // 窗口隐藏时停掉渲染和呼吸动画，显示回来再继续。
    let paused = false;
    api.onVisibility?.((visible) => {
        paused = !visible;
        document.body.classList.toggle('is-paused', paused);
        backend.setPaused(paused);
        if (!paused) lastActivity = Date.now();
    });
    // 定期看一眼角色占在哪里：气泡和输入框贴在头顶上方（小头像、矮立绘不会离得老远）；
    // Linux 用输入区代替整窗穿透（见主进程注释），把角色和界面的包围盒报上去。
    let headY = TOP_RESERVE;
    // 头顶上方放不下气泡加输入框时，输入框改到窗口底部（压在腿上，不挡脸，也不把气泡挤成一行）
    const placeComposer = () => document.body.classList.toggle('is-cramped', headY < COMPOSER_ROOM);
    placeComposer();
    setInterval(() => {
        if (paused) return;
        const b = backend.bounds();
        if (b) {
            // 动作会让头顶上下晃，差得不多就不挪，免得气泡跟着抖
            const y = Math.round(Math.max(TOP_RESERVE, Math.min(window.innerHeight - 40, b.y)));
            if (Math.abs(y - headY) > 16) {
                headY = y;
                document.documentElement.style.setProperty('--pet-head', `${y}px`);
                placeComposer();
            }
        }
        const ui = uiBounds();
        const rect = b && ui ? union(b, ui) : (b || ui);
        if (rect) api.setContentBounds({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height });
        if (Date.now() - lastActivity > IDLE_AFTER_MS && !frame.state) backend.setActive(false);
    }, 250);

    applyFrame(director.frame);
    window.__deskPetReady = { backend: backend.kind, info: backend.info || null };
    console.log('[DeskPet] ready', JSON.stringify(window.__deskPetReady));
}

start().catch((error) => {
    console.error('[DeskPet] 启动失败', error);
    notice(`桌宠启动失败：${error.message}`, { error: true, ms: 60000 });
});
