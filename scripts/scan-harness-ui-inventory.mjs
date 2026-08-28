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
const isUiExport = name => !/^DEFAULT_[A-Z0-9_]+$/.test(name);
const referenceNames = new Set(fs.existsSync(referenceDir)
    ? fs.readdirSync(referenceDir).filter(file => file.endsWith('.dom.json')).map(file => file.replace('.dom.json', ''))
    : []);
const contractAliases = new Map([
    ['ModelSelect', 'model-picker'],
]);
const contractKeyFor = (name, relative) => {
    // The Harness icon barrel exports many named SVGs, while the reference
    // contract intentionally covers the shared semantic-icon adapter boundary.
    if (/ui-primitives[\\/]src[\\/]icons[\\/]index\.tsx$/.test(relative) && /^Icon[A-Z]/.test(name)) return 'semantic-icon';
    return contractAliases.get(name) ?? name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
};
const scopeBoundaryFor = relative => {
    if (/ui-goal/.test(relative)) return 'composer-goal-surface-frozen';
    if (/ui-message-feedback/.test(relative)) return 'chat-feedback-surface-frozen';
    if (/ui-skill|ui-trajectory/.test(relative)) return 'chat-toolview-surface-frozen';
    if (/ui-subagent/.test(relative)) return 'composer-subagent-surface-frozen';
    if (/ui-user-questions/.test(relative)) return 'composer-question-surface-frozen';
    if (/ui-theme/.test(relative)) return 'settings-theme-surface-owned-by-main-thread';
    if (/ui-settings-/.test(relative)) return 'settings-surface-owned-by-main-thread';
    return null;
};
const inventory = files.flatMap(file => {
    const source = fs.readFileSync(file, 'utf8');
    const discovered = [...source.matchAll(componentPattern)].map(match => match[1]);
    const exports = discovered.filter(isUiExport);
    if (!exports.length) return [];
    const relative = path.relative(clientRoot, file);
    const packageName = relative.split(path.sep)[0];
    const frozen = /ui-conversation|markdown|toolviews|ui-tool/.test(relative);
    const scopeBoundary = scopeBoundaryFor(relative);
    return exports.map(name => ({
        name,
        package: packageName,
        source: file,
        relative,
        category: frozen ? 'frozen-domain-surface' : scopeBoundary ? 'scope-blocked-surface' : /ui-primitives/.test(relative) ? 'portable-primitive' : 'composite-surface',
        scopeBoundary,
        contractKey: contractKeyFor(name, relative),
    }));
});
const entries = inventory.map(item => ({
    ...item,
    referenceContract: referenceNames.has(item.contractKey),
}));
const ignoredExports = files.flatMap(file => {
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(componentPattern)].map(match => match[1]).filter(name => !isUiExport(name)).map(name => ({
        name,
        source: file,
        relative: path.relative(clientRoot, file),
        reason: 'non-UI exported constant',
    }));
});
const missingContracts = entries.filter(item => !item.referenceContract && !['frozen-domain-surface', 'scope-blocked-surface'].includes(item.category));
const surfacePatterns = [...new Set(entries.map(item => item.package))].sort().map(packageName => {
    const members = entries.filter(item => item.package === packageName);
    return {
        pattern: packageName,
        sourceFiles: [...new Set(members.map(item => item.relative))].sort(),
        exports: members.length,
        portablePrimitives: members.filter(item => item.category === 'portable-primitive').length,
        composites: members.filter(item => item.category === 'composite-surface').length,
        frozenDomainSurfaces: members.filter(item => item.category === 'frozen-domain-surface').length,
        scopeBlockedSurfaces: members.filter(item => item.category === 'scope-blocked-surface').length,
        contracted: members.filter(item => item.referenceContract).length,
        missingContracts: members.filter(item => !item.referenceContract && !['frozen-domain-surface', 'scope-blocked-surface'].includes(item.category)).length,
    };
});
const report = {
    generatedAt: new Date().toISOString(),
    harnessRoot,
    clientRoot,
    status: missingContracts.length ? 'inventory-gaps-present' : 'inventory-covered',
    counts: {
        sourceFiles: files.length,
        ignoredExports: ignoredExports.length,
        exports: entries.length,
        portablePrimitives: entries.filter(item => item.category === 'portable-primitive').length,
        composites: entries.filter(item => item.category === 'composite-surface').length,
        frozenDomainSurfaces: entries.filter(item => item.category === 'frozen-domain-surface').length,
        scopeBlockedSurfaces: entries.filter(item => item.category === 'scope-blocked-surface').length,
        missingContracts: missingContracts.length,
    },
    entries,
    surfacePatterns,
    ignoredExports,
    missingContracts,
    nextCandidates: missingContracts.slice(0, 12).map(item => ({ name: item.name, package: item.package, source: item.source })),
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness UI inventory written (status=${report.status}; exports=${entries.length}; missingContracts=${missingContracts.length}).`);
