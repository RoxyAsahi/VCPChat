// 声音页的文案和联动：开关名要说清它做什么，打开的开关要真的起作用。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('Musicmodules/music.html', 'utf8');
const musicJs = fs.readFileSync('Musicmodules/music.js', 'utf8');

function effects(extra = {}) {
    const section = { classList: { on: new Set(), toggle(c, v) { v ? this.on.add(c) : this.on.delete(c); } } };
    const app = {
        loudnessLufsSlider: { value: '-14' }, loudnessLufsValue: { textContent: '' },
        ditherSwitch: { checked: false }, outputBitsSelect: { disabled: false }, noiseShaperCurveSelect: { disabled: false },
        ...extra,
    };
    const context = { app, document: { getElementById: (id) => (id === 'noise-shaper-section' ? section : null) } };
    vm.runInNewContext(fs.readFileSync('Musicmodules/music-effects.js', 'utf8') + '\nsetupEffects(app);', context);
    return { app, section };
}

test('the ReplayGain switch is named for what it does, not "动态增益"', () => {
    const label = html.match(/<label for="replaygain-switch"[^>]*>([^<]*)<\/label>/)[1];
    assert.notEqual(label, '动态增益');
    assert.match(label, /ReplayGain/);
});

test('turning ReplayGain on also turns loudness normalization on', () => {
    const handler = musicJs.match(/app\.replaygainSwitch\.onchange = \(\) => \{([\s\S]*?)\n        \};/)[1];
    assert.match(handler, /app\.loudnessSwitch\.checked = true/);
});

test('loudness modes are the ones the engine tells apart; old saved modes map onto them', () => {
    const select = html.match(/<select id="loudness-mode-select"[\s\S]*?<\/select>/)[0];
    const values = [...select.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(values, ['track', 'replaygain_track', 'replaygain_album']);
    const aliases = musicJs.match(/LOUDNESS_MODE_ALIASES = Object\.freeze\((\{[^}]*\})\)/)[1];
    const map = vm.runInNewContext('(' + aliases + ')');
    assert.equal(map.album, 'replaygain_album');
    assert.equal(map.streaming, 'track');
    assert.match(musicJs, /app\.loudnessModeSelect\.value = app\.loudnessMode;/);
});

test('the loudness target shows its unit', () => {
    const { app } = effects();
    app.updateLoudnessLufsDisplay();
    assert.equal(app.loudnessLufsValue.textContent, '-14 LUFS');
});

test('noise shaping controls go inactive while dither is off', () => {
    const { app, section } = effects();
    app.syncDitherSection();
    assert.equal(app.outputBitsSelect.disabled, true);
    assert.equal(app.noiseShaperCurveSelect.disabled, true);
    assert.ok(section.classList.on.has('is-inactive'));
    app.ditherSwitch.checked = true;
    app.syncDitherSection();
    assert.equal(app.outputBitsSelect.disabled, false);
    assert.ok(!section.classList.on.has('is-inactive'));
});

test('noise shaper curves and bit depth read in words; 24-bit is the default like the engine', () => {
    const curve = html.match(/<select id="noise-shaper-curve-select"[\s\S]*?<\/select>/)[0];
    for (const cryptic of ['>F-W<', '>Mod E<', '>Imp E<']) assert.ok(!curve.includes(cryptic), cryptic);
    assert.match(html, /<option value="24" selected>24-bit<\/option>/);
});
