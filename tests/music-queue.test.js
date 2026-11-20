const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const titles = (list) => Array.from(list, (t) => t.title);

// 播放器的「下一首」和自动预载：先把现有行为锁住，再测手动队列。
function setup({ mode = 'repeat', count = 5 } = {}) {
    const events = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        document: { body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } }, dispatchEvent: (e) => events.push(e.type) },
        navigator: {}
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-player.js'), 'utf8'), context);
    const playlist = Array.from({ length: count }, (_, i) => ({ path: `C:/m/${i}.flac`, title: `t${i}` }));
    const preloads = [];
    const loads = [];
    const app = {
        playlist,
        currentTrackIndex: 0,
        currentFilteredTracks: null,
        playModes: ['repeat', 'repeat-one', 'shuffle'],
        currentPlayMode: ['repeat', 'repeat-one', 'shuffle'].indexOf(mode),
        shuffleQueue: [],
        pendingLoadRequestId: 0,
        normalizePathForCompare: (p) => (p || '').toLowerCase(),
        api: { queueNextMusicTrack: async (t) => { preloads.push(t.path); return { status: 'success' }; } }
    };
    context.setupPlayer(app);
    // 只看选了哪一首，不真的加载。
    app.loadTrack = (i) => { loads.push(i); app.currentTrackIndex = i; };
    const preload = async () => { app.isPreloadingNext = false; await app.handleNeedsPreload(); return preloads[preloads.length - 1]; };
    return { app, playlist, preloads, loads, preload, events };
}

test('repeat: next and preload both pick the following track in the active list and wrap', async () => {
    const { app, loads, preload } = setup();
    assert.equal(await preload(), 'C:/m/1.flac');
    app.nextTrack();
    assert.deepEqual(loads, [1]);
    app.currentTrackIndex = 4;
    assert.equal(await preload(), 'C:/m/0.flac');
    app.nextTrack();
    assert.equal(loads.pop(), 0);
});

test('repeat with a filtered list stays inside that list', async () => {
    const { app, playlist, loads, preload } = setup();
    app.currentFilteredTracks = [playlist[3], playlist[1]];
    app.currentTrackIndex = 3;
    assert.equal(await preload(), 'C:/m/1.flac');
    app.nextTrack();
    assert.equal(loads.pop(), 1);
    app.currentTrackIndex = 2; // 不在列表里：从列表头开始
    app.nextTrack();
    assert.equal(loads.pop(), 3);
});

test('repeat-one preloads the same track for a gapless loop', async () => {
    const { app, preload } = setup({ mode: 'repeat-one' });
    app.currentTrackIndex = 2;
    assert.equal(await preload(), 'C:/m/2.flac');
});

test('a single-track list does not preload unless repeating one', async () => {
    const { app, playlist, preloads, preload } = setup();
    app.currentFilteredTracks = [playlist[0]];
    await preload();
    assert.equal(preloads.length, 0);
});

test('shuffle: preload and next agree, never pick the current track, no repeats within a round', async () => {
    const { app, loads, preload } = setup({ mode: 'shuffle', count: 6 });
    const picks = new Set();
    for (let k = 0; k < 5; k++) {
        const before = app.currentTrackIndex;
        const preloaded = await preload();
        app.nextTrack();
        const picked = loads[loads.length - 1];
        assert.equal(`C:/m/${picked}.flac`, preloaded, 'next plays what was preloaded');
        assert.notEqual(picked, before);
        assert.ok(!picks.has(picked), 'no repeats within one round');
        picks.add(picked);
    }
});

// ───────── 手动队列 ─────────

test('play-next goes before add-to-queue, both before the context, and context resumes where it left off', async () => {
    const { app, playlist, loads, preload } = setup();
    app.queueAdd(playlist[4]);
    app.queuePlayNext(playlist[3]);
    assert.deepEqual(titles(app.manualQueue), ['t3', 't4']);
    assert.equal(await preload(), 'C:/m/3.flac', 'preload reads the queue');
    app.nextTrack();
    app.nextTrack();
    assert.deepEqual(loads, [3, 4]);
    assert.equal(app.manualQueue.length, 0);
    app.nextTrack();
    assert.equal(loads.pop(), 1, 'back to the context after track 0, not after track 4');
});

test('queueing a track that is already queued moves it instead of duplicating', () => {
    const { app, playlist } = setup();
    app.queueAdd(playlist[1]);
    app.queueAdd(playlist[2]);
    app.queueAdd(playlist[1]);
    assert.deepEqual(titles(app.manualQueue), ['t2', 't1']);
    app.queuePlayNext('C:/m/1.flac');
    assert.deepEqual(titles(app.manualQueue), ['t1', 't2']);
    app.queueMove(0, 1);
    assert.deepEqual(titles(app.manualQueue), ['t2', 't1']);
    app.queueRemove(0);
    assert.deepEqual(titles(app.manualQueue), ['t1']);
    app.queueClear();
    assert.equal(app.manualQueue.length, 0);
});

test('queue changes after a preload re-issue the preload so the engine slot is not stale', async () => {
    const { app, playlist, preloads, preload } = setup();
    await preload();
    assert.equal(preloads.pop(), 'C:/m/1.flac');
    app.isPreloadingNext = false;
    app.queuePlayNext(playlist[3]);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(preloads.pop(), 'C:/m/3.flac');
    app.isPreloadingNext = false;
    app.queueRemove(0);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(preloads.pop(), 'C:/m/1.flac', 'removing the head puts the context track back');
});

test('gapless switch into a queued track consumes it', async () => {
    const { app, playlist, preload } = setup();
    app.queuePlayNext(playlist[3]);
    await preload();
    app.renderPlaylist = () => {};
    app.trackTitle = {}; app.trackArtist = {}; app.trackBitrate = {}; app.albumArt = { style: {} };
    app.stripAudioExtension = (t) => t; app.updateBlurredBackground = () => {}; app.fetchAndDisplayLyrics = () => {};
    app.updateMediaSessionMetadata = () => {}; app.rememberPlayed = () => {}; app.publishCapsuleState = () => {};
    app.syncTrackIndexByPath('C:/m/3.flac');
    assert.equal(app.currentTrackIndex, 3);
    assert.equal(app.manualQueue.length, 0);
    app.loadTrack = (i) => { app.currentTrackIndex = i; app.lastLoad = i; };
    app.nextTrack();
    assert.equal(app.lastLoad, 1, 'context continues after the track that was playing before the queue');
});

test('repeat-one ignores the manual queue for the automatic loop', async () => {
    const { app, playlist, preload } = setup({ mode: 'repeat-one' });
    app.queueAdd(playlist[2]);
    assert.equal(await preload(), 'C:/m/0.flac');
});

test('up next shows the manual layer then the real context order (shuffle included)', async () => {
    const { app, playlist, loads, preload } = setup({ mode: 'shuffle', count: 6 });
    app.queueAdd(playlist[5]);
    const up = app.getUpNext();
    assert.deepEqual(titles(up.manual), ['t5']);
    assert.equal(up.context.length, 5, 'every other track, in the order shuffle will play them');
    await preload(); app.nextTrack(); // 先放手动的那首
    assert.equal(loads.pop(), 5);
    const order = app.getUpNext().context.map((t) => t.path);
    await preload();
    app.nextTrack();
    assert.equal(`C:/m/${loads.pop()}.flac`, order[0]);

    const r = setup();
    r.app.currentTrackIndex = 3;
    assert.deepEqual(titles(r.app.getUpNext().context), ['t4', 't0', 't1', 't2']);
});
