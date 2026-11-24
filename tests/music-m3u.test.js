const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 歌单 .m3u / .m3u8 读写，以及导入时怎么对上曲库。
const { parseM3u, buildM3u, decodeM3u, safeFileName } = require(path.join(__dirname, '../modules/ipc/musicM3u.js'));
const { matchEntries, uniqueName, setupMusicM3u } = require(path.join(__dirname, '../Musicmodules/music-m3u.js'));

test('parses EXTINF, relative paths, file URLs and skips network entries (Windows)', () => {
    const text = [
        '#EXTM3U',
        '#PLAYLIST:夜里听',
        '#EXTINF:241,歌手 - 标题',
        'sub\\a.flac',
        '../b.mp3',
        'file:///D:/Music/c%20d.flac',
        'http://example.com/stream.mp3',
        'E:/Other/e.flac',
        ''
    ].join('\r\n');
    const r = parseM3u(text, { baseDir: 'C:\\Lists', platform: 'win32' });
    assert.equal(r.name, '夜里听');
    assert.equal(r.skipped, 1);
    assert.deepEqual(r.entries.map((e) => e.path), ['C:\\Lists\\sub\\a.flac', 'C:\\b.mp3', 'D:\\Music\\c d.flac', 'E:\\Other\\e.flac']);
    assert.equal(r.entries[0].title, '歌手 - 标题');
    assert.equal(r.entries[0].duration, 241);
    assert.equal(r.entries[1].title, '');
});

test('posix paths and UNC file URLs', () => {
    const r = parseM3u('/music/a.flac\nrel/b.flac\n', { baseDir: '/lists', platform: 'linux' });
    assert.deepEqual(r.entries.map((e) => e.path), ['/music/a.flac', '/lists/rel/b.flac']);
    const w = parseM3u('file://nas/share/x.flac', { platform: 'win32' });
    assert.equal(w.entries[0].path, '\\\\nas\\share\\x.flac');
});

test('round trip through buildM3u keeps paths, names and durations', () => {
    const out = buildM3u('我的\n歌单', [
        { path: 'C:\\M\\a.flac', title: 'A', artist: 'X', duration: 200.4 },
        { path: 'C:\\M\\b.flac' }
    ]);
    assert.ok(out.startsWith('#EXTM3U\r\n#PLAYLIST:我的 歌单\r\n#EXTINF:200,X - A\r\nC:\\M\\a.flac\r\n'));
    const back = parseM3u(out, { platform: 'win32' });
    assert.equal(back.name, '我的 歌单');
    assert.deepEqual(back.entries.map((e) => e.path), ['C:\\M\\a.flac', 'C:\\M\\b.flac']);
});

test('decodes GBK .m3u, UTF-8 with BOM and plain UTF-8', () => {
    const iconv = require('iconv-lite');
    assert.equal(decodeM3u(iconv.encode('C:\\音乐\\歌.flac', 'gbk'), 'a.m3u'), 'C:\\音乐\\歌.flac');
    assert.equal(decodeM3u(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('歌')]), 'a.m3u'), '歌');
    assert.equal(decodeM3u(Buffer.from('歌'), 'a.m3u'), '歌');
    assert.equal(safeFileName('a/b:c?'), 'a_b_c_');
    assert.equal(safeFileName('  '), '歌单');
});

test('matchEntries maps to library paths case-insensitively, queues new files, counts missing', () => {
    const lib = [{ path: 'C:\\Music\\A.flac' }, { path: 'C:\\Music\\b.flac' }];
    const r = matchEntries([
        { path: 'c:\\music\\a.flac', exists: true },
        { path: 'C:/Music/b.flac', exists: true },
        { path: 'C:\\Music\\A.FLAC', exists: true },
        { path: 'C:\\New\\c.flac', exists: true },
        { path: 'C:\\Gone\\d.flac', exists: false }
    ], lib);
    assert.deepEqual(r.paths, ['C:\\Music\\A.flac', 'C:\\Music\\b.flac', 'C:\\New\\c.flac']);
    assert.deepEqual(r.toAdd, ['C:\\New\\c.flac']);
    assert.equal(r.missing, 1);
});

test('uniqueName avoids clashing with existing playlists', () => {
    assert.equal(uniqueName('夜里', [{ name: '夜里' }, { name: '夜里 (2)' }]), '夜里 (3)');
    assert.equal(uniqueName('', []), '导入的歌单');
});

test('import creates a playlist, adds new files to the library, and undo removes it', async () => {
    const toasts = [];
    globalThis.MusicToast = { show: (t) => toasts.push(t) };
    const added = [];
    let saved = 0;
    const app = {
        playlist: [{ path: 'C:\\M\\a.flac' }],
        customPlaylists: [{ id: '1', name: '夜里', tracks: [] }],
        saveCustomPlaylists: () => { saved++; },
        api: {
            importMusicM3u: async () => ({ ok: true, name: '夜里', skipped: 1, entries: [{ path: 'c:\\m\\A.flac', exists: true }, { path: 'C:\\N\\b.flac', exists: true }, { path: 'C:\\X\\z.flac', exists: false }] }),
            exportMusicM3u: async () => ({ ok: true }),
            addMusicPaths: (p) => { added.push(...p); return Promise.resolve(); }
        }
    };
    setupMusicM3u(app);
    const pl = await app.m3u.importFile();
    assert.equal(pl.name, '夜里 (2)');
    assert.deepEqual(pl.tracks, ['C:\\M\\a.flac', 'C:\\N\\b.flac']);
    assert.deepEqual(added, ['C:\\N\\b.flac']);
    assert.match(toasts.at(-1).message, /2 首.*1 首原来不在曲库里.*2 首找不到文件/);
    toasts.at(-1).action.run();
    assert.equal(app.customPlaylists.length, 1);
    assert.ok(saved >= 2);
    delete globalThis.MusicToast;
});

test('export skips cloud tracks and sends titles; palette lists one export per non-empty playlist', async () => {
    let sent = null;
    const app = {
        playlist: [{ path: 'C:\\M\\a.flac', title: 'A', artist: 'X', duration: 100 }],
        customPlaylists: [{ id: '1', name: '夜里', tracks: ['C:\\M\\a.flac', 'https://dav/x.flac'] }, { id: '2', name: '空', tracks: [] }],
        api: { importMusicM3u: async () => ({ ok: false }), exportMusicM3u: async (p) => { sent = p; return { ok: true, file: 'C:\\out.m3u8' }; } }
    };
    setupMusicM3u(app);
    assert.equal(await app.m3u.exportPlaylist(app.customPlaylists[0]), 'C:\\out.m3u8');
    assert.deepEqual(sent, { name: '夜里', tracks: [{ path: 'C:\\M\\a.flac', title: 'A', artist: 'X', duration: 100 }] });
    assert.deepEqual(app.m3u.commands().map((c) => c.id), ['m3u-import', 'm3u-export:1']);
});
