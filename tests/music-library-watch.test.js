const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 曲库文件夹自动同步：加过的文件夹完整同步，推出来的只更新；没变化不发；拔掉的盘不动；文件变化后再对一遍。
const { createLibraryWatch, collapseRoots, inferredDirs, changedSince } = require(path.join(__dirname, '../modules/musicLibraryWatch.js'));

const P = (...s) => path.join(path.sep === '\\' ? 'C:\\' : '/', ...s);

test('collapseRoots and inferredDirs', () => {
    assert.deepEqual(collapseRoots([P('m', 'a'), P('m'), P('x'), P('m', 'b')]), [P('m'), P('x')]);
    const dirs = inferredDirs([{ path: P('m', 'a', '1.flac') }, { path: P('m', 'a', '2.flac') }, { path: P('d', '3.mp3') }, { path: 'https://nas/x.flac' }]);
    assert.deepEqual(dirs, [P('m', 'a'), P('d')]);
    const k = [{ path: P('m', '1.flac'), size: 1, mtimeMs: 5 }];
    assert.equal(changedSince(k, [{ path: P('m', '1.flac'), size: 1, mtimeMs: 5 }], P('m')), false);
    assert.equal(changedSince(k, [{ path: P('m', '1.flac'), size: 2, mtimeMs: 5 }], P('m')), true);
    assert.equal(changedSince(k, [], P('m')), true);
});

function harness({ folders = [], known = [], disk = {}, missing = [] } = {}) {
    const sent = [];
    const timers = [];
    const watchers = [];
    let saved = folders.slice();
    const w = createLibraryWatch({
        scan: async (root) => ({ tracks: disk[root] || [], stats: { total: (disk[root] || []).length } }),
        readKnown: async () => known,
        readFolders: async () => saved,
        writeFolders: async (l) => { saved = l; },
        send: (ch, p) => sent.push([ch, p]),
        exists: async (d) => !missing.includes(d),
        watch: (dir, cb) => { const x = { dir, cb, closed: false, close() { this.closed = true; }, on() {} }; watchers.push(x); return x; },
        setTimer: (fn) => { timers.push(fn); return timers.length; },
        clearTimer: () => {},
        log: {}
    });
    const flush = async () => { while (timers.length) await timers.shift()(); await new Promise((r) => setTimeout(r, 5)); };
    return { w, sent, watchers, flush, saved: () => saved };
}

test('remembered folder: full sync only when something changed; inferred folder: update only', async () => {
    const music = P('music'), dl = P('dl'), usb = P('usb');
    const known = [
        { path: P('music', 'a.flac'), size: 1, mtimeMs: 1 },
        { path: P('dl', 'one.mp3'), size: 1, mtimeMs: 1 },
        { path: P('usb', 'u.flac'), size: 1, mtimeMs: 1 }
    ];
    const disk = {
        [music]: [{ path: P('music', 'a.flac'), size: 1, mtimeMs: 1 }, { path: P('music', 'new.flac'), size: 3, mtimeMs: 3 }],
        [dl]: [{ path: P('dl', 'one.mp3'), size: 9, mtimeMs: 9 }, { path: P('dl', 'other.mp3'), size: 1, mtimeMs: 1 }]
    };
    const h = harness({ folders: [music], known, disk, missing: [usb] });
    h.w.start();
    await h.flush();
    const byRoot = Object.fromEntries(h.sent.map(([, p]) => [p.folderPath === null ? 'update' : p.folderPath, p]));
    assert.deepEqual(byRoot[music].tracks.map((t) => path.basename(t.path)), ['a.flac', 'new.flac'], 'remembered folder picks up new songs');
    assert.deepEqual(byRoot.update.tracks.map((t) => path.basename(t.path)), ['one.mp3'], 'download folder: only the known, changed song; other.mp3 not added');
    assert.equal(h.sent.length, 2, 'unplugged usb drive is left alone');
    assert.deepEqual(h.watchers.map((x) => x.dir), [music, dl]);
    h.w.stop();
    assert.ok(h.watchers.every((x) => x.closed));
});

test('nothing changed: nothing sent; a file event rescans after the debounce; folders are remembered once', async () => {
    const music = P('music');
    const t = { path: P('music', 'a.flac'), size: 1, mtimeMs: 1 };
    const disk = { [music]: [t] };
    const h = harness({ known: [t], disk });
    await h.w.rememberFolder(music);
    await h.w.rememberFolder(P('music', 'sub'));
    assert.deepEqual(h.saved(), [music]);
    h.w.start();
    await h.flush();
    assert.equal(h.sent.length, 0);
    disk[music] = [t, { path: P('music', 'b.flac'), size: 2, mtimeMs: 2 }];
    h.watchers[0].cb('rename', 'cover.jpg');
    await h.flush();
    assert.equal(h.sent.length, 0, 'non-audio file changes are ignored');
    h.watchers[0].cb('rename', 'b.flac');
    await h.flush();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0][1].background, true);
});

test('songs the user removed from the library (file still on disk) are not added back by a full sync', async () => {
    const music = P('music');
    const a = { path: P('music', 'a.flac'), size: 1, mtimeMs: 1 };
    const b = { path: P('music', 'b.flac'), size: 1, mtimeMs: 1 };
    const gone = { path: P('music', 'gone.flac'), size: 1, mtimeMs: 1 };
    let excluded = [];
    const sent = [];
    const timers = [];
    const w = createLibraryWatch({
        scan: async () => ({ tracks: [a, b], stats: { total: 2 } }),
        readKnown: async () => [a],
        readFolders: async () => [music],
        writeFolders: async () => {},
        readExcluded: async () => excluded,
        writeExcluded: async (l) => { excluded = l; },
        fileExists: async (p) => p !== gone.path,
        send: (ch, p) => sent.push(p),
        exists: async () => true,
        watch: () => ({ close() {}, on() {} }),
        setTimer: (fn) => { timers.push(fn); return 1; },
        clearTimer: () => {},
        log: {}
    });
    await w.noteLibrarySaved([a, b, gone], [a]);
    assert.deepEqual(excluded, [b.path], 'b was removed by hand; gone.flac was deleted from disk');
    w.start();
    while (timers.length) await timers.shift()();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(sent.length, 0, 'b stays out, nothing else changed');
    await w.noteLibrarySaved([a], [a, b]);
    assert.deepEqual(excluded, [], 'added back by the user: no longer excluded');
});
