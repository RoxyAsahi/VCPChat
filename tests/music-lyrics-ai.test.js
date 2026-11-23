const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// AI 翻译外语歌词：哪些歌词要翻、主进程怎么请求和缓存、渲染端怎么把译文填回去。
const { needsTranslation, setupMusicLyricsAi } = require(path.join(__dirname, '../Musicmodules/music-lyrics-ai.js'));
const { createLyricsTranslator, parseTranslations, completionsUrl } = require(path.join(__dirname, '../modules/musicLyricsTranslate.js'));

const L = (...texts) => texts.map((t, i) => ({ time: i, original: t, translation: '' }));

test('needsTranslation: Japanese / English yes; Chinese, already translated, instrumental no', () => {
    assert.ok(needsTranslation(L('夜に駆ける', '沈むように溶けてゆくように', '二人だけの空が広がる夜に')));
    assert.ok(needsTranslation(L('I walk alone tonight', 'Under the city lights', '晴天')));
    assert.ok(needsTranslation(L('사랑해요', '보고 싶어')));
    assert.ok(!needsTranslation(L('故事的小黄花', '从出生那年就飘着', '童年的荡秋千')));
    assert.ok(!needsTranslation(L('作词：方文山', '作曲：周杰伦')));
    const done = L('夜に駆ける', '沈むように溶けてゆくように', '二人だけの空');
    done.forEach((l) => { l.translation = '译'; });
    assert.ok(!needsTranslation(done));
    assert.ok(!needsTranslation(L('纯音乐，请欣赏')));
});

test('parseTranslations tolerates fences and checks the line count', () => {
    assert.deepEqual(parseTranslations('```json\n["一", " 二 "]\n```', 2), ['一', '二']);
    assert.throws(() => parseTranslations('["一"]', 2), /行数/);
    assert.throws(() => parseTranslations('对不起', 2), /译文列表/);
    assert.equal(completionsUrl('http://127.0.0.1:6005/v1/chatvcp/completions'), 'http://127.0.0.1:6005/v1/chat/completions');
});

test('translator: uses the summary model on /chat/completions, caches, and skips without a model', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyr-'));
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push([url, JSON.parse(init.body), init.headers]);
        const lines = JSON.parse(JSON.parse(init.body).messages[1].content).lines;
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(lines.map((l) => '中' + l)) } }] }) };
    };
    let settings = { vcpServerUrl: 'http://127.0.0.1:6005/v1/chatvcp/completions', vcpApiKey: 'k', topicSummaryModel: 'm1' };
    const tr = createLyricsTranslator({ getSettings: async () => settings, getCacheDir: () => dir, fetchImpl });
    const r1 = await tr.translate({ lines: ['a', 'b'], title: 't', artist: 'x' });
    assert.equal(r1.status, 'success');
    assert.deepEqual(r1.translations, ['中a', '中b']);
    assert.equal(calls[0][0], 'http://127.0.0.1:6005/v1/chat/completions');
    assert.equal(calls[0][1].model, 'm1');
    assert.equal(calls[0][2].Authorization, 'Bearer k');
    const r2 = await tr.translate({ lines: ['a', 'b'] });
    assert.equal(r2.cached, true);
    assert.equal(calls.length, 1, 'second time comes from the cache');
    settings = { vcpServerUrl: 'http://x/v1/chat/completions' };
    const r3 = await createLyricsTranslator({ getSettings: async () => settings, getCacheDir: () => dir, fetchImpl }).translate({ lines: ['c', 'd'] });
    assert.equal(r3.status, 'unavailable');
});

test('renderer fills translations for the same lyrics only', async () => {
    globalThis.CustomEvent = class { constructor(t, i) { this.detail = i?.detail; } };
    globalThis.MusicToast = { show() {} };
    const store = new Map();
    let resolveApi;
    const app = {
        playlist: [{ title: 'x.flac', artist: 'y' }], currentTrackIndex: 0, lyricsRequestToken: 1, currentLyrics: [],
        renders: 0, renderLyrics() { app.renders++; },
        fetchAndDisplayLyrics: async () => { app.currentLyrics = L('夜に駆ける', '沈むように溶けてゆく'); },
        api: { translateMusicLyrics: (p) => new Promise((r) => { resolveApi = () => r({ status: 'success', translations: p.lines.map((l) => '译' + l) }); }) }
    };
    setupMusicLyricsAi(app, { storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
    await app.fetchAndDisplayLyrics();
    const before = app.currentLyrics;
    resolveApi();
    await new Promise((r) => setTimeout(r, 0));
    assert.notEqual(app.currentLyrics, before, 'a new array so other views notice');
    assert.equal(app.currentLyrics[0].translation, '译夜に駆ける');
    assert.equal(app.currentLyrics[0].translationSource, 'ai');
    assert.equal(app.renders, 1);
    // 切歌后才回来的结果不填
    await app.fetchAndDisplayLyrics();
    app.lyricsRequestToken = 2;
    resolveApi();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(app.currentLyrics[0].translation, '');
    // 关掉以后不翻
    app.lyricsAi.enabled = false;
    let asked = false;
    app.api.translateMusicLyrics = async () => { asked = true; return { status: 'success', translations: [] }; };
    await app.fetchAndDisplayLyrics();
    assert.equal(asked, false);
});
