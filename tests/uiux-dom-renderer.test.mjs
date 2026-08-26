import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LifecycleScope } = require('../modules/ui-system/lifecycle-scope.js');
const { createUiScope } = await import('../modules/uiux/runtime/scope.ts');
const { createDomRenderer } = await import('../modules/uiux/runtime/dom-renderer.ts');

test('DomRenderer owns mount, text update, keyed insertion and dispose', async () => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
        const scope = createUiScope(new LifecycleScope('dom-renderer-test'));
        const renderer = createDomRenderer(scope);
        const root = document.getElementById('root');
        const text = document.createTextNode('old');
        const release = renderer.mount(root, text);
        renderer.updateText(text, 'new');
        assert.equal(root.textContent, 'new');
        const keyedRelease = renderer.keyed(root, [{ id: 'a' }, { id: 'b' }], item => item.id, item => { const node = document.createElement('span'); node.dataset.key = item.id; return node; });
        assert.deepEqual([...root.children].map(node => node.dataset.key), ['a', 'b']);
        keyedRelease.update([{ id: 'b' }, { id: 'c' }]);
        assert.deepEqual([...root.children].map(node => node.dataset.key), ['b', 'c']);
        await keyedRelease();
        assert.equal(root.children.length, 0);
        await release();
        await scope.dispose('dom-renderer-complete');
    } finally { globalThis.document = previous; dom.window.close(); }
});
