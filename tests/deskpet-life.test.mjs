import test from 'node:test';
import assert from 'node:assert/strict';
import { createPetLife, LIFE_TIMINGS } from '../DeskPetmodules/petLife.js';
import { createLifeMotion } from '../DeskPetmodules/lifeMotion.js';

// 假时钟 + 固定随机数，按 250ms 一拍往前走（与页面的定时器一致）
function rig(timings = {}) {
    let clock = 0;
    const log = { actions: [], phases: [], gazes: [] };
    const life = createPetLife({
        now: () => clock,
        random: () => 0.5,
        timings,
        onAction: (a) => log.actions.push(a.name),
        onPhase: (p) => log.phases.push(p),
        onGaze: (g) => log.gazes.push(g),
    });
    const advance = (ms) => {
        const end = clock + ms;
        while (clock < end) {
            clock = Math.min(end, clock + 250);
            life.tick();
        }
    };
    return { life, log, advance, at: () => clock };
}

test('left alone, the pet does small idle moves, then yawns, dozes and falls asleep', () => {
    const { life, log, advance } = rig();
    advance(LIFE_TIMINGS.microMaxMs + 1000);
    assert.ok(log.actions.length >= 1, 'did at least one idle move');
    assert.ok(log.actions.every((n) => ['lookAround', 'tilt', 'stretch', 'hum'].includes(n)));
    assert.equal(life.phase, 'awake');

    advance(LIFE_TIMINGS.drowsyAfterMs);
    assert.equal(life.phase, 'drowsy');
    assert.equal(log.actions.at(-1) === 'yawn' || log.actions.includes('yawn'), true);

    advance(LIFE_TIMINGS.sleepAfterMs + 500);
    assert.equal(life.phase, 'asleep');
    assert.deepEqual(log.phases, ['drowsy', 'asleep']);
    // 睡着时视线垂下来，不再自己游走
    assert.deepEqual(life.gaze, { x: 0, y: -0.6 });
    const before = log.actions.length;
    advance(60000);
    assert.equal(log.actions.length, before, 'no idle moves while asleep');
});

test('idle moves do not repeat back to back', () => {
    const { log, advance } = rig({ microMinMs: 1000, microMaxMs: 1000, drowsyAfterMs: 1e9 });
    advance(30000);
    for (let i = 1; i < log.actions.length; i++) assert.notEqual(log.actions[i], log.actions[i - 1]);
});

test('a reply, an open composer or a drag keep it awake', () => {
    const { life, advance } = rig();
    life.hold('reply', true);
    advance(LIFE_TIMINGS.drowsyAfterMs * 2);
    assert.equal(life.phase, 'awake');
    life.hold('reply', false);
    // 说完以后重新计时
    advance(LIFE_TIMINGS.drowsyAfterMs - 1000);
    assert.equal(life.phase, 'awake');
    advance(2000);
    assert.equal(life.phase, 'drowsy');
});

test('hidden pets freeze: no moves and no sleep progress', () => {
    const { life, log, advance } = rig();
    life.hold('hidden', true);
    advance(LIFE_TIMINGS.drowsyAfterMs + LIFE_TIMINGS.sleepAfterMs + 10000);
    assert.equal(life.phase, 'awake');
    assert.deepEqual(log.actions, []);
});

test('waking up: a tap or a reply startles, wandering cursor wakes slowly, stroking the head does not wake', () => {
    const { life, log } = rig();
    life.force('asleep');
    assert.equal(life.tap({ onHead: false }), 'startle');
    assert.equal(life.phase, 'awake');

    life.force('asleep');
    life.hold('reply', true);
    assert.equal(log.actions.at(-1), 'startle');
    life.hold('reply', false);

    life.force('asleep');
    // 头上来回蹭：在梦里笑，不醒
    let x = 100;
    let result = null;
    for (let i = 0; i < 12; i++) {
        x += i % 2 ? -30 : 30;
        result = life.cursor({ x, y: 50, onHead: true }) || result;
    }
    assert.equal(life.phase, 'asleep');
    assert.equal(result, 'sleepPat');

    // 光标在别处晃够距离才醒，而且是慢慢醒
    assert.equal(life.cursor({ x: 10, y: 300 }), null);
    assert.equal(life.cursor({ x: 30, y: 300 }), null);
    assert.equal(life.cursor({ x: 80, y: 300 }), 'woke');
    assert.equal(log.actions.at(-1), 'wake');
});

test('cursor outside the window never wakes it', () => {
    const { life } = rig();
    life.force('asleep');
    for (let i = 0; i < 20; i++) life.cursor({ x: -200 - i * 40, y: 10, inside: false });
    assert.equal(life.phase, 'asleep');
});

test('rapid taps: third tap gets annoyed, sixth gets dizzy, and single-tap joy is suppressed', () => {
    const { life, log } = rig();
    assert.equal(life.tapDown(), 1);
    assert.equal(life.tapDown(), 2);
    assert.equal(life.tapDown(), 3);
    assert.equal(log.actions.at(-1), 'annoyed');
    assert.equal(life.tap(), null);
    life.tapDown();
    life.tapDown();
    life.tapDown();
    assert.equal(log.actions.at(-1), 'dizzy');
});

test('taps spaced out are single pokes; head taps are head taps', () => {
    let clock = 0;
    const names = [];
    const life = createPetLife({ now: () => clock, random: () => 0.5, onAction: (a) => names.push(a.name) });
    life.tapDown();
    assert.equal(life.tap({ onHead: false }), 'poke');
    clock += 2000;
    life.tapDown();
    assert.equal(life.tap({ onHead: true }), 'headTap');
    assert.deepEqual(names, ['poke', 'headTap']);
});

test('stroking back and forth over the head is a pat; one pass is not', () => {
    let clock = 0;
    const names = [];
    const life = createPetLife({ now: () => clock, random: () => 0.5, onAction: (a) => names.push(a.name) });
    for (let x = 100; x <= 160; x += 10) { clock += 50; life.cursor({ x, y: 40, onHead: true }); }
    assert.deepEqual(names, []);
    let x = 160;
    for (let i = 0; i < 4; i++) {
        for (let k = 0; k < 4; k++) { clock += 50; x += i % 2 ? 10 : -10; life.cursor({ x, y: 40, onHead: true }); }
    }
    assert.ok(names.includes('pat'));
});

test('gaze follows the cursor while it moves and wanders once it stops', () => {
    const { life, advance } = rig({ drowsyAfterMs: 1e9 });
    life.cursor({ x: 10, y: 10 });
    advance(500);
    assert.equal(life.gaze, null);
    advance(LIFE_TIMINGS.gazeIdleMs + 500);
    assert.ok(life.gaze && Math.abs(life.gaze.x) <= 1 && Math.abs(life.gaze.y) <= 1);
    life.cursor({ x: 60, y: 60 });
    assert.equal(life.gaze, null);
});

test('drowsy pet perks up quietly when the cursor comes by', () => {
    const { life, log } = rig();
    life.force('drowsy');
    life.cursor({ x: 10, y: 10 });
    life.cursor({ x: 40, y: 10 });
    assert.equal(life.phase, 'awake');
    assert.ok(!log.actions.includes('startle'));
});

test('life motion: asleep closes the eyes and droops the head; awake returns to rest', () => {
    const motion = createLifeMotion({ random: () => 0.5 });
    motion.setPhase('asleep');
    let out;
    for (let i = 0; i < 120; i++) out = motion.step(1 / 30);
    assert.ok(out.params.ParamEyeLOpen < -0.9);
    assert.ok(out.params.ParamAngleY < -14);
    motion.setPhase('awake');
    for (let i = 0; i < 120; i++) out = motion.step(1 / 30);
    assert.ok(Math.abs(out.params.ParamEyeLOpen || 0) < 0.05);
    assert.ok(motion.settled);
});

test('life motion: actions play out and end, hops go up, drag swings opposite to motion and settles', () => {
    const motion = createLifeMotion({ random: () => 0.5 });
    motion.play('startle', 1000);
    let maxHop = 0;
    let out;
    for (let i = 0; i < 40; i++) { out = motion.step(1 / 30); maxHop = Math.max(maxHop, out.hop); }
    assert.ok(maxHop > 20);
    assert.equal(out.hop, 0);
    assert.ok(motion.settled);

    motion.setHeld(true);
    motion.dragVelocity(900); // 往右拖
    for (let i = 0; i < 20; i++) out = motion.step(1 / 30);
    assert.ok(out.swing < -5, `swing ${out.swing}`);
    motion.setHeld(false);
    for (let i = 0; i < 150; i++) out = motion.step(1 / 30);
    assert.ok(Math.abs(out.swing) < 0.5);
});

test('life motion: a model with its own motion file only gets a light overlay', () => {
    const full = createLifeMotion({ random: () => 0.5 });
    const light = createLifeMotion({ random: () => 0.5 });
    full.play('annoyed', 2000);
    light.play('annoyed', 2000, { weight: 0.4 });
    let a, b;
    for (let i = 0; i < 15; i++) { a = full.step(1 / 30); b = light.step(1 / 30); }
    assert.ok(Math.abs(b.params.ParamMouthForm) < Math.abs(a.params.ParamMouthForm) * 0.5);
});
