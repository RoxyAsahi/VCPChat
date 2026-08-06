import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    getWorkspacePreviewModes,
    renderWorkspacePreviewContent,
} from '../modules/ui-system/agent-workspace-preview-registry.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { document } = dom.window;
dom.window.marked = { parse: (value) => `<h1>${value}</h1><script>alert(1)</script><a href="javascript:alert(2)">bad</a>` };
const browser = { previewMode: 'preview', editDraft: '# Draft' };
const actions = { updateEditDraft() {}, run: (work) => work(), saveText() {} };

assert.deepEqual(getWorkspacePreviewModes({ kind: 'markdown', editable: true }), ['preview', 'source', 'edit']);
assert.deepEqual(getWorkspacePreviewModes({ kind: 'pdf' }), ['preview']);

const markdown = renderWorkspacePreviewContent({
    preview: { kind: 'markdown', content: 'Title', displayName: 'README.md' }, browser, actions, document,
});
assert.equal(markdown.querySelector('script'), null);
assert.equal(markdown.querySelector('a')?.hasAttribute('href'), false,
    'rendered workspace Markdown must reject executable URLs');

const html = renderWorkspacePreviewContent({
    preview: { kind: 'html', content: '<button>App</button>', displayName: 'index.html' }, browser, actions, document,
});
assert.equal(html.tagName, 'IFRAME');
assert.equal(html.getAttribute('sandbox'), 'allow-scripts');
assert.match(html.srcdoc, /Content-Security-Policy/);
assert.match(html.srcdoc, /connect-src 'none'/);

browser.previewMode = 'edit';
const editor = renderWorkspacePreviewContent({
    preview: { kind: 'text', content: 'old', displayName: 'index.js', editable: true }, browser, actions, document,
});
assert.equal(editor.querySelector('textarea')?.value, '# Draft');

const pdf = renderWorkspacePreviewContent({
    preview: { kind: 'pdf', dataUrl: 'data:application/pdf;base64,AA==', displayName: 'a.pdf' },
    browser: { previewMode: 'preview' }, actions, document,
});
assert.equal(pdf.tagName, 'IFRAME');
assert.match(pdf.src, /^data:application\/pdf/);

console.log('Agent workspace preview registry tests passed.');
