import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body><div class="vcp-ui-scope"></div></body></html>', {
    url: 'https://vcpchat.local/',
    runScripts: 'outside-only'
});
Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    CustomEvent: dom.window.CustomEvent,
    localStorage: dom.window.localStorage
});

dom.window.eval(fs.readFileSync('modules/ui-system/appearance-engine.js', 'utf8'));
const appearance = dom.window.VCPAppearance;
assert.ok(appearance);
assert.equal(appearance.normalize({ radius: 'round' }, 'next').radius, 'round');
assert.equal(appearance.normalize({ radius: 'invalid' }, 'next').radius, 'medium');

const resolved = appearance.apply({
    density: 'compact', radius: 'square', typography: 'serif',
    fontScale: 'large', contentWidth: 'centered', surface: 'solid'
}, { uiMode: 'next', cache: true, source: 'test' });
assert.equal(JSON.stringify(resolved), JSON.stringify({
    density: 'compact', radius: 'square', typography: 'serif',
    fontScale: 'large', contentWidth: 'centered', surface: 'solid'
}));
assert.equal(document.documentElement.dataset.vcpRadius, 'square');
assert.equal(document.querySelector('.vcp-ui-scope').dataset.density, 'compact');
assert.equal(appearance.readCache('next').contentWidth, 'centered');
console.log('appearance engine checks passed.');
