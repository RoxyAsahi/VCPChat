/*
 * 档案卡面左侧文字栏的断行：按宽度断、拉丁字母在空格处断、最多 N 行、最后一行省略号收尾。
 * 用一个「每个字宽 10」的假 measureText，结果和字体无关。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { wrapText } = require('../Musicmodules/music-archive/archive-caption.js');

const ctx = { measureText: (s) => ({ width: Array.from(s).length * 10 }) };

test('短名一行放下，不加省略号', () => {
    assert.deepEqual(wrapText(ctx, '海の見える街', 100, 3), ['海の見える街']);
});

test('拉丁字母在空格处断行', () => {
    assert.deepEqual(wrapText(ctx, 'Fly Me to the Moon', 100, 3), ['Fly Me to', 'the Moon']);
});

test('超过行数时最后一行用省略号收尾，且不超宽', () => {
    const lines = wrapText(ctx, 'Fly Me to the Moon (Yoko Takahashi Version) [Remastered]', 100, 3);
    assert.equal(lines.length, 3);
    assert.ok(lines[2].endsWith('…'));
    for (const line of lines) assert.ok(Array.from(line).length * 10 <= 100, line);
});

test('中文没有空格也能按宽度断', () => {
    assert.deepEqual(wrapText(ctx, '一二三四五六七八九十甲乙', 50, 3), ['一二三四五', '六七八九十', '甲乙']);
});

test('空值返回空数组', () => {
    assert.deepEqual(wrapText(ctx, '', 100, 3), []);
    assert.deepEqual(wrapText(ctx, null, 100, 3), []);
});
