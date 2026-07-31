import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const scriptsDirectory = path.resolve(import.meta.dirname);
// The historical aggregate live scripts are explicitly excluded while they
// are migrated from v1.6. This contract audits the v1.7 R3-M live receipt,
// rather than falsely treating legacy commands as current protocol coverage.
const liveScripts = ['test-live-rust-concurrent-topics.mjs'];

let requests = 0;
for (const name of liveScripts) {
    const source = fs.readFileSync(path.join(scriptsDirectory, name), 'utf8');
    const legacyCreateSession = new RegExp("\\.request\\(['\\\"]create-session['\\\"]");
    assert.doesNotMatch(source, legacyCreateSession, `${name} still uses the removed v1.6 create-session command`);
    const pattern = /\b[a-z_$][\w$]*\.request\(['"]start-turn['"],\s*\{([\s\S]*?)\n\s*\}\);/gi;
    for (const match of source.matchAll(pattern)) {
        requests += 1;
        assert.match(
            match[1],
            /\bturnId\s*:/,
            `${name} contains a v1.4 start-turn request without turnId`,
        );
        assert.match(
            match[1],
            /\btopicId\s*:/,
            `${name} contains a v1.7 start-turn request without topicId`,
        );
    }
}

assert.ok(requests >= 2, `expected direct live start-turn coverage, found ${requests}`);
console.log(`Rust live protocol contracts passed (${requests} start-turn requests).`);
