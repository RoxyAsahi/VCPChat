import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const source = name => fs.readFileSync(new URL(`../modules/ui-system/${name}`, import.meta.url), 'utf8');

test('ThemeRuntime separates preference from effective and publishes immutable snapshots', () => {
    const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
    dom.window.eval(source('theme-runtime.js'));
    const runtime = new dom.window.VCPThemeRuntime({ matchMedia: () => ({ matches: true }) });
    assert.equal(runtime.snapshot().value.ready, true);
    assert.equal(runtime.snapshot().value.preference, 'system');
    assert.equal(runtime.snapshot().value.effective, 'dark');
    const seen = [];
    runtime.subscribe((_value, snapshot) => seen.push(snapshot));
    const next = runtime.setPreference('light', 'test');
    assert.equal(next.value.preference, 'light');
    assert.equal(next.value.effective, 'light');
    assert.equal(Object.isFrozen(next), true);
    assert.equal(seen.length, 1);
    dom.window.close();
});

test('Appearance and material runtimes expose independent ownership seams', () => {
    const dom = new JSDOM('<!doctype html><head></head>', { runScripts: 'outside-only' });
    dom.window.eval(source('appearance-profile-runtime.js'));
    dom.window.eval(source('material-runtime.js'));
    const profile = new dom.window.VCPAppearanceProfileRuntime({ normalize: value => ({ ...value, density: 'compact' }) });
    assert.equal(profile.resolve({ radius: 'small' }, 'next').density, 'compact');
    const material = new dom.window.VCPMaterialRuntime();
    material.apply({ surfaceOpacity: 68, surfaceBlur: 24, surfaceSaturation: 145, surfaceBrightness: 103, surfaceBorder: 32, surfaceShadow: 18, surfaceSheen: 18 }, dom.window.document);
    assert.match(dom.window.document.getElementById('vcpAppearanceMaterialVariables').textContent, /--vcp-material-blur:24px/);
    dom.window.close();
});
