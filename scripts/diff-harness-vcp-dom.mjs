import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const fixtureRoot = path.join(root, 'docs/reference/deepseek-harness-primitives/fixtures');
const reportDir = path.join(root, 'reports');
fs.mkdirSync(reportDir, { recursive: true });
const parse = file => new JSDOM(fs.readFileSync(file, 'utf8')).window.document.body.firstElementChild;
const primitiveRoot = (name, node) => name.startsWith('select.') ? node?.querySelector('[role="menu"]') : node;
const normalizeClass = value => [...new Set(String(value || '').split(/\s+/).filter(Boolean).map(token => {
    if (/^_[a-zA-Z]+_[a-z0-9]+$/.test(token)) return token.replace(/^_([a-zA-Z]+)_.*$/, '$1');
    return token.replace(/^vcp-uiux-input-wrap$/, 'wrap').replace(/^vcp-harness-menu-list$/, 'list').replace(/^vcp-uiux-primitive-menu$/, '').replace(/^vcp-harness-menu-scrollable$/, 'scrollable').replace(/^vcp-harness-menu-viewport$/, 'viewport').replace(/^vcp-harness-menu-item-wrap$/, 'itemWrap').replace(/^vcp-harness-menu-item$/, 'item').replace(/^vcp-harness-menu-item-label$/, 'itemLabel').replace(/^vcp-harness-menu-item-check$/, 'check').replace(/^vcp-harness-menu-item-selected$/, 'selected').replace(/^vcp-harness-field$/, 'field').replace(/^vcp-harness-field-head$/, 'head').replace(/^vcp-harness-field-label$/, 'label').replace(/^vcp-harness-field-input$/, 'input').replace(/^vcp-harness-field-input-invalid$/, 'inputInvalid').replace(/^vcp-harness-field-description$/, 'hint').replace(/^vcp-harness-field-error$/, 'invalid');
}).filter(Boolean))].sort().join(' ');
const shape = node => node ? { tag: node.tagName.toLowerCase(), class: normalizeClass(node.getAttribute('class')), role: node.getAttribute('role'), aria: [...node.attributes].filter(attribute => attribute.name.startsWith('aria-')).sort((a, b) => a.name.localeCompare(b.name)).map(attribute => [attribute.name, attribute.value]), children: [...node.children].map(shape) } : null;
const cases = [
  ['input.default', 'input.default.dom.html'],
  ['input.focus', 'input.focus.dom.html'],
  ['input.disabled', 'input.disabled.dom.html'],
  ['input.icon', 'input.icon.dom.html'],
  ['select.closed', 'select.closed.dom.html'],
  ['select.open', 'select.open.dom.html'],
  ['select.selected', 'select.selected.dom.html'],
  ['select.disabled', 'select.disabled.dom.html'],
  ['field.error', 'field.error.dom.html'],
  ['field.description', 'field.description.dom.html'],
];
const results = [];
for (const [name, file] of cases) {
  const harnessFile = path.join(fixtureRoot, 'harness', file);
  const vcpFile = path.join(fixtureRoot, 'vcp', file);
  if (!fs.existsSync(harnessFile) || !fs.existsSync(vcpFile)) {
    results.push({ case: name, status: 'pending', pass: false, missing: [!fs.existsSync(harnessFile) ? 'harness' : null, !fs.existsSync(vcpFile) ? 'vcp' : null].filter(Boolean) });
    continue;
  }
  const harness = shape(primitiveRoot(name, parse(harnessFile)));
  const vcp = shape(primitiveRoot(name, parse(vcpFile)));
  results.push({ case: name, status: 'compared', pass: JSON.stringify(harness) === JSON.stringify(vcp), harness, vcp });
}
const report = { generatedAt: new Date().toISOString(), cases: results, compared: results.filter(result => result.status === 'compared').length, pending: results.filter(result => result.status === 'pending').length, pass: results.every(result => result.pass) };
fs.writeFileSync(path.join(reportDir, 'harness-vcp-dom-diff.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`Harness↔VCP DOM diff report written (${results.filter(result => result.pass).length}/${results.length} cases structurally equal; pass=${report.pass}).`);
