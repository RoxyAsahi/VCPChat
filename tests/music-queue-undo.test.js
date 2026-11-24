const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 清空待播队列可以撤销。
const { setupMusicQueueUndo, restoredQueue } = require(path.join(__dirname, '../Musicmodules/music-queue-undo.js'));

test('restoredQueue puts the old queue back, keeps songs added since, drops songs gone from the library', () => {
    const a = {}, b = {}, c = {}, d = {};
    assert.deepEqual(restoredQueue([a, b, c], [d, b], [a, b, d]), [a, b, d]);
    assert.deepEqual(restoredQueue([], [], []), []);
});

test('clearing two or more songs offers undo; one song does not', () => {
    const toasts = [];
    globalThis.MusicToast = { show: (t) => toasts.push(t) };
    const a = { path: 'a' }, b = { path: 'b' };
    let refreshed = 0;
    const app = { playlist: [a, b], manualQueue: [a, b], refreshPreload: () => { refreshed++; } };
    app.queueClear = () => { app.manualQueue = []; };
    setupMusicQueueUndo(app);
    setupMusicQueueUndo(app); // 装两次不会套两层
    app.queueClear();
    assert.deepEqual(app.manualQueue, []);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].message, /2 首/);
    toasts[0].action.run();
    assert.deepEqual(app.manualQueue, [a, b]);
    assert.equal(refreshed, 1);
    app.manualQueue = [a];
    app.queueClear();
    assert.equal(toasts.length, 1);
    delete globalThis.MusicToast;
});
