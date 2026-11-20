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
        navigator: {},
        localStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })()
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
    return { app, playlist, preloads, loads, preload, events, context };
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

test('peekPrevious names what prev will play without touching history', () => {
    const { app, playlist } = setup();
    app.currentTrackIndex = 2;
    assert.equal(app.peekPrevious(), playlist[1], 'no history: previous in the list');
    app.rememberPlayed(playlist[4]);
    app.rememberPlayed(playlist[2]);
    assert.equal(app.peekPrevious(), playlist[4], 'history wins, skipping the current track');
    assert.equal(app.peekPrevious(), playlist[4], 'peeking twice gives the same answer');
    const loads = [];
    app.loadTrack = (i) => loads.push(i);
    app.prevTrack();
    assert.deepEqual(loads, [4]);
});

test('session: saves track, time, context and manual queue, and restores them by path without autoplay', () => {
    const { app, playlist, context } = setup();
    app.currentTrackIndex = 2;
    app.lastKnownCurrentTime = 83.46;
    app.currentFilteredTracks = [playlist[2], playlist[4], playlist[0]];
    app.filteredPlaylistSource = { type: 'playlist', id: 'p1', name: '通勤' };
    app.queueAdd(playlist[3]);
    app.saveSession();
    const saved = JSON.parse(context.localStorage.getItem('musicSession'));
    assert.equal(saved.track, 'C:/m/2.flac');
    assert.equal(saved.time, 83.5);
    assert.deepEqual(Array.from(saved.context), ['C:/m/2.flac', 'C:/m/4.flac', 'C:/m/0.flac']);
    assert.deepEqual(Array.from(saved.manual), ['C:/m/3.flac']);

    // 「重启」：新的播放器，曲库是重新扫描出来的新对象，还少了一首
    const next = setup();
    next.context.localStorage.setItem('musicSession', JSON.stringify(saved));
    next.app.playlist.splice(4, 1);
    next.app.renderPlaylist = () => {};
    const start = next.app.sessionStartPoint();
    assert.deepEqual({ ...start }, { index: 2, time: 83.5 });
    next.app.applySessionQueue();
    assert.deepEqual(titles(next.app.currentFilteredTracks), ['t2', 't0'], 'missing tracks are skipped');
    assert.equal(next.app.filteredPlaylistSource.id, 'p1');
    assert.deepEqual(titles(next.app.manualQueue), ['t3']);
    assert.equal(next.loads.length, 0, 'restoring does not start playback');
});

test('session: a whole-library context is stored as null and a missing track gives no start point', () => {
    const { app, context } = setup();
    app.currentTrackIndex = 1;
    app.saveSession();
    assert.equal(JSON.parse(context.localStorage.getItem('musicSession')).context, null);
    const next = setup();
    next.context.localStorage.setItem('musicSession', JSON.stringify({ v: 1, track: 'C:/gone.flac', time: 9 }));
    assert.equal(next.app.sessionStartPoint(), null);
});

test('playFromContext: the shown order becomes the context; library order is stored as the whole library', () => {
    const { app, playlist, loads } = setup();
    let rendered = 0;
    app.renderPlaylist = () => { rendered += 1; };
    const shown = [playlist[3], playlist[1], playlist[4]];
    app.playFromContext(shown, 1, { origin: 'classic', render: false });
    assert.deepEqual(titles(app.currentFilteredTracks), ['t3', 't1', 't4']);
    assert.equal(rendered, 0, 'render: false leaves the list alone');
    assert.deepEqual(loads, [1]);
    assert.equal(app.getUpNext(3).context.map(t => t.title).join(), 't4,t3');

    app.playFromContext(playlist.slice(), 0, { origin: 'classic' });
    assert.equal(app.currentFilteredTracks, null, 'same as the library order means the whole library');
    assert.equal(rendered, 1);
});

test('reorderContext: follows a new sort of the same group, only while that origin still owns the context', () => {
    const { app, playlist, events } = setup();
    app.playFromContext([playlist[0], playlist[1], playlist[2]], 1, { origin: 'classic', render: false });
    const before = events.filter(e => e === 'music-queue-change').length;

    assert.equal(app.reorderContext([playlist[2], playlist[1], playlist[0]], 'classic'), true);
    assert.deepEqual(titles(app.currentFilteredTracks), ['t2', 't1', 't0']);
    assert.equal(app.getUpNext(1).context[0].title, 't0', 'next follows the new order');
    assert.ok(events.filter(e => e === 'music-queue-change').length > before, 'the queue page is told');
    assert.equal(app.contextFrom('classic'), true, 'still owned after reordering');

    assert.equal(app.reorderContext([playlist[2], playlist[3], playlist[0]], 'classic'), false, 'different members are ignored');
    assert.equal(app.reorderContext([playlist[0], playlist[1], playlist[2]], 'archive'), false, 'another origin does not own it');

    // 档案页换了上下文：经典列表再怎么排序都不碰
    app.playFromContext([playlist[0], playlist[1], playlist[2]], 0, { origin: 'archive', render: false });
    assert.equal(app.contextFrom('classic'), false);
    assert.equal(app.reorderContext([playlist[1], playlist[0], playlist[2]], 'classic'), false);
    // 直接改上下文（旧代码路径）也让记录失效
    app.currentFilteredTracks = [playlist[4]];
    assert.equal(app.contextFrom('archive'), false);
});

test('lyrics offset: shifts the parsed timeline in place, is remembered per track, and is picked up on the next load', () => {
    const { app, playlist, context } = setup();
    let renders = 0;
    app.renderLyrics = () => { renders += 1; };
    const fetched = [];
    // 换歌时播放器会调用 fetchAndDisplayLyrics；这里只看它被调用时的偏移
    app.currentTrackIndex = 1;
    app.lastKnownCurrentTime = 10;
    app.lyricOffset = 0;
    app.currentLyrics = [
        { time: 5, startTime: 5, endTime: 9, words: [{ startTime: 5, endTime: 6 }] },
        { time: 9.8, startTime: 9.8, endTime: 12 }
    ];
    app.currentLyricIndex = 1;
    assert.equal(app.shiftLyrics(0.5), 0.5);
    assert.equal(app.currentLyrics[0].time, 5.5);
    assert.equal(app.currentLyrics[0].words[0].endTime, 6.5);
    assert.equal(app.currentLyricIndex, 0, 'the current line moves with the timeline');
    assert.ok(renders > 0);
    app.shiftLyrics(-1.5);
    assert.equal(app.lyricOffset, -1);
    assert.equal(app.currentLyrics[1].time, 8.8);
    assert.equal(JSON.parse(context.localStorage.getItem('musicLyricOffsets'))['C:/m/1.flac'], -1);
    assert.equal(app.lyricOffsetFor(playlist[2].path), 0);
    assert.equal(app.setLyricOffset(99), 30, 'clamped');
    app.setLyricOffset(0);
    assert.equal(context.localStorage.getItem('musicLyricOffsets'), '{}', 'zero is not stored');
    assert.equal(app.currentLyrics[0].time, 5);
});

test('lyrics offset is applied before the next track parses its lyrics; translation toggle persists', () => {
    const { app, context } = setup();
    context.localStorage.setItem('musicLyricOffsets', JSON.stringify({ 'C:/m/3.flac': 1.5 }));
    // 播放器会把已有的取歌词函数包一层：调用时先换成这首歌的偏移
    const seen = [];
    const fresh = { ...app, fetchAndDisplayLyrics() { seen.push(fresh.lyricOffset); } };
    context.setupPlayer(fresh);
    fresh.fetchAndDisplayLyrics('a', 't', { path: 'C:/m/3.flac' });
    fresh.fetchAndDisplayLyrics('a', 't', { path: 'C:/m/0.flac' });
    assert.deepEqual(seen, [1.5, 0]);

    assert.equal(fresh.lyricsTranslation, true, 'translation is shown by default');
    let renders = 0;
    fresh.renderLyrics = () => { renders += 1; };
    fresh.setLyricsTranslation(false);
    assert.equal(context.localStorage.getItem('musicLyricsTranslation'), 'false');
    assert.equal(renders, 1);
});

