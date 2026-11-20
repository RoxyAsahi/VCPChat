/* 档案页的交互（没有 WebGL 时只剩文字层，交互仍然可用）：键盘、目录与检索、播放进舞台、经典视图。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const read = (p) => fs.readFileSync(p, 'utf8');
const SCRIPTS = ['model', 'scene', 'index', 'list', 'lyrics', 'view'].map((n) => read(`Musicmodules/music-archive/archive-${n}.js`));

const open = [];
test.afterEach(() => { while (open.length) open.pop()(); });
function fixture({ n = 30, playlists, tracks: given, setup } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="music-archive-view" hidden></div><button id="music-archive-return"></button></body>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.console.warn = () => {};
    for (const s of SCRIPTS) w.eval(s);
    const tracks = given || Array.from({ length: n }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i, artist: i % 2 ? 'Aki' : 'Ren', album: 'A' + (i % 3) }));
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
    if (setup) setup(w, app);
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

const listEl = (f, name) => f.w.document.querySelector(`.archive-list [data-l="${name}"]`);
const listKey = (f, target, k, extra = {}) => target.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

test('「/」打开目录并聚焦检索框；输入即筛，第一条自动选中，阵列跟过去', () => {
    const f = fixture();
    f.view.setListOpen(false);
    f.key('/');
    const input = listEl(f, 'input');
    assert.equal(f.w.document.activeElement, input);
    assert.ok(f.w.document.querySelector('.archive-hud').classList.contains('list-open'));
    input.value = 'Song 1';
    listKey(f, input, 'Shift'); // 任意按键都会先把输入框里的词刷进去
    assert.equal(f.view.list.count, 17); // 每个词都要命中：Song 1、10–19，以及专辑 A1 里的
    assert.equal(f.view.debug().selected, 1);
    listKey(f, input, 'ArrowDown');
    assert.equal(f.view.debug().selected, 10);
    assert.equal(f.text('ftitle'), 'Song 10');
    f.close();
});

test('目录里回车只播放不进播放页；→ 进播放页；Esc 先清空再离开', () => {
    const f = fixture();
    f.view.setListOpen(true);
    f.view.list.focusSearch();
    const input = listEl(f, 'input');
    input.value = 'Song 7';
    listKey(f, input, 'Enter');
    assert.deepEqual(f.calls, [['load', 7, 3]]); // 从检索结果点播：队列就是这 3 条结果
    assert.equal(f.app.filteredPlaylistSource.name, '检索结果');
    assert.equal(f.text('queue'), '检索结果');
    f.calls.length = 0;
    f.app.isPlaying = true;
    input.setSelectionRange(input.value.length, input.value.length);
    listKey(f, input, 'ArrowRight');
    assert.deepEqual(f.calls, [['stage']]); // 已经在放这首了，只进播放页
    listKey(f, input, 'Escape');
    assert.equal(input.value, '');
    assert.equal(f.view.list.count, 30);
    listKey(f, input, 'Escape');
    assert.notEqual(f.w.document.activeElement, input);
    f.close();
});

test('LIST 按钮开关目录并记住；阵列里换选中，目录高亮跟着走', () => {
    const f = fixture();
    f.view.setListOpen(false);
    const btn = f.w.document.querySelector('[data-act="list"]');
    btn.click();
    assert.ok(!f.view.list.el.hidden);
    assert.equal(f.w.localStorage.getItem('musicArchiveList'), '1');
    f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown');
    const on = f.view.list.el.querySelector('.archive-list-row.on');
    assert.ok(on);
    assert.match(on.textContent, /Song 3/);
    btn.click();
    assert.ok(f.view.list.el.hidden);
    assert.equal(f.w.localStorage.getItem('musicArchiveList'), '0');
    f.close();
});

test('目录单击只选中，双击播放；歌单分类里的歌在阵列里落到那一列', () => {
    const f = fixture();
    f.view.setListOpen(true);
    f.view.list.setKind('playlist');
    const rows = [...f.view.list.el.querySelectorAll('.archive-list-row')];
    assert.equal(rows.length, 3);
    rows[1].dispatchEvent(new f.w.MouseEvent('click', { bubbles: true }));
    assert.equal(f.text('cat'), '夜间散步');
    assert.equal(f.view.debug().selected, 7);
    assert.deepEqual(f.calls, []);
    rows[1].dispatchEvent(new f.w.MouseEvent('dblclick', { bubbles: true }));
    assert.deepEqual(f.calls, [['load', 7, 3]]);
    f.close();
});

test('歌手分类按名字分组；切换分类会记住', async () => {
    const f = fixture();
    f.view.setListOpen(true);
    f.view.list.setKind('artist');
    listEl(f, 'viewport').scrollTop = 0;
    f.view.list.render();
    await new Promise((r) => setTimeout(r, 60));
    const heads = [...f.view.list.el.querySelectorAll('.archive-list-group')].map((n) => n.querySelector('span').textContent);
    assert.deepEqual(heads.sort(), ['Aki', 'Ren']);
    assert.equal(f.w.localStorage.getItem('musicArchiveListKind'), 'artist');
    f.close();
});

test('没有时长就不显示时长；播放过的歌记下时长后显示', async () => {
    const f = fixture();
    f.view.setListOpen(true);
    const times = () => [...f.view.list.el.querySelectorAll('.archive-list-row .rt i')].map((n) => n.textContent).filter((t) => /:/.test(t));
    assert.deepEqual(times(), []);
    f.app.lastKnownDuration = 245.4;
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepEqual(times(), ['04:05']);
    assert.deepEqual(JSON.parse(f.w.localStorage.getItem('musicArchiveDurations')), { '/m/0': 245 });
    f.close();
});

test('输入框里打字不触发档案页快捷键', () => {
    const f = fixture();
    f.key('/');
    const input = listEl(f, 'input');
    listKey(f, input, 'l');
    listKey(f, input, ' ', { code: 'Space' });
    assert.deepEqual(f.calls, []);
    assert.ok(!f.view.list.el.hidden);
    f.close();
});

test('空格切换播放暂停；Home/End 到这一列第一首和最后一首，PageDown 走 10 首', () => {
    const f = fixture();
    f.key(' ', { code: 'Space' });
    assert.deepEqual(f.calls, [['play']]);
    f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown');
    f.key('Home');
    assert.equal(f.view.debug().selected, 0);
    f.key('End');
    assert.equal(f.view.debug().selected, 29);
    f.key('Home'); f.key('PageDown');
    assert.equal(f.view.debug().selected, 10);
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

test('空曲库显示空状态，回车什么也不做；刚打开的一小段先不说空（曲库可能还在读），曲库到了就直接是阵列', async () => {
    const f = fixture({ n: 0, playlists: [] });
    const root = f.w.document.getElementById('music-archive-view');
    const wait = (ms) => new Promise((r) => f.w.setTimeout(r, ms));
    assert.equal(root.classList.contains('is-empty'), false, '刚打开不闪空状态');
    assert.ok(root.classList.contains('is-loading'));
    assert.equal(f.text('status'), 'LOADING');
    f.key('Enter');
    assert.deepEqual(f.calls, []);
    await wait(1650);
    assert.ok(root.classList.contains('is-empty'), '等过了还是没有歌才显示');
    assert.equal(root.classList.contains('is-loading'), false);
    assert.equal(f.text('status'), 'SESSION AUTHORIZED');
    f.close();

    const g = fixture({ n: 0, playlists: [] });
    const groot = g.w.document.getElementById('music-archive-view');
    g.app.playlist = Array.from({ length: 12 }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i }));
    g.view.refresh();
    assert.equal(groot.classList.contains('is-loading'), false);
    assert.equal(groot.classList.contains('is-empty'), false);
    assert.equal(g.text('status'), 'SESSION AUTHORIZED');
    g.close();
});

test('过场期间继续画、开场动画期间不画；选中卡抬高的接口在', async () => {
    const f = fixture();
    const body = f.w.document.body.classList;
    const allowed = () => f.view.debug().allowed;
    assert.equal(typeof f.view.raise, 'function');
    assert.equal(typeof f.view.setThemeWave, 'function');
    assert.equal(allowed(), true);
    body.add('music-intro-playing');
    assert.equal(allowed(), false);
    body.remove('music-intro-playing');
    body.add('music-stage-active', 'music-stage-entering');
    await new Promise((r) => setTimeout(r, 0)); // 等 body 观察者
    assert.equal(allowed(), true);
    body.remove('music-stage-entering');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(allowed(), false);
    f.close();
});

const LIB = (() => {
    const words = ['Apple', 'Amber', 'Arc', 'Atlas', 'Blue', 'Bird', 'Bell', 'Bloom', 'Cloud', 'Coral', 'Delta', 'Echo',
        'Xeno', 'Yarn', 'Zest', 'あおぞら', 'あめ', 'いと', 'うみ', 'かぜ', '1999', '2046', '★Star'];
    return Array.from({ length: 46 }, (_, i) => ({ path: '/l/' + i, title: words[i % words.length] + ' ' + i, artist: 'A', album: 'X' + i }));
})();

test('曲库够大时全部曲目按首字母拆列，歌少的相邻字母合并', () => {
    const f = fixture({ tracks: LIB, playlists: [] });
    const ids = f.view.debug().columns.map((c) => c.id);
    assert.deepEqual([...ids], ['letter:A', 'letter:B', 'letter:C', 'letter:D-E', 'letter:S-X', 'letter:Y-Z', 'letter:あ-か', 'letter:0-9']);
    assert.equal(f.text('cat'), 'A');
    // 每首歌只出现在一个字母列里
    const lettered = f.view.debug().columns.filter((c) => c.id.startsWith('letter:')).reduce((n, c) => n + c.n, 0);
    assert.equal(lettered, LIB.length);
    f.close();
});

test('字母列里回车播放，队列是整个曲库；目录里的行落到对应字母列', () => {
    const f = fixture({ tracks: LIB, playlists: [] });
    f.key('ArrowRight'); // B 列
    assert.equal(f.text('cat'), 'B');
    f.key('Enter');
    assert.equal(f.calls[0][0], 'load');
    assert.equal(f.calls[0][2], LIB.length);
    f.view.setListOpen(true);
    f.view.list.focusSearch();
    const input = listEl(f, 'input');
    input.value = 'zest';
    listKey(f, input, 'Shift');
    assert.equal(f.text('cat'), 'Y–Z');
    f.close();
});

test('有最近播放和收藏时排在最前面', () => {
    const f = fixture({
        tracks: LIB, playlists: [],
        setup: (w, app) => {
            w.localStorage.setItem('musicArchiveRecent', JSON.stringify(['/l/3', '/l/9']));
            app.favoriteTracks = ['/l/5'];
        }
    });
    const cols = f.view.debug().columns;
    assert.deepEqual(JSON.parse(JSON.stringify(cols.slice(0, 2).map((c) => [c.id, c.n]))), [['recent', 2], ['favorite', 1]]);
    f.close();
});

test('位置条：按下跳到对应位置，拖着走，提示首字母和第几首', () => {
    const f = fixture({ tracks: LIB, playlists: [] });
    const bar = f.w.document.querySelector('[data-ref="ticks"]');
    bar.getBoundingClientRect = () => ({ left: 100, top: 0, width: 314, height: 40, right: 414, bottom: 40 });
    bar.setPointerCapture = () => {};
    const ev = (type, x) => {
        const e = new f.w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 });
        Object.defineProperty(e, 'pointerId', { value: 1 });
        bar.dispatchEvent(e);
    };
    const n = f.view.debug().columns[0].n; // A 列
    ev('pointerdown', 107 + 300);           // 最右边
    assert.equal(f.text('selN').length >= 2, true);
    assert.equal(bar.getAttribute('aria-valuenow'), String(n));
    assert.ok(bar.classList.contains('is-scrubbing'));
    ev('pointermove', 107);                 // 拖回最左
    assert.equal(bar.getAttribute('aria-valuenow'), '1');
    assert.match(bar.querySelector('.archive-ticks-tip').textContent, /^A · 001$/);
    ev('pointerup', 107);
    assert.ok(!bar.classList.contains('is-scrubbing'));
    f.close();
});

test('滚轮快速滚动松手后会再滑几格', async () => {
    const f = fixture({ n: 200 });
    const root = f.w.document.getElementById('music-archive-view');
    for (let k = 0; k < 6; k++) {
        root.dispatchEvent(new f.w.WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 15));
    }
    const start = 0;
    const afterWheel = f.view.debug().row;
    assert.equal(afterWheel - start, 6);
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(f.view.debug().row > afterWheel, `停在第 ${f.view.debug().row} 行`);
    f.close();
});

test('目录里按歌手点播，队列是这位歌手的歌；全部曲目里点播，队列是整个曲库', () => {
    const f = fixture();
    f.view.setListOpen(true);
    f.view.list.setKind('artist');
    const rows = [...f.view.list.el.querySelectorAll('.archive-list-row')];
    rows[0].dispatchEvent(new f.w.MouseEvent('dblclick', { bubbles: true }));
    assert.equal(f.calls[0][2], 15);
    assert.equal(f.text('queue'), '歌手：Aki');
    f.calls.length = 0;
    f.view.list.setKind('all');
    const row = [...f.view.list.el.querySelectorAll('.archive-list-row')][4];
    row.dispatchEvent(new f.w.MouseEvent('dblclick', { bubbles: true }));
    assert.equal(f.calls[0][2], null);
    assert.equal(f.text('queue'), '全部曲目');
    f.close();
});

test('全部曲目按全局顺序（首字母、数值自然序）排，和目录一致', () => {
    const f = fixture({ n: 12 });
    const order = [];
    for (let k = 0; k < 12; k++) { order.push(f.view.debug().selected); f.key('ArrowDown'); }
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    f.view.setListOpen(true);
    const shown = [...f.view.list.el.querySelectorAll('.archive-list-row b')].map((n) => n.textContent);
    assert.deepEqual(shown.slice(0, 3), ['Song 0', 'Song 1', 'Song 2']);
    f.close();
});

test('Ctrl+L 定位当前播放，目录切回全部并滚到那一行', () => {
    const f = fixture();
    f.app.currentTrackIndex = 20;
    f.view.setListOpen(true);
    f.view.list.setKind('artist');
    f.key('ArrowDown');
    f.key('l', { ctrlKey: true });
    assert.equal(f.view.debug().selected, 20);
    assert.equal(f.view.list.kind, 'all');
    const on = f.view.list.el.querySelector('.archive-list-row.on');
    assert.match(on.textContent, /Song 20/);
    f.close();
});

test('每一列记住上次停在第几首，换列回来回到那一首', () => {
    const f = fixture({ playlists: [{ id: 'p', name: '夜间散步', tracks: ['/m/5', '/m/7', '/m/9', '/m/11', '/m/13'] }] });
    f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown'); // 全部曲目第 6 首
    f.key('ArrowRight');                       // 第一次进歌单：保持行号（第 6 行在 5 首的歌单里回绕到第 1 首 /m/5）
    assert.equal(f.view.debug().selected, 5);
    f.key('ArrowUp'); f.key('ArrowUp');        // 歌单里往回两首
    const inPlaylist = f.view.debug().selected;
    f.key('ArrowLeft');                        // 回全部曲目：回到第 6 首
    assert.equal(f.view.debug().selected, 5);
    f.key('ArrowRight');                       // 再进歌单：回到刚才那首
    assert.equal(f.view.debug().selected, inPlaylist);
    f.close();
});

test('目录排序菜单：换成按歌手排，阵列按歌手首字母重排，选中的歌不变，并记住', () => {
    const f = fixture({ n: 60 });
    const doc = f.w.document;
    f.view.setListOpen(true);
    f.key('ArrowDown'); f.key('ArrowDown'); f.key('ArrowDown'); // Song 3（Aki）
    const before = f.view.debug().selected;
    doc.querySelector('[data-l="sortBtn"]').click();
    const menu = doc.querySelector('[data-l="sortMenu"]');
    assert.equal(menu.hidden, false);
    menu.querySelector('[data-sort="artist"]').click();
    assert.equal(menu.hidden, true);
    assert.equal(f.view.sort, 'artist');
    assert.equal(doc.querySelector('[data-l="sortName"]').textContent, '歌手');
    const ids = f.view.debug().columns.map((c) => c.id);
    assert.ok(ids.includes('sort-artist:A') && ids.includes('sort-artist:R'), ids.join());
    assert.equal(f.view.debug().selected, before);
    assert.equal(f.text('cat'), 'A');
    assert.equal(f.w.localStorage.getItem('musicArchiveSort'), 'artist');
    // 目录的首字母组也按歌手
    f.view.list.el.querySelector('[data-l="viewport"]').scrollTop = 0;
    f.view.list.rebuild();
    const letters = [...doc.querySelectorAll('.archive-list-letter span')].map((s) => s.textContent);
    assert.equal(letters[0], 'A');
    // 键盘：菜单里上下选、回车确定
    doc.querySelector('[data-l="sortBtn"]').click();
    const kd = (k) => doc.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    kd('ArrowDown'); kd('Enter');
    assert.equal(f.view.sort, 'duration');
    assert.equal(f.text('cat'), '时长未知');
    f.close();
});

test('在档案页直接打字：打开目录、聚焦检索框并带入这个字；输入法组字时不抢', async () => {
    const f = fixture();
    f.view.setListOpen(false);
    const input = f.view.list.input;
    f.key('a', { isComposing: true });
    f.key('Process', { keyCode: 229 });
    assert.ok(f.view.list.el.hidden);
    assert.equal(input.value, '');
    f.key('2');
    assert.ok(!f.view.list.el.hidden);
    assert.equal(f.w.document.activeElement, input);
    assert.equal(input.value, '2');
    assert.equal(f.w.localStorage.getItem('musicArchiveList'), '0'); // 打字打开的不改用户「收起」的设置
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(f.view.list.query, '2');
    assert.equal(f.view.debug().selected, 2); // 第一条结果直接选中
    // 已有检索词时，回到阵列再打字是新的检索
    input.blur();
    f.key('9');
    assert.equal(input.value, '9');
    // 空格、修饰键、方向键不进检索框
    input.blur();
    f.key(' ', { code: 'Space' });
    f.key('k', { ctrlKey: true });
    f.key('ArrowDown');
    assert.equal(input.value, '9');
    assert.ok(f.calls.some((c) => c[0] === 'play'));
    f.close();
});

test('重启回到上次的列和那张卡，不自动播放；上次在播放页就回到播放页', async () => {
    const place = { mode: 'archive', stage: true, col: 'playlist:p', row: 2, path: '/m/9' };
    const f = fixture({ setup: (w) => w.localStorage.setItem('musicArchivePlace', JSON.stringify(place)) });
    assert.equal(f.text('cat'), '夜间散步');
    assert.equal(f.view.debug().selected, 9);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(f.calls, [['stage']]); // 只进播放页，没有 load / play
    f.close();
});

test('曲库晚到：等曲库到了再落位；换了选中会记下来，下次打开回到这里', async () => {
    const tracks = Array.from({ length: 30 }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i, artist: 'A', album: 'B' }));
    let store = null;
    const f = fixture({
        tracks: [],
        setup: (w) => w.localStorage.setItem('musicArchivePlace', JSON.stringify({ mode: 'archive', stage: false, col: 'all', row: 0, path: '/m/12' }))
    });
    f.app.playlist = tracks;
    f.view.refresh();
    assert.equal(f.view.debug().selected, 12);
    f.key('ArrowDown');
    assert.equal(f.view.debug().selected, 13);
    await new Promise((r) => setTimeout(r, 450));
    store = JSON.parse(f.w.localStorage.getItem('musicArchivePlace'));
    assert.equal(store.path, '/m/13');
    assert.equal(store.col, 'all');
    assert.equal(store.stage, false);
    assert.ok(!f.calls.length);
    f.close();
});

test('没有记录时：播放器晚一点恢复上次那首，选中直接落到那张卡', () => {
    const tracks = Array.from({ length: 30 }, (_, i) => ({ path: '/m/' + i, title: 'Song ' + i, artist: 'A', album: 'B' }));
    const f = fixture({ tracks: [] });
    f.app.playlist = tracks;
    f.view.refresh();
    assert.equal(f.view.debug().selected, 0);
    f.app.currentTrackIndex = 21; // 播放器 loadTrack(上次那首, 不播放)
    f.view.refresh();
    assert.equal(f.view.debug().selected, 21);
    f.close();
});

test('帧率：操作时按档位上限画，静止 2 秒后 12 帧，播放页盖住时一帧不画', () => {
    // 假场景：记录 step 次数；idle 由「距上次操作」决定，和真场景一致
    let now = 0;
    let lastInput = 0;
    let steps = 0;
    const canvas = { addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1, height: 1 }), style: {} };
    const fake = {
        create: () => ({
            canvas, tier: { fps: 60, idleFps: 12 }, target: { lane: 0, row: 0 }, dirty: false,
            step: () => { steps++; return { moving: false, idle: now - lastInput > 2000, animated: true }; },
            select: () => { lastInput = now; }, jump() {}, resize() {}, setTheme() {}, setPlaying() {}, setHover() {}, setPointer() {},
            touch: () => { lastInput = now; }, raise() {}, setLabeler() {}, setLabelMask() {}, refreshLabels() {}, dispose() {}, pick: () => null, debug: () => ({})
        })
    };
    const queue = [];
    const f = fixture({
        setup: (w) => {
            w.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
            w.cancelAnimationFrame = () => {};
            w.HTMLElement.prototype.insertBefore = function (n) { return n; };
        }
    });
    // 换成假场景重新初始化
    f.view.destroy();
    f.app.archiveView = null;
    const w = f.w;
    w.document.getElementById('music-archive-view').innerHTML = '';
    const view = w.MusicArchive.init(f.app, { sceneLib: fake, pinyinSrc: false });
    const run = (ms) => {
        const start = steps;
        const end = now + ms;
        while (now < end) {
            now += 1000 / 60;
            const cbs = queue.splice(0);
            for (const cb of cbs) cb(now);
        }
        return steps - start;
    };
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    lastInput = now;
    const active = run(1000);
    run(1500);
    const idle = run(2000) / 2;
    w.document.body.classList.add('music-stage-active');
    run(50);
    const covered = run(2000);
    assert.ok(active >= 55, 'active ' + active);
    assert.ok(idle >= 11 && idle <= 13, 'idle ' + idle);
    assert.equal(covered, 0);
    view.destroy();
    f.close();
});

test('降低动态读设置里的统一开关；开关不在时按系统设置挂 body 类', () => {
    // 系统开着减少动态，但用户在设置里选了「关」：档案页照常动
    let fire = null;
    const f = fixture({
        setup: (w) => {
            w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
            w.MusicMotion = { reduced: () => false, onChange: (fn) => { fire = fn; return () => { fire = null; }; } };
        }
    });
    assert.ok(!f.w.document.body.classList.contains('music-reduce-motion'));
    assert.equal(typeof fire, 'function');
    f.close();
    assert.equal(fire, null); // 关窗时取消订阅
    // 没有统一开关：跟随系统
    const g = fixture({ setup: (w) => { w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }); } });
    assert.ok(g.w.document.body.classList.contains('music-reduce-motion'));
    g.close();
});

test('有统一点播入口时走 playFromContext（按阵列顺序）；换排序时正在放的整库队列跟着换顺序', () => {
    const got = [];
    let owned = false;
    const f = fixture({
        n: 60,
        setup: (w, app) => {
            app.playFromContext = (list, index, opts) => { got.push(['ctx', list.length, index, opts.origin]); owned = true; app.currentTrackIndex = index; };
            app.contextFrom = (o) => owned && o === 'archive';
            app.reorderContext = (list, o) => { got.push(['reorder', list.length, o, list[0].path]); return true; };
        }
    });
    f.key('ArrowDown');
    f.key('Enter');
    assert.deepEqual(got[0], ['ctx', 60, f.view.debug().selected, 'archive']);
    f.view.setSort('added');
    assert.deepEqual(got[1], ['reorder', 60, 'archive', '/m/59']); // 新的在前
    f.close();
});

function withMenu(w, app, calls) {
    const doc = w.document;
    const menu = doc.createElement('div');
    menu.id = 'track-context-menu';
    menu.className = 'context-menu';
    menu.innerHTML = '<div class="context-menu-item" data-action="play">播放</div><div class="context-menu-item" data-action="play-next">下一首</div>'
        + '<div class="context-menu-item has-submenu" data-action="add-to-playlist">加入歌单<div class="context-submenu"><div class="submenu-item">夜间散步</div><div class="submenu-item">雨天</div></div></div>'
        + '<div class="context-menu-item danger" data-action="remove">移除</div>';
    doc.body.appendChild(menu);
    menu.querySelectorAll('.context-menu-item, .submenu-item').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); calls.push(['menu', el.dataset.action || el.textContent, app.contextMenuTrackIndex, app.contextMenuScopeHint === undefined ? 'none' : app.contextMenuScopeHint]); menu.classList.remove('visible'); }));
    app.contextMenu = menu;
    app.showContextMenu = (x, y) => { calls.push(['ctx', app.contextMenuTrackIndex]); menu.classList.add('visible'); };
    return menu;
}

test('目录行：Shift+F10 / 菜单键打开右键菜单，方向键移动，回车执行，Esc 关闭后焦点回到目录', () => {
    let menu;
    const f = fixture({ setup: (w, app) => { menu = withMenu(w, app, []); } });
    const calls = [];
    f.app.showContextMenu = (x, y) => { calls.push(['ctx', f.app.contextMenuTrackIndex]); menu.classList.add('visible'); };
    menu.querySelectorAll('.context-menu-item, .submenu-item').forEach((el) => el.addEventListener('click', () => calls.push(['menu', el.dataset.action || el.textContent, f.app.contextMenuTrackIndex])));
    const doc = f.w.document;
    f.view.setListOpen(true);
    const vp = f.view.list.el.querySelector('[data-l="viewport"]');
    vp.focus();
    const kd = (k, extra = {}) => doc.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
    kd('ArrowDown'); kd('ArrowDown'); kd('ArrowDown');
    const sel = f.view.debug().selected;
    kd('F10', { shiftKey: true });
    assert.ok(menu.classList.contains('visible'));
    assert.deepEqual(calls[0], ['ctx', sel]);
    assert.equal(doc.activeElement.dataset.action, 'play');
    kd('ArrowDown');
    assert.equal(doc.activeElement.dataset.action, 'play-next');
    kd('ArrowUp'); kd('ArrowUp'); // 循环到最后一项
    assert.equal(doc.activeElement.dataset.action, 'remove');
    kd('ArrowUp');
    kd('ArrowRight'); // 打开子菜单
    assert.equal(doc.activeElement.textContent, '夜间散步');
    kd('ArrowDown');
    kd('Enter');
    assert.deepEqual(calls.at(-1), ['menu', '雨天', sel]);
    assert.ok(!menu.classList.contains('visible'));
    assert.equal(doc.activeElement, vp);
    // 菜单键也行；Esc 关闭，焦点回到目录
    kd('ContextMenu');
    assert.ok(menu.classList.contains('visible'));
    kd('Escape');
    assert.ok(!menu.classList.contains('visible'));
    assert.equal(doc.activeElement, vp);
    f.close();
});

test('阵列上 Shift+F10 打开选中卡的右键菜单；歌单分类里的行右键时只从这个歌单移除', () => {
    let menu;
    const calls = [];
    const f = fixture({ setup: (w, app) => { menu = withMenu(w, app, calls); } });
    f.key('ArrowDown');
    f.key('F10', { shiftKey: true });
    assert.ok(menu.classList.contains('visible'));
    assert.deepEqual(calls[0], ['ctx', 1]);
    f.key('Escape');
    assert.ok(!menu.classList.contains('visible'));
    // 歌单分类里的行
    f.view.setListOpen(true);
    f.view.list.setKind('playlist');
    const row = f.view.list.el.querySelector('.archive-list-row');
    row.dispatchEvent(new f.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert.deepEqual(JSON.parse(JSON.stringify(f.app.contextMenuScopeHint)), { type: 'playlist', id: 'p', name: '夜间散步' });
    f.close();
});

test('右侧滚动歌词：播放器有歌词时显示，当前行跟着进度走，点一行跳过去；没有歌词就不显示', async () => {
    const seeks = [];
    const f = fixture({
        setup: (w, app) => {
            Object.defineProperty(w, 'innerWidth', { value: 1920 }); Object.defineProperty(w, 'innerHeight', { value: 1080 });
            app.currentLyrics = [{ time: 0, text: '第一句' }, { time: 5, text: '第二句', translation: 'second' }, { time: 10, text: '' }, { time: 12, text: '第三句' }];
            app.isPlaying = true;
            app.lastKnownCurrentTime = 6;
            app.lastStateUpdateTime = Date.now();
            app.seekTo = (t) => seeks.push(t);
        }
    });
    const el = f.w.document.querySelector('.archive-lyrics');
    assert.ok(el && !el.hidden);
    assert.ok(f.w.document.querySelector('.archive-hud').classList.contains('has-lyrics'));
    const d = f.view.debug().lyrics;
    assert.equal(d.lines, 3); // 空行不显示
    assert.equal(d.index, 1);
    assert.equal(el.querySelector('p.on b').textContent, '第二句');
    assert.equal(el.querySelector('p.on em').textContent, 'second');
    assert.ok(d.ticking);
    // 点第三句：跳到 12 秒，高亮跟过去
    el.querySelectorAll('p')[2].dispatchEvent(new f.w.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(seeks, [12]);
    assert.equal(el.querySelector('p.on b').textContent, '第三句');
    // 换了一首没有歌词的：收起
    f.app.currentLyrics = [];
    f.app.currentTrackIndex = 3;
    f.view.refresh();
    assert.ok(el.hidden);
    assert.ok(!f.w.document.querySelector('.archive-hud').classList.contains('has-lyrics'));
    assert.ok(!f.view.debug().lyrics.ticking);
    f.close();
});

test('右侧歌词：经典视图和播放页里不显示，暂停时不走表', () => {
    const f = fixture({
        setup: (w, app) => {
            Object.defineProperty(w, 'innerWidth', { value: 1920 }); Object.defineProperty(w, 'innerHeight', { value: 1080 });
            app.currentLyrics = [{ time: 0, text: 'a' }, { time: 5, text: 'b' }];
            app.isPlaying = false;
            app.lastKnownCurrentTime = 1;
        }
    });
    const el = f.w.document.querySelector('.archive-lyrics');
    assert.ok(!el.hidden);
    assert.ok(!f.view.debug().lyrics.ticking);
    f.view.showClassic();
    assert.ok(el.hidden);
    f.view.show();
    assert.ok(!el.hidden);
    f.w.document.body.classList.add('music-stage-active');
    f.view.refresh();
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.ok(el.hidden);
    f.w.document.body.classList.remove('music-stage-active');
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.ok(!el.hidden);
    // 窄窗口放不下：收起
    Object.defineProperty(f.w, 'innerWidth', { value: 900 });
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.ok(el.hidden);
    f.close();
});

test('onMotion：换选中时回调方向、速度和在这一列里的位置，可取消', () => {
    const f = fixture();
    const got = [];
    const off = f.view.onMotion((m) => got.push(m));
    f.key('ArrowDown'); f.key('ArrowDown');
    f.key('ArrowRight');
    assert.equal(got.length, 3);
    assert.equal(got[0].axis, 'row');
    assert.ok(got[1].velocity > 0);
    assert.equal(got[2].axis, 'lane');
    assert.ok(got[0].fraction > 0 && got[0].fraction <= 1);
    off();
    f.key('ArrowDown');
    assert.equal(got.length, 3);
    f.close();
});

test('流体小滴：底栏的流体标记模块在时，位置条和字母轴都挂上小滴，刻度按远近写 data-md-dist', (t) => {
    const file = process.env.MUSIC_FLUID_MARKER || 'Musicmodules/music-dock/music-fluid-marker.js';
    if (!fs.existsSync(file)) { t.skip('底栏的流体标记模块还没合进这个分支'); return; }
    const src = read(file);
    const f = fixture({ n: 60, setup: (w) => { w.eval(src); } });
    const ticks = f.w.document.querySelector('.archive-ticks');
    assert.ok(ticks.classList.contains('has-drop'));
    assert.ok(ticks.querySelector('svg.mfm'));
    for (let k = 0; k < 20; k++) f.key('ArrowDown');
    const marks = [...ticks.querySelectorAll('span')].filter((m) => !m.hidden);
    const on = marks.findIndex((m) => m.classList.contains('on'));
    assert.equal(marks[on].dataset.mdDist, '0');
    assert.equal(marks[Math.max(0, on - 1)].dataset.mdDist, on ? '1' : '0');
    f.view.setListOpen(true);
    f.view.list.render();
    f.close();
});

test('没有流体标记模块时照旧用竖线游标', () => {
    const f = fixture();
    const ticks = f.w.document.querySelector('.archive-ticks');
    assert.ok(!ticks.classList.contains('has-drop'));
    assert.ok(!ticks.querySelector('svg'));
    f.close();
});

test('封面：自带封面直接用，读不出来不留破图；没有封面时试同目录的图，每个目录只试一次', async () => {
    const asked = [];
    const f = fixture({
        tracks: [
            { path: '/a/0.flac', title: 'A0', albumArt: '/c/ok.jpg' },
            { path: '/a/1.flac', title: 'A1', albumArt: '/c/bad.jpg' },
            { path: '/b/2.flac', title: 'A2' },
            { path: '/b/3.flac', title: 'A3' },
            { path: 'https://x.test/dav/4.flac', title: 'A4' }
        ],
        playlists: [],
        setup: (w) => {
            w.Image = class {
                constructor() { this.l = {}; }
                addEventListener(type, fn) { (this.l[type] = this.l[type] || []).push(fn); }
                set src(v) {
                    asked.push(v);
                    const ok = /ok\.jpg$|\/b\/folder\.jpg$/.test(v);
                    w.setTimeout(() => { const t = ok ? 'load' : 'error'; this['on' + t]?.(); (this.l[t] || []).forEach((fn) => fn()); }, 0);
                }
            };
        }
    });
    const cover = f.w.document.querySelector('[data-ref="cover"]');
    const wait = (ms = 200) => new Promise((r) => f.w.setTimeout(r, ms));
    await wait();
    assert.equal(cover.dataset.state, 'ready');
    assert.match(cover.style.backgroundImage, /ok\.jpg/);
    f.key('ArrowDown'); await wait();
    assert.equal(cover.dataset.state, 'failed');
    assert.equal(cover.style.backgroundImage, '');
    assert.equal(cover.classList.contains('on'), false);
    f.key('ArrowDown'); await wait();
    assert.equal(cover.dataset.state, 'ready');
    assert.match(cover.style.backgroundImage, /\/b\/folder\.jpg/);
    const probes = asked.filter((u) => /\/b\//.test(u)).length;
    f.key('ArrowDown'); await wait();
    assert.equal(cover.dataset.state, 'ready', '同目录第二首直接用上次找到的图');
    assert.equal(asked.filter((u) => /\/b\//.test(u)).length, probes, '不再重新试');
    f.key('ArrowDown'); await wait();
    assert.equal(cover.dataset.state, 'none', '远程曲目不去试本地目录');
    assert.equal(asked.some((u) => /x\.test/.test(u)), false);
    f.close();
});

test('扫描曲库：空曲库时中间换成进度并收起入口，有歌时写在左下角状态里，扫完恢复', () => {
    const fns = {};
    const api = { onMusicScanStart: (fn) => { fns.start = fn; return () => { fns.start = null; }; }, onMusicScanProgress: (fn) => { fns.progress = fn; }, onMusicScanComplete: (fn) => { fns.complete = fn; } };
    const f = fixture({ n: 0, playlists: [], setup: (w, app) => { app.api = api; } });
    const root = f.w.document.getElementById('music-archive-view');
    assert.equal(f.text('emptyTitle'), 'ARCHIVE EMPTY');
    assert.match(root.querySelector('[data-act="add-local"]').textContent, /添加音乐文件夹/);
    fns.start();
    assert.ok(root.classList.contains('is-scanning'));
    assert.equal(f.text('emptyTitle'), 'SCANNING ARCHIVE');
    fns.progress({ current: 437, total: 1280 });
    assert.match(f.text('emptyText'), /0437 \/ 1280/);
    assert.equal(f.text('status'), 'SCANNING 0437 / 1280');
    assert.match(root.querySelector('[data-ref="scanBar"]').style.transform, /scaleX\(0\.34/);
    fns.complete({ tracks: new Array(1280) });
    assert.equal(root.classList.contains('is-scanning'), false);
    assert.equal(f.text('status'), 'SCAN COMPLETE ／ 1280 FILES');
    assert.equal(f.text('emptyTitle'), 'ARCHIVE EMPTY');
    f.close();
    assert.equal(fns.start, null, '关掉时取消订阅');
});

test('空的原因各有说法：检索没结果、空歌单、还没有播放记录', () => {
    const f = fixture({ playlists: [{ id: 'e', name: '空歌单', tracks: [] }] });
    const empty = () => f.view.list.el.querySelector('[data-l="empty"]');
    f.view.setListOpen(true);
    f.view.list.input.value = 'zzqx';
    f.view.list.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.match(empty().textContent, /没有找到「zzqx」.*ESC 清除检索/);
    f.view.list.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(empty().style.display, 'none');
    f.view.list.el.querySelector('[data-kind="playlist"]').click();
    assert.match(empty().textContent, /歌单里还没有歌.*右键/);
    f.view.list.el.querySelector('[data-kind="recent"]').click();
    assert.match(empty().textContent, /还没有播放记录/);
    // 阵列走到空歌单那一列：说明是空的，并提示怎么加歌
    const lane = f.view.debug().columns.findIndex((c) => c.id === 'playlist:e');
    for (let k = 0; k < lane; k++) f.key('ArrowRight');
    assert.equal(f.text('ftitle'), '这个歌单还是空的');
    assert.match(f.text('fmeta'), /右键/);
    f.close();
});

test('右侧歌词：正在放的歌等一会儿还没有歌词，只留栏头和「获取歌词」；歌词到了换成歌词，不占大封面的版面', async () => {
    const f = fixture({ setup: (w, app) => { w.innerWidth = 1600; w.innerHeight = 900; app.isPlaying = true; app.currentLyrics = []; app.openLyricsFetchModal = (i) => { app.fetchAsked = i; }; } });
    const el = f.w.document.querySelector('.archive-lyrics');
    const hud = f.w.document.querySelector('.archive-hud');
    const wait = (ms) => new Promise((r) => f.w.setTimeout(r, ms));
    f.view.refresh();
    assert.equal(el.hidden, true, '刚开始先不说没有（可能还在取）');
    await wait(2700);
    assert.equal(el.hidden, false);
    assert.ok(el.classList.contains('none'));
    assert.equal(hud.classList.contains('has-lyrics'), false);
    el.querySelector('[data-y="fetch"]').click();
    assert.equal(f.app.fetchAsked, 0);
    f.app.currentLyrics = [{ time: 1, text: '第一句' }, { time: 5, text: '第二句' }];
    f.view.refresh();
    assert.equal(el.classList.contains('none'), false);
    assert.ok(hud.classList.contains('has-lyrics'));
    f.close();
});

test('大曲库整体变化：分片重建，中途不改画面，做完后阵列、目录、检索都是新曲库；小曲库当场重建', async () => {
    const make = (n, tag = '') => Array.from({ length: n }, (_, i) => ({ path: '/big/' + tag + i, title: '清晨的站台 ' + tag + i, artist: i % 2 ? 'Aki' : '周杰伦', album: 'A' + (i % 9) }));
    const f = fixture({ tracks: make(2400), playlists: [] });
    const files = () => Number(f.text('files'));
    const wait = (ms) => new Promise((r) => f.w.setTimeout(r, ms));
    f.view.setListOpen(true);
    assert.equal(files(), 2400);
    f.app.playlist = make(2600);
    f.view.refreshSoon();
    assert.equal(files(), 2400, '这一片只算了一部分条目，画面还没换');
    // 中途曲库又变了：按最新的那份重来
    f.app.playlist = make(2700, 'x');
    await wait(400);
    assert.equal(files(), 2700);
    assert.equal(f.view.list.count, 2700);
    assert.equal(f.view.debug().columns.reduce((a, c) => a + (/^letter:/.test(c.id) ? c.n : 0), 0), 2700);
    f.view.list.input.value = 'x2699';
    f.view.list.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(f.view.list.count, 1);
    // 小曲库不分片
    f.app.playlist = make(30, 's');
    f.view.refreshSoon();
    assert.equal(files(), 30);
    f.close();
});

test('扫描途中一批批进来：阵列和目录跟着长，选中的还是那首歌，目录眼前的内容不被顶走，也不碰播放；扫完重排后仍是那首', async () => {
    const fns = {};
    const api = { onMusicScanStart: (fn) => { fns.start = fn; }, onMusicScanProgress: (fn) => { fns.progress = fn; }, onMusicScanComplete: (fn) => { fns.complete = fn; }, onMusicScanBatch: (fn) => { fns.batch = fn; } };
    const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({ path: '/s/' + tag + i, title: tag + ' ' + String(i).padStart(3, '0'), artist: 'Ren' }));
    const f = fixture({ tracks: mk(80, 'M'), playlists: [], setup: (w, app) => { app.api = api; } });
    const wait = (ms) => new Promise((r) => f.w.setTimeout(r, ms));
    const selPath = () => f.app.playlist[f.view.debug().selected].path;
    f.view.setListOpen(true);
    for (let k = 0; k < 7; k++) f.key('ArrowDown');
    const chosen = selPath();
    // 目录滚到别处看
    const vp = f.view.list.el.querySelector('[data-l="viewport"]');
    vp.scrollTop = 2000; vp.dispatchEvent(new f.w.Event('scroll'));
    await wait(40);
    const topTitle = () => {
        const rows = [...vp.querySelectorAll('.archive-list-row')].map((n) => ({ y: parseFloat((n.style.transform.match(/translateY\(([-\d.]+)px/) || [])[1]), t: n.textContent }))
            .filter((x) => x.y >= vp.scrollTop).sort((a, b) => a.y - b.y);
        return rows[0] && rows[0].t;
    };
    const before = topTitle();
    assert.ok(before);
    fns.start({ total: 200, folderPath: '/s' });
    fns.progress({ current: 100, total: 200 });
    assert.equal(f.text('status'), 'SCANNING 0100 / 0200');
    // 新来的歌排在前面（标题 A 开头）
    f.app.playlist = f.app.playlist.concat(mk(40, 'A'));
    fns.batch({ tracks: [] });
    assert.equal(Number(f.text('files')), 80, '攒一会儿再排');
    await wait(650);
    assert.equal(Number(f.text('files')), 120);
    assert.equal(selPath(), chosen);
    assert.equal(topTitle(), before, '眼前最上面还是那首');
    assert.deepEqual(f.calls, [], '没有碰播放');
    // 扫完：曲库按磁盘顺序重排（下标全变）
    f.app.playlist = f.app.playlist.slice().reverse();
    fns.complete({ tracks: f.app.playlist });
    f.view.refreshSoon();
    assert.equal(selPath(), chosen);
    f.close();
});
