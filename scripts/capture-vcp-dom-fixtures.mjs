import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const out = path.join(root, 'docs/reference/deepseek-harness-primitives/fixtures/vcp');
fs.mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');
const { createUiScope } = await import('../modules/uiux/generated/runtime/scope.js');
const { mountField } = await import('../modules/uiux/generated/primitives/field.js');
const { mountSelect } = await import('../modules/uiux/generated/primitives/select.js');
const { mountInput } = await import('../modules/uiux/generated/primitives/input.js');

const dom = new JSDOM('<!doctype html><main id="fixture"><div id="field"><select id="mode"><option selected>Comfortable</option><option>Compact</option></select></div><input id="name" value=""></main>');
const previousDocument = globalThis.document;
const previousWindow = globalThis.window;
globalThis.document = dom.window.document;
globalThis.window = dom.window;
try {
    const scope = createUiScope(new LifecycleScope('vcp-dom-fixture-capture'));
    const field = document.getElementById('field');
    const select = document.getElementById('mode');
    const input = document.getElementById('name');
    const fieldRelease = mountField(field, { label: 'Mode', description: 'Choose a mode.', control: select }, scope);
    const selectRelease = mountSelect(select, { label: 'Mode', portal: false }, scope);
    const inputRelease = mountInput(input, { placeholder: 'Search' }, scope);
    fs.writeFileSync(path.join(out, 'input.default.dom.html'), input.parentElement.outerHTML, 'utf8');
    input.focus();
    fs.writeFileSync(path.join(out, 'input.focus.dom.html'), input.parentElement.outerHTML, 'utf8');
    input.disabled = true;
    fs.writeFileSync(path.join(out, 'input.disabled.dom.html'), input.parentElement.outerHTML, 'utf8');
    input.disabled = false;
    fs.writeFileSync(path.join(out, 'field.description.dom.html'), field.outerHTML, 'utf8');
    const trigger = document.querySelector('.vcp-harness-select-trigger');
    fs.writeFileSync(path.join(out, 'select.closed.dom.html'), field.outerHTML, 'utf8');
    trigger.click();
    fs.writeFileSync(path.join(out, 'select.open.dom.html'), field.outerHTML, 'utf8');
    fs.writeFileSync(path.join(out, 'select.selected.dom.html'), field.outerHTML, 'utf8');
    select.disabled = true;
    trigger.click();
    fs.writeFileSync(path.join(out, 'select.disabled.dom.html'), field.outerHTML, 'utf8');
    await inputRelease?.(); await selectRelease?.(); await fieldRelease?.(); await scope.dispose('fixture-complete');
    console.log('VCP generated DOM fixtures captured (Input default/focus/disabled, Field.description, Select closed/open/selected/disabled).');
} finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    dom.window.close();
}
