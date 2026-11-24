const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 声道：存本机，引擎重启回到默认时把存的再发过去；没报 channels 的旧引擎当不支持。
const { setupMusicChannels, normalize, describe } = require(path.join(__dirname, '../Musicmodules/music-channels.js'));

test('normalize clamps and rounds; describe says it in words', () => {
    assert.deepEqual(normalize({ balance: -1.7, swap: 1 }), { balance: -1, swap: true, mono: false });
    assert.deepEqual(normalize(null), { balance: 0, swap: false, mono: false });
    assert.equal(describe({ balance: 0, swap: false, mono: false }), '正常立体声');
    assert.equal(describe({ balance: 0.3, swap: true, mono: true }), '单声道、左右互换、偏右 30%');
});

test('old engine is unsupported; new engine gets the saved setting re-sent after a restart', async () => {
    const store = new Map([['musicChannels', JSON.stringify({ balance: -0.2, swap: false, mono: true })]]);
    const sent = [];
    const app = {
        updateUIWithState: () => 'ok',
        api: { setMusicChannels: async (v) => { sent.push(v); return { status: 'success', channels: v }; } }
    };
    setupMusicChannels(app, { storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
    assert.equal(app.updateUIWithState({ is_playing: true }), 'ok');
    assert.equal(app.channels.supported, false);
    app.updateUIWithState({ channels: { balance: 0, swap: false, mono: false } });
    assert.equal(app.channels.supported, true);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [{ balance: -0.2, swap: false, mono: true }]);
    // 一样了就不再发
    app.updateUIWithState({ channels: { balance: -0.2, swap: false, mono: true } });
    await app.channels.set({ swap: true });
    assert.deepEqual(sent.at(-1), { balance: -0.2, swap: true, mono: true });
    assert.deepEqual(JSON.parse(store.get('musicChannels')), { balance: -0.2, swap: true, mono: true });
    assert.equal(sent.length, 2);
});
