import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessFile = process.env.HARNESS_SCREENSHOT || path.join(root, 'reports/harness-settings-production.png');
const vcpFile = process.env.VCP_SCREENSHOT || path.join(root, 'reports/vcp-uiux-primitive-contract.png');
const output = path.join(root, 'reports/harness-vcp-pixel-diff.json');
const policy = JSON.parse(await fs.readFile(path.join(root, 'docs/reference/deepseek-harness-primitives/pixel-policy.json'), 'utf8'));
const geometryReport = JSON.parse(await fs.readFile(path.join(root, 'reports/harness-vcp-geometry-diff.json'), 'utf8').catch(() => '{}'));

function decodePng(buffer) {
    if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not PNG');
    let offset = 8; let width; let height; let colorType; const idat = [];
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset); const type = buffer.toString('ascii', offset + 4, offset + 8); const data = buffer.subarray(offset + 8, offset + 8 + length); offset += 12 + length;
        if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
        if (type === 'IDAT') idat.push(data);
        if (type === 'IEND') break;
    }
    if (![2, 6].includes(colorType)) throw new Error(`unsupported PNG color type ${colorType}; expected RGB/RGBA`);
    const raw = zlib.inflateSync(Buffer.concat(idat)); const sourceBpp = colorType === 6 ? 4 : 3; const sourceStride = width * sourceBpp; const stride = width * 4; const pixels = Buffer.alloc(height * stride); let src = 0;
    const paeth = (a,b,c) => { const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c); return pa<=pb&&pa<=pc?a:pb<=pc?b:c; };
    for (let y=0; y<height; y++) { const filter=raw[src++]; const row=Buffer.alloc(sourceStride); for(let x=0;x<sourceStride;x++){ const left=x>=sourceBpp?row[x-sourceBpp]:0; const up=y>0?pixels[(y-1)*stride+Math.floor(x/sourceBpp)*4+(x%sourceBpp)]:0; const ul=y>0&&x>=sourceBpp?pixels[(y-1)*stride+(Math.floor(x/sourceBpp)-1)*4+(x%sourceBpp)]:0; const value=raw[src++]; row[x]=(value + (filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,ul))) & 255; } for(let x=0;x<width;x++){ pixels[y*stride+x*4]=row[x*sourceBpp]; pixels[y*stride+x*4+1]=row[x*sourceBpp+1]; pixels[y*stride+x*4+2]=row[x*sourceBpp+2]; pixels[y*stride+x*4+3]=sourceBpp===4?row[x*sourceBpp+3]:255; } }
    return { width, height, pixels };
}

function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) { c ^= byte; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function encodePng(width, height, pixels) {
    const chunk = (type, data) => { const t = Buffer.from(type); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); t.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([t, data])), 8 + data.length); return out; };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(height * (width * 4 + 1)); for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4); }
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let report;
try {
    if (policy.semanticFixtureRequired && geometryReport.semanticFixture?.same !== true) {
        report = { generatedAt: new Date().toISOString(), status: 'semantic-fixture-pending', policy, semanticFixture: geometryReport.semanticFixture ?? null, harness: harnessFile, vcp: vcpFile, comparable: false, pass: false, missingEvidence: ['same semantic fixture route'] };
        await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(`Harness↔VCP pixel diff report written (status=${report.status}; pass=false).`);
        process.exit(0);
    }
    const [harnessBuffer, vcpBuffer] = await Promise.all([fs.readFile(harnessFile), fs.readFile(vcpFile)]);
    const harness = decodePng(harnessBuffer); const vcp = decodePng(vcpBuffer);
    const comparable = harness.width === vcp.width && harness.height === vcp.height;
    const count = comparable ? harness.width * harness.height : 0; let different = 0; let totalDelta = 0;
    let diffPixels = null;
    if (comparable) { diffPixels = Buffer.alloc(harness.pixels.length); for (let i = 0; i < harness.pixels.length; i += 4) { const d = Math.max(Math.abs(harness.pixels[i]-vcp.pixels[i]), Math.abs(harness.pixels[i+1]-vcp.pixels[i+1]), Math.abs(harness.pixels[i+2]-vcp.pixels[i+2]), Math.abs(harness.pixels[i+3]-vcp.pixels[i+3])); totalDelta += d; if (d > 0) different++; diffPixels[i] = d > 0 ? 255 : 0; diffPixels[i + 1] = 0; diffPixels[i + 2] = 0; diffPixels[i + 3] = d > 0 ? 255 : 0; } }
    const diffImage = path.join(root, 'reports/harness-vcp-pixel-diff.png'); if (diffPixels) await fs.writeFile(diffImage, encodePng(harness.width, harness.height, diffPixels));
    const differingRatio = count ? different / count : null; const meanChannelDelta = count ? totalDelta / count : null;
    report = { generatedAt: new Date().toISOString(), status: comparable ? 'compared-but-semantic-baseline-mismatch' : 'pending-dimension-mismatch', policy, harness: { path: harnessFile, width: harness.width, height: harness.height }, vcp: { path: vcpFile, width: vcp.width, height: vcp.height }, comparable, differentPixels: different, totalPixels: count, differingRatio, meanChannelDelta, diffImage: diffPixels ? diffImage : null, pass: false, missingEvidence: ['same semantic fixture route'] };
} catch (error) { report = { generatedAt: new Date().toISOString(), status: 'pending-missing-or-invalid-input', pass: false, error: error.message, harness: harnessFile, vcp: vcpFile }; }
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness↔VCP pixel diff report written (status=${report.status}; pass=false).`);
