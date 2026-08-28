import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const readPng = name => fs.readFileSync(path.join(root, 'reports', name));
const decode = buffer => {
    let offset = 8; let width; let height; let bitDepth; let colorType; const chunks = [];
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset); const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
        const data = buffer.subarray(offset + 8, offset + 8 + length); offset += length + 12;
        if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
        if (type === 'IDAT') chunks.push(data);
    }
    if (bitDepth !== 8 || colorType !== 2) throw new Error(`Menu ROI comparator requires RGB8 PNG (got bitDepth=${bitDepth}, colorType=${colorType})`);
    const stride = width * 3; const raw = zlib.inflateSync(Buffer.concat(chunks)); const pixels = Buffer.alloc(stride * height); let cursor = 0; let previous = Buffer.alloc(stride);
    for (let y = 0; y < height; y += 1) {
        const filter = raw[cursor++]; const row = Buffer.from(raw.subarray(cursor, cursor + stride)); cursor += stride;
        for (let x = 0; x < stride; x += 1) { const left = x >= 3 ? row[x - 3] : 0; const above = previous[x]; const upperLeft = x >= 3 ? previous[x - 3] : 0; if (filter === 1) row[x] = (row[x] + left) & 255; else if (filter === 2) row[x] = (row[x] + above) & 255; else if (filter === 3) row[x] = (row[x] + Math.floor((left + above) / 2)) & 255; else if (filter === 4) { const pa = Math.abs(above - upperLeft); const pb = Math.abs(left - upperLeft); const pc = Math.abs(left + above - upperLeft * 2); row[x] = (row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 255; } }
        row.copy(pixels, y * stride); previous = row;
    }
    return { width, height, pixels };
};
const sourceImage = readPng('harness-menu-source.png'); const candidateImage = readPng('vcp-menu-candidate.png');
const harness = decode(sourceImage); const vcp = decode(candidateImage); const comparable = harness.width === vcp.width && harness.height === vcp.height;
let differentPixels = 0; let totalChannelDelta = 0;
if (comparable) for (let i = 0; i < harness.pixels.length; i += 3) { const delta = Math.abs(harness.pixels[i] - vcp.pixels[i]) + Math.abs(harness.pixels[i + 1] - vcp.pixels[i + 1]) + Math.abs(harness.pixels[i + 2] - vcp.pixels[i + 2]); if (delta) differentPixels += 1; totalChannelDelta += delta; }
const report = { generatedAt: new Date().toISOString(), component: 'menu', comparison: 'strict same-engine Menu ROI decoded RGB pixel comparison', harness: { sha256: crypto.createHash('sha256').update(sourceImage).digest('hex'), width: harness.width, height: harness.height }, vcp: { sha256: crypto.createHash('sha256').update(candidateImage).digest('hex'), width: vcp.width, height: vcp.height }, comparable, differentPixels, totalPixels: harness.width * harness.height, pixelRatio: comparable ? differentPixels / (harness.width * harness.height) : null, totalChannelDelta: comparable ? totalChannelDelta : null, exactPixelPass: comparable && differentPixels === 0, pass: comparable && differentPixels === 0, note: 'Strict ROI evidence is independent from DOM/ARIA and production-consumer boundaries.' };
fs.writeFileSync(path.join(root, 'reports/harness-vcp-menu-roi-pixel-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Menu ROI pixels: comparable=${report.comparable}; exact=${report.exactPixelPass}; different=${differentPixels}/${report.totalPixels}.`);
