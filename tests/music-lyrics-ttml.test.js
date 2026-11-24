const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// TTML 逐字歌词：词间空格、实体、行内/头部翻译、和声；逐字均分时英文词之间留空格。
const { parseTTML, parseLRC } = require(path.join(__dirname, '../modules/lyrics/parserCore.js'));

const APPLE = `<tt xmlns:itunes="x" xmlns:ttm="y"><head><metadata><iTunesMetadata><translations>`
    + `<translation xml:lang="en"><text for="L1">EN</text></translation>`
    + `<translation xml:lang="zh-Hans"><text for="L1">你好，世界</text></translation></translations>`
    + `<transliterations><transliteration xml:lang="ja-Latn"><text for="L3">yoru ni</text></transliteration></transliterations></iTunesMetadata></metadata></head>`
    + `<body><div><p begin="0:01.000" end="0:03.500" itunes:key="L1"><span begin="0:01.000" end="0:01.600">Hello</span> <span begin="0:01.600" end="0:02.200">world</span> `
    + `<span begin="0:02.200" end="0:03.000">&amp; you</span><span ttm:role="x-bg"><span begin="0:03.000" end="0:03.400">ooh</span></span></p>`
    + `<p begin="4.5s" end="6s"><span begin="4.5s" end="5s">They</span> <span begin="5s" end="6s">say</span><span ttm:role="x-translation">他们说</span></p>`
    + `<p begin="00:00:07.000" end="00:00:08.000" itunes:key="L3">\n   <span begin="00:00:07.000" end="00:00:07.500">夜</span>\n   <span begin="00:00:07.500" end="00:00:08.000">に</span>\n</p>`
    + `</div></body></tt>`;

test('TTML keeps spaces between words, decodes entities and reads translations', () => {
    const { lines, isWordByWord } = parseTTML(APPLE);
    assert.equal(isWordByWord, true);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].fullText, 'Hello world & you (ooh)');
    assert.deepEqual(lines[0].words.map((w) => w.text), ['Hello ', 'world ', '& you ', '(ooh)']);
    assert.equal(lines[0].translation, '你好，世界', 'Chinese head translation preferred');
    assert.equal(lines[1].translation, '他们说');
    assert.equal(lines[1].startTime, 4.5);
    assert.equal(lines[1].endTime, 6);
    assert.equal(lines[2].fullText, '夜に', 'indentation between spans is not a space');
    assert.equal(lines[2].romanization, 'yoru ni');
});

test('TTML lines without word timing fall back to even split; bad times are skipped', () => {
    const { lines } = parseTTML('<tt><body><p begin="9" end="10">plain &lt;text&gt;</p><p begin="x" end="y"><span>bad</span></p></body></tt>');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].words.map((w) => w.text).join(''), 'plain <text>');
});

test('simulated word timing keeps the spaces of the original line', () => {
    const { lines } = parseLRC('[00:01.00]Hello big world\n[00:03.00]你好 world');
    assert.deepEqual(lines[0].words.map((w) => w.text), ['Hello ', 'big ', 'world']);
    assert.equal(lines[1].words.map((w) => w.text).join(''), '你好 world');
});
