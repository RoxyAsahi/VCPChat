'use strict';

// 桌宠情绪导演：吃主进程里的流事件，吐出与渲染后端无关的 EmotionFrame。
//   state   生命周期：idle / thinking / speaking / tool / error（thinking 与 tool 显示为专注）
//   emotion 情绪：回复里的 <!--emo:..--> 标签优先；没有标签时用规则分类兜底
// 一个导演只服务一个 agent，只看该 agent 的流。

const { EmoTagStreamParser, EMOTIONS } = require('./emoTags');
const classifier = require('./chatEmotionClassifier');

const MIN_DWELL_MS = 1500;      // 每个表情最短停留；期间来的标签排队依次播放
const MAX_QUEUED = 3;           // 排队过长时丢掉最早的，表情不至于落后正文太多
const REACTION_HOLD_MS = 6000;  // 回复结束后保持最后一个表情
const ERROR_HOLD_MS = 3000;
const FALLBACK_AFTER_CHARS = 80; // 这么多字仍无标签，先用规则兜底一次
const FALLBACK_MIN_INTENSITY = 0.35;

// 状态覆盖情绪（与 TsukuMate 的 stateEmotion 一致）。
const STATE_EMOTION = Object.freeze({ thinking: 'focused', tool: 'focused', error: 'sad' });

function extractDeltaText(chunk) {
    if (!chunk || typeof chunk !== 'object') return { content: '', reasoning: '' };
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    const delta = choice?.delta || choice?.message || {};
    const content = typeof delta.content === 'string' ? delta.content : '';
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
        : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
    return { content, reasoning };
}

function classifyFallback(text) {
    const blend = classifier.inferEmotionBlendFromText(text);
    if (!blend || !EMOTIONS.includes(blend.primary) || blend.intensity < FALLBACK_MIN_INTENSITY) {
        return { emotion: 'calm', intensity: 0.5 };
    }
    return { emotion: blend.primary, intensity: blend.intensity };
}

function createPetDirector({ agentId, emit, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    let seq = 0;
    let current = { state: 'idle', emotion: 'calm', intensity: 0.5, variant: null, source: 'idle' };
    let lastEmotionAt = -Infinity;
    let queue = [];
    let dwellTimer = null;
    let holdTimer = null;
    let stream = null; // { messageId, parser, text, tagged, fallbackDone, started }

    function send(patch, reason) {
        current = { ...current, ...patch };
        seq += 1;
        emit({ seq, agentId, messageId: stream?.messageId || null, reason, ...current });
    }

    function clearTimers() {
        if (dwellTimer) { clearTimer(dwellTimer); dwellTimer = null; }
        if (holdTimer) { clearTimer(holdTimer); holdTimer = null; }
        queue = [];
    }

    function applyEmotion(next) {
        const t = now();
        const same = next.emotion === current.emotion;
        if (same && Math.abs(next.intensity - current.intensity) < 0.15) return;
        const wait = MIN_DWELL_MS - (t - lastEmotionAt);
        if ((wait > 0 || dwellTimer) && !same) {
            queue.push(next);
            if (queue.length > MAX_QUEUED) queue.shift();
            if (!dwellTimer) scheduleNext(Math.max(wait, 0));
            return;
        }
        lastEmotionAt = t;
        // 同一情绪只加强，不重播。
        const intensity = same ? Math.min(1, Math.max(current.intensity, next.intensity) + 0.1) : next.intensity;
        send({ emotion: next.emotion, variant: next.variant || null, intensity, source: next.source }, 'emotion');
    }

    function scheduleNext(delay) {
        dwellTimer = setTimer(() => {
            dwellTimer = null;
            const queued = queue.shift();
            if (!queued) return;
            applyEmotion(queued);
            if (queue.length && !dwellTimer) scheduleNext(MIN_DWELL_MS);
        }, delay);
    }

    function begin(messageId) {
        clearTimers();
        stream = {
            messageId,
            parser: new EmoTagStreamParser({ normalizeEmotion: classifier.normalizeEmotionToken }),
            text: '',
            tagged: false,
            fallbackDone: false,
            started: false,
        };
        send({ state: 'thinking' }, 'begin');
    }

    function consume(result) {
        if (result.toolOpened) send({ state: 'tool' }, 'tool');
        if (result.text && current.state !== 'tool') {
            stream.text += result.text;
            if (current.state !== 'speaking' && result.text.trim()) send({ state: 'speaking' }, 'speaking');
        }
        for (const tag of result.tags) {
            stream.tagged = true;
            applyEmotion({ ...tag, source: 'tag' });
        }
        if (result.toolClosed) send({ state: 'speaking' }, 'tool-done');
        if (!stream.tagged && !stream.fallbackDone && stream.text.length >= FALLBACK_AFTER_CHARS) {
            stream.fallbackDone = true;
            applyEmotion({ ...classifyFallback(stream.text), source: 'rule' });
        }
    }

    function data(messageId, chunk) {
        if (!stream || stream.messageId !== messageId) begin(messageId);
        const { content, reasoning } = extractDeltaText(chunk);
        if (reasoning && !content && current.state !== 'thinking' && !stream.started) send({ state: 'thinking' }, 'reasoning');
        if (!content) return;
        stream.started = true;
        consume(stream.parser.push(content));
    }

    function end(messageId) {
        if (!stream || stream.messageId !== messageId) return;
        consume(stream.parser.flush());
        if (!stream.tagged && stream.text.trim()) {
            applyEmotion({ ...classifyFallback(stream.text), source: 'rule' });
        }
        send({ state: 'idle' }, 'end');
        stream = null;
        holdTimer = setTimer(() => {
            holdTimer = null;
            if (stream) return;
            send({ emotion: 'calm', variant: null, intensity: 0.5, source: 'decay' }, 'decay');
        }, REACTION_HOLD_MS);
    }

    function error(messageId) {
        if (stream && stream.messageId !== messageId) return;
        clearTimers();
        send({ state: 'error' }, 'error');
        stream = null;
        holdTimer = setTimer(() => {
            holdTimer = null;
            if (stream) return;
            send({ state: 'idle', emotion: 'calm', variant: null, intensity: 0.5, source: 'decay' }, 'decay');
        }, ERROR_HOLD_MS);
    }

    return {
        begin,
        data,
        end,
        error,
        snapshot: () => ({ seq, agentId, ...current }),
        dispose: clearTimers,
    };
}

module.exports = {
    STATE_EMOTION,
    createPetDirector,
    extractDeltaText,
    classifyFallback,
};
