import fs from 'node:fs';
import path from 'node:path';

const harness = '/Users/asahi/Documents/Codex/deepseek-harness';
const source = path.join(harness, 'packages/client/ui-primitives/src/Input.tsx');
const tests = path.join(harness, 'packages/client/ui-primitives/tests/atoms.client.spec.tsx');
for (const file of [source, tests]) {
    if (!fs.existsSync(file)) throw new Error(`[harness-input-consumer] missing expected Harness source: ${file}`);
}

// This is an intentionally conservative source inventory, not a substitute
// for a browser fixture. It prevents the roadmap from promoting a unit-test
// only atom as a production consumer.
const roots = [path.join(harness, 'packages/client'), path.join(harness, 'apps/web')];
const files = [];
const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(target); continue; }
        if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name) && !target.includes('/lib/')) files.push(target);
    }
};
roots.forEach(walk);
const importsInput = text => {
    const namedImport = /import\s*(?:type\s*)?\{([\s\S]*?)\}\s*from\s*['"]@deepseek-ai\/dsh-client-ui-primitives['"]/g;
    for (const match of text.matchAll(namedImport)) {
        if (match[1].split(',').some(entry => /^(?:type\s+)?Input(?:\s+as\s+\w+)?\s*$/.test(entry.trim()))) return true;
    }
    return /import\s+\*\s+as\s+(\w+)\s+from\s+['"]@deepseek-ai\/dsh-client-ui-primitives['"][\s\S]*?\1\.Input\b/.test(text);
};
const production = files.filter(file => !file.includes('/tests/') && file !== source).filter(file => {
    const text = fs.readFileSync(file, 'utf8');
    return importsInput(text);
});
const report = {
    generatedAt: new Date().toISOString(),
    source: path.relative(harness, source),
    test: path.relative(harness, tests),
    productionConsumers: production.map(file => path.relative(harness, file)),
    eligibleForProductionBrowserFixture: production.length > 0,
    status: production.length ? 'production-consumer-present' : 'production-consumer-absent',
};
const output = path.join(process.cwd(), 'reports/harness-input-production-consumer.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
if (production.length) throw new Error(`[harness-input-consumer] source inventory changed; review ${production.join(', ')}`);
console.log('Harness Input source inventory passed: no production consumer is currently available.');
