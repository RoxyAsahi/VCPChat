/* 档案页的交互（没有 WebGL 时只剩文字层，交互仍然可用）：键盘、目录与检索、播放进舞台、经典视图。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const read = (p) => fs.readFileSync(p, 'utf8');
const SCRIPTS = ['model', 'scene', 'index', 'list', 'view'].map((n) => read(`Musicmodules/music-archive/archive-${n}.js`));

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

test('空曲库显示空状态，回车什么也不做', () => {
    const f = fixture({ n: 0, playlists: [] });
    assert.ok(f.w.document.getElementById('music-archive-view').classList.contains('is-empty'));
    f.key('Enter');
    assert.deepEqual(f.calls, []);
    f.close();
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
