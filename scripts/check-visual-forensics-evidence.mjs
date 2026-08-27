import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dirs = process.argv.slice(2).filter(Boolean);
const targets = dirs.length ? dirs : [path.join(root, 'reports/visual-forensics-qa/light'), path.join(root, 'reports/visual-forensics-qa/dark')];
const requiredViewports = [[800, 600], [1280, 800], [1680, 1000]];
const failures = [];
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
    assert.deepEqual(manifest.viewports, requiredViewports);
    assert.equal(manifest.gate?.pass, true);
    assert.equal(manifest.lifecycle?.removedOnClose, true);
    assert.equal(manifest.lifecycle?.reopened, true);
    assert.ok(manifest.settingsContext?.controls?.length > 0);
    assert.ok(manifest.settingsContext?.contextSample?.showcase?.ancestry?.length > 0);
    assert.ok(manifest.settingsContext?.contextSample?.settings?.ancestry?.length > 0);
    assert.ok(manifest.settingsCascade?.length > 0);
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
      for (const suffix of ['initial', 'reopen', 'menu', 'modal', 'tooltip', 'settings', 'states', 'scrolled', 'narrow', 'restored', 'hover', 'focus']) {
        await fs.access(path.join(dir, `${name}-${suffix}.png`));
      }
      const observation = manifest.observations.find(item => item.viewport?.width === width && item.viewport?.height === height);
      assert.equal(observation?.reopen?.removedOnClose, true);
      assert.equal(observation?.reopen?.reopened, true);
      assert.equal(observation?.reopen?.newRootIdentity, true);
      assert.equal(observation?.reopen?.bodyAfterClose?.bodyInlineStyle, '');
      assert.equal(observation?.overlayViewport?.menu?.open, true);
      assert.ok(observation?.overlayViewport?.menu?.rect);
      assert.equal(observation?.overlayViewport?.modal?.open, true);
      assert.ok(observation?.overlayViewport?.modal?.rect);
      assert.equal(observation?.overlayViewport?.modal?.mask, true);
      assert.ok(observation?.overlayViewport?.modal?.parent);
      assert.equal(observation?.overlayViewport?.tooltip?.open, true);
      assert.ok(observation?.overlayViewport?.tooltip?.rect);
      assert.ok(observation?.overlayViewport?.tooltip?.parent);
      assert.ok(observation?.scrolled?.ownerY > 0 || observation?.scrolled?.ownerScrollHeight <= observation?.scrolled?.ownerViewport, `scroll owner did not move for ${name}`);
      assert.ok(observation?.initial?.cdpCascade?.length > 0);
      assert.ok(observation?.initial?.interactionStates?.hover);
      assert.ok(observation?.initial?.interactionStates?.focus);
      assert.ok(observation?.initial?.stateCounts && Object.values(observation.initial.stateCounts).every(value => Number.isInteger(value)));
      assert.ok(observation?.initial?.stateTargets?.disabled?.rect);
      assert.ok(observation?.initial?.stateTargets?.selected?.rect);
      assert.ok(observation?.initial?.themeTokens && Object.values(observation.initial.themeTokens).some(value => typeof value === 'string' && value.trim()));
      assert.ok(['div', 'section'].includes(observation?.initial?.dom?.rootTree?.tag));
      assert.equal(observation?.settingsViewport?.active, true);
      assert.ok(observation?.settingsViewport?.visible?.length > 0);
      assert.equal(observation?.settingsViewport?.sections?.length, 8);
      assert.ok(observation.settingsViewport.sections.every(section => section.activeId && section.visibleControls > 0));
      assert.ok(observation.settingsViewport?.cascade?.length > 0);
      assert.ok(observation.settingsViewport?.contextSample?.showcase?.ancestry?.length > 0);
      assert.ok(observation.settingsViewport?.contextSample?.settings?.ancestry?.length > 0);
      assert.equal(observation?.stateTransitions?.loading?.visible, true);
      assert.equal(observation?.stateTransitions?.loading?.cleared, true);
      assert.ok(observation?.stateTransitions?.loading?.position);
      assert.equal(observation?.stateTransitions?.errorState?.status, 'error');
      assert.ok(observation?.stateTransitions?.errorState?.className);
      assert.equal(observation?.stateTransitions?.asyncLoading?.status, 'loading');
      assert.ok(observation?.stateTransitions?.asyncLoading?.animationName !== undefined);
      assert.equal(observation?.stateTransitions?.reset, 'idle');
      assert.equal(observation?.restored?.width, width);
      assert.equal(observation?.restored?.height, height);
      assert.equal(observation?.restored?.overflowX, false);
    }
    console.log(`Visual forensics evidence passed: ${dir}`);
  } catch (error) {
    failures.push(`${dir}: ${error.message}`);
  }
}
if (!dirs.length) {
  try {
    const light = JSON.parse(await fs.readFile(path.join(root, 'reports/visual-forensics-qa/light/manifest.json'), 'utf8'));
    const dark = JSON.parse(await fs.readFile(path.join(root, 'reports/visual-forensics-qa/dark/manifest.json'), 'utf8'));
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
