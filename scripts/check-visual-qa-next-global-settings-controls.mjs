import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv.slice(2);
const targets = requested.length ? requested : ['light', 'dark'].map(theme =>
  path.join(root, 'reports/visual-forensics-qa/global-settings-controls', theme));
const viewports = [[800, 600], [1280, 800], [1680, 1000]];
const failures = [];

for (const dir of targets) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const theme = manifest.theme;
    const generatedAtMs = Date.parse(manifest.generatedAt);
    assert.ok(Number.isFinite(generatedAtMs), 'manifest generatedAt is invalid');
    assert.equal(manifest.source, 'VCP production Global Settings controls');
    assert.ok(['light', 'dark'].includes(theme), 'manifest theme is invalid');
    assert.equal(manifest.gate?.pass, true);
    assert.deepEqual(manifest.viewports, viewports);
    assert.equal(manifest.captures?.length, viewports.length);
    for (const [width, height] of viewports) {
      const name = `${width}x${height}`;
      const capture = manifest.captures.find(item => item.viewport?.width === width && item.viewport?.height === height);
      assert.ok(capture, `${name}: capture missing`);
      const screenshot = path.join(dir, `${name}-${theme}.png`);
      const stat = await fs.stat(screenshot);
      assert.ok(stat.size > 1_000, `${name}: screenshot is unexpectedly small`);
      assert.ok(stat.mtimeMs >= generatedAtMs - 120_000, `${name}: screenshot is stale relative to manifest`);
      const image = await sharp(screenshot).metadata();
      assert.equal(image.width, width, `${name}: screenshot width mismatch`);
      assert.equal(image.height, height, `${name}: screenshot height mismatch`);
      for (const type of ['input', 'select', 'range', 'toggle', 'choice']) {
        assert.ok(capture.state?.primitiveCounts?.[type] > 0, `${name}: no visible ${type} primitive`);
      }
      assert.equal(capture.state?.overflow?.modal, false, `${name}: modal has horizontal overflow`);
      assert.equal(capture.state?.overflow?.content, false, `${name}: content has horizontal overflow`);
      assert.equal(capture.menu?.inViewport, true, `${name}: Select menu is outside viewport`);
      assert.equal(capture.menu?.topmost, true, `${name}: Select menu is occluded`);
      assert.ok(capture.menu?.itemCount >= 3, `${name}: Select option count drifted`);
      assert.equal(capture.interaction?.input?.focusWithin, true, `${name}: Input focus cascade missing`);
      assert.equal(capture.interaction?.select?.hovered, true, `${name}: Select hover missing`);
      assert.equal(capture.interaction?.select?.focused, true, `${name}: Select keyboard focus missing`);
      assert.equal(capture.interaction?.range?.geometryStable, true, `${name}: Range value changes layout`);
      assert.notEqual(capture.interaction?.range?.before?.output, capture.interaction?.range?.after?.output, `${name}: Range output did not project`);
      assert.notEqual(capture.interaction?.toggle?.before, capture.interaction?.toggle?.after, `${name}: Toggle did not transition`);
      assert.equal(capture.interaction?.choice?.after, true, `${name}: Choice did not select`);
      assert.equal(capture.scroll?.overflowX, false, `${name}: scroll owner has horizontal overflow`);
      assert.ok(capture.scroll?.scrollTop >= 0, `${name}: scroll evidence missing`);
      assert.equal(capture.reopen?.active, true, `${name}: modal did not reopen`);
      assert.equal(capture.reopen?.bodyStyle, '', `${name}: body inline style leaked after reopen`);
      assert.equal(capture.rootIdentityChanged, true, `${name}: modal root identity was reused after reopen`);
    }
    console.log(`Global Settings controls visual evidence passed: ${dir}`);
  } catch (error) {
    failures.push(`${dir}: ${error.message}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 2;
}
