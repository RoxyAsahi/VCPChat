const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// 任务栏缩略图按钮：只在 Windows 设；播放状态变了才换中间按钮；点按钮发 music-control。
const { createMusicThumbar } = require(path.join(__dirname, '../modules/musicThumbar.js'));

function fakeWindow() {
    const sent = [];
    const calls = [];
    return {
        id: 7, sent, calls,
        isDestroyed: () => false,
        setThumbarButtons: (b) => { calls.push(b); return true; },
        webContents: { send: (ch, cmd) => sent.push([ch, cmd]) }
    };
}
const nativeImage = { createFromPath: (p) => ({ p }) };

test('sets prev / play-pause / next and swaps the middle button with the play state', () => {
    const t = createMusicThumbar({ nativeImage, platform: 'win32' });
    const win = fakeWindow();
    assert.equal(t.update(win, { playing: false }), true);
    assert.deepEqual(win.calls[0].map((b) => b.tooltip), ['上一首', '播放', '下一首']);
    assert.equal(t.update(win, { playing: false }), false, 'same state: nothing to redo');
    assert.equal(t.update(win, { playing: true }), true);
    assert.equal(win.calls[1][1].tooltip, '暂停');
    assert.equal(t.update(win, { playing: true, force: true }), true, 'force after show');
    win.calls[1].forEach((b) => b.click());
    assert.deepEqual(win.sent, [['music-control', 'previous'], ['music-control', 'pause'], ['music-control', 'next']]);
});

test('does nothing off Windows or on a closed window', () => {
    const win = fakeWindow();
    assert.equal(createMusicThumbar({ nativeImage, platform: 'darwin' }).update(win, { playing: true }), false);
    const t = createMusicThumbar({ nativeImage, platform: 'win32' });
    assert.equal(t.update({ ...win, isDestroyed: () => true }, { playing: true }), false);
    assert.equal(win.calls.length, 0);
});

test('icons exist at 1x and 2x', () => {
    for (const n of ['previous', 'play', 'pause', 'next']) {
        for (const s of ['', '@2x']) assert.ok(fs.existsSync(path.join(__dirname, '../assets/music-thumbar', `${n}${s}.png`)), n + s);
    }
});
