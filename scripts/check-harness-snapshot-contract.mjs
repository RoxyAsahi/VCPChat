import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const refDir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const require = createRequire(import.meta.url);
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');
const { createUiScope } = await import('../modules/uiux/generated/runtime/scope.js');
const { mountField } = await import('../modules/uiux/generated/primitives/field.js');
const { mountSelect } = await import('../modules/uiux/generated/primitives/select.js');
const { mountInput } = await import('../modules/uiux/generated/primitives/input.js');

const readJson = name => JSON.parse(fs.readFileSync(path.join(refDir, name), 'utf8'));
const dom = new JSDOM('<!doctype html><main><div id="field"><select id="mode"><option>Alpha</option><option selected>Beta</option></select></div><input id="name" value="hello"></main>');
const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
globalThis.document = dom.window.document;
globalThis.window = dom.window;

function shape(node) {
    return {
        tag: node.tagName.toLowerCase(),
        class: node.className || null,
        role: node.getAttribute('role'),
        children: [...node.children].map(shape),
    };
}

try {
    const scope = createUiScope(new LifecycleScope('harness-snapshot-contract'));
    const field = document.getElementById('field');
    const select = document.getElementById('mode');
    const input = document.getElementById('name');
    const fieldRelease = mountField(field, { label: 'Mode', description: 'Choose a mode.', control: select }, scope);
    const selectRelease = mountSelect(select, { label: 'Mode' }, scope);
    const inputRelease = mountInput(input, {}, scope);

    const inputReference = readJson('input.dom.json');
    const inputWrap = input.parentElement;
    assert.equal(inputWrap?.tagName.toLowerCase(), inputReference.root.tag);
    assert.ok(inputWrap?.classList.contains(inputReference.root.class));
    assert.equal(input.classList.contains(inputReference.children.find(item => item.native)?.class), true);
    assert.equal(inputWrap?.querySelector('.icon'), null, 'icon is optional and omitted without an icon prop');

    const fieldReference = readJson('field.dom.json');
    assert.equal(field.querySelector('label')?.htmlFor, 'mode');
    assert.equal(field.querySelector('.vcp-harness-field-description')?.id, 'mode-description');
    assert.equal(Boolean(fieldReference.contract.aria.includes('describedby')), true);
    assert.equal(select.getAttribute('aria-describedby'), 'mode-description');

    const selectReference = readJson('select.dom.json');
    const menu = field.querySelector('[role="menu"]');
    assert.equal(menu?.tagName.toLowerCase(), selectReference.contract.list.tag);
    assert.equal(menu?.querySelectorAll('[role="menuitem"]').length, 2);
    assert.equal(menu?.querySelector('[data-selected="true"]')?.textContent, 'Beta');

    await inputRelease?.();
    await selectRelease?.();
    await fieldRelease?.();
    await scope.dispose('snapshot-contract-complete');
    assert.equal(document.getElementById('name')?.parentElement?.tagName.toLowerCase(), 'main');
    assert.equal(document.querySelector('.vcp-harness-select-trigger'), null);
    console.log('Harness generated snapshot contract passed (Input + Field + Select DOM/state/teardown).');
} finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    dom.window.close();
}
