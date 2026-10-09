// 桌宠出声：回复按句交给 VCPChat 自带的 TTS（主进程 SovitsTTS），音频回到桌宠窗口自己播放，
// 从播放的声音里取音量包络驱动嘴型；气泡文字和表情跟着正在念的那一句走。
//
//   createVoicePlayer  播放 play-tts-audio 送来的音频块，接一个 AnalyserNode 量音量
//   createLipSync      音量 → 张嘴程度（噪声门 + 起音快、收音慢）
//   createSpeech       一条回复的朗读：切句、送 TTS、跟踪念到哪一句、超时放弃
import { createSpeechChunker } from './speechText.js';

// 口型参数：小于噪声门的音量当作闭嘴；张嘴 40ms 跟上，合嘴 90ms 放下：
// 嘴不会每个波形都抖，字与字之间的短停顿又来得及合上。
const NOISE_GATE = 0.035;
const ATTACK_S = 0.04;
const RELEASE_S = 0.09;
// 音量按分贝映射到 0..1：-50dB 以下算安静，-14dB 以上算张到最大。
const DB_FLOOR = -50;
const DB_CEIL = -14;
const TICK_MS = 33;
// 送出去的句子迟迟没有声音（TTS 服务没开、合成失败）就不等了，直接把字显示完。
const FIRST_AUDIO_TIMEOUT_MS = 20000;
const GAP_TIMEOUT_MS = 15000;
// 第一句的声音这么久还没来（TTS 慢或者没开）：先把字全显示出来，别让气泡一直只有省略号；声音来了照常念
const REVEAL_WAIT_MS = 4000;
// 句与句之间、流式音频块之间的短暂空档不算念完。
const DRAIN_GRACE_MS = 700;

/**
 * 助手设了「只念匹配的文字」正则时，这一句有没有能念出来的字（和主进程 SovitsTTS 切分的规则一致：
 * 只有主正则时只念匹配的部分；有副正则时副正则匹配的部分总会念，其余部分再按主正则筛）。
 * 一个字都念不出来的句子不送 TTS：TTS 会悄悄丢掉它，气泡就会一直等这句的声音。
 */
export function speaksAnything(text, { ttsRegex = '', ttsRegexSecondary = '' } = {}) {
    if (!text || !text.trim()) return false;
    try {
        if (ttsRegexSecondary && new RegExp(ttsRegexSecondary).test(text)) return true;
        if (!ttsRegex) return true;
        return (text.match(new RegExp(ttsRegex, 'g')) || []).some((m) => m.trim());
    } catch {
        return true; // 正则写坏了：交给 TTS 自己处理
    }
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** RMS（0..1 的振幅）→ 0..1 的响度。 */
export function rmsToLevel(rms) {
    if (!(rms > 0)) return 0;
    const db = 20 * Math.log10(rms);
    return clamp01((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR));
}

export function createLipSync() {
    let smoothed = 0;
    return {
        /** level: 0..1 的响度；dt: 秒。返回张嘴程度 0..1。 */
        update(level, dt) {
            const gated = level <= NOISE_GATE ? 0 : (level - NOISE_GATE) / (1 - NOISE_GATE);
            const step = Math.min(0.25, Math.max(0, dt));
            const k = 1 - Math.exp(-step / (gated >= smoothed ? ATTACK_S : RELEASE_S));
            smoothed += (gated - smoothed) * k;
            return smoothed < 0.002 ? 0 : Math.min(1, smoothed * 1.1);
        },
        reset() { smoothed = 0; },
    };
}

function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/**
 * 播放主进程送来的 TTS 音频。和主窗口的播放器一样按 sessionId 丢掉过时的块，
 * 不同的是所有块都按音频时钟首尾相接排好，并记下每块属于哪一句（msgId），方便知道正在念哪句。
 */
export function createVoicePlayer({ onError } = {}) {
    let ctx = null;
    let analyser = null;
    let samples = null;
    let session = -1;
    let generation = 0;
    let nextStart = 0;
    let decodeTail = Promise.resolve();
    const segments = []; // { key, start, end, source }

    function ensureContext() {
        if (ctx) return ctx;
        ctx = new AudioContext();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0;
        analyser.connect(ctx.destination);
        samples = new Float32Array(analyser.fftSize);
        return ctx;
    }

    function stop() {
        generation += 1;
        decodeTail = Promise.resolve();
        nextStart = 0;
        for (const seg of segments.splice(0)) {
            seg.source.onended = null;
            try { seg.source.stop(); } catch { /* 还没开始或已经停了 */ }
        }
    }

    function play({ audioData, msgId, sessionId, playbackRate = 1 } = {}) {
        if (!audioData) return;
        if (Number.isFinite(sessionId)) {
            if (sessionId < session) return;
            if (sessionId > session) {
                stop();
                session = sessionId;
            }
        }
        const owner = generation;
        decodeTail = decodeTail.then(async () => {
            if (owner !== generation) return;
            const audio = ensureContext();
            if (audio.state === 'suspended') await audio.resume().catch(() => {});
            const buffer = await audio.decodeAudioData(decodeBase64(audioData));
            if (owner !== generation) return;
            const rate = Math.min(2, Math.max(0.5, Number(playbackRate) || 1));
            const source = audio.createBufferSource();
            source.buffer = buffer;
            source.playbackRate.value = rate;
            source.connect(analyser);
            const start = Math.max(audio.currentTime + 0.03, nextStart);
            const end = start + buffer.duration / rate;
            nextStart = end;
            const seg = { key: String(msgId || ''), start, end, source };
            segments.push(seg);
            source.onended = () => {
                const i = segments.indexOf(seg);
                if (i >= 0) segments.splice(i, 1);
            };
            source.start(start);
        }).catch((error) => {
            if (owner === generation) onError?.(error);
        });
    }

    return {
        play,
        stop,
        /** 现在正在出声的那一块的 msgId；没在出声返回 null。 */
        currentKey() {
            if (!ctx) return null;
            const t = ctx.currentTime;
            return segments.find((s) => s.start <= t && t < s.end)?.key ?? null;
        },
        /** 还有排着或正在放的声音。 */
        busy() {
            return Boolean(ctx) && segments.some((s) => s.end > ctx.currentTime);
        },
        /** 当前音量（0..1 的 RMS）。 */
        rms() {
            if (!analyser) return 0;
            analyser.getFloatTimeDomainData(samples);
            let sum = 0;
            for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
            return Math.sqrt(sum / samples.length);
        },
        dispose() {
            stop();
            ctx?.close?.().catch(() => {});
            ctx = null;
            analyser = null;
        },
    };
}

/**
 * 一条回复的朗读。调用顺序：begin(messageId) → update(raw, frame)…… → finish(raw, frame)。
 *   raw   到目前为止的回复原文（只追加），气泡就是它整理出来的
 *   frame 这句的表情帧，或者 (sentence) => 帧；切出一句时记下，念到这句时再换上
 *
 * 回调：
 *   onChange()      气泡该重画了（显示到哪儿变了、开始或结束朗读）
 *   onFrame(frame)  念到新的一句，换上它的表情
 *   onRelease()     不再按句子控制表情了（念完、放弃、被打断），换回导演的当前帧
 *   onLevel(open)   每帧的张嘴程度 0..1，正在朗读时才会调
 */
export function createSpeech({ api, onChange, onFrame, onRelease, onLevel, onError } = {}) {
    const player = createVoicePlayer({ onError });
    const lipSync = createLipSync();
    let reply = null; // { messageId, mode: 'pending' | 'voice' | 'off', sentences, sent, heard, ended, waitingSince, lastHeard }
    let timer = 0;
    let lastTick = 0;
    let mouth = 0;
    let holding = false;

    function keyFor(messageId, index) {
        return `${messageId}#deskpet-${index}`;
    }

    function indexFromKey(key) {
        if (!reply || !key) return -1;
        const prefix = `${reply.messageId}#deskpet-`;
        return key.startsWith(prefix) ? Number(key.slice(prefix.length)) : -1;
    }

    function ensureTicking() {
        if (timer) return;
        lastTick = performance.now();
        timer = setInterval(tick, TICK_MS);
    }

    function stopTicking() {
        clearInterval(timer);
        timer = 0;
        mouth = 0;
        lipSync.reset();
        onLevel?.(0);
    }

    function release() {
        if (!holding) return;
        holding = false;
        onRelease?.();
    }

    // 不再朗读这条：字全部显示，表情交回导演
    function settle({ stopAudio = false, notifyMain = true } = {}) {
        if (!reply) return;
        const wasVoice = reply.mode !== 'off';
        if (stopAudio) player.stop();
        if (wasVoice && notifyMain) api.voiceEnd?.({ messageId: reply.messageId, stop: stopAudio });
        reply.mode = 'off';
        if (!player.busy()) stopTicking();
        release();
        onChange?.();
    }

    function sendSentence(sentence) {
        if (!sentence.text || !speaksAnything(sentence.text, reply.filter)) return;
        sentence.sent = true;
        reply.lastSent = sentence.index;
        if (reply.waitingSince == null) reply.waitingSince = Date.now();
        api.voiceSay({ messageId: reply.messageId, key: keyFor(reply.messageId, sentence.index), text: sentence.text, first: !reply.anySent });
        reply.anySent = true;
    }

    function addSentences(list, frame) {
        for (const sentence of list) {
            sentence.frame = typeof frame === 'function' ? frame(sentence) : frame;
            reply.sentences.push(sentence);
            if (reply.mode === 'voice') sendSentence(sentence);
        }
        if (reply.mode === 'voice' && reply.anySent) {
            holding = true;
            ensureTicking();
        }
    }

    function tick() {
        const now = performance.now();
        const dt = (now - lastTick) / 1000;
        lastTick = now;
        const busy = player.busy();
        mouth = busy ? lipSync.update(rmsToLevel(player.rms()), dt) : lipSync.update(0, dt);
        onLevel?.(mouth);
        if (!reply || reply.mode !== 'voice') {
            if (!busy && mouth === 0) stopTicking();
            return;
        }
        const playing = indexFromKey(player.currentKey());
        if (playing >= 0) {
            reply.waitingSince = null;
            reply.lastAudioAt = Date.now();
            if (playing !== reply.heard) {
                reply.heard = playing;
                holding = true;
                const sentence = reply.sentences.find((s) => s.index === playing);
                if (sentence?.frame) onFrame?.(sentence.frame);
                onChange?.();
            }
        } else if (!busy && reply.waitingSince == null && reply.lastSent > reply.heard) {
            // 上一句念完了，下一句的声音还没来
            reply.waitingSince = Date.now();
        }
        if (reply.heard < 0 && !reply.revealAll && reply.waitingSince != null && Date.now() - reply.waitingSince > REVEAL_WAIT_MS) {
            reply.revealAll = true;
            onChange?.();
        }
        const caughtUp = reply.heard >= reply.lastSent;
        const quiet = !busy && Date.now() - (reply.lastAudioAt || 0) > DRAIN_GRACE_MS;
        if (caughtUp && quiet) {
            if (reply.ended) {
                // 整条念完
                settle();
                return;
            }
            // 念到了流的前面：表情交回导演，等新的句子
            release();
        }
        const limit = reply.heard < 0 ? FIRST_AUDIO_TIMEOUT_MS : GAP_TIMEOUT_MS;
        if (reply.waitingSince != null && !busy && Date.now() - reply.waitingSince > limit) {
            console.warn('[DeskPet] TTS 迟迟没有声音，这条不念了');
            settle({ stopAudio: true });
        }
    }

    return {
        /**
         * 新回复开始。主进程说这个助手能出声（设了音色、没静音）才进入朗读模式；
         * silent 时（免打扰）这条不念，但仍然打断上一条。
         */
        begin(messageId, { silent = false } = {}) {
            if (reply && reply.messageId === messageId) return;
            if (reply && reply.mode !== 'off') settle({ stopAudio: true });
            const chunker = createSpeechChunker();
            const current = {
                messageId, mode: 'pending', chunker, sentences: [], heard: -1, lastSent: -1,
                anySent: false, ended: false, waitingSince: null, lastAudioAt: 0,
            };
            reply = current;
            if (silent) {
                current.mode = 'off';
                return;
            }
            Promise.resolve(api.voiceBegin?.(messageId)).then((result) => {
                if (reply !== current || current.mode !== 'pending') return;
                current.mode = result?.speaking ? 'voice' : 'off';
                current.filter = { ttsRegex: result?.ttsRegex || '', ttsRegexSecondary: result?.ttsRegexSecondary || '' };
                if (current.mode === 'voice') {
                    player.stop();
                    for (const s of current.sentences) sendSentence(s);
                    if (current.anySent) { holding = true; ensureTicking(); }
                    // 整条已经到齐但一句能念的都没有
                    if (current.ended && !current.anySent) settle();
                }
                onChange?.();
            }).catch(() => {
                if (reply === current) { current.mode = 'off'; onChange?.(); }
            });
        },
        update(raw, frame) {
            if (!reply || reply.mode === 'off') return;
            addSentences(reply.chunker.push(raw), frame);
        },
        finish(raw, frame) {
            if (!reply) return;
            if (reply.mode !== 'off') addSentences(reply.chunker.finish(raw), frame);
            reply.ended = true;
            if (reply.mode === 'voice' && !reply.anySent) settle();
            else if (reply.mode === 'voice') ensureTicking();
        },
        /** 回复出错：已经在念的念完，后面不再送。 */
        fail() {
            if (!reply) return;
            reply.ended = true;
            if (reply.mode === 'voice' && !reply.anySent) settle();
        },
        /** 用户让 TA 别念了（点了一下角色、关了朗读、别的窗口开始朗读）。 */
        stop({ notifyMain = true } = {}) {
            if (reply && reply.mode !== 'off') settle({ stopAudio: true, notifyMain });
            else player.stop();
        },
        /** 主进程转来的音频块。 */
        play: (payload) => {
            player.play(payload);
            ensureTicking();
        },
        /** 正在朗读这条（还有句子没念完）。 */
        active() {
            return Boolean(reply) && reply.mode !== 'off';
        },
        /** 有声音在放。 */
        speaking() { return player.busy(); },
        /** 表情是否由念到的句子控制（期间导演的新帧先不上脸）。 */
        holdsFrames() { return holding; },
        /**
         * 气泡显示到原文的哪个位置；null 表示全部显示。
         * 朗读时只显示到正在念的这句末尾，还没开口时是 0。
         */
        revealEnd() {
            if (!reply || reply.mode === 'off' || reply.messageId == null) return null;
            if (reply.mode === 'pending') return 0;
            if (reply.revealAll) return null;
            if (!reply.anySent) return reply.ended ? null : 0;
            if (reply.heard < 0) return 0;
            const sentence = reply.sentences.find((s) => s.index === reply.heard);
            // 念到的句子前面那些只有代码、图片的句子跟着一起显示
            return sentence ? sentence.end : null;
        },
        messageId() { return reply?.messageId ?? null; },
        /** 当前的张嘴程度；没在朗读模式返回 null（调用方用自己的假口型）。 */
        mouth() {
            if (reply && reply.mode === 'voice' && reply.anySent) return mouth;
            return player.busy() || mouth > 0 ? mouth : null;
        },
        dispose() {
            stopTicking();
            player.dispose();
        },
    };
}
