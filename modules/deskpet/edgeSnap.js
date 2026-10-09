// modules/deskpet/edgeSnap.js
// 贴边：拖到屏幕左右边或任务栏附近松手时，角色本身（不是透明窗口）贴齐那条边，脚底落在任务栏上。
// 故意拖出去一大截（只露半个身子）的不动；按住 Alt 松手也不吸。
// 纯函数，主进程和测试共用；坐标都是 DIP。

'use strict';

const SNAP_DIP = 24;

function isRect(r) {
    return r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
}

/**
 * win：窗口在屏幕上的位置和大小；figure：角色在窗口里的包围盒（页面量的）；area：这块屏的工作区。
 * 返回窗口该去的位置和贴上的边（没贴就是 null）。
 */
function snapPosition(win, figure, area, threshold = SNAP_DIP) {
    if (!isRect(win) || !isRect(figure) || !isRect(area)) return null;
    const left = win.x + figure.x;
    const right = left + figure.width;
    const bottom = win.y + figure.y + figure.height;
    const areaRight = area.x + area.width;
    const areaBottom = area.y + area.height;
    let dx = 0;
    let dy = 0;
    const edges = [];
    if (Math.abs(left - area.x) <= threshold) {
        dx = area.x - left;
        edges.push('left');
    } else if (Math.abs(areaRight - right) <= threshold) {
        dx = areaRight - right;
        edges.push('right');
    }
    if (Math.abs(areaBottom - bottom) <= threshold) {
        dy = areaBottom - bottom;
        edges.push('bottom');
    }
    if (!edges.length) return null;
    return { x: Math.round(win.x + dx), y: Math.round(win.y + dy), edges };
}

/** 从 from 滑到 to 的几帧（先快后慢），最后一帧正好是 to。 */
function snapFrames(from, to, count = 6) {
    const frames = [];
    for (let i = 1; i <= count; i += 1) {
        const t = 1 - (1 - i / count) ** 3;
        frames.push({ x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) });
    }
    return frames;
}

module.exports = { SNAP_DIP, snapPosition, snapFrames };
