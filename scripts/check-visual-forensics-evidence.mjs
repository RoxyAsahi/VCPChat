import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dirs = process.argv.slice(2).filter(Boolean);
const targets = dirs.length ? dirs : [path.join(root, 'reports/visual-forensics-qa/light'), path.join(root, 'reports/visual-forensics-qa/dark')];
const requiredViewports = [[800, 600], [1280, 800], [1680, 1000]];
const failures = [];
for (const dir of targets) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.viewports, requiredViewports);
    assert.equal(manifest.gate?.pass, true);
    assert.equal(manifest.lifecycle?.removedOnClose, true);
    assert.equal(manifest.lifecycle?.reopened, true);
    assert.ok(manifest.settingsContext?.controls?.length > 0);
    assert.ok(manifest.overlays?.menu?.rect && manifest.overlays?.modal?.open && manifest.overlays?.tooltip?.open);
    assert.equal(manifest.observations?.length, requiredViewports.length);
    for (const [width, height] of requiredViewports) {
      const name = `${width}x${height}`;
      for (const suffix of ['initial', 'settings', 'scrolled', 'narrow', 'hover', 'focus']) {
        await fs.access(path.join(dir, `${name}-${suffix}.png`));
      }
      const observation = manifest.observations.find(item => item.viewport?.width === width && item.viewport?.height === height);
      assert.ok(observation?.scrolled?.ownerY > 0 || observation?.scrolled?.ownerScrollHeight <= observation?.scrolled?.ownerViewport, `scroll owner did not move for ${name}`);
      assert.ok(observation?.initial?.cdpCascade?.length > 0);
      assert.ok(observation?.initial?.interactionStates?.hover);
      assert.ok(observation?.initial?.interactionStates?.focus);
      assert.ok(observation?.initial?.stateCounts && Object.values(observation.initial.stateCounts).every(value => Number.isInteger(value)));
      assert.equal(observation?.settingsViewport?.active, true);
      assert.ok(observation?.settingsViewport?.visible?.length > 0);
    }
    console.log(`Visual forensics evidence passed: ${dir}`);
  } catch (error) {
    failures.push(`${dir}: ${error.message}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 2;
}
