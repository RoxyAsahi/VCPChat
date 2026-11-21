// 独占模式打不开、选的声卡被拔掉时，引擎会自己退回共享模式 / 默认设备继续放。
// 以前界面照旧显示「独占」「某某声卡」，用户以为在用独占输出；现在设备下面要说清实际在用什么。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ engineState } = {}) {
    const note = { textContent: '', hidden: true };
    const context = vm.createContext({
        console, setTimeout, clearTimeout,
        document: { getElementById: (id) => (id === 'output-fallback-note' ? note : null), createElement: () => ({}) }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules/music-output.js'), 'utf8'), context);
    const app = {
        deviceSelect: { value: 'default', disabled: false, innerHTML: '', appendChild() {} },
        wasapiSwitch: { checked: true, disabled: false },
        currentDeviceId: null, useWasapiExclusive: false,
        api: {
            configureMusicOutput: async () => ({ status: 'success', state: engineState }),
            getMusicState: async () => ({ status: 'success', state: engineState }),
            getMusicDevices: async () => ({ status: 'success', devices: { preferred: [], other: [] } })
        }
    };
    context.setupOutput(app);
    return { app, note };
}

test('turning on exclusive mode that the device refuses says it is playing shared', async () => {
    const { app, note } = setup({ engineState: { exclusive_mode: true, output_fallback: ['exclusive'] } });
    await app.configureOutput();
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /独占模式没能打开.*共享模式/);
});

test('a missing device says the default one is playing', () => {
    const { app, note } = setup();
    app.syncOutputFallback({ output_fallback: ['device'] });
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /默认设备/);
});

test('once exclusive mode is switched off the exclusive note goes away', () => {
    const { app, note } = setup();
    app.syncOutputFallback({ output_fallback: ['exclusive'] });
    app.wasapiSwitch.checked = false;
    app.syncOutputFallback({ output_fallback: ['exclusive'] });
    assert.equal(note.hidden, true);
});

test('an old engine without the field shows nothing', () => {
    const { app, note } = setup();
    app.syncOutputFallback({ exclusive_mode: true });
    assert.equal(note.hidden, true);
    assert.equal(note.textContent, '');
});

test('the window asks the engine where the sound actually went after play starts', () => {
    const player = fs.readFileSync(path.join(__dirname, '../Musicmodules/music-player.js'), 'utf8');
    const music = fs.readFileSync(path.join(__dirname, '../Musicmodules/music.js'), 'utf8');
    assert.match(player, /app\.startStatePolling\(\);\s*app\.checkOutputFallbackSoon\?\.\(\);/);
    assert.match(music, /app\.updateUIWithState = \(state, options = \{\}\) => \{\s*if \(!state\) return;\s*app\.syncOutputFallback\?\.\(state\);/);
    const html = fs.readFileSync(path.join(__dirname, '../Musicmodules/music.html'), 'utf8');
    assert.match(html, /id="output-fallback-note"[^>]*hidden/);
});
