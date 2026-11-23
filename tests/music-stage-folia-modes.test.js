const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = global;
window.matchMedia = () => ({ matches: false });
const stage = path.resolve(__dirname, '..', 'Musicmodules', 'music-stage');
require(path.join(stage, 'music-stage-runtime.js'));
require(path.join(stage, 'modes', 'stage-mode-utils.js'));
require(path.join(stage, 'modes', 'inkdraft-figures.js'));
require(path.join(stage, 'modes', 'inkdraft-manager.js'));
const { buildCues, findCue, glyphUnits, viewAt, blobsAt } = window.MusicStageInkdraftManager._test;
const lines = window.MusicStageRuntime.normalizeLines([
    { time: 10, original: '清晨的站台还没有人' },
    { time: 14, original: 'I will follow the light' },
    { time: 18, original: '……' },
    { time: 40, original: '长间奏之后' }
]);

test('cues tile the song without gaps: lines, interludes, a long break split up', () => {
    const cues = buildCues(lines, 120);
    assert.equal(cues[0].start, 0);
    assert.equal(cues[0].kind, 'rest');
    assert.ok(cues[0].title, 'the first interlude carries the title');
    for (let i = 1; i < cues.length; i += 1) assert.ok(Math.abs(cues[i].start - cues[i - 1].end) < 1e-9, `gap before cue ${i}`);
    assert.ok(!cues.some(c => c.kind === 'line' && c.line.fullText === '……'), 'punctuation-only lines are interlude');
    assert.ok(cues.at(-1).end >= 120);
    assert.equal(cues[findCue(cues, 15)].line.fullText, 'I will follow the light');
    assert.equal(findCue(cues, 0), 0);
});

test('no lyrics: the whole song is interlude parts of about twenty seconds', () => {
    const cues = buildCues([], 200);
    assert.ok(cues.length >= 9 && cues.every(c => c.kind === 'rest'));
    assert.ok(cues.at(-1).end >= 720);
});

test('words become units; spaces separate latin words', () => {
    const cue = buildCues(lines, 120).find(c => c.kind === 'line' && c.line.fullText.startsWith('I will'));
    const units = glyphUnits(cue, '');
    assert.deepEqual(units.map(u => u.glyphs.map(g => g.text).join('')), ['I', 'will', 'follow', 'the', 'light']);
    assert.ok(units.every(u => u.end >= u.start));
});

test('the camera and the ink are pure functions of time', () => {
    const plan = { shots: [{ start: 0, end: 4, type: 'wide', drift: [0.2, -0.1], roll: 0, neg: false }], closeH: 300, close: [], macro: [], wideH: 900, wideC: [1000, 600], W: 2048, H: 1152 };
    assert.deepEqual(viewAt(plan, 1.5), viewAt(plan, 1.5));
    const cue = { cue: { start: 0 }, mass: null, accents: [], collisions: [{ t: 2, x: 500, y: 500, angle: 0.3, dist: 120, r: 20, spin: 1.7, fragments: 7 }] };
    const out = new Float32Array(96), rings = new Float32Array(8), acc = new Float32Array(12);
    const before = blobsAt(cue, 1, out, rings, acc, 0);
    assert.equal(before.blobs, 2, 'two balls approach');
    const after = blobsAt(cue, 2.4, out, rings, acc, 0);
    assert.ok(after.blobs > 7 && rings[3] > 0, 'fragments and a shock ring after the hit');
    assert.equal(blobsAt(cue, 6, out, rings, acc, 0).blobs, 0, 'gone afterwards');
});

require(path.join(stage, 'modes', 'fogpane-manager.js'));
test('fogpane: every sung line gets a place on the window, and fogs over before the third line after it', () => {
    const { planSong } = window.MusicStageFogpaneManager._test;
    const many = window.MusicStageRuntime.normalizeLines(Array.from({ length: 12 }, (_, i) => ({ time: 5 + i * 4, original: `第${i}句歌词写在车窗上` })));
    const plan = planSong(many, 960, 540, 1, (text, size) => size * text.length, 'k');
    assert.equal(plan.length, 12);
    plan.forEach((p, i) => {
        assert.ok(p.items.length > 0);
        assert.ok(p.box[0] >= 0 && p.box[2] <= 960 * 1.05 && p.box[1] >= 0 && p.box[3] <= 540, `line ${i} stays on the window`);
        assert.ok(p.fogBack >= p.end + 0.3 - 1e-9);
        if (plan[i + 3]) assert.ok(p.fogBack <= plan[i + 3].start, 'at most three lines on the glass');
    });
    assert.deepEqual(planSong(many, 960, 540, 1, (t, s) => s * t.length, 'k').map(p => p.box), plan.map(p => p.box), 'deterministic');
});

require(path.join(stage, 'modes', 'lumiere-manager.js'));
test('lumiere: cues tile the song, every four sung lines share one light rig, beams stay bounded', () => {
    const L = window.MusicStageLumiereManager._test;
    const many = window.MusicStageRuntime.normalizeLines(Array.from({ length: 10 }, (_, i) => ({ time: 5 + i * 3, original: `第${i + 1}句歌词` })));
    const cues = L.buildCues(many, 60, 'k');
    assert.equal(cues[0].start, 0);
    for (let i = 1; i < cues.length; i += 1) assert.ok(Math.abs(cues[i].start - cues[i - 1].end) < 1e-9, `gap before cue ${i}`);
    const sung = cues.filter(c => c.kind === 'line');
    assert.equal(sung.length, 10);
    assert.equal(sung[0].rig, sung[3].rig);
    assert.ok(sung[4].sectionStart && sung[4].rig !== sung[3].rig, 'a new section picks a different rig');
    assert.deepEqual(L.buildCues(many, 60, 'k').map(c => c.rig), cues.map(c => c.rig), 'deterministic');
    const colours = { warm: [1, 0.9, 0.7], cool: [0.6, 0.8, 1], accent: [1, 0.4, 0.5] };
    for (const rig of ['zenith', 'lattice', 'prism', 'stage', 'caustic', 'motes']) {
        const n = L.beamsAt(rig, 12.3, 40, colours, new Float32Array(20), new Float32Array(20));
        assert.ok(n >= 1 && n <= 5, rig);
    }
});

require(path.join(stage, 'modes', 'hanabi-manager.js'));
test('hanabi: every sung line launches a shell at its start, the show is deterministic and the active list stays bounded', () => {
    const H = window.MusicStageHanabiManager._test;
    const many = window.MusicStageRuntime.normalizeLines(Array.from({ length: 12 }, (_, i) => ({ time: 6 + i * 3, original: `第${i + 1}句歌词慢慢唱` })));
    const cues = H.buildCues(many, 90);
    const show = H.planShow(cues, 'k', 1);
    for (let i = 1; i < show.length; i += 1) assert.ok(show[i].t >= show[i - 1].t, 'sorted');
    cues.filter(c => c.kind === 'line').forEach((cue) => {
        assert.ok(show.some(b => Math.abs(b.t - cue.line.startTime) < 0.05 && b.launch > 0), `shell for line at ${cue.line.startTime}`);
    });
    assert.ok(show.some(b => b.t > 45), 'the closing interlude has a barrage');
    assert.deepEqual(H.planShow(cues, 'k', 1), show, 'deterministic');
    assert.ok(H.planShow(cues, 'k', 0.4).length < show.length, 'density thins the show');
    const out = new Int32Array(24);
    for (let t = 0; t < 90; t += 0.25) {
        const n = H.activeAt(show, t, out);
        assert.ok(n <= 24);
        for (let i = 0; i < n; i += 1) {
            const b = show[out[i]];
            assert.ok(t >= b.t - b.launch - 0.06 && t <= b.t + H.LIFE[b.kind], `burst ${out[i]} active at ${t}`);
        }
    }
});
