import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');
const { createUiScope } = await import('../modules/uiux/runtime/scope.ts');
const { mountField } = await import('../modules/uiux/primitives/field.ts');
const { mountSelect } = await import('../modules/uiux/primitives/select.ts');

test('Harness-compatible Field and Select keep Light DOM contract and dispose cleanly', async () => {
    const dom = new JSDOM('<!doctype html><form><div id="field"><select id="density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></div></form>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('primitive-test'));
        const fieldRoot = document.getElementById('field');
        const select = document.getElementById('density');
        const fieldRelease = mountField(fieldRoot, { label: 'Density', description: 'Controls UI density.', control: select }, scope);
        const selectRelease = mountSelect(select, { label: 'Density' }, scope);
        assert.equal(fieldRoot.querySelector('.vcp-harness-field-label')?.htmlFor, 'density');
        assert.equal(fieldRoot.querySelector('.vcp-harness-select-trigger')?.textContent, 'Comfortable');
        assert.equal(fieldRoot.querySelector('[role="menu"]')?.children.length, 2);
        const trigger = fieldRoot.querySelector('.vcp-harness-select-trigger');
        trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        await selectRelease?.();
        await fieldRelease?.();
        await scope.dispose('test-complete');
        assert.equal(fieldRoot.querySelector('.vcp-harness-field'), null);
        assert.equal(document.querySelector('.vcp-harness-select-trigger'), null);
        assert.equal(document.getElementById('density')?.tabIndex, 0);
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('Harness Select interaction sequence matches keyboard and ownership contract', async () => {
    const dom = new JSDOM('<!doctype html><main><select id="mode" tabindex="3" aria-hidden="false"><option>One</option><option>Two</option><option>Three</option></select><button id="outside">Outside</button></main>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('select-sequence'));
        const select = document.getElementById('mode');
        const outside = document.getElementById('outside');
        const release = mountSelect(select, { label: 'Mode', portal: true }, scope);
        const trigger = document.querySelector('.vcp-harness-select-trigger');
        trigger.focus();
        trigger.click();
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(document.activeElement, items[0]);
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        assert.equal(document.activeElement, items[1]);
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        assert.equal(document.activeElement, items[2]);
        items[2].click();
        assert.equal(select.value, 'Three');
        assert.equal(trigger.textContent, 'Three');
        assert.equal(document.activeElement, trigger);
        trigger.click();
        outside.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        trigger.click();
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(document.activeElement, trigger);
        await release?.();
        await scope.dispose('sequence-complete');
        assert.equal(select.getAttribute('tabindex'), '3');
        assert.equal(select.getAttribute('aria-hidden'), 'false');
        assert.equal(document.querySelector('.vcp-harness-select'), null);
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});
