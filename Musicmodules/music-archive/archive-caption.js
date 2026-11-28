/*
 * 档案卡面左侧的文字栏：格式、码率、曲名、歌手。
 *
 * 卡面左边有竖排字、内圈刻线和两个十字，这一栏收在它们里面（位置和大小由 archive-scene.js 的 CAPTION 决定），
 * 这里只管在离屏画布上排字：按宽度断行、拉丁字母尽量在空格处断、放不下的最后一行用省略号收尾，不压扁字。
 */
(function (global) {
    'use strict';

    const wrapText = (ctx, text, width, maxLines) => {
        const chars = Array.from(String(text || '').trim());
        const lines = [];
        while (chars.length && lines.length < maxLines) {
            let end = 1;
            while (end < chars.length && ctx.measureText(chars.slice(0, end + 1).join('')).width <= width) end++;
            const last = lines.length === maxLines - 1;
            if (end < chars.length && !last) {
                const space = chars.slice(0, end).lastIndexOf(' ');
                if (space > 0) end = space + 1;
            }
            let line = chars.splice(0, end).join('').trim();
            if (last && chars.length) {
                while (line.length > 1 && ctx.measureText(line + '…').width > width) line = Array.from(line).slice(0, -1).join('').trimEnd();
                line += '…';
            }
            if (line) lines.push(line);
        }
        return lines;
    };

    // 格式一般只有 3–4 个字母，给它窄一点的格子；码率（如 1634 kbps）拿剩下的宽度
    const FIELD_SPLIT = 104;

    const draw = (canvas, { title = '', artist = '', format = '', bitrate = '' }, { ink, fontStack, showTitle }) => {
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = ink;
        ctx.textBaseline = 'alphabetic';
        // 格式、码率：栏顶一行两格
        const fields = [['格式', format], ['码率', bitrate]].filter(([, value]) => value);
        fields.forEach(([label, value], i) => {
            const x = i === 0 ? 0 : FIELD_SPLIT;
            ctx.font = `400 18px ${fontStack}`;
            ctx.globalAlpha = 0.72;
            ctx.fillText(label, x, 24);
            ctx.globalAlpha = 1;
            ctx.font = `600 24px ${fontStack}`;
            const room = (fields.length === 1 ? W : (i === 0 ? FIELD_SPLIT : W - FIELD_SPLIT)) - 8;
            ctx.fillText(wrapText(ctx, value, room, 1)[0] || '', x, 56);
        });
        if (!showTitle) return;
        // 曲名最多三行；歌手紧跟在曲名下面，整块压在栏底（和封面下沿差不多齐）
        ctx.font = `700 40px ${fontStack}`;
        const lines = wrapText(ctx, title, W - 2, 3);
        let y = H - 20 - (artist ? 38 : 0) - (lines.length - 1) * 50;
        for (const line of lines) { ctx.fillText(line, 0, y); y += 50; }
        if (artist) {
            ctx.font = `500 24px ${fontStack}`;
            ctx.globalAlpha = 0.85;
            ctx.fillText(wrapText(ctx, artist, W - 2, 1)[0] || '', 0, y - 4);
            ctx.globalAlpha = 1;
        }
    };

    const api = { wrapText, draw };
    global.ArchiveCaption = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
