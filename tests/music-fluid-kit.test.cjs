const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function setup({ reduce = false, low = false } = {}) {
    const dom = new JSDOM(`<!doctype html><body class="${reduce ? 'music-reduce-motion' : ''}"><div id="music-dock-root" class="${low ? 'md-fl-low' : 'md-fl-on'}"></div><div class="menu" style="position:fixed"></div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom;
    let now = 0;
    const frames = [];
    window.performance.now = () => now;
    window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
    window.cancelAnimationFrame = () => {};
    window.eval(fs.readFileSync(path.join(ROOT, 'Musicmodules/music-dock/music-fluid-kit.js'), 'utf8'));
    const menu = window.document.querySelector('.menu');
    menu.getBoundingClientRect = () => ({ left: 100, top: 200, width: 220, height: 300, right: 320, bottom: 500 });
    const run = (ms) => { now += ms; const due = frames.splice(0); due.forEach((fn) => fn()); };
    return { window, doc: window.document, menu, run };
}

test('a menu grows out of the point it was opened from, then the liquid layer is removed', async () => {
    const { window, doc, menu, run } = setup();
    assert.equal(window.MusicFluid.enabled(), true);
    const done = window.MusicFluid.bud(menu, { x: 110, y: 205 });
    assert.ok(menu.classList.contains('mf-budding'), 'content waits for the liquid');
    const goo = doc.querySelector('svg.mf-goo');
    assert.ok(goo, 'a temporary liquid layer is drawn');
    assert.equal(goo.querySelector('circle').getAttribute('cx'), '110.0', 'the drop sits on the opening point');
    run(150);
    const w1 = Number(goo.querySelector('rect').getAttribute('width'));
    assert.ok(w1 > 28 && w1 < 220, 'the body is still growing');
    run(150);
    assert.ok(!menu.classList.contains('mf-budding'), 'content shows before the liquid finishes');
    run(200);
    await done;
    assert.equal(doc.querySelector('svg.mf-goo'), null, 'nothing is left drawing afterwards');
});

test('opening again mid-way cancels the first growth instead of stacking layers', () => {
    const { window, doc, menu, run } = setup();
    window.MusicFluid.bud(menu, { x: 110, y: 205 });
    run(100);
    window.MusicFluid.bud(menu, { x: 300, y: 480 });
    assert.equal(doc.querySelectorAll('svg.mf-goo').length, 1);
    run(600);
    assert.equal(doc.querySelectorAll('svg.mf-goo').length, 0);
});

test('reduced motion and the low quality tier skip the liquid entirely', async () => {
    for (const opts of [{ reduce: true }, { low: true }]) {
        const { window, doc, menu } = setup(opts);
        assert.equal(window.MusicFluid.enabled(), false);
        await window.MusicFluid.bud(menu, { x: 110, y: 205 });
        assert.equal(doc.querySelector('svg.mf-goo'), null);
        assert.ok(!menu.classList.contains('mf-budding'));
    }
});

test('a selection marker flows to its new place: the leading edge arrives first, the trailing edge follows', () => {
    const { window, doc, run } = setup();
    const mark = doc.createElement('i');
    doc.body.appendChild(mark);
    window.MusicFluid.slide(mark, { left: 0, width: 40 }, { key: 'tabs' });
    assert.equal(parseFloat(mark.style.left), 0, 'first placement is instant');
    const fresh = doc.createElement('i'); // 那一排重画了，标记是新元素
    doc.body.appendChild(fresh);
    window.MusicFluid.slide(fresh, { left: 200, width: 40 }, { key: 'tabs' });
    run(120);
    const left = parseFloat(fresh.style.left), width = parseFloat(fresh.style.width);
    assert.ok(left > 0 && left < 200, 'still on its way');
    assert.ok(width > 40, `stretched while moving (${width})`);
    run(400);
    assert.equal(parseFloat(fresh.style.left), 200);
    assert.equal(parseFloat(fresh.style.width), 40);
});
