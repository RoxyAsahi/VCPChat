'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EmoTagStreamParser, parseEmoTag, stripEmoTags } = require('../modules/deskpet/emoTags');
const { createPetDirector, classifyFallback } = require('../modules/deskpet/petDirector');
const classifier = require('../modules/deskpet/chatEmotionClassifier');

const delta = (content) => ({ choices: [{ delta: { content } }] });

function parser() {
    return new EmoTagStreamParser({ normalizeEmotion: classifier.normalizeEmotionToken });
}

function fakeClock() {
    let t = 0;
    const timers = [];
    return {
        now: () => t,
        setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
        clearTimer: (h) => { const i = timers.indexOf(h); if (i !== -1) timers.splice(i, 1); },
        advance(ms) {
            const until = t + ms;
            for (;;) {
                timers.sort((a, b) => a.at - b.at);
                if (!timers.length || timers[0].at > until) break;
                const next = timers.shift();
                t = Math.max(t, next.at);
                next.fn();
            }
            t = until;
        },
    };
}

test('emo tag parsing accepts emotion, variant and intensity', () => {
    assert.deepEqual(parseEmoTag('<!--emo:happy 0.8-->', classifier.normalizeEmotionToken),
        { emotion: 'happy', variant: null, intensity: 0.8 });
    assert.deepEqual(parseEmoTag('<!-- emo:shy/blush -->', classifier.normalizeEmotionToken),
        { emotion: 'shy', variant: 'blush', intensity: 0.7 });
    assert.equal(parseEmoTag('<!--emo:furious-->', classifier.normalizeEmotionToken), null);
});

test('stream parser holds back a tag split across chunks', () => {
    const p = parser();
    const a = p.push('你好<!--em');
    assert.equal(a.tags.length, 0);
    assert.equal(a.text, '你好');
    const b = p.push('o:happy 0.9-->呀');
    assert.equal(b.tags.length, 1);
    assert.equal(b.tags[0].emotion, 'happy');
    assert.equal(b.text, '呀');
});

test('stream parser catches a tag whose opener is split right after "<"', () => {
    const p = parser();
    const text = '开心～\n\n<!--emo:shy 0.8-->被你看着';
    const tags = [];
    let visible = '';
    for (const part of ['开心～\n\n<', '!--emo', ':shy 0', '.8-->被', '你看着']) {
        const r = p.push(part);
        tags.push(...r.tags);
        visible += r.text;
    }
    visible += p.flush().text;
    assert.deepEqual(tags.map((t) => t.emotion), ['shy']);
    assert.equal(visible, text.replace('<!--emo:shy 0.8-->', ''));
});

test('stream parser ignores tags inside code fences and tool requests', () => {
    const p = parser();
    const r = p.push('```\n<!--emo:sad-->\n```<<<[TOOL_REQUEST]>>>x<!--emo:annoyed--><<<[END_TOOL_REQUEST]>>>ok<!--emo:calm-->');
    assert.deepEqual(r.tags.map((t) => t.emotion), ['calm']);
    assert.equal(r.toolOpened, true);
    assert.equal(r.toolClosed, true);
});

test('stripEmoTags removes only emo comments', () => {
    assert.equal(stripEmoTags('a<!--emo:happy-->b<!-- other -->'), 'ab<!-- other -->');
});

test('director goes thinking -> speaking -> tagged emotion -> idle, then decays', () => {
    const clock = fakeClock();
    const frames = [];
    const d = createPetDirector({ agentId: 'a1', emit: (f) => frames.push(f), ...clock });
    d.begin('m1');
    assert.equal(frames.at(-1).state, 'thinking');
    d.data('m1', delta('<!--emo:happy 0.8-->今天天气真好'));
    assert.ok(frames.some((f) => f.state === 'speaking'));
    assert.equal(frames.at(-1).emotion, 'happy');
    assert.equal(frames.at(-1).source, 'tag');
    d.end('m1');
    assert.equal(frames.at(-1).state, 'idle');
    assert.equal(frames.at(-1).emotion, 'happy');
    clock.advance(6000);
    assert.equal(frames.at(-1).emotion, 'calm');
    d.dispose();
});

test('director shows the tool state while a tool request streams', () => {
    const clock = fakeClock();
    const frames = [];
    const d = createPetDirector({ agentId: 'a1', emit: (f) => frames.push(f), ...clock });
    d.data('m2', delta('我查一下<<<[TOOL_REQUEST]>>>'));
    assert.equal(frames.at(-1).state, 'tool');
    d.data('m2', delta('tool_name:「始」x「末」<<<[END_TOOL_REQUEST]>>>'));
    assert.equal(frames.at(-1).state, 'speaking');
    d.dispose();
});

test('director keeps each emotion for a minimum dwell and plays queued tags in order', () => {
    const clock = fakeClock();
    const frames = [];
    const d = createPetDirector({ agentId: 'a1', emit: (f) => frames.push(f), ...clock });
    d.data('m3', delta('<!--emo:happy-->a<!--emo:sad-->b<!--emo:surprised-->c'));
    assert.equal(frames.at(-1).emotion, 'happy');
    clock.advance(1500);
    assert.equal(frames.at(-1).emotion, 'sad');
    clock.advance(1500);
    assert.equal(frames.at(-1).emotion, 'surprised');
    d.dispose();
});

test('untagged replies fall back to the rule classifier', () => {
    const clock = fakeClock();
    const frames = [];
    const d = createPetDirector({ agentId: 'a1', emit: (f) => frames.push(f), ...clock });
    d.data('m4', delta('哈哈哈太好了，真开心！'));
    d.end('m4');
    const emotionFrame = frames.find((f) => f.reason === 'emotion');
    assert.ok(emotionFrame, 'a rule-based emotion frame is emitted');
    assert.equal(emotionFrame.source, 'rule');
    assert.equal(classifyFallback('').emotion, 'calm');
    d.dispose();
});

test('errors show the error state and recover to idle', () => {
    const clock = fakeClock();
    const frames = [];
    const d = createPetDirector({ agentId: 'a1', emit: (f) => frames.push(f), ...clock });
    d.begin('m5');
    d.error('m5');
    assert.equal(frames.at(-1).state, 'error');
    clock.advance(3000);
    assert.equal(frames.at(-1).state, 'idle');
    d.dispose();
});

test('a long burst of tags keeps only the newest few queued', () => {
    const clock = fakeClock();
    const frames = [];
    const d = createPetDirector({ agentId: 'a1', emit: (f) => frames.push(f), ...clock });
    d.data('m6', delta('<!--emo:happy-->a<!--emo:sad-->b<!--emo:shy-->c<!--emo:annoyed-->d<!--emo:surprised-->e'));
    clock.advance(10000);
    const played = frames.filter((f) => f.reason === 'emotion').map((f) => f.emotion);
    assert.deepEqual(played, ['happy', 'shy', 'annoyed', 'surprised']);
    d.dispose();
});
