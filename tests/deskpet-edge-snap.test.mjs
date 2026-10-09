import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SNAP_DIP, snapPosition, snapFrames } = require('../modules/deskpet/edgeSnap.js');

const area = { x: 0, y: 0, width: 1600, height: 960 };
const figure = { x: 50, y: 120, width: 220, height: 400 };

test('the figure, not the transparent window, snaps to the left, right and bottom edges', () => {
    assert.deepEqual(snapPosition({ x: -40, y: 100, width: 320, height: 580 }, figure, area), { x: -50, y: 100, edges: ['left'] });
    // 右边：角色右沿离屏幕右边 12
    const right = snapPosition({ x: 1600 - 270 - 12, y: 100, width: 320, height: 580 }, figure, area);
    assert.deepEqual(right, { x: 1600 - 270, y: 100, edges: ['right'] });
    // 脚底落到任务栏上（工作区底边），角落里两条边一起
    const corner = snapPosition({ x: -45, y: 960 - 520 + 15, width: 320, height: 580 }, figure, area);
    assert.deepEqual(corner, { x: -50, y: 960 - 520, edges: ['left', 'bottom'] });
});

test('far from every edge, or pushed well past one, nothing moves', () => {
    assert.equal(snapPosition({ x: 600, y: 200, width: 320, height: 580 }, figure, area), null);
    assert.equal(snapPosition({ x: -50 - SNAP_DIP - 30, y: 200, width: 320, height: 580 }, figure, area), null);
    assert.equal(snapPosition({ x: 0, y: 0, width: 320, height: 580 }, null, area), null);
    assert.equal(snapPosition({ x: 0, y: 0, width: 320, height: 580 }, { x: 0, y: 0, width: 0, height: 10 }, area), null);
});

test('a second display with a negative origin works the same', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1040 };
    assert.deepEqual(snapPosition({ x: -1920 - 50 + 8, y: 300, width: 320, height: 580 }, figure, left), { x: -1970, y: 300, edges: ['left'] });
});

test('the slide eases out and ends exactly on the target', () => {
    const frames = snapFrames({ x: 0, y: 0 }, { x: -30, y: 12 });
    assert.equal(frames.length, 6);
    assert.deepEqual(frames.at(-1), { x: -30, y: 12 });
    assert.ok(Math.abs(frames[0].x) > Math.abs(frames[1].x - frames[0].x) / 2, 'fast first, slow last');
});
