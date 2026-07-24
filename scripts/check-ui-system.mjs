import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postcss from 'postcss';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const styleDir = path.join(root, 'styles', 'ui-system');
const moduleDir = path.join(root, 'modules', 'ui-system');
const failures = [];

function filesIn(directory, extension) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? filesIn(target, extension) : entry.name.endsWith(extension) ? [target] : [];
    });
}

function report(file, message) {
    failures.push(`${path.relative(root, file)}: ${message}`);
}

function inspectSelectors(file, css) {
    const root = postcss.parse(css, { from: file });
    root.walkRules(rule => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        rule.selectors.forEach(selector => {
            if (!selector.startsWith('html[data-ui-mode="next"]')) {
                report(file, `selector escapes next UI scope: ${selector}`);
            }
            if (!selector.includes('.vcp-ui-scope')) {
                report(file, `selector is missing .vcp-ui-scope: ${selector}`);
            }
        });
    });
}

for (const file of filesIn(styleDir, '.css')) {
    const css = fs.readFileSync(file, 'utf8');
    if (/!important\b/.test(css)) report(file, 'contains !important');
    const basename = path.basename(file);
    if (!['tokens.css', 'fonts.css', 'index.css'].includes(basename)) {
        if (/(#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\()/i.test(css)) report(file, 'contains an unregistered literal color');
        if (/font-size\s*:\s*(?:\d|\.)/i.test(css)) report(file, 'contains a fixed font size outside tokens');
    }
    if (!['index.css'].includes(basename)) inspectSelectors(file, css);
}

const componentCss = fs.readFileSync(path.join(styleDir, 'components.css'), 'utf8');
if (!componentCss.includes(':focus-visible')) report(path.join(styleDir, 'components.css'), 'missing focus-visible rules');

for (const file of filesIn(moduleDir, '.js')) {
    const source = fs.readFileSync(file, 'utf8');
    if (/\bstyle\s*=|\.style\./.test(source)) report(file, 'contains inline style mutation');
}

const runtimeFile = path.join(moduleDir, 'vcp-ui.js');
const runtime = fs.readFileSync(runtimeFile, 'utf8');
const registrations = [...runtime.matchAll(/\['([A-Za-z]+)',\s*[a-zA-Z]/g)].map(match => match[1]);
const duplicateComponents = registrations.filter((name, index) => registrations.indexOf(name) !== index);
if (duplicateComponents.length) report(runtimeFile, `duplicate component registrations: ${[...new Set(duplicateComponents)].join(', ')}`);
const requiredComponents = ['Button', 'IconButton', 'Input', 'Textarea', 'Select', 'Range', 'Checkbox', 'Switch', 'Field', 'SettingsSection', 'SettingsActionBar', 'Badge', 'Alert', 'Card', 'Tabs', 'Toolbar', 'List', 'TableFrame', 'EmptyState', 'Divider', 'Tooltip', 'Skeleton', 'SegmentedControl', 'Pagination', 'ScrollArea', 'Modal', 'Toast', 'ConfirmDialog', 'InputDialog'];
requiredComponents.filter(name => !registrations.includes(name)).forEach(name => report(runtimeFile, `missing component registration: ${name}`));

const manifestFile = path.join(moduleDir, 'component-manifest.js');
const { COMPONENT_MANIFEST } = await import(pathToFileURL(manifestFile).href);
const manifestNames = COMPONENT_MANIFEST.flatMap(item => [item.name, ...item.aliases]);
const duplicateManifestNames = manifestNames.filter((name, index) => manifestNames.indexOf(name) !== index);
if (duplicateManifestNames.length) report(manifestFile, `duplicate manifest names: ${[...new Set(duplicateManifestNames)].join(', ')}`);
COMPONENT_MANIFEST.forEach(item => {
    if (!['stable', 'candidate', 'deprecated'].includes(item.status)) report(manifestFile, `invalid status for ${item.name}: ${item.status}`);
});
registrations.filter(name => !manifestNames.includes(name)).forEach(name => report(manifestFile, `registered component is missing from manifest: ${name}`));
manifestNames.filter(name => !registrations.includes(name)).forEach(name => report(manifestFile, `manifest component is not registered: ${name}`));

const mainHtmlFile = path.join(root, 'main.html');
const mainDom = new JSDOM(fs.readFileSync(mainHtmlFile, 'utf8'));
const modalTemplates = [...mainDom.window.document.querySelectorAll('template[id$="ModalTemplate"]')];
modalTemplates.forEach(template => {
    const modal = template.content.querySelector('.modal');
    if (modal && !modal.classList.contains('vcp-ui-scope')) {
        report(mainHtmlFile, `modal template ${template.id} is missing vcp-ui-scope`);
    }
});
const globalSearchTemplate = mainDom.window.document.querySelector('template#globalSearchModalTemplate');
const globalSearch = globalSearchTemplate?.content.querySelector('#global-search-modal');
if (!globalSearch?.classList.contains('vcp-ui-scope')) {
    report(mainHtmlFile, 'global search template is missing vcp-ui-scope');
}

const appIds = [];
for (const file of filesIn(moduleDir, '.js')) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/register\(\{[\s\S]*?\bid:\s*'([^']+)'/g)) appIds.push({ id: match[1], file });
}
appIds.forEach((item, index) => {
    if (appIds.findIndex(candidate => candidate.id === item.id) !== index) report(item.file, `duplicate application id: ${item.id}`);
});

if (failures.length) {
    console.error('UI system guard failed:\n');
    failures.forEach(failure => console.error(`- ${failure}`));
    process.exit(1);
}

console.log(`UI system guard passed (${filesIn(styleDir, '.css').length} CSS files, ${filesIn(moduleDir, '.js').length} modules).`);
