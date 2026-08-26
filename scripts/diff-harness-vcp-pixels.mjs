import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessFile = process.env.HARNESS_SCREENSHOT || path.join(root, 'reports/harness-settings-production.png');
const vcpFile = process.env.VCP_SCREENSHOT || path.join(root, 'reports/vcp-uiux-primitive-contract.png');
const output = path.join(root, 'reports/harness-vcp-pixel-diff.json');

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

let report;
try {
    const [harnessBuffer, vcpBuffer] = await Promise.all([fs.readFile(harnessFile), fs.readFile(vcpFile)]);
    const harness = decodePng(harnessBuffer); const vcp = decodePng(vcpBuffer);
    const comparable = harness.width === vcp.width && harness.height === vcp.height;
    const count = comparable ? harness.width * harness.height : 0; let different = 0; let totalDelta = 0;
    if (comparable) for (let i = 0; i < harness.pixels.length; i += 4) { const d = Math.max(Math.abs(harness.pixels[i]-vcp.pixels[i]), Math.abs(harness.pixels[i+1]-vcp.pixels[i+1]), Math.abs(harness.pixels[i+2]-vcp.pixels[i+2]), Math.abs(harness.pixels[i+3]-vcp.pixels[i+3])); totalDelta += d; if (d > 0) different++; }
    report = { generatedAt: new Date().toISOString(), status: comparable ? 'compared-but-semantic-baseline-mismatch' : 'pending-dimension-mismatch', harness: { path: harnessFile, width: harness.width, height: harness.height }, vcp: { path: vcpFile, width: vcp.width, height: vcp.height }, comparable, differentPixels: different, totalPixels: count, differingRatio: count ? different / count : null, meanChannelDelta: count ? totalDelta / count : null, pass: false, missingEvidence: ['same semantic fixture route', 'pixel tolerance policy', 'reviewable diff image'] };
} catch (error) { report = { generatedAt: new Date().toISOString(), status: 'pending-missing-or-invalid-input', pass: false, error: error.message, harness: harnessFile, vcp: vcpFile }; }
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness↔VCP pixel diff report written (status=${report.status}; pass=false).`);
