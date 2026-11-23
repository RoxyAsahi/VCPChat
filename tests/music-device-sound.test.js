const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// 按输出设备记住 EQ：第一次见到的设备记下当前设置，换回见过的设备时套用它上次的 EQ。
const { setupMusicDeviceSound, sameProfile } = require(path.join(__dirname, '../Musicmodules/music-device-sound.js'));

function setup() {
    const store = new Map();
    const sliders = {};
    const toasts = [];
    globalThis.document = { getElementById: (id) => sliders[id] || null };
    globalThis.MusicToast = { show: (t) => toasts.push(t.message) };
    const app = {
        eqBands: { '31': 0, '1k': 0 },
        eqSwitch: { checked: false },
        sent: [],
        updateUIWithState() {},
        sendEqSettings() { app.sent.push({ on: app.eqSwitch.checked, b31: Number(sliders['eq-31'].value) }); return Promise.resolve({ status: 'success' }); }
    };
    sliders['eq-31'] = { value: '0' };
    sliders['eq-1k'] = { value: '0' };
    setupMusicDeviceSound(app, { storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
    return { app, sliders, toasts, store };
}

test('each output device gets its own EQ back', async () => {
    const { app, sliders, toasts } = setup();
    app.updateUIWithState({ output_device: 'Speakers' });
    // 在音箱上开 EQ、低音 +6
    app.eqSwitch.checked = true; sliders['eq-31'].value = '6'; app.sendEqSettings();
    // 插上耳机：没见过，沿用当前设置
    app.updateUIWithState({ output_device: 'Headphones' });
    assert.equal(toasts.length, 0);
    // 耳机上关掉 EQ
    app.eqSwitch.checked = false; sliders['eq-31'].value = '0'; app.sendEqSettings();
    // 回到音箱：套回 +6
    app.updateUIWithState({ output_device: 'Speakers' });
    await Promise.resolve();
    assert.equal(sliders['eq-31'].value, '6');
    assert.equal(app.eqSwitch.checked, true);
    assert.match(toasts[0], /Speakers/);
    assert.deepEqual(app.sent[app.sent.length - 1], { on: true, b31: 6 });
    // 再回耳机：关着
    app.updateUIWithState({ output_device: 'Headphones' });
    assert.equal(app.eqSwitch.checked, false);
    assert.equal(app.deviceSound.device, 'Headphones');
});

test('turning it off stops switching; old engines without a device name do nothing', () => {
    const { app, sliders } = setup();
    app.updateUIWithState({});
    assert.equal(app.deviceSound.device, null);
    app.updateUIWithState({ output_device: 'A' });
    app.deviceSound.enabled = false;
    sliders['eq-31'].value = '3'; app.sendEqSettings();
    app.updateUIWithState({ output_device: 'B' });
    app.updateUIWithState({ output_device: 'A' });
    assert.equal(sliders['eq-31'].value, '3');
    assert.equal(sameProfile({ enabled: true, bands: { a: 1 } }, { enabled: true, bands: { a: 1, b: 0 } }), true);
});
