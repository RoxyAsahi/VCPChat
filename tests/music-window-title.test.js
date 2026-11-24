const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// 窗口标题跟着歌走（任务栏、Alt+Tab 里能看到在放什么）。
const MOD = path.join(__dirname, '../Musicmodules/music-window-title.js');

test('windowTitle: title - artist, placeholders fall back, long names are cut', () => {
    const { windowTitle } = require(MOD);
    assert.equal(windowTitle('晴天', '周杰伦'), '晴天 - 周杰伦');
    assert.equal(windowTitle('晴天', '未知艺术家'), '晴天');
    assert.equal(windowTitle('未选择歌曲', '未知艺术家'), '音乐播放器');
    assert.equal(windowTitle('  a \n b ', ''), 'a b');
    assert.equal(windowTitle('x'.repeat(300), 'y').length, 120);
});

test('follows the now-playing text nodes', async () => {
    const dom = new JSDOM('<span id="t">未选择歌曲</span><span id="a">未知艺术家</span>');
    const g = globalThis;
    g.window = dom.window; g.document = dom.window.document; g.MutationObserver = dom.window.MutationObserver;
    delete require.cache[MOD];
    const { setupMusicWindowTitle } = require(MOD);
    const app = { trackTitle: document.getElementById('t'), trackArtist: document.getElementById('a') };
    setupMusicWindowTitle(app);
    assert.equal(document.title, '音乐播放器');
    app.trackTitle.textContent = 'Song';
    app.trackArtist.textContent = 'Band';
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(document.title, 'Song - Band');
    app.windowTitleWatch.stop();
    assert.equal(document.title, '音乐播放器');
    delete g.window; delete g.document; delete g.MutationObserver;
});
