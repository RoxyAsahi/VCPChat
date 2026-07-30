import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const scriptsDirectory = path.resolve(import.meta.dirname);
const liveScripts = fs.readdirSync(scriptsDirectory)
    .filter((name) => /^test-live-rust-.*\.mjs$/.test(name));

let requests = 0;
for (const name of liveScripts) {
    const source = fs.readFileSync(path.join(scriptsDirectory, name), 'utf8');
    const pattern = /\b[a-z_$][\w$]*\.request\(['"]start-turn['"],\s*\{([\s\S]*?)\n\s*\}\);/gi;
    for (const match of source.matchAll(pattern)) {
        requests += 1;
        assert.match(
            match[1],
            /\bturnId\s*:/,
            `${name} contains a v1.4 start-turn request without turnId`,
        );
    }
}

assert.equal(requests, 9, `expected to audit all direct live start-turn requests, found ${requests}`);
console.log(`Rust live protocol contracts passed (${requests} start-turn requests).`);
