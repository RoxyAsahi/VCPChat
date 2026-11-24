const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 整理重复的歌：同一首的几个文件归一组，留本机/无损/规格高的那份；没有歌手时只认完全相同的拷贝。
const { findDuplicates, dupeKey } = require(path.join(__dirname, '../Musicmodules/music-dupes.js'));

test('groups copies and keeps the best file', () => {
    const a1 = { path: 'C:\\M\\250515\\a.flac', title: 'A', artist: 'X', lossless: true, bitsPerSample: 16, sampleRate: 44100 };
    const a2 = { path: 'C:\\M\\250515 - 副本\\01\\a.flac', title: 'A', artist: 'X', lossless: true, bitsPerSample: 24, sampleRate: 96000 };
    const a3 = { path: 'https://nas/a.flac', title: 'A.flac', artist: 'X', lossless: true, bitsPerSample: 24, sampleRate: 192000 };
    const b = { path: 'C:\\M\\b.mp3', title: 'B', artist: 'X' };
    const n1 = { path: 'C:\\M\\x\\01.flac', title: '01.flac', duration: 200.2, size: 1000 };
    const n2 = { path: 'C:\\M\\y\\01.flac', title: '01.flac', duration: 200.4, size: 1000 };
    const n3 = { path: 'C:\\M\\z\\01.flac', title: '01.flac', duration: 180, size: 900 };
    const groups = findDuplicates([a1, a2, a3, b, n1, n2, n3]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].keep, a2, 'local 24/96 beats local 16/44 and the 24/192 WebDAV copy');
    assert.deepEqual(groups[0].extra.sort((x, y) => x.path.localeCompare(y.path)), [a1, a3].sort((x, y) => x.path.localeCompare(y.path)));
    assert.deepEqual([groups[1].keep, ...groups[1].extra].sort((x, y) => x.path.localeCompare(y.path)), [n1, n2]);
    assert.equal(dupeKey({ title: '01.flac' }), '', 'no artist, no size: never grouped');
});
