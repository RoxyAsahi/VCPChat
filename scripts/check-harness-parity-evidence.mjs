import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const referenceDir = path.join(root, 'docs/reference/deepseek-harness-primitives');
const harnessRoot = process.env.DEEPSEEK_HARNESS_ROOT || '/Users/asahi/Documents/Codex/deepseek-harness';
const strict = process.argv.includes('--strict');
const reportPath = path.join(root, 'reports/harness-parity-evidence.json');

const fail = (message, details = {}) => ({ status: 'invalid', message, ...details });
const readJson = name => {
    try { return JSON.parse(fs.readFileSync(path.join(referenceDir, name), 'utf8')); }
    catch (error) { return fail(`invalid JSON: ${error.message}`, { file: name }); }
};
const isPathLike = value => typeof value === 'string' && (
    value.includes('/') || value.includes('\\') || /\.(tsx?|css|jsx?)$/.test(value)
);
const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value];
const resolveSource = value => {
    if (!isPathLike(value)) return null;
    if (path.isAbsolute(value)) return value;
    return path.join(harnessRoot, value);
};

const domFiles = fs.existsSync(referenceDir)
    ? fs.readdirSync(referenceDir).filter(file => file.endsWith('.dom.json')).sort()
    : [];
const primitives = [];
const missingEvidence = [];
const invalid = [];

for (const domFile of domFiles) {
    const name = domFile.replace(/\.dom\.json$/, '');
    const dom = readJson(domFile);
    const geometry = readJson(`${name}.geometry.json`);
    const entry = { name, domFile, geometryFile: `${name}.geometry.json`, provenance: [], contract: {} };
    if (dom.status === 'invalid') {
        invalid.push({ name, dom, geometry });
        continue;
    }
    if (geometry.status === 'invalid') {
        if (/ENOENT/.test(geometry.message ?? '')) missingEvidence.push(`${name}: geometry contract is not captured`);
        else invalid.push({ name, geometry });
    }
    for (const source of asArray(dom.source)) {
        const resolved = resolveSource(source);
        const exists = Boolean(resolved && fs.existsSync(resolved));
        entry.provenance.push({ kind: 'source', declared: source, resolved, exists });
        if (!resolved) missingEvidence.push(`${name}: source is descriptive rather than a Harness path`);
        else if (!exists) missingEvidence.push(`${name}: missing Harness source ${source}`);
    }
    for (const styleSource of asArray(dom.styleSource ?? geometry.styleSource)) {
        const resolved = resolveSource(styleSource);
        const exists = Boolean(resolved && fs.existsSync(resolved));
        entry.provenance.push({ kind: 'style', declared: styleSource, resolved, exists });
        if (!resolved) missingEvidence.push(`${name}: style source is descriptive rather than a Harness path`);
        else if (!exists) missingEvidence.push(`${name}: missing Harness style source ${styleSource}`);
    }
    const rootContract = dom.root;
    const domContract = dom.contract ?? dom.harnessContract ?? dom.standardContract ?? dom.headlessContract ?? dom.tree ?? dom.reference;
    entry.contract.domAria = Boolean(
        (rootContract?.tag && (Array.isArray(dom.aria) || dom.children || dom.states))
        || (domContract && (typeof domContract === 'object' || Array.isArray(domContract)))
        || (dom.root && typeof dom.root === 'object')
    );
    entry.contract.geometry = Boolean(geometry && geometry.status !== 'invalid' && typeof geometry === 'object' && Object.keys(geometry).length > 0);
    if (!entry.contract.domAria) invalid.push({ name, issue: 'DOM/ARIA contract is missing a structural declaration' });
    if (!entry.contract.geometry) invalid.push({ name, issue: 'geometry contract is empty' });
    primitives.push(entry);
}

const matrix = readJson('fixture-matrix.json');
const matrixValid = matrix.status !== 'invalid'
    && matrix.viewport?.width === 800
    && matrix.viewport?.height === 600
    && matrix.viewport?.deviceScaleFactor === 1
    && Array.isArray(matrix.cases)
    && Array.isArray(matrix.interactionCases);
if (!matrixValid) invalid.push({ name: 'fixture-matrix', issue: 'viewport/cases/interactionCases contract is incomplete' });

const interactionCases = Array.isArray(matrix?.interactionCases) ? matrix.interactionCases : [];
for (const item of interactionCases) {
    if (!item?.case || !item?.status || !item?.evidence) invalid.push({ name: 'fixture-matrix', issue: `incomplete interaction case ${item?.case ?? '<unknown>'}` });
    if (typeof item?.status === 'string' && /pending|blocked|source-only/i.test(item.status)) {
        missingEvidence.push(`${item.case}: ${item.status}`);
    }
}

const nextCandidate = interactionCases.find(item => /pending|blocked|source-only/i.test(item?.status ?? ''))?.case ?? null;
const report = {
    generatedAt: new Date().toISOString(),
    harnessRoot,
    strict,
    status: invalid.length ? 'invalid-reference-pack' : missingEvidence.length ? 'evidence-gaps-present' : 'complete',
    pass: invalid.length === 0 && missingEvidence.length === 0,
    counts: { primitives: primitives.length, provenanceRecords: primitives.reduce((sum, item) => sum + item.provenance.length, 0), interactionCases: interactionCases.length, invalid: invalid.length, missingEvidence: missingEvidence.length },
    primitives,
    interactionCases,
    invalid,
    missingEvidence,
    nextCandidate,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Harness parity evidence report written (status=${report.status}; primitives=${primitives.length}; gaps=${missingEvidence.length}).`);
if (strict && !report.pass) process.exitCode = 1;
