(function (global) {
    'use strict';

    /*
     * 群唱：歌词变成一个群聊。每句是群里某个人发的一条消息，按唱的进度一个字一个字打出来；
     * 开唱前那人「正在输入…」；间奏是一条语音消息，波形跟着音乐跳；副歌（整句出现两次以上的）
     * 大家一起唱，消息下面叠着几个人的回声；唱完的消息偶尔有人点个赞。
     * 全部是 DOM，不用画布；每帧只动正在打字的那条和语音波形。
     */

    const Utils = global.MusicStageModeUtils;
    const Runtime = global.MusicStageRuntime;
    if (!Utils || !Runtime) throw new Error('MusicStageModeUtils and MusicStageRuntime must load before groupchat-manager.js');
    const { clamp, createElement } = Utils;
    const { resolveSupplementalText, readableText, buildGlyphTimeline, hashString, splitGraphemes } = Runtime;

    const FPS = Object.freeze({ 'energy-saving': 24, standard: 30, ultimate: 60 });
    const KEEP_ROWS = 16;            // DOM 里最多留几行
    const TYPING_LEAD = 0.9;         // 开唱前多久显示「正在输入」
    const VOICE_GAP = 4.5;           // 两句之间空这么久就发一条语音
    const BARS = 28;                 // 语音波形的格数

    // 群成员：名字和头像颜色（色相）。「我」在右边。
    const MEMBERS = Object.freeze([
        { name: '阿澈', hue: 205 },
        { name: '小满', hue: 340 },
        { name: '栗子', hue: 28 },
        { name: '七七', hue: 150 },
        { name: '老周', hue: 262 }
    ]);
    const ME = Object.freeze({ name: '我', hue: -1, me: true });
    const REACTIONS = Object.freeze(['♥', '＋1', '☆', '哈', '♪']);
    // 长间奏里有人回一个表情：用发的人自己的脸做的表情包（label 给读屏）
    const STICKERS = Object.freeze([
        { eyes: 'happy', mouth: 'open', prop: 'notes', label: '开心地唱' },
        { eyes: 'heart', mouth: 'cat', prop: 'heart', label: '喜欢' },
        { eyes: 'star', mouth: 'open', prop: 'sparkle', label: '好听' },
        { eyes: 'closed', mouth: 'o', prop: 'zzz', label: '听睡着了' },
        { eyes: 'wink', mouth: 'cat', prop: 'notes', label: '眨眼' },
        { eyes: 'happy', mouth: 'cat', prop: 'sweat', label: '嘿嘿' }
    ]);
    const STICKER_GAP = 9;

    // 群唱头像和表情：每个人一张自己画的日系动画风小像（SVG）——尖一点的下巴、偏下的大眼睛
    // （上睫毛线、虹膜上深下浅、两颗高光）、细描线、一缕缕带尖的刘海、头发上一圈天使环高光；
    // 发型、发色、瞳色各不同，老周戴眼镜、我戴耳机。表情换眼睛、嘴和小道具
    const LOOKS = Object.freeze({
        '阿澈': { hair: 'messy', hairCol: '#2b3550', skin: '#fbe3d4', eye: '#3f78c4', bg: 205, ahoge: true },
        '小满': { hair: 'long', hairCol: '#5e2f3c', skin: '#fde6da', eye: '#c25277', bg: 340 },
        '栗子': { hair: 'bun', hairCol: '#8a4f2a', skin: '#fbe0cf', eye: '#d08a2c', bg: 28 },
        '七七': { hair: 'twin', hairCol: '#1f2b2a', skin: '#fde8dc', eye: '#2f9a8e', bg: 150 },
        '老周': { hair: 'part', hairCol: '#3a3a42', skin: '#f3d6c2', eye: '#6e4a36', bg: 262, glasses: true, calm: true },
        '我': { hair: 'short', hairCol: '#2a2a30', skin: '#fbe1d2', eye: '#5b5f96', bg: -1, phones: true }
    });
    const LINE = '#3a2530';
    // 颜色往白 / 往黑拉
    const tint = (hex, t) => {
        const n = parseInt(hex.slice(1), 16);
        const ch = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(t >= 0 ? v + (255 - v) * t : v * (1 + t)));
        return `rgb(${ch.join(',')})`;
    };
    // 刘海：从左鬓角起，一缕一缕带尖往右排。tips = [[尖的 x, 尖的 y], ...]，缕根在 rootY
    const bangs = (tips, rootY, left = 11.2, right = 36.8, sideY = 28) => {
        let d = `M${left} ${sideY} C${left - 1.6} 15 16.5 8 24 8 C31.5 8 ${right + 1.6} 15 ${right} ${sideY}`;
        // 沿刘海下缘从右往左走回去
        const pts = tips.slice().sort((a, b) => b[0] - a[0]);
        let x0 = right, y0 = sideY - 2;
        pts.forEach(([x, y], i) => {
            const next = pts[i + 1];
            const rx = next ? (x + next[0]) / 2 : left;
            d += ` Q${((x0 + x) / 2 + 0.6).toFixed(1)} ${((y0 + y) / 2).toFixed(1)} ${x} ${y}`;
            d += ` Q${(x - 0.4).toFixed(1)} ${((y + rootY) / 2).toFixed(1)} ${rx.toFixed(1)} ${next ? rootY : sideY - 2}`;
            x0 = rx; y0 = rootY;
        });
        return d + ` L${left} ${sideY} Z`;
    };
    const HAIR = {
        messy: {
            back: c => `<path d="M10.5 30 C8 14 16 7 24 7 C32 7 40 14 37.5 30 L35 27 L13 27 Z" fill="${tint(c, -0.25)}"/>`,
            tips: [[16.2, 22.6], [22.4, 21.8], [29.2, 21.6]],
            front: bangs([[13, 25.5], [16.2, 22.6], [19.6, 24.4], [22.4, 21.8], [25.8, 24.2], [29.2, 21.6], [32.4, 24.6], [35.4, 23]], 17.5)
        },
        long: {
            back: c => `<path d="M10 24 C8 10 40 10 38 24 L40.5 42 Q36 45.5 32 42 L33 30 L15 30 L16 42 Q12 45.5 7.5 42 Z" fill="${tint(c, -0.22)}"/>`,
            tips: [[19.4, 21.4], [27.6, 21], [15.6, 23.6], [31.6, 23.4]],
            front: bangs([[12.4, 33], [15.6, 23.6], [19.4, 21.4], [23.6, 23.6], [27.6, 21], [31.6, 23.4], [35.6, 33]], 17, 10.6, 37.4, 34)
        },
        bun: {
            back: c => `<circle cx="24" cy="8.4" r="6.2" fill="${c}"/><path d="M19.4 6.6 Q24 3.6 28.6 6.6" stroke="${tint(c, 0.45)}" stroke-width="0.9" fill="none" stroke-linecap="round"/><path d="M18.4 11.2 Q24 13.4 29.6 11.2" stroke="${tint(c, -0.35)}" stroke-width="1.1" fill="none"/>`,
            tips: [[21.8, 21.6], [26, 21.2], [33.6, 21.6], [15.4, 23.4]],
            front: bangs([[12.6, 27], [15.4, 23.4], [18.8, 24.6], [21.8, 21.6], [26, 21.2], [30.4, 22.8], [33.6, 21.6], [36, 26]], 16.6)
        },
        twin: {
            back: c => `<path d="M9.6 20 C2.6 23 2.4 35 5.6 43 Q8.4 40 9.4 34 Q11 28 12 23 Z M38.4 20 C45.4 23 45.6 35 42.4 43 Q39.6 40 38.6 34 Q37 28 36 23 Z" fill="${c}"/><path d="M6.4 26 Q5 33 6.6 39 M41.6 26 Q43 33 41.4 39" stroke="${tint(c, 0.4)}" stroke-width="0.7" fill="none" stroke-linecap="round"/><path d="M10.5 26 C8 13 40 13 37.5 26 Z" fill="${tint(c, -0.25)}"/>`,
            // 姬发式齐刘海，两边垂到下巴
            front: c => `<path d="M11 32 C9.4 15 16.5 8 24 8 C31.5 8 38.6 15 37 32 L35.4 32 L35.2 22.6 L12.8 22.6 L12.6 32 Z" fill="${c}"/>`,
            extra: () => `<circle cx="10.4" cy="20.8" r="2.1" fill="#ff8fab" stroke="${LINE}" stroke-width="0.4"/><circle cx="37.6" cy="20.8" r="2.1" fill="#ff8fab" stroke="${LINE}" stroke-width="0.4"/>`
        },
        part: {
            back: c => `<path d="M10.8 27 C9 13 39 13 37.2 27 Z" fill="${tint(c, -0.25)}"/>`,
            // 三七分，额前一缕斜过去
            front: c => `<path d="M11 27 C9.6 14 16.5 8 24 8 C31.5 8 38.4 14 37 27 L35.8 24 Q35.4 19 33 17 Q27 20.6 20 18 Q17 21.2 15.4 23.6 Q14.2 22 13.6 20.6 Q12.4 23.2 12 27 Z" fill="${c}"/>`
        },
        short: {
            back: c => `<path d="M10.8 28 C9 13 39 13 37.2 28 Z" fill="${tint(c, -0.25)}"/>`,
            tips: [[15.8, 23.2], [22.6, 22], [29.8, 22.2]],
            front: bangs([[12.6, 26], [15.8, 23.2], [19.2, 24.2], [22.6, 22], [26.2, 23.8], [29.8, 22.2], [33, 24], [35.6, 25.4]], 17.6)
        }
    };
    // 一只眼睛：上睫毛线（外眼角带一点上挑）、虹膜上深下浅、瞳孔、两颗高光、细下睫毛
    const eye = (cx, L, gid, side, shape = 'round') => {
        const s = side;              // -1 左眼，1 右眼
        const outer = cx + s * 3.3, inner = cx - s * 2.9;
        const ry = L.calm ? 2.8 : 3.4;
        const top = 28.6 - ry - 0.4;
        let iris = `<ellipse cx="${cx}" cy="28.9" rx="2.5" ry="${ry}" fill="url(#${gid})"/><path d="M${cx - 2.5} 28.4 Q${cx} ${(28.9 - ry - 0.6).toFixed(1)} ${cx + 2.5} 28.4 Q${cx} ${(28.9 - ry + 1.4).toFixed(1)} ${cx - 2.5} 28.4 Z" fill="${tint(L.eye, -0.7)}" opacity="0.55"/>`
            + `<ellipse cx="${cx}" cy="29.3" rx="1.05" ry="${(ry * 0.5).toFixed(2)}" fill="${tint(L.eye, -0.62)}"/>`;
        if (shape === 'heart') iris = `<path d="M${cx} 31.6 L${cx - 2.5} 28.6 A1.45 1.45 0 0 1 ${cx} 26.4 A1.45 1.45 0 0 1 ${cx + 2.5} 28.6 Z" fill="#ec4f79"/>`;
        if (shape === 'star') iris += `<path d="M${cx} 26.6 L${cx + 0.55} 28.2 L${cx + 2} 28.3 L${cx + 0.9} 29.2 L${cx + 1.3} 30.7 L${cx} 29.9 L${cx - 1.3} 30.7 L${cx - 0.9} 29.2 L${cx - 2} 28.3 L${cx - 0.55} 28.2 Z" fill="#ffe27a"/>`;
        const glints = `<circle cx="${(cx - 0.95).toFixed(2)}" cy="27.4" r="0.95" fill="#fff"/><circle cx="${(cx + 0.95).toFixed(2)}" cy="30.4" r="0.42" fill="#fff" opacity="0.85"/>`;
        return `<ellipse cx="${cx}" cy="28.8" rx="3.15" ry="${(ry + 0.2).toFixed(2)}" fill="#fff"/>${iris}${glints}`
            + `<path d="M${outer} ${(top + 1.6).toFixed(1)} Q${(cx + s * 1.4).toFixed(1)} ${(top - 0.6).toFixed(1)} ${inner} ${(top + 1.1).toFixed(1)}" stroke="${LINE}" stroke-width="1.25" fill="none" stroke-linecap="round"/>`
            + `<path d="M${outer} ${(top + 1.6).toFixed(1)} l${(s * 0.9).toFixed(1)} -0.7" stroke="${LINE}" stroke-width="0.8" stroke-linecap="round"/>`
            + `<path d="M${(cx + s * 2.2).toFixed(1)} ${(28.8 + ry + 0.1).toFixed(1)} Q${cx} ${(29.2 + ry + 0.4).toFixed(1)} ${(cx - s * 1.6).toFixed(1)} ${(28.8 + ry).toFixed(1)}" stroke="${LINE}" stroke-width="0.45" fill="none" stroke-linecap="round" opacity="0.7"/>`;
    };
    const arcEyes = (up, w = 1.3) => {
        const y = 28.8, k = up ? -2.8 : 1.8;
        return `<path d="M16.2 ${y} Q19.2 ${y + k} 22.2 ${y} M25.8 ${y} Q28.8 ${y + k} 31.8 ${y}" stroke="${LINE}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`;
    };
    const EYES = {
        open: (L, gid) => `<g class="gcf-eyes">${eye(19.2, L, gid, -1)}${eye(28.8, L, gid, 1)}</g>`,
        happy: () => arcEyes(true, 1.4),
        closed: () => arcEyes(false, 1.2),
        wink: (L, gid) => `${eye(19.2, L, gid, -1)}<path d="M25.8 28.8 Q28.8 26.2 31.8 28.8 M31.8 28.8 l0.9 -0.8" stroke="${LINE}" stroke-width="1.35" fill="none" stroke-linecap="round"/>`,
        heart: (L, gid) => `${eye(19.2, L, gid, -1, 'heart')}${eye(28.8, L, gid, 1, 'heart')}`,
        star: (L, gid) => `${eye(19.2, L, gid, -1, 'star')}${eye(28.8, L, gid, 1, 'star')}`
    };
    const MOUTH_COL = '#a8434d';
    const MOUTH = {
        smile: `<path class="gcf-m-smile" d="M22.7 34.6 Q24 35.5 25.3 34.6" stroke="${MOUTH_COL}" stroke-width="0.8" fill="none" stroke-linecap="round"/>`,
        sing: `<path class="gcf-m-smile" d="M22.7 34.6 Q24 35.5 25.3 34.6" stroke="${MOUTH_COL}" stroke-width="0.8" fill="none" stroke-linecap="round"/><path class="gcf-m-open" d="M22.4 34.2 Q24 33.8 25.6 34.2 Q25.4 37 24 37.1 Q22.6 37 22.4 34.2 Z" fill="${MOUTH_COL}"/>`,
        open: `<path d="M21.6 33.8 Q24 33.4 26.4 33.8 Q25.8 38 24 38.1 Q22.2 38 21.6 33.8 Z" fill="${MOUTH_COL}"/><path d="M22.6 36.6 Q24 35.6 25.4 36.6 Q24.8 37.8 24 37.8 Q23.2 37.8 22.6 36.6 Z" fill="#f08a90"/>`,
        cat: `<path d="M21.8 34.2 Q22.9 35.6 24 34.4 Q25.1 35.6 26.2 34.2" stroke="${MOUTH_COL}" stroke-width="0.8" fill="none" stroke-linecap="round"/>`,
        o: `<ellipse cx="24" cy="35" rx="1.1" ry="1.4" fill="${MOUTH_COL}"/>`
    };
    const PROPS = {
        heart: `<path d="M40 14 L36.4 10.4 A2.2 2.2 0 0 1 40 7.6 A2.2 2.2 0 0 1 43.6 10.4 Z" fill="#ec4f79" stroke="#fff" stroke-width="0.6"/>`,
        notes: `<path d="M38 6 L44 4.6 L44 11.6 A1.8 1.5 0 1 1 42.6 10.2 L42.6 7.2 L39.4 8 L39.4 13 A1.8 1.5 0 1 1 38 11.6 Z" fill="currentColor"/>`,
        sparkle: `<path d="M41 4 L42 8 L46 9 L42 10 L41 14 L40 10 L36 9 L40 8 Z" fill="#f2b51e"/><path d="M6 8 L6.6 10.4 L9 11 L6.6 11.6 L6 14 L5.4 11.6 L3 11 L5.4 10.4 Z" fill="#f2b51e"/>`,
        zzz: `<text x="35" y="12" font-size="7" font-weight="700" fill="currentColor" font-family="sans-serif">z</text><text x="40" y="7" font-size="5" font-weight="700" fill="currentColor" font-family="sans-serif">z</text>`,
        sweat: `<path d="M37.4 18 Q39.6 22 38.2 23.8 Q36.2 24.6 35.8 22.6 Q36 20.6 37.4 18 Z" fill="#8fd3ff" stroke="#fff" stroke-width="0.5"/>`
    };
    const LOOK_IDS = Object.keys(LOOKS);
    const face = (name, { eyes = 'open', mouth = 'sing', prop = null, bg = true } = {}) => {
        const key = LOOKS[name] ? name : '阿澈';
        const L = LOOKS[key];
        const id = LOOK_IDS.indexOf(key);
        const gid = `gcfI${id}`, hid = `gcfH${id}`, sid = `gcfS${id}`;
        const hair = HAIR[L.hair];
        const c = L.hairCol;
        const bgFill = L.bg < 0 ? 'var(--stage-accent, #e0a030)' : `hsl(${L.bg} 46% 80%)`;
        const front = typeof hair.front === 'function' ? hair.front(c) : `<path d="${hair.front}" fill="${c}"/>`;
        const frontLine = typeof hair.front === 'function' ? '' : `<path d="${hair.front}" fill="none" stroke="${tint(c, -0.45)}" stroke-width="0.45" stroke-linejoin="round"/>`;
        const defs = `<defs>`
            + `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tint(L.eye, -0.55)}"/><stop offset="0.55" stop-color="${L.eye}"/><stop offset="1" stop-color="${tint(L.eye, 0.55)}"/></linearGradient>`
            + `<linearGradient id="${hid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tint(c, 0.12)}"/><stop offset="1" stop-color="${tint(c, -0.2)}"/></linearGradient>`
            + `<linearGradient id="${sid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tint(L.skin.replace('#', '#'), -0.12)}"/><stop offset="0.35" stop-color="${L.skin}"/></linearGradient>`
            + `</defs>`;
        const shirt = L.bg < 0 ? 40 : L.bg;
        const body = `<path d="M21.4 36 L21.4 41 L26.6 41 L26.6 36 Z" fill="${tint(L.skin, -0.12)}"/>`
            + `<path d="M7 48 C8 42.6 14 40.4 20 40 L24 43.2 L28 40 C34 40.4 40 42.6 41 48 Z" fill="hsl(${shirt} 28% 42%)" stroke="${LINE}" stroke-width="0.4"/>`
            + `<path d="M20 40 L24 43.2 L28 40" stroke="#fff" stroke-opacity="0.75" stroke-width="0.9" fill="none" stroke-linejoin="round"/>`;
        // 脸：鬓角往下收成尖一点的下巴
        const facePath = 'M12.4 24 C12.4 16 17.2 12.6 24 12.6 C30.8 12.6 35.6 16 35.6 24 C35.6 30.2 33.2 34.4 29.6 37 Q26.6 39.6 24 39.8 Q21.4 39.6 18.4 37 C14.8 34.4 12.4 30.2 12.4 24 Z';
        const head = `<ellipse cx="12.4" cy="28" rx="1.5" ry="2.2" fill="${L.skin}" stroke="${LINE}" stroke-width="0.35"/><ellipse cx="35.6" cy="28" rx="1.5" ry="2.2" fill="${L.skin}" stroke="${LINE}" stroke-width="0.35"/>`
            + `<path d="${facePath}" fill="url(#${sid})" stroke="${LINE}" stroke-width="0.45"/>`
            // 腮红：一团淡粉 + 三道斜线
            + `<ellipse cx="15.8" cy="32.6" rx="2.4" ry="1.2" fill="#ff7f8e" opacity="0.32"/><ellipse cx="32.2" cy="32.6" rx="2.4" ry="1.2" fill="#ff7f8e" opacity="0.32"/>`
            + `<path d="M14.6 33.2 l0.7 -1.1 M15.8 33.2 l0.7 -1.1 M17 33.2 l0.7 -1.1 M31 33.2 l0.7 -1.1 M32.2 33.2 l0.7 -1.1 M33.4 33.2 l0.7 -1.1" stroke="#e8606e" stroke-width="0.3" stroke-linecap="round" opacity="0.7"/>`
            + `<path d="M24.3 31.6 l-0.5 0.9" stroke="${tint(L.skin, -0.35)}" stroke-width="0.5" stroke-linecap="round"/>`;
        // 眉毛：细，略带角度
        const brows = `<path d="M16.4 23.8 Q18.8 22.6 21.4 23.4 M26.6 23.4 Q29.2 22.6 31.6 23.8" stroke="${tint(c, -0.2)}" stroke-width="0.6" fill="none" stroke-linecap="round" opacity="0.9"/>`;
        // 天使环：头顶一圈断开的亮弧
        // 天使环：头顶一道柔和的亮带，中间断两处，像一缕缕头发各自反光
        const ring = `<path d="M14.2 16.2 Q24 9.4 33.8 16.2" stroke="${tint(c, 0.5)}" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-dasharray="7 0.9 5.4 0.9 9" opacity="0.62"/>`
            + `<path d="M17 13.6 Q21 11.4 24.4 11.4" stroke="#fff" stroke-width="0.55" fill="none" stroke-linecap="round" opacity="0.5"/>`;
        // 发丝：从刘海每个尖往头顶拉的细线，分出一缕一缕
        const strands = hair.tips ? hair.tips.map(([x, y]) => `M${x} ${y - 0.6} Q${(x * 0.75 + 6).toFixed(1)} ${((y + 12) / 2).toFixed(1)} ${(x * 0.55 + 10.8).toFixed(1)} 12.4`).join(' ') : '';
        const strandLines = strands ? `<path d="${strands}" stroke="${tint(c, -0.4)}" stroke-width="0.35" fill="none" stroke-linecap="round" opacity="0.8"/>` : '';
        const ahoge = L.ahoge ? `<path d="M24.6 8.4 Q25.2 3.4 30.2 3.2 Q26.8 4.8 26.4 8.6 Z" fill="${c}" stroke="${tint(c, -0.45)}" stroke-width="0.4"/>` : '';
        const glasses = L.glasses ? `<g fill="#fff" fill-opacity="0.12" stroke="${LINE}" stroke-width="0.7"><rect x="15.4" y="25.4" width="7.6" height="6.4" rx="2"/><rect x="25" y="25.4" width="7.6" height="6.4" rx="2"/></g><path d="M23 27.6 Q24 27 25 27.6 M15.4 27 L12.6 26.6 M32.6 27 L35.4 26.6" stroke="${LINE}" stroke-width="0.6" fill="none"/><path d="M16.6 26.4 l2 0 M26.2 26.4 l2 0" stroke="#fff" stroke-width="0.5" opacity="0.7" stroke-linecap="round"/>` : '';
        const phones = L.phones ? `<path d="M9.4 27 C9 10 39 10 38.6 27" stroke="#2a2a2e" stroke-width="2" fill="none"/><path d="M11 18 C14 11 34 11 37 18" stroke="#fff" stroke-opacity="0.3" stroke-width="0.6" fill="none"/><rect x="6.6" y="23.6" width="5.2" height="8.4" rx="2.4" fill="#2a2a2e"/><rect x="36.2" y="23.6" width="5.2" height="8.4" rx="2.4" fill="#2a2a2e"/><rect x="7.6" y="25" width="1.2" height="5.4" rx="0.6" fill="var(--stage-accent, #e0a030)"/><rect x="39.2" y="25" width="1.2" height="5.4" rx="0.6" fill="var(--stage-accent, #e0a030)"/>` : '';
        return `<svg class="gcf" viewBox="0 0 48 48" aria-hidden="true">${defs}${bg ? `<circle cx="24" cy="24" r="24" fill="${bgFill}"/>` : ''}`
            + `${hair.back(c)}${body}${head}${brows}${EYES[eyes](L, gid)}${MOUTH[mouth]}`
            + `${front.replace(`fill="${c}"`, `fill="url(#${hid})"`)}${frontLine}${strandLines}${ring}${ahoge}${hair.extra ? hair.extra(c) : ''}${glasses}${phones}${prop ? PROPS[prop] : ''}</svg>`;
    };
           // 间奏长过这么久，语音之后再来一个表情

    const unit = (...parts) => (hashString(parts.join('|')) >>> 0) / 4294967295;
    const normLine = line => String(line?.fullText || '').replace(/[\s，。、,.!?！？…~～'"“”‘’()（）-]/g, '').toLowerCase();
    const compactLength = text => splitGraphemes(String(text || '').replace(/\s/g, '')).length;
    const fmt = (seconds) => {
        const s = Math.max(0, Math.round(seconds));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };

    /* ───────────────────────── 编排（纯函数，同一首歌每次都一样） ───────────────────────── */

    const buildThread = (lines, title, duration) => {
        const sung = (lines || []).filter(line => readableText(line.fullText));
        const messages = [{ kind: 'system', start: 0, text: title ? `《${title}》 群聊 · ${MEMBERS.length + 1} 人` : `群聊 · ${MEMBERS.length + 1} 人` }];
        const counts = new Map();
        sung.forEach((line) => { const k = normLine(line); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
        let last = null;
        let leftCursor = 0;
        let sinceStamp = 0;
        sung.forEach((line, i) => {
            const prev = sung[i - 1];
            const prevEnd = prev ? Math.max(prev.endTime, prev.vocalEndTime || 0) : 0;
            const gap = line.startTime - prevEnd;
            // 间奏：发一条语音，长度就是这段间奏
            if (gap > VOICE_GAP) {
                const start = prev ? prevEnd + 0.6 : Math.min(1.2, line.startTime * 0.25);
                const end = line.startTime - TYPING_LEAD - 0.2;
                if (end - start > 2) {
                    const who = MEMBERS[Math.floor(unit('voice', i, line.startTime) * MEMBERS.length)];
                    messages.push({ kind: 'voice', start, end, sender: who, side: 'left' });
                    last = null;
                    if (end - start > STICKER_GAP) {
                        const others = MEMBERS.filter(m => m !== who);
                        const from = others[Math.floor(unit('sticker-who', i) * others.length)];
                        messages.push({
                            kind: 'sticker', start: start + (end - start) * 0.55, sender: from, side: 'left',
                            sticker: STICKERS[Math.floor(unit('sticker', i, line.startTime) * STICKERS.length)]
                        });
                    }
                }
            }
            // 隔一阵插一个时间戳
            sinceStamp += 1;
            if (i > 0 && (gap > VOICE_GAP || sinceStamp >= 9)) {
                messages.push({ kind: 'system', start: line.startTime - TYPING_LEAD - 0.05, text: fmt(line.startTime), stamp: true });
                sinceStamp = 0;
            }
            const chorus = (counts.get(normLine(line)) || 0) >= 2;
            const short = compactLength(line.fullText) <= 8;
            let sender;
            if ((i + 1) % 4 === 0) sender = ME;
            else if (short && last && unit('carry', i, line.startTime) < 0.55) sender = last;
            else if (unit('side', i, line.startTime) < 0.22) sender = ME;
            else {
                // 不连着两句换回同一个人：从下一个开始轮
                const step = 1 + Math.floor(unit('who', i, line.startTime) * 2);
                leftCursor = (leftCursor + step) % MEMBERS.length;
                sender = MEMBERS[leftCursor];
            }
            const others = MEMBERS.filter(m => m !== sender);
            const echoes = chorus
                ? others.slice().sort((a, b) => unit('echo', i, a.name) - unit('echo', i, b.name)).slice(0, 2 + Math.floor(unit('n', i) * 2))
                : [];
            const roll = unit('react', i, line.startTime);
            const reaction = chorus
                ? { mark: '♪', count: echoes.length + 1 }
                : roll < 0.24 ? { mark: REACTIONS[Math.floor(unit('mark', i) * 4)], count: 1 + Math.floor(unit('cnt', i) * 3) } : null;
            messages.push({
                kind: 'line', start: line.startTime, line, sender, side: sender.me ? 'right' : 'left', chorus, echoes, reaction,
                index: i, continued: last === sender
            });
            last = sender;
        });
        const lastLine = sung[sung.length - 1];
        // 没有歌词：整首歌是一条语音，群里就听着
        if (!lastLine && duration > 6) {
            messages.push({ kind: 'voice', start: 1.2, end: duration - 1.5, sender: MEMBERS[0], side: 'left', whole: true });
        }
        if (lastLine) {
            const end = Math.max(lastLine.endTime, lastLine.vocalEndTime || 0) + 1.5;
            if (!(duration > 0) || end < duration) messages.push({ kind: 'system', start: end, text: '— 曲终 · 群聊结束 —' });
        }
        messages.sort((a, b) => a.start - b.start);
        return messages;
    };

    // 最后一条已经出现的消息（start ≤ t）
    const messageIndexAt = (messages, t) => {
        let lo = 0, hi = messages.length - 1, found = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (messages[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return found;
    };

    // 开唱前「正在输入」的那一条
    const typingAt = (messages, t) => {
        const i = messageIndexAt(messages, t) + 1;
        for (let k = i; k < messages.length && k < i + 3; k += 1) {
            const m = messages[k];
            if (m.kind === 'line') return m.start - t <= TYPING_LEAD ? m : null;
            if (m.kind === 'voice') return null;
        }
        return null;
    };

    const avatarStyle = (sender) => sender.me
        ? ''
        : `--gc-h:${sender.hue}`;

    /* ───────────────────────── 舞台 ───────────────────────── */

    const createManager = (container, services) => {
        const mode = Utils.makeModeBase('groupchat', '群唱', container, services);
        const head = createElement('header', 'gc-head');
        head.innerHTML = '<i class="gc-back">‹</i><div class="gc-title"><b></b><span></span></div><div class="gc-level"><i></i><i></i><i></i><i></i></div>';
        const headTitle = head.querySelector('b');
        const headSub = head.querySelector('span');
        const levels = Array.from(head.querySelectorAll('.gc-level > i'));
        const viewport = createElement('div', 'gc-viewport');
        const list = createElement('div', 'gc-list');
        viewport.append(list);
        const kicker = createElement('div', 'gc-kicker', '群唱');
        mode.root.append(head, viewport, kicker);
        const cardInset = Utils.watchCardInset(mode.root);
        mode.scope.add(() => cardInset.destroy());

        const reducedMotion = global.matchMedia?.('(prefers-reduced-motion: reduce)');
        let messages = [];
        let threadFor = null;
        let shownUpTo = -1;        // 已经放进 DOM 的最后一条消息
        let rows = [];             // { message, el, text, glyphs, shown, tr }
        let typingRow = null;
        let typingFor = null;
        let paused = false;
        let latest = null;
        let lastDraw = -Infinity;
        let lastOnsets = -1;
        let caption = '';
        let sub = '';
        let lastT = -Infinity;
        let voiceRow = null;
        const stats = { rebuilds: 0, rows: 0 };

        const settings = () => {
            const tuning = mode.config.modes?.groupchat || {};
            return {
                fontScale: clamp(tuning.fontScale ?? 1, 0.65, 1.5),
                voiceNotes: tuning.voiceNotes !== false,
                echoes: tuning.echoes !== false,
                reactions: tuning.reactions !== false,
                audioReactivity: clamp(tuning.audioReactivity ?? 1, 0, 2),
                showTranslation: tuning.showTranslation !== false,
                reducedMotion: Boolean(reducedMotion?.matches)
            };
        };
        const applyScale = () => mode.root.style.setProperty('--gc-scale', String(settings().fontScale));
        applyScale();

        // 头像：每人一张自己的小脸；眨眼错开（每人不同的延迟），正在唱的那句的人张嘴
        const avatar = (sender, cls = 'gc-avatar') => {
            const a = createElement('div', `${cls}${sender.me ? ' is-me' : ''}`);
            a.innerHTML = face(sender.me ? '我' : sender.name);
            a.title = sender.name;
            a.style.cssText = `${avatarStyle(sender)};--gc-blink:${(-unit('blink', sender.name) * 5).toFixed(2)}s`;
            return a;
        };

        // 一条消息的 DOM；past 为真时整句直接显示完（拖进度、刚切进来时用）
        const makeRow = (message, past, s) => {
            if (message.kind === 'system') {
                const el = createElement('div', `gc-row gc-system${message.stamp ? ' is-stamp' : ''}`);
                el.append(createElement('span', '', message.text));
                return { message, el };
            }
            const el = createElement('div', `gc-row is-${message.side}`);
            if (message.kind === 'sticker') {
                el.classList.add('is-sticker');
                el.append(avatar(message.sender));
                const body = createElement('div', 'gc-body');
                const sticker = createElement('div', 'gc-sticker');
                sticker.innerHTML = face(message.sender.name, { ...message.sticker, bg: false });
                sticker.setAttribute('role', 'img');
                sticker.setAttribute('aria-label', message.sticker.label);
                body.append(createElement('div', 'gc-name', message.sender.name), sticker);
                el.append(body);
                return { message, el };
            }
            if (message.continued) el.classList.add('is-continued');
            el.append(avatar(message.sender));
            const body = createElement('div', 'gc-body');
            if (!message.sender.me && !message.continued) body.append(createElement('div', 'gc-name', message.sender.name));
            const bubble = createElement('div', 'gc-bubble');
            body.append(bubble);
            el.append(body);
            if (message.kind === 'voice') {
                el.classList.add('is-voice');
                bubble.innerHTML = '<i class="gc-play"></i><div class="gc-wave"></div><span class="gc-dur"></span>';
                const wave = bubble.querySelector('.gc-wave');
                const bars = [];
                for (let i = 0; i < BARS; i += 1) {
                    const b = createElement('i');
                    // 没在播的时候：一条固定的、看着像语音的波形
                    const rest = 0.25 + 0.55 * Math.abs(Math.sin(i * 1.7 + message.start)) * (0.6 + 0.4 * unit('bar', message.start, i));
                    b.style.transform = `scaleY(${rest.toFixed(3)})`;
                    b.dataset.rest = rest.toFixed(3);
                    wave.append(b);
                    bars.push(b);
                }
                bubble.querySelector('.gc-dur').textContent = message.whole ? fmt(message.end - message.start) : `${Math.max(1, Math.round(message.end - message.start))}″`;
                if (message.whole) body.append(createElement('div', 'gc-meta', '这首没有歌词 · 一起听'));
                return { message, el, bars, played: 0 };
            }
            if (message.chorus) el.classList.add('is-chorus');
            const text = createElement('div', 'gc-text');
            bubble.append(text);
            const glyphs = buildGlyphTimeline(message.line);
            let tr = null;
            const supplemental = s.showTranslation ? resolveSupplementalText(message.line) : '';
            if (supplemental) {
                tr = createElement('div', 'gc-tr', supplemental);
                bubble.append(tr);
            }
            const row = { message, el, text, glyphs, shown: 0, tr, bubble, body, meta: null };
            if (message.chorus && s.echoes && message.echoes.length) {
                const echo = createElement('div', 'gc-echo');
                const stack = createElement('div', 'gc-stack');
                message.echoes.forEach(m => stack.append(avatar(m, 'gc-mini')));
                echo.append(stack, createElement('span', '', `${message.echoes.length} 人一起唱`));
                body.append(echo);
                row.echo = echo;
                if (past) echo.classList.add('is-on');
            }
            if (past) {
                text.textContent = message.line.fullText;
                row.shown = glyphs.length;
                el.classList.add('is-past');
                finish(row, s, false);
            } else {
                if (tr) tr.classList.add('is-waiting');
                el.classList.add('is-active');
            }
            return row;
        };

        // 唱完：补上点赞、已读
        const finish = (row, s, animate) => {
            if (row.done) return;
            row.done = true;
            const m = row.message;
            if (row.tr) row.tr.classList.remove('is-waiting');
            const parts = [];
            if (s.reactions && m.reaction) {
                const chip = createElement('span', 'gc-chip', `${m.reaction.mark} ${m.reaction.count}`);
                if (animate && s.live) chip.classList.add('is-pop');
                parts.push(chip);
            }
            if (m.side === 'right') parts.push(createElement('span', 'gc-read', `${2 + (m.index % 4)} 人已读`));
            parts.push(createElement('span', 'gc-time', fmt(m.start)));
            if (parts.length) {
                const meta = createElement('div', 'gc-meta');
                meta.append(...parts);
                row.body.append(meta);
                row.meta = meta;
            }
        };

        const trim = () => {
            while (rows.length > KEEP_ROWS) rows.shift().el.remove();
        };

        // 新行进来时整列往上滑：先把列表往下挪出新行的高度，再过渡回 0
        const pushRow = (row, animate) => {
            const before = list.offsetHeight;
            if (typingRow) list.insertBefore(row.el, typingRow.el); else list.append(row.el);
            rows.push(row);
            if (!animate) return;
            const delta = list.offsetHeight - before;
            row.el.classList.add('is-enter');
            if (delta > 0) {
                list.style.transition = 'none';
                list.style.transform = `translateY(${delta}px)`;
                void list.offsetHeight;
                list.style.transition = '';
                list.style.transform = '';
            }
        };

        const rebuild = (index, s, t) => {
            stats.rebuilds += 1;
            list.replaceChildren();
            rows = [];
            typingRow = null;
            typingFor = null;
            voiceRow = null;
            const from = Math.max(0, index - KEEP_ROWS + 1);
            for (let k = from; k <= index; k += 1) {
                const m = messages[k];
                const live = k === index && (m.kind === 'line' || m.kind === 'voice');
                const row = makeRow(m, !live, s);
                pushRow(row, false);
                if (m.kind === 'voice' && t < m.end) voiceRow = row;
            }
            shownUpTo = index;
        };

        const setTyping = (message, t) => {
            if (typingFor === message) return;
            if (typingRow) { typingRow.el.remove(); typingRow = null; }
            typingFor = message;
            if (!message) return;
            const el = createElement('div', `gc-row gc-typing is-${message.side}`);
            el.append(avatar(message.sender));
            const bubble = createElement('div', 'gc-bubble');
            bubble.innerHTML = '<i></i><i></i><i></i>';
            el.append(bubble);
            typingRow = { el };
            const before = list.offsetHeight;
            list.append(el);
            const delta = list.offsetHeight - before;
            if (delta > 0 && Number.isFinite(t)) {
                list.style.transition = 'none';
                list.style.transform = `translateY(${delta}px)`;
                void list.offsetHeight;
                list.style.transition = '';
                list.style.transform = '';
            }
        };

        const revealRow = (row, t, s) => {
            if (!row.glyphs || row.done) return;
            let count = 0;
            while (count < row.glyphs.length && row.glyphs[count].startTime <= t + 0.02) count += 1;
            if (count < row.shown) {
                row.text.replaceChildren();
                row.shown = 0;
            }
            if (count > row.shown) {
                const frag = global.document.createDocumentFragment();
                for (let i = row.shown; i < count; i += 1) {
                    const span = createElement('span', s.reducedMotion || !s.live ? '' : 'is-new', row.glyphs[i].text);
                    frag.append(span);
                }
                row.text.append(frag);
                row.shown = count;
            }
            const line = row.message.line;
            const end = Math.max(line.endTime, line.vocalEndTime || 0);
            if (row.echo && t >= line.startTime + 0.35) row.echo.classList.add('is-on');
            if (count >= row.glyphs.length && t >= end - 0.05) {
                row.el.classList.remove('is-active');
                row.el.classList.add('is-past');
                finish(row, s, true);
            }
        };

        const updateVoice = (row, frame, s) => {
            const m = row.message;
            const t = frame.playbackTime;
            const live = t >= m.start && t < m.end;
            row.el.classList.toggle('is-playing', live && frame.isPlaying);
            const played = clamp((t - m.start) / Math.max(0.1, m.end - m.start), 0, 1);
            const cut = Math.floor(played * BARS);
            if (cut !== row.played) {
                row.bars.forEach((b, i) => b.classList.toggle('is-played', i < cut));
                row.played = cut;
            }
            if (!live) {
                if (row.wasLive) row.bars.forEach(b => { b.style.transform = `scaleY(${b.dataset.rest})`; });
                row.wasLive = false;
                return;
            }
            row.wasLive = true;
            const spec = frame.audio?.spectrum || [];
            const n = spec.length;
            row.bars.forEach((b, i) => {
                const mirror = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);
                const v = n ? clamp(Number(spec[Math.floor(Math.pow(1 - mirror, 1.6) * n * 0.6)]) || 0, 0, 1) : 0;
                const h = clamp(0.14 + v * 1.1 * s.audioReactivity, 0.12, 1);
                b.style.transform = `scaleY(${h.toFixed(3)})`;
            });
        };

        const updateHeader = (frame, typing, s) => {
            const title = String(frame.track?.title || '').trim() || '群唱';
            const next = `《${title}》`;
            if (next !== caption) { caption = next; headTitle.textContent = next; }
            let subtitle;
            if (typing) subtitle = `${typing.sender.me ? '我' : typing.sender.name} 正在输入…`;
            else if (voiceRow && frame.playbackTime < voiceRow.message.end && frame.playbackTime >= voiceRow.message.start) subtitle = `${voiceRow.message.sender.name} 的语音 · 播放中`;
            else if (frame.lyricsEstimated) subtitle = `${MEMBERS.length + 1} 人 · 纯文本歌词，按时长铺开`;
            else subtitle = `${MEMBERS.length + 1} 人 · ${Utils.lineCounter(frame)}`;
            if (subtitle !== sub) { sub = subtitle; headSub.textContent = subtitle; head.classList.toggle('is-typing', Boolean(typing)); }
            // 右上角的电平小格
            const a = frame.audio || {};
            const vals = [a.bass, a.lowMid, a.vocal, a.treble];
            levels.forEach((el, i) => {
                const v = frame.isPlaying && !s.reducedMotion ? clamp((Number(vals[i]) || 0) * 1.3 * s.audioReactivity, 0.08, 1) : 0.15;
                el.style.transform = `scaleY(${v.toFixed(2)})`;
            });
        };

        const step = (frame) => {
            const s = settings();
            s.live = Boolean(frame.isPlaying);
            mode.root.classList.toggle('is-live', s.live && !s.reducedMotion);
            const t = frame.playbackTime || 0;
            const key = `${frame.track?.path || frame.track?.title || ''}|${Math.round(frame.duration || 0)}`;
            if (!threadFor || threadFor.lines !== frame.lines || threadFor.key !== key) {
                messages = buildThread(frame.lines, String(frame.track?.title || '').trim(), frame.duration);
                threadFor = { lines: frame.lines, key };
                shownUpTo = -2;
            }
            const index = messageIndexAt(messages, t);
            // 往回拖、或者一下跳过好几条：整列重排；正常播放：一条一条加
            if (index < shownUpTo || index > shownUpTo + 2 || t < lastT - 0.5) rebuild(index, s, t);
            else {
                while (shownUpTo < index) {
                    shownUpTo += 1;
                    const m = messages[shownUpTo];
                    const prevActive = rows.filter(r => r.glyphs && !r.done);
                    prevActive.forEach((r) => {
                        r.text.textContent = r.message.line.fullText;
                        r.shown = r.glyphs.length;
                        r.el.classList.remove('is-active');
                        r.el.classList.add('is-past');
                        finish(r, s, true);
                    });
                    if (typingFor === m) { typingRow?.el.remove(); typingRow = null; typingFor = null; }
                    const row = makeRow(m, false, s);
                    pushRow(row, !s.reducedMotion && s.live);
                    if (m.kind === 'voice') voiceRow = row;
                }
                trim();
            }
            lastT = t;
            stats.rows = rows.length;

            const typing = typingAt(messages, t);
            setTyping(typing, frame.isPlaying && !s.reducedMotion ? t : NaN);
            rows.forEach((row) => { if (row.glyphs && !row.done) revealRow(row, t, s); });
            if (voiceRow) {
                if (!s.voiceNotes) voiceRow.el.hidden = true;
                else { voiceRow.el.hidden = false; updateVoice(voiceRow, frame, s); }
            }
            updateHeader(frame, typing, s);

            // 鼓点：正在唱的那条轻轻一跳
            const audio = frame.audio || {};
            const onset = Number.isFinite(audio.onsets) && audio.onsets !== lastOnsets;
            if (Number.isFinite(audio.onsets)) lastOnsets = audio.onsets;
            if (onset && frame.isPlaying && !s.reducedMotion) {
                const active = rows.find(r => r.glyphs && !r.done);
                if (active) {
                    active.bubble.classList.remove('is-thump');
                    void active.bubble.offsetWidth;
                    active.bubble.classList.add('is-thump');
                }
            }
            const chorusNow = rows.some(r => r.message.chorus && !r.done);
            mode.root.classList.toggle('is-chorus', chorusNow);
            const cap = `群唱 · ${Utils.lineCounter(frame)}`;
            if (cap !== kicker.textContent) kicker.textContent = cap;
        };

        mode.updateFrame = (frame) => {
            if (mode.destroyed || paused) return;
            frame = Utils.withPlainLyrics(frame);   // 只有纯文本歌词时按时长铺开
            latest = frame;
            const aim = 1000 / (FPS[mode.config.quality || 'standard'] || 30);
            const now = frame.now ?? performance.now();
            if (now < lastDraw) lastDraw = -Infinity;
            if (frame.isPlaying && now - lastDraw < aim - 3) return;
            if (!frame.isPlaying && frame.playbackTime === lastT && threadFor && threadFor.lines === frame.lines) return;
            lastDraw = now - lastDraw < aim * 2 ? lastDraw + aim : now;
            step(frame);
        };

        const refresh = () => { lastDraw = -Infinity; shownUpTo = -2; threadFor = null; if (latest) mode.updateFrame(latest); };
        const updateConfig = mode.updateConfig;
        mode.updateConfig = (config) => { updateConfig(config); applyScale(); refresh(); };
        mode.resize = () => cardInset.measure();
        mode.suspend = () => { paused = true; mode.root.classList.add('is-suspended'); };
        mode.resume = () => { paused = false; mode.root.classList.remove('is-suspended'); lastDraw = -Infinity; if (latest) mode.updateFrame(latest); };
        mode.updateTheme = () => {};
        mode.getDebugSnapshot = () => ({ initialized: true, messages: messages.length, rows: stats.rows, rebuilds: stats.rebuilds });
        return mode;
    };

    global.MusicStageGroupchatManager = Object.freeze({
        create: createManager,
        _test: Object.freeze({ buildThread, messageIndexAt, typingAt, MEMBERS, ME, TYPING_LEAD })
    });
})(window);
