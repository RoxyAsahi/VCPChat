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
