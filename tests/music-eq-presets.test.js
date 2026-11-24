const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// 自己的 EQ 预设：存、在预设下拉里出现、选中后能删、操作项不会被当成预设。
const MOD = path.join(__dirname, '../Musicmodules/music-eq-presets.js');

function setup(saved) {
    const dom = new JSDOM('<select id="eq-preset-select"></select><input id="eq-32" value="0"><input id="eq-64" value="0">');
    const g = globalThis;
    g.window = dom.window; g.document = dom.window.document; g.Event = dom.window.Event;
    const toasts = [];
    g.MusicToast = dom.window.MusicToast = { show: (t) => toasts.push(t) };
    delete require.cache[MOD];
    const { setupMusicEqPresets, cleanName } = require(MOD);
    const store = new Map(saved ? [['musicEqUserPresets', JSON.stringify(saved)]] : []);
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const sel = document.getElementById('eq-preset-select');
    const app = {
        eqBands: { 32: 0, 64: 0 },
        eqPresets: { balance: { 32: 0, 64: 0 }, rock: { 32: 4, 64: 4 } },
        eqPresetSelect: sel,
        sent: 0,
        sendEqSettings() { this.sent++; },
        applyEqPreset(name) { const p = this.eqPresets[name]; if (!p) return; for (const b in p) document.getElementById(`eq-${b}`).value = p[b]; this.sendEqSettings(); this.syncEqPresetSelect(); },
        populateEqPresets() { for (const k of Object.keys(this.eqPresets)) { if (k.startsWith('u:')) continue; const o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); } this.syncEqPresetSelect(); },
        syncEqPresetSelect() {
            const cur = { 32: Number(document.getElementById('eq-32').value), 64: Number(document.getElementById('eq-64').value) };
            const m = Object.keys(this.eqPresets).find((n) => n !== 'balance' || true ? (this.eqPresets[n][32] === cur[32] && this.eqPresets[n][64] === cur[64]) : false);
            sel.value = m || '';
        }
    };
    sel.addEventListener('change', () => app.applyEqPreset(sel.value));
    setupMusicEqPresets(app, { storage });
    app.populateEqPresets();
    return { app, sel, store, toasts, cleanName };
}
const pick = (sel, value) => { sel.value = value; sel.dispatchEvent(new window.Event('change', { bubbles: true })); };

test('saved presets show up in their own group and apply like built-ins', () => {
    const { app, sel } = setup([{ name: '耳机', bands: { 32: 3, 64: -2 } }]);
    assert.deepEqual([...sel.querySelectorAll('optgroup')[0].children].map((o) => o.textContent), ['耳机']);
    pick(sel, 'u:耳机');
    assert.equal(document.getElementById('eq-32').value, '3');
    assert.equal(sel.value, 'u:耳机');
    const del = [...sel.options].find((o) => o.value === '__eq-delete');
    assert.equal(del.textContent, '删除「耳机」');
    assert.equal(del.hidden, false);
});

test('save captures current sliders, overwrites same name, and the action item never reaches the preset handler', () => {
    const { app, sel, store } = setup();
    document.getElementById('eq-32').value = '5';
    app.syncEqPresetSelect();
    const sentBefore = app.sent;
    pick(sel, '__eq-save'); // 打开起名框，不会被当成预设去套用
    assert.equal(app.sent, sentBefore);
    assert.ok(document.querySelector('.music-eq-name'));
    app.eqUserPresets.save('  音箱 ');
    app.eqUserPresets.save('音箱');
    assert.deepEqual(JSON.parse(store.get('musicEqUserPresets')), [{ name: '音箱', bands: { 32: 5, 64: 0 } }]);
    assert.equal(sel.value, 'u:音箱');
});

test('delete removes the selected preset and can be undone', () => {
    const { app, sel, toasts } = setup([{ name: 'A', bands: { 32: 1, 64: 1 } }, { name: 'B', bands: { 32: 2, 64: 2 } }]);
    pick(sel, 'u:B');
    pick(sel, '__eq-delete');
    assert.deepEqual(app.eqUserPresets.list().map((p) => p.name), ['A']);
    assert.equal('u:B' in app.eqPresets, false);
    toasts.at(-1).action.run();
    assert.deepEqual(app.eqUserPresets.list().map((p) => p.name), ['A', 'B']);
});

test('cleanName trims and caps names', (t) => {
    const { cleanName } = setup();
    assert.equal(cleanName(' a\nb '), 'a b');
    assert.equal(cleanName('x'.repeat(40)).length, 24);
});

test('adversarial: broken storage, names with markup, and a full list blocks new names in the dialog', async () => {
    let s = setup('not json');
    assert.deepEqual(s.app.eqUserPresets.list(), []);
    s = setup([{ name: '' , bands: {} }, { name: 'ok', bands: null }, null, { name: '<b>"x"</b>', bands: { 32: 1 } }]);
    assert.deepEqual(s.app.eqUserPresets.list().map((p) => p.name), ['<b>"x"</b>']);
    assert.ok([...s.sel.options].some((o) => o.textContent === '<b>"x"</b>'));
    assert.equal(s.sel.querySelector('b'), null);
    const full = Array.from({ length: 16 }, (_, i) => ({ name: `p${i}`, bands: { 32: i, 64: 0 } }));
    s = setup(full);
    s.app.eqUserPresets.promptSave();
    const input = document.querySelector('.music-eq-name input');
    const ok = document.querySelector('.music-eq-name .dialog-btn.confirm');
    assert.equal(ok.disabled, true);
    assert.match(document.querySelector('.music-eq-name .music-dialog-msg').textContent, /已经存了 16 个/);
    input.value = 'p3';
    input.dispatchEvent(new window.Event('input'));
    assert.equal(ok.disabled, false); // 同名可以覆盖
    ok.click();
    assert.equal(s.app.eqUserPresets.list().length, 16);
});
