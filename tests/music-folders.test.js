const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 曲库文件夹：加过的文件夹在前并计数，其余的歌按位置归并。
const { folderRows, underDir } = require(path.join(__dirname, '../Musicmodules/music-folders.js'));
const { createLibraryWatch } = require(path.join(__dirname, '../modules/musicLibraryWatch.js'));

test('underDir is case-insensitive and does not match name prefixes', () => {
    assert.equal(underDir('D:\\Music\\a.flac', 'd:/music'), true);
    assert.equal(underDir('D:\\Music2\\a.flac', 'D:\\Music'), false);
});

test('folderRows counts remembered folders and merges the rest by parent', () => {
    const t = (p) => ({ path: p });
    const rows = folderRows([{ path: 'D:\\Music', exists: true }, { path: 'E:\\Gone', exists: false }], [
        t('D:\\Music\\A\\1.flac'), t('D:\\Music\\B\\2.flac'),
        t('F:\\Down\\Aki\\x.flac'), t('F:\\Down\\Aki\\y.flac'), t('F:\\Down\\Ren\\z.flac'), t('F:\\Down\\w.flac'),
        t('G:\\One\\q.flac'),
        t('https://dav/x.flac')
    ]);
    assert.deepEqual(rows, [
        { path: 'D:\\Music', count: 2, remembered: true, exists: true },
        { path: 'E:\\Gone', count: 0, remembered: true, exists: false },
        { path: 'F:\\Down', count: 4, remembered: false, exists: true },
        { path: 'G:\\One', count: 1, remembered: false, exists: true }
    ]);
});

test('forgetFolder drops the folder and its subfolders from the remembered list', async () => {
    let saved = ['D:\\Music', 'D:\\Music\\Sub', 'E:\\Other'];
    const w = createLibraryWatch({ scan: async () => ({ tracks: [] }), readKnown: async () => [], readFolders: async () => saved, writeFolders: async (l) => { saved = l; }, send: () => {} });
    assert.equal(await w.forgetFolder('d:\\music'), true);
    assert.deepEqual(saved, ['E:\\Other']);
    assert.deepEqual(await w.folders(), ['E:\\Other']);
    assert.equal(await w.forgetFolder('X:\\none'), false);
});

test('folderRows stays fast with tens of thousands of tracks in thousands of scattered folders', () => {
    const tracks = [];
    for (let i = 0; i < 30000; i++) tracks.push({ path: `F:\\Dump${i % 3000}\\x${i}.mp3` });
    for (let i = 0; i < 200; i++) tracks.push({ path: `https://dav/x${i}.flac`, isRemote: true });
    const t0 = Date.now();
    const rows = folderRows([{ path: 'D:\\Music' }], tracks);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
    assert.equal(rows.length, 3001);
    assert.equal(rows.slice(1).reduce((n, r) => n + r.count, 0), 30000);
});

test('folderRows: mixed slashes, odd characters, nested remembered folders, empty library', () => {
    assert.deepEqual(folderRows([], []), []);
    assert.deepEqual(folderRows(null, null), []);
    const rows = folderRows([{ path: 'D:/Music/' }, { path: 'D:\\Music\\Live' }], [
        { path: 'd:\\music\\Live\\a #1 100%.flac' }, { path: 'D:/Music/歌手😀/b.flac' }, { path: 'E:\\[OST] 名前\\c.flac' }
    ]);
    assert.deepEqual(rows.map((r) => [r.path, r.count]), [['D:/Music/', 2], ['D:\\Music\\Live', 0], ['E:\\[OST] 名前', 1]]);
});

test('removing an "other location" does not touch the sync list, and undo puts the same tracks back', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<body></body>');
    const g = globalThis;
    const MOD = path.join(__dirname, '../Musicmodules/music-folders.js');
    g.window = dom.window; g.document = dom.window.document;
    const toasts = [];
    dom.window.MusicToast = { show: (t) => toasts.push(t) };
    dom.window.MusicDialog = { confirm: async () => true };
    delete require.cache[MOD];
    const { setupMusicFolders } = require(MOD);
    const calls = [];
    const a = { path: 'F:\\Down\\a.flac' }, b = { path: 'F:\\Down\\b.flac' }, keep = { path: 'D:\\M\\k.flac' };
    let saves = 0;
    const app = {
        playlist: [keep, a, b], currentTrackIndex: 0,
        saveLibrary: async () => { saves++; },
        api: { musicLibraryFolders: async (p) => { calls.push(p.op); return p.op === 'list' ? { ok: true, folders: [] } : { ok: true }; } }
    };
    setupMusicFolders(app);
    app.openLibraryFolders();
    await new Promise((r) => setTimeout(r, 20));
    const row = [...document.querySelectorAll('.mfold-row')].find((li) => li.textContent.includes('F:\\Down'));
    assert.match(row.textContent, /2 首 · 其他位置/);
    row.querySelector('.mfold-remove').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(app.playlist, [keep]);
    assert.ok(!calls.includes('forget'));
    assert.equal(toasts.filter((t) => t.kind === 'error').length, 0);
    await toasts.at(-1).action.run();
    assert.deepEqual(app.playlist, [keep, a, b]);
    await toasts.at(-1).action.run(); // 连点两次不会放回两份
    assert.equal(app.playlist.length, 3);
    assert.ok(saves >= 2);
    delete g.window; delete g.document;
});

test('an open folders dialog refreshes counts when the library changes underneath it', async () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<body></body>');
    const g = globalThis;
    const MOD = path.join(__dirname, '../Musicmodules/music-folders.js');
    g.window = dom.window; g.document = dom.window.document;
    delete require.cache[MOD];
    const { setupMusicFolders } = require(MOD);
    const app = { playlist: [{ path: 'D:\\M\\a.flac' }], api: { musicLibraryFolders: async (p) => (p.op === 'list' ? { ok: true, folders: [{ path: 'D:\\M', exists: true }] } : { ok: true }) } };
    setupMusicFolders(app);
    app.openLibraryFolders();
    await new Promise((r) => setTimeout(r, 30));
    assert.match(document.querySelector('.mfold-meta').textContent, /^1 首/);
    app.playlist = app.playlist.concat([{ path: 'D:\\M\\b.flac' }, { path: 'D:\\M\\c.flac' }]);
    await new Promise((r) => setTimeout(r, 1700));
    assert.match(document.querySelector('.mfold-meta').textContent, /^3 首/);
    delete g.window; delete g.document;
});
