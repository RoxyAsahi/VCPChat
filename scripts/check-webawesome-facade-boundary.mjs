import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const forbidden = ['on', 'translateEvent', 'awaitUpdate', 'applyTokens', 'registerTheme', 'destroy'];
const files = [];
const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && file.endsWith('.js')
            && !file.includes(`${path.sep}scripts${path.sep}`)
            && !file.includes(`${path.sep}tests${path.sep}`)
            && !file.endsWith(`${path.sep}webawesome-adapter.js`)) files.push(file);
    }
};
walk(path.join(root, 'modules'));
for (const entry of ['renderer.js', 'main.js', 'main.html']) {
    const file = path.join(root, entry);
    if (fs.existsSync(file)) files.push(file);
}
for (const directory of ['preloads']) {
    if (fs.existsSync(path.join(root, directory))) walk(path.join(root, directory));
}
const violations = [];
for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const name of forbidden) {
        const direct = new RegExp(`VCPWebAwesome\\s*(?:\\.|\\[\\s*["']?)${name}(?:["']?\\s*\\])?\\s*\\(`);
        if (direct.test(source)) violations.push(`${path.relative(root, file)}: forbidden VCPWebAwesome.${name} facade call`);
    }
    const aliases = [...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\.)?VCPWebAwesome\b/g)];
    for (const [, alias] of aliases) {
        for (const name of forbidden) {
            if (new RegExp(`\\b${alias}\\s*(?:\\.|\\[\\s*["']?)${name}(?:["']?\\s*\\])?\\s*\\(`).test(source)) {
                violations.push(`${path.relative(root, file)}: forbidden VCPWebAwesome alias ${alias}.${name}`);
            }
        }
    }
}
if (violations.length) {
    console.error(`Web Awesome facade boundary failed:\n${violations.join('\n')}`);
    process.exitCode = 1;
} else {
    console.log(`Web Awesome facade boundary passed (${files.length} production modules scanned).`);
}
