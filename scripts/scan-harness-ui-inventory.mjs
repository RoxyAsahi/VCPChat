import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const clientRoot = path.join(harnessRoot, 'packages/client');
const referenceDir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const reportPath = path.join(root, 'reports/harness-ui-inventory.json');
const walk = directory => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(file) : [file];
    });
};
const files = walk(clientRoot).filter(file => /\.tsx$/.test(file) && !file.includes('/tests/'));
const componentPattern = /export\s+(?:function|const|class)\s+([A-Z][A-Za-z0-9_]*)/g;
const referenceNames = new Set(fs.existsSync(referenceDir)
    ? fs.readdirSync(referenceDir).filter(file => file.endsWith('.dom.json')).map(file => file.replace('.dom.json', ''))
    : []);
const contractAliases = new Map([
    ['ModelSelect', 'model-picker'],
]);
const inventory = files.flatMap(file => {
    const source = fs.readFileSync(file, 'utf8');
    const exports = [...source.matchAll(componentPattern)].map(match => match[1]);
    if (!exports.length) return [];
    const relative = path.relative(clientRoot, file);
    const packageName = relative.split(path.sep)[0];
    const frozen = /ui-conversation|markdown|toolviews|ui-tool/.test(relative);
    return exports.map(name => ({
        name,
        package: packageName,
        source: file,
        relative,
        category: frozen ? 'frozen-domain-surface' : /ui-primitives/.test(relative) ? 'portable-primitive' : 'composite-surface',
        contractKey: contractAliases.get(name) ?? name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
    }));
});
const entries = inventory.map(item => ({
    ...item,
    referenceContract: referenceNames.has(item.contractKey),
}));
const missingContracts = entries.filter(item => !item.referenceContract && item.category !== 'frozen-domain-surface');
const report = {
    generatedAt: new Date().toISOString(),
    harnessRoot,
    clientRoot,
    status: missingContracts.length ? 'inventory-gaps-present' : 'inventory-covered',
    counts: {
        sourceFiles: files.length,
        exports: entries.length,
        portablePrimitives: entries.filter(item => item.category === 'portable-primitive').length,
        composites: entries.filter(item => item.category === 'composite-surface').length,
        frozenDomainSurfaces: entries.filter(item => item.category === 'frozen-domain-surface').length,
        missingContracts: missingContracts.length,
    },
    entries,
    missingContracts,
    nextCandidates: missingContracts.slice(0, 12).map(item => ({ name: item.name, package: item.package, source: item.source })),
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness UI inventory written (status=${report.status}; exports=${entries.length}; missingContracts=${missingContracts.length}).`);
