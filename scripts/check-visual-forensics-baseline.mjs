import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dirs = process.argv.slice(2).filter(Boolean);
const targets = dirs.length ? dirs : [
  path.join(root, 'reports/visual-forensics-qa/light'),
  path.join(root, 'reports/visual-forensics-qa/dark'),
];
const viewports = [[800, 600], [1280, 800], [1680, 1000]];
const suffixes = ['initial', 'settings', 'states', 'scrolled', 'narrow', 'restored', 'hover', 'focus'];
const failures = [];

const baseline = JSON.parse(await fs.readFile(path.join(root, 'docs/visual-qa/fixtures/visual-forensics-pixel-baseline.json'), 'utf8'));
assert.equal(baseline.schemaVersion, 1);
const matrix = JSON.parse(await fs.readFile(path.join(root, 'docs/visual-qa/fixtures/visual-forensics-fixture-matrix.json'), 'utf8'));
const fixtureBySuffix = new Map(matrix.fixtures.filter(fixture => fixture.screenshotSuffix).map(fixture => [fixture.screenshotSuffix, fixture]));

const pixels = async file => {
  const image = sharp(file, { failOn: 'none' });
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  let nonBackground = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 4 || Math.max(r, g, b) < 248) nonBackground += 1;
  }
  return { width: info.width, height: info.height, channels: info.channels, nonBackgroundRatio: nonBackground / (info.width * info.height), data };
};

const deltaRatio = (left, right) => {
  if (left.width !== right.width || left.height !== right.height) return 1;
  const channels = Math.min(left.channels, right.channels);
  let changed = 0;
  const pixelsCount = left.width * left.height;
  for (let pixel = 0; pixel < pixelsCount; pixel += 1) {
    const offset = pixel * channels;
    let delta = 0;
    for (let channel = 0; channel < Math.min(3, channels); channel += 1) delta += Math.abs(left.data[offset + channel] - right.data[offset + channel]);
    if (delta > 12) changed += 1;
  }
  return changed / pixelsCount;
};

for (const dir of targets) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    for (const [width, height] of viewports) {
      const name = `${width}x${height}`;
      const observation = manifest.observations?.find(item => item.viewport?.width === width && item.viewport?.height === height);
      assert.ok(observation, `missing observation ${name}`);
      const images = {};
      for (const suffix of suffixes) {
        const fixture = fixtureBySuffix.get(suffix);
        assert.ok(fixture, `fixture matrix has no screenshot fixture for ${suffix}`);
        const file = path.join(dir, `${name}-${suffix}.png`);
        images[suffix] = await pixels(file);
        const expectedWidth = suffix === 'narrow' ? Math.max(320, width - 240) : width;
        assert.equal(images[suffix].width, expectedWidth, `${name}-${suffix}: rendered width mismatch`);
        assert.ok(images[suffix].height >= height, `${name}-${suffix}: rendered height is below viewport`);
        assert.ok(images[suffix].nonBackgroundRatio >= baseline.minNonBackgroundRatio, `${name}-${suffix}: blank/near-blank capture`);
      }
      for (const suffix of ['hover', 'focus']) {
        assert.ok(deltaRatio(images.initial, images[suffix]) >= baseline.minInteractionDeltaRatio, `${name}-${suffix}: no measurable pixel delta from initial`);
      }
      assert.ok(deltaRatio(images.initial, images.states) >= baseline.minStateDeltaRatio, `${name}-states: no measurable pixel delta from initial`);
      const finiteRect = rect => rect && [rect.x, rect.y, rect.width, rect.height].every(value => Number.isFinite(value)) && rect.width > 0 && rect.height > 0;
      assert.ok(observation.initial?.controls?.some(control => finiteRect(control.rect)), `${name}: no finite initial control geometry`);
      assert.ok(observation.settingsViewport?.visible?.some(control => finiteRect(control.rect)), `${name}: no finite settings geometry`);
      assert.equal(observation.settingsViewport?.sections?.length, 8, `${name}: incomplete settings section geometry`);
      assert.ok(observation.settingsViewport.sections.every(section => finiteRect(section.rect) && section.visibleControls > 0), `${name}: invalid settings section geometry`);
      assert.ok(finiteRect(manifest.settingsContext?.contextSample?.showcase?.rect), `${name}: missing showcase context geometry`);
      assert.ok(finiteRect(manifest.settingsContext?.contextSample?.settings?.rect), `${name}: missing Settings context geometry`);
      assert.ok(finiteRect(observation.settingsViewport?.contextSample?.showcase?.rect), `${name}: missing viewport showcase context geometry`);
      assert.ok(finiteRect(observation.settingsViewport?.contextSample?.settings?.rect), `${name}: missing viewport Settings context geometry`);
      assert.ok(finiteRect(observation.restored && { x: 0, y: 0, width: observation.restored.width, height: observation.restored.height }), `${name}: invalid restored geometry`);
      console.log(`Visual forensics pixel/geometry baseline passed: ${dir} ${name}`);
    }
  } catch (error) {
    failures.push(`${dir}: ${error.message}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 2;
}
