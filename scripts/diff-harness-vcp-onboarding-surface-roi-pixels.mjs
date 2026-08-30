import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, 'reports', file));
const decode = buffer => {
  let cursor = 8; let width; let height; let bitDepth; let colorType; const chunks = [];
  while (cursor < buffer.length) { const length = buffer.readUInt32BE(cursor); const type = buffer.subarray(cursor + 4, cursor + 8).toString(); const data = buffer.subarray(cursor + 8, cursor + 8 + length); cursor += 12 + length; if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; } if (type === 'IDAT') chunks.push(data); }
  if (bitDepth !== 8 || colorType !== 2) throw new Error('only RGB8 non-interlaced PNG supported');
  const stride = width * 3; const raw = zlib.inflateSync(Buffer.concat(chunks)); const pixels = Buffer.alloc(stride * height); let offset = 0; let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) { const filter = raw[offset++]; const row = Buffer.from(raw.subarray(offset, offset + stride)); offset += stride; for (let x = 0; x < stride; x += 1) { const left = x >= 3 ? row[x - 3] : 0; const up = previous[x]; const upperLeft = x >= 3 ? previous[x - 3] : 0; if (filter === 1) row[x] = (row[x] + left) & 255; else if (filter === 2) row[x] = (row[x] + up) & 255; else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255; else if (filter === 4) { const pa = Math.abs(up - upperLeft); const pb = Math.abs(left - upperLeft); const pc = Math.abs(left + up - upperLeft - upperLeft); row[x] = (row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 255; } } row.copy(pixels, y * stride); previous = row; }
  return { width, height, pixels };
};
const harness = read('harness-onboarding-surface-source.png'); const vcp = read('vcp-onboarding-surface-candidate.png'); const a = decode(harness); const b = decode(vcp); const comparable = a.width === b.width && a.height === b.height; let differentPixels = 0; let totalChannelDelta = 0;
if (comparable) for (let index = 0; index < a.pixels.length; index += 3) { const delta = Math.abs(a.pixels[index] - b.pixels[index]) + Math.abs(a.pixels[index + 1] - b.pixels[index + 1]) + Math.abs(a.pixels[index + 2] - b.pixels[index + 2]); if (delta) differentPixels += 1; totalChannelDelta += delta; }
const report = { generatedAt: new Date().toISOString(), component: 'onboarding-surface', comparison: 'strict same-engine OnboardingSurface full-surface decoded RGB pixel comparison', harness: { bytes: harness.length, sha256: crypto.createHash('sha256').update(harness).digest('hex'), width: a.width, height: a.height }, vcp: { bytes: vcp.length, sha256: crypto.createHash('sha256').update(vcp).digest('hex'), width: b.width, height: b.height }, comparable, differentPixels, totalPixels: a.width * a.height, pixelRatio: comparable ? differentPixels / (a.width * a.height) : null, totalChannelDelta: comparable ? totalChannelDelta : null, exactPixelPass: comparable && differentPixels === 0, pass: comparable && differentPixels === 0, note: 'Full-surface RGB equality is fixture-scoped evidence and does not close source lifecycle, consumer, or production boundaries.' };
fs.writeFileSync(path.join(root, 'reports/harness-vcp-onboarding-surface-roi-pixel-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP OnboardingSurface pixels: exact=${report.exactPixelPass}; different=${differentPixels}/${report.totalPixels}.`);
