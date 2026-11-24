(function (global) {
    'use strict';

    /*
     * 群唱：歌词变成一个群聊。每句是群里某个人发的一条消息，按唱的进度一个字一个字打出来；
     * 开唱前那人「正在输入…」；间奏是一条语音消息，波形跟着音乐跳；副歌（整句出现两次以上的）
     * 大家一起唱，消息下面叠着几个人的回声；唱完的消息偶尔有人点个赞。
     * 全部是 DOM，不用画布；每帧只动正在打字的那条和语音波形。
     */

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before groupchat-manager.js');
    const { clamp, createElement } = Utils;
    const { resolveSupplementalText, readableText, buildGlyphTimeline, hashString, splitGraphemes } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const KEEP_ROWS = 16;            // DOM 里最多留几行
    const TYPING_LEAD = 0.9;         // 开唱前多久显示「正在输入」
    const VOICE_GAP = 4.5;           // 两句之间空这么久就发一条语音
    const BARS = 28;                 // 语音波形的格数

    // 群成员：名字和头像颜色（色相）。「我」在右边。
    const MEMBERS = Object.freeze([
        { name: '阿澈', hue: 205 },
        { name: '小满', hue: 340 },
        { name: '栗子', hue: 28 },
        { name: '七七', hue: 150 },
        { name: '老周', hue: 262 }
    ]);
    const ME = Object.freeze({ name: '我', hue: -1, me: true });
    const REACTIONS = Object.freeze(['♥', '＋1', '☆', '哈', '♪']);
    // 长间奏里有人回一个表情
    const STICKERS = Object.freeze(['ヽ(✿ﾟ▽ﾟ)ノ', '♪(´▽｀)', '(๑•̀ㅂ•́)و✧', '(っ˘ω˘ς )', '٩(ˊᗜˋ*)و', '(*´∀`)~♥', '( ˘ ³˘)♪', '(ﾉ´ヮ`)ﾉ*:･ﾟ✧']);
    const STICKER_GAP = 9;           // 间奏长过这么久，语音之后再来一个表情

    const unit = (...parts) => (hashString(parts.join('|')) >>> 0) / 4294967295;
    const normLine = line => String(line?.fullText || '').replace(/[\s，。、,.!?！？…~～'"“”‘’()（）-]/g, '').toLowerCase();
    const compactLength = text => splitGraphemes(String(text || '').replace(/\s/g, '')).length;
    const fmt = (seconds) => {
        const s = Math.max(0, Math.round(seconds));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    /* ───────────────────────── 编排（纯函数，同一首歌每次都一样） ───────────────────────── */

    const buildThread = (lines, title, duration) => {
        const sung = (lines || []).filter(line => readableText(line.fullText));
        const messages = [{ kind: 'system', start: 0, text: title ? `《${title}》 群聊 · ${MEMBERS.length + 1} 人` : `群聊 · ${MEMBERS.length + 1} 人` }];
        const counts = new Map();
        sung.forEach((line) => { const k = normLine(line); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
        let last = null;
        let leftCursor = 0;
        let sinceStamp = 0;
        sung.forEach((line, i) => {
            const prev = sung[i - 1];
            const prevEnd = prev ? Math.max(prev.endTime, prev.vocalEndTime || 0) : 0;
            const gap = line.startTime - prevEnd;
            // 间奏：发一条语音，长度就是这段间奏
            if (gap > VOICE_GAP) {
                const start = prev ? prevEnd + 0.6 : Math.min(1.2, line.startTime * 0.25);
                const end = line.startTime - TYPING_LEAD - 0.2;
                if (end - start > 2) {
                    const who = MEMBERS[Math.floor(unit('voice', i, line.startTime) * MEMBERS.length)];
                    messages.push({ kind: 'voice', start, end, sender: who, side: 'left' });
                    last = null;
                    if (end - start > STICKER_GAP) {
                        const others = MEMBERS.filter(m => m !== who);
                        const from = others[Math.floor(unit('sticker-who', i) * others.length)];
                        messages.push({
                            kind: 'sticker', start: start + (end - start) * 0.55, sender: from, side: 'left',
                            text: STICKERS[Math.floor(unit('sticker', i, line.startTime) * STICKERS.length)]
                        });
                    }
                }
            }
            // 隔一阵插一个时间戳
            sinceStamp += 1;
            if (i > 0 && (gap > VOICE_GAP || sinceStamp >= 9)) {
                messages.push({ kind: 'system', start: line.startTime - TYPING_LEAD - 0.05, text: fmt(line.startTime), stamp: true });
                sinceStamp = 0;
            }
            const chorus = (counts.get(normLine(line)) || 0) >= 2;
            const short = compactLength(line.fullText) <= 8;
            let sender;
            if ((i + 1) % 4 === 0) sender = ME;
            else if (short && last && unit('carry', i, line.startTime) < 0.55) sender = last;
            else if (unit('side', i, line.startTime) < 0.22) sender = ME;
            else {
                // 不连着两句换回同一个人：从下一个开始轮
                const step = 1 + Math.floor(unit('who', i, line.startTime) * 2);
                leftCursor = (leftCursor + step) % MEMBERS.length;
                sender = MEMBERS[leftCursor];
            }
            const others = MEMBERS.filter(m => m !== sender);
            const echoes = chorus
                ? others.slice().sort((a, b) => unit('echo', i, a.name) - unit('echo', i, b.name)).slice(0, 2 + Math.floor(unit('n', i) * 2))
                : [];
            const roll = unit('react', i, line.startTime);
            const reaction = chorus
                ? { mark: '♪', count: echoes.length + 1 }
                : roll < 0.24 ? { mark: REACTIONS[Math.floor(unit('mark', i) * 4)], count: 1 + Math.floor(unit('cnt', i) * 3) } : null;
            messages.push({
                kind: 'line', start: line.startTime, line, sender, side: sender.me ? 'right' : 'left', chorus, echoes, reaction,
                index: i, continued: last === sender
            });
            last = sender;
        });
        const lastLine = sung[sung.length - 1];
        // 没有歌词：整首歌是一条语音，群里就听着
        if (!lastLine && duration > 6) {
            messages.push({ kind: 'voice', start: 1.2, end: duration - 1.5, sender: MEMBERS[0], side: 'left', whole: true });
        }
        if (lastLine) {
            const end = Math.max(lastLine.endTime, lastLine.vocalEndTime || 0) + 1.5;
            if (!(duration > 0) || end < duration) messages.push({ kind: 'system', start: end, text: '— 曲终 · 群聊结束 —' });
        }
        messages.sort((a, b) => a.start - b.start);
        return messages;
    };

    // 最后一条已经出现的消息（start ≤ t）
    const messageIndexAt = (messages, t) => {
        let lo = 0, hi = messages.length - 1, found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (messages[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return found;
    };

    // 开唱前「正在输入」的那一条
    const typingAt = (messages, t) => {
        const i = messageIndexAt(messages, t) + 1;
        for (let k = i; k < messages.length && k < i + 3; k += 1) {
            const m = messages[k];
            if (m.kind === 'line') return m.start - t <= TYPING_LEAD ? m : null;
            if (m.kind === 'voice') return null;
        }
        return null;
    };

    const avatarStyle = (sender) => sender.me
        ? ''
        : `--gc-h:${sender.hue}`;

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('groupchat', '群唱', container, services);
        const head = createElement('header', 'gc-head');
        head.innerHTML = '<i class="gc-back">‹</i><div class="gc-title"><b></b><span></span></div><div class="gc-level"><i></i><i></i><i></i><i></i></div>';
        const headTitle = head.querySelector('b');
        const headSub = head.querySelector('span');
        const levels = Array.from(head.querySelectorAll('.gc-level > i'));
        const viewport = createElement('div', 'gc-viewport');
        const list = createElement('div', 'gc-list');
        viewport.append(list);
        const kicker = createElement('div', 'gc-kicker', '群唱');
        mode.root.append(head, viewport, kicker);
        const cardInset = Utils.watchCardInset(mode.root);
        mode.scope.add(() => cardInset.destroy());

        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let messages = [];
        let threadFor = null;
        let shownUpTo = -1;        // 已经放进 DOM 的最后一条消息
        let rows = [];             // { message, el, text, glyphs, shown, tr }
        let typingRow = null;
        let typingFor = null;
        let paused = false;
        let latest = null;
        let lastDraw = -Infinity;
        let lastOnsets = -1;
        let caption = '';
        let sub = '';
        let lastT = -Infinity;
        let voiceRow = null;
        const stats = { rebuilds: 0, rows: 0 };

        const settings = () => {
            const tuning = mode.config.modes?.groupchat || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                voiceNotes: tuning.voiceNotes !== false,
                echoes: tuning.echoes !== false,
                reactions: tuning.reactions !== false,
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: Boolean(reducedMotion?.matches)
            };
        };
        const applyScale = () => mode.root.style.setProperty('--gc-scale', String(settings().fontScale));
        applyScale();

        const avatar = (sender, cls = 'gc-avatar') => {
            const a = createElement('div', `${cls}${sender.me ? ' is-me' : ''}`, sender.me ? '我' : splitGraphemes(sender.name)[1] || sender.name);
            if (!sender.me) a.style.cssText = avatarStyle(sender);
            return a;
        };

        // 一条消息的 DOM；past 为真时整句直接显示完（拖进度、刚切进来时用）
        const makeRow = (message, past, s) => {
            if (message.kind === 'system') {
                const el = createElement('div', `gc-row gc-system${message.stamp ? ' is-stamp' : ''}`);
                el.append(createElement('span', '', message.text));
                return { message, el };
            }
            const el = createElement('div', `gc-row is-${message.side}`);
            if (message.kind === 'sticker') {
                el.classList.add('is-sticker');
                el.append(avatar(message.sender));
                const body = createElement('div', 'gc-body');
                body.append(createElement('div', 'gc-name', message.sender.name), createElement('div', 'gc-sticker', message.text));
                el.append(body);
                return { message, el };
            }
            if (message.continued) el.classList.add('is-continued');
            el.append(avatar(message.sender));
            const body = createElement('div', 'gc-body');
            if (!message.sender.me && !message.continued) body.append(createElement('div', 'gc-name', message.sender.name));
            const bubble = createElement('div', 'gc-bubble');
            body.append(bubble);
            el.append(body);
            if (message.kind === 'voice') {
                el.classList.add('is-voice');
                bubble.innerHTML = '<i class="gc-play"></i><div class="gc-wave"></div><span class="gc-dur"></span>';
                const wave = bubble.querySelector('.gc-wave');
                const bars = [];
                for (let i = 0; i < BARS; i += 1) {
                    const b = createElement('i');
                    // 没在播的时候：一条固定的、看着像语音的波形
                    const rest = 0.25 + 0.55 * Math.abs(Math.sin(i * 1.7 + message.start)) * (0.6 + 0.4 * unit('bar', message.start, i));
                    b.style.transform = `scaleY(${rest.toFixed(3)})`;
                    b.dataset.rest = rest.toFixed(3);
                    wave.append(b);
                    bars.push(b);
                }
                bubble.querySelector('.gc-dur').textContent = message.whole ? fmt(message.end - message.start) : `${Math.max(1, Math.round(message.end - message.start))}″`;
                if (message.whole) body.append(createElement('div', 'gc-meta', '这首没有歌词 · 一起听'));
                return { message, el, bars, played: 0 };
            }
            if (message.chorus) el.classList.add('is-chorus');
            const text = createElement('div', 'gc-text');
            bubble.append(text);
            const glyphs = buildGlyphTimeline(message.line);
            let tr = null;
            const supplemental = s.showTranslation ? resolveSupplementalText(message.line) : '';
            if (supplemental) {
                tr = createElement('div', 'gc-tr', supplemental);
                bubble.append(tr);
            }
            const row = { message, el, text, glyphs, shown: 0, tr, bubble, body, meta: null };
            if (message.chorus && s.echoes && message.echoes.length) {
                const echo = createElement('div', 'gc-echo');
                const stack = createElement('div', 'gc-stack');
                message.echoes.forEach(m => stack.append(avatar(m, 'gc-mini')));
                echo.append(stack, createElement('span', '', `${message.echoes.length} 人一起唱`));
                body.append(echo);
                row.echo = echo;
                if (past) echo.classList.add('is-on');
            }
            if (past) {
                text.textContent = message.line.fullText;
                row.shown = glyphs.length;
                el.classList.add('is-past');
                finish(row, s, false);
            } else {
                if (tr) tr.classList.add('is-waiting');
                el.classList.add('is-active');
            }
            return row;
        };

        // 唱完：补上点赞、已读
        const finish = (row, s, animate) => {
            if (row.done) return;
            row.done = true;
            const m = row.message;
            if (row.tr) row.tr.classList.remove('is-waiting');
            const parts = [];
            if (s.reactions && m.reaction) {
                const chip = createElement('span', 'gc-chip', `${m.reaction.mark} ${m.reaction.count}`);
                if (animate && s.live) chip.classList.add('is-pop');
                parts.push(chip);
            }
            if (m.side === 'right') parts.push(createElement('span', 'gc-read', `${2 + (m.index % 4)} 人已读`));
            parts.push(createElement('span', 'gc-time', fmt(m.start)));
            if (parts.length) {
                const meta = createElement('div', 'gc-meta');
                meta.append(...parts);
                row.body.append(meta);
                row.meta = meta;
            }
        };

        const trim = () => {
            while (rows.length > KEEP_ROWS) rows.shift().el.remove();
        };

        // 新行进来时整列往上滑：先把列表往下挪出新行的高度，再过渡回 0
        const pushRow = (row, animate) => {
            const before = list.offsetHeight;
            if (typingRow) list.insertBefore(row.el, typingRow.el); else list.append(row.el);
            rows.push(row);
            if (!animate) return;
            const delta = list.offsetHeight - before;
            row.el.classList.add('is-enter');
            if (delta > 0) {
                list.style.transition = 'none';
                list.style.transform = `translateY(${delta}px)`;
                void list.offsetHeight;
                list.style.transition = '';
                list.style.transform = '';
            }
        };

        const rebuild = (index, s, t) => {
            stats.rebuilds += 1;
            list.replaceChildren();
            rows = [];
            typingRow = null;
            typingFor = null;
            voiceRow = null;
            const from = Math.max(0, index - KEEP_ROWS + 1);
            for (let k = from; k <= index; k += 1) {
                const m = messages[k];
                const live = k === index && (m.kind === 'line' || m.kind === 'voice');
                const row = makeRow(m, !live, s);
                pushRow(row, false);
                if (m.kind === 'voice' && t < m.end) voiceRow = row;
            }
            shownUpTo = index;
        };

        const setTyping = (message, t) => {
            if (typingFor === message) return;
            if (typingRow) { typingRow.el.remove(); typingRow = null; }
            typingFor = message;
            if (!message) return;
            const el = createElement('div', `gc-row gc-typing is-${message.side}`);
            el.append(avatar(message.sender));
            const bubble = createElement('div', 'gc-bubble');
            bubble.innerHTML = '<i></i><i></i><i></i>';
            el.append(bubble);
            typingRow = { el };
            const before = list.offsetHeight;
            list.append(el);
            const delta = list.offsetHeight - before;
            if (delta > 0 && Number.isFinite(t)) {
                list.style.transition = 'none';
                list.style.transform = `translateY(${delta}px)`;
                void list.offsetHeight;
                list.style.transition = '';
                list.style.transform = '';
            }
        };

        const revealRow = (row, t, s) => {
            if (!row.glyphs || row.done) return;
            let count = 0;
            while (count < row.glyphs.length && row.glyphs[count].startTime <= t + 0.02) count += 1;
            if (count < row.shown) {
                row.text.replaceChildren();
                row.shown = 0;
            }
            if (count > row.shown) {
                const frag = global.document.createDocumentFragment();
                for (let i = row.shown; i < count; i += 1) {
                    const span = createElement('span', s.reducedMotion || !s.live ? '' : 'is-new', row.glyphs[i].text);
                    frag.append(span);
                }
                row.text.append(frag);
                row.shown = count;
            }
            const line = row.message.line;
            const end = Math.max(line.endTime, line.vocalEndTime || 0);
            if (row.echo && t >= line.startTime + 0.35) row.echo.classList.add('is-on');
            if (count >= row.glyphs.length && t >= end - 0.05) {
                row.el.classList.remove('is-active');
                row.el.classList.add('is-past');
                finish(row, s, true);
            }
        };

        const updateVoice = (row, frame, s) => {
            const m = row.message;
            const t = frame.playbackTime;
            const live = t >= m.start && t < m.end;
            row.el.classList.toggle('is-playing', live && frame.isPlaying);
            const played = clamp((t - m.start) / Math.max(0.1, m.end - m.start), 0, 1);
            const cut = Math.floor(played * BARS);
            if (cut !== row.played) {
                row.bars.forEach((b, i) => b.classList.toggle('is-played', i < cut));
                row.played = cut;
            }
            if (!live) {
                if (row.wasLive) row.bars.forEach(b => { b.style.transform = `scaleY(${b.dataset.rest})`; });
                row.wasLive = false;
                return;
            }
            row.wasLive = true;
            const spec = frame.audio?.spectrum || [];
            const n = spec.length;
            row.bars.forEach((b, i) => {
                const mirror = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
                const v = n ? clamp(Number(spec[Math.floor(Math.pow(1 - mirror, 1.6) * n * 0.6)]) || 0, 0, 1) : 0;
                const h = clamp(0.14 + v * 1.1 * s.audioReactivity, 0.12, 1);
                b.style.transform = `scaleY(${h.toFixed(3)})`;
            });
        };

        const updateHeader = (frame, typing, s) => {
            const title = String(frame.track?.title || '').trim() || '群唱';
            const next = `《${title}》`;
            if (next !== caption) { caption = next; headTitle.textContent = next; }
            let subtitle;
            if (typing) subtitle = `${typing.sender.me ? '我' : typing.sender.name} 正在输入…`;
            else if (voiceRow && frame.playbackTime < voiceRow.message.end && frame.playbackTime >= voiceRow.message.start) subtitle = `${voiceRow.message.sender.name} 的语音 · 播放中`;
            else if (frame.lyricsEstimated) subtitle = `${MEMBERS.length + 1} 人 · 纯文本歌词，按时长铺开`;
            else subtitle = `${MEMBERS.length + 1} 人 · ${Utils.lineCounter(frame)}`;
            if (subtitle !== sub) { sub = subtitle; headSub.textContent = subtitle; head.classList.toggle('is-typing', Boolean(typing)); }
            // 右上角的电平小格
            const a = frame.audio || {};
            const vals = [a.bass, a.lowMid, a.vocal, a.treble];
            levels.forEach((el, i) => {
                const v = frame.isPlaying && !s.reducedMotion ? clamp((Number(vals[i]) || 0) * 1.3 * s.audioReactivity, 0.08, 1) : 0.15;
                el.style.transform = `scaleY(${v.toFixed(2)})`;
            });
        };

        const step = (frame) => {
            const s = settings();
            s.live = Boolean(frame.isPlaying);
            mode.root.classList.toggle('is-live', s.live && !s.reducedMotion);
            const t = frame.playbackTime || 0;
            const key = `${frame.track?.path || frame.track?.title || ''}|${Math.round(frame.duration || 0)}`;
            if (!threadFor || threadFor.lines !== frame.lines || threadFor.key !== key) {
                messages = buildThread(frame.lines, String(frame.track?.title || '').trim(), frame.duration);
                threadFor = { lines: frame.lines, key };
                shownUpTo = -2;
            }
            const index = messageIndexAt(messages, t);
            // 往回拖、或者一下跳过好几条：整列重排；正常播放：一条一条加
            if (index < shownUpTo || index > shownUpTo + 2 || t < lastT - 0.5) rebuild(index, s, t);
            else {
                while (shownUpTo < index) {
                    shownUpTo += 1;
                    const m = messages[shownUpTo];
                    const prevActive = rows.filter(r => r.glyphs && !r.done);
                    prevActive.forEach((r) => {
                        r.text.textContent = r.message.line.fullText;
                        r.shown = r.glyphs.length;
                        r.el.classList.remove('is-active');
                        r.el.classList.add('is-past');
                        finish(r, s, true);
                    });
                    if (typingFor === m) { typingRow?.el.remove(); typingRow = null; typingFor = null; }
                    const row = makeRow(m, false, s);
                    pushRow(row, !s.reducedMotion && s.live);
                    if (m.kind === 'voice') voiceRow = row;
                }
                trim();
            }
            lastT = t;
            stats.rows = rows.length;

            const typing = typingAt(messages, t);
            setTyping(typing, frame.isPlaying && !s.reducedMotion ? t : NaN);
            rows.forEach((row) => { if (row.glyphs && !row.done) revealRow(row, t, s); });
            if (voiceRow) {
                if (!s.voiceNotes) voiceRow.el.hidden = true;
                else { voiceRow.el.hidden = false; updateVoice(voiceRow, frame, s); }
            }
            updateHeader(frame, typing, s);

            // 鼓点：正在唱的那条轻轻一跳
            const audio = frame.audio || {};
            const onset = Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets;
            if (Number.isFinite(audio.onsets)) lastOnsets = audio.onsets;
            if (onset && frame.isPlaying && !s.reducedMotion) {
                const active = rows.find(r => r.glyphs && !r.done);
                if (active) {
                    active.bubble.classList.remove('is-thump');
                    void active.bubble.offsetWidth;
                    active.bubble.classList.add('is-thump');
                }
            }
            const chorusNow = rows.some(r => r.message.chorus && !r.done);
            mode.root.classList.toggle('is-chorus', chorusNow);
            const cap = `群唱 · ${Utils.lineCounter(frame)}`;
            if (cap !== kicker.textContent) kicker.textContent = cap;
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            latest = frame;
            const aim = 1000 / (FPS[mode.config.quality || 'standard'] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (!frame.isPlaying && frame.playbackTime === lastT && threadFor && threadFor.lines === frame.lines) return;
            lastDraw = now - lastDraw < aim * 2 ? lastDraw + aim : now;
            step(frame);
        };

        const refresh = () => { lastDraw = -Infinity; shownUpTo = -2; threadFor = null; if (latest) mode.updateFrame(latest); };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); applyScale(); refresh(); };
        mode.resize = () => cardInset.measure();
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); lastDraw = -Infinity; if (latest) mode.updateFrame(latest); };
        mode.updateTheme = () => {};
        mode.getDebugSnapshot = () => ({ initialized: true, messages: messages.length, rows: stats.rows, rebuilds: stats.rebuilds });
        return mode;
    };

    global.MusicStageGroupchatManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ buildThread, messageIndexAt, typingAt, MEMBERS, ME, TYPING_LEAD })
    });
})(window);
