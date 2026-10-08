/* Long-lived mood of one assistant: a point in VAD space that replies and the user's messages
 * push around a little, and that eases back to neutral over hours (faster across a new day).
 * The emotion director shows a reply's emotion on top of it and settles back to it afterwards.
 * Pure data and functions with no DOM, Electron or file access: the main process owns the
 * stored copy (Agents/<id>/mood.json), the side pane portrait and the desk pet only read it.
 * The user-message part (empathy map and comfort/still-upset phrases) follows TsukuMate's
 * chat-emotion layer (Roxy's own project); the VAD easing follows soullink-emotion-sdk. */
import { classifyReplyText } from './emotionRules.js';
import { EMOTIONS, EMOTION_VAD, normalizeEmotion, clampIntensity } from './emotionVocabulary.js';
import { createEmotionTagScanner } from './emotionTags.js';

export const MOOD_VERSION = 1;

export const MOOD_DEFAULTS = Object.freeze({
    // 偏离平静的部分每过这么久减半
    halfLifeMs: 4 * 60 * 60 * 1000,
    // 跨过一天（本地日期变了）时再额外只留下这一部分：第二天醒来基本回到平静
    newDayKeep: 0.35,
    // 低于这个强度就当作平静，立绘不跟着换
    showThreshold: 0.22,
});

// 能成为心情的情绪：惊讶、好奇是一瞬间的反应，不会持续半天
const MOOD_EMOTIONS = new Set(['calm', 'happy', 'excited', 'shy', 'affectionate', 'concerned', 'sad', 'tired', 'angry']);

// 每次事件把心情往目标拉多少（再乘事件自身的强度）
const PULL = Object.freeze({ tag: 0.35, rule: 0.2, user: 0.3 });
const ORIGIN = Object.freeze({ valence: 0, arousal: 0, dominance: 0 });
const AXES = ['valence', 'arousal', 'dominance'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const norm = vad => Math.hypot(vad.valence, vad.arousal, vad.dominance);
const mix = (from, to, amount) => Object.fromEntries(AXES.map(axis => [axis, from[axis] + (to[axis] - from[axis]) * amount]));
const scale = (vad, factor) => Object.fromEntries(AXES.map(axis => [axis, vad[axis] * factor]));

function localDay(time) {
    const date = new Date(time);
    return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** 一份全新的平静心情 */
export function createMood(at = Date.now()) {
    return { version: MOOD_VERSION, vad: { ...ORIGIN }, updatedAt: at, last: null };
}

/** 从磁盘读来的任意内容整理成合法心情；读不懂就当平静 */
export function normalizeMood(value, at = Date.now()) {
    if (!value || typeof value !== 'object' || !value.vad || typeof value.vad !== 'object') return createMood(at);
    const vad = Object.fromEntries(AXES.map(axis => [axis, clamp(finite(value.vad[axis]), -1, 1)]));
    const updatedAt = Number.isFinite(value.updatedAt) && value.updatedAt <= at ? value.updatedAt : at;
    const last = value.last && normalizeEmotion(value.last.emotion)
        ? { emotion: normalizeEmotion(value.last.emotion), source: String(value.last.source || ''), at: finite(value.last.at, updatedAt) }
        : null;
    return { version: MOOD_VERSION, vad, updatedAt, last };
}

/** 把心情推进到 at：按半衰期回落，跨天再额外回落一截 */
export function decayMood(mood, at = Date.now(), { halfLifeMs = MOOD_DEFAULTS.halfLifeMs, newDayKeep = MOOD_DEFAULTS.newDayKeep } = {}) {
    const elapsed = at - mood.updatedAt;
    if (!(elapsed > 0)) return mood;
    let keep = halfLifeMs > 0 ? Math.pow(0.5, elapsed / halfLifeMs) : 0;
    if (localDay(at) !== localDay(mood.updatedAt)) keep *= newDayKeep;
    const vad = norm(mood.vad) * keep < 0.01 ? { ...ORIGIN } : scale(mood.vad, keep);
    return { ...mood, vad, updatedAt: at };
}

/**
 * 记一次情绪事件。event: { emotion, intensity, source: 'tag' | 'rule' | 'user', at, settle? }
 * settle 是用户说「好多了」这类话：按比例拉回平静，不再朝某个情绪推。
 */
export function applyMoodEvent(mood, event = {}, options = {}) {
    const at = Number.isFinite(event.at) ? event.at : Date.now();
    const current = decayMood(mood, at, options);
    if (event.settle > 0) {
        return { ...current, vad: scale(current.vad, 1 - clamp(event.settle, 0, 1)), last: { emotion: 'calm', source: event.source || 'user', at } };
    }
    const emotion = normalizeEmotion(event.emotion);
    // 惊讶、好奇是一瞬间的反应：立绘照样换表情，但不改心情
    if (!emotion || !MOOD_EMOTIONS.has(emotion)) return current;
    const pull = (PULL[event.source] ?? PULL.rule) * clampIntensity(event.intensity, 0.7);
    if (!(pull > 0)) return current;
    return { ...current, vad: mix(current.vad, EMOTION_VAD[emotion], pull), last: { emotion, source: event.source || 'rule', at } };
}

/**
 * 心情在立绘上显示成哪个情绪：方向最接近的情绪键，强度按离平静多远算；太弱就是 neutral。
 * 返回 { emotion, intensity }，可以直接交给情绪导演的 setBaseline。
 */
export function moodEmotion(mood, { showThreshold = MOOD_DEFAULTS.showThreshold } = {}) {
    const length = norm(mood?.vad || ORIGIN);
    if (length < 0.05) return { emotion: 'neutral', intensity: 0 };
    let best = null;
    for (const emotion of EMOTIONS) {
        if (!MOOD_EMOTIONS.has(emotion)) continue;
        const anchor = EMOTION_VAD[emotion];
        const cosine = AXES.reduce((sum, axis) => sum + mood.vad[axis] * anchor[axis], 0) / (length * norm(anchor));
        if (!best || cosine > best.cosine) best = { emotion, cosine, anchor };
    }
    // 强度只算朝这个情绪方向的那一段：开心过后又听到坏消息，剩下的多是「还有点激动」，算不上兴奋
    const intensity = clamp((length * best.cosine) / norm(best.anchor), 0, 1);
    if (intensity < showThreshold || best.cosine < 0.7) return { emotion: 'neutral', intensity: 0 };
    return { emotion: best.emotion, intensity: Math.round(intensity * 100) / 100 };
}

/** 给渲染端的快照：时间推进到 at 后的显示情绪，加上原始 VAD 和最近一次是什么推动的 */
export function moodSnapshot(mood, at = Date.now(), options = {}) {
    const current = decayMood(mood, at, options);
    const shown = moodEmotion(current, options);
    return {
        emotion: shown.emotion,
        intensity: shown.intensity,
        vad: { ...current.vad },
        updatedAt: current.updatedAt,
        last: current.last ? { ...current.last } : null,
    };
}

// 用户的情绪传到助手身上是什么样子：用户难过、生气、累，助手是担心；开心、兴奋就跟着开心
const EMPATHY = Object.freeze({
    happy: 'happy',
    excited: 'excited',
    affectionate: 'shy',
    shy: 'affectionate',
    curious: 'curious',
    surprised: 'curious',
    calm: 'calm',
    concerned: 'concerned',
    sad: 'concerned',
    angry: 'concerned',
    tired: 'concerned',
});

// 「还没好」「还是难过」：保持现状，不再往哪边推
const STILL_UPSET = /(?:还|仍然|依然|并|並)?(?:没|沒有|没有|未)(?:有)?(?:好|恢复|恢復|释怀|釋懷|缓解|緩解)|并没有好|並沒有好|not\s+(?:okay|better|fine)|still\s+(?:sad|upset|angry|tired)|まだ(?:だめ|辛い|悲しい|怒って)/i;
// 「没事了」「好多了」：心情回到平静
const RESOLVED = /(?:我)?(?:已经|已經)?(?:没事了|沒事了|好多了|恢复了|恢復了|释怀了|釋懷了)|谢谢你安慰我|謝謝你安慰我|被你安慰好了|心情恢复了|心情恢復了|i(?:'m| am)\s+(?:okay|fine|better)\s+now|i\s+feel\s+better\s+now|もう大丈夫|元気になった/i;
// 「好一点了」：回落一半
const EASED = /(?:稍微|有点|有點|一点|一點)(?:好|舒服|轻松|輕鬆)(?:一点|一點)?|好一点了|好一點了|缓解了一些|緩解了一些|a\s+(?:little|bit)\s+better|少し(?:楽|良く)なった/i;

/** 用户说的一句话对助手心情的影响；没有明显情绪时返回 null */
export function userMessageMoodEvent(input, at = Date.now()) {
    const text = String(input ?? '').trim().slice(-1600);
    if (!text) return null;
    if (STILL_UPSET.test(text)) return null;
    if (RESOLVED.test(text)) return { settle: 0.6, source: 'user', at };
    if (EASED.test(text)) return { settle: 0.35, source: 'user', at };
    const result = classifyReplyText(text);
    const emotion = result && EMPATHY[result.emotion];
    return emotion ? { emotion, intensity: result.intensity, source: 'user', at } : null;
}

/**
 * 一整条助手回复对心情的影响：有标签取最后一个标签（回复的落点），没有就用规则判断正文。
 * 思考、工具调用和代码块里的字不算。没有明显情绪时返回 null。
 */
export function replyMoodEvent(input, at = Date.now()) {
    const scanner = createEmotionTagScanner();
    let region = null;
    let lastTag = null;
    let visible = '';
    for (const event of [...scanner.push(String(input ?? '')), ...scanner.finish()]) {
        if (event.type === 'tag') lastTag = event;
        else if (event.type === 'enter') region = event.region;
        else if (event.type === 'exit') region = null;
        else if (event.type === 'text' && !region) visible = (visible + event.text).slice(-2000);
    }
    if (lastTag) return { emotion: lastTag.emotion, intensity: lastTag.intensity, source: 'tag', at };
    const result = classifyReplyText(visible);
    return result ? { emotion: result.emotion, intensity: result.intensity, source: 'rule', at } : null;
}
