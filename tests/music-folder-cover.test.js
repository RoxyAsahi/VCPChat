const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 没嵌封面的歌用同目录的 cover.jpg / folder.jpg；后台同步看到新找到的封面也算变化。
const { pickFolderCover, fillFolderCovers } = require(path.join(__dirname, '../modules/musicLibraryScanner.js'));
const { changedSince } = require(path.join(__dirname, '../modules/musicLibraryWatch.js'));

test('pickFolderCover prefers cover over folder over front, any case', () => {
    assert.equal(pickFolderCover(['01.flac', 'Folder.JPG', 'Front.png']), 'Folder.JPG');
    assert.equal(pickFolderCover(['COVER.jpeg', 'folder.jpg']), 'COVER.jpeg');
    assert.equal(pickFolderCover(['AlbumArt_{X}_Large.jpg']), 'AlbumArt_{X}_Large.jpg');
    assert.equal(pickFolderCover(['scan.jpg', 'a.flac']), null);
});

test('fillFolderCovers only fills local tracks without art and reads each folder once', async () => {
    const reads = [];
    const dirA = path.join('m', 'A');
    const tracks = [
        { path: path.join(dirA, '1.flac') },
        { path: path.join(dirA, '2.flac'), albumArt: 'cache/x.jpg' },
        { path: path.join(dirA, '3.flac') },
        { path: path.join('m', 'B', '1.flac') },
        { path: 'https://dav/x.flac' }
    ];
    const n = await fillFolderCovers(tracks, async (dir) => { reads.push(dir); return dir === dirA ? ['folder.jpg', '1.flac'] : ['1.flac']; });
    assert.equal(n, 2);
    assert.equal(tracks[0].albumArt, path.join(dirA, 'folder.jpg'));
    assert.equal(tracks[1].albumArt, 'cache/x.jpg');
    assert.equal(tracks[3].albumArt, undefined);
    assert.deepEqual(reads, [dirA, path.join('m', 'B')]);
});

test('changedSince notices a newly found cover', () => {
    const root = path.resolve('m');
    const p = path.join(root, 'a.flac');
    assert.equal(changedSince([{ path: p, size: 1, mtimeMs: 1 }], [{ path: p, size: 1, mtimeMs: 1, albumArt: 'c.jpg' }], root), true);
    assert.equal(changedSince([{ path: p, size: 1, mtimeMs: 1, albumArt: 'c.jpg' }], [{ path: p, size: 1, mtimeMs: 1, albumArt: 'c.jpg' }], root), false);
});

test('multi-disc albums borrow the cover from the album folder above CD1 / Disc 2', async () => {
    const album = path.join('m', 'Album');
    const cd1 = path.join(album, 'CD1');
    const disc2 = path.join(album, 'Disc 2');
    const other = path.join('m', 'Live', 'Encore');
    const tracks = [{ path: path.join(cd1, '1.flac') }, { path: path.join(disc2, '1.flac') }, { path: path.join(other, '1.flac') }];
    const files = { [album]: ['Cover.JPG', 'CD1', 'Disc 2'], [cd1]: ['1.flac'], [disc2]: ['1.flac'], [path.join('m', 'Live')]: ['cover.jpg'], [other]: ['1.flac'] };
    const n = await fillFolderCovers(tracks, async (dir) => files[dir] || []);
    assert.equal(n, 2);
    assert.equal(tracks[0].albumArt, path.join(album, 'Cover.JPG'));
    assert.equal(tracks[1].albumArt, path.join(album, 'Cover.JPG'));
    assert.equal(tracks[2].albumArt, undefined); // 不是碟号文件夹，不往上找
});
