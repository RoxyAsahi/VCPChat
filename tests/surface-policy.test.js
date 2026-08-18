const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync('modules/ui-system/surface-policy.js', 'utf8');

test('Surface policy accepts only the canonical main-chat marker', () => {
    const canonical = new JSDOM('<!doctype html><html data-vcp-ui-surface="main-chat"></html>', { runScripts: 'outside-only' });
    canonical.window.eval(source);
    assert.equal(canonical.window.VCPSurfacePolicy.isMainChat(), true);
    canonical.window.close();

    const legacy = new JSDOM('<!doctype html><html data-ui-mode="next"></html>', { runScripts: 'outside-only' });
    legacy.window.eval(source);
    assert.equal(legacy.window.VCPSurfacePolicy.isMainChat(), false);
    legacy.window.close();
});

test('Surface policy does not classify unrelated child pages as main chat', () => {
    const child = new JSDOM('<!doctype html><html></html>', { runScripts: 'outside-only' });
    child.window.eval(source);
    assert.equal(child.window.VCPSurfacePolicy.isMainChat(), false);
    child.window.close();
});
