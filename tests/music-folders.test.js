const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 曲库文件夹：加过的文件夹在前并计数，其余的歌按位置归并。
const { folderRows, underDir } = require(path.join(__dirname, '../Musicmodules/music-folders.js'));
const { createLibraryWatch } = require(path.join(__dirname, '../modules/musicLibraryWatch.js'));

test('underDir is case-insensitive and does not match name prefixes', () => {
    assert.equal(underDir('D:\\Music\\a.flac', 'd:/music'), true);
    assert.equal(underDir('D:\\Music2\\a.flac', 'D:\\Music'), false);
});

test('folderRows counts remembered folders and merges the rest by parent', () => {
    const t = (p) => ({ path: p });
    const rows = folderRows([{ path: 'D:\\Music', exists: true }, { path: 'E:\\Gone', exists: false }], [
        t('D:\\Music\\A\\1.flac'), t('D:\\Music\\B\\2.flac'),
        t('F:\\Down\\Aki\\x.flac'), t('F:\\Down\\Aki\\y.flac'), t('F:\\Down\\Ren\\z.flac'), t('F:\\Down\\w.flac'),
        t('G:\\One\\q.flac'),
        t('https://dav/x.flac')
    ]);
    assert.deepEqual(rows, [
        { path: 'D:\\Music', count: 2, remembered: true, exists: true },
        { path: 'E:\\Gone', count: 0, remembered: true, exists: false },
        { path: 'F:\\Down', count: 4, remembered: false, exists: true },
        { path: 'G:\\One', count: 1, remembered: false, exists: true }
    ]);
});

test('forgetFolder drops the folder and its subfolders from the remembered list', async () => {
    let saved = ['D:\\Music', 'D:\\Music\\Sub', 'E:\\Other'];
    const w = createLibraryWatch({ scan: async () => ({ tracks: [] }), readKnown: async () => [], readFolders: async () => saved, writeFolders: async (l) => { saved = l; }, send: () => {} });
    assert.equal(await w.forgetFolder('d:\\music'), true);
    assert.deepEqual(saved, ['E:\\Other']);
    assert.deepEqual(await w.folders(), ['E:\\Other']);
    assert.equal(await w.forgetFolder('X:\\none'), false);
});
