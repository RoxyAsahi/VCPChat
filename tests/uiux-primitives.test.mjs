import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');
const { createUiScope } = await import('../modules/uiux/runtime/scope.ts');
const { mountField } = await import('../modules/uiux/primitives/field.ts');
const { mountSelect } = await import('../modules/uiux/primitives/select.ts');
const { mountInput } = await import('../modules/uiux/primitives/input.ts');
const { mountChoice } = await import('../modules/uiux/primitives/choice.ts');
const { mountRange } = await import('../modules/uiux/primitives/range.ts');
const { mountToggle } = await import('../modules/uiux/primitives/toggle.ts');
const { mountColorPair } = await import('../modules/uiux/primitives/color-pair.ts');

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
        assert.equal(select.getAttribute('aria-describedby'), 'density-description');
        assert.equal(fieldRoot.querySelector('#density-description')?.textContent, 'Controls UI density.');
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
        assert.equal(select.getAttribute('aria-describedby'), null);
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('Harness Input keeps native control and restores DOM on dispose', async () => {
    const dom = new JSDOM('<!doctype html><label id="field"><span>Tagline</span><input id="tagline" value="Hello"></label>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('input-test'));
        const input = document.getElementById('tagline');
        const release = mountInput(input, {}, scope);
        assert.equal(input.parentElement.classList.contains('vcp-uiux-input-wrap'), true);
        assert.equal(input.parentElement.classList.contains('wrap'), true);
        assert.equal(input.classList.contains('input'), true);
        assert.equal(input.value, 'Hello');
        assert.equal(input.parentElement.getAttribute('role'), null);
        await release?.();
        assert.equal(input.parentElement.id, 'field');
        await scope.dispose('input-complete');
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('Harness Choice decorates native radios and retracts cleanly', async () => {
    const dom = new JSDOM('<!doctype html><div id="choices"><label><input type="radio" name="r" value="a">A</label><label><input type="radio" name="r" value="b">B</label></div>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('choice-test')); const root = document.getElementById('choices');
        const release = mountChoice(root, scope);
        assert.equal(root.classList.contains('vcp-uiux-choice'), true);
        root.querySelector('input[value="b"]').click();
        assert.equal(root.dataset.value, 'b');
        await release?.(); await scope.dispose('choice-complete');
        assert.equal(root.classList.contains('vcp-uiux-choice'), false);
        assert.equal(root.querySelector('label').classList.contains('vcp-uiux-choice-option'), false);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Range keeps native value, output sync, and teardown', async () => {
    const dom = new JSDOM('<!doctype html><label id="field"><output id="out"></output><input id="range" type="range" value="32"><span id="after"></span></label>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('range-test')); const input = document.getElementById('range'); const output = document.getElementById('out');
        const release = mountRange(input, { output }, scope);
        assert.equal(input.parentElement.className, 'vcp-uiux-range'); assert.equal(output.textContent, '32px');
        input.value = '40'; input.dispatchEvent(new dom.window.Event('input')); assert.equal(output.textContent, '40px');
        await release?.(); await scope.dispose('range-complete'); assert.equal(input.parentElement.id, 'field'); assert.equal(output.parentElement.id, 'field');
        assert.deepEqual([...document.getElementById('field').children].map(node => node.id), ['out', 'range', 'after']);
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness Toggle keeps native checkbox and retires legacy slider', async () => {
    const dom = new JSDOM('<!doctype html><label class="switch" id="toggle"><input type="checkbox"><span class="slider"></span></label>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window;
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('toggle-test')); const input = document.querySelector('input'); const slider = document.querySelector('.slider');
        const release = mountToggle(input, scope);
        assert.equal(input.parentElement.className, 'vcp-uiux-toggle'); assert.equal(slider.style.display, 'none');
        await release?.(); await scope.dispose('toggle-complete');
        assert.equal(input.parentElement.id, 'toggle'); assert.equal(slider.style.display, '');
    } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
});

test('Harness ColorPair synchronizes source and mirror with invalid rollback', async () => {
    const dom = new JSDOM('<!doctype html><div id="pair"><input id="color" type="color" value="#3d5a80"><input id="text" type="text" value="#3d5a80"></div>');
    const previousDocument = globalThis.document; const previousWindow = globalThis.window; globalThis.document = dom.window.document; globalThis.window = dom.window;
    try { const scope = createUiScope(new LifecycleScope('color-pair')); const color = document.getElementById('color'); const text = document.getElementById('text'); const release = mountColorPair(color, text, scope); assert.equal(text.value, '#3d5a80'); text.value = '#112233'; text.dispatchEvent(new dom.window.Event('change')); assert.equal(color.value, '#112233'); text.value = 'invalid'; text.dispatchEvent(new dom.window.Event('change')); assert.equal(text.value, '#112233'); await release?.(); await scope.dispose('color-pair-complete'); assert.equal(color.parentElement.id, 'pair'); } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; dom.window.close(); }
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

test('Harness Select external snapshot sync is presentation-only and owner-bound', async () => {
    const dom = new JSDOM('<!doctype html><select id="density"><option>Comfortable</option><option>Compact</option></select>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('select-sync'));
        const select = document.getElementById('density');
        let changes = 0;
        select.addEventListener('change', () => { changes += 1; });
        const release = mountSelect(select, { label: 'Density' }, scope);
        select.value = 'Compact';
        select.dispatchEvent(new dom.window.Event('vcp-uiux-sync'));
        const trigger = document.querySelector('.vcp-harness-select-trigger');
        assert.equal(trigger.textContent, 'Compact');
        assert.equal(changes, 0);
        await release?.();
        select.value = 'Comfortable';
        select.dispatchEvent(new dom.window.Event('vcp-uiux-sync'));
        assert.equal(document.querySelector('.vcp-harness-select-trigger'), null);
        assert.equal(changes, 0);
        await scope.dispose('sync-complete');
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});

test('Harness Input/Field/Select expose stable error, disabled and selected state contracts', async () => {
    const dom = new JSDOM('<!doctype html><main><div id="field"><select id="mode" disabled><option value="a">Alpha</option><option value="b" selected>Beta</option></select></div><input id="name" disabled></main>');
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    try {
        const scope = createUiScope(new LifecycleScope('primitive-state-contract'));
        const fieldRoot = document.getElementById('field');
        const select = document.getElementById('mode');
        const input = document.getElementById('name');
        const fieldRelease = mountField(fieldRoot, { label: 'Mode', description: 'Choose a mode.', error: 'Mode is unavailable.', control: select }, scope);
        const selectRelease = mountSelect(select, { label: 'Mode' }, scope);
        const inputRelease = mountInput(input, {}, scope);
        const trigger = fieldRoot.querySelector('.vcp-harness-select-trigger');
        assert.equal(select.getAttribute('aria-invalid'), 'true');
        assert.equal(select.getAttribute('aria-describedby'), 'mode-description mode-error');
        assert.equal(trigger.textContent, 'Beta');
        assert.equal(fieldRoot.querySelector('[role="menuitem"][data-selected="true"]')?.textContent, 'Beta');
        trigger.click();
        assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'disabled select must not open');
        assert.equal(input.disabled, true);
        await inputRelease?.();
        await selectRelease?.();
        await fieldRelease?.();
        await scope.dispose('state-contract-complete');
        assert.equal(select.getAttribute('aria-invalid'), null);
        assert.equal(select.getAttribute('aria-describedby'), null);
    } finally {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
        dom.window.close();
    }
});
