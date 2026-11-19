/* 档案阵列数据层：歌单映射成列、循环取格、检索、键盘和滚轮步进。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../Musicmodules/music-archive/archive-model.js');

const tracks = [
    { path: 'D:\\M\\a.flac', title: 'Alpha.flac', artist: 'Aki', album: 'Low Tide' },
    { path: 'D:\\M\\b.mp3', title: '站台', artist: 'Ren', album: 'Low Tide' },
    { path: 'D:\\M\\c.flac', title: 'Gamma', artist: 'Lumi', album: '窗边' },
    { path: 'D:\\M\\d.flac', title: 'Delta', artist: 'Aki', album: '' }
];
const playlists = [
    { id: 'p1', name: '海边线路', tracks: ['d:/m/c.flac', 'D:\\M\\a.flac', 'D:\\M\\missing.flac'] },
    { id: 'p2', name: 'Night Walk', tracks: [] }
];

test('第一列是全部曲目，之后是歌单，再之后是两首以上的专辑', () => {
    const cols = M.buildColumns(tracks, playlists);
    assert.deepEqual(cols.map((c) => c.kind), ['all', 'playlist', 'playlist', 'album']);
    assert.deepEqual(cols[0].items, [0, 1, 2, 3]);
    assert.equal(cols[3].name, 'Low Tide');
    assert.deepEqual(cols[3].items, [0, 1]);
});

test('歌单按路径对上曲库下标，不分大小写和斜杠方向，找不到的跳过', () => {
    const cols = M.buildColumns(tracks, playlists);
    assert.deepEqual(cols[1].items, [2, 0]);
    assert.equal(cols[1].playlistId, 'p1');
    assert.equal(cols[2].ref, 'NIGHT WALK');
    assert.equal(cols[1].ref, 'PLAYLIST 01');
});

test('阵列两个方向都循环；空列返回 -1', () => {
    const cols = M.buildColumns(tracks, playlists);
    assert.equal(M.cellTrack(cols, 0, 5), 1);
    assert.equal(M.cellTrack(cols, 0, -1), 3);
    assert.equal(M.cellTrack(cols, -3, 1), 0);   // -3 → 第 1 列（海边线路）
    assert.equal(M.cellTrack(cols, 2, 0), -1);
    assert.equal(M.cellTrack([], 0, 0), -1);
});

test('locate 优先在指定列里找', () => {
    const cols = M.buildColumns(tracks, playlists);
    assert.deepEqual(M.locate(cols, 0, 1), { lane: 1, row: 1 });
    assert.deepEqual(M.locate(cols, 3, 1), { lane: 0, row: 3 });
    assert.equal(M.locate(cols, -1, 0), null);
});

test('检索标题（去掉扩展名）、歌手、专辑', () => {
    assert.deepEqual(M.search(tracks, 'flac'), []);
    assert.deepEqual(M.search(tracks, 'aki'), [0, 3]);
    assert.deepEqual(M.search(tracks, '窗'), [2]);
    assert.deepEqual(M.search(tracks, '  '), []);
    const col = M.searchColumn(tracks, ' 站台 ');
    assert.equal(col.kind, 'search');
    assert.deepEqual(col.items, [1]);
});

test('方向键和翻页键的步进', () => {
    const s = { lane: 2, row: 5 };
    assert.deepEqual(M.step(s, 'ArrowUp'), { lane: 2, row: 4 });
    assert.deepEqual(M.step(s, 'ArrowLeft'), { lane: 1, row: 5 });
    assert.deepEqual(M.step(s, 'PageDown'), { lane: 2, row: 13 });
    assert.equal(M.step(s, 'a'), null);
});

test('滚轮累计到阈值才走一格，停顿后清零，一次最多 6 格', () => {
    const w = M.createWheel(60);
    assert.equal(w(40, 0), 0);
    assert.equal(w(40, 10), 1);
    assert.equal(w(30, 1000), 0);    // 停顿超过 400ms，余量清掉
    assert.equal(w(-130, 1010), -1);
    assert.equal(w(5000, 1020), 6);
});

test('几千首歌建列也很快', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ path: '/m/' + i, title: 't' + i, album: 'al' + (i % 300) }));
    const pls = Array.from({ length: 30 }, (_, k) => ({ id: k, name: 'p' + k, tracks: many.slice(k * 100, k * 100 + 200).map((t) => t.path) }));
    const t0 = process.hrtime.bigint();
    const cols = M.buildColumns(many, pls);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(cols.length, 1 + 30 + 24);
    assert.ok(ms < 200, `buildColumns took ${ms}ms`);
});

test('档案号至少三位', () => {
    assert.equal(M.fileCode(0), '001');
    assert.equal(M.fileCode(1233), '1234');
});
