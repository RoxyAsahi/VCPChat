import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const dirs = process.argv.slice(2);
assert.equal(dirs.length, 2, 'usage: node check-visual-qa-next-sidebar-account-tray.mjs <light> <dark>');
const expected = [[800, 600], [1280, 800], [1680, 1000]];
const manifests = await Promise.all(dirs.map(dir => fs.readFile(path.join(dir, 'manifest.json'), 'utf8').then(JSON.parse)));
assert.deepEqual(manifests.map(m => m.theme), ['light', 'dark']);
for (const m of manifests) {
  assert.equal(m.gate?.pass, true, `${m.theme}: fixture gate failed`);
  assert.deepEqual(m.viewports, expected);
  assert.equal(m.captures?.length, 3);
  assert.equal(m.gate?.failures?.length, 0, `${m.theme}: teardown failures ${JSON.stringify(m.gate?.failures)}`);
  for (const c of m.captures) {
    const n = `${c.viewport.width}x${c.viewport.height}`;
    assert.equal(c.account.open.triggerExpanded, 'true', `${m.theme}/${n}: account not open`);
    assert.equal(c.account.open.items.length, 3, `${m.theme}/${n}: account item count`);
    assert.ok(c.account.open.menu.inViewport && c.account.open.topmostFirstItem, `${m.theme}/${n}: account menu placement`);
    assert.ok(c.account.open.items.every(i => i.harnessButton && Number.parseFloat(i.minHeight) >= 36), `${m.theme}/${n}: account control geometry`);
    assert.equal(c.account.hover.hovered, true); assert.equal(c.account.focus.focused, true);
    assert.equal(c.account.closed.hidden, true); assert.equal(c.account.closed.focus, 'nextUiAccountMenuTrigger');
    assert.equal(c.account.reopen.hidden, false);
    assert.equal(c.tray.open.triggerExpanded, 'true');
    assert.ok(c.tray.open.drawer.inViewport && c.tray.open.topmostItem && c.tray.open.candidate, `${m.theme}/${n}: tray placement`);
    assert.ok(Number.parseFloat(c.tray.open.item.height) >= 35.5, `${m.theme}/${n}: tray geometry`);
    assert.ok(c.tray.tooltip.portal && c.tray.tooltip.inViewport, `${m.theme}/${n}: tooltip portal`);
    assert.equal(c.tray.closed.active, false); assert.equal(c.tray.closed.focus, 'appTrayMoreBtn');
    assert.equal(c.tray.closed.tooltip, false, `${m.theme}/${n}: tooltip leaked after dispose`);
    assert.equal(c.tray.reopen.active, true);
  }
}
console.log(JSON.stringify({ pass: true, themes: manifests.map(m => m.theme), viewports: expected }, null, 2));
