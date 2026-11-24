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

test('adversarial: UTF-16 both byte orders, odd characters in paths, empty and comment-only files', () => {
    const body = '#EXTM3U\r\nD:\\音乐\\a #1 100%.flac\r\nD:\\😀\\b.flac\r\n';
    const le = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(body, 'utf16le')]);
    const be = Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(body, 'utf16le').swap16()]);
    assert.equal(decodeM3u(le, 'x.m3u'), body);
    assert.equal(decodeM3u(be, 'x.m3u'), body);
    const r = parseM3u(decodeM3u(be, 'x.m3u'), { platform: 'win32' });
    assert.deepEqual(r.entries.map((e) => e.path), ['D:\\音乐\\a #1 100%.flac', 'D:\\😀\\b.flac']);
    assert.deepEqual(parseM3u('', { platform: 'win32' }), { name: '', entries: [], skipped: 0 });
    assert.deepEqual(parseM3u('#EXTM3U\n#EXTINF:-1,x\n', { platform: 'win32' }).entries, []);
    assert.equal(parseM3u('file:///D:/bad%zz.flac', { platform: 'win32' }).skipped, 1);
    // 导出再导入，怪字符原样回来
    const back = parseM3u(buildM3u('名#字', [{ path: 'D:\\😀\\b.flac', title: 'a,b', artist: '' }]), { platform: 'win32' });
    assert.deepEqual(back.entries.map((e) => [e.path, e.title]), [['D:\\😀\\b.flac', 'a,b']]);
});

test('adversarial: import with every entry missing, or an empty list, creates nothing and says why', async () => {
    const toasts = [];
    globalThis.MusicToast = { show: (t) => toasts.push(t) };
    let res = { ok: true, name: '旧电脑', skipped: 2, entries: [{ path: 'Z:\\a.flac', exists: false }] };
    const app = { playlist: [], customPlaylists: [], api: { importMusicM3u: async () => res, exportMusicM3u: async () => ({ ok: true }) } };
    setupMusicM3u(app);
    assert.equal(await app.m3u.importFile(), null);
    assert.match(toasts.at(-1).message, /3 首在这台电脑上都找不到/);
    res = { ok: true, name: '空', skipped: 0, entries: [] };
    assert.equal(await app.m3u.importFile(), null);
    assert.match(toasts.at(-1).message, /是空的/);
    res = { ok: false, canceled: true };
    const n = toasts.length;
    assert.equal(await app.m3u.importFile(), null);
    assert.equal(toasts.length, n); // 取消选择文件不弹提示
    assert.equal(app.customPlaylists.length, 0);
    // 只有云端歌的歌单：导出给出说明，不弹保存框
    let asked = false;
    app.api.exportMusicM3u = async () => { asked = true; return { ok: true }; };
    assert.equal(await app.m3u.exportPlaylist({ name: '云', tracks: ['https://dav/a.flac'] }), null);
    assert.equal(asked, false);
    assert.match(toasts.at(-1).message, /没有本机的歌/);
    delete globalThis.MusicToast;
});

test('after export the toast offers to show the file in its folder', async () => {
    const toasts = [];
    globalThis.MusicToast = { show: (t) => toasts.push(t) };
    let shown = null;
    const app = {
        playlist: [{ path: 'C:\\M\\a.flac' }],
        customPlaylists: [],
        api: { importMusicM3u: async () => ({ ok: false }), exportMusicM3u: async () => ({ ok: true, file: 'C:\\out.m3u8' }), showMusicInFolder: async (p) => { shown = p; return { ok: true }; } }
    };
    setupMusicM3u(app);
    await app.m3u.exportPlaylist({ name: 'x', tracks: ['C:\\M\\a.flac'] });
    assert.equal(toasts.at(-1).action.label, '在文件夹中显示');
    toasts.at(-1).action.run();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(shown, { path: 'C:\\out.m3u8' });
    delete globalThis.MusicToast;
});

test('dropping files the library cannot take says so; folders with dots in their names are not counted', () => {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<body></body>');
    const g = globalThis;
    const MOD = path.join(__dirname, '../Musicmodules/music-m3u.js');
    g.window = dom.window; g.document = dom.window.document;
    const toasts = [];
    dom.window.MusicToast = { show: (t) => toasts.push(t) };
    delete require.cache[MOD];
    const { setupMusicM3u: setup } = require(MOD);
    const app = { playlist: [], customPlaylists: [], api: { importMusicM3u: async () => ({ ok: false }), exportMusicM3u: async () => ({ ok: true }), getPathForFile: () => '' } };
    setup(app);
    const drop = (entries) => {
        const ev = new dom.window.Event('drop', { bubbles: true });
        const items = entries.map(([name, dir]) => ({ webkitGetAsEntry: () => ({ isDirectory: dir }), getAsFile: () => ({ name }) }));
        ev.dataTransfer = { types: ['Files'], items, files: entries.filter(([, d]) => !d).map(([name]) => ({ name })) };
        document.dispatchEvent(ev);
    };
    drop([['a.ape', false], ['b.wma', false]]);
    assert.match(toasts.at(-1).message, /2 个文件曲库收不了（APE、WMA）/);
    assert.equal(toasts.at(-1).kind, 'error');
    drop([['a.flac', false], ['c.zip', false]]);
    assert.match(toasts.at(-1).message, /有 1 个文件曲库收不了（ZIP），跳过了/);
    const n = toasts.length;
    drop([['Vol.1', true], ['x.mp3', false], ['cover', false]]);
    assert.equal(toasts.length, n);
    drop([['Vol.1', true], ['notes.txt', false]]);
    assert.match(toasts.at(-1).message, /跳过了/); // 有文件夹在加，不算全部失败
    delete g.window; delete g.document;
});
