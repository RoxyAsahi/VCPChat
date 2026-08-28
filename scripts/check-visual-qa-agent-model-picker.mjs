import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv.slice(2);
const targets = requested.length ? requested : ['light', 'dark'].map(theme => path.join(root, 'reports/visual-forensics-qa/agent-model-picker', theme));
const viewports = [[800, 600], [1280, 800], [1680, 1000]];
const failures = [];
const finite = value => Number.isFinite(value);

for (const dir of targets) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.source, 'VCP production Agent Settings Electron Surface');
    assert.equal(manifest.gate?.pass, true);
    assert.deepEqual(manifest.viewports, viewports);
    assert.equal(manifest.captures?.length, viewports.length);
    for (const [width, height] of viewports) {
      const name = `${width}x${height}`;
      const capture = manifest.captures.find(item => item.viewport?.width === width && item.viewport?.height === height);
      assert.ok(capture, `${name}: capture missing`);
      for (const suffix of ['open', 'model-directory', 'model-directory-busy', 'model-directory-favorite', 'model-hover', 'narrow-open', 'restored-open']) {
        const screenshot = path.join(dir, `${name}-${suffix}.png`);
        const stat = await fs.stat(screenshot);
        assert.ok(stat.size > 1_000, `${name}-${suffix}: screenshot is unexpectedly small`);
        const info = await sharp(screenshot).metadata();
        const expectedWidth = suffix === 'narrow-open' ? Math.max(320, width - 240) : width;
        assert.equal(info.width, expectedWidth, `${name}-${suffix}: width mismatch`);
        assert.equal(info.height, height, `${name}-${suffix}: height mismatch`);
      }
      const hover = capture.modelPaneHover;
      const icon = capture.open?.semanticIcon;
      assert.ok(icon?.slotClass?.includes('vcp-harness-agent-model-picker-trigger-icon'), `${name}: production ModelPicker semantic icon slot is missing`);
      assert.equal(icon?.tag, 'svg', `${name}: production ModelPicker semantic icon did not render as SVG`);
      assert.equal(icon?.ariaHidden, 'true', `${name}: production ModelPicker semantic icon is exposed to accessibility tree`);
      assert.equal(icon?.viewBox, '0 0 24 24', `${name}: production ModelPicker semantic icon viewBox drifted`);
      assert.ok(icon?.pathCount > 0 && icon.rect.width === 14 && icon.rect.height === 14, `${name}: production ModelPicker semantic icon has no 14px glyph geometry`);
      assert.equal(hover?.role, 'option', `${name}: production model-row role is not option`);
      assert.equal(hover?.hovered, true, `${name}: production model-row hover state was not captured`);
      assert.equal(hover?.topmostInsideCard, true, `${name}: production model-row hover is occluded outside the card`);
      const hoverRect = hover?.rect;
      assert.ok(
        [hoverRect?.x, hoverRect?.y, hoverRect?.width, hoverRect?.height].every(finite)
          && hoverRect.width > 0 && hoverRect.height > 0
          && hoverRect.x >= -2 && hoverRect.y >= -2
          && hoverRect.x + hoverRect.width <= width + 2
          && hoverRect.y + hoverRect.height <= height + 2,
        `${name}: production model-row hover geometry exceeds viewport`,
      );
      for (const action of ['refresh', 'favorite']) {
        const directory = capture.modelDirectory?.[action];
        assert.ok(directory, `${name}: production model-directory ${action} evidence is missing`);
        assert.equal(directory.inViewport, true, `${name}: production model-directory ${action} is outside viewport`);
        assert.equal(directory.topmostInsideCard, true, `${name}: production model-directory ${action} is occluded outside card`);
        assert.ok(
          [directory.rect?.x, directory.rect?.y, directory.rect?.width, directory.rect?.height].every(finite)
            && directory.rect.width > 0 && directory.rect.height > 0,
          `${name}: production model-directory ${action} has invalid geometry`,
        );
      }
      assert.equal(capture.directoryTransient?.refreshBusy?.busy, 'true', `${name}: refresh busy state was not rendered`);
      assert.equal(capture.directoryTransient?.refreshBusy?.refresh?.disabled, true, `${name}: refresh button was not disabled while busy`);
      assert.equal(capture.directoryTransient?.refreshBusy?.refresh?.text, 'Refreshing…', `${name}: refresh busy label was not rendered`);
      assert.ok(capture.favoriteTransient?.before, `${name}: favorite action transition was not captured`);
      for (const [phase, expectedWidth] of [['narrow', Math.max(320, width - 240)], ['restored', width]]) {
        const snapshot = capture[phase];
        const card = snapshot?.card;
        assert.equal(snapshot?.open, true, `${name}: ${phase} card is not open`);
        assert.equal(snapshot?.inViewport, true, `${name}: ${phase} card is outside viewport`);
        assert.equal(snapshot?.topmostInsideCard, true, `${name}: ${phase} card center is occluded`);
        assert.equal(card?.position, 'fixed', `${name}: ${phase} card is not fixed`);
        assert.equal(card?.parent, 'body', `${name}: ${phase} card is not a body portal`);
        assert.ok(card?.rect?.x >= -2 && card.rect.y >= -2 && card.rect.x + card.rect.width <= expectedWidth + 2 && card.rect.y + card.rect.height <= height + 2, `${name}: ${phase} card geometry exceeds viewport`);
      }
      assert.equal(capture.closed?.cardCount, 0, `${name}: card survives Escape`);
      assert.equal(capture.closed?.expanded, 'false', `${name}: trigger aria-expanded is not reset`);
      assert.equal(capture.closed?.active, 'openModelSelectBtn', `${name}: focus does not return to trigger`);
      assert.equal(capture.closed?.bodyStyle, '', `${name}: body inline style survives close`);
    }
    console.log(`Production Agent ModelPicker visual evidence passed: ${dir}`);
  } catch (error) {
    failures.push(`${dir}: ${error.message}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 2;
}
