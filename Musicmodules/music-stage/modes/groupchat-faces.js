(function (global) {
    'use strict';

    /*
     * 群唱的小头像和表情包：每个群成员一张自己画的 Q 版半身像（SVG 字符串）。
     * 画法：大头、宽脸颊小下巴；不用统一的黑描线，每块颜色用自己的深一档描边（头发描深发色、
     * 皮肤描暖棕）；平涂，头发只分本色 / 暗部两层，加几道发丝线；刘海是尖头发束，两侧垂一缕鬓发；
     * 眼睛大而圆，上半深、下半浅，粗上睫毛，两颗高光；小嘴、粉色腮红；每人一个小配饰（发夹、花、
     * 蝴蝶结、眼镜、耳机）。表情换眼睛、嘴和小道具；类名 gcf-eyes / gcf-m-open / gcf-m-smile 给样式表做眨眼和唱歌。
     */

    const tint = (hex, t) => {
        const n = parseInt(hex.slice(1), 16);
        const ch = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(t >= 0 ? v + (255 - v) * t : v * (1 + t)));
        return `#${ch.map(v => v.toString(16).padStart(2, '0')).join('')}`;
    };

    // 发色、瞳色、衣服都偏柔和；bg 是圆底的色相（和消息气泡同色），-1 = 跟舞台强调色
    const LOOKS = Object.freeze({
        '阿澈': { hair: 'messy', hairCol: '#5866c4', eye: '#4f74c8', cloth: '#f4f5fb', trim: '#3b4686', bg: 205, deco: 'clip' },
        '小满': { hair: 'long', hairCol: '#e89aae', eye: '#c45a7c', cloth: '#fbf1f2', trim: '#c76b84', bg: 340, deco: 'ribbon' },
        '栗子': { hair: 'bun', hairCol: '#e0844c', eye: '#c7862c', cloth: '#f6ecd9', trim: '#8a4a2a', bg: 28, deco: 'flower' },
        '七七': { hair: 'twin', hairCol: '#3aa596', eye: '#2f9a8c', cloth: '#ffffff', trim: '#2c3d48', bg: 150, deco: 'bows' },
        '老周': { hair: 'part', hairCol: '#b4b0cf', eye: '#6670b4', cloth: '#5f6b9a', trim: '#f2f2f8', bg: 262, glasses: true },
        '我': { hair: 'short', hairCol: '#3e4470', eye: '#5a64b0', cloth: '#f3f3f6', trim: '#3e4470', bg: -1, phones: true }
    });
    const SKIN = '#fff0e8';
    const SKIN_SHADE = '#f7d9cf';
    const SKIN_LINE = '#d9a090';
    const SW = 0.55;

    // 刘海下沿：一串 [x, y]，发根和发尖交替。到发尖的那段竖着收进去，所以发尖是尖的、发根是圆的；
    // lean 让发束往一边扫
    const fringe = (pts, lean = 0) => {
        let d = '';
        for (let i = 1; i < pts.length; i++) {
            const [ax, ay] = pts[i - 1];
            const [bx, by] = pts[i];
            const down = by > ay;
            // 往发尖去的那段先平后陡、往发根回的那段先陡后平，两边都收成尖，发束像一片片叶子
            const cx = down ? ax + (bx - ax) * 0.75 + lean : ax + (bx - ax) * 0.2 + lean;
            const cy = down ? ay + (by - ay) * 0.3 : by + (ay - by) * 0.55;
            d += ` Q${cx.toFixed(1)} ${cy.toFixed(1)} ${bx} ${by}`;
        }
        return d;
    };
    // 前发 = 头顶 + 右鬓发 + 刘海 + 左鬓发，一条闭合路径
    const front = ({ tips, lean = 0, lockL = 38.2, lockR = 38.2, top = 6.6, crown = '' }) => {
        const first = tips[0];
        const last = tips[tips.length - 1];
        return `M10 21 C9 ${top + 4.2} 15.8 ${top} 24 ${top} C32.2 ${top} 39 ${top + 4.2} 38 21${crown}`
            + ` C38.6 27.6 38 ${(lockR - 4).toFixed(1)} 36.4 ${lockR} Q34.9 ${(lockR - 5).toFixed(1)} ${first[0]} ${first[1]}`
            + fringe(tips, lean)
            + ` Q13.1 ${(lockL - 5).toFixed(1)} 11.6 ${lockL} C10 ${(lockL - 4).toFixed(1)} 9.4 27.6 10 21 Z`;
    };
    // 发丝线：从每个发根往头顶收一道短弧
    const strandsOf = tips => tips.filter((p, i) => i % 4 === 3).map(([x, y]) =>
        `M${x} ${y} Q${(x + (24 - x) * 0.12).toFixed(1)} ${(y - 4).toFixed(1)} ${(x + (24 - x) * 0.4).toFixed(1)} ${(y - 8).toFixed(1)}`).join(' ');
    const STYLES = {
        messy: {
            back: 'M9.4 31 C6.6 22 8.6 9.6 24 8.2 C39.4 9.6 41.4 22 38.6 31 L40.2 33.4 L36.8 33 L37 35.8 L11 35.8 L11.2 33 L7.8 33.4 Z',
            tips: [[34.4, 26], [32.6, 21], [30.8, 25.6], [28.6, 20.4], [26.2, 26.8], [24.4, 21.4], [22.2, 27.2], [20, 20.8], [17.8, 25.4], [16, 21.4], [13.8, 26]],
            front: front({ tips: [[34.4, 26], [32.6, 21], [30.8, 25.6], [28.6, 20.4], [26.2, 26.8], [24.4, 21.4], [22.2, 27.2], [20, 20.8], [17.8, 25.4], [16, 21.4], [13.8, 26]], lean: 0.4 }),
            // 呆毛
            top: c => `<path d="M24.6 7.8 Q24.8 2.6 30 2.4 Q27.2 3.8 26.8 8 Z" fill="${c.base}" stroke="${c.line}" stroke-width="${SW}" stroke-linejoin="round"/>`
        },
        long: {
            back: 'M10 20 C8.6 9.6 39.4 9.6 38 20 C39.4 29 40.4 38 42.4 47 L38.2 45 L35.6 48.6 L33 44.6 L15 44.6 L12.4 48.6 L9.8 45 L5.6 47 C7.6 38 8.6 29 10 20 Z',
            tips: [[34.6, 27], [32.6, 21.4], [30.6, 26.2], [28.4, 20.6], [26.2, 27], [24, 21.2], [21.8, 27], [19.6, 20.6], [17.4, 26.2], [15.4, 21.4], [13.4, 27]],
            front: front({ tips: [[34.6, 27], [32.6, 21.4], [30.6, 26.2], [28.4, 20.6], [26.2, 27], [24, 21.2], [21.8, 27], [19.6, 20.6], [17.4, 26.2], [15.4, 21.4], [13.4, 27]], lean: -0.3, lockL: 41, lockR: 41 }),
        },
        bun: {
            back: 'M9.8 30 C7.4 15.6 15.2 8.4 24 8.4 C32.8 8.4 40.6 15.6 38.2 30 Z',
            tips: [[34.2, 25.6], [32.6, 20.4], [30, 25.4], [27.8, 19.8], [25, 26.4], [23, 20.4], [20.4, 26], [18.6, 20.8], [16.4, 25.4], [15.4, 21.6], [13.8, 26]],
            front: front({ tips: [[34.2, 25.6], [32.6, 20.4], [30, 25.4], [27.8, 19.8], [25, 26.4], [23, 20.4], [20.4, 26], [18.6, 20.8], [16.4, 25.4], [15.4, 21.6], [13.8, 26]], lean: -0.8, lockL: 36.6, lockR: 36.6 }),
            // 侧边丸子
            under: c => `<circle cx="34.4" cy="9.6" r="5.4" fill="${c.base}" stroke="${c.line}" stroke-width="${SW}"/><path d="M31.2 7.4 Q34.2 5.4 37.4 7.6" stroke="${c.line}" stroke-width="0.45" fill="none" stroke-linecap="round" opacity="0.6"/>`
        },
        twin: {
            back: 'M9.8 30 C7.4 15.6 15.2 8.4 24 8.4 C32.8 8.4 40.6 15.6 38.2 30 Z',
            tips: [[34, 24.6], [32.4, 21.4], [30.6, 25], [28.8, 21.4], [27, 25.2], [25, 21.6], [23, 25.2], [21.2, 21.4], [19.4, 25], [17.6, 21.4], [14, 24.6]],
            front: front({ tips: [[34, 24.6], [32.4, 21.4], [30.6, 25], [28.8, 21.4], [27, 25.2], [25, 21.6], [23, 25.2], [21.2, 21.4], [19.4, 25], [17.6, 21.4], [14, 24.6]], lean: 0, lockL: 39, lockR: 39 }),
            // 双马尾：从耳后往下垂，尾巴尖尖地翘一下
            under: c => `<path d="M10.6 17 C3.4 18.6 1.6 28 3 36.4 Q3.8 41.6 1.8 46 Q6.6 43.6 8 38.4 Q9.6 32 10.8 26 Z M37.4 17 C44.6 18.6 46.4 28 45 36.4 Q44.2 41.6 46.2 46 Q41.4 43.6 40 38.4 Q38.4 32 37.2 26 Z" fill="${c.base}" stroke="${c.line}" stroke-width="${SW}" stroke-linejoin="round"/>`
                + `<path d="M6.4 22 Q4.4 30 5.2 38 M41.6 22 Q43.6 30 42.8 38" stroke="${c.line}" stroke-width="0.45" fill="none" stroke-linecap="round" opacity="0.6"/>`
        },
        part: {
            back: 'M9.8 30 C7.4 15.6 15.2 8.4 24 8.4 C32.8 8.4 40.6 15.6 38.2 30 Z',
            // 侧分：额前一大片往右扫，左边露出额头
            tips: [[34.4, 25], [33.4, 19.6], [31, 24.6], [28.6, 19], [25.4, 23.6], [23.2, 18], [19.6, 22], [18, 17.6], [16, 22.4], [15.6, 19.6], [13.8, 24.6]],
            front: front({ tips: [[34.4, 25], [33.4, 19.6], [31, 24.6], [28.6, 19], [25.4, 23.6], [23.2, 18], [19.6, 22], [18, 17.6], [16, 22.4], [15.6, 19.6], [13.8, 24.6]], lean: 1.4, lockL: 33.6, lockR: 33.6 }),
        },
        short: {
            back: 'M9.8 30 C7.4 15.6 15.2 8.4 24 8.4 C32.8 8.4 40.6 15.6 38.2 30 L37.4 33.6 L10.6 33.6 Z',
            tips: [[34.2, 25.6], [32.4, 20.8], [30.4, 25.2], [28.2, 20.4], [26, 26.2], [24, 21], [21.8, 26.4], [19.8, 20.6], [17.6, 25.2], [15.8, 21], [14, 25.6]],
            front: front({ tips: [[34.2, 25.6], [32.4, 20.8], [30.4, 25.2], [28.2, 20.4], [26, 26.2], [24, 21], [21.8, 26.4], [19.8, 20.6], [17.6, 25.2], [15.8, 21], [14, 25.6]], lean: 0.6, lockL: 34.4, lockR: 34.4 }),
        }
    };

    // 眼睛：圆一点的大眼，上半深、下半浅，瞳孔、两颗高光，粗上睫毛带一点眼尾
    const EX = [18, 30], EY = 30;
    const eyeOpen = (cx, side, e) => {
        const rx = 2.9, ry = 3.5;
        const out = side < 0 ? cx - rx - 0.7 : cx + rx + 0.7;
        return `<ellipse cx="${cx}" cy="${EY}" rx="${rx}" ry="${ry}" fill="${e.mid}"/>`
            + `<path d="M${(cx - rx).toFixed(2)} ${EY} A${rx} ${ry} 0 0 1 ${(cx + rx).toFixed(2)} ${EY} Q${cx} ${(EY - 1.1).toFixed(2)} ${(cx - rx).toFixed(2)} ${EY} Z" fill="${e.dark}"/>`
            + `<ellipse cx="${cx}" cy="${(EY + 1.7).toFixed(2)}" rx="1.75" ry="1.05" fill="${e.light}"/>`
            + `<ellipse cx="${cx}" cy="${(EY + 0.1).toFixed(2)}" rx="1.05" ry="1.55" fill="${e.dark}"/>`
            + `<circle cx="${(cx - 0.95).toFixed(2)}" cy="${(EY - 1.25).toFixed(2)}" r="0.95" fill="#fff"/>`
            + `<circle cx="${(cx + 1.05).toFixed(2)}" cy="${(EY + 1.35).toFixed(2)}" r="0.42" fill="#fff"/>`
            + `<path d="M${(cx - rx - 0.3).toFixed(2)} ${(EY - 1.6).toFixed(2)} Q${cx} ${(EY - 4.6).toFixed(2)} ${(cx + rx + 0.3).toFixed(2)} ${(EY - 1.6).toFixed(2)} L${out.toFixed(2)} ${(EY - 0.9).toFixed(2)}" stroke="${e.lash}" stroke-width="1.05" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    };
    const arcs = (k, e, w = 1.05) => EX.map(x => `<path d="M${x - 2.6} ${EY} Q${x} ${EY + k} ${x + 2.6} ${EY}" stroke="${e.lash}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`).join('');
    const heartAt = cx => `<path d="M${cx} ${EY + 2.5} L${cx - 2.5} ${EY - 0.1} A1.3 1.3 0 0 1 ${cx} ${EY - 1.9} A1.3 1.3 0 0 1 ${cx + 2.5} ${EY - 0.1} Z" fill="#f2668e" stroke="#c4446a" stroke-width="0.45" stroke-linejoin="round"/>`;
    const starAt = cx => `<path d="M${cx} ${EY - 2.9} L${cx + 0.8} ${EY - 0.8} L${cx + 2.9} ${EY - 0.6} L${cx + 1.2} ${EY + 0.7} L${cx + 1.8} ${EY + 2.8} L${cx} ${EY + 1.6} L${cx - 1.8} ${EY + 2.8} L${cx - 1.2} ${EY + 0.7} L${cx - 2.9} ${EY - 0.6} L${cx - 0.8} ${EY - 0.8} Z" fill="#ffd166" stroke="#d99a2b" stroke-width="0.45" stroke-linejoin="round"/>`;
    const EYES = {
        open: e => `<g class="gcf-eyes">${eyeOpen(EX[0], -1, e)}${eyeOpen(EX[1], 1, e)}</g>`,
        happy: e => arcs(-2.6, e, 1.15),
        closed: e => arcs(1.6, e),
        wink: e => `${eyeOpen(EX[0], -1, e)}<path d="M${EX[1] - 2.6} ${EY} Q${EX[1]} ${EY - 2.6} ${EX[1] + 2.6} ${EY}" stroke="${e.lash}" stroke-width="1.15" fill="none" stroke-linecap="round"/>`,
        heart: () => heartAt(EX[0]) + heartAt(EX[1]),
        star: () => starAt(EX[0]) + starAt(EX[1])
    };
    const ML = '#a0504f';
    const MC = '#c8545f';
    const MOUTH = {
        smile: `<path class="gcf-m-smile" d="M23 34.6 Q24 35.5 25 34.6" stroke="${ML}" stroke-width="0.6" fill="none" stroke-linecap="round"/>`,
        sing: `<path class="gcf-m-smile" d="M22.6 34.5 Q23.3 35.3 24 34.7 Q24.7 35.3 25.4 34.5" stroke="${ML}" stroke-width="0.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
            + `<path class="gcf-m-open" d="M22.8 34.3 L25.2 34.3 Q25.1 36.6 24 36.6 Q22.9 36.6 22.8 34.3 Z" fill="${MC}" stroke="${ML}" stroke-width="0.4" stroke-linejoin="round"/>`,
        open: `<path d="M22.4 34 L25.6 34 Q25.4 37 24 37 Q22.6 37 22.4 34 Z" fill="${MC}" stroke="${ML}" stroke-width="0.45" stroke-linejoin="round"/><path d="M23 36 Q24 35.3 25 36 Q24.7 36.7 24 36.7 Q23.3 36.7 23 36 Z" fill="#f59aa2"/>`,
        cat: `<path d="M22.4 34.4 Q23.2 35.4 24 34.6 Q24.8 35.4 25.6 34.4" stroke="${ML}" stroke-width="0.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
        o: `<ellipse cx="24" cy="35" rx="0.9" ry="1.05" fill="${MC}" stroke="${ML}" stroke-width="0.4"/>`
    };
    const PROPS = {
        heart: `<path d="M40 14 L36.4 10.4 A2.2 2.2 0 0 1 40 7.6 A2.2 2.2 0 0 1 43.6 10.4 Z" fill="#f2668e" stroke="#c4446a" stroke-width="0.5" stroke-linejoin="round"/>`,
        notes: `<path d="M38 6 L44 4.6 L44 11.6 A1.8 1.5 0 1 1 42.6 10.2 L42.6 7.2 L39.4 8 L39.4 13 A1.8 1.5 0 1 1 38 11.6 Z" fill="currentColor"/>`,
        sparkle: `<path d="M41 4 L42 8 L46 9 L42 10 L41 14 L40 10 L36 9 L40 8 Z" fill="#ffd166"/><path d="M6 8 L6.6 10.4 L9 11 L6.6 11.6 L6 14 L5.4 11.6 L3 11 L5.4 10.4 Z" fill="#ffd166"/>`,
        zzz: `<text x="35" y="12" font-size="7" font-weight="700" fill="currentColor" font-family="sans-serif">z</text><text x="40" y="7" font-size="5" font-weight="700" fill="currentColor" font-family="sans-serif">z</text>`,
        sweat: `<path d="M37.4 17.6 Q39.6 21.6 38.2 23.4 Q36.2 24.2 35.8 22.2 Q36 20.2 37.4 17.6 Z" fill="#a8dcff" stroke="#6aa8d8" stroke-width="0.45"/>`
    };
    // 配饰（画在前发上）
    const DECO = {
        // 星形小发夹
        clip: () => `<path d="M33.6 14.2 L34.5 16.2 L36.7 16.4 L35 17.8 L35.6 20 L33.6 18.8 L31.6 20 L32.2 17.8 L30.5 16.4 L32.7 16.2 Z" fill="#9cc8f4" stroke="#4a78b8" stroke-width="0.45" stroke-linejoin="round"/>`,
        // 侧边蝴蝶结
        ribbon: () => `<path d="M35.2 15.4 L31.4 12.4 Q30.6 15.6 31.6 18.2 Z M35.2 15.4 L39.4 12.8 Q40.2 16 38.8 18.4 Z" fill="#fff6f8" stroke="#c76b84" stroke-width="0.5" stroke-linejoin="round"/><circle cx="35.2" cy="15.4" r="1.15" fill="#e88aa2" stroke="#c76b84" stroke-width="0.45"/>`,
        // 一朵山茶
        flower: () => `<g stroke="#b5462a" stroke-width="0.45"><circle cx="13.8" cy="14.6" r="1.9" fill="#f07a4e"/><circle cx="16.4" cy="13" r="1.9" fill="#f07a4e"/><circle cx="16.2" cy="16.4" r="1.9" fill="#f07a4e"/><circle cx="12.4" cy="17.2" r="1.7" fill="#f07a4e"/><circle cx="18.2" cy="14.8" r="1.6" fill="#f07a4e"/></g><circle cx="15.2" cy="15" r="1" fill="#ffd27a"/><path d="M19.4 16.8 Q21.6 16.4 22.2 18.2 Q20.4 18.8 19.4 16.8 Z" fill="#6fae74" stroke="#3f7d4a" stroke-width="0.4"/>`,
        // 双马尾根上一对黑色蝴蝶结
        bows: () => [9.6, 38.4].map(x => `<path d="M${x} 17.6 L${x - 3} 15.4 Q${x - 3.6} 18 ${x - 2.6} 20 Z M${x} 17.6 L${x + 3} 15.4 Q${x + 3.6} 18 ${x + 2.6} 20 Z" fill="#33404a" stroke="#1e262c" stroke-width="0.45" stroke-linejoin="round"/><circle cx="${x}" cy="17.6" r="1" fill="#4a5a66"/>`).join('')
    };

    const faceCache = new Map();
    const face = (name, { eyes = 'open', mouth = 'sing', prop = null, bg = true } = {}) => {
        const key = `${name}|${eyes}|${mouth}|${prop || ''}|${bg ? 1 : 0}`;
        const hit = faceCache.get(key);
        if (hit !== undefined) return hit;
        const L = LOOKS[name] || LOOKS['阿澈'];
        const S = STYLES[L.hair];
        const c = { base: L.hairCol, shade: tint(L.hairCol, -0.16), line: tint(L.hairCol, -0.34), light: tint(L.hairCol, 0.32) };
        const e = { mid: L.eye, dark: tint(L.eye, -0.45), light: tint(L.eye, 0.5), lash: tint(L.eye, -0.7) };
        const bgFill = L.bg < 0 ? 'var(--stage-accent, #e0a030)' : `hsl(${L.bg} 55% 88%)`;
        const hairStroke = `stroke="${c.line}" stroke-width="${SW}" stroke-linejoin="round"`;

        const back = `<path d="${S.back}" fill="${c.shade}" ${hairStroke}/>`;
        const under = S.under ? S.under(c) : '';
        // 衣服：小肩膀 + 白领子 + 领口一点颜色
        const body = `<path d="M8.6 49 C9.4 43.4 15 40.6 24 40.6 C33 40.6 38.6 43.4 39.4 49 Z" fill="${L.cloth}" stroke="${tint(L.cloth, -0.35)}" stroke-width="${SW}"/>`
            + `<path d="M21.8 37.4 L21.8 41.2 Q24 42.4 26.2 41.2 L26.2 37.4 Z" fill="${SKIN_SHADE}"/>`
            + `<path d="M19.4 40.9 L24 44.6 L28.6 40.9 Q24 42.6 19.4 40.9 Z" fill="${L.trim}" opacity="0.9"/>`
            + `<path d="M22.6 43.2 L24 44.8 L25.4 43.2 L24 47.6 Z" fill="${L.trim}"/>`;
        const headPath = 'M11.8 25.4 C11.8 17.4 17.2 13.2 24 13.2 C30.8 13.2 36.2 17.4 36.2 25.4 C36.2 31.4 33.6 35.8 29.8 38 Q26.8 39.8 24 39.8 Q21.2 39.8 18.2 38 C14.4 35.8 11.8 31.4 11.8 25.4 Z';
        const head = `<path d="${headPath}" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="${SW}"/>`
            // 刘海在额头上投一道浅影
            + `<path d="M13 24.2 Q18 21.6 24 23.2 Q30 21.6 35 24.2 L35 25.4 Q30 23.2 24 24.8 Q18 23.2 13 25.4 Z" fill="${SKIN_SHADE}" opacity="0.9"/>`
            + `<ellipse cx="14.8" cy="33.4" rx="2.5" ry="1.45" fill="#ff9aa6" opacity="0.5"/><ellipse cx="33.2" cy="33.4" rx="2.5" ry="1.45" fill="#ff9aa6" opacity="0.5"/>`;
        const fr = `<path d="${S.front}" fill="${c.base}" ${hairStroke}/>`
            + `<path d="${strandsOf(S.tips)}" stroke="${c.line}" stroke-width="0.5" fill="none" stroke-linecap="round" opacity="0.45"/>`
            // 头顶一圈浅色光泽：几小段弧
            + `<path d="M16.6 12.6 Q18.6 10.8 21 10.4 M23.2 10 Q25 9.8 26.8 10.2 M29 10.8 Q30.8 11.6 31.8 12.6" stroke="${c.light}" stroke-width="0.9" fill="none" stroke-linecap="round"/>`;
        const top = S.top ? S.top(c) : '';
        const deco = L.deco ? DECO[L.deco]() : '';
        const glasses = L.glasses ? `<g fill="none" stroke="#545a82" stroke-width="0.7"><rect x="14.6" y="26.2" width="7.4" height="6.6" rx="2.6"/><rect x="26" y="26.2" width="7.4" height="6.6" rx="2.6"/><path d="M22 28.6 Q24 27.6 26 28.6"/></g><path d="M15.6 27.4 L17.2 26.8 M27 27.4 L28.6 26.8" stroke="#fff" stroke-width="0.6" stroke-linecap="round" opacity="0.8"/>` : '';
        const phones = L.phones ? `<path d="M10.2 25 C9.6 9.6 38.4 9.6 37.8 25" stroke="#dfe3f2" stroke-width="2" fill="none"/><path d="M10.2 25 C9.6 9.6 38.4 9.6 37.8 25" stroke="#8d94b8" stroke-width="0.5" fill="none" transform="translate(0 -1)"/><rect x="7.4" y="22.2" width="5" height="8.6" rx="2.5" fill="#f4f5fb" stroke="#8d94b8" stroke-width="${SW}"/><rect x="35.6" y="22.2" width="5" height="8.6" rx="2.5" fill="#f4f5fb" stroke="#8d94b8" stroke-width="${SW}"/><circle cx="9.9" cy="26.5" r="1.2" fill="var(--stage-accent, #e0a030)"/><circle cx="38.1" cy="26.5" r="1.2" fill="var(--stage-accent, #e0a030)"/>` : '';

        const svg = `<svg class="gcf" viewBox="0 0 48 48" aria-hidden="true">${bg ? `<circle cx="24" cy="24" r="24" fill="${bgFill}"/>` : ''}`
            + `${under}${back}${body}${head}${EYES[eyes](e)}${MOUTH[mouth]}${fr}${top}${deco}${glasses}${phones}${prop ? PROPS[prop] : ''}</svg>`;
        faceCache.set(key, svg);
        return svg;
    };

    global.MusicStageGroupchatFaces = Object.freeze({ face, LOOKS });
})(typeof window !== 'undefined' ? window : globalThis);
