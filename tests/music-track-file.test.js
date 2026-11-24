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

test('describeTrack lists what is known and skips the rest', () => {
    const { describeTrack } = require(path.join(__dirname, '../Musicmodules/music-track-file.js'));
    const rows = describeTrack({ path: 'C:\\M\\a.flac', artist: 'Aki', codec: 'FLAC', lossless: true, sampleRate: 96000, bitsPerSample: 24, numberOfChannels: 2, bitrate: 2950000, duration: 245.4, size: 90 * 1024 * 1024, mtimeMs: new Date(2026, 10, 3).getTime() },
        { plays: 3, skips: 1, last: new Date(2026, 10, 20).getTime() });
    assert.deepEqual(rows, [
        ['歌手', 'Aki'], ['格式', 'FLAC · 无损'], ['规格', '96 kHz · 24 bit · 立体声 · 2950 kbps'], ['时长', '4:05'],
        ['大小', '90.0 MB'], ['改动时间', '2026-11-03'], ['听过', '3 次 · 上次 2026-11-20 · 跳过 1 次'], ['位置', 'C:\\M\\a.flac']
    ]);
    const old = describeTrack({ path: 'C:\\M\\b.mp3', codec: 'MPEG 1 Layer 3', sampleRate: 44100 }, null);
    assert.deepEqual(old, [['格式', 'MP3 · MPEG 1 Layer 3'], ['规格', '44.1 kHz'], ['听过', '还没听过'], ['位置', 'C:\\M\\b.mp3']]);
});
