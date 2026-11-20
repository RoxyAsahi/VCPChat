/* 档案目录的检索索引：拼音、假名、首字母分组、各分类的行。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Index = require('../Musicmodules/music-archive/archive-index.js');

// 测试里用一张带声调的小拼音表代替真正的拼音库（声调要能去掉）
const PY = { 晴: 'qíng', 天: 'tiān', 海: 'hǎi', 风: 'fēng', 周: 'zhōu', 杰: 'jié', 伦: 'lún', 夜: 'yè', 曲: 'qǔ' };
const pinyin = (c) => PY[c] || '';

const TRACKS = [
    { path: '/a', title: '晴天.flac', artist: '周杰伦', album: '叶惠美' },
    { path: '/b', title: '海风', artist: 'Aimer', album: 'Dawn' },
    { path: '/c', title: 'アイドル', artist: 'YOASOBI', album: 'THE BOOK 3' },
    { path: '/d', title: 'Blue Bird', artist: 'いきものがかり', album: '' },
    { path: '/e', title: '1989', artist: 'Taylor', album: '1989' },
    { path: '/f', title: '「夜曲」', artist: '周杰伦', album: '十一月的萧邦' }
];

test('romanize 给出全拼和首字母，拉丁词取词首', () => {
    assert.deepEqual(Index.romanize('晴天', pinyin), { py: 'qingtian', ini: 'qt' });
    assert.deepEqual(Index.romanize('Blue Bird', pinyin), { py: 'bluebird', ini: 'bb' });
    assert.deepEqual(Index.romanize('晴天', null), { py: '晴天', ini: '晴天' });
});

test('拼音全拼、首字母都能找到汉字标题和歌手', () => {
    const idx = Index.createIndex(TRACKS, { pinyin });
    assert.equal(idx.query('qt')[0], 0);
    assert.equal(idx.query('qingt')[0], 0);
    assert.equal(idx.query('haif')[0], 1);
    assert.deepEqual(idx.query('zjl').sort(), [0, 5]);
    assert.deepEqual(idx.query('zjl yq'), [5]); // 多个词都要命中
});

test('平假名和片假名互通，全角半角不分', () => {
    const idx = Index.createIndex(TRACKS, { pinyin });
    assert.deepEqual(idx.query('あいど'), [2]);
    assert.deepEqual(idx.query('イキモノ'), [3]);
    assert.deepEqual(idx.query('ＹＯＡ'), [2]);
});

test('标题前缀最靠前，其次歌手前缀，再是标题中间命中', () => {
    const idx = Index.createIndex([
        { title: 'Night Walk', artist: 'Blue' },
        { title: 'Blue Night', artist: 'X' },
        { title: 'Deep Blue', artist: 'Y' }
    ]);
    assert.deepEqual(idx.query('blue'), [1, 0, 2]);
});

test('首字母分组：字母、假名行、汉字按拼音、数字、其他；跳过开头的符号', () => {
    const g = (t, p = pinyin) => Index.groupOf(t, p);
    assert.equal(g('Blue Bird'), 'B');
    assert.equal(g('アイドル'), 'あ');
    assert.equal(g('ぎんいろ'), 'か');
    assert.equal(g('晴天'), 'Q');
    assert.equal(g('晴天', null), '#');
    assert.equal(g('「夜曲」'), 'Y');
    assert.equal(g('1989'), '0-9');
    assert.equal(g('★'), '#');
    assert.equal(Index.groupName('あ'), 'あ行');
});

test('groupColumns 按固定顺序排组，组内按拼音排', () => {
    const idx = Index.createIndex(TRACKS, { pinyin });
    const cols = Index.groupColumns(idx, TRACKS.map((_, i) => i));
    assert.deepEqual(cols.map((c) => c.group), ['B', 'H', 'Q', 'Y', 'あ', '0-9']);
    assert.equal(cols[0].id, 'letter:B');
    assert.equal(cols[4].name, 'あ行');
});

test('listRows：全部按字母分组；有检索词时只有一组结果', () => {
    const index = Index.createIndex(TRACKS, { pinyin });
    const all = Index.listRows({ tracks: TRACKS, index });
    assert.equal(all.count, 6);
    assert.deepEqual(all.rows.filter((r) => r.type === 'head').map((r) => r.label), ['B', 'H', 'Q', 'Y', 'あ行', '0–9']);
    const hit = Index.listRows({ tracks: TRACKS, index, query: 'zjl' });
    assert.equal(hit.rows[0].label, '检索结果');
    assert.equal(hit.count, 2);
});

test('listRows：歌手、专辑、歌单、最近', () => {
    const index = Index.createIndex(TRACKS, { pinyin });
    const artist = Index.listRows({ tracks: TRACKS, index, kind: 'artist' });
    assert.equal(artist.rows.find((r) => r.type === 'head' && r.label === '周杰伦').n, 2);
    const album = Index.listRows({ tracks: TRACKS, index, kind: 'album' });
    assert.ok(album.rows.some((r) => r.type === 'head' && r.label === '未知专辑'));
    assert.equal(album.rows.find((r) => r.type === 'track' && r.i === 4).ctx, 'album:1989');
    const playlists = [{ id: 7, name: '通勤', tracks: ['\\B', '/x', '/C'] }];
    const pl = Index.listRows({ tracks: TRACKS, index, kind: 'playlist', playlists });
    assert.deepEqual(pl.rows.filter((r) => r.type === 'track').map((r) => [r.i, r.ctx]), [[1, 'playlist:7'], [2, 'playlist:7']]);
    assert.equal(Index.listRows({ tracks: TRACKS, index, kind: 'playlist', playlists, query: '通勤' }).count, 2); // 歌单名命中保留整张
    const recent = Index.listRows({ tracks: TRACKS, index, kind: 'recent', recent: [5, 99, 0] });
    assert.deepEqual(recent.rows.filter((r) => r.type === 'track').map((r) => r.i), [5, 0]);
});

test('几千首也能即时检索', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ title: (i % 2 ? '晴天' : 'Song ') + i, artist: '周杰伦', album: 'A' + (i % 40) }));
    const index = Index.createIndex(many, { pinyin });
    const t0 = process.hrtime.bigint();
    for (let k = 0; k < 20; k++) index.query('qt 12');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
    assert.ok(ms < 30, `一次检索 ${ms.toFixed(1)} ms`);
});

test('groupColumns 合并歌少的相邻字母，只在同一类里合并', () => {
    const titles = ['Apple', 'Avocado', 'Banana', 'Xylo', 'Zeta', 'Yak', 'あい', 'かき', '1999', '★'];
    const t = titles.map((title) => ({ title }));
    const idx = Index.createIndex(t);
    const cols = Index.groupColumns(idx, t.map((_, i) => i), { minSize: 2 });
    assert.deepEqual(cols.map((c) => [c.id, c.name]), [
        ['letter:A', 'A'], ['letter:B-X', 'B–X'], ['letter:Y-Z', 'Y–Z'], ['letter:あ-か', 'あ–か行'], ['letter:0-9', '0–9'], ['letter:#', '其他']
    ]);
    assert.deepEqual(cols[1].groups, ['B', 'X']);
});

test('组内按数值自然排序', () => {
    const t = ['Song 10', 'Song 2', 'Song 1'].map((title) => ({ title }));
    const idx = Index.createIndex(t);
    assert.deepEqual(Index.groupColumns(idx, [0, 1, 2])[0].items, [2, 1, 0]);
});
