const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 右键「在文件夹中显示」：本机文件交给主进程，云端的歌直接提示。
const { setupMusicTrackFile, isLocal } = require(path.join(__dirname, '../Musicmodules/music-track-file.js'));

test('isLocal tells local paths from cloud URLs', () => {
    assert.equal(isLocal('C:\\Music\\a.flac'), true);
    assert.equal(isLocal('/home/a.flac'), true);
    assert.equal(isLocal('https://dav.example/a.flac'), false);
    assert.equal(isLocal(''), false);
});

test('showTrackInFolder sends local paths and reports failures', async () => {
    const toasts = [];
    globalThis.MusicToast = { show: (t) => toasts.push(t.message) };
    const sent = [];
    const app = {
        playlist: [{ path: 'C:\\M\\a.flac' }, { path: 'https://dav/x.flac' }, { path: 'C:\\M\\gone.flac' }],
        api: { showMusicInFolder: async (p) => { sent.push(p.path); return p.path.includes('gone') ? { ok: false, message: '文件已经不在原来的位置了' } : { ok: true }; } }
    };
    setupMusicTrackFile(app);
    assert.equal(await app.showTrackInFolder(0), true);
    assert.equal(await app.showTrackInFolder(1), false);
    assert.equal(await app.showTrackInFolder(2), false);
    assert.deepEqual(sent, ['C:\\M\\a.flac', 'C:\\M\\gone.flac']);
    assert.deepEqual(toasts, ['云端的歌没有本机文件', '文件已经不在原来的位置了']);
    delete globalThis.MusicToast;
});
