const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 听歌统计：歌手、专辑榜由歌的次数合起来；时长和时段的说法。
const { rank, formatDuration, hourName } = require(path.join(__dirname, '../Musicmodules/music-stats-view.js'));

test('rank sums plays into artists and albums and skips tracks no longer in the library', () => {
    const lib = [
        { path: 'C:\\m\\a1.flac', title: 'a1', artist: 'A / B', album: 'X' },
        { path: 'C:\\m\\a2.flac', title: 'a2', artist: 'A', album: 'X' },
        { path: 'C:\\m\\c1.flac', title: 'c1', artist: 'C', album: 'Y' }
    ];
    const r = rank({ tracks: [
        { path: 'c:/m/c1.flac', plays: 4 }, { path: 'C:\\m\\a1.flac', plays: 3 },
        { path: 'C:\\m\\a2.flac', plays: 2 }, { path: 'C:\\gone.flac', plays: 9 }
    ] }, lib);
    assert.deepEqual(r.songs.map((s) => s.index), [2, 0, 1]);
    assert.deepEqual(r.artists.map((a) => [a.name, a.plays]), [['A', 5], ['C', 4]]);
    assert.deepEqual(r.albums.map((a) => [a.name, a.plays]), [['X', 5], ['Y', 4]], 'same album, same lead artist: one entry');
});

test('durations and hour names read naturally', () => {
    assert.equal(formatDuration(30), '不到 1 分');
    assert.equal(formatDuration(45 * 60), '45 分');
    assert.equal(formatDuration(3 * 3600 + 12 * 60), '3 小时 12 分');
    assert.equal(formatDuration(7200), '2 小时');
    assert.equal(hourName(22), '晚上 10 点');
    assert.equal(hourName(0), '凌晨 0 点');
    assert.equal(hourName(12), '中午 12 点');
});

test('coverUrls: embedded cover first, then folder images; remote tracks only use their own art', () => {
    const { coverUrls } = require(path.join(__dirname, '../Musicmodules/music-stats-view.js'));
    assert.deepEqual(coverUrls({ path: 'D:\\m\\a b#\\x.flac', albumArt: 'C:\\c\\1.jpg' }).slice(0, 2), ['file:///C:/c/1.jpg', 'file:///D:/m/a%20b%23/cover.jpg']);
    assert.deepEqual(coverUrls({ path: 'https://dav/x.flac' }), []);
    assert.deepEqual(coverUrls(null), []);
});
