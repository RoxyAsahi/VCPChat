import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const referenceDir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const reportPath = path.join(root, 'reports/harness-geometry-contracts.json');
const require = createRequire(import.meta.url);
const csstree = require('css-tree');
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').trim();
const kebab = value => value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const resolve = value => path.isAbsolute(value) ? value : path.join(harnessRoot, value);
const readJson = file => JSON.parse(fs.readFileSync(path.join(referenceDir, file), 'utf8'));

const checks = [];
for (const geometryFile of fs.readdirSync(referenceDir).filter(file => file.endsWith('.geometry.json')).sort()) {
    const name = geometryFile.replace('.geometry.json', '');
    const geometry = readJson(geometryFile);
    let dom = null;
    try { dom = readJson(`${name}.dom.json`); } catch { /* geometry-only references remain reportable */ }
    const styleSource = geometry.styleSource ?? dom?.styleSource;
    const entry = { name, geometryFile, styleSource: styleSource ?? null, status: 'pending', checks: [], missing: [] };
    if (!styleSource) {
        entry.missing.push('styleSource');
        checks.push(entry);
        continue;
    }
    const sourcePath = resolve(styleSource);
    if (!fs.existsSync(sourcePath)) {
        entry.missing.push(`missing source: ${styleSource}`);
        checks.push(entry);
        continue;
    }
    const css = fs.readFileSync(sourcePath, 'utf8');
    const tokenNames = [...new Set([...css.matchAll(/var\((--[A-Za-z0-9_-]+)/g)].map(match => match[1]))];
    entry.tokens = { names: tokenNames, harnessDswCount: tokenNames.filter(name => name.startsWith('--dsw-')).length, pass: tokenNames.some(name => name.startsWith('--dsw-')) };
    const ast = csstree.parse(css);
    const declarations = new Map();
    csstree.walk(ast, {
        visit: 'Rule',
        enter(node) {
            if (node.type !== 'Rule') return;
            const selectors = new Set();
            csstree.walk(node.prelude, { visit: 'ClassSelector', enter(selector) { selectors.add(`.${selector.name}`); } });
            if (!selectors.size) return;
            const values = {};
            csstree.walk(node.block, { visit: 'Declaration', enter(declaration) { values[declaration.property] = csstree.generate(declaration.value); } });
            for (const selector of selectors) declarations.set(selector, { ...(declarations.get(selector) ?? {}), ...values });
        },
    });
    for (const [selector, properties] of Object.entries(geometry.selectors ?? {})) {
        const baseSelector = selector.match(/\.[A-Za-z0-9_-]+/)?.[0] ?? selector;
        for (const [property, expected] of Object.entries(properties)) {
            if (property === 'offset') continue;
            const cssProperty = kebab(property);
            const actual = declarations.get(baseSelector)?.[cssProperty] ?? null;
            entry.checks.push({ selector, property: cssProperty, expected, actual, pass: actual !== null && normalize(actual) === normalize(expected) });
        }
    }
    entry.status = entry.checks.length && entry.checks.every(item => item.pass) ? 'source-equivalent' : 'source-mismatch';
    if (!entry.tokens.pass) entry.missing.push('Harness --dsw-* token usage');
    entry.missing = entry.checks.filter(item => !item.pass).map(item => `${item.selector} ${item.property}`);
    checks.push(entry);
}
const report = {
    generatedAt: new Date().toISOString(),
    harnessRoot,
    status: checks.some(item => item.status === 'source-mismatch' || item.status === 'pending') ? 'geometry-evidence-gaps-present' : 'source-equivalent',
    counts: { contracts: checks.length, sourceEquivalent: checks.filter(item => item.status === 'source-equivalent').length, mismatched: checks.filter(item => item.status === 'source-mismatch').length, pending: checks.filter(item => item.status === 'pending').length, checks: checks.reduce((sum, item) => sum + item.checks.length, 0) },
    checks,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness geometry contracts written (status=${report.status}; equivalent=${report.counts.sourceEquivalent}/${report.counts.contracts}).`);
