import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const inputs = process.argv.slice(2);
assert.equal(inputs.length, 2, 'usage: node check-visual-qa-next-notification-menu.mjs <light> <dark>');
const expectedViewports = [[800, 600], [1280, 800], [1680, 1000]];
const read = async dir => JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
const manifests = await Promise.all(inputs.map(read));
assert.deepEqual(manifests.map(m => m.theme), ['light', 'dark'], 'themes must be light then dark');
for (const manifest of manifests) {
  assert.equal(manifest.gate?.pass, true, `${manifest.theme}: fixture gate failed: ${JSON.stringify(manifest.gate?.failures || [])}`);
  assert.deepEqual(manifest.viewports, expectedViewports, `${manifest.theme}: viewport matrix drifted`);
  assert.equal(manifest.captures?.length, 3, `${manifest.theme}: expected three viewport captures`);
  for (const capture of manifest.captures) {
    const name = `${capture.viewport.width}x${capture.viewport.height}`;
    const { open, hover, focus, selected, closed, reopen } = capture;
    assert.equal(open.trigger.expanded, 'true', `${manifest.theme}/${name}: trigger not expanded`);
    assert.equal(open.items.length, 7, `${manifest.theme}/${name}: action count drifted`);
    assert.ok(open.menu.inViewport && open.menu.topmost, `${manifest.theme}/${name}: menu clipped or occluded`);
    assert.ok(open.items.filter(i => !['nextUiNotificationFilterToggle', 'nextUiNotificationClear'].includes(i.id)).every(i => i.harnessButton), `${manifest.theme}/${name}: generated action presentation missing`);
    assert.ok(open.items.filter(i => i.harnessButton).every(i => Number.parseFloat(i.height) >= 35.5), `${manifest.theme}/${name}: action below 36px`);
    assert.equal(hover.hovered, true, `${manifest.theme}/${name}: hover evidence missing`);
    assert.equal(focus.focused, true, `${manifest.theme}/${name}: focus evidence missing`);
    assert.ok(['true', 'false'].includes(selected.checked), `${manifest.theme}/${name}: selected state missing`);
    assert.equal(closed.hidden, true, `${manifest.theme}/${name}: Escape did not close`);
    assert.equal(closed.focus, 'nextUiNotificationMenuBtn', `${manifest.theme}/${name}: focus not restored`);
    assert.equal(reopen.hidden, false, `${manifest.theme}/${name}: reopen failed`);
  }
}
console.log(JSON.stringify({ pass: true, themes: manifests.map(m => m.theme), viewports: expectedViewports }, null, 2));
