/* global PIXI */
// VCPChat 桌宠页面。
//   形象：Live2D（agent 的 deskpet/ 里有 .model3.json，且用户放了 5.x 的 Cubism Core）
//        → 网格立绘（deskpet/ 里有 .puppet.json，一张图切块做的可动角色，不需要 Core）
//        → 差分立绘（portrait.<情绪>.png，与侧栏首页立绘同一套约定）→ 头像加情绪色环。
//   表情：主进程把这个 agent 的回复流原样转过来，交给与侧栏立绘共用的情绪导演
//        （modules/emotion），导演给出 { state, emotion, intensity } 帧。
//   对话：光标停在角色上时脚边冒出小胶囊（打字 / 说话），双击角色或右键「和 TA 说话」直接展开输入条；
//        话经主窗口按正常流程发送，回复显示在气泡里。说话用本地 SenseVoice 识别成文字放进输入条。
//   预览：?preview=1 时只画角色，量好位置报给主进程截图（设置页卡片用），不接回复流、不出声。
import { createEmotionDirector } from 'vcp-deskpet://pet/emotion/emotionDirector.js';
import { createEmotionTagScanner } from 'vcp-deskpet://pet/emotion/emotionTags.js';
import { resolvePortrait } from 'vcp-deskpet://pet/emotion/portraitVariants.js';
import { toBubbleText } from 'vcp-deskpet://pet/app/bubbleText.js';
import { createSpeech } from 'vcp-deskpet://pet/app/voice.js';
import { createToolCard } from 'vcp-deskpet://pet/app/toolCard.js';
import { createMoodOrder } from 'vcp-deskpet://pet/app/moodOrder.js';
import { shapeGaze, limitGaze } from 'vcp-deskpet://pet/app/gaze.js';
import { createPetLife } from 'vcp-deskpet://pet/app/petLife.js';
import { createLifeMotion } from 'vcp-deskpet://pet/app/lifeMotion.js';
import { measureSilhouette, silhouetteAspect, fitSilhouette, touchesEdge } from 'vcp-deskpet://pet/app/figure.js';
import { createDictation } from 'vcp-deskpet://pet/app/dictation.js';

const api = window.deskPetAPI;
const PREVIEW = new URLSearchParams(location.search).has('preview');
// 帧率：有回复、刚被碰过时用 active，空闲一会儿降到 idle，睡着了再降到 sleep；
// 没有显卡、用软件渲染时整体再降一档。
const FPS = { active: 30, idle: 15, sleep: 10 };
const FPS_SOFTWARE = { active: 20, idle: 8, sleep: 5 };
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
const TOP_RESERVE = 150;       // 窗口上方留给气泡的高度（与样式一致）
const DOCK_SHOW_MS = 220;      // 光标在角色上停这么久，脚边的小胶囊冒出来
const DOCK_HIDE_MS = 1400;     // 光标离开这么久，小胶囊收回去
const FIGURE_MEASURE_MS = 450; // Live2D、网格立绘载入后过这么久（物理和待机动作稳下来）量一次轮廓
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
// 被碰到才有的反应：回到高帧率；其余闲时小动作按当前帧率演
const USER_REACTIONS = new Set(['poke', 'headTap', 'pat', 'annoyed', 'dizzy', 'startle', 'wake', 'landed']);
// 反应期间临时换的情绪（立绘换差分、Live2D 换表情），演完换回来
const REACTION_EMOTION = { headTap: 'shy', pat: 'affectionate', annoyed: 'angry', dizzy: 'surprised', startle: 'surprised' };
// 头顶冒出的小符号
const LIFE_FX = { annoyed: '💢', dizzy: '💫', pat: '💕', sleepPat: '💕', headTap: '♪', hum: '♪', startle: '❗', yawn: '💭', wake: '✨' };
const LIFE_ANNOYED_AT = 3; // 与 petLife 的 annoyedAt 一致：连点到这一下就不再打开输入框

const $ = (id) => document.getElementById(id);
let backend = null;
let frame = { state: null, emotion: 'neutral', intensity: 0, source: 'idle' };
let lastActivity = Date.now();
let life = null; // petLife：闲时小动作、困了睡、被吵醒、连点和摸头（start 里创建）

// setActive 的参数：true/false 是旧的「有动静 / 空闲」，也可以直接给档位名
function fpsTier(level) {
    if (level === true) return 'active';
    if (level === false) return 'idle';
    return level === 'sleep' || level === 'idle' ? level : 'active';
}
// 主进程给的设置：大小、免打扰。别的模块（声音、待机反应）读 window.deskPetPrefs 或听 'deskpet:prefs' 事件。
let prefs = { scale: 1, doNotDisturb: false };
// 免打扰时只有「在回桌宠上说的话」的回复还显示气泡：发出后这么久内开始的回复，
// 以及紧接着这种回复（工具调用后的续写）开始的回复
const OWN_REPLY_WINDOW_MS = 30000;
const OWN_FOLLOW_UP_MS = 5000;

// ---- 气泡：状态、回复文字、提示 ----------------------------------------------

const bubble = {
    reply: '',          // 当前回复里可见的文字（还带着 Markdown 记号，显示前再整理）
    replyId: null,      // 正在流式的回复
    region: null,       // 回复正读到哪种区域（thought / tool / code），null 是正文
    notice: null,       // { text, error }，临时提示，优先显示
    own: false,         // 这条回复是不是在回桌宠上说的话
    proactive: null,    // 角色主动说的话（新话题、闹钟）：{ kind, title, topicId }，正文放在 reply 里
    tags: [],           // 回复里的情绪标记 { at, emotion, intensity }，at 是它在 reply 里的位置（朗读时按句换表情）
    hovered: false,
    hideTimer: 0,
    noticeTimer: 0,
    renderQueued: false,
};

// ---- 出声：回复按句交给 TTS，气泡和表情跟着念到的那一句走（见 voice.js） ----------------

let director = null;
const speech = createSpeech({
    api,
    onChange: () => {
        // 念着的时候不打哈欠、不睡着
        life?.hold('speak', speech.active());
        renderBubble();
        // 回复早就结束、刚念完：现在才开始算气泡停留时间
        // 闹钟、新话题按它们自己的停留时间算（念完不能把 60 秒的闹钟缩成几秒）
        if (!bubble.replyId && !speech.active() && bubble.reply) scheduleReplyHide(Math.max(replyHoldMs(), PROACTIVE_HOLD_MS[bubble.proactive?.kind] || 0));
    },
    onFrame: (next) => applyFrame(next),
    onRelease: () => { if (director) applyFrame(director.frame); },
    onLevel: (open) => {
        document.body.style.setProperty('--voice', open.toFixed(3));
        backend?.setMouth?.(open);
        if (open) lastActivity = Date.now();
    },
    onError: (error) => console.warn('[DeskPet] 播放朗读音频失败：', error?.message || error),
});

// 说话时嘴张多大：朗读时跟着声音走；没有朗读时，回复流出来的那段时间假装在说（fake 给出假口型）。
function talkLevel(fake) {
    const voiced = speech.mouth();
    if (voiced != null) return voiced;
    return bubble.replyId && !frame.state ? fake() : 0;
}

// 状态写在回复下方的小字里：思考只在真的读到思维链时提示（刚开口那一下导演还停在「思考」上）
function replyStateLabel() {
    if (!frame.state) return '';
    if (frame.state === 'thinking') return bubble.replyId && bubble.region === 'thought' ? STATE_LABEL.thinking : '';
    if (frame.state === 'tool' && toolCard?.visible) return ''; // 小卡片已经说了在做什么
    return STATE_LABEL[frame.state] || '';
}

function renderBubble() {
    bubble.renderQueued = false;
    const el = $('bubble');
    const text = $('bubbleText');
    let content = '';
    let mode = '';
    // 免打扰：主窗口里聊天的回复不在桌宠头上冒出来，只有在桌宠上说的话才回气泡
    const muted = isQuiet() && !bubble.own;
    // 朗读时只显示到正在念的这一句；还没开口时显示省略号
    const revealEnd = speech.revealEnd();
    const source = revealEnd == null ? bubble.reply : bubble.reply.slice(0, revealEnd);
    const waiting = revealEnd != null && !source.trim() && speech.active();
    const reply = muted ? '' : source.trim() ? toBubbleText(source) : (waiting ? '…' : '');
    if (bubble.notice) {
        content = bubble.notice.text;
        mode = bubble.notice.error ? 'is-error' : 'is-notice';
    } else if (reply) {
        content = reply;
        mode = 'is-reply';
    } else if (!muted && frame.state && STATE_LABEL[frame.state] && !(frame.state === 'tool' && toolCard?.visible)) {
        content = STATE_LABEL[frame.state];
        mode = 'is-state';
    }
    el.hidden = !content;
    el.className = `pet-ui ${mode}`;
    el.classList.toggle('is-streaming', mode === 'is-reply' && (Boolean(bubble.replyId) || speech.active()));
    const shown = content.length > BUBBLE_MAX_CHARS ? `…${content.slice(-BUBBLE_MAX_CHARS)}` : content;
    if (text.textContent !== shown) {
        text.textContent = shown;
        // 只有用户没往上翻时才跟到底部
        if (!bubble.hovered) text.scrollTop = text.scrollHeight;
    }
    // 排队等发的话写在小字里，不盖住正在说的回复
    const queued = composer.queued ? `说完就发：「${shorten(composer.queued)}」` : '';
    $('bubbleState').textContent = mode === 'is-reply' || mode === 'is-state'
        ? [mode === 'is-reply' ? replyStateLabel() || proactiveLabel() : '', queued].filter(Boolean).join(' · ')
        : '';
    el.classList.toggle('is-alarm', mode === 'is-reply' && bubble.proactive?.kind === 'alarm');
    if (content) aimBubble(aimedHeadX);
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
        // 还在念就等念完（念完时会重新计时）
        if (bubble.replyId || bubble.hovered || speech.active()) return;
        bubble.reply = '';
        bubble.proactive = null;
        renderBubble();
    }, ms);
}

function proactiveLabel() {
    const p = bubble.proactive;
    if (!p) return '';
    if (p.kind === 'alarm') return '⏰ 闹钟';
    return p.title ? `💬 新话题「${shorten(p.title)}」· 点我去看` : '💬 新话题 · 点我去看';
}

// 角色主动说话（AI 开了新话题、闹钟到点）。正在回复时先记着，回复说完再说。
const PROACTIVE_HOLD_MS = { topic: 20000, alarm: 60000 };
let pendingProactive = [];
let toolCard = null; // 「正在做什么」小卡片（bindStream 里建）
let proactiveDirector = null;

function speakProactive(payload) {
    if (!payload?.text && !payload?.title) return;
    if (bubble.replyId || speech.active()) {
        pendingProactive = [...pendingProactive, payload].slice(-3);
        // 上一条已经回复完、只是还在念：念完再说
        if (!bubble.replyId) setTimeout(flushProactive, 1500);
        return;
    }
    const kind = payload.kind === 'alarm' ? 'alarm' : 'topic';
    // 免打扰：自己开新话题这种不说；闹钟是用户自己定的，照常叫
    if (kind !== 'alarm' && isQuiet()) return;
    bubble.proactive = { kind, title: payload.title || '', topicId: payload.topicId || '' };
    bubble.own = kind === 'alarm';
    bubble.reply = payload.text || payload.title;
    lastActivity = Date.now();
    life?.wake({ startle: true });
    proactiveDirector?.nudge({ emotion: kind === 'alarm' ? 'excited' : 'happy', intensity: 0.7, source: 'proactive' });
    backend?.tap?.();
    // 主动说的话也念出来（助手设了音色、没在菜单里关掉朗读时）
    speech.begin(`deskpet-proactive-${Date.now()}`, { silent: isQuiet() && !bubble.own });
    speech.finish(bubble.reply, proactiveDirector?.frame);
    renderBubble();
    scheduleReplyHide(PROACTIVE_HOLD_MS[kind]);
}

function flushProactive() {
    const next = pendingProactive.shift();
    if (next) speakProactive(next);
}

function notice(text, { error = false, ms = 6000 } = {}) {
    bubble.notice = text ? { text, error } : null;
    clearTimeout(bubble.noticeTimer);
    if (text) bubble.noticeTimer = setTimeout(() => { bubble.notice = null; renderBubble(); }, ms);
    renderBubble();
}

let badgeTimer = 0;
function flashEmotionBadge(emotion, source) {
    if (isQuiet()) return;
    const el = $('emotionBadge');
    const suffix = source === 'rule' ? '（推测）' : source === 'mood' ? '（心情）' : '';
    el.textContent = `${EMOTION_EMOJI[emotion] || ''} ${EMOTION_LABEL[emotion] || emotion}${suffix}`;
    el.hidden = false;
    el.classList.remove('is-fading');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => el.classList.add('is-fading'), 2500);
}

// ---- 输入框 ---------------------------------------------------------------------

const composer = { open: false, sending: false, queued: null, lastSentAt: 0, ownReplyEndedAt: 0 };

// 脚边的小胶囊（样式在 dock.css）：hidden 收起、pill 小胶囊、bar 输入条、rec 录音。
const dock = { mode: 'hidden', hover: false, dragging: false, showTimer: 0, hideTimer: 0, voice: null };

function setDock(mode) {
    if (dock.mode === mode) return;
    const previous = dock.mode;
    dock.mode = mode;
    $('dock').dataset.mode = mode;
    composer.open = mode === 'bar';
    // 打字、录音的时候别打瞌睡
    life?.hold('composer', mode === 'bar' || mode === 'rec');
    // 输入条要打字、录音时要能按 Esc 取消：整窗可点、可聚焦；其余时候回到按像素穿透
    const focused = (m) => m === 'bar' || m === 'rec';
    if (focused(mode) !== focused(previous)) {
        api.setInteractive(focused(mode));
        // 收起后主进程回到穿透：下一次命中不管和上次一样不一样都要报上去
        if (!focused(mode)) lastHit = null;
    }
    if (mode === 'bar') {
        fitComposerInput();
        setTimeout(() => $('composerInput').focus(), 60);
    }
}

// 光标进出角色（或小胶囊本身）：停一下才冒出来，离开一会儿才收回去；输入条、录音时不跟着收
function dockHover(on) {
    if (on === dock.hover) return;
    dock.hover = on;
    clearTimeout(dock.showTimer);
    clearTimeout(dock.hideTimer);
    if (dock.mode === 'bar' || dock.mode === 'rec') return;
    if (on && dock.mode === 'hidden') {
        dock.showTimer = setTimeout(() => { if (dock.hover && !dock.dragging) setDock('pill'); }, DOCK_SHOW_MS);
    } else if (!on && dock.mode === 'pill') {
        dock.hideTimer = setTimeout(() => { if (!dock.hover) setDock('hidden'); }, DOCK_HIDE_MS);
    }
}

function restingDock() {
    return dock.hover && !dock.dragging ? 'pill' : 'hidden';
}

function openComposer() {
    dock.voice?.cancel();
    setDock('bar');
}

function closeComposer() {
    dock.voice?.cancel();
    setDock(restingDock());
}

// 输入条跟着字数长高（最多 4 行），外框的高度一起动
function fitComposerInput() {
    const input = $('composerInput');
    input.style.height = 'auto';
    const height = Math.min(96, Math.max(36, input.scrollHeight));
    input.style.height = `${height}px`;
    $('dock').style.setProperty('--dock-bar-h', `${height + 12}px`);
    $('composerSend').classList.toggle('is-empty', !input.value.trim());
}

// ---- 说话：本地语音识别成文字，放进输入条，看一眼再发 ----

async function startVoice() {
    const voice = dock.voice;
    if (!voice || voice.active || voice.starting || $('recStop').classList.contains('is-busy')) return;
    const from = dock.mode;
    setDock('rec');
    try {
        await voice.start();
        voice.onLimit(() => finishVoice());
    } catch (error) {
        if (error.code === 'cancelled') return; // 打开麦克风前就被收起：界面已经是别的状态了
        notice(error.message, { error: true, ms: error.code === 'no-model' ? 8000 : 5000 });
        setDock(from === 'bar' ? 'bar' : restingDock());
    }
}

async function finishVoice() {
    const voice = dock.voice;
    const stop = $('recStop');
    // 麦克风还没打开就点了停：当作取消
    if (voice?.starting) {
        voice.cancel();
        setDock($('composerInput').value.trim() ? 'bar' : restingDock());
        return;
    }
    if (!voice?.active || stop.classList.contains('is-busy')) return;
    stop.classList.add('is-busy');
    let text = '';
    try {
        text = await voice.stop();
    } catch (error) {
        notice(error.message, { error: true, ms: 5000 });
    } finally {
        stop.classList.remove('is-busy');
    }
    if (dock.mode !== 'rec') return; // 识别期间点了打字
    const input = $('composerInput');
    if (text) {
        input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text;
        setDock('bar');
        fitComposerInput();
    } else {
        if (!input.value.trim()) notice('没听到说话', { ms: 3000 });
        setDock(input.value.trim() ? 'bar' : restingDock());
    }
}

function shorten(text, max = 16) {
    const flat = text.replace(/\s+/g, ' ');
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function sendText(text) {
    composer.sending = true;
    $('composerSend').disabled = true;
    fitComposerInput();
    // 先记下发出时间：回复流的开头可能比发送结果先到
    const previousSentAt = composer.lastSentAt;
    composer.lastSentAt = Date.now();
    try {
        const result = await api.send(text);
        if (result?.success) return true;
        composer.lastSentAt = previousSentAt;
        notice(`没发出去：${result?.error || '未知原因'}`, { error: true });
    } catch (error) {
        composer.lastSentAt = previousSentAt;
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
        fitComposerInput();
        closeComposer();
        renderBubble();
        return;
    }
    if (await sendText(text)) {
        input.value = '';
        fitComposerInput();
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
    input.addEventListener('input', fitComposerInput);
    $('composer').addEventListener('submit', (e) => { e.preventDefault(); submitComposer(); });
    $('composerSend').addEventListener('click', submitComposer);
    $('dockEdit').addEventListener('click', openComposer);
    $('recEdit').addEventListener('click', openComposer);
    $('dockVoice').addEventListener('click', startVoice);
    $('composerMic').addEventListener('click', startVoice);
    $('recStop').addEventListener('click', finishVoice);
    dock.voice = createDictation({
        status: () => api.sttStatus(),
        transcribe: (wav, language) => api.transcribe(wav, language),
        onLevel: (level) => $('recStop').style.setProperty('--level', level.toFixed(2)),
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dock.mode === 'rec') {
            e.preventDefault();
            dock.voice.cancel();
            setDock(restingDock());
        }
    });
    fitComposerInput();
    // 点气泡打开主窗口看完整回复；鼠标停在气泡上时先不收起，方便读完或往上翻。
    const bubbleEl = $('bubble');
    bubbleEl.addEventListener('click', () => {
        // 主动开的新话题：直接切到那个话题
        if (bubble.proactive?.topicId && !bubble.replyId) api.openTopic(bubble.proactive.topicId);
        else api.openMainWindow();
    });
    bubbleEl.addEventListener('mouseenter', () => {
        bubble.hovered = true;
        clearTimeout(bubble.hideTimer);
    });
    bubbleEl.addEventListener('mouseleave', () => {
        bubble.hovered = false;
        if (bubble.reply && !bubble.replyId) scheduleReplyHide(REPLY_HOLD_AFTER_HOVER_MS);
    });
    // 快捷键再按一次是收起（输入框里还有字时不收，免得误按丢了）；设置页预览里打的字直接发出去
    api.onOpenInput(({ toggle, submit } = {}) => {
        if (submit) {
            // 不展开输入条、不抢焦点（人还在主窗口的设置页里），也不动桌宠输入条里已经打的字；
            // TA 正在回或上一句还在发：排到这条说完再发，连着来的几句不会互相顶掉
            if (composer.sending || bubble.replyId) {
                composer.queued = composer.queued ? `${composer.queued}\n${submit}` : submit;
                renderBubble();
            } else sendText(submit);
        } else if (toggle && composer.open && !input.value.trim()) closeComposer();
        else openComposer();
    });
    // 失焦（点到别的程序）且没写东西时自动收起，回到穿透状态。
    window.addEventListener('blur', () => {
        // 录音中切到别的程序：麦克风别一直开着（Esc 也按不到这里了）
        if (dock.mode === 'rec') closeComposer();
        else if (composer.open && !input.value.trim()) closeComposer();
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
        if (el.hidden || el.dataset.mode === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        rect = rect ? union(rect, r) : { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return rect;
}

// 气泡挪到头的正上方（窗口比气泡宽时），小尾巴指着头
let aimedHeadX = null;
function aimBubble(headX) {
    aimedHeadX = headX;
    if (headX === null) return;
    const stack = $('uiStack');
    const room = stack.clientWidth;
    const left = stack.getBoundingClientRect().left;
    for (const el of [$('bubble'), $('toolCard')]) {
        if (el.hidden) continue;
        const width = el.offsetWidth;
        const slack = Math.max(0, (room - width) / 2);
        const shift = Math.round(Math.max(-slack, Math.min(slack, headX - left - room / 2)));
        el.style.translate = shift ? `${shift}px 0` : '';
        if (el.id === 'bubble') {
            const bubbleLeft = left + (room - width) / 2 + shift;
            el.style.setProperty('--tail-x', `${Math.round(Math.max(16, Math.min(width - 16, headX - bubbleLeft)))}px`);
        }
    }
}

// ---- 拖动、点击、双击、右键 -------------------------------------------------------

function bindPointer({ onTap, onDoubleTap, onTapDown, onDrag }) {
    let down = null;
    let lastTap = 0;
    let lastUp = 0;
    let pairGap = Infinity; // 双击第一下离再前一下有多久：隔了一会儿才双击，是真想打开输入框，不是在连点
    let tapTimer = 0;
    window.addEventListener('pointerdown', (e) => {
        api.touched?.();
        if (e.button !== 0 || e.target?.closest?.('.pet-ui')) return;
        // 上一次按下没收到 pointerup（被菜单、切窗口打断）时，先把它的拖动收尾（窗口和被拎着的姿势都放下）。
        if (down?.dragging) {
            api.dragEnd();
            onDrag('end');
        }
        down = { x: e.screenX, y: e.screenY, dragging: false, cx: e.clientX, cy: e.clientY };
        // 捕获指针：窗口跟着光标移动时 pointerup 也一定回到这里。
        try { e.target?.setPointerCapture?.(e.pointerId); } catch { /* 指针已经没了 */ }
    });
    window.addEventListener('pointermove', (e) => {
        lastActivity = Date.now();
        if (!down) return;
        if (down.dragging) {
            onDrag('move', e);
            return;
        }
        if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
            down.dragging = true;
            api.dragStart({ x: down.x, y: down.y });
            onDrag('start', e);
        }
    });
    window.addEventListener('pointerup', () => {
        if (!down) return;
        const at = { x: down.cx, y: down.cy };
        if (down.dragging) {
            api.dragEnd();
            onDrag('end');
            down = null;
            return;
        }
        // 每一下都先报去数连点，再分单击、双击
        onTapDown(at);
        const upAt = Date.now();
        const gap = upAt - lastUp;
        lastUp = upAt;
        if (upAt - lastTap < DOUBLE_TAP_MS) {
            // 双击只打开输入框，不先做一遍单击的开心动作
            clearTimeout(tapTimer);
            lastTap = 0;
            onDoubleTap({ afterPause: pairGap >= DOUBLE_TAP_MS });
        } else {
            pairGap = gap;
            lastTap = upAt;
            clearTimeout(tapTimer);
            tapTimer = setTimeout(() => onTap(at), DOUBLE_TAP_MS);
        }
        down = null;
    });
    // 触屏手势被系统接管（pointercancel）、拖到一半切走窗口时收不到 pointerup，拖动必须在这里结束。
    const abort = () => {
        if (down?.dragging) {
            api.dragEnd();
            onDrag('end');
        }
        down = null;
    };
    window.addEventListener('pointercancel', abort);
    window.addEventListener('blur', abort);
    // Ctrl（macOS 上 Cmd）+ 滚轮调大小；气泡上的滚轮留给翻看回复
    window.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.target?.closest?.('.pet-ui')) return;
        e.preventDefault();
        const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
        api.wheelResize?.(px);
    }, { passive: false });
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
// 闲时和互动的动作：先看 deskpet.json 的 motions，再按组名找；都没有就只靠参数曲线演（lifeMotion.js）。
const LIFE_MOTIONS = {
    headTap: ['TapHead', 'Tap@Head', 'Head'],
    pat: ['TapHead', 'Tap@Head', 'Head'],
    annoyed: ['Angry', 'Flick@Body', 'Flick', 'Shake'],
    dizzy: ['Dizzy', 'Shake', 'FlickDown'],
    startle: ['Surprised', 'FlickUp', 'Flick'],
    yawn: ['Yawn', 'Sleepy'],
    stretch: ['Stretch'],
    hum: ['Happy', 'Dance'],
    wake: ['Wake', 'WakeUp'],
    landed: ['Landing', 'FlickDown'],
};
const LIFE_MOTION_WEIGHT = 0.4; // 模型自己有这个动作时，参数曲线只轻轻叠一点

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
    model.anchor.set(0.5, 1);
    // 角色画在下方，上面留给气泡和输入框；量出轮廓后按轮廓摆，脚底贴窗口底边（见 createFigureFit）。
    let hop = 0;
    const figure = createFigureFit(app, canvas, {
        width: model.internalModel.width,
        height: model.internalModel.height,
        apply(fit) {
            model.scale.set(fit.scale);
            model.position.set(fit.x, fit.y - hop);
        },
    });

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
    function pickLifeMotion(name) {
        const configured = profile.motions?.[name];
        if (configured && motionGroups.includes(configured)) return configured;
        return (LIFE_MOTIONS[name] || []).find((g) => motionGroups.includes(g)) || null;
    }
    const life = createLifeMotion();

    // 闲时动作、拖动摆动、情绪参数要在物理之前叠上去：引擎每帧的顺序是 动作 → 表情 → 眨眼 → 视线 →
    // updateNaturalMovements（呼吸）→ 物理 → pose → beforeModelUpdate，叠在 beforeModelUpdate 里的
    // 头歪、身体晃不会带动头发和衣服的物理。所以接在 updateNaturalMovements 后面加，嘴和跳一下仍在后面。
    const current = {};
    let target = {};
    let mouthPhase = 0;
    const naturalMovements = internal.updateNaturalMovements.bind(internal);
    internal.updateNaturalMovements = (now, dt) => {
        naturalMovements(now, dt);
        addLifeAndEmotion();
    };
    let lifeFrame = { params: {}, hop: 0 };
    function addLifeAndEmotion() {
        // 闲时动作、困意、拖动摆动：叠在情绪之上
        lifeFrame = life.step(app.ticker.deltaMS / 1000);
        for (const [id, v] of Object.entries(lifeFrame.params)) {
            if (paramIds.has(id)) coreModel.addParameterValueById(internal.getIdSafe(id), v);
        }
        const keys = new Set([...Object.keys(current), ...Object.keys(target)]);
        for (const id of keys) {
            const goal = target[id] || 0;
            current[id] = (current[id] || 0) + (goal - (current[id] || 0)) * 0.12;
            if (Math.abs(current[id]) < 0.001 && !goal) { delete current[id]; continue; }
            if (paramIds.has(id)) coreModel.addParameterValueById(internal.getIdSafe(id), current[id]);
        }
    }
    internal.on('beforeModelUpdate', () => {
        // 跳一下改的是模型位置
        if (lifeFrame.hop !== hop) {
            hop = lifeFrame.hop;
            model.position.y = figure.base().y - hop;
        }
        // 嘴：朗读时按声音的音量开合；没开朗读时回复流出来就假装在说话。
        if (paramIds.has('ParamMouthOpenY')) {
            const open = talkLevel(() => {
                mouthPhase += 0.55 + Math.random() * 0.35;
                return 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(mouthPhase));
            });
            if (open) coreModel.addParameterValueById(internal.getIdSafe('ParamMouthOpenY'), open);
        }
    });

    const alphaProbe = createAlphaProbe(app);

    let lastExpression = null;
    return {
        kind: 'live2d',
        probe: alphaProbe.probe,
        // 视线跟光标：不用模型自带的 focus（它只取方向，光标在上面就仰到最大），按离头多远、往哪边转多少
        focus(x, y) {
            const h = figure.head();
            const g = shapeGaze((x - h.x) / (window.innerWidth * 0.6), (h.y + h.width * 0.5 - y) / (window.innerHeight * 0.6));
            internal.focusController.focus(g.x, g.y);
        },
        bounds() { const b = model.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height }; },
        head: () => figure.head(),
        figureReady: figure.ready,
        tap() {
            const group = pickMotion('happy') || motionGroups.find((g) => /tap/i.test(g));
            if (group) model.motion(group);
        },
        // motion: false 只换表情和参数（换阶段、互动反应演完换回来），不再放一遍情绪动作
        apply(f, { changed, motion = true }) {
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
            if (!f.state && motion) {
                const group = pickMotion(f.emotion);
                if (group) model.motion(group);
            }
        },
        setActive(level) { app.ticker.maxFPS = fps[fpsTier(level)]; },
        life: {
            phase(p) { life.setPhase(p); },
            act(name, ms) {
                const group = pickLifeMotion(name);
                life.play(name, ms, { weight: group ? LIFE_MOTION_WEIGHT : 1 });
                // 互动动作要马上看到：打断待机动作再放（同一个动作连着放也能重播）
                if (group) {
                    internal.motionManager?.stopAllMotions?.();
                    model.motion(group, undefined, PIXI.live2d.MotionPriority?.FORCE ?? 3);
                }
            },
            held(on) { life.setHeld(on); },
            dragVelocity(vx) { life.dragVelocity(vx); },
            // 视线：g 以头为原点、-1..1；换算成窗口坐标交给模型自己的视线跟随
            gaze(g) {
                const v = limitGaze(g);
                internal.focusController.focus(v.x, v.y);
            },
        },
        // 窗口藏起来时整个停掉（窗口关了后台节流，不停的话隐藏着也在一直画）
        setPaused(paused) {
            if (paused) app.ticker.stop();
            else if (!app.ticker.started) app.ticker.start();
        },
        info: { coreVersion, expressions: expressionNames, motionGroups, renderer: webgl.renderer, software: webgl.software },
    };
}

// ---- 网格立绘后端（*.puppet.json，见 puppet.js） ------------------------------------

// 呼吸、眨眼、视线和说话这些自动动作；Live2D 模型自带，网格立绘要自己做。
function createIdleAnimator() {
    let nextBlink = 1.5 + Math.random() * 3;
    let blinkT = -1;
    let doubleBlink = false;
    let mouthPhase = 0;
    let t = 0;
    return {
        step(dt) {
            t += dt;
            nextBlink -= dt;
            if (blinkT < 0 && nextBlink <= 0) {
                blinkT = 0;
                doubleBlink = Math.random() < 0.18;
                nextBlink = 2.5 + Math.random() * 4;
            }
            let eyeClose = 0;
            if (blinkT >= 0) {
                blinkT += dt;
                const CLOSE = 0.07, HOLD = 0.04, OPEN = 0.11;
                if (blinkT < CLOSE) eyeClose = blinkT / CLOSE;
                else if (blinkT < CLOSE + HOLD) eyeClose = 1;
                else if (blinkT < CLOSE + HOLD + OPEN) eyeClose = 1 - (blinkT - CLOSE - HOLD) / OPEN;
                else if (doubleBlink) { doubleBlink = false; blinkT = 0; }
                else blinkT = -1;
            }
            const talk = talkLevel(() => {
                mouthPhase += dt * (9 + Math.random() * 5);
                return 0.2 + 0.45 * Math.max(0, Math.sin(mouthPhase)) * (0.6 + 0.4 * Math.sin(mouthPhase * 0.37));
            });
            return {
                breath: 0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / 3.6),
                eyeClose,
                talk,
                swayZ: 2.2 * Math.sin(t * 0.45) + 0.8 * Math.sin(t * 1.1),
                swayX: 3 * Math.sin(t * 0.31),
            };
        },
    };
}

async function createPuppetBackend(assets) {
    const webgl = probeWebGL();
    if (!webgl) throw userFacing('当前环境没有 WebGL（显卡加速被禁用？），网格立绘画不出来，先用普通立绘代替。');
    const fps = webgl.software ? FPS_SOFTWARE : FPS;
    const { createPuppet } = await import('vcp-deskpet://pet/app/puppet.js');
    const canvas = $('live2dCanvas');
    canvas.hidden = false;
    // 与 Live2D 相同：上下文丢了就整页重载，短时间内反复丢由 start() 改用立绘。
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
        antialias: !webgl.software,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
        preserveDrawingBuffer: false,
        powerPreference: 'low-power',
    });
    app.ticker.maxFPS = fps.active;
    try {
        return await mountPuppet(app, await createPuppet(assets.puppet.rigUrl), { webgl, fps });
    } catch (error) {
        canvas.removeEventListener('webglcontextlost', onContextLost);
        app.destroy({ removeView: false }, { children: true });
        canvas.hidden = true;
        throw error;
    }
}

async function mountPuppet(app, puppet, { webgl, fps }) {
    const holder = new PIXI.Container();
    holder.addChild(puppet.root);
    app.stage.addChild(holder);
    let scale = 1;
    puppet.root.pivot.set(puppet.width / 2, puppet.height);
    // 与 Live2D 相同：先按底图大小摆，量出轮廓后按轮廓摆
    const figure = createFigureFit(app, $('live2dCanvas'), {
        width: puppet.width,
        height: puppet.height,
        apply(fit) {
            scale = fit.scale;
            puppet.root.scale.set(scale);
            holder.position.set(fit.x, fit.y);
        },
    });

    const idle = createIdleAnimator();
    const params = {};
    const current = {};
    let target = {};
    const look = { x: 0, y: 0, tx: 0, ty: 0 };
    let hop = 0, hopV = 0;
    const life = createLifeMotion();
    let lifeParams = {};
    // 情绪目标 + 闲时动作和困意（lifeMotion）的增量
    const get = (id) => (current[id] || 0) + (lifeParams[id] || 0);
    app.ticker.add((ticker) => {
        const dt = Math.min(0.1, ticker.deltaMS / 1000);
        const a = idle.step(dt);
        const lifeFrame = life.step(dt);
        lifeParams = lifeFrame.params;
        const ease = 1 - Math.pow(1 - 0.12, dt * 60);
        for (const id of new Set([...Object.keys(current), ...Object.keys(target)])) {
            const now = current[id] || 0;
            current[id] = now + ((target[id] || 0) - now) * ease;
        }
        look.x += (look.tx - look.x) * (1 - Math.pow(1 - 0.08, dt * 60));
        look.y += (look.ty - look.y) * (1 - Math.pow(1 - 0.08, dt * 60));
        // 单击时跳一下：弹簧回到 0。
        hopV += (-180 * hop - 12 * hopV) * dt;
        hop += hopV * dt;
        holder.position.y = figure.base().y + hop - lifeFrame.hop;

        params.ParamAngleX = get('ParamAngleX') + look.x * 22 + a.swayX;
        params.ParamAngleY = get('ParamAngleY') + look.y * 16;
        params.ParamAngleZ = get('ParamAngleZ') + a.swayZ - look.x * 4;
        params.ParamEyeBallX = clampUnit(get('ParamEyeBallX') + look.x * 0.9);
        params.ParamEyeBallY = clampUnit(get('ParamEyeBallY') + look.y * 0.8);
        for (const side of ['L', 'R']) {
            const open = puppet.defaults[`ParamEye${side}Open`] + get(`ParamEye${side}Open`);
            params[`ParamEye${side}Open`] = Math.max(0, open * (1 - a.eyeClose));
            params[`ParamEye${side}Smile`] = get(`ParamEye${side}Smile`);
        }
        params.ParamMouthForm = get('ParamMouthForm');
        params.ParamMouthOpenY = Math.max(get('ParamMouthOpenY'), a.talk);
        params.ParamCheek = get('ParamCheek');
        params.ParamBreath = a.breath;
        puppet.update(params, dt);
    });

    const probe = createAlphaProbe(app);
    return {
        kind: 'puppet',
        probe: probe.probe,
        focus(x, y) {
            // 视线跟着光标：以脸为原点，按窗口尺寸归一化。
            const hx = holder.position.x + (puppet.headCenter[0] - puppet.width / 2) * scale;
            const hy = holder.position.y + (puppet.headCenter[1] - puppet.height) * scale;
            const g = shapeGaze((x - hx) / (window.innerWidth * 0.6), (hy - y) / (window.innerHeight * 0.6));
            look.tx = g.x;
            look.ty = g.y;
        },
        // 用静止时量出的轮廓，不跟着呼吸、单击轻跳和头发摆动抖（气泡按它贴头顶）。
        bounds: () => figure.bounds(),
        head: () => figure.head(),
        figureReady: figure.ready,
        tap() { hopV = -260; },
        apply(f) {
            const intensity = Math.max(0.3, Math.min(1, f.intensity || 0.6));
            target = {};
            for (const [id, v] of Object.entries(EMOTION_PARAMS[f.emotion] || {})) target[id] = v * intensity;
            for (const [id, v] of Object.entries(STATE_PARAMS[f.state] || {})) target[id] = (target[id] || 0) + v;
        },
        setActive(level) { app.ticker.maxFPS = fps[fpsTier(level)]; },
        life: {
            phase(p) { life.setPhase(p); },
            act(name, ms) { life.play(name, ms); },
            held(on) { life.setHeld(on); },
            dragVelocity(vx) { life.dragVelocity(vx); },
            gaze(g) { const v = limitGaze(g); look.tx = v.x; look.ty = v.y; },
        },
        setPaused(paused) {
            if (paused) app.ticker.stop();
            else if (!app.ticker.started) app.ticker.start();
        },
        info: { ...puppet.info, renderer: webgl.renderer, software: webgl.software },
    };
}

function clampUnit(v) {
    return Math.max(-1, Math.min(1, v));
}

// ---- 按轮廓摆放（Live2D、网格立绘） ------------------------------------------------
// 模型画布、底图四周常留着透明边（全身模型脚下空一截），按画布摆脚会浮在半空。
// 先按画布摆，等物理和待机动作稳下来，读回整帧量出不透明像素的轮廓和头，再按轮廓摆：
// 脚底贴窗口底边、左右居中、塞满角色区。量之前画布透明，看不到它先浮着再落下来。
// 坐标单位：以锚点（画布底边中点）为原点、1 倍缩放的模型像素；窗口一变就按同一个轮廓重摆。

function createFigureFit(app, canvas, { width, height, apply }) {
    let box = { left: -width / 2, right: width / 2, top: -height, bottom: 0 };
    let head = null;
    let fit = null;
    let measured = false;
    const layout = () => {
        fit = fitSilhouette(box, { width: window.innerWidth, height: window.innerHeight, topReserve: TOP_RESERVE })
            || { scale: 1, x: window.innerWidth / 2, y: window.innerHeight };
        apply(fit);
    };
    layout();
    window.addEventListener('resize', layout);
    canvas.style.opacity = '0';

    const measureOnce = () => {
        app.render();
        const gl = app.renderer.gl;
        const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const s = measureSilhouette(pixels, w, h, { flipY: true });
        if (!s) return false;
        const r = app.renderer.resolution || 1;
        const u = (px) => (px / r - fit.x) / fit.scale;
        const v = (py) => (py / r - fit.y) / fit.scale;
        box = { left: u(s.left), right: u(s.right), top: v(s.top), bottom: v(s.bottom) };
        head = { x: u(s.head.x), y: v(s.head.y), width: s.head.width / r / fit.scale };
        measured = true;
        layout();
        return touchesEdge(s, w, h) ? 'clipped' : true;
    };
    // 第一次摆的时候形象可能有一截在窗口外（模型画布四周留白不对称），量到的是被裁过的轮廓、摆出来会偏；
    // 按量到的摆好以后再量，直到整个形象都在窗口里
    const measure = () => {
        let result = false;
        for (let i = 0; i < 4; i++) {
            result = measureOnce();
            if (result !== 'clipped') break;
        }
        return result ? silhouetteAspect(box) : null;
    };
    const ready = new Promise((resolve) => {
        setTimeout(() => {
            let aspect = null;
            try { aspect = measure(); } catch (error) { console.warn('[DeskPet] 量轮廓失败：', error); }
            canvas.style.transition = 'opacity 160ms ease';
            canvas.style.opacity = '1';
            resolve(aspect);
        }, FIGURE_MEASURE_MS);
    });
    const toWindow = (b) => ({ x: fit.x + b.left * fit.scale, y: fit.y + b.top * fit.scale, width: (b.right - b.left) * fit.scale, height: (b.bottom - b.top) * fit.scale });
    return {
        ready,
        base: () => fit,
        bounds: () => toWindow(box),
        // 没量出来时按包围盒估：头在顶上、宽度取一半
        head() {
            if (measured && head) return { x: fit.x + head.x * fit.scale, y: fit.y + head.y * fit.scale, width: head.width * fit.scale };
            const b = toWindow(box);
            return { x: b.x + b.width / 2, y: b.y, width: b.width * 0.5 };
        },
    };
}

// 按像素命中：在当帧渲染之后读 alpha。
function createAlphaProbe(app) {
    const gl = app.renderer.gl;
    const pixel = new Uint8Array(4);
    let pending = null;
    const readAlpha = (x, y) => {
        const r = app.renderer.resolution;
        gl.readPixels(Math.floor(x * r), Math.floor(gl.drawingBufferHeight - y * r - 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return pixel[3];
    };
    app.ticker.add(() => {
        if (!pending) return;
        const { x, y } = pending;
        pending = null;
        reportHit(readAlpha(x, y) >= HIT_ALPHA);
    }, null, PIXI.UPDATE_PRIORITY.UTILITY);
    return {
        probe(x, y) {
            if (app.ticker.started) { pending = { x, y }; return; }
            app.render();
            reportHit(readAlpha(x, y) >= HIT_ALPHA);
        },
    };
}

// ---- 差分立绘 / 头像后端 ---------------------------------------------------

let lastHit = false;
function reportHit(hit) {
    if (hit !== lastHit) {
        lastHit = hit;
        api.setHit(hit);
        dockHover(hit);
    }
}

// 立绘和头像没有参数可调：阶段和动作写成 #lifeBody 上的属性，由样式里的关键帧演；
// 拖动摆动和跳一下用同一套单摆计算，只在动起来时跑 requestAnimationFrame，停稳就不再占帧。
function createCssLife() {
    const body = $('lifeBody');
    const stage = $('stage');
    const motion = createLifeMotion();
    let raf = 0;
    let last = 0;
    let paused = false;
    let actTimer = 0;
    const loop = (ts) => {
        raf = 0;
        if (paused) return;
        const dt = last ? (ts - last) / 1000 : 1 / 60;
        last = ts;
        const { swing, hop } = motion.step(dt);
        stage.style.setProperty('--life-swing', `${swing.toFixed(2)}deg`);
        stage.style.setProperty('--life-hop', `${(-hop).toFixed(1)}px`);
        if (!motion.settled) raf = requestAnimationFrame(loop);
        else { last = 0; stage.style.removeProperty('--life-swing'); stage.style.removeProperty('--life-hop'); }
    };
    const kick = () => { if (!raf && !paused) raf = requestAnimationFrame(loop); };
    return {
        phase(p) {
            body.dataset.lifePhase = p;
            motion.setPhase(p);
        },
        act(name, ms) {
            clearTimeout(actTimer);
            delete body.dataset.lifeAct;
            void body.offsetWidth; // 同一个动作连着来也要从头播
            body.style.setProperty('--life-ms', `${ms}ms`);
            body.dataset.lifeAct = name;
            actTimer = setTimeout(() => { delete body.dataset.lifeAct; }, ms);
            motion.play(name, ms);
            kick();
        },
        held(on) { motion.setHeld(on); kick(); },
        dragVelocity(vx) { motion.dragVelocity(vx); kick(); },
        gaze() {},
        setPaused(p) {
            paused = p;
            if (!p) kick();
        },
    };
}

function createImageBackend(assets) {
    const portraits = assets.portraits;
    const cssLife = createCssLife();
    const sampler = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    let activeImg = null;

    // 图片实际画在哪里（含呼吸、跳一下这些变换），scale 是画出来的像素 ÷ 原图像素。
    function drawnRect(img) {
        const box = img.getBoundingClientRect();
        if (!img.naturalWidth || !box.width) return null;
        return { x: box.x, y: box.y, width: box.width, height: box.height, scale: box.width / img.naturalWidth };
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
        const talkImg = $('portraitTalk');
        let front = 0;
        let currentSrc = null;
        const failed = new Set();

        // 按轮廓摆：去掉透明边、脚底贴窗口底边。同一套差分画布一样大，都按第一张（默认立绘）的轮廓摆，
        // 换表情时人不会跳；画布大小不一样的那张按它自己的轮廓摆。
        const measured = new Map(); // src -> 轮廓（原图像素）
        let reference = null; // { width, height, silhouette }
        let resolveFigure = null;
        const figureReady = new Promise((resolve) => { resolveFigure = resolve; });
        const measureImage = (img) => {
            if (measured.has(img.src)) return measured.get(img.src);
            const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
            ctx.canvas.width = img.naturalWidth;
            ctx.canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);
            let silhouette = null;
            try {
                silhouette = measureSilhouette(ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data, img.naturalWidth, img.naturalHeight);
            } catch (error) {
                console.warn('[DeskPet] 量立绘轮廓失败：', error);
            }
            // 整张都是透明的（或读不了像素）就按整张图摆
            silhouette ||= { left: 0, top: 0, right: img.naturalWidth, bottom: img.naturalHeight, head: { x: img.naturalWidth / 2, y: 0, width: img.naturalWidth / 2 } };
            measured.set(img.src, silhouette);
            return silhouette;
        };
        const silhouetteOf = (img) => {
            if (!img?.naturalWidth) return null;
            if (reference && reference.width === img.naturalWidth && reference.height === img.naturalHeight) return reference.silhouette;
            return measureImage(img);
        };
        const place = (img) => {
            const silhouette = silhouetteOf(img);
            if (!silhouette) return;
            const fit = fitSilhouette(silhouette, { width: window.innerWidth, height: window.innerHeight, topReserve: TOP_RESERVE });
            if (!fit) return;
            img.style.left = `${fit.x}px`;
            img.style.top = `${fit.y}px`;
            img.style.width = `${img.naturalWidth * fit.scale}px`;
            img.style.height = `${img.naturalHeight * fit.scale}px`;
        };
        window.addEventListener('resize', () => [...layers, talkImg].forEach(place));

        const show = async (src, withPop) => {
            if (!src || src === currentSrc || failed.has(src)) return;
            currentSrc = src;
            const next = layers[1 - front];
            next.src = src;
            try {
                await next.decode();
            } catch {
                failed.add(src); // 坏图记住，不再尝试
                if (!reference) resolveFigure(null);
                return;
            }
            if (src !== currentSrc) return;
            if (!reference) {
                reference = { width: next.naturalWidth, height: next.naturalHeight, silhouette: measureImage(next) };
                resolveFigure(silhouetteAspect(reference.silhouette));
                if (talkImg.naturalWidth) place(talkImg);
            }
            place(next);
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
        // 张嘴帧（portrait.talk.png，可选）：朗读时声音大过一点就换上，小下去再换回，中间留一段免得闪
        let talking = false;
        if (portraits.talk) {
            talkImg.src = portraits.talk;
            talkImg.decode().then(() => place(talkImg)).catch(() => {});
        }
        const setMouth = (open) => {
            if (!portraits.talk) return;
            const next = talking ? open > 0.08 : open > 0.2;
            if (next === talking) return;
            talking = next;
            $('portrait').classList.toggle('is-talking', talking);
        };
        // 轮廓（原图像素）换成窗口坐标
        const inWindow = (img) => {
            const r = img && drawnRect(img);
            const silhouette = r && silhouetteOf(img);
            if (!silhouette) return null;
            return { r, silhouette };
        };
        return {
            kind: 'portrait',
            probe(x, y) {
                const r = activeImg && drawnRect(activeImg);
                if (!r || x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height) return reportHit(false);
                const a = sampler.getImageData(Math.floor((x - r.x) / r.scale), Math.floor((y - r.y) / r.scale), 1, 1).data[3];
                reportHit(a >= HIT_ALPHA);
            },
            focus() {},
            bounds() {
                const got = inWindow(activeImg);
                if (!got) return null;
                const { r, silhouette: sil } = got;
                return { x: r.x + sil.left * r.scale, y: r.y + sil.top * r.scale, width: (sil.right - sil.left) * r.scale, height: (sil.bottom - sil.top) * r.scale };
            },
            head() {
                const got = inWindow(activeImg);
                if (!got) return null;
                const { r, silhouette: sil } = got;
                return { x: r.x + sil.head.x * r.scale, y: r.y + sil.head.y * r.scale, width: sil.head.width * r.scale };
            },
            figureReady,
            tap: pop,
            canShow: (emotion) => Boolean(portraits[emotion]),
            apply(f, { changed }) { if (changed) show(urlFor(f), true); },
            setMouth,
            setActive() {},
            setPaused(paused) { cssLife.setPaused(paused); },
            life: cssLife,
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
        head() { const b = $('avatar').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y, width: b.width * 0.8 }; },
        tap() {},
        apply(f) {
            $('avatar').style.setProperty('--deskpet-ring', EMOTION_RING[f.emotion] || EMOTION_RING.neutral);
            $('avatarBadge').textContent = f.state === 'thinking' || f.state === 'tool' ? '💭' : (EMOTION_EMOJI[f.emotion] || '');
        },
        setActive() {},
        setPaused(paused) { cssLife.setPaused(paused); },
        life: cssLife,
    };
}

// ---- 头顶小符号（所有形象共用）：💢 💫 💕 ♪，睡着时冒 z ------------------------

// 睡着时的 z 一秒只挪两三下：CSS 无限动画即使分段也每帧合成，软件渲染下多占 GPU 进程几个百分点
const ZZZ_STEP_MS = 400;
const ZZZ_STEPS = 8;

function createLifeFx() {
    const el = $('lifeFx');
    let timer = 0;
    let zzzTimer = 0;
    let zzzStep = 0;
    let sleeping = false;
    const stepZzz = () => {
        const k = zzzStep / (ZZZ_STEPS - 1);
        el.style.opacity = String(k < 0.25 ? k * 4 : 1 - (k - 0.25) / 0.75);
        el.style.translate = `${Math.round(14 * k)}px ${Math.round(-36 * k)}px`;
        el.style.fontSize = `${Math.round(14 + 12 * k)}px`;
        zzzStep = (zzzStep + 1) % ZZZ_STEPS;
    };
    const stopZzz = () => {
        clearInterval(zzzTimer);
        zzzTimer = 0;
        el.style.removeProperty('opacity');
        el.style.removeProperty('translate');
        el.style.removeProperty('font-size');
    };
    const show = (glyph, ms, mode) => {
        clearTimeout(timer);
        stopZzz();
        if (mode === 'is-zzz' && !document.body.classList.contains('is-paused')) {
            zzzStep = 0;
            stepZzz();
            zzzTimer = setInterval(stepZzz, ZZZ_STEP_MS);
        }
        el.textContent = glyph;
        el.className = '';
        void el.offsetWidth;
        el.className = mode;
        el.hidden = false;
        if (ms) timer = setTimeout(() => { if (sleeping) show('z', 0, 'is-zzz'); else el.hidden = true; }, ms);
    };
    return {
        phase(p) {
            sleeping = p === 'asleep';
            if (sleeping) show('z', 0, 'is-zzz');
            else if (el.classList.contains('is-zzz')) { stopZzz(); el.hidden = true; }
        },
        // 窗口隐藏时 z 也停下
        setPaused(paused) {
            if (paused) stopZzz();
            else if (sleeping) show('z', 0, 'is-zzz');
        },
        act(name, ms) { if (LIFE_FX[name]) show(LIFE_FX[name], Math.min(ms, 1800), 'is-pop'); },
        held(on) { if (on) show('💦', 0, 'is-held'); else if (el.classList.contains('is-held')) el.hidden = true; },
    };
}

// ---- 回复流 → 导演与气泡 ----------------------------------------------------------

function applyFrame(next) {
    const changed = next.emotion !== frame.emotion || next.state !== frame.state;
    const emotionChanged = next.emotion !== frame.emotion;
    frame = next;
    lastActivity = Date.now();
    backend?.setActive(true);
    backend?.apply(shownFrame(frame), { changed });
    if (emotionChanged && (next.source === 'tag' || next.source === 'rule' || next.source === 'mood')) flashEmotionBadge(next.emotion, next.source);
    renderBubble();
}

// 朗读时一句话的表情：这句里（或之前）最后一个情绪标记；没有标记就用导演当前的情绪。
// 不直接用导演的帧：回复流得比念得快，导演为了不闪会压着切换，切句时它可能还停在「思考」上。
function sentenceFrame(sentence) {
    const tag = [...(bubble.tags || [])].reverse().find((t) => t.at < sentence.end);
    const base = director?.frame || frame;
    if (!tag) return { ...base, state: null };
    return { ...base, state: null, emotion: tag.emotion, intensity: tag.intensity ?? base.intensity, source: 'tag' };
}

// 睡着时（又没在思考、调工具）换成疲惫的表情或差分；醒来恢复原来的情绪
function shownFrame(f) {
    if (life?.phase !== 'asleep' || f.state) return f;
    // 立绘没画「疲惫」时不换（不然会退到「难过」之类不搭的差分），靠闭眼歪头和 z 表现睡着
    if (backend?.canShow && !backend.canShow('tired')) return f;
    return { ...f, emotion: 'tired', intensity: Math.max(0.7, f.intensity || 0) };
}

function bindStream(director) {
    let scanner = null;
    toolCard = createToolCard({ el: $('toolCard'), onChange: queueRenderBubble, isMuted: () => isQuiet() && !bubble.own });
    $('toolCard').addEventListener('click', () => api.openMainWindow());
    const startReply = (messageId) => {
        clearTimeout(bubble.hideTimer);
        bubble.own = Date.now() - composer.lastSentAt < OWN_REPLY_WINDOW_MS
            || (composer.ownReplyEndedAt > 0 && Date.now() - composer.ownReplyEndedAt < OWN_FOLLOW_UP_MS);
        bubble.replyId = messageId;
        bubble.reply = '';
        bubble.region = null;
        bubble.proactive = null;
        bubble.tags = [];
        scanner = createEmotionTagScanner();
        // 免打扰时主窗口里聊天的回复不念；在桌宠上说的话照常念
        speech.begin(messageId, { silent: isQuiet() && !bubble.own });
        toolCard.start();
    };
    api.onStream((event) => {
        if (!event?.messageId) return;
        lastActivity = Date.now();
        if (event.type === 'start') {
            life?.hold('reply', true);
            director.begin(event.messageId);
            startReply(event.messageId);
        } else if (event.type === 'data') {
            // 同一个助手同时有两条在流（另一个话题、主窗口和桌宠撞在一起）：气泡只跟当前这条，别的不来回抢
            if (bubble.replyId && bubble.replyId !== event.messageId) return;
            if (!bubble.replyId) startReply(event.messageId);
            life?.hold('reply', true);
            director.append(event.messageId, event.text);
            toolCard.push(event.text);
            // 气泡只显示正文：情绪标签、思维链、工具调用和结果都不显示，代码块写成 [代码]。
            for (const item of scanner.push(event.text)) {
                if (item.type === 'text') bubble.reply += item.text;
                else if (item.type === 'enter' && item.region === 'code') bubble.reply += '\n[代码]\n';
                else if (item.type === 'tag') bubble.tags.push({ at: bubble.reply.length, emotion: item.emotion, intensity: item.intensity });
            }
            bubble.region = scanner.region;
            speech.update(bubble.reply, sentenceFrame);
            queueRenderBubble();
            return;
        } else if (event.type === 'end' || event.type === 'error') {
            if (event.type === 'end') director.end(event.messageId);
            else director.fail(event.messageId);
            // 别的那条结束了：不动正在显示的这条
            if (bubble.replyId && bubble.replyId !== event.messageId) return;
            if (scanner && bubble.replyId === event.messageId) {
                for (const item of scanner.finish()) if (item.type === 'text') bubble.reply += item.text;
                if (event.type === 'end') speech.finish(bubble.reply, sentenceFrame);
                else speech.fail();
            }
            scanner = null;
            bubble.replyId = null;
            life?.hold('reply', false);
            bubble.region = null;
            composer.ownReplyEndedAt = bubble.own ? Date.now() : 0;
            scheduleReplyHide(replyHoldMs());
            toolCard.end();
            if (pendingProactive.length) setTimeout(flushProactive, Math.min(replyHoldMs(), 6000));
            // 排队的话等气泡画完这一帧再发，免得和刚结束的回复挤在一起
            if (composer.queued) setTimeout(flushQueued, 400);
        }
        renderBubble();
    });
}

// ---- 设置：大小、免打扰 -------------------------------------------------------------

function isQuiet() {
    return prefs.doNotDisturb === true;
}

function applyPrefs(next) {
    if (!next || typeof next !== 'object') return;
    const previous = prefs;
    prefs = { ...prefs, ...next };
    window.deskPetPrefs = Object.freeze({ ...prefs });
    document.documentElement.style.setProperty('--pet-scale', String(prefs.scale || 1));
    document.body.classList.toggle('is-dnd', isQuiet());
    $('dndBadge').hidden = !isQuiet();
    if (isQuiet() && !previous.doNotDisturb) $('emotionBadge').hidden = true;
    // 刚开了免打扰：正在念的主窗口回复停下
    if (isQuiet() && !previous.doNotDisturb && !bubble.own) speech.stop();
    toolCard?.refresh();
    renderBubble();
    window.dispatchEvent(new CustomEvent('deskpet:prefs', { detail: window.deskPetPrefs }));
}

// ---- 持续心情 ----------------------------------------------------------------
// 助手的持续心情（主进程记着，和侧栏立绘同一份）是待机时的表情：回复的情绪过去以后回到它。
// 心情一变，角色就换成新的待机表情，头顶的小牌子提示一下（「😊 开心（心情）」）；右键菜单第一行也写着现在的心情。

function bindMood(director, agentId) {
    // 先发的查询晚到时不能盖掉已经推过来的新心情；按主进程的广播序号比（系统时间可能被往回调）
    const accept = createMoodOrder(agentId);
    const apply = (mood) => {
        if (accept(mood)) director.setBaseline(mood);
    };
    api.onMood?.(apply);
    Promise.resolve(api.getMood?.()).then(apply).catch((error) => console.warn('[DeskPet] 读取心情失败：', error));
}

// ---- 启动 --------------------------------------------------------------------

async function start() {
    const assets = await api.getAssets();
    if (!assets) return;
    applyPrefs(await api.getPrefs?.().catch(() => null));
    api.onPrefs?.(applyPrefs);
    document.title = `${assets.name} · 桌宠`;
    // 占位只写一句：窄窗口里也不折行；按键提示放在悬停说明里
    $('composerInput').placeholder = `和 ${assets.name} 说点什么…`;
    $('composerInput').title = 'Enter 发送，Shift+Enter 换行，Esc 收起';

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
    } else if (assets.live2d && !assets.coreUrl && !assets.puppet && !assets.outfit?.builtIn) {
        // 内置 Nova 自带立绘，Core 本来就要用户自己放：不每次打开都弹红字，设置页卡片上写着
        notice(`找到了 Live2D 模型，但缺少 Cubism Core：请把 5.x 的 live2dcubismcore.min.js 放到 ${assets.corePath}`, { error: true, ms: 12000 });
    }
    if (!backend && assets.puppet && recentContextLosses().length >= CONTEXT_LOSS_LIMIT) {
        notice('显卡渲染反复中断，这次先用普通立绘。重新打开桌宠会再试。', { error: true, ms: 10000 });
    } else if (!backend && assets.puppet) {
        try {
            backend = await createPuppetBackend(assets);
        } catch (error) {
            console.error('[DeskPet] 网格立绘加载失败，改用立绘：', error);
            $('live2dCanvas').hidden = true;
            notice(error.userFacing ? error.message : `网格立绘加载失败：${error.message}`, { error: true, ms: 8000 });
        }
    }
    if (!backend) backend = createImageBackend(assets);
    document.body.dataset.backend = backend.kind;
    if (PREVIEW) {
        await renderPreview(assets);
        return;
    }

    // 朗读时表情跟着念到的句子换（见 speech），导演的新帧先不上脸
    director = createEmotionDirector({ onFrame: (next) => { if (!speech.holdsFrames()) applyFrame(next); } });
    const lifeFx = createLifeFx();
    let flashTimer = 0;
    // 互动反应时临时换个表情（不改导演的心情，演完换回来）
    const flashEmotion = (emotion, ms) => {
        // 立绘没画这个情绪就不换，免得退回默认立绘闪一下
        if (backend.canShow && !backend.canShow(emotion)) return;
        clearTimeout(flashTimer);
        backend.apply({ ...frame, emotion, intensity: 0.8 }, { changed: true });
        flashTimer = setTimeout(() => backend.apply(shownFrame(frame), { changed: true, motion: false }), ms);
    };
    life = createPetLife({
        onPhase(phase) {
            document.body.dataset.lifePhase = phase;
            backend.life?.phase(phase);
            lifeFx.phase(phase);
            backend.apply(shownFrame(frame), { changed: true, motion: false });
            if (phase === 'asleep' && !frame.state) backend.setActive('sleep');
        },
        onAction({ name, ms }) {
            backend.life?.act(name, ms);
            if (!life.quiet || USER_REACTIONS.has(name)) lifeFx.act(name, ms);
            if (USER_REACTIONS.has(name)) {
                // 被碰到的反应要流畅：回到高帧率
                lastActivity = Date.now();
                backend.setActive(true);
            }
            if (name === 'poke') {
                backend.tap();
                director.nudge({ emotion: 'happy', intensity: 0.6, source: 'tap' });
            } else if (REACTION_EMOTION[name] && !frame.state) {
                flashEmotion(REACTION_EMOTION[name], ms);
            }
        },
        onGaze(g) { if (g) backend.life?.gaze(g); },
    });
    // 免打扰（桌宠设置里开）：不自己做小动作、不冒小符号
    const syncQuiet = () => life.setQuiet(isQuiet());
    syncQuiet();
    window.addEventListener('deskpet:prefs', syncQuiet);
    bindStream(director);
    api.onPlayTtsAudio?.((payload) => speech.play(payload));
    // 别的窗口开始朗读、在菜单里关了朗读：这条不念了，字全部显示出来
    api.onStopTtsAudio?.(() => speech.stop());
    bindMood(director, assets.agentId);
    proactiveDirector = director;
    api.onProactive?.(speakProactive);
    api.onTopicMissing?.(() => {
        if (bubble.proactive?.kind === 'topic') {
            bubble.reply = '';
            bubble.proactive = null;
        }
        notice('这个话题已经不在了（可能被删掉了）', { ms: 4000 });
    });
    bindComposer();
    // 头那一块（摸头、点头用）：从头顶往下大约一个头高、头宽以内。
    // 量不出头时退回包围盒上方四分之一、中间六成宽。
    const onHead = (x, y) => {
        const h = backend.head?.();
        if (h) return y >= h.y && y <= h.y + h.width * 0.9 && Math.abs(x - h.x) <= h.width / 2;
        const b = backend.bounds();
        if (!b) return false;
        return y >= b.y && y <= b.y + b.height * 0.25 && Math.abs(x - (b.x + b.width / 2)) <= b.width * 0.3;
    };
    // Linux 上主进程不轮询光标（窗口输入区按内容裁过，指针直接进页面）：用页面自己收到的指针判断停在哪
    if (/Linux/.test(navigator.platform)) {
        window.addEventListener('pointermove', (e) => {
            if (e.buttons) return;
            if (uiAt(e.clientX, e.clientY)) reportHit(true);
            else backend.probe(e.clientX, e.clientY);
        });
        document.documentElement.addEventListener('pointerleave', () => reportHit(false));
    }
    api.onCursor(({ x, y, outside }) => {
        if (!outside) {
            if (uiAt(x, y)) reportHit(true);
            else backend.probe(x, y);
        } else reportHit(false); // 出了窗口也算离开：下次直接落在角色身上时胶囊照样冒出来
        life.cursor({ x, y, inside: !outside, onHead: !outside && onHead(x, y) });
        // 光标停着时视线归 petLife 管（游走、犯困低头），动起来再跟光标
        if (!life.gaze) backend.focus(x, y);
    });
    let streak = 0;
    let drag = null;
    bindPointer({
        onTap: (at) => {
            // 正在念的时候点一下：别念了
            if (speech.active() || speech.speaking()) {
                speech.stop();
                return;
            }
            life.tap({ onHead: onHead(at.x, at.y) });
        },
        onTapDown: () => {
            streak = life.tapDown();
            // 连点时第二下打开的输入框没写东西就收回去，别让它跟着一开一关
            if (streak >= LIFE_ANNOYED_AT && composer.open && !$('composerInput').value.trim()) closeComposer();
        },
        // 连点没断时双击不打开；停了一下再双击（比如第一次双击慢了，马上补一次）照常打开
        onDoubleTap: ({ afterPause } = {}) => { if (streak < LIFE_ANNOYED_AT || afterPause) openComposer(); },
        onDrag: (kind, e) => {
            if (kind === 'start') {
                drag = { x: e.screenX, at: performance.now(), vx: 0 };
                dock.dragging = true;
                if (dock.mode === 'pill') setDock('hidden');
                life.hold('drag', true);
                backend.life?.held(true);
                lifeFx.held(true);
            } else if (kind === 'move' && drag) {
                const at = performance.now();
                const dt = Math.max(1, at - drag.at);
                // 速度做个平滑，免得一顿一顿地甩
                drag.vx = drag.vx * 0.7 + (((e.screenX - drag.x) / dt) * 1000) * 0.3;
                drag.x = e.screenX;
                drag.at = at;
                backend.life?.dragVelocity(drag.vx);
            } else if (kind === 'end' && drag) {
                drag = null;
                dock.dragging = false;
                backend.life?.held(false);
                lifeFx.held(false);
                life.hold('drag', false);
                life.dragEnd();
            }
        },
    });
    // 窗口隐藏时停掉渲染和呼吸动画，显示回来再继续。
    let paused = false;
    api.onVisibility?.((visible) => {
        paused = !visible;
        // 藏起来就不出声了，录着的音也停掉（不然麦克风开着、整窗挡着点击）
        if (paused) {
            speech.stop();
            if (dock.mode === 'rec' || (composer.open && !$('composerInput').value.trim())) closeComposer();
        }
        // 光标停在气泡上时被藏起来收不到 mouseleave：别让旧回复从此一直挂着
        if (bubble.hovered) {
            bubble.hovered = false;
            if (!paused && bubble.reply && !bubble.replyId) scheduleReplyHide(REPLY_HOLD_AFTER_HOVER_MS);
        }
        document.body.classList.toggle('is-paused', paused);
        backend.setPaused(paused);
        lifeFx.setPaused(paused);
        life.hold('hidden', paused);
        if (!paused) lastActivity = Date.now();
    });
    // 定期看一眼角色占在哪里：气泡和输入框贴在头顶上方（小头像、矮立绘不会离得老远）；
    // Linux 用输入区代替整窗穿透（见主进程注释），把角色和界面的包围盒报上去。
    let headY = null; // 第一次量到头就摆上去，之后差得多才挪
    let headX = null;
    let headWidth = null;
    // 气泡、角标、小符号都跟着头走：全身像的头在窗口上部，Q 版的大头矮矮的在中间，头歪在一边时气泡也挪过去
    const followHead = () => {
        const h = backend.head?.();
        const b = h ? null : backend.bounds();
        const head = h || (b && { x: b.x + b.width / 2, y: b.y, width: b.width * 0.5 });
        if (!head) return;
        const root = document.documentElement.style;
        // 动作会让头顶上下晃，差得不多就不挪，免得气泡跟着抖
        const y = Math.round(Math.max(TOP_RESERVE, Math.min(window.innerHeight - 40, head.y)));
        if (headY === null || Math.abs(y - headY) > 16) {
            headY = y;
            root.setProperty('--pet-head', `${y}px`);
        }
        const x = Math.round(Math.max(0, Math.min(window.innerWidth, head.x)));
        const w = Math.round(Math.max(24, Math.min(window.innerWidth, head.width)));
        if (headX === null || Math.abs(x - headX) > 8 || Math.abs(w - headWidth) > 8) {
            headX = x;
            headWidth = w;
            root.setProperty('--pet-head-x', `${x}px`);
            root.setProperty('--pet-head-w', `${w}px`);
        }
        aimBubble(headX);
    };
    setInterval(() => {
        if (paused) return;
        followHead();
        const b = backend.bounds();
        const ui = uiBounds();
        const rect = b && ui ? union(b, ui) : (b || ui);
        if (rect) api.setContentBounds({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height });
        life.setMood(director.baseline);
        life.tick();
        if (Date.now() - lastActivity > IDLE_AFTER_MS && !frame.state) backend.setActive(life.phase === 'asleep' ? 'sleep' : 'idle');
    }, 250);

    applyFrame(director.frame);
    document.body.dataset.lifePhase = life.phase;
    backend.life?.phase(life.phase);
    window.__deskPetReady = { backend: backend.kind, info: backend.info || null };
    // 调试和录屏：__deskPetLife.force('asleep') 直接睡着，__deskPetLife.perform('yawn') 演一个动作
    window.__deskPetLife = life;
    window.__deskPetBounds = () => backend.bounds();
    window.__deskPetHead = () => backend.head?.() || null;
    // 量出形象的长宽比后告诉主进程，窗口按比例改（全身像高、Q 版矮），脚底不动
    Promise.resolve(backend.figureReady).then((aspect) => {
        window.__deskPetFigure = { outfit: assets.outfit?.id || null, aspect };
        if (aspect && assets.outfit) api.reportFigure?.({ outfit: assets.outfit.id, aspect });
        followHead();
    }).catch(() => {});
    console.log('[DeskPet] ready', JSON.stringify(window.__deskPetReady));
    api.pageReady?.();
}

// 设置页卡片的快照：摆好默认表情，等形象量完、物理和待机动作稳下来，把角色的包围盒报给主进程截图
async function renderPreview(assets) {
    document.body.classList.add('is-preview');
    backend.apply({ state: null, emotion: 'neutral', intensity: 0, source: 'idle' }, { changed: true, motion: false });
    const aspect = await Promise.race([
        Promise.resolve(backend.figureReady).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const bounds = backend.bounds();
    window.__deskPetPreview = { outfit: assets.outfit?.id || null, bounds, aspect };
    api.previewReady?.({ bounds, aspect });
}

start().catch((error) => {
    console.error('[DeskPet] 启动失败', error);
    // 告诉主进程别再等这个页面了：等着交给桌宠的话按失败退回去
    api.pageFailed?.(String(error?.message || error));
    notice(`桌宠启动失败：${error.message}`, { error: true, ms: 60000 });
});
