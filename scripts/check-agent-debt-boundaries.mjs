import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const errors = [];

function filesUnder(directory, predicate = () => true) {
    if (!fs.existsSync(directory)) return [];
    const pending = [directory];
    const files = [];
    while (pending.length) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) pending.push(absolute);
            else if (predicate(absolute)) files.push(absolute);
        }
    }
    return files;
}

function localDependencies(file) {
    const source = fs.readFileSync(file, 'utf8');
    const dependencies = [];
    const pattern = /(?:from\s+|import\s*(?:\(\s*)?|require\s*\()\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
        if (!match[1].startsWith('.')) continue;
        const base = path.resolve(path.dirname(file), match[1]);
        const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')];
        const resolved = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (resolved) dependencies.push(resolved);
    }
    return dependencies;
}

const productionCandidates = [
    ...filesUnder(path.join(root, 'modules/codex-runtime'), (file) => file.endsWith('.js')),
    ...filesUnder(path.join(root, 'modules/ui-system'), (file) => file.endsWith('.js') && (
        /[\\/]agent[^\\/]*\.js$/.test(file) || file.includes(`${path.sep}agent-presentation${path.sep}`)
        || file.includes(`${path.sep}agent-store${path.sep}`)
    )),
];
const productionSet = new Set(productionCandidates);
const entries = [
    'modules/codex-runtime/runtimeManager.js',
    'modules/ipc/agentRuntimeHandlers.js',
    'modules/ui-system/agent-workbench.js',
].map((relative) => path.join(root, relative));
const reachable = new Set();
const pending = [...entries];
while (pending.length) {
    const file = pending.pop();
    if (!fs.existsSync(file) || reachable.has(file)) continue;
    reachable.add(file);
    for (const dependency of localDependencies(file)) pending.push(dependency);
}
const orphanAllowlist = new Map([
    ['modules/ui-system/agent-presentation/renderer.js', 'standalone presentation contract fixture'],
    ['modules/ui-system/agent-presentation/content-renderer-fork.js', 'fork contract fixture'],
    ['modules/ui-system/agent-presentation/streaming-accumulator.js', 'stream accumulator contract fixture'],
    ['modules/ui-system/agent-presentation/fork/agentRenderContext.js', 'fork receipt context fixture'],
]);
for (const file of productionSet) {
    if (reachable.has(file)) continue;
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (!orphanAllowlist.has(relative)) errors.push(`orphan Agent production module: ${relative}`);
}
for (const [relative] of orphanAllowlist) {
    if (!fs.existsSync(path.join(root, relative))) errors.push(`stale orphan allowlist entry: ${relative}`);
}

for (const removed of [
    'archive/agent-runtime', '.github/workflows/rust_agent_runtime.yml', 'rust/Cargo.toml',
    'modules/ui-system/agent-workbench-topic-flow.js', 'modules/ui-system/agent-topic-context-menu-view.js',
]) {
    if (fs.existsSync(path.join(root, removed))) errors.push(`removed route returned: ${removed}`);
}
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(packageJson.scripts || {}).some((name) => /^archive:(?:rust|pi):/.test(name))) {
    errors.push('root package exposes a removed Pi/Rust command');
}
const bridgeManifest = fs.readFileSync(path.join(root, 'rust/toolbox-bridge/Cargo.toml'), 'utf8');
for (const member of ['vcp-agent-protocol', 'vcp-agent-vcp', 'vcp-toolbox-bridge']) {
    if (!bridgeManifest.includes(`"crates/${member}"`)) errors.push(`Bridge workspace missing ${member}`);
}
for (const removedMember of ['vcp-agentd', 'vcp-agent-core', 'vcp-agent-host', 'vcp-grok-', 'rust-tui']) {
    if (bridgeManifest.includes(removedMember)) errors.push(`Bridge workspace includes removed member ${removedMember}`);
}
if (!packageJson.build?.extraResources?.some((entry) => (
    entry.from === 'rust/toolbox-bridge/target/release/vcp-toolbox-bridge.exe'
    && entry.to === 'vcp-toolbox-bridge.exe'
))) errors.push('Electron packaging does not use the canonical Bridge path');

const currentDocs = filesUnder(path.join(root, 'docs/agent-runtime/current'), (file) => file.endsWith('.md'));
for (const file of currentDocs) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].trim().replace(/^<|>$/g, '').split('#')[0];
        if (!target || target.startsWith('#') || /^[a-z]+:/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
        if (!fs.existsSync(resolved)) {
            errors.push(`broken current-doc link: ${path.relative(root, file)} -> ${target}`);
        }
    }
}

const receiptDirectory = path.join(root, 'docs/agent-runtime/current/receipts');
for (const file of filesUnder(receiptDirectory, (entry) => entry.endsWith('.json'))) {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!receipt.testedCommit) continue;
    const exists = spawnSync('git', ['cat-file', '-e', `${receipt.testedCommit}^{commit}`], { cwd: root });
    if (exists.status !== 0) {
        errors.push(`receipt references missing commit: ${path.basename(file)}`);
        continue;
    }
    if (Array.isArray(receipt.protectedPaths) && receipt.protectedPaths.length) {
        const changed = spawnSync('git', ['diff', '--quiet', `${receipt.testedCommit}..HEAD`, '--', ...receipt.protectedPaths], { cwd: root });
        if (changed.status === 1) errors.push(`stale current receipt: ${path.basename(file)}`);
        else if (changed.status !== 0) errors.push(`could not validate receipt: ${path.basename(file)}`);
    }
}

if (errors.length) {
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
}
console.log(`Agent debt boundary check passed (${productionSet.size} production modules, ${currentDocs.length} current docs).`);
