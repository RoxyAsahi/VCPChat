/* 档案页的交互（没有 WebGL 时只剩文字层，交互仍然可用）：键盘、检索、播放进舞台、经典视图。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const read = (p) => fs.readFileSync(p, 'utf8');
const SCRIPTS = ['model', 'scene', 'view'].map((n) => read(`Musicmodules/music-archive/archive-${n}.js`));

const open = [];
test.afterEach(() => { while (open.length) open.pop()(); });
function fixture({ n = 30, playlists } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="music-archive-view" hidden></div><button id="music-archive-return"></button></body>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.console.warn = () => {};
    for (const s of SCRIPTS) w.eval(s);
    const tracks = Array.from({ length: n }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i, artist: i % 2 ? 'Aki' : 'Ren', album: 'A' + (i % 3) }));
    const calls = [];
    const app = {
        playlist: tracks,
        customPlaylists: playlists || [{ id: 'p', name: '夜间散步', tracks: ['/m/5', '/m/7', '/m/9'] }],
        currentTrackIndex: 0, isPlaying: false,
        loadTrack(i) { calls.push(['load', i, this.currentFilteredTracks ? this.currentFilteredTracks.length : null]); this.currentTrackIndex = i; },
        playTrack() { calls.push(['play']); }, pauseTrack() { calls.push(['pause']); },
        renderPlaylist() {}, showContextMenu() { calls.push(['ctx', this.contextMenuTrackIndex]); },
        stageHost: { active: false, enter() { calls.push(['stage']); this.active = true; } }
    };
    const view = w.MusicArchive.init(app);
    const key = (k, extra = {}) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    const text = (ref) => w.document.querySelector(`[data-ref="${ref}"]`).textContent;
    let closed = false;
    const close = () => { if (closed) return; closed = true; view.destroy(); w.close(); };
    open.push(close);
    return { w, app, view, calls, key, text, close };
}

test('默认显示档案页，选中正在播放的那首', () => {
    const f = fixture();
    assert.equal(f.view.mode, 'archive');
    assert.equal(f.w.document.getElementById('music-archive-view').hidden, false);
    assert.ok(f.w.document.body.classList.contains('music-archive-on'));
    assert.equal(f.text('fno'), 'TRK-001');
    assert.equal(f.text('cat'), '全部曲目');
    f.close();
});

test('方向键换曲目和歌单，HUD 跟着变', () => {
    const f = fixture();
    f.key('ArrowDown'); f.key('ArrowDown');
    assert.equal(f.text('fno'), 'TRK-003');
    assert.equal(f.text('ftitle'), 'Song 2');
    f.key('ArrowRight');
    assert.equal(f.text('cat'), '夜间散步');
    assert.equal(f.text('selT'), '03');
    assert.equal(f.view.debug().selected, 9); // 换列保持行号
    f.key('ArrowUp'); f.key('ArrowUp'); f.key('ArrowUp'); // 越过第一首，循环到这一列最后一首
    assert.equal(f.view.debug().selected, 9);
    f.close();
});

test('回车播放选中曲目：队列换成这一列，并进入播放页', () => {
    const f = fixture();
    f.key('ArrowRight'); f.key('ArrowDown');
    f.key('Enter');
    assert.deepEqual(f.calls.filter((c) => c[0] !== 'ctx'), [['load', 7, 3], ['stage']]);
    assert.equal(f.app.filteredPlaylistSource.type, 'playlist');
    f.close();
});

test('已经在放的那首再按回车只进播放页，不重新加载', () => {
    const f = fixture();
    f.app.isPlaying = true;
    f.key('Enter');
    assert.deepEqual(f.calls, [['stage']]);
    f.close();
});

test('「/」打开检索，结果成为第一列，Esc 关掉后回到原来的列', () => {
    const f = fixture();
    f.key('ArrowRight');
    f.key('/');
    const input = f.w.document.querySelector('[data-ref="searchInput"]');
    assert.equal(f.w.document.activeElement, input);
    input.value = 'Song 1';
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(f.text('cat'), '检索：Song 1');
    assert.equal(f.view.debug().columns[0].id, 'search');
    assert.equal(f.view.debug().columns[0].n, 11); // Song 1, 10..19
    f.key('Escape');
    assert.equal(f.view.debug().columns[0].id, 'all');
    f.close();
});

test('输入框里打字不触发档案页快捷键', () => {
    const f = fixture();
    f.key('/');
    const input = f.w.document.querySelector('[data-ref="searchInput"]');
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    assert.deepEqual(f.calls, []);
    f.close();
});

test('空格切换播放暂停；Home 回到正在播放', () => {
    const f = fixture();
    f.key(' ', { code: 'Space' });
    assert.deepEqual(f.calls, [['play']]);
    f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown');
    f.key('Home');
    assert.equal(f.view.debug().selected, 0);
    f.close();
});

test('经典视图隐藏档案页并记住；返回按钮回来', () => {
    const f = fixture();
    f.w.document.querySelector('[data-act="classic"]').click();
    assert.equal(f.view.mode, 'classic');
    assert.ok(f.w.document.body.classList.contains('music-archive-off'));
    assert.equal(f.w.localStorage.getItem('musicArchiveView'), 'classic');
    f.key('ArrowDown');
    assert.equal(f.text('fno'), 'TRK-001'); // 经典视图里方向键不归档案页
    f.w.document.getElementById('music-archive-return').click();
    assert.equal(f.view.mode, 'archive');
    f.close();
});

test('空曲库显示空状态，回车什么也不做', () => {
    const f = fixture({ n: 0, playlists: [] });
    assert.ok(f.w.document.getElementById('music-archive-view').classList.contains('is-empty'));
    f.key('Enter');
    assert.deepEqual(f.calls, []);
    f.close();
});
