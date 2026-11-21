// 曲库文件夹：记住、推断、同步、盯着文件夹变化；拔掉的盘不当成删歌。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createLibraryFolders, inferRoots } = require('../modules/ipc/musicLibraryFolders.js');
const { summary } = require('../Musicmodules/music-library-sync.js');

test('从现有曲库推出音乐根目录：每个盘取最深公共上级，盘符根不要', () => {
    assert.deepStrictEqual(inferRoots([
        'D:\\Music\\Aki\\Low Tide\\01.flac',
        'D:\\Music\\周杰伦\\叶惠美\\02.flac',
        'E:\\a.mp3',
        'https://dav.example/x.flac',
        'relative/x.mp3'
    ]), ['D:\\Music']);
    assert.deepStrictEqual(inferRoots(['/home/u/Music/a/1.mp3', '/home/u/Music/b/2.mp3']), ['/home/u/Music']);
    assert.deepStrictEqual(inferRoots([]), []);
    // 歌散在用户目录下好几处：推出来的是用户目录本身，不要
    assert.deepStrictEqual(inferRoots(['C:\\Users\\me\\Music\\a.mp3', 'C:\\Users\\me\\Downloads\\b.mp3'], 'C:\\Users\\me'), []);
    assert.deepStrictEqual(inferRoots(['C:\\Users\\me\\Music\\x\\a.mp3', 'C:\\Users\\me\\Music\\y\\b.mp3'], 'C:\\Users\\me'), ['C:\\Users\\me\\Music']);
});

function harness({ playlist = [], stateFile } = {}) {
    const handles = new Map();
    const ipcMain = { handle: (n, f) => handles.set(n, f), on() {} };
    const sent = [];
    const music = { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } };
    let musicWin = music;
    const scans = [];
    const watched = [];
    const watch = (p, opts, cb) => { const w = new EventEmitter(); w.close = () => { w.closed = true; }; w.path = p; w.cb = cb; watched.push(w); return w; };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-'));
    const lf = createLibraryFolders({
        ipcMain,
        getMusicWindow: () => musicWin,
        stateFile: stateFile || path.join(dir, 'music-library-folders.json'),
        readPlaylist: async () => playlist,
        scan: async (folderPath) => { scans.push(folderPath); return { tracks: [{ path: path.join(folderPath, 'x.flac') }], aborted: false }; },
        watch
    });
    return { lf, handles, sent, music, scans, watched, dir, closeMusic: () => { musicWin = null; } };
}

test('记住文件夹：子文件夹不重复记，父文件夹替换子文件夹；记录写盘', async () => {
    const h = harness();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    assert.strictEqual(await h.lf.remember(sub), true);
    assert.strictEqual(await h.lf.remember(path.join(sub, 'deeper')), false);
    assert.strictEqual(await h.lf.remember(root), true);
    const list = await h.lf.list();
    assert.deepStrictEqual(list.map((f) => f.path), [root]);
    assert.strictEqual(list[0].online, true);
    assert.strictEqual(await h.lf.remember('relative/path'), false);
});

test('打开播放器后对每个在线文件夹同步一次并开始盯；不在的文件夹跳过', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), 'f.json');
    fs.writeFileSync(stateFile, JSON.stringify([{ path: root, addedAt: 1 }, { path: path.join(root, '..', 'not-here-' + Date.now()), addedAt: 2 }]));
    const h = harness({ stateFile });
    await h.lf.syncAll('manual');
    assert.deepStrictEqual(h.scans, [root]);
    const syncs = h.sent.filter((s) => s[0] === 'music-library-sync');
    assert.strictEqual(syncs.length, 1);
    assert.strictEqual(syncs[0][1].folderPath, root);
    assert.strictEqual(syncs[0][1].reason, 'manual');

    await h.lf.musicReady();
    assert.strictEqual(h.watched.length, 2);
    h.lf.musicClosed();
    assert.ok(h.watched.every((w) => w.closed));
});

test('文件夹里有音频文件变动才重新同步，封面歌词之类不管', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), 'f.json');
    fs.writeFileSync(stateFile, JSON.stringify([{ path: root, addedAt: 1 }]));
    const h = harness({ stateFile });
    await h.lf.musicReady();
    const w = h.watched[0];
    w.cb('rename', 'cover.jpg');
    t.mock.timers.tick(5000);
    w.cb('rename', path.join('Aki', 'new.flac'));
    w.cb('change', path.join('Aki', 'new.flac'));
    t.mock.timers.tick(5000);
    t.mock.timers.reset();
    await new Promise((r) => setImmediate(r));
    await h.lf.syncAll('noop').catch(() => {});
    // 一次来自文件变动（攒在一起），一次是上面手动的；cover.jpg 没有触发
    assert.strictEqual(h.scans.filter((p) => p === root).length >= 1, true);
    const reasons = h.sent.filter((s) => s[0] === 'music-library-sync').map((s) => s[1].reason);
    assert.strictEqual(reasons.filter((r) => r === 'watch').length, 1);
});

test('第一次用：按曲库推出根目录记下来', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
    const h = harness({ playlist: [{ path: path.join(root, 'a', '1.flac') }, { path: path.join(root, 'b', '2.flac') }] });
    const list = await h.lf.list();
    assert.deepStrictEqual(list.map((f) => f.path), [root]);
    assert.strictEqual(list[0].inferred, true);
});

test('只有音乐窗口能移除或手动同步', async () => {
    const h = harness();
    await assert.rejects(() => h.handles.get('music-library-folders-remove')({ sender: {} }, 'x'));
    await assert.rejects(() => h.handles.get('music-library-folders-sync')({ sender: {} }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
    await h.lf.remember(root);
    const out = await h.handles.get('music-library-folders-remove')({ sender: h.music.webContents }, root);
    assert.deepStrictEqual(out, []);
});

test('提示文案', () => {
    assert.strictEqual(summary({ added: 3, removed: 1 }), '曲库已和文件夹同步：新增 3 首 · 移除 1 首');
    assert.strictEqual(summary({ updated: 2 }), '曲库已和文件夹同步：更新了 2 首的信息');
    assert.strictEqual(summary({}), '');
    assert.strictEqual(summary({}, true), '曲库已是最新，文件夹里没有变化');
});
