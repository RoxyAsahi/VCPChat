import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(await fs.readFile(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));
const fieldFixture = { width: 1680, height: 1000, deviceScaleFactor: 1, reason: 'Harness Plugin Settings is not reachable through the narrow 800px navigation.' };
const crc32 = buffer => { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; };
function decode(buffer) {
    if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not PNG');
    let offset = 8; let width; let height; let type; const chunks = [];
    while (offset < buffer.length) { const length = buffer.readUInt32BE(offset); const name = buffer.toString('ascii', offset + 4, offset + 8); const data = buffer.subarray(offset + 8, offset + 8 + length); offset += length + 12; if (name === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; } if (name === 'IDAT') chunks.push(data); if (name === 'IEND') break; }
    if (![2, 6].includes(type)) throw new Error(`unsupported color type ${type}`);
    const bpp = type === 6 ? 4 : 3; const source = zlib.inflateSync(Buffer.concat(chunks)); const rowSize = width * bpp; const pixels = Buffer.alloc(width * height * 4); let input = 0;
    const paeth = (a, b, c) => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
    for (let y = 0; y < height; y++) { const filter = source[input++]; const row = Buffer.alloc(rowSize); for (let x = 0; x < rowSize; x++) { const left = x >= bpp ? row[x - bpp] : 0; const up = y ? pixels[(y - 1) * width * 4 + Math.floor(x / bpp) * 4 + x % bpp] : 0; const upperLeft = y && x >= bpp ? pixels[(y - 1) * width * 4 + (Math.floor(x / bpp) - 1) * 4 + x % bpp] : 0; const sourceValue = source[input++]; row[x] = (sourceValue + (filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft))) & 255; } for (let x = 0; x < width; x++) { for (let channel = 0; channel < 3; channel++) pixels[(y * width + x) * 4 + channel] = row[x * bpp + channel]; pixels[(y * width + x) * 4 + 3] = bpp === 4 ? row[x * bpp + 3] : 255; } }
    return { width, height, pixels };
}
function encode(width, height, pixels) { const chunk = (type, data) => { const tag = Buffer.from(type); const output = Buffer.alloc(data.length + 12); output.writeUInt32BE(data.length, 0); tag.copy(output, 4); data.copy(output, 8); output.writeUInt32BE(crc32(Buffer.concat([tag, data])), data.length + 8); return output; }; const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 0); header[8] = 8; header[9] = 6; const raw = Buffer.alloc(height * (width * 4 + 1)); for (let y = 0; y < height; y++) pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }

const results = [];
for (const state of ['description', 'error']) {
    const harnessPath = path.join(root, `reports/harness-field-${state}.png`);
    const vcpPath = path.join(root, `reports/vcp-field-${state}.png`);
    const [harness, vcp] = await Promise.all([fs.readFile(harnessPath).then(decode), fs.readFile(vcpPath).then(decode)]);
    const comparable = harness.width === vcp.width && harness.height === vcp.height;
    let differentPixels = 0; let totalDelta = 0; let diff;
    if (comparable) { diff = Buffer.alloc(harness.pixels.length); for (let index = 0; index < harness.pixels.length; index += 4) { const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(harness.pixels[index + channel] - vcp.pixels[index + channel]))); if (delta) differentPixels++; totalDelta += delta; diff[index] = delta ? 255 : 0; diff[index + 3] = 255; } }
    const totalPixels = comparable ? harness.width * harness.height : 0;
    const differingRatio = totalPixels ? differentPixels / totalPixels : null;
    const meanChannelDelta = totalPixels ? totalDelta / totalPixels : null;
    const diffImage = comparable ? path.join(root, `reports/harness-vcp-field-${state}-pixel-diff.png`) : null;
    if (diff) await fs.writeFile(diffImage, encode(harness.width, harness.height, diff));
    results.push({ state, harness: { path: harnessPath, width: harness.width, height: harness.height }, vcp: { path: vcpPath, width: vcp.width, height: vcp.height }, comparable, differentPixels, totalPixels, differingRatio, meanChannelDelta, diffImage, pass: comparable && differingRatio <= policy.maxDifferingRatio && meanChannelDelta <= policy.maxMeanChannelDelta });
}
const report = { generatedAt: new Date().toISOString(), policy, fixtureViewport: fieldFixture, comparisonRegion: 'direct Field root screenshot clip', cases: results, comparable: results.every(item => item.comparable), pass: results.every(item => item.pass), status: results.every(item => item.pass) ? 'cross-page-field-pixel-equivalent' : results.some(item => !item.comparable) ? 'pending-field-dimension-mismatch' : 'cross-page-field-pixel-mismatch', missingEvidence: [] };
await fs.writeFile(path.join(root, 'reports/harness-vcp-field-pixel-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP Field pixel report written (${report.status}; pass=${report.pass}).`);
