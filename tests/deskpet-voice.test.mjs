import test from 'node:test';
import assert from 'node:assert/strict';
import { createLipSync, createSpeech, rmsToLevel } from '../DeskPetmodules/voice.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 假的 Web Audio：时钟走真实时间，每段音频的时长写在 base64 里（"秒数"），振幅固定 0.2。
function installFakeAudio() {
    const t0 = performance.now();
    class FakeContext {
        constructor() { this.state = 'running'; this.destination = {}; }
        get currentTime() { return (performance.now() - t0) / 1000; }
        createAnalyser() {
            const ctx = this;
            return {
                fftSize: 0,
                connect() {},
                getFloatTimeDomainData(out) {
                    const loud = FakeContext.playing.some((s) => s.startAt <= ctx.currentTime && ctx.currentTime < s.endAt);
                    out.fill(loud ? 0.2 : 0);
                },
            };
        }
        decodeAudioData(buffer) {
            const seconds = Number(new TextDecoder().decode(new Uint8Array(buffer)));
            return Promise.resolve({ duration: seconds });
        }
        createBufferSource() {
            const source = {
                playbackRate: { value: 1 },
                connect() {},
                start(at) {
                    source.startAt = at;
                    source.endAt = at + source.buffer.duration / source.playbackRate.value;
                    FakeContext.playing.push(source);
                    source.timer = setTimeout(() => source.onended?.(), (source.endAt - (performance.now() - t0) / 1000) * 1000);
                },
                stop() {
                    clearTimeout(source.timer);
                    source.endAt = 0;
                },
            };
            return source;
        }
        resume() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
    }
    FakeContext.playing = [];
    globalThis.AudioContext = FakeContext;
    return FakeContext;
}

// 假的主进程：记下送去合成的句子，按需要把「音频」发回来。
function fakeApi({ speaking = true } = {}) {
    const said = [];
    const ended = [];
    return {
        said,
        ended,
        voiceBegin: async () => ({ speaking }),
        voiceSay: (payload) => said.push(payload),
        voiceEnd: (payload) => ended.push(payload),
    };
}

const audio = (seconds) => Buffer.from(String(seconds)).toString('base64');

test('loudness mapping and lip sync: silence closes the mouth, speech opens it quickly', () => {
    assert.equal(rmsToLevel(0), 0);
    assert.ok(rmsToLevel(0.2) > 0.8);
    assert.ok(rmsToLevel(0.002) < 0.05);
    const lip = createLipSync();
    let open = 0;
    for (let i = 0; i < 4; i += 1) open = lip.update(0.9, 1 / 30);
    assert.ok(open > 0.7, `张嘴要在 130ms 内跟上：${open}`);
    for (let i = 0; i < 10; i += 1) open = lip.update(0.01, 1 / 30);
    assert.ok(open < 0.1, `安静下来要合上：${open}`);
});

test('a spoken reply: bubble and face follow the sentence being read, then everything is shown', async () => {
    const Ctx = installFakeAudio();
    const api = fakeApi();
    const frames = [];
    let releases = 0;
    const mouths = [];
    const speech = createSpeech({
        api,
        onFrame: (f) => frames.push(f.emotion),
        onRelease: () => { releases += 1; },
        onLevel: (open) => mouths.push(open),
    });
    speech.begin('m1');
    assert.equal(speech.revealEnd(), 0, '还没开口时气泡先不出字');
    await sleep(5);
    const raw1 = '你好呀！今天天气真好。';
    speech.update(`${raw1}可`, { emotion: 'happy' });
    const raw2 = `${raw1}可惜我出不去。`;
    speech.finish(raw2, { emotion: 'sad' });
    assert.deepEqual(api.said.map((s) => s.text), ['你好呀！', '今天天气真好。', '可惜我出不去。']);
    assert.equal(api.said[0].first, true);
    assert.equal(api.said[1].first, false);
    assert.ok(speech.holdsFrames(), '送出句子以后表情由句子控制');

    // 主进程合成好了：三句依次回来
    for (const s of api.said) speech.play({ audioData: audio(0.25), msgId: s.key, sessionId: 7 });
    await sleep(120);
    assert.equal(speech.revealEnd(), '你好呀！'.length, '念第一句时只显示第一句');
    assert.ok(mouths.some((m) => m > 0.3), '有声音时嘴张开');
    await sleep(270);
    assert.equal(speech.revealEnd(), raw1.length);
    await sleep(250);
    assert.equal(speech.revealEnd(), raw2.length);
    assert.deepEqual(frames, ['happy', 'happy', 'sad'], '每句换上切出它时的表情');
    // 念完：全部显示、表情交回导演、通知主进程
    await sleep(900);
    assert.equal(speech.revealEnd(), null);
    assert.equal(speech.active(), false);
    assert.equal(releases, 1);
    assert.deepEqual(api.ended, [{ messageId: 'm1', stop: false }]);
    assert.equal(speech.mouth(), null, '不在朗读时由调用方用自己的假口型');
    Ctx.playing.length = 0;
    speech.dispose();
});

test('tapping (stop) silences the pet at once and shows the whole reply', async () => {
    installFakeAudio();
    const api = fakeApi();
    const speech = createSpeech({ api });
    speech.begin('m2');
    await sleep(5);
    speech.update('第一句话在这里。第二句话也来了。还有', { emotion: 'neutral' });
    for (const s of api.said) speech.play({ audioData: audio(1), msgId: s.key, sessionId: 1 });
    await sleep(80);
    assert.ok(speech.speaking());
    speech.stop();
    assert.equal(speech.speaking(), false);
    assert.equal(speech.revealEnd(), null);
    assert.deepEqual(api.ended, [{ messageId: 'm2', stop: true }]);
    // 后面再流进来的句子不再送去念
    speech.update('第一句话在这里。第二句话也来了。还有第三句。然后', { emotion: 'neutral' });
    assert.equal(api.said.length, 2);
    speech.dispose();
});

test('no voice configured (or muted): nothing is sent and the bubble shows text as it streams', async () => {
    installFakeAudio();
    const api = fakeApi({ speaking: false });
    const speech = createSpeech({ api });
    speech.begin('m3');
    await sleep(5);
    speech.update('你好。这是一句话。', { emotion: 'neutral' });
    speech.finish('你好。这是一句话。', { emotion: 'neutral' });
    assert.equal(api.said.length, 0);
    assert.equal(speech.revealEnd(), null);
    assert.equal(speech.mouth(), null);
    assert.equal(speech.active(), false);
    speech.dispose();
});

test('stale audio from an older session is ignored; a new reply interrupts the old one', async () => {
    installFakeAudio();
    const api = fakeApi();
    const speech = createSpeech({ api });
    speech.begin('a');
    await sleep(5);
    speech.update('第一条回复的句子。后面', { emotion: 'neutral' });
    speech.play({ audioData: audio(1), msgId: api.said[0].key, sessionId: 5 });
    await sleep(60);
    assert.ok(speech.speaking());
    speech.begin('b');
    assert.equal(speech.speaking(), false, '新回复开始，旧的不念了');
    assert.deepEqual(api.ended.at(-1), { messageId: 'a', stop: true });
    await sleep(5);
    speech.update('第二条回复。后面', { emotion: 'neutral' });
    speech.play({ audioData: audio(1), msgId: api.said.at(-1).key, sessionId: 6 });
    speech.play({ audioData: audio(1), msgId: api.said[0].key, sessionId: 5 });
    await sleep(60);
    assert.equal(speech.revealEnd(), '第二条回复。'.length);
    speech.dispose();
});
