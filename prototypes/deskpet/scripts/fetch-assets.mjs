// Downloads the parts this prototype must not commit: Cubism Core (Live2D
// Proprietary Software License) and a sample model (Free Material License).
// Usage: node scripts/fetch-assets.mjs [--core <local live2dcubismcore.min.js>] [--model Hiyori]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';
const SAMPLES_RAW = 'https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources';

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function write(rel, data) {
  const file = path.join(vendor, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

async function fetchCore() {
  const local = argValue('--core');
  const data = local ? await fs.readFile(local) : await download(CORE_URL);
  await write('live2dcubismcore.min.js', data);
  console.log(`core: ${data.length} bytes`);
}

function modelRefs(model) {
  const refs = model.FileReferences || {};
  const list = [refs.Moc, refs.Physics, refs.Pose, refs.UserData, refs.DisplayInfo, ...(refs.Textures || [])];
  for (const group of Object.values(refs.Motions || {})) {
    for (const motion of group) list.push(motion.File, motion.Sound);
  }
  for (const expression of refs.Expressions || []) list.push(expression.File);
  return list.filter(Boolean);
}

async function fetchModel(name) {
  const base = `${SAMPLES_RAW}/${name}`;
  const manifest = await download(`${base}/${name}.model3.json`);
  await write(`models/${name}/${name}.model3.json`, manifest);
  let total = manifest.length;
  for (const rel of modelRefs(JSON.parse(manifest))) {
    const data = await download(`${base}/${rel}`);
    await write(`models/${name}/${rel}`, data);
    total += data.length;
  }
  console.log(`model ${name}: ${total} bytes`);
}

await fetchCore();
await fetchModel(argValue('--model', 'Hiyori'));
