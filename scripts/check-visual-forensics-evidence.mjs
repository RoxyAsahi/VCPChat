import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dirs = process.argv.slice(2).filter(Boolean);
const targets = dirs.length ? dirs : [path.join(root, 'reports/visual-forensics-qa/light'), path.join(root, 'reports/visual-forensics-qa/dark')];
const requiredViewports = [[800, 600], [1280, 800], [1680, 1000]];
const failures = [];
const manifests = [];
try {
  const fixturePath = path.join(root, 'docs/visual-qa/fixtures/visual-forensics-fixture-matrix.json');
  const fixtureMatrix = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  assert.equal(fixtureMatrix.schemaVersion, 1);
  assert.deepEqual(fixtureMatrix.viewports, requiredViewports.map(([width, height]) => `${width}x${height}`));
  assert.deepEqual(fixtureMatrix.themes, ['light', 'dark']);
  assert.ok(Array.isArray(fixtureMatrix.fixtures) && fixtureMatrix.fixtures.length >= 4);
  fixtureMatrix.fixtures.forEach(fixture => {
    assert.ok(fixture.id && fixture.trigger && Array.isArray(fixture.selectors) && fixture.selectors.length > 0);
    assert.ok(fixture.screenshotSuffix === null || typeof fixture.screenshotSuffix === 'string');
  });
} catch (error) {
  failures.push(`fixture matrix: ${error.message}`);
}
for (const dir of targets) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    manifests.push({ dir, manifest });
    const generatedAtMs = Date.parse(manifest.generatedAt);
    assert.ok(Number.isFinite(generatedAtMs), 'manifest generatedAt is invalid');
    assert.deepEqual(manifest.viewports, requiredViewports);
    assert.equal(manifest.gate?.pass, true);
    assert.equal(manifest.lifecycle?.removedOnClose, true);
    assert.equal(manifest.lifecycle?.reopened, true);
    assert.ok(manifest.settingsContext?.controls?.length > 0);
    assert.ok(manifest.settingsContext?.contextSample?.showcase?.ancestry?.length > 0);
    assert.ok(manifest.settingsContext?.contextSample?.settings?.ancestry?.length > 0);
    assert.ok(manifest.settingsCascade?.length > 0);
    assert.ok(manifest.settingsCascade.every(rule => Array.isArray(rule.specificity) && rule.specificity.length === 3 && Number.isInteger(rule.cascadeOrder)));
    assert.equal(manifest.settingsContext?.sections?.length, 8);
    assert.ok(manifest.settingsContext.sections.every(section => section.activeId && section.visibleControls > 0));
    assert.equal(manifest.settingsContext?.settingsCleanup?.active, false);
    assert.equal(manifest.settingsContext?.settingsCleanup?.visible, false);
    assert.equal(manifest.settingsContext?.settingsCleanup?.visibleDialogCount, 0);
    assert.equal(manifest.settingsContext?.settingsCleanup?.bodyInlineStyle, '');
    assert.ok(manifest.overlays?.menu?.rect && manifest.overlays?.modal?.open && manifest.overlays?.tooltip?.open);
    assert.equal(manifest.observations?.length, requiredViewports.length);
    for (const [width, height] of requiredViewports) {
      const name = `${width}x${height}`;
      for (const suffix of ['initial', 'reopen', 'menu', 'modal', 'tooltip', 'settings', 'states', 'loading', 'error', 'async-loading', 'disabled', 'selected', 'scrolled', 'narrow', 'narrow-menu', 'narrow-modal', 'narrow-tooltip', 'restored', 'restored-tooltip', 'hover', 'focus']) {
        const screenshotPath = path.join(dir, `${name}-${suffix}.png`);
        await fs.access(screenshotPath);
        const stat = await fs.stat(screenshotPath);
        assert.ok(stat.mtimeMs >= generatedAtMs - 120_000, `${name}-${suffix}: screenshot is stale relative to manifest`);
      }
      const observation = manifest.observations.find(item => item.viewport?.width === width && item.viewport?.height === height);
      assert.equal(observation?.reopen?.removedOnClose, true);
      assert.equal(observation?.reopen?.reopened, true);
      assert.equal(observation?.reopen?.newRootIdentity, true);
      assert.equal(observation?.reopen?.bodyAfterClose?.bodyInlineStyle, '');
      const expectedThemeClass = `${path.basename(dir)}-theme`;
      assert.ok(observation?.reopen?.bodyAfterClose?.bodyClasses?.includes(expectedThemeClass));
      assert.ok(!observation?.reopen?.bodyAfterClose?.bodyClasses?.includes('next-ui-internal-app-open'));
      assert.equal(observation?.overlayViewport?.menu?.open, true);
      assert.ok(observation?.overlayViewport?.menu?.rect);
      assert.ok(observation.overlayViewport.menu.rect.x >= -2 && observation.overlayViewport.menu.rect.y >= -2 && observation.overlayViewport.menu.rect.x + observation.overlayViewport.menu.rect.width <= width + 2 && observation.overlayViewport.menu.rect.y + observation.overlayViewport.menu.rect.height <= height + 2, `${name}: menu is outside the viewport`);
      assert.equal(observation.overlayViewport.menu.topmostInside, true, `${name}: menu center is occluded`);
      assert.equal(observation?.overlayViewport?.modal?.open, true);
      assert.ok(observation?.overlayViewport?.modal?.rect);
      assert.ok(observation.overlayViewport.modal.rect.x >= -2 && observation.overlayViewport.modal.rect.y >= -2 && observation.overlayViewport.modal.rect.x + observation.overlayViewport.modal.rect.width <= width + 2 && observation.overlayViewport.modal.rect.y + observation.overlayViewport.modal.rect.height <= height + 2, `${name}: modal is outside the viewport`);
      assert.equal(observation.overlayViewport.modal.topmostInside, true, `${name}: modal center is occluded`);
      assert.equal(observation?.overlayViewport?.modal?.mask, true);
      assert.ok(observation?.overlayViewport?.modal?.parent);
      assert.equal(observation?.overlayViewport?.tooltip?.open, true);
      assert.ok(observation?.overlayViewport?.tooltip?.rect);
      assert.ok(observation?.overlayViewport?.tooltip?.parent);
      assert.ok(observation.overlayViewport.tooltip.rect.y >= -2 && observation.overlayViewport.tooltip.rect.y + observation.overlayViewport.tooltip.rect.height <= height + 2, `${name}: tooltip is outside the viewport`);
      if (observation.overlayViewport.tooltip.pointerEvents !== 'none') {
        assert.equal(observation.overlayViewport.tooltip.topmostInside, true, `${name}: tooltip center is occluded`);
      }
      assert.ok(observation?.scrolled?.ownerY > 0 || observation?.scrolled?.ownerScrollHeight <= observation?.scrolled?.ownerViewport, `scroll owner did not move for ${name}`);
      assert.ok(observation?.initial?.cdpCascade?.length > 0);
      assert.ok(observation.initial.cdpCascade.every(rule => Array.isArray(rule.specificity) && Number.isInteger(rule.cascadeOrder)));
      assert.ok(observation?.initial?.interactionStates?.hover);
      assert.ok(observation?.initial?.interactionStates?.focus);
      assert.equal(observation.initial.interactionStates.hover.active, true, `${name}: hover state was not active`);
      assert.equal(observation.initial.interactionStates.hover.inViewport, true, `${name}: hover target is outside the viewport`);
      assert.equal(observation.initial.interactionStates.focus.inViewport, true, `${name}: focus target is outside the viewport`);
      assert.equal(observation.initial.interactionStates.focus.focusVisible, true, `${name}: keyboard focus is not focus-visible`);
      assert.ok(observation?.initial?.stateCounts && Object.values(observation.initial.stateCounts).every(value => Number.isInteger(value)));
      assert.ok(observation?.initial?.stateTargets?.disabled?.rect);
      assert.ok(observation?.initial?.stateTargets?.selected?.rect);
      assert.equal(observation.initial.stateTargets.disabled.inViewport, true, `${name}: disabled-state visual target is outside the viewport`);
      assert.equal(observation.initial.stateTargets.selected.inViewport, true, `${name}: selected-state visual target is outside the viewport`);
      assert.ok(observation?.initial?.themeTokens && Object.values(observation.initial.themeTokens).some(value => typeof value === 'string' && value.trim()));
      assert.ok(['div', 'section'].includes(observation?.initial?.dom?.rootTree?.tag));
      assert.equal(observation?.settingsViewport?.active, true);
      assert.ok(observation?.settingsViewport?.visible?.length > 0);
      assert.equal(observation?.settingsViewport?.sections?.length, 8);
      assert.ok(observation.settingsViewport.sections.every(section => section.activeId && section.visibleControls > 0));
      assert.ok(observation.settingsViewport?.cascade?.length > 0);
      assert.ok(observation.settingsViewport?.contextSample?.showcase?.ancestry?.length > 0);
      assert.ok(observation.settingsViewport?.contextSample?.settings?.ancestry?.length > 0);
      assert.equal(observation?.settingsViewport?.settingsOverlay?.inViewport, true, `${name}: settings overlay is outside the viewport`);
      assert.equal(observation?.settingsViewport?.settingsOverlay?.topmostInside, true, `${name}: settings overlay center is occluded`);
      assert.equal(observation?.stateTransitions?.loading?.visible, true);
      assert.equal(observation?.stateTransitions?.loading?.cleared, true);
      assert.ok(observation?.stateTransitions?.loading?.position);
      assert.equal(observation?.stateTransitions?.visual?.loading?.visible, true);
      assert.ok(observation?.stateTransitions?.visual?.loading?.rect);
      assert.equal(observation?.stateTransitions?.visual?.loading?.inViewport, true);
      assert.equal(observation?.stateTransitions?.errorState?.status, 'error');
      assert.ok(observation?.stateTransitions?.errorState?.className);
      assert.equal(observation?.stateTransitions?.visual?.error?.status, 'error');
      assert.equal(observation?.stateTransitions?.visual?.error?.visible, true);
      assert.equal(observation?.stateTransitions?.visual?.error?.inViewport, true);
      assert.equal(observation?.stateTransitions?.asyncLoading?.status, 'loading');
      assert.ok(observation?.stateTransitions?.asyncLoading?.animationName !== undefined);
      assert.equal(observation?.stateTransitions?.visual?.asyncLoading?.status, 'loading');
      assert.equal(observation?.stateTransitions?.visual?.asyncLoading?.visible, true);
      assert.equal(observation?.stateTransitions?.visual?.asyncLoading?.inViewport, true);
      assert.equal(observation?.stateTransitions?.reset, 'idle');
      assert.equal(observation?.restored?.width, width);
      assert.equal(observation?.restored?.height, height);
      assert.equal(observation?.restored?.overflowX, false);
      assert.equal(observation?.restored?.tooltip?.open, true, `${name}: tooltip did not reopen after restore`);
      assert.equal(observation?.restored?.tooltip?.position, 'fixed', `${name}: restored tooltip is not fixed`);
      assert.equal(observation?.restored?.tooltip?.parent, 'body', `${name}: restored tooltip is not body-portalized`);
      assert.equal(observation?.restored?.tooltip?.inViewport, true, `${name}: restored tooltip is outside the viewport`);
      assert.notEqual(observation?.restored?.tooltip?.interaction?.method, 'synthetic-mouseenter', `${name}: restored Tooltip only opened via synthetic mouseenter`);
      assert.equal(observation?.resized?.tooltip?.open, true, `${name}: tooltip did not open after narrow resize`);
      assert.equal(observation?.resized?.tooltip?.position, 'fixed', `${name}: narrow tooltip is not fixed`);
      assert.equal(observation?.resized?.tooltip?.parent, 'body', `${name}: narrow tooltip is not body-portalized`);
      assert.equal(observation?.resized?.tooltip?.inViewport, true, `${name}: narrow tooltip is outside the viewport`);
      assert.notEqual(observation?.resized?.tooltip?.interaction?.method, 'synthetic-mouseenter', `${name}: narrow Tooltip only opened via synthetic mouseenter`);
      for (const type of ['menu', 'modal']) {
        assert.equal(observation?.resized?.[type]?.open, true, `${name}: ${type} did not open after narrow resize`);
        assert.equal(observation?.resized?.[type]?.inViewport, true, `${name}: narrow ${type} is outside the viewport`);
        assert.equal(observation?.resized?.[type]?.topmostInside, true, `${name}: narrow ${type} center is occluded`);
      }
    }
    console.log(`Visual forensics evidence passed: ${dir}`);
  } catch (error) {
    failures.push(`${dir}: ${error.message}`);
  }
}
if (!dirs.length || manifests.length === 2) {
  try {
    const selected = manifests.length === 2 ? manifests : [
      { dir: path.join(root, 'reports/visual-forensics-qa/light'), manifest: JSON.parse(await fs.readFile(path.join(root, 'reports/visual-forensics-qa/light/manifest.json'), 'utf8')) },
      { dir: path.join(root, 'reports/visual-forensics-qa/dark'), manifest: JSON.parse(await fs.readFile(path.join(root, 'reports/visual-forensics-qa/dark/manifest.json'), 'utf8')) },
    ];
    const light = selected.find(({ dir, manifest }) => manifest.theme === 'light' || path.basename(dir) === 'light')?.manifest;
    const dark = selected.find(({ dir, manifest }) => manifest.theme === 'dark' || path.basename(dir) === 'dark')?.manifest;
    assert.ok(light && dark, 'a paired run must include both light and dark manifests');
    const lightTokens = light.observations?.[0]?.initial?.themeTokens || {};
    const darkTokens = dark.observations?.[0]?.initial?.themeTokens || {};
    const comparable = ['accent', 'surface', 'inputBackground', 'textPrimary', 'bodyBackground', 'bodyColor'];
    assert.ok(comparable.some(key => lightTokens[key] && darkTokens[key] && lightTokens[key] !== darkTokens[key]), 'light/dark computed tokens are indistinguishable');
    console.log('Visual forensics light/dark token contrast passed');
  } catch (error) {
    failures.push(`theme token contrast: ${error.message}`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 2;
}
