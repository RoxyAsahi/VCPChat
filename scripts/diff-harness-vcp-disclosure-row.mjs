import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const reports = path.join(root, 'reports');
const readJson = name => JSON.parse(fs.readFileSync(path.join(reports, name), 'utf8'));
const harness = readJson('harness-disclosure-row-source.json');
const candidate = readJson('vcp-harness-disclosure-row-candidate.json');
const normalize = value => value === '0' ? 0 : value;
const checks = [
  ['row.role', harness.rowOpen.row.role, candidate.row.role],
  ['row.tabIndex', harness.rowOpen.row.tabIndex, candidate.row.tabIndex],
  ['row.ariaExpanded', harness.rowOpen.row.ariaExpanded, candidate.row.ariaExpanded],
  ['row.display', harness.rowOpen.row.display, candidate.row.display],
  ['row.alignItems', harness.rowOpen.row.alignItems, candidate.row.alignItems],
  ['row.height', harness.rowOpen.row.height, candidate.row.height],
  ['row.overflow', harness.rowOpen.row.overflow, candidate.row.overflow],
  ['leading.tag', harness.rowOpen.leading.tag, candidate.leading.tag],
  ['leading.width', harness.rowOpen.leading.width, candidate.leading.width],
  ['leading.height', harness.rowOpen.leading.height, candidate.leading.height],
  ['leading.marginRight', harness.rowOpen.leading.marginRight, candidate.leading.marginRight],
  ['leading.padding', harness.rowOpen.leading.padding, candidate.leading.padding],
  ['leading.borderWidth', harness.rowOpen.leading.borderWidth, candidate.leading.borderWidth],
  ['leading.chevron', harness.rowOpen.leading.chevron, candidate.leading.chevron],
  ['title.fontSize', harness.rowOpen.title.fontSize, candidate.title.fontSize],
  ['title.lineHeight', harness.rowOpen.title.lineHeight, candidate.title.lineHeight],
  ['summaryVisible', harness.rowOpen.summaryVisible, candidate.summaryVisible],
  ['bodyVisible', harness.rowOpen.bodyVisible, candidate.bodyVisible],
].map(([field, expected, actual]) => ({ field, harness: expected, vcp: actual, pass: normalize(expected) === normalize(actual) }));

function decodePng(buffer) {
  let offset = 8; let width; let height; let bitDepth; let colorType; const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset); const type = buffer.subarray(offset + 4, offset + 8).toString();
    const data = buffer.subarray(offset + 8, offset + 8 + length); offset += length + 12;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === 'IDAT') chunks.push(data);
  }
  if (bitDepth !== 8 || colorType !== 2) throw new Error('DisclosureRow pixel diff requires RGB8 PNG');
  return { width, height, bytes: buffer.length, pixels: zlib.inflateSync(Buffer.concat(chunks)) };
}
const harnessPng = fs.readFileSync(path.join(reports, 'harness-disclosure-row-source.png'));
const candidatePng = fs.readFileSync(path.join(reports, 'vcp-harness-disclosure-row-candidate.png'));
const a = decodePng(harnessPng); const b = decodePng(candidatePng);
const comparable = a.width === b.width && a.height === b.height;
let differentPixels = null; let totalChannelDelta = null;
if (comparable) {
  differentPixels = 0; totalChannelDelta = 0;
  for (let i = 0; i < a.pixels.length; i += 3) {
    const delta = Math.abs(a.pixels[i] - b.pixels[i]) + Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) + Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
    if (delta) differentPixels += 1; totalChannelDelta += delta;
  }
}
const report = {
  generatedAt: new Date().toISOString(), component: 'disclosure-row',
  semanticFixture: { harness: harness.semanticFixture, vcp: 'disclosure-row/row-click-open-keep-content', alignedState: 'rowOpen ↔ candidate', pass: true },
  dom: { structuralPass: checks.every(item => item.pass), checks },
  computedStyle: { pass: checks.filter(item => /display|alignItems|height|overflow|width|marginRight|padding|borderWidth|fontSize|lineHeight/.test(item.field)).every(item => item.pass), fields: checks.filter(item => /display|alignItems|height|overflow|width|marginRight|padding|borderWidth|fontSize|lineHeight/.test(item.field)) },
  pixel: { comparison: 'strict decoded RGB screenshot comparison; no crop or resize', comparable, harness: { width: a.width, height: a.height, bytes: a.bytes, sha256: crypto.createHash('sha256').update(harnessPng).digest('hex') }, vcp: { width: b.width, height: b.height, bytes: b.bytes, sha256: crypto.createHash('sha256').update(candidatePng).digest('hex') }, differentPixels, totalChannelDelta, exactPixelPass: comparable && differentPixels === 0, status: comparable ? 'compared' : 'not-comparable-geometry' },
  pass: false,
  missingEvidence: ['same screenshot geometry/ROI capture scope', 'authorized VCP production consumer; chat/message integration remains frozen'],
  note: 'Structural and computed-style fields are compared independently from screenshot dimensions. This Candidate Lab report is non-promoting and does not authorize chat/message consumer wiring.',
};
fs.writeFileSync(path.join(reports, 'harness-vcp-disclosure-row-diff.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Harness↔VCP DisclosureRow diff: structural=${report.dom.structuralPass}; computedStyle=${report.computedStyle.pass}; pixel=${report.pixel.status}; pass=false.`);
