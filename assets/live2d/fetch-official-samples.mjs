// Downloads Live2D official sample models into assets/live2d/local/ (git-ignored).
// These models are under the Live2D Free Material License, which does not allow
// redistributing the files, so they are fetched on demand instead of committed.
// Running this script means you accept that license:
// https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html
//
// Usage: node assets/live2d/fetch-official-samples.mjs [Natori Mao Haru ...]
// With no names it fetches the expression-capable set: Natori Mao Haru.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLES_RAW = 'https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources';
const KNOWN = ['Haru', 'Hiyori', 'Mao', 'Mark', 'Natori', 'Ren', 'Rice', 'Wanko'];
const DEFAULT = ['Natori', 'Mao', 'Haru'];
const outRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'local');

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function modelRefs(model) {
  const refs = model.FileReferences || {};
  const files = [refs.Moc, refs.Physics, refs.Pose, refs.UserData, refs.DisplayInfo, ...(refs.Textures || [])];
  for (const e of refs.Expressions || []) files.push(e.File);
  for (const group of Object.values(refs.Motions || {})) {
    for (const m of group) files.push(m.File, m.Sound);
  }
  return [...new Set(files.filter(Boolean))];
}

async function fetchModel(name) {
  const base = `${SAMPLES_RAW}/${name}`;
  const dir = path.join(outRoot, name);
  const manifest = await download(`${base}/${name}.model3.json`);
  const refs = modelRefs(JSON.parse(manifest));
  let total = manifest.length;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.model3.json`), manifest);
  for (const rel of refs) {
    const target = path.resolve(dir, rel);
    if (!target.startsWith(dir + path.sep)) throw new Error(`refusing path outside model dir: ${rel}`);
    const data = await download(`${base}/${rel.split('/').map(encodeURIComponent).join('/')}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    total += data.length;
  }
  console.log(`${name}: ${refs.length + 1} files, ${(total / 1024 / 1024).toFixed(1)} MB -> ${dir}`);
}

const names = process.argv.slice(2);
for (const name of names.length ? names : DEFAULT) {
  if (!KNOWN.includes(name)) {
    console.error(`unknown sample "${name}", choose from: ${KNOWN.join(' ')}`);
    process.exitCode = 1;
    continue;
  }
  await fetchModel(name);
}
