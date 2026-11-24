const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 专辑按碟号、曲号排：标签优先，旧曲库从文件名、文件夹猜。
const { numberOf, albumCompare } = require(path.join(__dirname, '../Musicmodules/music-track-order.js'));

test('numberOf reads tags first, then file and folder names', () => {
    assert.deepEqual(numberOf({ trackNo: 7, discNo: 2, path: 'D:\\A\\01 x.flac' }), { disc: 2, no: 7 });
    assert.deepEqual(numberOf({ path: 'D:\\A\\03 - 晴天.flac' }), { disc: 0, no: 3 });
    assert.deepEqual(numberOf({ path: 'D:\\A\\12. Song.mp3' }), { disc: 0, no: 12 });
    assert.deepEqual(numberOf({ path: 'D:\\A\\2-05 Song.flac' }), { disc: 2, no: 5 });
    assert.deepEqual(numberOf({ path: 'D:\\A\\Disc 2\\04 Song.flac' }), { disc: 2, no: 4 });
    assert.deepEqual(numberOf({ path: 'D:/A/CD1/09_Song.flac' }), { disc: 1, no: 9 });
    assert.deepEqual(numberOf({ path: 'D:\\A\\2019 Live.flac' }), { disc: 0, no: 0 });
    assert.deepEqual(numberOf({ path: 'D:\\A\\2Pac - x.flac' }), { disc: 0, no: 0 });
    assert.deepEqual(numberOf({ path: 'https://dav/A/05%20x.flac' }), { disc: 0, no: 5 });
    assert.deepEqual(numberOf({ path: 'D:\\A\\Track01.wav' }), { disc: 0, no: 1 });
    assert.deepEqual(numberOf({ path: 'D:\\A\\Track 12.flac' }), { disc: 0, no: 12 });
    assert.deepEqual(numberOf({ path: 'D:\\A\\Tracking Down.flac' }), { disc: 0, no: 0 });
    assert.deepEqual(numberOf(null), { disc: 0, no: 0 });
});

test('albumCompare orders by disc then track, unnumbered last by fallback', () => {
    const tracks = [
        { title: 'Zebra', path: 'D:\\A\\CD2\\01 Zebra.flac' },
        { title: 'Apple', path: 'D:\\A\\CD1\\02 Apple.flac' },
        { title: 'Mango', trackNo: 1, discNo: 1, path: 'D:\\A\\CD1\\Mango.flac' },
        { title: 'Bonus', path: 'D:\\A\\Bonus.flac' },
        { title: 'Aria', path: 'D:\\A\\Aria.flac' }
    ];
    const byTitle = (a, b) => tracks[a].title.localeCompare(tracks[b].title);
    const order = [0, 1, 2, 3, 4].sort(albumCompare(tracks, byTitle)).map((i) => tracks[i].title);
    assert.deepEqual(order, ['Mango', 'Apple', 'Zebra', 'Aria', 'Bonus']);
});

test('archive list groups an album in track order when sorting by title', () => {
    const idx = require(path.join(__dirname, '../Musicmodules/music-archive/archive-index.js'));
    const tracks = [
        { title: 'Zebra', album: 'X', path: 'D:\\X\\01 Zebra.flac' },
        { title: 'Apple', album: 'X', path: 'D:\\X\\02 Apple.flac' }
    ];
    const index = idx.createIndex(tracks);
    const { rows } = idx.listRows({ tracks, index, kind: 'album' });
    assert.deepEqual(rows.filter((r) => r.type === 'track').map((r) => tracks[r.i].title), ['Zebra', 'Apple']);
});
