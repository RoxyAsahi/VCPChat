// 形象的「实际轮廓」：按 alpha 找出不透明像素的包围盒和头的位置。
// 立绘四周常有一大圈透明边，Live2D 的画布底下也常空着一截；按轮廓摆，脚底才能贴着窗口底边，
// 气泡、角标才能跟着头走（全身像的头在窗口上部，Q 版的大头占了半个身子）。
//
// 纯函数，页面和测试共用。坐标都是像素，原点左上，y 向下。

const DEFAULT_THRESHOLD = 24; // 与按像素命中的阈值一致
const MAX_SAMPLES = 400000;   // 大图隔几个像素取一个，量一次不超过这么多点

/**
 * 量轮廓。pixels 是 RGBA 字节（Uint8Array / Uint8ClampedArray），width × height。
 * flipY：WebGL readPixels 读出来的行是从下往上的。
 * 返回 null 表示一个不透明像素都没有；否则
 *   { left, top, right, bottom, head: { x, y, width } }（right、bottom 不含）。
 * 头：从头顶往下 2%–10% 那几行的中点是头的中线，头顶往下 15% 以内最宽的一行是头宽（长发、双马尾算进去）。
 */
export function measureSilhouette(pixels, width, height, { flipY = false, threshold = DEFAULT_THRESHOLD } = {}) {
    if (!pixels || !(width > 0) || !(height > 0)) return null;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / MAX_SAMPLES)));
    const rowLeft = [];
    const rowRight = [];
    let top = -1, bottom = -1, left = width, right = -1;
    for (let y = 0; y < height; y += step) {
        const row = flipY ? height - 1 - y : y;
        const base = row * width * 4 + 3;
        let l = -1, r = -1;
        for (let x = 0; x < width; x += step) {
            if (pixels[base + x * 4] >= threshold) {
                if (l < 0) l = x;
                r = x;
            }
        }
        rowLeft.push(l);
        rowRight.push(r);
        if (l < 0) continue;
        if (top < 0) top = y;
        bottom = y;
        if (l < left) left = l;
        if (r > right) right = r;
    }
    if (top < 0) return null;
    const box = { left, top, right: Math.min(width, right + step), bottom: Math.min(height, bottom + step) };
    const h = box.bottom - box.top;
    let sum = 0, count = 0, headWidth = 0;
    for (let i = 0; i < rowLeft.length; i++) {
        const y = i * step;
        if (rowLeft[i] < 0 || y < box.top) continue;
        const depth = (y - box.top) / h;
        if (depth > 0.15) break;
        headWidth = Math.max(headWidth, rowRight[i] + step - rowLeft[i]);
        if (depth >= 0.02 && depth <= 0.1) {
            sum += (rowLeft[i] + rowRight[i] + step) / 2;
            count += 1;
        }
    }
    const headX = count ? sum / count : (box.left + box.right) / 2;
    return { ...box, head: { x: headX, y: box.top, width: Math.min(headWidth || box.right - box.left, box.right - box.left) } };
}

/** 高 ÷ 宽，按轮廓算。 */
export function silhouetteAspect(s) {
    if (!s) return null;
    const w = s.right - s.left;
    const h = s.bottom - s.top;
    return w > 0 && h > 0 ? h / w : null;
}

/**
 * 把轮廓摆进窗口：底边贴窗口底、左右居中，整个塞进角色区（窗口去掉上方留给气泡的高度）。
 * box 是轮廓（任意单位，1 单位画出来是 scale 像素），返回 { scale, x, y }：
 * 把单位坐标 (u, v) 画在 (x + u * scale, y + v * scale)。
 */
export function fitSilhouette(box, { width, height, topReserve, widthFill = 0.96, heightFill = 0.98 }) {
    const w = box.right - box.left;
    const h = box.bottom - box.top;
    if (!(w > 0) || !(h > 0)) return null;
    const scale = Math.min((width * widthFill) / w, (Math.max(1, height - topReserve) * heightFill) / h);
    return {
        scale,
        x: width / 2 - ((box.left + box.right) / 2) * scale,
        y: height - box.bottom * scale,
    };
}
